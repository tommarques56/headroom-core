// Gateway implementing the desktop /api/v1/desktop/* contract.
// Node 22, zero runtime deps beyond express (installed by the compose command).
//
// The contract fields were extracted from src-tauri/src/pricing.rs of the
// desktop app: every key is camelCase and every optional field the client
// tolerates defaults to null/false so a minimal envelope is enough.
//
// Accounts live in Postgres (the Supabase Postgres instance). Email codes are
// logged to the container console for local development: check
// `docker compose logs gateway | grep AUTH-CODE`.

import crypto from "node:crypto";
import express from "express";
import pg from "pg";

const PORT = Number(process.env.GATEWAY_PORT || 8090);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const CODE_TTL_SECONDS = 900; // AUTH_CODE_EXPIRY_SECONDS on the client
const SESSION_TTL_HOURS = 24 * 30; // sessions valid for a month

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:headroom_local_pg@supabase-db:5432/headroom";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function initSchema() {
  // Wait for Postgres to accept connections, then create the tables.
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          email TEXT PRIMARY KEY,
          trial_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
          subscription_active BOOLEAN NOT NULL DEFAULT FALSE,
          subscription_tier TEXT,
          invite_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS auth_codes (
          email TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS milestones (
          email TEXT NOT NULL,
          milestone_tokens_saved BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      console.log("[gateway] schema ready");
      return;
    } catch (err) {
      if (attempt > 30) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------- helpers ----------

const now = () => new Date();
const iso = (d) => (d == null ? null : new Date(d).toISOString());

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function getOrCreateAccount(email) {
  const res = await pool.query(
    `INSERT INTO accounts (email, trial_started_at, trial_ends_at)
     VALUES ($1, now(), now() + make_interval(days => $2))
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [email, TRIAL_DAYS]
  );
  return res.rows[0];
}

function trialDaysLeft(account) {
  const ends = new Date(account.trial_ends_at).getTime();
  return Math.max(0, Math.ceil((ends - now().getTime()) / 86400000));
}

function accountEnvelope(account, extras = {}) {
  // RemoteAccountEnvelope shape (pricing.rs):
  // { account: {...}, activePercentOff, pricingLadder, introOffer, planPrices }
  const trialActive = new Date(account.trial_ends_at) > now();
  return {
    account: {
      email: account.email,
      trialStartedAt: iso(account.trial_started_at),
      trialEndsAt: iso(account.trial_ends_at),
      trialUsageDaysLeft: trialDaysLeft(account),
      trialActive,
      subscriptionActive: account.subscription_active === true,
      subscriptionTier: account.subscription_tier || null,
      subscriptionStartedAt: null,
      subscriptionRenewsAt: null,
      subscriptionAmountCents: null,
      subscriptionBillingPeriod: null,
      subscriptionDiscountDuration: null,
      subscriptionDiscountDurationInMonths: null,
      subscriptionCancelAtPeriodEnd: false,
      subscriptionEndsAt: null,
      subscriptionRenewalCents: null,
      subscriptionRenewalEndsAt: null,
      subscriptionPendingTier: null,
      subscriptionPendingBillingPeriod: null,
      subscriptionPendingEffectiveAt: null,
      inviteCode: account.invite_code || null,
      acceptedInvitesCount: 0,
      inviteBonusPercent: 0.0,
      upgradeAction: null,
      appsumoLifetimeTier: null,
      recommendedTier: null,
      grandfathered: false,
      pro500Grandfathered: false,
      paymentFailed: false,
      referralCode: null,
      referralSignups: 0,
      referralSubscribed: 0,
      referralFreeMonths: 0,
      referralRewardPending: false,
    },
    activePercentOff: 0,
    pricingLadder: null,
    introOffer: null,
    planPrices: null,
    ...extras,
  };
}

function sessionFromAuth(header = "") {
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return { token, tokenHash: sha256(token) };
}

async function accountForSession(tokenHash) {
  const res = await pool.query(
    `SELECT a.* FROM sessions s JOIN accounts a ON a.email = s.email
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  return res.rows[0] || null;
}

// ---------- app ----------

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// POST /api/v1/desktop/auth/request_code
// Client expects { email, expiresInSeconds } (RequestCodeResponse).
app.post("/api/v1/desktop/auth/request_code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "invalid email" });
  }
  const account = await getOrCreateAccount(email);
  // New code invalidates previous codes for this email.
  const code = crypto.randomInt(100000, 1000000).toString();
  await pool.query("DELETE FROM auth_codes WHERE email = $1", [email]);
  await pool.query(
    `INSERT INTO auth_codes (email, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [email, sha256(code), CODE_TTL_SECONDS]
  );
  // Dev delivery: print to the gateway console.
  console.log(`AUTH-CODE for ${email}: ${code} (valid ${CODE_TTL_SECONDS}s)`);
  res.json({ email, expiresInSeconds: CODE_TTL_SECONDS });
});

// POST /api/v1/desktop/auth/verify_code
// Client expects the session envelope (VerifyCodeResponse).
app.post("/api/v1/desktop/auth/verify_code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  if (!email || !code) return res.status(400).json({ error: "email and code required" });

  const rows = await pool.query(
    `SELECT * FROM auth_codes WHERE email = $1 AND code_hash = $2 AND expires_at > now()`,
    [email, sha256(code)]
  );
  if (rows.rowCount === 0) return res.status(401).json({ error: "invalid or expired code" });

  await pool.query("DELETE FROM auth_codes WHERE email = $1", [email]);
  const account = await getOrCreateAccount(email);
  const token = randomToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, email, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), email, SESSION_TTL_HOURS]
  );
  res.json({
    sessionToken: token,
    ...accountEnvelope(account),
  });
});

// GET /api/v1/desktop/account (Bearer)
app.get("/api/v1/desktop/account", async (req, res) => {
  const session = sessionFromAuth(req.headers.authorization);
  if (!session) return res.status(401).json({ error: "missing token" });
  const account = await accountForSession(session.tokenHash);
  if (!account) return res.status(401).json({ error: "invalid or expired session" });
  res.json(accountEnvelope(account));
});

// POST /api/v1/desktop/account/activate (Bearer) - idempotent
app.post("/api/v1/desktop/account/activate", async (req, res) => {
  const session = sessionFromAuth(req.headers.authorization);
  if (!session) return res.status(401).json({ error: "missing token" });
  const account = await accountForSession(session.tokenHash);
  if (!account) return res.status(401).json({ error: "invalid or expired session" });
  res.json(accountEnvelope(account));
});

// GET /api/v1/desktop/config - public config (PublicConfig shape)
app.get("/api/v1/desktop/config", (_req, res) => {
  res.json({
    activePercentOff: 0,
    pricingLadder: null,
    introOffer: null,
    planPrices: null,
    paywallFirst: false, // false keeps sign-in behind the pricing screen
  });
});

// POST /api/v1/desktop/grace/start - funnel noop
app.post("/api/v1/desktop/grace/start", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/milestones - noop (Bearer optional)
app.post("/api/v1/desktop/milestones", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/weekly_limit - noop
app.post("/api/v1/desktop/weekly_limit", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/checkout - stub: no payments wired; return a URL
// the Settings screen can open (change to Stripe/Polar later).
app.post("/api/v1/desktop/checkout", (_req, res) => {
  res.json({ url: "https://example.com/checkout-not-configured" });
});

app.post("/api/v1/desktop/subscriptions/change_plan", (_req, res) =>
  res.status(501).json({ error: "not configured in local gateway" })
);
app.post("/api/v1/desktop/subscriptions/reactivate", (_req, res) =>
  res.status(501).json({ error: "not configured in local gateway" })
);
app.get("/api/v1/desktop/billing_portal", (_req, res) =>
  res.status(501).json({ error: "not configured in local gateway" })
);
app.post("/api/v1/desktop/cancellation_intent", (_req, res) => res.status(200).json({ ok: true }));
app.post("/api/v1/desktop/account/referral", (_req, res) => res.status(200).json({ ok: true }));

initSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[gateway] listening on :${PORT} (contract /api/v1/desktop/*)`);
    });
  })
  .catch((err) => {
    console.error("[gateway] init failed:", err);
    process.exit(1);
  });
