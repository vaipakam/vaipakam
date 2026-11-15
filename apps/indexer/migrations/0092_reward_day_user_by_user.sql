-- RW-31 (#3216) — one wallet's lifetime claimed rewards (`/rewards/claimed`)
-- sums `reward_day_user` by (chain, user). The table's key leads with the
-- day, so without this index that read scans every row of the chain.
-- Additive: an index only.
CREATE INDEX IF NOT EXISTS idx_reward_day_user_user
  ON reward_day_user (chain_id, user);
