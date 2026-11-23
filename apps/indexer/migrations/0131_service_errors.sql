-- #3922 — the service error record (TroubleshootingPictureDesign.md §3, §4.6).
--
-- One row per failed or refused request to the indexer or the agent, written
-- by `withRequestReference` (packages/lib/src/serviceErrors.ts) after the
-- response is sent:
--   service           indexer | agent
--   method            the request's method
--   route             the path as a PATTERN: plain words kept, every id,
--                     hex value or other segment replaced by a placeholder,
--                     the query string never read. So no address that
--                     appeared in a path reaches this table
--   status            the status returned (a throw is recorded as 500)
--   reference         the request reference the response carried
--   reference_source  app (the request carried it) | service (made here)
--   build             the service's deploy tag, or `unstamped`
--   version_id        the platform's version id, when the binding has one
--   at                unix seconds
--
-- No wallet, no address of any kind and no network address of the caller.
-- Every 5xx is recorded; a 4xx only from one of the app's own origins.
--
-- service_error_hours counts every failure considered for the record per
-- service per hour. A row is kept only while the rows already kept for that
-- service are under 25 this hour and 300 this UTC day, so the counter says
-- how many were not kept, and the table stays bounded (two services, 90 days:
-- at most 54,000 rows).
--
-- Not served by any public route. Kept 90 days by default
-- (SERVICE_ERROR_RETENTION_DAYS); the indexer cron prunes older rows.
-- Nothing here is replayed from a chain, and no row names a chain, so a new
-- Diamond or a reorg leaves it alone.
-- Additive: new tables and their indexes only.
CREATE TABLE IF NOT EXISTS service_errors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  service          TEXT    NOT NULL,
  method           TEXT    NOT NULL,
  route            TEXT    NOT NULL,
  status           INTEGER NOT NULL,
  reference        TEXT    NOT NULL,
  reference_source TEXT    NOT NULL,
  build            TEXT    NOT NULL,
  version_id       TEXT,
  at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_errors_at ON service_errors (at);
CREATE INDEX IF NOT EXISTS idx_service_errors_reference ON service_errors (reference);
CREATE INDEX IF NOT EXISTS idx_service_errors_service_at ON service_errors (service, at);

CREATE TABLE IF NOT EXISTS service_error_hours (
  service    TEXT    NOT NULL,
  hour_start INTEGER NOT NULL,
  failures   INTEGER NOT NULL,
  PRIMARY KEY (service, hour_start)
);
