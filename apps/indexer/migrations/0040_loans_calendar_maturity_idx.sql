-- #1213 PR 2 (Codex #1298 r4) — range-scan index for the calendar
-- reminder sweep (calendarNotifications.ts).
--
-- The sweep runs EVERY caught-up tick and filters/orders on the derived
-- maturity `start_time + duration_days * 86400`. Without a matching
-- expression index SQLite picks idx_loans_chain_is_stub and builds a
-- temp B-tree for the ORDER BY, so the per-tick cost grows with the
-- chain's TOTAL active loan set instead of the due/grace window.
--
-- Partial on exactly the sweep's fixed predicate terms (status/stub/
-- sale-vehicle/start_time>0 — the query states them verbatim, so
-- SQLite's partial-index implication check accepts it), keyed on
-- (chain_id, maturity-expression) so the BETWEEN window range-scans and
-- the ORDER BY on the same expression needs no sort step. The
-- expression must stay textually identical to the query's (SQLite
-- matches expression indexes structurally).
CREATE INDEX IF NOT EXISTS idx_loans_calendar_maturity
  ON loans (chain_id, (start_time + duration_days * 86400))
  WHERE status = 'active' AND is_stub = 0 AND is_sale_vehicle = 0
    AND start_time > 0;
