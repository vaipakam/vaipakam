## Thread — Vault beacon history in the indexer

The indexer now keeps the vault beacon's own records: every proposal, cancellation, application, version and revocation, per chain and in chain order, with the block, the version each names and the time from which a waiting change may apply. They are served at `/vault-beacon/events`, filtered by vault (that vault's own requests plus the changes that apply to every vault), by kind, and paged backwards. Each answer states the last block the indexer has read, so a reader can tell "no change yet" from "not read yet".

The beacon is read in the same log request as the Diamond, so the scan costs no extra request; a block that carries only beacon records is still processed and the cursor still moves past it. The beacon and the Diamond both emit an ownership-transfer record with the same signature, so beacon records are told apart by the address that emitted them and never land in the Diamond's tables.

This is the indexer half; the app's upgrade notice (#3422) and any agent alert (#3281) read it. Part of #3281, part of #3422.

> Caveat: history starts at the indexer's current cursor for chains already indexed; earlier beacon records arrive only on a fresh epoch or a rescan.
