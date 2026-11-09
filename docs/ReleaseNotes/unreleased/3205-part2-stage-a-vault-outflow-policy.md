## Thread — every movement out of a vault through one policy (#3205 part 2, Stage A)

Every movement out of a user's vault now passes one platform rule: a withdrawal, a claim, a fee, a settlement leg, a liquidation pull or an allowance. The rule names the movement's destination class (the owner, the position holder, the counterparty, the treasury, the backstop, a swap adapter, a listing escrow, a stored party's claim custody, and the rest), checks the destination against loan state, and emits one movement record with the vault, asset, amount sent and received, destination, class, reason and loan or offer. The vault then checks the destination again on its own knowledge: its recorded owner, the position-NFT contract's holder, a governance-owned registry, and the fact that every genuine vault runs the same code. The vault's old withdraw and approve entries are gone; it has one door out and one door for allowances.

Three behaviours change for users. An owner's own withdrawal pays only the owner's own wallet unless protected mode allows another address. Claims, the lender's share of an open loan's repayment and a new loan's principal are paid into the payee's vault, from which the payee withdraws. A discounted liquidation pays the seized collateral only to the liquidator that paid, and the backstop's warehoused collateral can be swept only to the treasury.

No vault holds an allowance between transactions any more. A swap-to-repay fill is granted exactly its lot inside the fill, and a collateral listing's ERC-721 is approved to the marketplace conduit only inside the fill. An ERC-1155 listing moves its lot into an escrow the vault creates for that listing, which is the marketplace order's seller; every teardown brings the rest back.

ForcedSaleFacet had reached 11 bytes under the contract size limit, so its two previews move to a new ForcedSalePreviewFacet, with the sizing rule both read in one shared library. A launch is now refused until the registry names the treasury and carries every route the platform sells or lists through. Design and every decided default: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage A build notes).

> Caveat: the backstop vault and the aggregator adapter, which hold lender positions, claim through one shared rule that withdraws the claim's vault credit to them. Both are their own upgradeable contracts and change with this release.
> Caveat: Stage A does not yet bound an amount by an owner-signed lien. That, the class budgets, the payee-receipt release and the seller-claim check are Stage B (#3379). No deployment happens before Stage B.
> Caveat: the launch check needs the protocol registry (#3383); until it lands, every launch refuses.
> Caveat: a share that cannot follow its holder yet is parked with the loan's stored party until the claim (#3381 makes it follow the holder).
> Caveat: AutoLifecycleFacet and EncumbranceMutateFacet are next to split for size (#3385).
