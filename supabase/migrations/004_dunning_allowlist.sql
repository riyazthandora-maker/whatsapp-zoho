-- ── Dunning phone allowlist ────────────────────────────────────────────────────
-- Stores the set of customer phones that are allowed to receive dunning messages
-- when filter_mode = 'allowlist'. Phone values are stored normalised (digits only).
CREATE TABLE IF NOT EXISTS dunning_allowlist (
  phone      TEXT        PRIMARY KEY,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Dunning settings (key/value) ───────────────────────────────────────────────
-- filter_mode: 'allowlist' = only phones in dunning_allowlist receive messages
--              'all'       = all customers receive messages (filter off)
CREATE TABLE IF NOT EXISTS dunning_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default: filter is ON (allowlist mode)
INSERT INTO dunning_settings (key, value)
VALUES ('filter_mode', 'allowlist')
ON CONFLICT (key) DO NOTHING;

-- ── Row-Level Security ─────────────────────────────────────────────────────────
ALTER TABLE dunning_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_settings  ENABLE ROW LEVEL SECURITY;

-- ── Explicit grants (required from Supabase Oct 30 2026 onwards) ───────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dunning_allowlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dunning_settings  TO service_role;
