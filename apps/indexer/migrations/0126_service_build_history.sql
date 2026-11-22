-- #3921 — the build history (TroubleshootingPictureDesign §4.5 "Builds"):
-- which build of each service was running, from when. A row is added each
-- time a service is seen running a build (or Cloudflare version) other than
-- the one its latest row names, so a rollback is a row of its own.
--
--   service     indexer | agent | failed-tx-pass | app | www | alpha05
--   seen_at     unix seconds the build was first seen running
--   build       the deploy stamp's tag (12 hex digits of the commit, with
--               '-dirty' when the build held uncommitted changes), or
--               'unstamped' when the service could not name it
--   version_id  the Cloudflare version id, for a Worker that notes its own
--   source      self (the Worker's own version metadata) | pass-report (the
--               failed-tx pass, with its writes) | build-file (the
--               build.json a static build serves, read by the indexer)
--
-- Written only through @vaipakam/lib/buildHistory. Born off chain: no
-- replay recreates it, so it is archived nightly and kept for the life of
-- the deployment. It names no user. Additive: a new table only.
CREATE TABLE IF NOT EXISTS service_build_history (
  service    TEXT    NOT NULL,
  seen_at    INTEGER NOT NULL,
  build      TEXT    NOT NULL,
  version_id TEXT,
  source     TEXT    NOT NULL,
  PRIMARY KEY (service, seen_at, build)
);
