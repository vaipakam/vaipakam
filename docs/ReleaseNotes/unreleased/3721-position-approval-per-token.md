## Position tokens are approved one at a time (#3721)

A position token can no longer be approved together with all of a holder's other position tokens. The approve-everything prompt that marketplaces and dishonest websites both use is refused for position tokens, so one careless signature cannot hand over every loan and offer position a holder has. Revoking such an approval still succeeds, so wallet clean-up tools keep working.

Approving a single token works as before. The approval is cleared when the token moves, refused while the holder's tokens are locked, and retired by a later lock. Marketplaces list a single position with that per-token approval.

Nothing in the platform needed the wider approval: its loan sales, offsets and obligation handovers retire the old token and mint a new one, and the platform's own listings approve the collateral, never a position token.

The position token contract changes, so this reaches a chain by fresh deploy. Design: `PositionSaleStateGuardDesign.md` section 3.9.
