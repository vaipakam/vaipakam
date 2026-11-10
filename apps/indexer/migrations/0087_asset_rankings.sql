-- #3446 — asset trust tiers in the new app (#3180).
--
-- The app labels each token by where it sits in the market-cap rankings of
-- two public aggregators (Blue chip / Top 100 / 200 / 300 / 500; beyond 500
-- it warns the user they act at their own risk). The keeper machine fetches
-- both rankings once a day (pass `assetRankings`, disarmed until an owner
-- arms it) and writes them here; the indexer serves them read-only on
-- `GET /assets/rankings?chainId=`. No user data and nothing derived from the
-- chain: a cache of public lists, refreshed whole on every good run.
--
-- asset_ranking: one row per (token chain, contract address, source). The
-- address is the exact contract on that chain, lowercase, so a look-alike
-- token at another address never inherits a ranked token's tier. Where one
-- source lists an address twice, the writer keeps the better (lower) rank.
-- A good run replaces a (source, chain)'s rows and its run row in one batch,
-- every row carrying that run's fetched_at, so the rows a reader sees are
-- always one run's whole list, never a mix.
--
-- asset_ranking_run: the last run per (source, chain), good or not, so the
-- app can say how old the list is and whether the latest fetch failed. A
-- failed run writes only this row (ok = 0) and leaves the last good list in
-- place; the date of that list is max(fetched_at) over its rows.
--
-- chain_id here is the TOKEN's chain (1, 8453, 42161, 137, 10, 56), not a
-- Diamond's. Both tables are listed in src/diamondEpochKeep.json so a fresh
-- Diamond on a chain does not wipe a list that has nothing to do with it.
--
-- Additive: two new tables and an index, safe while the previous Workers are
-- still serving (nothing reads or writes them yet).
CREATE TABLE IF NOT EXISTS asset_ranking (
  chain_id   INTEGER NOT NULL,
  address    TEXT    NOT NULL CHECK (address = lower(address) AND length(address) = 42),
  source     TEXT    NOT NULL CHECK (source IN ('cg', 'cp')),
  rank       INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 500),
  name       TEXT    NOT NULL CHECK (length(name) <= 100),
  symbol     TEXT    NOT NULL CHECK (length(symbol) <= 32),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address, source)
);

-- Token search in the app matches by symbol within one chain.
CREATE INDEX IF NOT EXISTS idx_asset_ranking_symbol
  ON asset_ranking(chain_id, symbol);

CREATE TABLE IF NOT EXISTS asset_ranking_run (
  source     TEXT    NOT NULL CHECK (source IN ('cg', 'cp')),
  chain_id   INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  row_count  INTEGER NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail     TEXT,
  PRIMARY KEY (source, chain_id)
);
