-- 0011_liquidity_confidence.sql
--
-- Depth-tiered-LTV liquidity-confidence relay state (apps/keeper —
-- `liquidityConfidence.ts`; see
-- docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.1.b item 2
-- / §4.4 step 5). One row per (chain, collateral asset): the off-chain
-- aggregator-confirmed tier from the last check and the
-- consecutive-eligible-tick streak the promotion rule consumes (promote
-- the on-chain `keeperTier` one step only after the streak has held for
-- `LIQ_CONFIDENCE_MIN_CHECKS` ticks spanning ≥ `LIQ_CONFIDENCE_MIN_WINDOW_DAYS`
-- days; demote immediately on degradation). Lives in the shared D1
-- database the keeper reads/writes alongside `user_thresholds` /
-- `notify_state`.

CREATE TABLE IF NOT EXISTS liquidity_confidence (
  chain_id          INTEGER NOT NULL,
  asset             TEXT    NOT NULL,            -- lowercased 0x collateral-asset address
  agg_tier          INTEGER NOT NULL,            -- aggregator-confirmed tier at the last check (0-3)
  on_chain_tier     INTEGER NOT NULL,            -- on-chain `keeperTier` at the last check (1-3)
  healthy_streak    INTEGER NOT NULL DEFAULT 0,  -- consecutive ticks with agg_tier > on_chain_tier
  first_eligible_ts INTEGER,                     -- ts of the first tick in the current eligible streak
  last_check_ts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, asset)
);
