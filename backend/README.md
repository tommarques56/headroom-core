# Backend: Supabase Postgres + desktop API gateway

Self-hosted replacement for the original private account backend. Two containers:

- `supabase-db` — Supabase's Postgres 15 image (storage for accounts, codes, sessions)
- `gateway` — Node 22 + Express implementing the `/api/v1/desktop/*` contract the desktop app expects

## Run

```bash
cd backend
docker compose up -d
```

> Note for colima users: bind-mount sources must live under a colima-mountable
> path. If `~/Documents` mounts fail with "operation not permitted", copy the
> backend dir to e.g. `~/.headroom-backend` and run compose from there.

## The contract (extracted from src-tauri/src/pricing.rs)

| Endpoint | Method | Purpose |
|---|---|---|
| `desktop/auth/request_code` | POST | Email + code sign-in. Returns `{email, expiresInSeconds}` |
| `desktop/auth/verify_code` | POST | Returns `{sessionToken, account: {...}, ...}` (7-day trial auto-starts) |
| `desktop/account` | GET | Bearer session -> account envelope |
| `desktop/account/activate` | POST | Bearer, idempotent account sync |
| `desktop/config` | GET | Public config: `paywallFirst`, pricing stubs |
| `desktop/grace/start` | POST | Funnel noop (200) |
| `desktop/milestones` | POST | Noop |
| `desktop/weekly_limit` | POST | Noop |
| `desktop/checkout`, `subscriptions/*`, `billing_portal` | - | Stubs (wire Stripe/Polar here later) |

## Sign-in flow (local dev)

1. App points at `http://127.0.0.1:8090/api/v1` (default in release builds; `HEADROOM_ACCOUNT_API_BASE_URL` overrides in debug)
2. Enter your email in the app's sign-in form
3. Read the code in the gateway logs: `docker compose logs gateway | grep AUTH-CODE`
4. Enter the code -> 30-day session, 7-day trial active

## Wiring the desktop app

`src-tauri/src/pricing.rs`:
```rust
const DEFAULT_ACCOUNT_API_BASE_URL: &str = "http://127.0.0.1:8090/api/v1";
```

Change this constant (or the `HEADROOM_ACCOUNT_API_BASE_URL` build env) to your
deployed URL before shipping builds to users.

## Going to production

- Front the gateway with TLS (Caddy/nginx) on a real host
- Replace the console AUTH-CODE delivery with SMTP or Supabase Auth email
- Wire `desktop/checkout` to Stripe or Polar for subscriptions
- Store `accounts.subscription_active`/`subscription_tier` on webhook events
