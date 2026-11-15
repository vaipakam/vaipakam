-- #3327 — remove signed offers stored in the shape before the maker's
-- protections, so every stored order is one a taker can replay.
--
-- #3327 added four signed fields (the two fee caps, the allowed taker and
-- the co-signer), which changes the typehash: a row stored before it carries
-- the 31-field order, whose signature the Diamond can no longer accept, and
-- the signed-offer route accepts only the 35-field order, so no new such row
-- can appear. The same treatment migration 0078 gave the pre-#1949 rows: the
-- book, the summaries and the restore converter all read only the shape the
-- route writes (`packages/lib/src/signedOfferWire.mjs`), and this keeps the
-- table in it.
--
-- `json_valid` first: `json_extract` raises on text that is not JSON, and
-- such a row is not a replayable order either. Compatible with the code
-- still serving while it lands: the rows it removes are ones that code's
-- own Diamond could fill, but the deployment carrying this migration serves
-- the new shape only, and the platform is prelive with a fresh deploy to
-- follow (no row is migrated across a typehash change).
DELETE FROM signed_offers
 WHERE CASE
         WHEN json_valid(order_json) THEN json_extract(order_json, '$.coSigner') IS NULL
         ELSE 1
       END;
