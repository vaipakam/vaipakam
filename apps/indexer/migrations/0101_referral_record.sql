-- #3727 — the referral record behind the inviter's page (design:
-- docs/DesignsAndPlans/ReferralFeeShareDesign.md section 6.1).
--
-- Both tables are read off the Diamond's own events and nothing else:
-- `InviterBound` (one row per wallet that bound an inviter, with the end
-- time the contract fixed for it) and `ReferralShareSettled` (one row per
-- loan whose referral cut or share was above zero, with where the share
-- went). Replay-derived: a fresh Diamond resets them with the chain epoch,
-- and a rebuild replays them. Amounts are decimal strings in the asset's
-- own units, so no precision is lost to SQLite's 64-bit integers.

CREATE TABLE IF NOT EXISTS referral_binding (
  chain_id     INTEGER NOT NULL,
  new_user     TEXT    NOT NULL,  -- lowercased
  inviter      TEXT    NOT NULL,  -- lowercased
  ends_at      INTEGER NOT NULL,  -- unix seconds, as the event states it
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  bound_at     INTEGER NOT NULL,  -- the block's chain time
  PRIMARY KEY (chain_id, new_user)
);

CREATE INDEX IF NOT EXISTS idx_referral_binding_inviter
  ON referral_binding (chain_id, inviter, block_number);

CREATE TABLE IF NOT EXISTS referral_share (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  loan_id      TEXT    NOT NULL,  -- decimal
  offer_id     TEXT    NOT NULL,  -- decimal
  new_user     TEXT    NOT NULL,  -- lowercased
  inviter      TEXT    NOT NULL,  -- lowercased
  asset        TEXT    NOT NULL,  -- lowercased
  cut          TEXT    NOT NULL,  -- decimal, the new user's amount not charged
  share        TEXT    NOT NULL,  -- decimal, the inviter's share
  outcome      INTEGER NOT NULL CHECK (outcome BETWEEN 0 AND 4),
  settled_at   INTEGER NOT NULL,  -- the block's chain time
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_referral_share_inviter
  ON referral_share (chain_id, inviter, block_number);
