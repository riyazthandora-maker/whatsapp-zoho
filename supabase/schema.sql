-- ── Sales reps registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_reps (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  whatsapp_number  TEXT        UNIQUE NOT NULL, -- E.164 format e.g. +971501234567
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  role             TEXT        NOT NULL DEFAULT 'rep', -- 'rep' | 'admin'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Zoho customer cache (synced nightly via /api/sync-customers) ───────────────
CREATE TABLE IF NOT EXISTS zoho_customers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_contact_id  TEXT        UNIQUE NOT NULL,
  name             TEXT        NOT NULL,
  email            TEXT,
  phone            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full-text index for fast fuzzy name search
CREATE INDEX IF NOT EXISTS idx_zoho_customers_name
  ON zoho_customers USING gin(to_tsvector('english', name));

-- ── Audit log (append-only — never delete rows) ───────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id           UUID        REFERENCES sales_reps(id),
  rep_name         TEXT        NOT NULL,
  rep_phone        TEXT        NOT NULL,
  customer_zoho_id TEXT        NOT NULL,
  customer_name    TEXT        NOT NULL,
  statement_from   DATE,
  statement_to     DATE,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_status  TEXT        NOT NULL DEFAULT 'pending' -- 'delivered' | 'failed'
);

-- ── Row-Level Security ────────────────────────────────────────────────────────
-- All access goes through the service_role key (server-side only), which
-- bypasses RLS. Enabling RLS with no public policies locks out the anon role.
ALTER TABLE sales_reps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;

-- ── Sample: add your first sales rep ─────────────────────────────────────────
-- INSERT INTO sales_reps (name, whatsapp_number, role)
-- VALUES ('Riyaz', '+971501234567', 'admin');
