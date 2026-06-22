## Thread — LibPrepayOrder: bundle the order-spec scalars into a memory struct (PR #<n>)

Pure refactor of the canonical Seaport `OrderComponents` builder, with **no
behaviour change** — every prepay listing's derived orderHash is byte-identical
(the fixed-price, Dutch, atomic, cancel-reconstruction, and parallel-sale suites
all stay green).

The builder `LibPrepayOrder._componentsAtMemory` took nine scalar order-spec
arguments (`startAskPrice`, `endAskPrice`, `lenderLeg`, `treasuryLeg`, `salt`,
`conduitKey`, `startTime`, `seaportEndTime`, `counter`) and — because the whole
`buildAndHash*` → `_componentsAtMemory` chain is `internal`/`private` and inlines
into each listing facet — those nine values lived as nine simultaneous stack
slots in the flattened frame, holding the NFT-prepay listing compilation unit at
the exact viaIR whole-unit stack ceiling. Any addition anywhere in that unit
overflowed it.

They're now bundled into an `OrderSpec` memory struct, read on-demand (one
`mload` each at use) instead of nine live stack slots. The public builders
(`buildAndHash`, `buildAndHashMem`, `buildAndHashDutch`, `componentsForCancel`,
`componentsForCancelDutch`) keep their scalar signatures — each just packs its
scalars into an `OrderSpec` before the private build — so callers and the
orderHash inputs are untouched; only the two private helpers (`_componentsAtMemory`,
`_componentsAtCalldata`) changed shape.

This recovers the whole-unit slack needed to wire the #594 consolidate-before-
listing hooks (the #656b prerequisite — #697). Confirmed: with this lean the
fixed-price `postPrepayListing` consolidate hook now compiles where it previously
tipped `_componentsAtMemory`. (The Dutch / atomic / auto-list *entry* functions
carry their own separate per-function ceilings, addressed in #656b.)

Closes #697 (#656a). Prerequisite for #698 (#656b).
