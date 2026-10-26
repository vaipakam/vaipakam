-- #1481 — remove signed offers stored in a shape the platform no longer
-- writes, so every stored order is one a taker can replay.
--
-- A row stored before #1949 carries the 28-field order: its signature is
-- over the old typehash, so the Diamond can never accept it, and the book
-- and the market summaries have filtered it out with a predicate on
-- `order_json` ever since (0061). The signed-offer route accepts only the
-- 31-field order, so no new such row can appear. Deleting the old ones
-- states the invariant instead of filtering for its absence: the book and
-- the summaries drop the predicate, and the restore converter, which
-- re-admits an archived row only in the form the route writes
-- (`packages/lib/src/signedOfferWire.mjs`), never meets one in a backup
-- taken after this migration. The signed-offer backup starts with #1481,
-- so no earlier archive carries the table at all.
--
-- `json_valid` first: `json_extract` raises on text that is not JSON, and
-- such a row is not a replayable order either. The deleted rows were
-- already excluded from every read and summary, so nothing that is served
-- changes. Compatible with the code still serving while it lands, which
-- reads with the predicate this makes redundant.
DELETE FROM signed_offers
 WHERE CASE
         WHEN json_valid(order_json) THEN json_extract(order_json, '$.creatorFull') IS NULL
         ELSE 1
       END;
