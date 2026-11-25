// Gateway implementing the desktop /api/v1/desktop/* contract on top of
// hosted Supabase (Auth + PostgREST + RLS).
//
// Node 22, zero runtime deps beyond express + the low-level fetch that Node
// ships. Supabase access is HTTP-only:
//
//   * Auth (signup / login / recovery)    -> SUPABASE_URL/auth/v1/...
//     uses the publishable anon key + either the client's typed password or
//     the service-role key for confirm/refresh.
//   * Licensing (profiles / licenses / sessions) -> SUPABASE_URL/rest/v1/...
//     uses the service-role key (bypasses RLS) for the session store, and the
//     authenticated user's own JWT for RLS-scoped reads.
//
// The desktop client contract (src-tauri/src/pricing.rs) is preserved so the
// app keeps working unchanged: every key is camelCase and optional fields
// default to null/false when absent.
//
// ENV:
//   PORT                     gateway listen port (default 8090)
//   SUPABASE_URL             e.g. https://dqnyzemgsffawrvojpvn.supabase.co
//   SUPABASE_ANON_KEY        publishable key (Auth signup/login/recovery)
//   SUPABASE_SERVICE_ROLE_KEY service key (session store, license reads)
//   TRIAL_DAYS               trial length in days (default 7)
//   SESSION_TTL_HOURS        desktop session length (default 24*30)

import crypto from "node:crypto";
import express from "express";

const PORT = Number(process.env.PORT || 8090);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24 * 30);

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dqnyzemgsffawrvojpvn.supabase.co")
  .replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// ---------- fetch helpers ----------

// Auth model for Supabase HTTP calls:
//   apikey   - always one of the project keys (anon or service role)
//   bearer   - the JWT sent as Authorization. For user-scoped calls this is
//              the user's access_token (RLS applies); for admin/service calls
//              both are the service-role key.
function supabaseHeaders({ apikey = SUPABASE_ANON_KEY, bearer = apikey } = {}) {
  return {
    apikey,
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
}

async function supabaseJson(route, { auth = {}, method = "GET", body, extraHeaders } = {}) {
  const res = await fetch(`${SUPABASE_URL}${route}`, {
    method,
    headers: { ...supabaseHeaders(auth), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const ok = res.ok;
  return { status: res.status, ok, data, headers: res.headers };
}

// ---------- hashing helpers ----------

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------- Supabase Auth calls ----------

// Register + login in one call. `signup` with a password either creates the
// account (returning a session when email confirmation is off) or, when the
// account already exists, returns 200 with no session - the caller then falls
// back to an explicit password sign-in.
async function supabaseSignUp(email, password) {
  return supabaseJson("/auth/v1/signup", {
    method: "POST",
    body: { email, password },
  });
}

// Actually sign in with email + password. Returns the Supabase session
// {access_token, refresh_token, user}.
async function supabaseSignIn(email, password) {
  return supabaseJson("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
}

// Send a password-recovery email.
async function supabaseRecover(email) {
  return supabaseJson("/auth/v1/recover", {
    method: "POST",
    body: { email },
  });
}

// Confirm an email address that has pending confirmation using the service
// role, so a user who signed up with mailer_autoconfirm off can proceed
// without clicking the verification link.
async function supabaseConfirmEmail(userId) {
  return supabaseJson(`/auth/v1/admin/users/${userId}/confirm`, {
    auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY },
    method: "PUT",
  });
}

async function supabaseGetUser(accessToken) {
  // /auth/v1/user authenticates the caller by their access JWT; apikey must be
  // a real project key (anon is fine) so the request is not rejected.
  return supabaseJson("/auth/v1/user", {
    auth: { apikey: SUPABASE_ANON_KEY, bearer: accessToken },
  });
}

// Return the freshest usable auth headers for a user's desktop session,
// refreshing the Supabase access token server-side when it has expired.
async function supabaseAuthHeadersForSession(session) {
  if (session.access_token && new Date(session.access_expires_at) > new Date()) {
    return `Bearer ${session.access_token}`;
  }
  // Refresh token rotation: exchange refresh_token -> new pair, persist it.
  const res = await supabaseJson("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: session.refresh_token },
  });
  if (!res.ok || !res.data?.access_token) {
    return null;
  }
  await updateSessionTokens(session.token_hash, res.data);
  return `Bearer ${res.data.access_token}`;
}

// ---------- licensing store (service role) ----------

async function upsertProfileForAuthUser(userId, email) {
  // POST with Prefer resolution=merge-duplicates makes an RFC5789-style
  // insert-or-ignore keyed on the primary key (id == auth user), so a profile
  // the signup trigger already created is left untouched.
  await supabaseJson("/rest/v1/profiles", {
    auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY },
    method: "POST",
    body: { id: userId, email },
    extraHeaders: { Prefer: "resolution=merge-duplicates" },
  });
}

// Translate a Supabase Auth user into the account envelope the desktop expects.
// Licensing state is read through the user's own RLS-scoped token so the
// gateway never needs service-role access to licenses; trials come from the
// signup trigger.
function envelopeForUser(user, license, now = new Date()) {
  const email = user?.email ?? "";
  const trialEndsAt = license?.ends_at ? new Date(license.ends_at) : new Date(now.getTime() + TRIAL_DAYS * 86400000);
  const trialActive = license?.status === "trialing" && trialEndsAt > now;
  const trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86400000));
  const subscriptionActive = license?.status === "active" &&
    (license.kind === "subscription" || license.kind === "lifetime");

  const tier = license?.tier && license.tier !== "trial" ? license.tier : null;
  return {
    account: {
      email,
      trialStartedAt: license?.starts_at ?? null,
      trialEndsAt: trialEndsAt.toISOString(),
      trialUsageDaysLeft: trialDaysLeft,
      trialActive,
      subscriptionActive,
      subscriptionTier: tier,
      subscriptionStartedAt: license?.starts_at ?? null,
      subscriptionRenewsAt: license?.renews_at ?? null,
      subscriptionAmountCents: license?.amount_cents ?? null,
      subscriptionBillingPeriod: license?.billing_period ?? null,
      subscriptionDiscountDuration: null,
      subscriptionDiscountDurationInMonths: null,
      subscriptionCancelAtPeriodEnd: license?.cancel_at_period_end ?? false,
      subscriptionEndsAt: null,
      subscriptionRenewalCents: license?.renewal_cents ?? null,
      subscriptionRenewalEndsAt: null,
      subscriptionPendingTier: null,
      subscriptionPendingBillingPeriod: null,
      subscriptionPendingEffectiveAt: null,
      inviteCode: null,
      acceptedInvitesCount: 0,
      inviteBonusPercent: 0,
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
  };
}

// ---------- desktop session store ----------

async function createDesktopSession(userId, supabaseSession) {
  const token = randomToken();
  const access_expires_at = new Date(
    Date.now() + (supabaseSession?.expires_in ?? 3600) * 1000
  ).toISOString();
  await supabaseJson("/rest/v1/sessions", {
    auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY },
    method: "POST",
    body: {
      token_hash: sha256(token),
      user_id: userId,
      refresh_token: supabaseSession?.refresh_token ?? "",
      access_token: supabaseSession?.access_token ?? null,
      access_expires_at,
    },
  });
  return token;
}

async function findDesktopSession(token) {
  const res = await supabaseJson(
    `/rest/v1/sessions?token_hash=eq.${sha256(token)}&select=*&limit=1`,
    { auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY } }
  );
  return res.ok && Array.isArray(res.data) ? res.data[0] || null : null;
}

async function updateSessionTokens(tokenHash, supabaseSession) {
  await supabaseJson(`/rest/v1/sessions?token_hash=eq.${tokenHash}`, {
    auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY },
    method: "PATCH",
    body: {
      refresh_token: supabaseSession.refresh_token,
      access_token: supabaseSession.access_token,
      access_expires_at: new Date(
        Date.now() + (supabaseSession.expires_in ?? 3600) * 1000
      ).toISOString(),
      last_used_at: new Date().toISOString(),
    },
  });
}

async function deleteDesktopSession(token) {
  await supabaseJson(`/rest/v1/sessions?token_hash=eq.${sha256(token)}`, {
    auth: { apikey: SUPABASE_SERVICE_ROLE_KEY, bearer: SUPABASE_SERVICE_ROLE_KEY },
    method: "DELETE",
  });
}

// ---------- anon-key guard ----------

function requireSupabaseConfigured(res) {
  if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: "gateway not configured (missing SUPABASE keys)" });
    return false;
  }
  return true;
}

// ---------- app ----------

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// POST /api/v1/desktop/auth/register
// { email, password } -> session envelope (201 on fresh signup, 200 on login)
app.post("/api/v1/desktop/auth/register", async (req, res) => {
  if (!requireSupabaseConfigured(res)) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email.includes("@")) return res.status(400).json({ error: "invalid email" });
  if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

  const signup = await supabaseSignUp(email, password);

  // Fresh signup on a project with mailer_autoconfirm=false returns no session
  // (the user must confirm via email first). On a trust-first install we
  // auto-confirm the newly created account with the service role so the first
  // register completes in one shot, then sign the user in explicitly.
  if (signup.data?.user?.id) {
    await supabaseConfirmEmail(signup.data.user.id).catch(() => {});
  }

  // Signup either created a user (with a session when autoconfirm is on) or
  // told us the account exists (200 with no session / an already-registered
  // error). In both cases the correct move is an explicit password sign-in;
  // a signup that returns a session is also treated as "logged in".
  if (signup.ok && signup.data?.access_token) {
    const userId = signup.data.user?.id;
    if (userId) await upsertProfileForAuthUser(userId, email);
    const token = await createDesktopSession(userId, signup.data);
    const license = await readLicenseForUser(signup.data.access_token);
    return res.status(201).json({
      sessionToken: token,
      ...envelopeForUser(signup.data.user, license),
    });
  }

  const login = await supabaseSignIn(email, password);
  if (!login.ok) {
    const msg =
      login.data?.msg || signup.data?.msg || "invalid email or password";
    return res.status(401).json({ error: msg });
  }
  if (login.data?.user && login.data.user.email_confirmed_at == null && !login.data.user?.email_confirmed_at) {
    // Email confirmation is still pending: require the user to click their
    // confirmation link OR auto-confirm with the service role on a trust-first
    // install. We auto-confirm only when a service role key is present.
    if (SUPABASE_SERVICE_ROLE_KEY) {
      await supabaseConfirmEmail(login.data.user.id).catch(() => {});
    }
  }
  const userId = login.data.user?.id;
  if (userId) await upsertProfileForAuthUser(userId, email);
  const token = await createDesktopSession(userId, login.data);
  const license = await readLicenseForUser(login.data.access_token);
  res.json({ sessionToken: token, ...envelopeForUser(login.data.user, license) });
});

// POST /api/v1/desktop/auth/login
// { email, password } -> session envelope
app.post("/api/v1/desktop/auth/login", async (req, res) => {
  if (!requireSupabaseConfigured(res)) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email.includes("@")) return res.status(400).json({ error: "invalid email" });
  if (!password) return res.status(400).json({ error: "password required" });

  const login = await supabaseSignIn(email, password);
  if (!login.ok) {
    return res.status(401).json({
      error: login.data?.msg || "invalid email or password",
    });
  }
  const userId = login.data.user?.id;
  if (userId) await upsertProfileForAuthUser(userId, email);
  const token = await createDesktopSession(userId, login.data);
  const license = await readLicenseForUser(login.data.access_token);
  res.json({ sessionToken: token, ...envelopeForUser(login.data.user, license) });
});

// POST /api/v1/desktop/auth/reset_password
// { email } -> 200 when the recovery email was accepted (never leaks existence)
app.post("/api/v1/desktop/auth/reset_password", async (req, res) => {
  if (!requireSupabaseConfigured(res)) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email.includes("@")) return res.status(400).json({ error: "invalid email" });

  const recover = await supabaseRecover(email);
  // Supabase answers 200 even for unknown emails (no user enumeration); we
  // mirror that so the desktop never surfaces which addresses have accounts.
  if (!recover.ok) {
    return res.status(recover.status >= 500 ? 502 : 400).json({ error: recover.data?.msg || "could not send recovery email" });
  }
  res.json({ ok: true });
});

// POST /api/v1/desktop/auth/verify_code (deprecated OTP path)
// Still served so old builds keep working; verifies nothing but returns an
// anonymous session envelope mapping to the email's account when it exists.
app.post("/api/v1/desktop/auth/verify_code", async (_req, res) => {
  res.status(410).json({ error: "OTP sign-in is deprecated; use email + password" });
});

// GET /api/v1/desktop/account (Bearer desktop session)
app.get("/api/v1/desktop/account", async (req, res) => {
  if (!requireSupabaseConfigured(res)) return;
  const session = sessionFromAuth(req.headers.authorization);
  if (!session) return res.status(401).json({ error: "missing token" });

  const row = await findDesktopSession(session.token);
  if (!row) return res.status(401).json({ error: "invalid or expired session" });

  const headers = await supabaseAuthHeadersForSession(row);
  if (!headers) {
    await deleteDesktopSession(session.token);
    return res.status(401).json({ error: "session expired" });
  }
  const accessToken = headers.replace("Bearer ", "");

  const userRes = await supabaseGetUser(accessToken);
  if (!userRes.ok || !userRes.data?.id) {
    await deleteDesktopSession(session.token);
    return res.status(401).json({ error: "session expired" });
  }
  const user = userRes.data;

  const license = await readLicenseForUser(accessToken);
  res.json(envelopeForUser(user, license));
});

// Comment header for the RLS license read lives with supabaseAuthHeadersForSession.
async function readLicenseForUser(accessToken) {
  const licenseRes = await supabaseJson(
    `/rest/v1/licenses?select=*&order=created_at.desc&limit=1`,
    // RLS keys off auth.uid() == profile_id, so no user filter is needed; the
    // request just has to present the user's access JWT.
    { auth: { apikey: SUPABASE_ANON_KEY, bearer: accessToken } }
  );
  if (licenseRes.ok && Array.isArray(licenseRes.data) && licenseRes.data.length) {
    return licenseRes.data[0];
  }
  return null;
}

// POST /api/v1/desktop/account/activate (Bearer) - idempotent
app.post("/api/v1/desktop/account/activate", async (req, res) => {
  const session = sessionFromAuth(req.headers.authorization);
  if (!session) return res.status(401).json({ error: "missing token" });
  const row = await findDesktopSession(session.token);
  if (!row) return res.status(401).json({ error: "invalid or expired session" });
  const headers = await supabaseAuthHeadersForSession(row);
  if (!headers) return res.status(401).json({ error: "session expired" });
  const userRes = await supabaseGetUser(headers.replace("Bearer ", ""));
  if (!userRes.ok || !userRes.data?.id) return res.status(401).json({ error: "session expired" });
  res.json(envelopeForUser(userRes.data));
});

// GET /api/v1/desktop/config - public config (PublicConfig shape)
app.get("/api/v1/desktop/config", (_req, res) => {
  res.json({
    activePercentOff: 0,
    pricingLadder: null,
    introOffer: null,
    planPrices: null,
    paywallFirst: false,
  });
});

// POST /api/v1/desktop/grace/start - funnel noop
app.post("/api/v1/desktop/grace/start", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/milestones - noop
app.post("/api/v1/desktop/milestones", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/weekly_limit - noop
app.post("/api/v1/desktop/weekly_limit", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/v1/desktop/checkout - stub: no payments wired; return a URL the
// Settings screen can open (change to Stripe/Polar/Paddle later).
app.post("/api/v1/desktop/checkout", (_req, res) => {
  res.json({ url: "https://example.com/checkout-not-configured" });
});

app.post("/api/v1/desktop/subscriptions/change_plan", (_req, res) =>
  res.status(501).json({ error: "not configured in gateway" })
);
app.post("/api/v1/desktop/subscriptions/reactivate", (_req, res) =>
  res.status(501).json({ error: "not configured in gateway" })
);
app.get("/api/v1/desktop/billing_portal", (_req, res) =>
  res.status(501).json({ error: "not configured in gateway" })
);
app.post("/api/v1/desktop/cancellation_intent", (_req, res) => res.status(200).json({ ok: true }));
app.post("/api/v1/desktop/account/referral", (_req, res) => res.status(200).json({ ok: true }));

function sessionFromAuth(header = "") {
  const token = header.replace(/^Bearer\s+/i, "");
  return token ? { token, tokenHash: sha256(token) } : null;
}

const server = app.listen(PORT, "0.0.0.0", () => {
  const mode =
    SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY
      ? "hosted Supabase"
      : "UNCONFIGURED (missing SUPABASE keys) - auth endpoints will return 503";
  console.log(`[gateway] listening on :${PORT} (contract /api/v1/desktop/*, backing ${mode})`);
});
server.on("error", (err) => {
  console.error("[gateway] listen failed:", err);
  process.exit(1);
});
