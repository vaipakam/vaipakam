-- apps/keeper/migrations/0008_keeper_private_send.sql
--
-- #3408 — the private sends the keeper may still have to send publicly. On a
-- chain whose private route allows a public fallback
-- (`PRIVATE_TX_FALLBACK_CHAIN_IDS`), every transaction a private endpoint
-- ACCEPTS is recorded here with its signed bytes. Each tick sends the same
-- bytes through the chain's ordinary RPC once the send has been unmined for
-- `PRIVATE_TX_PUBLIC_AFTER_SECONDS` (`src/privateRebroadcast.ts`), and notes
-- when it did (`public_at_ms`). `sent_at_ms` is when the private endpoint
-- accepted the send (the timeout runs from it); `reserved_at_ms` is when its
-- nonce was reserved (the private nonce window runs from it, as the
-- reservation in `keeper_private_nonce` does). A row is forgotten once its
-- nonce is mined, once it is reported as having left the window uncopied, or,
-- after a public copy, once its window has passed.
--
-- Keyed by `network_id`, deliberately NOT `chain_id`, like
-- `keeper_private_nonce`: the record belongs to the account on the network,
-- not to a Diamond, so a fresh Diamond's epoch reset (`keeperEpoch.ts` clears
-- every table with a `chain_id` column) must leave it alone. Additive: a new
-- table the running build never reads.
CREATE TABLE IF NOT EXISTS keeper_private_send (
  network_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  raw_tx TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  public_at_ms INTEGER,
  PRIMARY KEY (network_id, tx_hash)
);
