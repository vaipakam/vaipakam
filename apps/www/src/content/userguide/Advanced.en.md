# Vaipakam — User Guide (Advanced Mode)

Precise, technically-accurate explanations of every card in the app.
Each section corresponds to an `(i)` info icon next to a card title.

> **You're reading the Advanced version.** It matches the app's
> **Advanced** mode (denser controls, diagnostics, protocol-config
> detail). For the friendlier, plain-English walkthrough, switch the
> app to **Basic** mode — open Settings (gear icon at the top right)
> → **Mode** → **Basic**. The (i) "Learn more" links inside the app
> will then start opening the Basic guide.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### Your Vaipakam Vault

An upgradeable per-user contract — your private vault on this chain
— created for you the first time you take part in a loan. One
vault per address per chain. Holds the ERC-20, ERC-721, and ERC-1155
balances tied to your loan positions. There is no commingling: other
users' assets are never in this contract.

The vault is the only place collateral, lent assets, and your
locked VPFI sit. The protocol authenticates against it on every
deposit and withdrawal. The implementation can be upgraded by the
protocol owner, but only through a timelock — never instantly.

<a id="dashboard.your-loans"></a>

### Your Loans

Every loan involving the connected wallet on this chain — whether
you sit on the lender side, the borrower side, or both across
distinct positions. Computed live from the protocol's view methods
against your address. Each row deep-links to the full position page
with HF, LTV, accrued interest, the action surface gated by your
role and the loan's status, and the on-chain loan id you can paste
into a block explorer.

<a id="dashboard.vpfi-panel"></a>

### VPFI on this chain

Live VPFI accounting for the connected wallet on the active chain:

- Wallet balance.
- Vault balance.
- Your share of circulating supply (after subtracting protocol-held
  balances).
- Remaining mintable cap.

Vaipakam ships VPFI cross-chain over Chainlink CCIP. **Base is the
canonical chain** — the canonical adapter there runs the
lock-on-send / release-on-receive semantics. Every other supported
chain runs a mirror that mints when an inbound bridge packet
arrives and burns on outbound. The total supply across all chains
stays invariant under bridging by construction.

The cross-chain message-verification policy hardened after the
April 2026 industry incident is **3 required + 2 optional verifiers,
threshold 1-of-2**. The single-verifier default is rejected at the
deploy gate.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

A wallet-level opt-in flag that lets the protocol settle the
discounted portion of a fee in VPFI debited from your vault at
terminal events. Default: off. Off means you pay 100% of every
fee in the principal asset; on means the time-weighted discount
applies.

Tier ladder:

| Tier | Min vault VPFI                  | Discount                          |
| ---- | -------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`         | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`         | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`         | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`         | `{liveValue:tier4DiscountBps}`%   |

Tier is computed against your **post-change** vault balance the
moment you deposit or withdraw VPFI, then time-weighted across
each loan's lifetime. An unstake re-stamps the rate at the new
lower balance immediately for every open loan you're on — there
is no grace window where your old (higher) tier still applies.
This closes the gaming pattern where a user could top up VPFI
just before a loan ends, capture the full-tier discount, and
withdraw seconds later.

The discount applies to the lender yield fee at settlement, and
to the borrower Loan Initiation Fee (paid out as a VPFI rebate
when the borrower claims).

> **Network gas is separate.** The discount above is on Vaipakam's
> **protocol fees** (yield fee `{liveValue:treasuryFeeBps}`%, Loan
> Initiation Fee `{liveValue:loanInitiationFeeBps}`%). The blockchain
> **network gas fee** every on-chain action requires — paid to
> validators on Base / Sepolia / Arbitrum / etc. when you create an
> offer, accept, repay, claim, withdraw, etc. — is not a protocol
> charge. Vaipakam never receives it; the network does. It can't be
> tiered or rebated, and it varies with chain congestion at submission
> time, not with loan size or your VPFI tier.

<a id="dashboard.rewards-summary"></a>

### Your VPFI rewards

Aspirational summary card surfacing the connected wallet's
combined VPFI rewards picture across both reward streams in
one view. The headline figure is the sum of: pending staking
rewards, lifetime-claimed staking rewards, pending
interaction rewards, and lifetime-claimed interaction
rewards.

Per-stream breakdown rows show pending + claimed and a
chevron deep-link to the full claim card on its native page:

- **Staking yield** — pending VPFI accrued at the protocol
  APR on your vault balance, plus every staking reward
  you've previously claimed from this wallet. Deep-links to
  the staking claim card on the Buy VPFI page.
- **Platform-interaction rewards** — pending VPFI accrued
  across every loan you've participated in (lender or
  borrower side), plus every interaction reward you've
  previously claimed. Deep-links to the interaction claim
  card in the Claim Center.

The lifetime-claimed numbers are reconstructed from each
wallet's on-chain claim history. There is no on-chain
running total to query, so the figure is summed by walking
the wallet's prior claim events on this chain. A fresh
browser cache shows zero (or a partial total) until the
historic walk completes; the number then jumps to truth.
Same trust model as the underlying claim cards.

The card always renders for connected wallets, even at all-
zero state. The empty-state hint is intentional — hiding
the card on zero would make the rewards programs invisible
to fresh users until they wandered into Buy VPFI or Claim
Center.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Client-side filters over the lender / borrower offer lists.
Filter by asset, side, status, and a few other axes. Filters do
not affect "Your Active Offers" — that list is always shown in
full.

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Open offers (status Active, expiry not yet reached) you created.
Cancellable any time before acceptance — the cancel call is free.
Acceptance flips the offer to Accepted and triggers loan
initiation, which mints the two position NFTs (one for lender,
one for borrower) and opens the loan in the Active state.

Closed offers carry one of several distinct statuses. Some are
already exposed as filter chips on the My Offers page; others
are indexer-side terminals that will get dedicated UI treatment
in follow-up work:

- **Filled** — accepted by a counterparty; the offer's loan
  reference is the resulting loan id.
- **Cancelled** — the offer reached the Cancelled state via
  either path: withdrawn by the creator before acceptance,
  OR cleaned up permissionlessly via `OfferCancelFacet.cancelOffer`
  once `LibVaipakam.isOfferExpired(offer)` is true (the refund
  still routes to the creator regardless of who initiated the
  cancel call).
- **Sold** — the offer was opted into the borrow-OR-sell
  parallel-sale flow (see Create Offer → Allow optional sale)
  and a marketplace buyer filled the NFT collateral listing
  before any lender accepted. The offer carries the on-chain
  status `consumed_by_sale`; the row's rate column shows the
  rate the offer was posted at and the collateral cell renders
  the NFT shape (token id for ERC-721, copy count for
  ERC-1155). The dapp also surfaces the row in the Activity
  feed as `Offer sold via OpenSea` for the borrower (offer
  creator). The on-chain event itself is
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  both the offer id AND the executor address are indexed on-chain,
  but the borrower / creator address is NOT. The borrower's
  wallet match for the Activity feed is added by the indexer at
  ingestion time (it joins the offer row to look up the creator),
  so the per-wallet filter finds the borrower without the
  event itself indexing them.
- **Fully Filled (indexer state, no chip yet)** — Range-orders
  only. When partial-fill matching consumes the offer's
  remaining budget (the last match fully fills the range, or
  a partial match leaves a sub-dust remainder),
  `OfferMatchFacet` emits `OfferClosed(FullyFilled | Dust)` and
  the indexer stamps the offer row `status = 'fullyFilled'`.
  The contract's `accepted` state and the on-chain Filled
  label above are reserved for the direct-accept terminal, so
  `fullyFilled` is distinct on the indexer side. The dapp's
  `MyOfferStatus` doesn't yet expose this terminal as its own
  filter chip — `useMyOffers` currently ignores rows with the
  `fullyFilled` indexer status — so a fully-filled range offer
  effectively drops out of the My Offers view altogether
  until the dedicated chip lands. The chip surface is queued
  as a separate UI follow-up.

Past-GTT (Good-Til-Time) offers that never reached a terminal
event aren't yet exposed as a distinct status chip in the dapp;
they currently fall under Active until the indexer records a
terminal. A dedicated Expired chip is queued as a separate UI
follow-up.

<a id="offer-book.lender-offers"></a>

### Lender Offers

Active offers from creators willing to lend. Acceptance is
performed by a borrower. There is a hard gate at initiation: the
borrower's collateral basket must produce a Health Factor of at
least 1.5 against the lender's principal request. The HF math is
the protocol's own — the gate is not bypassable. The 1% treasury
cut on interest is debited at terminal settlement, not up front.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

Active offers from borrowers who have already locked their
collateral in the vault. Acceptance is performed by a lender; this
funds the loan with the principal asset and mints the position
NFTs. Same HF ≥ 1.5 gate at initiation. The fixed APR is set on
the offer at creation and is immutable through the loan's
lifetime — refinance creates a fresh loan rather than mutating
the existing one.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

Selects which side of the offer the creator is on:

- **Lender** — the lender supplies the principal asset and a
  collateral spec the borrower must meet.
- **Borrower** — the borrower locks the collateral up front; a
  lender accepts and funds.
- **Rental** sub-type — for ERC-4907 (rentable ERC-721) and
  rentable ERC-1155 NFTs. Routes through the rental flow rather
  than a debt loan; the renter pre-pays the full rental cost
  (duration × daily fee) plus a 5% buffer.

<a id="create-offer.lending-asset"></a>

### Lending Asset

For a debt offer, you specify the asset, the principal amount,
the fixed APR, and the duration in days:

- **Asset** — the ERC-20 being lent / borrowed.
- **Amount** — principal, denominated in the asset's native
  decimals.
- **APR** — fixed annual rate in basis points (one hundredth of
  a percent), snapshotted at acceptance and not reactive
  afterwards.
- **Duration in days** — sets the grace window before a default
  can be triggered.

Accrued interest is computed continuously per second from the
loan's start time until terminal settlement.

<a id="create-offer.lending-asset:lender"></a>

#### If you're the lender

The principal asset and amount that you are willing to offer,
plus the interest rate (APR in %) and duration in days. Rate is
fixed at offer time; duration sets the grace window before the
loan can default. On acceptance, the principal moves from your
vault into the borrower's vault as part of loan initiation.

<a id="create-offer.lending-asset:borrower"></a>

#### If you're the borrower

The principal asset and amount that you want from the lender,
plus the interest rate (APR in %) and duration in days. Rate is
fixed at offer time; duration sets the grace window before the
loan can default. Your collateral is locked in your vault at
offer-creation time and remains locked until a lender accepts
and the loan opens (or you cancel).

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields. Specifies the NFT contract and token id
(and quantity for ERC-1155), plus the daily rental fee in the
principal asset. On acceptance, the protocol debits the prepaid
rental from the renter's vault into custody — that's
duration × daily fee, plus a 5% buffer. The NFT itself moves
into a delegated state (via ERC-4907 user rights, or the
equivalent ERC-1155 rental hook) so the renter has rights but
cannot transfer the NFT itself.

<a id="create-offer.collateral"></a>

### Collateral

Collateral asset spec on the offer. Two liquidity classes:

- **Liquid** — has a registered Chainlink price feed AND at
  least one Uniswap V3 / PancakeSwap V3 / SushiSwap V3 pool
  with ≥ $1M of depth at the current tick. LTV and HF math
  apply; an HF-based liquidation runs the collateral through a
  4-DEX failover (0x → 1inch → Uniswap V3 → Balancer V2).
- **Illiquid** — anything that fails the above. Valued at $0
  on-chain. No HF math. On default, the full collateral
  transfers to the lender. Both sides must explicitly
  acknowledge the illiquid-collateral risk at offer creation
  / acceptance for the offer to land.

The price oracle has a secondary quorum of three independent
sources (Tellor, API3, DIA) using a soft 2-of-N decision rule
on top of the primary Chainlink feed. Pyth was evaluated and
not adopted.

<a id="create-offer.collateral:lender"></a>

#### If you're the lender

How much you want the borrower to lock to secure the loan.
Liquid ERC-20s (Chainlink feed plus ≥ $1M v3 pool depth) get
LTV / HF math; illiquid ERC-20s and NFTs have no on-chain
valuation and require both parties to consent to a
full-collateral-on-default outcome. The HF ≥ 1.5 gate at loan
initiation is computed against the collateral basket the
borrower presents at acceptance — sizing the requirement here
directly sets the borrower's HF headroom.

<a id="create-offer.collateral:borrower"></a>

#### If you're the borrower

How much you are willing to lock to secure the loan. Liquid
ERC-20s (Chainlink feed plus ≥ $1M v3 pool depth) get LTV / HF
math; illiquid ERC-20s and NFTs have no on-chain valuation and
require both parties to consent to a full-collateral-on-default
outcome. Your collateral is locked in your vault at
offer-creation time on a borrower offer; for a lender offer,
your collateral is locked at offer-acceptance time. Either way,
the HF ≥ 1.5 gate at loan initiation must clear with the basket
you present.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Acknowledgement gate before submitting. The same risk surface
applies to both sides; the role-specific tabs below explain how
each one bites differently depending on which side of the offer
you sign. Vaipakam is non-custodial: there is no admin key that
can reverse a landed transaction. Pause levers exist on
cross-chain-facing contracts only, are gated to a timelock, and
cannot move assets.

<a id="create-offer.risk-disclosures:lender"></a>

#### If you're the lender

- **Smart-contract risk** — the contract code is immutable at
  runtime; audited but not formally verified.
- **Oracle risk** — Chainlink staleness or pool-depth divergence
  can delay an HF-based liquidation past the point where the
  collateral covers the principal. The secondary quorum
  (Tellor + API3 + DIA, soft 2-of-N) catches gross drift but
  small skew can still erode recovery.
- **Liquidation slippage** — the 4-DEX failover routes to the
  best execution it can find, but cannot guarantee a specific
  price. Recovery is net of slippage and the 1% treasury cut
  on interest.
- **Illiquid-collateral defaults** — collateral transfers to
  you in full at default time. You have no recourse if the
  asset is worth less than principal plus accrued interest.

<a id="create-offer.risk-disclosures:borrower"></a>

#### If you're the borrower

- **Smart-contract risk** — the contract code is immutable at
  runtime; bugs would affect locked collateral.
- **Oracle risk** — staleness or manipulation can trigger
  HF-based liquidation against you when the real-market price
  would have stayed safe. The HF formula reacts to oracle
  output; a single bad tick crossing 1.0 is enough.
- **Liquidation slippage** — when a liquidation fires, the swap
  can sell your collateral at slippage-eaten prices. The swap
  is permissionless — anyone can trigger it the instant your
  HF drops below 1.0.
- **Illiquid-collateral defaults** — default transfers your
  full collateral to the lender. There is no leftover claim;
  only any unused VPFI Loan Initiation Fee rebate, which you
  collect as the borrower at claim time.

<a id="create-offer.advanced-options"></a>

### Advanced Options

Less-common knobs:

- **Expiry** — offer self-cancels after this timestamp.
  Default ≈ 7 days.
- **Use fee discount for this offer** — local override of the
  wallet-level fee-discount consent for this specific offer.
- Side-specific options exposed by the offer creation flow.

Defaults are sensible for most users.

<a id="create-offer.borrow-or-sell"></a>

### Allow optional sale of this NFT on OpenSea (borrower NFT-collateral offers only)

If you're posting a **borrower offer** with **ERC-721 or
ERC-1155 collateral** and an **ERC-20 principal**, the dapp
exposes a `Borrow or sell` opt-in below the collateral
section. Ticking it marks the offer as eligible for a
parallel-sale listing of your NFT collateral on OpenSea — a
single offer that can be filled EITHER by a lender (you take
the loan) OR by a marketplace buyer (you sell the NFT). The
listing is NOT torn down at lender acceptance if it was already
posted: if a lender fills first you take the loan, the existing
OpenSea listing carries through loan initiation until its
original Seaport expiry, and a later marketplace fill before
that expiry triggers the diamond's settlement waterfall to close
the loan from the sale proceeds (see Scenario B below). For
ordinary GTT offers this expiry is the offer's original
Good-Til-Time; lender acceptance does not extend or repost the
listing for the full loan term. If a marketplace buyer fills
first, no loan is ever created (Scenario A). The two scenarios
end at different offer states: Scenario A stamps
the offer with `consumed_by_sale` via `markOfferConsumedBySale`
(it shows up under the Sold filter), and lender acceptance
is gated against any offer that has already been stamped. In
Scenario B the offer is already in the `Accepted` state by
the time the marketplace fill lands; the contract
deliberately leaves the offer status at `Accepted` and only
settles the loan from the sale — the offer doesn't transition
to Sold a second time.

**Two-step nature.** Opting in at offer create time just
sets the eligibility flag on the offer. Getting an actual
buyable listing onto OpenSea is a SEPARATE TWO-PART step
the dapp does NOT automate today:

1. **Record + wire on the diamond.** Call
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` while the offer is still active and before any
   lender acceptance. Once the offer is accepted, cancelled, or
   consumed by sale, this call reverts as terminal; ticking the
   opt-in alone is not enough to create a listing that can carry
   into Scenario B. The ask must also clear the pre-loan floor:
   principal plus worst-case offer interest through the loan
   duration and grace window, treasury cut on that interest, the
   configured safety buffer, and all fee-leg amounts. Under-floor
   asks revert at this step. The `feeLegs` argument is the ONLY
   place this call records OpenSea protocol-fee and creator-
   royalty obligations: the diamond subtracts each fee-leg
   amount from the seller proceeds and appends the recipient +
   absolute amount to the Seaport consideration array.
   Passing `feeLegs: []` on a fee-enforced collection produces
   an order shape that the OpenSea publish step will reject
   (the fee-recipient consideration items are missing) and a
   direct Seaport fill will route the full ask to the seller
   rather than splitting the fees as the collection requires.
   Advanced users must fetch the OpenSea required-fee schedule
   for the collection (the in-repo fee parser at
   `apps/defi/src/lib/openseaFeeSchedule.ts` is the reference) and pass
   absolute amounts derived against the ask before calling. The facet internally builds the
   canonical Seaport OrderComponents from those inputs, the
   OfferContext values it records for the executor (borrower
   vault address, principal asset, collateral fields, startTime,
   endTime), and the current `Seaport.getCounter` for the vault,
   derives the orderHash via
   `Seaport.getOrderHash`, returns it, registers the vault's
   ERC-1271 binding to that hash, and grants the Seaport
   conduit approval for the NFT collateral. The emitted
   `PostParallelSaleListing` event exposes the input args
   (`offerId`, borrower, orderHash, askPrice, executor /
   conduit data, salt, fee legs); it does NOT echo the
   per-context fields, so reconstructing OrderComponents
   off-chain requires the additional reads described in
   step 2 below. **Important:** at this point the order is
   already FILLABLE via Seaport. A bot watching the
   contract's events PLUS those reads can reconstruct the
   OrderComponents and call `Seaport.fulfillOrder` directly
   — the listing does not need to appear on OpenSea's
   marketplace UI for
   the on-chain fill path to work. If you don't want
   counterparties to fill at the current ask before step 2
   lands, either run step 2 immediately after step 1 OR call
   `releaseParallelSaleLock` to invalidate the binding before
   any unintended fill.
   For fee-enforced collections, populate `feeLegs` from the
   collection's required OpenSea / creator fee schedule before
   calling this step. Use only required, non-zero fee rows; cap
   the list to the protocol-supported fee-leg count; convert each
   row into an absolute fixed amount in the principal asset at the
   chosen ask price; and use the listed fee recipient as the leg
   recipient. If a required fee rounds to zero at the chosen ask,
   the ask is too small for that collection and the post should not
   be attempted. Passing an empty array is valid only for fee-free
   collections. On fee-enforced collections it can produce an order
   that fails OpenSea publication or cannot satisfy the marketplace's
   required consideration shape.
2. **Publish to OpenSea.** Reconstruct the same OrderComponents
   the facet built. The `PostParallelSaleListing` event alone
   isn't sufficient: it emits `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, and fee legs, but
   the offer-keyed order shape also needs values held in the
   executor's `OfferContext` storage (borrower vault address,
   principal asset, collateral fields, startTime, endTime) plus
   the borrower vault's Seaport counter. This is the same
   context used by the `LibPrepayOrder.buildAndHashOfferMem`
   offer-order path, and it is different from the loan-keyed
   prepay-listing order shape. Read both before posting:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     returns the persisted `OfferContext` struct for that hash.
   - `Seaport.getCounter(borrowerVault)` returns the canonical
     Seaport counter for the vault offerer.
   With those fields in hand the OrderComponents struct
   reproduces exactly the one the diamond hashed. Before POSTing,
   add the API-only `parameters.totalOriginalConsiderationItems`
   field — OpenSea's API requires it even though it's NOT part
   of the Seaport struct that produces the canonical hash; the
   in-repo publishers (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) inject it before
   calling the endpoint. For ERC-1271-validated orders OpenSea
   accepts the `signature` field as `0x` (empty bytes) — the
   vault's on-chain `isValidSignature(orderHash, '')` callback
   ignores the signature bytes and returns the EIP-1271 magic
   value for any orderHash the diamond previously registered
   (from step 1). POST the JSON to the OpenSea listings
   endpoint (`POST /api/v2/orders/{chain}/{protocol}/listings`,
   per the official [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs — this is the same endpoint Vaipakam's own publishers
   in `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` use). Only after this
   step does the listing appear on OpenSea's marketplace UI
   and become discoverable to casual buyers. Vaipakam does
   not currently automate this submission for the
   parallel-sale path — surfacing the listing publication
   end-to-end is tracked as a follow-up.

Advanced users following the manual path today need BOTH steps
to get OpenSea visibility; running step 1 alone produces an
order that's fillable directly through Seaport (by a bot or
counterparty that reconstructs the components from the event)
but invisible on the OpenSea marketplace UI.

**Fill mode is forced to All-or-Nothing.** Opting in
automatically pins the offer's fill mode to `Aon` — partial
or IOC fills would create multiple loans against one
offer's collateral, which the contract gates against. The
toggle is hidden on lender offers, ERC-20 collateral, NFT
principals, and any other shape the contract's
`_validatePostParallelSale` would reject, so you can't
accidentally tick it on an ineligible offer.

**What a buyer sees.**

- *Before any lender accepts* (Scenario A): a buyer who
  fills the OpenSea listing pays the listed price. On
  fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first; the executor passes only the
  **net proceeds** (listed price minus those marketplace /
  creator fee legs) to the diamond. The diamond escrows that
  net amount in your vault, the NFT transfers to the buyer,
  and the offer is marked `consumed_by_sale` (visible as a
  distinct "Sold" status in My Offers, Activity, and Offer
  Details). No loan was ever created; you keep the net sale
  proceeds.
- *After a lender accepts* (Scenario B): the listing
  carries through loan initiation only if it was already
  posted before acceptance, and only until the Seaport order's
  original expiry. Neither the borrower NFT lock nor the listing
  is torn down at acceptance, but lender acceptance also does not
  extend or repost the order for the full loan term. A later buyer
  fill before that expiry triggers the diamond's settlement
  waterfall in one Seaport transaction. Same fee-leg note as Scenario A:
  on fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first, and the executor passes only
  the **net proceeds** (sale price minus marketplace /
  creator fees) into the diamond's waterfall. The waterfall
  then routes that net amount: the lender receives their
  settlement entitlement (which `LibEntitlement.settlementInterest`
  computes as the full coupon when the loan was created with
  `useFullTermInterest = true`, or the pro-rata interest
  accrued to the settlement timestamp otherwise — the gate is
  the loan policy, not whether the sale happens before or
  after scheduled maturity), the treasury cut goes to
  treasury, and the remainder is deposited DIRECTLY into
  the current borrower-position NFT holder's vault (via
  `LibUserVault.getOrCreate` + a vault deposit). No Claim
  Center claim is created — check your vault balance after
  the sale lands.

**What you can't combine it with.** Two distinct conflict
classes, surfaced at different protocol stages:

- *Publish-time block (sibling loan-keyed listing).* If the
  loan already has a parallel-sale listing carrying through
  from offer-create AND the borrower then calls
  `NFTPrepayListingFacet.postPrepayListing` (or `updatePrepayListing`)
  to post a SECOND loan-keyed prepay listing on the same loan,
  the diamond reverts with `SiblingParallelSaleListingLive`.
  The conduit approval for the borrower's NFT is a single
  slot — running both listings concurrently would create an
  ambiguous approval. The borrower sees the revert at the
  publish/update call; nothing fills.
- *Fill-time block (open PrecloseFacet offset).* If the loan
  has an open PrecloseFacet offset offer AND a buyer later
  tries to fill the parallel-sale listing, the diamond's
  `_settleLoanFromParallelSale` reverts with
  `ParallelSaleBlockedByOpenOffsetOffer`. The listing remains
  valid on OpenSea but any fill attempt reverts until the
  offset link is cleared. The dapp does NOT currently surface
  a dedicated banner / notification on the Loan Details page
  for this combination; users will see fills revert and may
  need to inspect the revert reason on a block explorer to
  diagnose. The cleanup path is the ordinary offer-cancel
  surface — call `OfferCancelFacet.cancelOffer(offsetOfferId)`
  to cancel the offset offer, which releases the offset link
  and unblocks the parallel-sale fill (PrecloseFacet has no
  separate cancellation entry point; the offset is bound to
  the linked offer, so cancelling the linked offer clears it).
  A dedicated UI surface for the conflict is queued as a
  separate UX follow-up.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims are pull-style by design — terminal events leave the
funds in protocol custody and the holder of the position NFT
calls claim to move them. Both kinds of claim can sit in the
same wallet at the same time. The role-specific tabs below
describe each.

Each claim burns the holder's position NFT atomically. The NFT
*is* the bearer instrument — transferring it before claiming
hands the new holder the right to collect.

<a id="claim-center.claims:lender"></a>

#### If you're the lender

The lender claim returns:

- Your principal back into your wallet on this chain.
- Accrued interest minus the 1% treasury cut. The cut is itself
  reduced by your time-weighted VPFI fee-discount accumulator
  when consent is on.

Claimable as soon as the loan reaches a terminal state
(Settled, Defaulted, or Liquidated). The lender position NFT is
burned in the same transaction.

<a id="claim-center.claims:borrower"></a>

#### If you're the borrower

The borrower claim returns, depending on how the loan settled:

- **Full repayment / preclose / refinance** — your collateral
  basket back, plus the time-weighted VPFI rebate from the
  Loan Initiation Fee.
- **HF-liquidation or default** — only the unused VPFI Loan
  Initiation Fee rebate, which on these terminal paths is zero
  unless explicitly preserved. Collateral has already moved to
  the lender.

The borrower position NFT is burned in the same transaction.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

On-chain events involving your wallet on the active chain,
sourced live from protocol logs over a sliding block window.
There is no backend cache — every page load re-fetches. Events
are grouped by transaction hash so multi-event transactions
(for example, accept + initiate landing in the same block)
stay together. Newest first. Surfaces offers, loans,
repayments, claims, liquidations, NFT mints and burns, and
VPFI buys / stakes / unstakes.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### Buying VPFI

Two paths:

- **Canonical (Base)** — direct call to the canonical buy flow
  on the protocol. Mints VPFI directly to your wallet on Base.
- **Off-canonical** — the local-chain buy adapter sends a
  Chainlink CCIP packet to the canonical receiver on Base, which
  performs the buy on Base and bridges the result back via
  the cross-chain token standard. End-to-end latency is ≈ 1
  minute on L2-to-L2 pairs. The VPFI lands in your wallet on
  the **origin** chain.

Adapter rate limits (post-hardening): 50,000 VPFI per request
and 500,000 VPFI rolling over 24 hours. Tunable by governance
through a timelock.

<a id="buy-vpfi.discount-status"></a>

### Your VPFI Discount Status

Live status:

- Current tier (0 to 4).
- Vault VPFI balance plus the gap to the next tier.
- Discount percentage at the current tier.
- Wallet-level consent flag.

Note that vault VPFI also accrues 5% APR via the staking
pool — there is no separate "stake" action. Depositing VPFI
into your vault IS staking.

<a id="buy-vpfi.buy"></a>

### Step 1 — Buy VPFI with ETH

Submits the buy. On the canonical chain, the protocol mints
directly. On mirror chains, the buy adapter takes payment,
sends a cross-chain message, and the receiver executes the buy
on Base and bridges VPFI back. The bridge fee plus
verifier-network cost is quoted live and shown in the form.
VPFI does not auto-deposit into your vault — Step 2 is an
explicit user action by design.

<a id="buy-vpfi.deposit"></a>

### Step 2 — Deposit VPFI into your vault

A separate explicit deposit step from your wallet to your
vault on the same chain. Required on every chain — even the
canonical one — because vault deposit is always an explicit
user action per spec. On chains where Permit2 is configured,
the app prefers the single-signature path over the classic
approve + deposit pattern; it falls back gracefully if Permit2
isn't configured on that chain.

<a id="buy-vpfi.unstake"></a>

### Step 3 — Unstake VPFI from your vault

Withdraw VPFI from your vault back to your wallet. There is
no separate approval leg — the protocol owns the vault and
debits itself. The withdraw triggers an immediate fee-discount
rate re-stamp at the new (lower) balance, applied to every
open loan you're on. There is no grace window where the old
tier still applies.

---

## Rewards

<a id="rewards.overview"></a>

### About Rewards

Two streams:

- **Staking pool** — vault-held VPFI accrues at 5% APR
  continuously, with per-second compounding.
- **Interaction pool** — per-day pro-rata share of a fixed
  daily emission, weighted by your settled-interest
  contribution to that day's loan volume. Daily windows
  finalise lazily on the first claim or settlement after
  window close.

Both streams are minted directly on the active chain — there
is no cross-chain round-trip for the user. Cross-chain reward
aggregation happens between protocol contracts only.

<a id="rewards.claim"></a>

### Claim Rewards

A single transaction claims both streams at once. Staking
rewards are always available; interaction rewards are zero
until the relevant daily window finalises (lazy finalisation
triggered by the next non-zero claim or settlement on that
chain). The UI guards the button while the window is still
finalising so users don't under-claim.

<a id="rewards.withdraw-staked"></a>

### Withdraw Staked VPFI

Identical surface to "Step 3 — Unstake" on the Buy VPFI page —
withdraw VPFI from vault back to your wallet. Withdrawn VPFI
exits the staking pool immediately (rewards stop accruing for
that amount that block) and exits the discount accumulator
immediately (post-balance re-stamp on every open loan).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (this page)

Single-loan view derived live from the protocol, plus live HF
and LTV from the risk engine. Renders terms, collateral risk,
parties, the action surface gated by your role and the loan's
status, and inline keeper status.

<a id="loan-details.terms"></a>

### Loan Terms

Immutable parts of the loan:

- Principal (asset and amount).
- APR (fixed at offer creation).
- Duration in days.
- Start time and end time (start time + duration).
- Accrued interest, computed live from elapsed seconds since
  start.

Refinance creates a fresh loan rather than mutating these
values.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math.

- **Health Factor** = (collateral USD value × liquidation
  threshold) / debt USD value. HF below 1.0 makes the
  position liquidatable.
- **LTV** = debt USD value / collateral USD value.
- **Liquidation threshold** = the LTV at which the position
  becomes liquidatable; depends on the volatility class of
  the collateral basket. The high-volatility collapse
  trigger is 110% LTV.

Illiquid collateral has zero on-chain USD value; HF and LTV
collapse to "n/a" and the only terminal path is full
collateral transfer on default — both parties consented at
offer creation via the illiquid-risk acknowledgement.

<a id="loan-details.collateral-risk:lender"></a>

#### If you're the lender

The collateral basket securing this loan is your protection.
HF above 1.0 means the position is over-collateralised
relative to the liquidation threshold. As HF drifts toward 1.0,
your protection thins. Once HF goes below 1.0, anyone (you
included) can call liquidate, and the protocol routes the
collateral via the 4-DEX failover for your principal asset.
Recovery is net of slippage.

For illiquid collateral, on default the basket transfers to
you in full at default time — what it's actually worth on the
open market is your problem.

<a id="loan-details.collateral-risk:borrower"></a>

#### If you're the borrower

Your locked collateral. Keep HF safely above 1.0 — a common
buffer target is 1.5 to ride out volatility. Levers to bring
HF up:

- **Add collateral** — top up the basket. User-only action.
- **Partial repay** — reduces debt, raises HF.

Once HF goes below 1.0, anyone can trigger an HF-based
liquidation; the swap sells your collateral at slippage-eaten
prices to repay the lender. On illiquid collateral, default
transfers your full collateral to the lender — only any unused
VPFI Loan Initiation Fee rebate is left for you to claim.

<a id="loan-details.parties"></a>

### Parties

Lender, borrower, lender's vault, borrower's vault, and the two
position NFTs (one for each side). Each NFT is an ERC-721
with on-chain metadata; transferring it transfers the right to
claim. The vault contracts are deterministic per address —
same address across deploys.

<a id="loan-details.actions"></a>

### Actions

Action surface, gated per role by the protocol. The
role-specific tabs below list each side's available actions.
Disabled actions surface a hover-reason derived from the gate
("Insufficient HF", "Not yet expired", "Loan locked", etc.).

Permissionless actions available to anyone regardless of role:

- **Trigger liquidation** — when HF drops below 1.0.
- **Mark defaulted** — when the grace period has expired
  without full repayment.

<a id="loan-details.actions:lender"></a>

#### If you're the lender

- **Claim as lender** — terminal-only. Returns principal plus
  interest minus the 1% treasury cut (further reduced by
  your time-weighted VPFI yield-fee discount when consent is
  on). Burns the lender position NFT.
- **Initiate early withdrawal** — list the lender position NFT
  for sale at an asking price. A buyer who completes the sale
  takes over your side; you receive the proceeds. Cancellable
  before the sale fills.
- Optionally delegatable to a keeper holding the relevant
  action permission — see Keeper Settings.

<a id="loan-details.actions:borrower"></a>

#### If you're the borrower

- **Repay** — full or partial. Partial reduces outstanding
  and raises HF; full triggers terminal settlement, including
  the time-weighted VPFI Loan Initiation Fee rebate.
- **Swap collateral to repay** — for ERC-20-on-ERC-20 loans
  only, where you've pledged one ERC-20 as collateral against
  a different ERC-20 principal. Instead of having to withdraw
  collateral, swap externally on a DEX, redeposit the principal
  asset, and then call repay (the classic four-step dance),
  one call swaps your collateral into the loan's principal
  asset and applies the proceeds to settlement atomically. Two
  modes:
    - *Full close* — sized to cover principal + interest +
      late fee + treasury cut; loan transitions to Repaid; any
      favorable-quote surplus principal lands in your wallet
      directly (not your vault, so you can spend it immediately
      without an extra withdraw step). Respects the
      `useFullTermInterest` flag from offer creation, identical
      to the regular repay surface.
    - *Partial reduction* — gated on the offer having been
      created with `allowsPartialRepay = true`. Reduces the
      principal by the swap proceeds (after the
      `lender share + treasury cut` haircut), resets the
      accrual clock, post-swap health-factor check ensures
      the loan still stands. Rejects swaps large enough to
      retire the full principal — use Full close for that
      so the position-NFT lifecycle + reward close fire.
  Slippage capped at 3% by default (tighter than the
  6% HF-liquidation cap because you're picking the moment;
  the protocol gives you the borrower-friendly buffer). The
  4-DEX try-list (0x v2 / 1inch v6 / Uniswap V3 / Balancer V2)
  is the same proven adapter set the HF-liquidation path
  uses; total swap failure reverts the whole transaction so
  you can retry with better routing. The lender or whoever
  currently holds the lender-position NFT cannot use this
  surface on their own loan (self-repay guard).
- **Preclose direct** — pay the outstanding amount from your
  wallet now, release collateral, settle the rebate.
- **Preclose offset** — sell some collateral via the protocol's
  swap router, repay from proceeds, and return the remainder.
  Two-step: initiate, then complete.
- **Refinance** — post a borrower offer for new terms; once a
  lender accepts, complete refinance swaps the loans
  atomically with the collateral never leaving your vault.
- **List collateral on OpenSea (prepay sale)** — if the loan has
  an NFT as collateral and the lender opted in at offer time, you
  can post your collateral on OpenSea via Vaipakam at any price
  above the live floor. The floor is the lender's **settlement
  entitlement** (the FULL coupon for full-term-interest loans
  where the lender locked in the whole interest leg at offer
  time, pro-rata accrued interest otherwise) plus the treasury
  cut plus a safety buffer. When a buyer fills, the sale
  waterfall pays the lender at their entitlement, the treasury
  fee, and the remainder lands in your vault — atomically, in
  one Seaport transaction, no extra step from you. Cancellable
  any time before the grace window closes. The listing surfaces
  on OpenSea's marketplace UI automatically; you don't sign
  anything off-chain.
- **Claim as borrower** — terminal-only. Returns collateral on
  full repayment, or the unused VPFI Loan Initiation Fee
  rebate on default / liquidation. Burns the borrower position
  NFT.

> **If your repay tx reverts while you have a live OpenSea
> listing** — a buyer's `Seaport.fulfillOrder` may have landed
> in the same block, EVM-ordered before your repay. Both txes
> are competing terminal flows; only one can win. If the buyer's
> tx wins, your loan is **already settled**: the lender + treasury
> got paid from the sale proceeds, and your remainder (sale price
> minus those two legs) is sitting in your vault ready to claim.
> Your repay's revert just means there was nothing left to repay
> — no funds left your wallet. The Vaipakam dapp detects this
> case and surfaces a tailored message linking straight to the
> Claim Center; if you ever see a generic revert and you had a
> live listing at the time, check your loan status on the
> Dashboard first. This is the only case where a borrower-
> initiated repay can fail "harmlessly" without something
> actually going wrong.

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Matching OpenSea offers on a prepay listing

Once your prepay listing is live on OpenSea's marketplace,
casual buyers will sometimes place **item offers** directly
on your token — bids tied to your specific collateral, not
to any token in the collection. Vaipakam surfaces these item
offers on the Loan Details page in real time — a separate
panel under "List collateral on OpenSea" with one row per
incoming offer. The panel applies a **buffer threshold** —
the lender's settlement entitlement (which ALREADY INCLUDES
principal plus the full coupon for full-term-interest loans
or the pro-rata interest otherwise — see
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus the
treasury cut, plus a safety buffer — and **greys out** offers
that don't clear it. You can see market interest at every
level but can only Match offers that the protocol will
actually settle.

Collection-wide / criteria offers (bids that any token in
the collection can fulfill) stay on OpenSea but **don't
appear** in the dapp's Match panel — the multi-leg
consideration the protocol settles into can't be
reconstructed against a criteria offer without contract-side
plumbing that isn't in v1. If your only inbound demand is
collection-wide, the practical path today is to wait for
an item-specific bid OR to leave the listing at your fixed
ask and let any buyer fulfill it directly. You cannot
manually settle a collection-wide bid yourself — the
collateral NFT lives in your Vaipakam vault, and Vaipakam-
side Seaport orders are the only authorised settlement
shape.

On collections that enforce OpenSea protocol fees and/or
creator royalties, the dapp DOES render the offers panel —
the fee-schedule fetch from the OpenSea API is treated as
advisory; the actual fulfillment data is fetched at
Match-click time. If that fulfillment-data fetch fails (rate
limit, API outage, or unsupported collection shape), the
dapp-side Match click handler ABORTS before any
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` transaction
is constructed — no calldata, no signature prompt, no
revert. The on-chain function itself isn't a `bool`-returning
selector; when it does run it returns a `bytes32` order hash
or reverts. So a fee-enforced collection's panel may show
offers you can browse but not all of them are clickable-
to-match in a given moment.

When you find an acceptable offer and click **Match offer**,
the dapp opens the **Confirm Match** modal, which restates the
matched value (the gross OpenSea offer amount the panel showed
— NOT the net amount the diamond will settle at; on
fee-enforced collections `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
computes `effectiveAsk = offerValue - bidderFeeTotal` before
running the lender / treasury / borrower split, so the net the
diamond actually distributes is smaller than the modal's
headline) and gives a generic explanation of the atomic-match
flow. After you
confirm, the dapp sends a single `matchOpenSeaOffer`
transaction that bundles the bidder's offer with a freshly-
constructed diamond-side counter-order into one Seaport
`matchAdvancedOrders` call — the bidder's fulfilment, the
counter-order's listing-side leg (whether or not you had a
prior v1 prepay listing live; the atomic path supports
`existingHash == 0`), and the diamond's settlement waterfall
all land atomically in one block. The transaction either fully succeeds (loan
settled, NFT transferred, sale proceeds split) or fully
reverts (nothing moves), and there is **no window between
listing rotation and settlement** in which a third-party
buyer could step in at the matched price.

> **No race window — atomic by construction.** This is the
> structural close-out of the v1 two-step "cancel + post"
> pattern: under v1 the dapp would rotate the listing as a
> separate `updatePrepayListing` transaction, leaving the
> rotated price live on OpenSea until the bidder's
> `fulfillOrder` landed in a later block — anyone watching
> the mempool could snipe the bidder out of the price they
> bid. The atomic path closes that hole by binding both
> orders into one Seaport match call: either the bidder fills
> at the agreed price or the whole transaction reverts.

**What you still want to verify before clicking Match:**

- **Confirm the matched value in the modal.** The modal
  surfaces the gross OpenSea offer amount. On fee-enforced
  collections, the diamond settles against the net effective
  ask after bidder-side marketplace / creator fee legs, so the
  modal value can be higher than the amount used for the
  lender / treasury / borrower split. The bidder address and
  the precise split aren't broken out in either the modal OR
  the OpenSea Offers panel row (the row shows value, payment
  token, offer kind, truncated bidder, and end time). The split
  is enforced on-chain by the diamond at settlement — the
  protocol's settlement buffer guarantees the effective ask covers
  the lender's settlement entitlement (which already includes
  principal plus the full coupon on full-term-interest loans
  or the pro-rata interest otherwise) plus the
  treasury cut, so the split is always at least neutral for
  you. If you want to see the projected split before
  confirming, the diamond exposes
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  as a callable view — it returns the lender and treasury legs
  the settlement waterfall will route at the given timestamp,
  and the remainder is yours.
- **Check OpenSea's fee posture for the collection.** If the
  collection enforces OpenSea protocol fees or creator
  royalties, the atomic path needs SignedZone `extraData` /
  criteria-resolver plumbing that the dapp fetches via the
  agent's OpenSea fulfillment-data proxy (PR #349) AT MATCH
  CLICK TIME. The Match panel renders regardless of
  fee-schedule fetch status; the click-time fulfillment-data
  fetch is the gate. If that fetch fails (rate limit, API
  outage, unsupported collection shape), the dapp-side click
  handler aborts before constructing the on-chain
  `matchOpenSeaOffer` transaction — no calldata is built,
  no signature prompt fires, no banner is shown in advance.
  You can retry the click later (the fetch may have just
  been a transient API blip), or fill the listing directly
  on OpenSea at the listed ask in the meantime.

---

## How Liquidation Actually Works

The Risk Disclosures you agreed to at offer time capture the
worst-case outcome in two sentences. This section explains the
underlying mechanics — useful if you want to understand WHY the
in-kind fallback exists, or which of the four branches your
loan would actually take.

The contract function that decides the split is
`LibFallback.computeFallbackEntitlements`. It walks four cases
in order; the FIRST one that matches is the one that fires.

<a id="liquidation-mechanics.case-1"></a>

### Case 1 — Oracle available, collateral worth ≥ amount due

The healthy path. Chainlink price feeds are responsive, the
Soft 2-of-N secondary quorum (Tellor + API3 + DIA) hasn't
disagreed, and the seized collateral covers the amount owed
when priced against the oracle.

What happens:

- The lender receives **collateral asset** worth (principal +
  accrued interest + a 3% fallback bonus), priced at the oracle.
  In effect: the lender is made whole at fair value, paid in the
  collateral asset rather than the lending asset.
- The treasury receives a 2% premium of principal, also priced
  in collateral.
- The borrower receives the **remainder** of the collateral
  back. This is a real refund — it's the over-collateralisation
  that wasn't needed to cover the lender's claim.

Worked example: a loan of 1000 USDC against 0.6 WETH ($3000
collateral, $1000 debt). Oracle prices ETH at $5000 / WETH; debt
+ interest + bonus = $1050. Lender receives 0.21 WETH ($1050
worth), treasury receives 0.004 WETH ($20 worth of the 2%
premium), borrower receives the remaining ~0.386 WETH.

<a id="liquidation-mechanics.case-2"></a>

### Case 2 — Oracle available, collateral worth < amount due

The underwater path. The oracle works, but the seized collateral
is worth less than the amount due even at oracle price. Common
in volatile-asset crashes where collateral value drops faster
than HF can react.

What happens:

- The lender receives **ALL** of the seized collateral, in the
  collateral asset.
- The treasury receives nothing.
- The borrower receives nothing — there is no remainder to refund.

The lender absorbs the shortfall. No further claim exists
against the borrower, the protocol, or any third party. This is
the case the Risk Disclosures' "recovery may be less than the
asset lent" line specifically warns about.

Worked example: same 1000 USDC / 0.6 WETH loan, but ETH crashes
to $1500 / WETH. Collateral now $900; debt is $1050. Lender
receives all 0.6 WETH ($900 worth), treasury 0, borrower 0.

<a id="liquidation-mechanics.case-3"></a>

### Case 3 — Oracle quorum UNAVAILABLE

The dark-quorum path. Chainlink staleness is past the volatile
ceiling AND the 2-of-N secondary quorum can't agree (every
secondary either is offline or disagrees with primary). The
protocol has no trustworthy price for either side of the loan,
so it can't compute a fair split.

What happens:

- The lender receives **ALL** of the seized collateral, in the
  collateral asset, **regardless of computed value** (because no
  computation is trustworthy).
- The treasury receives nothing.
- The borrower receives nothing.

Same payout as Case 2, but reached for a fundamentally different
reason: the protocol isn't deciding "collateral is worth less
than debt" — it's deciding "I cannot trust any number here, so
the lender gets the entire seized basket and absorbs whatever
that turns out to be worth on the open market."

A different on-chain event (`LiquidationFallbackOracleUnavailable`)
is emitted so that auditors can distinguish the two paths in
post-mortem analysis.

<a id="liquidation-mechanics.case-4"></a>

### Case 4 — Illiquid asset on either side

The illiquid-asset path. The lending asset, the collateral asset,
or both don't qualify as Liquid in the protocol's classifier
(no Chainlink feed, or no Uniswap-V3-style concentrated-liquidity
pool above the volume threshold). Common for NFT collateral
and long-tail tokens.

What happens at default time:

- The lender receives the **full collateral** in-kind, regardless
  of market value.
- No partition between "amount owed" and "remainder" —
  oracle pricing can't be applied.
- The asset may be worth materially more or less than the amount
  owed. No warranty on resaleability.

Both sides consented to this when the offer was created — the
Risk Disclosures' illiquid-asset clause covers exactly this case.
You can't reach this branch unless both parties knowingly chose
to do a loan involving an illiquid asset.

<a id="liquidation-mechanics.why-in-kind"></a>

### Why in-kind, why not always cash?

Three reasons the protocol pays out in collateral asset units
rather than always swapping to the lending asset:

- **Sequencer / DEX outage**: when the protocol can't safely
  execute a swap (slippage > 6%, thin liquidity, DEX revert,
  sequencer down), the safest action is to deliver what it
  already has — the seized collateral — directly. Forcing a
  swap at any cost would lock losses in.
- **Black-swan envelope**: in volatile cascades, an oracle-
  available path can disappear within minutes. Pre-staging the
  in-kind fallback keeps the protocol functional even when
  every price source is degraded.
- **Counterparty-pair recovery**: at claim time the lender (or
  their keeper bot) gets a second-chance retry over the
  full 4-DEX failover. If conditions have normalised by then,
  they can sell the in-kind collateral for the lending asset
  through the same routing infrastructure the at-liquidation
  path tried.

<a id="liquidation-mechanics.claim-time-retry"></a>

### Claim-time retry

`ClaimFacet.claimAsLenderWithRetry` lets the lender (or a
keeper acting on the lender's NFT) supply a ranked retry try-
list of swap adapter calls (0x → 1inch → Uniswap V3 → Balancer
V2) when the loan is in `FallbackPending`. The library iterates
the list, commits on first success, and rewrites the lender +
borrower claims to principal-asset proceeds.

Total failure leaves the recorded collateral split intact and
transitions the loan terminally to Defaulted — at which point the
lender takes the in-kind collateral and is free to sell it through
any external venue.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### Pre-claim internal-match rescue

Before any external swap runs — at HF-liquidation, at time-based
default, AND at claim time — the protocol first checks whether an
**opposing-direction loan** exists that can settle this one with no
DEX involvement at all.

If loan A needs to sell WETH for USDC and loan B needs to sell USDC
for WETH, the two can be matched directly: A's collateral covers B's
debt and vice-versa, priced at the protocol's oracle. No aggregator,
no slippage, no swap fee. The borrower keeps far more of their
collateral; the lender is made whole at oracle price.

This internal-match path runs automatically:

- **At HF-liquidation** — when a keeper calls liquidate and an
  opposing counterparty exists, the protocol settles internally
  instead of swapping. The keeper still earns a matcher incentive.
- **At time-based default** — same check before the default swap.
- **At claim time** — when a lender claims a loan stuck in
  `FallbackPending`, the protocol re-checks for an opposing
  counterparty. This is a genuine second chance: the pool of
  matchable loans grows continuously, so a counterparty that
  didn't exist when liquidation first failed may exist by the time
  you claim.

A loan that landed in `FallbackPending` because its at-liquidation
swap failed *transiently* (a momentary slippage spike, a DEX revert,
a stale oracle tick) is a prime rescue candidate — the underlying
collateral is usually still perfectly liquid, and an opposing loan
can clear it cleanly. The protocol only requires that the oracle can
still price the asset; it does not require the DEX to have depth,
because an internal match never touches a DEX.

If no opposing counterparty exists, the protocol falls through to the
external-aggregator path described above. Internal-match is a
strictly-better-when-available optimization, never a blocker.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Lists every ERC-20 allowance your wallet has granted the
protocol on this chain. Sourced by scanning a candidate-token
list against on-chain allowance views. Revoking sets the
allowance to zero.

Per the exact-amount approval policy, the protocol never asks
for unlimited allowances, so the typical revocation list is
short.

Note: Permit2-style flows bypass the per-asset allowance on
the protocol by using a single signature instead, so a clean
list here does not preclude future deposits.

---

## Alerts

<a id="alerts.overview"></a>

### About Alerts

An off-chain watcher polls every active loan involving your
wallet on a 5-minute cadence, reads the live Health Factor for
each, and on a band crossing in the unsafe direction fires
once via the configured channels. There is no on-chain state
and no gas. Alerts are advisory — they don't move funds.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

A user-configured ladder of HF bands. Crossing into a more-
dangerous band fires once and arms the next deeper threshold;
crossing back above a band re-arms it. Defaults: 1.5 → 1.3 →
1.1. Higher numbers are appropriate for volatile collateral.
The ladder's only job is to get you out before HF drops below
1.0 and triggers liquidation.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

Two rails:

- **Telegram** — bot direct message with the wallet's short
  address, the loan id, and the current HF.
- **Push Protocol** — wallet-direct notification via the
  Vaipakam Push channel.

Both share the threshold ladder; per-channel warning levels are
intentionally not exposed to avoid drift. Push channel
publishing is currently stubbed pending channel creation.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### Verify an NFT

Given an NFT contract address and a token id, the verifier
fetches:

- The current owner (or a burn signal if the token is already
  burned).
- The on-chain JSON metadata.
- A protocol cross-check: derives the underlying loan id from
  the metadata and reads loan details from the protocol to
  confirm state.

Surfaces: minted by Vaipakam? which chain? loan status?
current holder? Lets you spot a counterfeit, an already-claimed
(burned) position, or a position whose loan has settled and is
mid-claim.

The position NFT is the bearer instrument — verify before
buying on a secondary market.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### About Keepers

A per-wallet keeper whitelist of up to 5 keepers. Each keeper
has an action permission set authorising specific maintenance
calls on **your side** of a loan. Money-out paths (repay,
claim, add collateral, liquidate) are user-only by design and
cannot be delegated.

Two additional gates apply at action time:

1. The master keeper-access switch — a one-flip emergency
   brake that disables every keeper without touching the
   allowlist.
2. A per-loan opt-in toggle, set on the Offer Book or Loan
   Details surface.

A keeper can act only when all four conditions are true:
approved, master switch on, per-loan toggle on, and the
specific action permission set on that keeper.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

Action permissions currently exposed:

- **Complete loan sale** (lender side, secondary-market exit).
- **Complete offset** (borrower side, second leg of preclose
  via collateral sale).
- **Initiate early withdrawal** (lender side, list position
  for sale).
- **Initiate preclose** (borrower side, kick off the
  preclose flow).
- **Refinance** (borrower side, atomic loan swap on a new
  borrower offer).

Permissions added on-chain that the frontend doesn't yet
reflect get a clear "invalid permission" revert. Revocation is
instantaneous on all loans — there is no waiting period.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### About Public Analytics

A wallet-free aggregator computed live from on-chain protocol
view calls across every supported chain. No backend, no
database. CSV / JSON export is available; the protocol address
plus the view function backing every metric is shown for
verifiability.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

Cross-chain rollup. The header reports how many chains were
covered and how many errored, so an unreachable RPC at fetch
time is explicit. When one or more chains errored, the
per-chain table flags which one — TVL totals are still
reported, but acknowledge the gap.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Per-chain split of the combined metrics. Useful for spotting
TVL concentration, mismatched VPFI mirror supplies (the sum of
mirror supplies should equal the canonical adapter's locked
balance), or stalled chains.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

On-chain VPFI accounting on the active chain:

- Total supply, read directly from the ERC-20.
- Circulating supply — total supply minus protocol-held
  balances (treasury, reward pools, in-flight bridge packets).
- Remaining mintable cap — only meaningful on the canonical
  chain; mirror chains report "n/a" for the cap because mints
  there are bridge-driven, not minted from the cap.

Cross-chain invariant: the sum of mirror supplies across all
mirror chains equals the canonical adapter's locked balance.
A watcher monitors this and alerts on drift.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

For every metric the page lists:

- The block number used as the snapshot.
- Data freshness (max staleness across chains).
- The protocol address and view function call.

Anyone can re-derive any number on this page from
RPC + block + protocol address + function name — that's the
bar.

---

## Refinance

This page is borrower-only — refinance is initiated by the
borrower on the borrower's loan.

<a id="refinance.overview"></a>

### About Refinancing

Refinance atomically pays off your existing loan from new
principal and opens a fresh loan with the new terms, all in
one transaction. Collateral stays in your vault throughout —
there is no unsecured window. The new loan must clear the
HF ≥ 1.5 gate at initiation, just like any other loan.

The old loan's unused Loan Initiation Fee rebate is settled
correctly as part of the swap.

<a id="refinance.position-summary"></a>

### Your Current Position

Snapshot of the loan being refinanced — current principal,
accrued interest so far, HF / LTV, and the collateral basket.
The new offer should size at least the outstanding amount
(principal + accrued interest); any excess on the new offer
is delivered to your vault as free principal.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — Post the New Offer

Posts a borrower offer with your target terms. The old loan
continues accruing interest while you wait; collateral remains
locked. The offer appears in the public Offer Book and any
lender can accept it. You can cancel before acceptance.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

Atomic settlement after the new lender has accepted:

1. Funds the new loan from the accepting lender.
2. Repays the old loan in full (principal + interest, less the
   treasury cut).
3. Burns the old position NFTs.
4. Mints new position NFTs.
5. Settles the old loan's unused Loan Initiation Fee rebate.

Reverts if HF on the new terms would be below 1.5.

---

## Preclose

This page is borrower-only — preclose is initiated by the
borrower on the borrower's loan.

<a id="preclose.overview"></a>

### About Preclose

A borrower-driven early termination. Two paths:

- **Direct** — pay the outstanding amount (principal + accrued
  interest) from your wallet, release collateral, settle the
  unused Loan Initiation Fee rebate.
- **Offset** — initiate the offset to sell part of the
  collateral via the protocol's 4-DEX swap failover for the
  principal asset, complete the offset to repay from
  proceeds, and the remainder of collateral returns to you.
  Same rebate settlement.

There is no flat early-close penalty. The time-weighted VPFI
math handles the fairness.

<a id="preclose.position-summary"></a>

### Your Current Position

Snapshot of the loan being preclosed — outstanding principal,
accrued interest, current HF / LTV. The preclose flow does
**not** require HF ≥ 1.5 on exit (it's a closure, not a
re-init).

<a id="preclose.in-progress"></a>

### Offset In Progress

State: the offset has been initiated, the swap is mid-execution
(or the quote was consumed but the final settle is pending).
Two exits:

- **Complete offset** — settles the loan from realised
  proceeds, returns the remainder.
- **Cancel offset** — aborts; collateral stays locked, loan
  unchanged. Use this when the swap moved against you between
  initiate and complete.

<a id="preclose.choose-path"></a>

### Choose a Path

The direct path consumes wallet liquidity in the principal
asset. The offset path consumes collateral via DEX swap;
preferred when you don't have the principal asset on hand or
you want to exit the collateral position too. Offset slippage
is bounded by the same 4-DEX failover used for liquidations
(0x → 1inch → Uniswap V3 → Balancer V2).

---

## Early Withdrawal (Lender)

This page is lender-only — early withdrawal is initiated by
the lender on the lender's loan.

<a id="early-withdrawal.overview"></a>

### About Lender Early Exit

A secondary-market mechanism for lender positions. You list
your position NFT for sale at a chosen price; on acceptance,
the buyer pays, ownership of the lender NFT transfers to the
buyer, and the buyer becomes the lender of record for all
future settlement (claim at terminal, etc.). You walk away
with the sale proceeds.

Liquidations remain user-only and are NOT delegated through
the sale — only the right to claim transfers.

<a id="early-withdrawal.position-summary"></a>

### Your Current Position

Snapshot — outstanding principal, accrued interest, time
remaining, current HF / LTV of the borrower side. These set
the fair price the buyer market expects: the buyer's payoff
is principal plus interest at terminal, less liquidation risk
over the remaining time.

<a id="early-withdrawal.initiate-sale"></a>

### Initiate the Sale

Lists the position NFT for sale via the protocol at your
asking price. A buyer completes the sale; you can cancel
before the sale fills. Optionally delegatable to a keeper
holding the "complete loan sale" permission; the initiate
step itself stays user-only.

---

## Stuck-Token Recovery

This section covers an EDGE CASE most users will never need.
Read all of it before clicking the recovery link at the
bottom — declaring an incorrect source can lock your vault
under the protocol's sanctions policy.

<a id="stuck-recovery.what"></a>

### What "stuck token" means

Your Vaipakam Vault proxy is internal protocol storage. It
is NOT a deposit address. Every protocol-supported deposit
flows through Vaipakam's facet entry points, which pull
funds from your wallet to your vault as part of an offer
creation, loan acceptance, or stake operation. Tokens that
arrive at the vault OUTSIDE that flow — a direct
`IERC20.transfer` from a wallet or a CEX withdrawal that
copy-pasted your vault address — sit there without
protocol bookkeeping. The Asset Viewer hides them by
showing only the protocol-tracked balance.

Two ways tokens get stuck:

1. **You sent them yourself.** You copied your vault address
   (from the Dashboard or a block explorer) into a CEX
   withdrawal field or a wallet's send-tokens form, and
   submitted. The tokens landed in your vault without going
   through the protocol's deposit path.

2. **A third party sent them ("dust attack").** Someone
   transferred a small amount to your vault from a flagged
   wallet, hoping to associate your address with their
   reputation. This is a real attack vector against
   high-profile addresses on permissionless chains.

<a id="stuck-recovery.taint-poisoning"></a>

### About "taint poisoning"

If the third-party sender is on a sanctions list, generic
on-chain analytics tools may flag your vault as
"sanctions-adjacent" even though you never touched the
incoming tokens. There is no on-chain way to undo this — the
transfer event is permanent. Vaipakam's INTERNAL
bookkeeping is unaffected (we track only protocol-mediated
deposits, dust never enters our counter), so your loans /
stake / claims continue to work normally. But external tools
that don't understand our accounting may surface warnings.

<a id="stuck-recovery.dont-recover"></a>

### When NOT to recover

If you did NOT send the tokens yourself, **do not recover
them**. Recovering requires you to declare the sender's
address. If that address is on the sanctions list, your
vault gets locked under the protocol's sanctions policy
until the source is de-listed from the oracle.

Tokens you didn't send are not yours. Recovering them by
declaring a "clean" address you don't actually own is also
a bad idea — the protocol can't verify the declaration
on-chain, but external oracle tooling may disagree later.

The safe move is to ignore unsolicited dust. It does not
affect your protocol balance or any active loan / offer.

<a id="stuck-recovery.when-recover"></a>

### When TO recover

You sent the tokens yourself by mistake, you control the
source wallet, and you know the source is not on any
sanctions list (your own EOA, a CEX hot wallet you withdrew
from, etc.).

<a id="stuck-recovery.flow"></a>

### Recovery flow

1. Visit the [recovery page](/app/recover).
2. Enter the token contract address, the source you sent
   from, and the amount.
3. Review the on-screen acknowledgment carefully.
4. Type "CONFIRM" to enable signing.
5. Sign the EIP-712 acknowledgment in your wallet.
6. Submit the transaction.

Two outcomes:

- **Source clean** → tokens return to your EOA.
- **Source flagged** → tokens stay in the vault, your vault
  gets locked under the protocol's sanctions policy. The
  lock auto-lifts if the address is later removed from the
  sanctions oracle.

<a id="stuck-recovery.disown"></a>

### Disowning unsolicited tokens (compliance audit trail)

If you want a public on-chain record asserting that some
token balance in your vault is NOT yours, the protocol
provides a `disown(token)` function. It emits an event
(`TokenDisowned`) and changes nothing else — tokens stay in
vault as before. Useful in compliance disputes if a CEX or
regulator asks "did you receive these funds?": you can point
to the on-chain event.

The disown function is exposed only via direct contract call
for now; the Vaipakam frontend does not surface it as a
button. Use a block-explorer "Write Contract" UI or a
contract-interaction tool to call it.
