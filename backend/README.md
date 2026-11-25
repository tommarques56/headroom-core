# Backend: hosted Supabase + desktop API gateway

Replacement for the original private account backend. A thin Node gateway
implements the `/api/v1/desktop/*` contract the desktop app expects, backed by
**hosted Supabase** (Auth + PostgREST + RLS) instead of local Postgres.

- Auth (signup / login / password recovery) -> hosted Supabase Auth (goTrue)
- Licensing (profiles / licenses / sessions) -> hosted Supabase Postgres
- The gateway reads the desktop's opaque session token, refreshes the Supabase
  access token server-side, and maps `profiles` + `licenses` into the account
  envelope the Rust client parses.

## Project

- Supabase project ref: `dqnyzemgsffawrvojpvn`
- Dashboard: https://supabase.com/dashboard/project/dqnyzemgsffawrvojpvn
- Run `supabase link --project-ref dqnyzemgsffawrvojpvn` once to link.

## Run

```bash
cd backend
export SUPABASE_URL="https://dqnyzemgsffawrvojpvn.supabase.co"
export SUPABASE_ANON_KEY="sb_publishable_..."
export SUPABASE_SERVICE_ROLE_KEY="..."   # server secret, never ship client-side
docker compose up -d
# gateway on http://127.0.0.1:8090
```

The gateway answers 503 on auth endpoints until `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are both set.

## Test the gateway (no cloud / no secrets)

`backend/gateway/test/mock-supabase.mjs` is a local fake of the Supabase
Auth + PostgREST HTTP surface. The end-to-end test boots it next to the real
gateway and drives the desktop contract (register -> login -> account
envelope -> trial license -> reset password -> error cases):

```bash
npm run test:gateway        # from headroom-desktop
```

Needs only `npm install` inside `backend/gateway` (the gateway's only runtime
dep is `express`). Uses placeholder keys; never touches the hosted project.

## Migrate the licensing schema

The `supabase/migrations/*.sql` files define `profiles`, `licenses`,
`sessions`, the signup trigger (auto 7-day trial) and RLS. On a NEW hosted
project, apply with:

```bash
supabase link --project-ref dqnyzemgsffawrvojpvn
supabase db push
```

> This branch does NOT push the schema to the live project yet. Apply it when
> you're ready to switch the desktop builds to the Supabase backend.

## The contract (extracted from src-tauri/src/pricing.rs)

| Endpoint | Method | Purpose |
|---|---|---|
| `desktop/auth/register` | POST | `{email, password}` -> session envelope (fresh signup or existing-account login) |
| `desktop/auth/login` | POST | `{email, password}` -> session envelope |
| `desktop/auth/reset_password` | POST | `{email}` -> 200 (sends recovery email; no user enumeration) |
| `desktop/auth/verify_code` | POST | Deprecated (410): OTP flow retired for email/password |
| `desktop/account` | GET | Bearer desktop session -> account envelope |
| `desktop/account/activate` | POST | Bearer, idempotent account sync |
| `desktop/config` | GET | Public config: `paywallFirst`, pricing stubs |
| `desktop/grace/start` | POST | Funnel noop (200) |
| `desktop/milestones` | POST | Noop |
| `desktop/weekly_limit` | POST | Noop |
| `desktop/checkout`, `subscriptions/*`, `billing_portal` | - | Stubs (wire Stripe/Polar/Paddle here later) |

## Sign-in flow (local dev)

1. App points at `http://127.0.0.1:8090/api/v1` (default in release builds;
   `HEADROOM_ACCOUNT_API_BASE_URL` overrides in debug)
2. Enter email + password in the app's register / login form
3. Gateway creates the Supabase Auth user (if new), auto-starts the 7-day
   trial via the signup trigger, and returns a desktop session token

> With `mailer_autoconfirm: false` on the project, a brand-new signup must
> first confirm its email before password sign-in succeeds. A service-role key
> lets the gateway auto-confirm on trust-first installs; otherwise the user
> clicks the confirmation email first.

## Wiring the desktop app

`src-tauri/src/pricing.rs`:
```rust
const DEFAULT_ACCOUNT_API_BASE_URL: &str = "http://127.0.0.1:8090/api/v1";
```

Change this constant (or the `HEADROOM_ACCOUNT_API_BASE_URL` build env) to your
deployed gateway URL before shipping builds to users.

## Going to production

- Front the gateway with TLS (Caddy/nginx) on a real host
- Wire `desktop/checkout` to Stripe/Polar/Paddle for subscriptions
- Insert `licenses` rows on payment webhook events (status/tier/period)
