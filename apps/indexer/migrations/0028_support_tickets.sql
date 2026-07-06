-- #1040 phase 1 — support tickets captured by the alpha02 support
-- widget via the agent Worker's POST /support/ticket.
--
-- Lives in apps/indexer/migrations/ per the D1 schema discipline:
-- this directory owns EVERY table on the shared vaipakam-archive
-- database, including tables only apps/agent writes (see CLAUDE.md
-- "Cloudflare D1 schema discipline"). apps/agent reads/writes this
-- table through its existing DB binding.
--
-- Contents are user-submitted text plus the SELF-diagnostics block
-- the widget builds client-side (already address-redacted there);
-- no wallet address column on purpose — a support ticket needs a
-- reply channel (optional email) and context, not an identity.

CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id TEXT PRIMARY KEY,          -- short public id shown to the user (e.g. VPK-4F7C2A)
  created_at INTEGER NOT NULL,         -- unix seconds
  message TEXT NOT NULL,               -- the user's own words (capped at the endpoint)
  email TEXT,                          -- optional reply address the user typed
  diagnostics TEXT,                    -- optional consented self-diagnostics block (pre-redacted client-side)
  page TEXT,                           -- app route the report was sent from
  chain_id INTEGER,                    -- active chain at send time, when known
  status TEXT NOT NULL DEFAULT 'open'  -- open | closed (operator-managed; no in-app writer yet)
);

-- Operator triage + retention sweeps both scan by recency.
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at
  ON support_tickets (created_at);
