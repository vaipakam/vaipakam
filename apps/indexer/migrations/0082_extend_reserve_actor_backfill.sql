-- #2814 — file every stored extension-reserve row under its depositor.
--
-- An extension reserve is its depositor's own money, and the Claims page
-- finds the loans a wallet still holds a reserve on by the activity rows
-- filed under it (`/activity?actor=<wallet>&kind=ExtendReserveFunded`).
-- The actor rule for `ExtendReserveFunded`, `ExtendReserveWithdrawn` and
-- `ExtendChargeDrawn` (`packages/lib/src/activityActor.ts`) arrived with
-- #2814, and the indexer writes activity rows with `INSERT OR IGNORE`, so a
-- row stored before it keeps a null actor and is never rewritten. Without
-- this backfill a reserve funded before #2814 stays off its depositor's
-- Claims list until they fund that loan again.
--
-- The actor is the event's `holder` argument, lower-cased exactly as the
-- rule writes it. Only rows whose actor is still null are touched, and only
-- where `holder` is a 0x address string, so a row the rule has already
-- filed, or one whose args are not the expected shape, is left as it is.
-- `json_valid` first: `json_extract` raises on text that is not JSON.
-- Additive and idempotent: it fills a column the serving code already
-- reads, and a second run finds nothing to update.
UPDATE activity_events
   SET actor = lower(json_extract(args_json, '$.holder'))
 WHERE kind IN ('ExtendReserveFunded', 'ExtendReserveWithdrawn', 'ExtendChargeDrawn')
   AND actor IS NULL
   AND json_valid(args_json)
   AND json_type(args_json, '$.holder') = 'text'
   AND json_extract(args_json, '$.holder') GLOB '0x[0-9a-fA-F]*'
   AND length(json_extract(args_json, '$.holder')) = 42;
