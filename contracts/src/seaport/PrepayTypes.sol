// src/seaport/PrepayTypes.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// Round-6 / Block D (#345): the BidderOrder struct below carries a
// typed Seaport `OrderComponents` so the atomic facet can pass it
// directly to `Seaport.getOrderHash` without an on-chain decode
// step. ISeaportOrderHash is a leaf file with no Vaipakam-specific
// imports, so this one-way import is acyclic.
import {OrderComponents} from "./ISeaportOrderHash.sol";

// PrepayTypes — T-086 Round-5 Block A (Issue #313)
//
// Shared struct vocabulary for the extended N-leg prepay-listing
// surface. Lives in its own file so the diamond facet, the canonical
// order builder (`LibPrepayOrder`), the recorder interface
// (`IListingExecutorRecorder`), and the executor's storage layout
// (`CollateralListingExecutor`) can ALL import the same shape without
// a library / interface cyclic-import awkwardness.
//
// Round 5 design ratified at
// `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §14.5.

// Hard cap on the number of marketplace-required fee legs allowed
// per prepay-collateral listing. Round-5 Block A (#313) sets this
// at 4 — covering the realistic worst case of OpenSea's protocol
// fee + up to 3 creator-side recipients for collections with artist
// splits / DAO shares. The executor's `_assertOrderContent` length
// cap is `3 + MAX_FEE_LEGS = 7`; the facet's posting validations
// enforce the same bound at sign time. If OpenSea's schedule ever
// requires more than 4 required legs the cap is lifted in a
// follow-up. See §14.5 of the design doc.
uint256 constant MAX_FEE_LEGS = 4;

// Round-5 Block B (Issue #309) — auction-mode discriminator the
// executor's recordOrder + cancel-time reconstruction dispatch on.
// Kept as plain uint8 constants (not a Solidity enum) so the
// recorder interface, the executor storage layout, and every
// off-chain consumer (TS, JSON ABI) all see the same wire-level
// shape with no implicit casting surface.
//
// `PREPAY_MODE_FIXED_PRICE` — the Round-4 / Block A path. The
// borrower-leg and every fee-leg have `startAmount == endAmount`;
// the Seaport `OrderComponents.endTime` is `loan.gracePeriodEnd`
// and Seaport's amount-interpolation collapses to the constant.
//
// `PREPAY_MODE_DUTCH` — the Block B path. The borrower-leg decays
// from `startAskPrice − projectedLender − projectedTreasury −
// sum(feeLegs.startAmount)` down to `endAskPrice − projectedLender
// − projectedTreasury − sum(feeLegs.endAmount)` over the window
// `[startTime, auctionEndTime]`. Lender + treasury legs stay
// pinned at the projected-max floor at `auctionEndTime` (see
// design doc §15.2). The Seaport `OrderComponents.endTime` is
// `auctionEndTime`, NOT `gracePeriodEnd` — past `auctionEndTime`,
// Seaport rejects fills as expired and the protocol-side cleanup
// path (`cancelPrepayListing` / `cancelExpiredPrepayListing`)
// handles the still-locked NFT.
uint8 constant PREPAY_MODE_FIXED_PRICE = 0;
uint8 constant PREPAY_MODE_DUTCH = 1;

// T-086 Round-6 / Block D (#345) — atomic match-rotation via Seaport
// matchAdvancedOrders. The new facet's matchOpenSeaOffer entry point
// constructs a Vaipakam-side counter-order on-the-fly and matches it
// atomically against the bidder's signed OpenSea Offer in a single tx,
// killing the v1 English-mode race window (§15.3 → §17 of the design
// doc). For the executor's mode-dispatch + cancel-time reconstruction,
// atomic-match orders reuse the fixed-price COMPONENTS shape (3-leg
// consideration: lender + treasury + borrower remainder; no fee legs
// on the Vaipakam side — bidder's signed Offer carries any OpenSea /
// creator fees in ITS consideration array, not ours, per §17.7).
uint8 constant PREPAY_MODE_ATOMIC_MATCH = 2;

// Minimum auction window for Dutch listings, enforced at the facet
// boundary. Protects against accidentally posting a sub-block-window
// auction that locks the borrower's NFT but can never fill (the
// pinned lender + treasury legs would over-cover any fill at
// t < auctionEndTime, but the borrower's UI would never see a
// usable price band). One hour is the conservative v1 floor —
// design doc §15.2.
uint256 constant MIN_AUCTION_WINDOW = 1 hours;

/// @notice One marketplace-required fee leg in a prepay-collateral
///         listing. Borrower-supplied at post time, sourced from
///         OpenSea's Collection API by the dapp.
/// @dev    Packed across 2 storage slots:
///           slot 0: `address recipient` (20B) + `uint96 startAmount` (12B)
///           slot 1: `uint96 endAmount`   (12B) + 20B padding
///
///         `uint96` covers 7.9 × 10^28 wei — vastly above any realistic
///         fee amount in any ERC20. The facet's bounds-checked
///         narrowing casts on input fail-loud on overflow, mirroring
///         the existing `LoanIdOverflow` / `AskPriceOverflow` pattern
///         in {CollateralListingExecutor}.
///
///         For **fixed-price** listings the facet enforces
///         `startAmount == endAmount` so each fee leg flows into a
///         constant `ConsiderationItem`. The `≥` form is reserved
///         for the Dutch posting path (§15.2 / Block B), where
///         Seaport's native interpolation between
///         (`startAmount`, `endAmount`) produces the decayed amount
///         at fill time.
struct FeeLeg {
    address recipient;
    uint96 startAmount;
    uint96 endAmount;
}

// T-086 Round-6 / Block D (#345) — caps for the bidder-side calldata
// surface on NFTPrepayListingAtomicFacet.matchOpenSeaOffer.

// MAX_BIDDER_FEE_LEGS — distinct from the seller-side MAX_FEE_LEGS
// (4, sized for Vaipakam's own listing construction). The bidder
// cap must accommodate OpenSea's worst case: 1 marketplace fee leg
// PLUS up to 4 creator-payout addresses (per OpenSea's fee docs),
// so the bidder's consideration can carry up to 5 ERC20 fee legs
// alongside the NFT leg = 6 consideration items total. Block D
// reuses this cap in the Atomic facet's shape invariant + the
// executor's atomic-mode dispatch. See §17.5-bis of the design doc.
uint256 constant MAX_BIDDER_FEE_LEGS = 5;

// MAX_RESOLVERS — calldata cap on the Seaport CriteriaResolver[]
// array we pass into matchAdvancedOrders. In practice this is 0 for
// item offers and 1 for collection-criteria offers; 4 is generous
// headroom. Defended against gas-griefing payloads.
uint256 constant MAX_RESOLVERS = 4;

// MAX_BIDDER_EXTRADATA_BYTES — calldata cap on the bidder's signed
// SIP-7 SignedZone extraData blob. OpenSea's SignedZone signatures
// are under 256 bytes in practice; 1024 leaves 4× headroom.
uint256 constant MAX_BIDDER_EXTRADATA_BYTES = 1024;

// MAX_CRITERIA_PROOF_DEPTH — each CriteriaResolver carries a Merkle
// proof; cap the depth to defend against deep-tree gas-griefing.
// 32 covers million-NFT collections with margin (typical real-world
// collections rarely exceed depth 16).
uint256 constant MAX_CRITERIA_PROOF_DEPTH = 32;

/// @notice The bidder's signed OpenSea Offer payload, as supplied
///         to NFTPrepayListingAtomicFacet.matchOpenSeaOffer.
///
///         Decoded from the apps/agent GET /opensea/signed-offer/
///         {chainId}/{contract}/{tokenId}/{orderHash} endpoint on
///         the dapp side; passed as calldata. The facet runs the
///         §17.5 bytes verification (Seaport.getOrderHash re-derive
///         against the dapp-pinned expected hash) and the §17.5-bis
///         shape invariant on these bytes BEFORE any state mutation.
/// @dev    T-086 Round-6 / Block D (#345). `components` and
///         `signature` are the standard Seaport bidder offer fields;
///         `extraData` carries OpenSea's SIP-7 SignedZone
///         authorisation for fee-enforced collections and MUST be
///         passed through verbatim to AdvancedOrder.extraData on
///         the bidder side (an empty extraData would revert at the
///         SignedZone validation step for fee-enforced collections).
struct BidderOrder {
    // The Seaport OrderComponents shape — offerer, zone, offer items,
    // consideration items, orderType, startTime, endTime, zoneHash,
    // salt, conduitKey, counter. The dapp decodes this from the
    // agent's signed-offer response and passes it through verbatim;
    // the facet runs Seaport.getOrderHash on it to verify against
    // the dapp-pinned expected hash (§17.5 of the design doc).
    OrderComponents components;
    // The bidder's ECDSA / ERC-1271 signature over the orderHash.
    bytes signature;
    // OpenSea SignedZone (SIP-7) extraData blob. Empty for collections
    // without fee enforcement; carries the signed-zone authorisation
    // for fee-enforced collections. Capped at MAX_BIDDER_EXTRADATA_BYTES.
    bytes extraData;
}
