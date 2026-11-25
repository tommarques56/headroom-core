// Minimal mock of the Supabase Auth/PostgREST HTTP surface, enough to exercise
// the gateway end-to-end (register -> login -> account envelope + license RLS)
// without touching a real hosted project or holding service-role keys.
//
// Run with the gateway pointed here via SUPABASE_URL; keys can be placeholders.
//
//   node backend/gateway/test/mock-supabase.mjs &
//   SUPABASE_URL=http://127.0.0.1:54325 \
//     SUPABASE_ANON_KEY=anon-key \
//     SUPABASE_SERVICE_ROLE_KEY=service-key \
//     node backend/gateway/server.mjs &

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 54325);
// MOCK_AUTOCONFIRM=1 simulates a Supabase project with "Confirm email" OFF:
// signup returns a session immediately and the user is usable right away.
const MOCK_AUTOCONFIRM = process.env.MOCK_AUTOCONFIRM || "0";

// In-memory fake database.
import { createHash } from "node:crypto";

const users = new Map(); // email -> {id, email, emailConfirmed}
const sessions = []; // {token_hash, user_id, refresh_token, access_token}
const licenses = new Map(); // user_id -> license row
const refreshTokens = new Map(); // refresh_token -> {access_token, user_id}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}
let uid = 0;

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function trialLicense(userId) {
  return {
    id: `lic-${userId}`,
    profile_id: userId,
    tier: "trial",
    status: "trialing",
    kind: "trial",
    starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    billing_period: null,
    amount_cents: null,
    cancel_at_period_end: false,
    renews_at: null,
    created_at: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (process.env.MOCK_DEBUG) console.error(`[mock] ${req.method} ${path} auth=${req.headers.authorization || "-"} body=${raw || "-"}`);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  // ---- Auth ----
  if (path === "/auth/v1/signup" && req.method === "POST") {
    const { email, password } = body;
    if (!email || typeof password !== "string" || password.length < 6) {
      return json(res, 400, { code: 400, msg: "invalid signup payload" });
    }
    if (users.has(email)) {
      return json(res, 200, { access_token: null, user: null, identities: [] });
    }
    const id = `uid-${++uid}`;
    const emailConfirmed = MOCK_AUTOCONFIRM === "1";
    users.set(email, { id, email, emailConfirmed, password });
    if (MOCK_AUTOCONFIRM === "1") {
      const access_token = `jwt-${id}`;
      const refresh_token = `rt-${id}-${Date.now()}`;
      refreshTokens.set(refresh_token, { access_token, user_id: id });
      return json(res, 200, {
        access_token,
        refresh_token,
        expires_in: 3600,
        user: { id, email },
        identities: [],
      });
    }
    // mailer_autoconfirm=false => no session returned on signup.
    return json(res, 200, { access_token: null, user: { id, email }, identities: [] });
  }

  if (path === "/auth/v1/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const { email, password } = body;
      const user = users.get(email);
      if (!user || user.password !== password) {
        return json(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      }
      if (!user.emailConfirmed) {
        return json(res, 400, { error_code: "email_not_confirmed", msg: "Email not confirmed" });
      }
      const access_token = `jwt-${user.id}`;
      const refresh_token = `rt-${user.id}-${Date.now()}`;
      refreshTokens.set(refresh_token, { access_token, user_id: user.id });
      return json(res, 200, {
        access_token,
        refresh_token,
        expires_in: 3600,
        user: { id: user.id, email: user.email },
      });
    }
    if (grant === "refresh_token") {
      const { refresh_token } = body;
      const entry = refreshTokens.get(refresh_token);
      if (!entry) return json(res, 400, { code: 400, msg: "Invalid Refresh Token: Refresh Token Not Found" });
      const access_token = `jwt-${entry.user_id}-refreshed`;
      refreshTokens.set(refresh_token, { ...entry, access_token });
      return json(res, 200, { access_token, refresh_token, expires_in: 3600, user: { id: entry.user_id } });
    }
    return json(res, 400, { code: 400, msg: "unsupported grant" });
  }

  if (path === "/auth/v1/recover" && req.method === "POST") {
    return json(res, 200, {});
  }

  if (path === "/auth/v1/user" && req.method === "GET") {
    const auth = req.headers.authorization || "";
    const match = auth.match(/Bearer jwt-([\w-]+)/);
    if (!match) return json(res, 401, { code: 401, msg: "No access token" });
    const uid2 = match[1];
    const user = [...users.values()].find((u) => u.id === uid2);
    if (!user) return json(res, 401, { code: 401, msg: "User not found" });
    return json(res, 200, user);
  }

  if (path.match(/^\/auth\/v1\/admin\/users\/.+\/confirm$/) && req.method === "PUT") {
    const id = path.split("/")[4];
    const user = [...users.values()].find((u) => u.id === id);
    if (user) user.emailConfirmed = true;
    return json(res, 200, {});
  }
  if (path === "/rest/v1/profiles" && req.method === "POST") {
    const { id, email } = body;
    const user = users.get(email);
    if (user) user.id = id;
    licenses.set(id, trialLicense(id));
    return json(res, 201, { id, email });
  }

  if (path.startsWith("/rest/v1/sessions") && req.method === "POST") {
    sessions.push(body);
    return json(res, 201, body);
  }
  if (path.startsWith("/rest/v1/sessions") && req.method === "DELETE") {
    const tokenHash = decodeURIComponent(url.searchParams.get("token_hash") || "").replace("eq.", "");
    const idx = sessions.findIndex((s) => s.token_hash === tokenHash);
    if (idx >= 0) sessions.splice(idx, 1);
    return json(res, 200, []);
  }
  if (path.startsWith("/rest/v1/sessions") && req.method === "PATCH") {
    const tokenHash = decodeURIComponent(url.searchParams.get("token_hash") || "").replace("eq.", "");
    const s = sessions.find((x) => x.token_hash === tokenHash);
    if (s) Object.assign(s, body);
    return json(res, 204, "");
  }
  if (path.startsWith("/rest/v1/sessions") && req.method === "GET") {
    const tokenHash = decodeURIComponent(url.searchParams.get("token_hash") || "").replace("eq.", "");
    const hit = sessions.find((s) => s.token_hash === tokenHash);
    return json(res, 200, hit ? [hit] : []);
  }

  if (path.startsWith("/rest/v1/licenses") && req.method === "GET") {
    const auth = req.headers.authorization || "";
    const m = auth.match(/Bearer jwt-([\w-]+)/);
    const uid2 = m ? m[1] : null;
    const row = uid2 ? licenses.get(uid2) : null;
    return json(res, 200, row ? [row] : []);
  }

  if (path.startsWith("/rest/v1/licenses") && req.method === "POST") {
    licenses.set(body.profile_id, { ...trialLicense(body.profile_id), ...body });
    return json(res, 201, []);
  }

  return json(res, 404, { error: `unhandled: ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-supabase] listening on :${PORT}`);
});
