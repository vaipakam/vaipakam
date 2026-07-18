# Interaction-rewards read-only lens facet (EIP-170 headroom)

The read-only view/getter surface of the interaction-rewards system —
`previewInteractionRewards`, `getInteractionSnapshot`,
`getInteractionClaimability`, `getUserRewardEntries`, the pool/day/cap
getters, and the rest of the 14 pure/view functions — was carved out of
`InteractionRewardsFacet` into a new `InteractionRewardsLensFacet`.

No behaviour changes: the functions moved verbatim and route to the same
selectors from the same Diamond address, so every caller (frontend,
indexer, cross-facet reads) sees an identical surface. The split is
purely structural — it drops `InteractionRewardsFacet` from the EIP-170
ceiling (~24.6KB) back to ~17.2KB, restoring generous bytecode headroom
so the claim/sweep surface can keep growing (e.g. the recycling
loop-closure work) without being squeezed against the 24,576-byte limit.
The lens facet itself is ~5.3KB.
