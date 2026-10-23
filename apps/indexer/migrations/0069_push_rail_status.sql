-- #2667 — the keeper's Push rail readiness, published where the agent can
-- read it.
--
-- Two Workers send Push on one channel: the agent (payment reminders) and the
-- keeper (risky-loan warnings, from its own copy of the key on the keeper
-- machine). The agent's `GET /push/status` could answer only for its own rail,
-- so the app had to say its check covered reminders alone. The keeper now
-- writes what its rail can do, each time its health-factor watcher runs, and
-- the agent combines the two into one answer for the whole service.
--
--   sender      — which Worker's rail the row describes ('keeper'). The
--                 agent answers for its own rail live and writes nothing.
--   usable      — 1 when the rail can issue a request (a signer that signs
--                 as the Push SDK needs, and a well-formed channel); 0 when
--                 it cannot. Not "Push will accept it": nothing local can say.
--   reason      — the rail's reason code when usable = 0, else NULL.
--   channel     — the checksummed channel posted as when usable = 1, else
--                 NULL. Never the key: the status carries no part of it.
--   observed_at — when the sender last read its own configuration (unix
--                 seconds, the sender's clock). A row older than the agent's
--                 freshness bound is read as UNKNOWN, never as the last word.
--
-- Additive: a new table nothing deployed reads or writes. It carries no
-- chain_id, so a Diamond change does not reset it — it describes a Worker's
-- configuration, not any chain's state.
CREATE TABLE IF NOT EXISTS push_rail_status (
  sender TEXT PRIMARY KEY,
  usable INTEGER NOT NULL CHECK (usable IN (0, 1)),
  reason TEXT,
  channel TEXT,
  observed_at INTEGER NOT NULL
);
