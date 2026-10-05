-- #2383 — the asset and amount each activity row moved or offered, normalized
-- at ingest (apps/indexer/src/activityValue.ts). ADDITIVE ONLY (#2409): the
-- running Workers ignore columns they do not name, and `/activity` reads them
-- through `SELECT *`, so a database without them still serves.
--
-- asset       lowercase token address, or NULL when not established
-- asset_type  LibVaipakam.AssetType (0 ERC-20, 1 ERC-721, 2 ERC-1155), or NULL
-- amount      base units as a decimal string; ERC-20 only, else NULL
-- amount_max  a range's ceiling (strictly above amount); NULL when exact
-- token_id    NFT token id as a decimal string; NFTs only, else NULL
-- quantity    ERC-1155 copies as a decimal string; ERC-1155 only, else NULL
--
-- Rows written before this migration keep NULL in all five: the app shows
-- no amount for them rather than reconstructing one.
ALTER TABLE activity_events ADD COLUMN asset TEXT;
ALTER TABLE activity_events ADD COLUMN asset_type INTEGER;
ALTER TABLE activity_events ADD COLUMN amount TEXT;
ALTER TABLE activity_events ADD COLUMN amount_max TEXT;
ALTER TABLE activity_events ADD COLUMN token_id TEXT;
ALTER TABLE activity_events ADD COLUMN quantity TEXT;
