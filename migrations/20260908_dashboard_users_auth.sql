-- =========================================================
-- Multi-user auth for the operator dashboard.
--
-- Replaces the single shared HTTP Basic password (DASHBOARD_AUTH) with named
-- users, invites, and revocable sessions, so access can be granted and removed
-- per person and destructive actions can be attributed.
--
-- Why a sessions table at all: the existing signSession helper is stateless —
-- a signed cookie stays valid until it expires no matter what the server
-- thinks. Without a row to revoke, "remove someone's access" would not take
-- effect for up to the full TTL, which defeats the point of managed users.
-- Session ids are opaque random values; the cookie is the id plus an HMAC over
-- it (see src/shared/portal-auth.mjs), so leaked ids are not usable tokens and
-- no token hash needs storing here.
--
-- Invite tokens ARE stored hashed (SHA-256): unlike sessions they are handed
-- out as raw links, so the table must not contain anything redeemable.
--
-- RLS is enabled on all three tables to match the 2026-06-16 hardening. The
-- dashboard talks to Supabase with the service_role key, which bypasses RLS.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.dashboard_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username           text NOT NULL,
  -- ASCII-folded form used for lookup; UNIQUE here is what stops two accounts
  -- differing only by case. Populated by foldUsername() in portal-auth.mjs.
  username_folded    text NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES public.dashboard_users(id) ON DELETE SET NULL,
  last_login_at      timestamptz,
  -- Login throttling. The old Basic-auth check was an unbounded string compare
  -- with no rate limit, so an attacker got unlimited guesses.
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz
);

CREATE TABLE IF NOT EXISTS public.dashboard_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  username     text,
  role         text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_by   uuid REFERENCES public.dashboard_users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  consumed_by  uuid REFERENCES public.dashboard_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.dashboard_sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.dashboard_users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user     ON public.dashboard_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires  ON public.dashboard_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_invites_expires   ON public.dashboard_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_users_status      ON public.dashboard_users(status);

ALTER TABLE public.dashboard_users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_invites  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_sessions ENABLE ROW LEVEL SECURITY;
