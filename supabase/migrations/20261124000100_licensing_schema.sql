-- Licensing schema for Headroom desktop
--
-- Wires the desktop account/licensing model onto hosted Supabase:
--   * `public.profiles`      - one row per Headroom account (email, trial, billing)
--   * `public.licenses`      - entitlement records (trial / pro / max5x / max20x / pro500)
--   * signup trigger         - auto-creates a profile + 7-day trial license on auth signup
--   * RLS                    - users read/write their own rows; the gateway (service role)
--                              bypasses RLS and is the only principal that issues licenses.
--
-- The desktop client never holds a service-role key: it authenticates through
-- Supabase Auth (email/password) and reads its own profile/license through RLS.

-----------------------------
-- profiles
-----------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default now() + interval '7 days',
  invite_code text,
  accepted_invites_count integer not null default 0,
  invite_bonus_percent double precision not null default 0,
  referral_code text,
  referral_signups integer not null default 0,
  referral_subscribed integer not null default 0,
  referral_free_months integer not null default 0,
  referral_reward_pending boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Headroom desktop account profile, keyed 1:1 to a Supabase Auth user.';

-----------------------------
-- licenses
-----------------------------
create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  tier text not null check (tier in ('trial', 'pro', 'max5x', 'max20x', 'pro500')),
  status text not null default 'active'
    check (status in ('active', 'trialing', 'canceled', 'past_due', 'unpaid')),
  starts_at timestamptz not null default now(),
  -- NULL for non-expiring licenses (e.g. lifetime grant).
  ends_at timestamptz,
  -- Trial auto-grant: one time a profile may hold a trialing license.
  kind text not null default 'trial' check (kind in ('trial', 'subscription', 'lifetime')),
  billing_period text check (billing_period in ('monthly', 'annual', null)),
  amount_cents integer,
  cancel_at_period_end boolean not null default false,
  renewal_cents integer,
  renews_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists licenses_profile_id_idx on public.licenses(profile_id);

comment on table public.licenses is
  'Entitlement records for a Headroom profile. The gateway issues these on
   subscription webhook events; the signup trigger grants the initial trial.';

-----------------------------
-- helper: trial license for a profile
-----------------------------
create or replace function public.grant_trial_license(p_profile_id uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Trial grants run once per account: a profile that already has a trialing
  -- row is untouched so a re-signup or re-insert never extends the window.
  if not exists (
    select 1 from public.licenses
    where profile_id = p_profile_id and kind = 'trial'
  ) then
    insert into public.licenses (profile_id, tier, status, kind, starts_at, ends_at)
    values (
      p_profile_id,
      'trial',
      'trialing',
      'trial',
      now(),
      now() + interval '7 days'
    );
  end if;
end;
$$;

-----------------------------
-- signup trigger: profile + trial on first auth user
-----------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;

  select id into v_profile_id from public.profiles where id = new.id;
  if v_profile_id is not null then
    perform public.grant_trial_license(v_profile_id, new.email);
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-----------------------------
-- RLS
-----------------------------
alter table public.profiles enable row level security;
alter table public.licenses enable row level security;

-- A user can read (and update) only their own profile.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Licenses are visible to the owning profile only; nothing user-facing writes
-- them (the service-role gateway is the writer via webhook).
create policy "licenses_select_own" on public.licenses
  for select using (auth.uid() = profile_id);

-- Keep the auth.users insert trigger free of shadow rows: the trigger body
-- runs security definer as the table owner, which bypasses RLS by default,
-- but re-assert the grants/ownership so an accidental revoke can't break it.
-----------------------------
-- sessions (gateway-managed desktop sessions)
-----------------------------
-- The desktop client holds ONE opaque long-lived token (== the gateway's
-- internal session id). The gateway keeps the Supabase access/refresh pair
-- server-side and refreshes it as needed, so a short-lived Supabase access
-- token never forces the desktop to re-sign-in. Only the service role touches
-- this table.
create table if not exists public.sessions (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.sessions enable row level security;
-- No policies: RLS denies everything by default; the service-role gateway
-- bypasses RLS. Clients never read this table directly.

grant select, insert, update on public.profiles to authenticated;
grant select on public.licenses to authenticated;
grant select, insert, update, delete on public.sessions to service_role;
