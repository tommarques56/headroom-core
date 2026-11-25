// End-to-end test for backend/gateway against a local mock of Supabase.
//
// Boots:
//   1. mock-supabase.mjs        (fake Supabase Auth + PostgREST on :54325)
//   2. server.mjs               (the desktop gateway on :18090)
// then drives the /api/v1/desktop/* contract like the Tauri client does.
//
//   node backend/gateway/test/gateway.test.mjs
//
// Exit code 0 = all checks passed.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 54325;
const GATEWAY_PORT = 18090;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}

async function req(pathname, { method = "GET", body, token } = {}) {
  const res = await fetch(`${GATEWAY_URL}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function waitForReady(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${url}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

function spawnNode(script, env, onLine) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const handler = (d) => {
    const text = String(d);
    lines.push(text.trim());
    if (onLine) onLine(text);
  };
  child.stdout.on("data", handler);
  child.stderr.on("data", handler);
  return { child, lines };
}

const mock = spawnNode("test/mock-supabase.mjs", {
  MOCK_PORT: String(MOCK_PORT),
  MOCK_AUTOCONFIRM: "1",
});
const gateway = spawnNode("server.mjs", {
  PORT: String(GATEWAY_PORT),
  SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
});

let exitCode = 1;
try {
  await waitForReady(`${GATEWAY_URL}/healthz`);

  const email = `user-${Date.now()}@example.com`;
  const password = "correct horse battery";

  // ---- register (fresh account) ----
  const reg = await req("/api/v1/desktop/auth/register", {
    method: "POST",
    body: { email, password },
  });
  check("register returns 201 + sessionToken", reg.status === 201 && typeof reg.data?.sessionToken === "string", `status=${reg.status}`);
  const regTok = reg.data?.sessionToken;
  check("register envelope reports active trial", reg.data?.account?.trialActive === true && reg.data?.account?.trialUsageDaysLeft === 7);

  // ---- account (with desktop session) ----
  const acct = await req("/api/v1/desktop/account", { token: regTok });
  check("account returns 200 envelope", acct.status === 200 && acct.data?.account?.email === email, `status=${acct.status}`);
  check("account has trial license + no paid sub", acct.data?.account?.trialActive === true && acct.data?.account?.subscriptionActive === false);

  // ---- login (duplicate register falls back to login) ----
  const regDup = await req("/api/v1/desktop/auth/register", {
    method: "POST",
    body: { email, password },
  });
  check("second register logs the user in (200 + token)", regDup.status === 200 && typeof regDup.data?.sessionToken === "string", `status=${regDup.status}`);

  const login = await req("/api/v1/desktop/auth/login", {
    method: "POST",
    body: { email, password },
  });
  check("login returns 200 + sessionToken", login.status === 200 && typeof login.data?.sessionToken === "string", `status=${login.status}`);
  const loginTok = login.data?.sessionToken;
  const acct2 = await req("/api/v1/desktop/account", { token: loginTok });
  check("login session resolves to same account", acct2.status === 200 && acct2.data?.account?.email === email);

  // ---- bad login ----
  const bad = await req("/api/v1/desktop/auth/login", {
    method: "POST",
    body: { email, password: "wrong password" },
  });
  check("bad login returns 401", bad.status === 401, `status=${bad.status}`);

  // ---- reset password (no existence leak) ----
  const reset = await req("/api/v1/desktop/auth/reset_password", {
    method: "POST",
    body: { email },
  });
  check("reset password returns ok", reset.status === 200 && reset.data?.ok === true, `status=${reset.status}`);

  // ---- expired session is rejected ----
  const ghost = await req("/api/v1/desktop/account", { token: "no-such-token" });
  check("unknown session token rejected", ghost.status === 401, `status=${ghost.status}`);

  // ---- old OTP route removed ----
  const otp = await req("/api/v1/desktop/auth/verify_code", {
    method: "POST",
    body: { email, code: "123456" },
  });
  check("verify_code deprecated (410)", otp.status === 410, `status=${otp.status}`);

  // ---- unconfigured gateway guard ----
  const pass = results.every((r) => r.pass);
  exitCode = pass ? 0 : 1;
} catch (e) {
  console.error("TEST RUNNER ERROR:", e);
  check("runner completed without throwing", false, String(e));
} finally {
  gateway.child.kill("SIGTERM");
  mock.child.kill("SIGTERM");
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
  process.exit(exitCode);
}
