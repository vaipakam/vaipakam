// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  VaultOutflowTypes
 * @author Vaipakam Developer Team
 * @notice The one vocabulary every vault outflow is described in (#3205 part 2,
 *         `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` §3.1 and §3.3).
 *         The Diamond's policy host ({VaultOutflowFacet}) builds these, and the
 *         vault checks them on its own before anything moves.
 *
 * @dev    Stage A of part 2 (decided default, 2026-11-08) carries every field
 *         the vault-side lien checks of Stage B (#3379) will read: `ref`, the
 *         class and the position token. Stage B adds checks against them; it
 *         does not add an entry point or a field.
 */
library VaultOutflowTypes {
    /// @notice What kind of asset moves.
    enum AssetKind {
        ERC20,
        ERC721,
        ERC1155
    }

    /**
     * @notice Who an outflow may reach. Each class names how its recipient is
     *         established; the vault checks that independently (layer 2).
     * @dev    APPEND-ONLY: the ordinals are emitted in {VaultOutflowFacet}'s
     *         movement event and read by the indexer.
     *         - Owner: the vault owner's own wallet.
     *         - OwnerAllowlisted: a protected account's allowlisted address,
     *           after its delay. Checked by the Diamond only until Stage B
     *           moves the allowlist into the vault.
     *         - PositionHolder: the vault of whoever holds THIS vault's side of
     *           the position now (a release, a claim, a consolidation).
     *         - Counterparty: the vault of whoever holds the OTHER side of the
     *           same loan now.
     *         - MatchedCounterparty: the vault of whoever holds the lender side
     *           of another loan this loan was matched against.
     *         - Treasury: the registry's treasury.
     *         - SwapAdapter: a registry swap adapter (liquidation, default,
     *           swap-to-repay, treasury conversion).
     *         - ListingEscrow: an ERC-1155 listing escrow this vault created.
     *         - Incentive: the actor of this action (liquidator bonus, match
     *           fee, keeper reward).
     *         - LiquidationBuyer: the liquidator that paid the loan's debt in
     *           this same transaction.
     *         - SellerClaim: a recorded prior seller of this loan.
     *         - Backstop: the registry's backstop.
     *         - DiamondTransient: the Diamond itself, within one transaction,
     *           with its onward leg declared in `reason`.
     *         - ClaimCustody: the vault of the loan side's STORED party, where a
     *           settlement parks that side's share until its claim pays the
     *           current holder (decided default, 2026-11-08): a side that
     *           cannot be consolidated to its holder (an NFT rental, a
     *           FallbackPending loan, a Tier-2 sanctioned holder, a live
     *           listing) keeps its custody with the stored party. The vault
     *           checks only that the destination is a genuine Vaipakam vault;
     *           the claim that leaves it is holder-bound (PositionHolder).
     */
    enum OutflowClass {
        Owner,
        OwnerAllowlisted,
        PositionHolder,
        Counterparty,
        MatchedCounterparty,
        Treasury,
        SwapAdapter,
        ListingEscrow,
        Incentive,
        LiquidationBuyer,
        SellerClaim,
        Backstop,
        DiamondTransient,
        ClaimCustody
    }

    /// @notice Who a just-in-time allowance may name as spender.
    /// @dev    APPEND-ONLY. Conduit: a registry marketplace conduit (a
    ///         listing fill). OrderTaker: a registry order protocol (the
    ///         swap-to-repay limit-order fill).
    enum GrantClass {
        Conduit,
        OrderTaker
    }

    /**
     * @notice One movement out of a vault.
     * @param kind          The asset kind.
     * @param asset         The token contract.
     * @param tokenId       The NFT id (0 for ERC-20).
     * @param amount        The amount (1 for ERC-721).
     * @param to            The recipient. For the holder classes it is the
     *                      payee's VAULT, which the vault checks against
     *                      `positionToken`'s holder.
     * @param class_        How `to` is established.
     * @param ref           The loan or offer the movement belongs to (0 for
     *                      the owner classes).
     * @param positionToken For PositionHolder, Counterparty and
     *                      MatchedCounterparty: the position NFT whose current
     *                      holder's vault is the payee. 0 otherwise.
     * @param reason        The business reason (an {OutflowReason} ordinal),
     *                      named in the movement event.
     */
    struct Outflow {
        AssetKind kind;
        address asset;
        uint256 tokenId;
        uint256 amount;
        address to;
        OutflowClass class_;
        uint256 ref;
        uint256 positionToken;
        uint8 reason;
    }

    /**
     * @notice One just-in-time allowance, for the transaction that uses it.
     * @param kind    ERC20 or ERC721 (an ERC-1155 listing goes through an
     *                escrow; the vault never grants an operator approval).
     * @param asset   The token contract.
     * @param tokenId The NFT id (0 for ERC-20).
     * @param amount  The ERC-20 amount (1 for ERC-721).
     * @param spender The registry conduit or order protocol.
     * @param class_  Which registry set `spender` must belong to.
     * @param ref     The loan or offer the grant serves.
     */
    struct Grant {
        AssetKind kind;
        address asset;
        uint256 tokenId;
        uint256 amount;
        address spender;
        GrantClass class_;
        uint256 ref;
    }
}

/**
 * @notice The business reason an outflow carries, named in the movement event
 *         so a reader sees why money moved, not only where.
 * @dev    APPEND-ONLY, like the classes.
 */
library OutflowReason {
    uint8 internal constant WITHDRAW = 0; // the owner's own withdrawal
    uint8 internal constant PAYOUT_RELEASE = 1; // a protected-mode queued payout released
    uint8 internal constant ESCAPE = 2; // a protected-mode escape withdrawal
    uint8 internal constant OFFER_REFUND = 3; // an offer cancelled or mutated: its deposit back
    uint8 internal constant PRINCIPAL = 4; // a loan's principal to its borrower
    uint8 internal constant REPAYMENT = 5; // a repayment to the lender side
    uint8 internal constant INTEREST = 6; // a periodic interest settlement
    uint8 internal constant COLLATERAL_RELEASE = 7; // collateral back to the borrower side
    uint8 internal constant CLAIM = 8; // a terminal claim to the position holder
    uint8 internal constant DEFAULT_TRANSFER = 9; // collateral to the lender on default
    uint8 internal constant LIQUIDATION = 10; // a liquidation leg
    uint8 internal constant FEE = 11; // a treasury fee or cut
    uint8 internal constant INCENTIVE = 12; // a liquidator, matcher or keeper reward
    uint8 internal constant SWAP = 13; // a swap through a registry adapter
    uint8 internal constant SALE = 14; // a loan or collateral sale leg
    uint8 internal constant CONSOLIDATION = 15; // two positions of one holder merged
    uint8 internal constant SELLER_CLAIM = 16; // a prior seller's interest claim
    uint8 internal constant BACKSTOP = 17; // a backstop leg
    uint8 internal constant RECYCLE = 18; // VPFI into the recycle bucket (Diamond transient)
    uint8 internal constant PARTIAL_WITHDRAWAL = 19; // surplus collateral to the borrower side
    uint8 internal constant LISTING_ESCROW = 20; // an ERC-1155 listing's lot into its escrow
    uint8 internal constant SANCTIONED_LOCK = 21; // a sanctioned party's share into its lock
    uint8 internal constant RENTAL = 22; // a rental settlement leg
}
