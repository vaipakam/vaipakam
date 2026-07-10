### Indexer: Base-Sepolia ingest stall fixed — offer modifications no longer wedge the scan (#1149)

The chain indexer's handler for offer modifications tried to save a
"maximum collateral" figure into a database column that was never
created. The database rejected the write, the scan treated that as a
retriable failure (by design — a failed scan must not skip events), and
the Base-Sepolia ingest cursor wedged in place, retrying the same
failing window every tick from 06:57 UTC on 2026-07-10. The book, tape
and history surfaces on that chain silently stopped receiving new
on-chain events (the fault was dormant since 2026-06-30 and only fired
once an offer modification actually appeared in the scan window).

Fixed by dropping the phantom column from the modification update — the
platform stores and displays the modified offer's amounts, rates and
collateral floor, none of which changed. Recovery needs no operator
action beyond the normal deploy: once live, the stuck scan window
succeeds and the cursor catches up on its own.

A new automated guard now prepares every database statement in the
indexer against the exact schema the migrations produce, so a statement
referencing a table or column that doesn't exist fails in CI instead of
wedging production ingest.
