-- #2560 — retire the shared copies of the five keeper tables.
--
-- WHY. Since #2450 the keeper keeps its operational state in its own database,
-- `vaipakam-keeper-db`. These five tables were created here by 0041, 0043 and
-- 0044, before that split, and the one-time cutover (2026-10-18) copied them to
-- the keeper's database. Since then nothing reads or writes these copies: the
-- keeper's code writes only its private database, and the only reader left was
-- the keeper's own cutover check, which watched them to catch a legacy keeper
-- still writing here. That check could not see a legacy keeper that only
-- deleted rows (#2560), so the copies are retired instead of watched.
--
-- SAFE AGAINST THE DEPLOYED KEEPER. The keeper's cutover check reads a missing
-- table as retired and passes, so this lands safely whichever keeper build is
-- serving. The keeper code released with it no longer looks at these tables.
--
-- Drops only. `apps/keeper/test/keeperPrivateD1.test.ts` allows a shared
-- migration to do nothing else to a keeper-private table. 0041, 0043 and 0044
-- are applied and stay as they are, so a fresh database still creates these
-- tables and then drops them here.
DROP TABLE IF EXISTS hf_band_state;
DROP TABLE IF EXISTS keeper_commitment_scan;
DROP TABLE IF EXISTS keeper_commitment_day;
DROP TABLE IF EXISTS keeper_remit_ack;
DROP TABLE IF EXISTS keeper_remit_ack_frontier;
