-- ── Payment commitment tracking ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_commitments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_zoho_id    TEXT        NOT NULL,
  customer_name       TEXT        NOT NULL,
  customer_phone      TEXT        NOT NULL,
  invoice_number      TEXT        UNIQUE NOT NULL,
  amount              NUMERIC     NOT NULL,
  committed_date      DATE,
  assigned_rep_id     UUID        REFERENCES sales_reps(id),
  status              TEXT        NOT NULL DEFAULT 'pending',
  -- pending | negotiating | committed | soft_commitment
  -- declined | collected | broken | escalated
  no_count            INT         NOT NULL DEFAULT 0,
  exchange_count      INT         NOT NULL DEFAULT 0,
  template_step       INT         NOT NULL DEFAULT 0,
  -- 0=none, 1=advance_notice, 2=overdue_collect, 3=followup, 4=final_notice
  template_sent_at    TIMESTAMPTZ,
  customer_replied_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Full conversation history (fed to Gemini each turn) ────────────────────────
CREATE TABLE IF NOT EXISTS dunning_conversations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id  UUID        NOT NULL REFERENCES collection_commitments(id) ON DELETE CASCADE,
  role           TEXT        NOT NULL,   -- 'bot' | 'customer'
  message        TEXT        NOT NULL,
  language       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_conv_commitment
  ON dunning_conversations(commitment_id, created_at);

-- ── Rep task list ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rep_tasks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id           UUID        REFERENCES sales_reps(id),
  customer_zoho_id TEXT        NOT NULL,
  customer_name    TEXT        NOT NULL,
  invoice_number   TEXT        NOT NULL,
  amount           NUMERIC     NOT NULL,
  task_type        TEXT        NOT NULL,  -- 'collection' | 'escalation' | 'follow_up'
  due_date         DATE,
  status           TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'done' | 'broken' | 'noted'
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rep_tasks_rep_status
  ON rep_tasks(rep_id, status);

-- ── Row-Level Security ─────────────────────────────────────────────────────────
ALTER TABLE collection_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_conversations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rep_tasks               ENABLE ROW LEVEL SECURITY;
