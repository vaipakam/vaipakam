## Thread — T-086 #316: fast OpenSea catalog refresh via Seaport.cancel emit (PR #<n>)

When a borrower's prepay-collateral listing is closed out — by a borrower
cancel, an update that rotates to a fresh ask, the permissionless
grace-expired cancel, or a terminal loan event (repay, preclose,
refinance, default, HF-liquidation) — Vaipakam's on-chain bookkeeping
correctly invalidates the order: the executor's binding is dropped, the
borrower vault revokes the conduit approval and forgets the orderHash,
and the ERC-1271 delegate will reject any future signature for that hash.
That's enough to make the order unfillable: even if a buyer tries to fill
the stale listing through OpenSea's marketplace UI, the executor's zone
callback reverts the transaction and the buyer's wallet shows a clean
failure. But the OpenSea marketplace catalog itself doesn't know the
order is dead until its lazy stale-listing scan eventually catches up —
typically hours. During that window the UI still shows the listing as
"live," and buyers waste a wallet signature and a small amount of gas on
a guaranteed-revert simulation each time they try to fill it.

This change closes that window. The executor now records the full
sign-time inputs (conduit key, salt, post timestamp, ask price) alongside
the existing `(loanId, conduit)` binding, so at cleanup time it can
reconstruct the exact `OrderComponents` Seaport hashed at sign time and
forward `Seaport.cancel` on the matching orderHash. The executor is
already the zone on every prepay-listing order it records, so Seaport
accepts the call directly. Seaport then emits its own `OrderCancelled`
event, which OpenSea's marketplace indexer watches — the listing
disappears from the UI within roughly thirty seconds instead of hours,
and buyers stop seeing the stale entry. The acceleration applies
uniformly to all cleanup paths (cancel, update, grace-expired, every
terminal flow).

The cancel emit is **best-effort and never load-bearing for safety**.
The cleanup proper — binding delete, vault revoke, lock release — is
what actually prevents fills, and it always runs. The cancel emit
gracefully falls back to a no-op in three edge cases: a position-NFT
holder transferred between sign and cleanup (the reconstructed
consideration recipients differ); the borrower vault's Seaport counter
was incremented (a different orderHash); or the treasury fee floor
drifted upward through governance (the recorded ask is now below the
fresh floor, breaking the canonical-construction math). Each case emits
a `SeaportCancelSkipped` operator-side breadcrumb so the cleanup history
is auditable. In every other case — the overwhelming majority of real
prepay-listing cleanups — `SeaportCancelEmitted` confirms the
acceleration fired.

Storage cost is three new slots per recorded listing (~60k gas added to
the post path); the lookup remains a single mapping read. The change is
contracts-only — frontend and Worker flows already use the on-chain
state of the loan as their source of truth, so they automatically benefit
from the faster OpenSea catalog refresh without any consumer-side update.

Closes #316. Follow-up to PR #317's terminal-state sweep, which had
flagged Seaport.cancel emit as a deferred fast-refresh win.
