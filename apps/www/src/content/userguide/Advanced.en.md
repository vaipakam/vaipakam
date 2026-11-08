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

<a id="chapter.dashboard"></a>

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

A wallet-level opt-in flag that turns your VPFI holding into a
fee discount. Default: off — off means you pay 100% of every fee
in the principal asset.

The two legs work differently, and it is worth knowing which one
you are reading about. **As a borrower**, the discount is a direct
reduction of the Loan Initiation Fee, charged in the lending asset
at acceptance; nothing is debited from your vault for it. **As a
lender**, the yield-fee discount applies at settlement, and where
the protocol has a VPFI price reference configured it can instead
be settled in VPFI from your vault, leaving you the whole fee in
the lending asset.

Tier ladder:

| Tier | Min vault VPFI                  | Discount                          |
| ---- | -------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`         | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`         | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`         | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`         | `{liveValue:tier4DiscountBps}`%   |

Tier is computed against your **post-change** vault balance the
moment you deposit or withdraw VPFI. **For the lender yield fee**
the rate that is actually charged is resolved at settlement from
your tier at that moment — there is no separate average taken over
each loan's own lifetime. Your tier itself is the guard: it is a
time-weighted average of your daily balance over a recent window of
up to 30 days — a protocol setting, counted from the day your
current holding began, weighting the most recent days more heavily.
That average is then held down to the lowest tier you fell to at any
point since your holding began, looking back up to 30 days.

**Those are two separate look-backs, and the second is usually the
longer one.** The averaging window is configurable and can be set
shorter than 30 days; the lowest-tier look-back is not tied to it —
it spans your whole current holding, capped at 30 days. So with a
14-day averaging window, a dip 20 days ago still holds your tier
down even though it falls outside the average.

Your tier is zero altogether until you have held a non-zero balance
**continuously** for a minimum number of days, also a protocol
setting. That clock starts when your balance goes from zero to
positive and restarts only if it returns to zero — topping up an
existing holding does not restart it.

An unstake therefore bites immediately across every open loan
you're on, with no grace window where your old (higher) tier still
applies. This closes the gaming pattern where a user could top up
VPFI just before a loan ends, capture the full-tier discount, and
withdraw seconds later. Note which rule closes it: a long-standing
holder has already satisfied the minimum period, so the work is done
by the lowest-tier rule, which an average could not do — an average
can be pulled up by a late top-up, a minimum cannot.

Against that specific pattern the current rule is the stronger of
the two. It is **not** stronger in every respect: because the
lowest-tier look-back reaches back at most 30 days, a long loan's
early low-tier months eventually stop counting, where an average
across the loan's whole life would have kept them in. The change
tightened the brief-top-up defence and shortened the memory.

**The borrower's initiation-fee rate is read once, when the loan
is accepted**, so nothing you do afterwards moves it — neither a
withdrawal nor a top-up. The anti-gaming protection on that side
is the minimum holding period and the history clamp described
above, not the lifetime weighting.

The discount applies to the lender yield fee at settlement, and
to the borrower Loan Initiation Fee — where it is a **direct
reduction of the fee you pay in the lending asset**, applied when
the loan is accepted. No VPFI is taken from your vault to pay
that fee, and there is no rebate to claim afterwards.

> **If you are looking for a Loan Initiation Fee rebate, read
> this.** An earlier model took the full fee in VPFI up front,
> held it for the life of the loan, and returned part of it when
> you claimed. **That path has been removed.** No loan was ever
> opened on it, so no loan has VPFI held against its initiation
> fee and no rebate is pending — waiting for one would mean
> waiting for money that cannot arrive.

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
VPFI rewards picture in one view. The headline figure is the
sum of pending interaction rewards and lifetime-claimed
interaction rewards.

The breakdown row shows pending + claimed and a chevron
deep-link to the full claim card on its native page:

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
the card on zero would make the rewards program invisible
to fresh users until they wandered into the Claim Center.

---

<a id="chapter.offer-book"></a>

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
the protocol's own — the gate is not bypassable. The `{liveValue:treasuryFeeBps}`% treasury
cut on interest is debited at terminal settlement, not up front.
That rate is fixed when the loan is created, so a later change to the
protocol fee leaves an already-open loan on the rate it started with.

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

<a id="chapter.create-offer"></a>

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
  price. Recovery is net of slippage and the `{liveValue:treasuryFeeBps}`% treasury cut
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
  full collateral to the lender. There is no leftover claim at
  all.

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
   for the collection (the in-repo fee parser that derived absolute
   `FeeLeg` amounts, `apps/defi/src/lib/openseaFeeSchedule.ts`, was
   retired in #1854 and has no live replacement — recover it from git
   history for reference. The agent's `openseaCollectionProxy.ts` is not
   a substitute: it relays OpenSea's Collection API body verbatim and
   does not compute the split. Tracked in #1959.) and pass
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
   in-repo publishers (`apps/indexer/src/openseaPublish.ts`) inject it before
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
  creator fees) into the diamond's waterfall. The sale is a
  repayment funded by the collateral, so the diamond settles
  that net amount exactly as a repayment at the moment of the
  fill would: the loan becomes repaid; the lender's due (the
  full coupon when the loan was created with
  `useFullTermInterest = true`, the interest accrued so far
  otherwise, plus any lender yield-fee discount) is placed in
  the lender's vault and paid to the current lender-position
  holder through the ordinary lender claim; the treasury
  receives its cut net of that discount; and the rest is sent
  to the current borrower-position holder's wallet. If the rest
  cannot be paid to that wallet, it is held instead and paid
  through the ordinary borrower claim in the Claim Center. The
  lender is never paid inside the sale itself, so nothing about
  the lender's wallet can stop it.

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

<a id="chapter.claim-center"></a>

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
- Accrued interest minus the treasury cut fixed when your loan
  was created (`{liveValue:treasuryFeeBps}`% for loans created at
  the current rate). The cut is itself reduced by your
  time-weighted VPFI fee-discount accumulator when consent is on.

Claimable as soon as the loan reaches a terminal state
(Settled, Defaulted, or Liquidated). The lender position NFT is
burned in the same transaction.

<a id="claim-center.claims:borrower"></a>

#### If you're the borrower

The borrower claim returns, depending on how the loan settled:

- **Full repayment / preclose / refinance** — your collateral
  basket back. No Loan Initiation Fee rebate comes with it: your
  discount was already taken off the fee at acceptance.
- **A prepay sale that settles the loan** — this one is not a claim
  at all: the payout happens as the sale fills, and afterwards the
  loan is in a state the Claim Center will not act on, so do not go
  looking for it there. The collateral goes to the buyer, not back
  to you. What you receive is the sale price
  less the lender's entitlement, the treasury cut and any seller
  fees the listing carried, paid to whoever holds the borrower
  position NFT.
- **A full swap-to-repay** (a partial one leaves the loan open and
  creates no claim) — your collateral is sold to cover the debt, up
  to a ceiling you set. Set that ceiling generously and more can be
  consumed than the debt strictly needed; whatever is not consumed
  comes back to you. A surplus in the loan's own asset is normally
  paid straight to the borrower position NFT holder rather than
  waiting as a claim — unless that holder is under a sanctions
  freeze, in which case it is held as a claim instead.
- **HF-liquidation or default** — check anyway; there may be a
  surplus. Only enough value is taken to cover the
  liquidator, the lender and the treasury, and the remainder is
  recorded as your claim. Its FORM turns on one thing: whether
  the collateral was SOLD or HANDED OVER. Sold — routed out
  through an exchange — and the residue reaches you in the loan’s
  principal asset. Handed over, and what is left is the
  collateral itself, encumbered in your vault. More than one
  thing hands it over, and none of them depends on which
  close-out you are in: a liquidator taking the collateral
  directly at a discount, a close-out matched internally against
  an opposing position instead of being sent to an exchange, and a sale that could not be completed — there the collateral comes to you unless the lender brings a working
  quote when they claim, which pays you in the loan's asset instead
  — and most claims bring no quote at all. The
  ordinary liquidation route and a time-based default both try that
  internal match BEFORE reaching for an exchange, so neither of
  those two ends reliably one way or the other, which is why the
  claim rather than the route is the thing to read. The discounted
  route IS reliable, and in the other direction: it neither sells
  nor matches, so what it leaves you is always the collateral. A partial liquidation is not a
  close-out at all — the loan stays open and no claim is created.
  Check the claim rather than assuming which one you have.
  On an illiquid default the whole basket goes and nothing is
  left — that is the rule on this route, not an unlucky outcome.

The borrower position NFT is burned when you claim, not when the
loan resolves — so a surplus left by a liquidation is still there
to collect afterwards. The NFT surviving is not itself proof of a
surplus: where a liquidation left nothing over there is nothing to
collect, claiming is refused, and the NFT can remain regardless.
Read the claim, not the NFT.

---

<a id="chapter.activity"></a>

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
VPFI vault deposits / withdrawals.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Getting VPFI

VPFI is freely transferable. Acquire it on the open market
wherever it trades, or bridge it in: VPFI is a Chainlink CCIP
cross-chain token, so it moves between supported chains using
the official bridge and lands in your wallet on the chain you
bridged to.

<a id="buy-vpfi.discount-status"></a>

### Your VPFI Discount Status

Live status:

- Current tier (0 to 4).
- Vault VPFI balance plus the gap to the next tier.
- Discount percentage at the current tier.
- Wallet-level consent flag.

Vault VPFI counts toward your discount tier for as long as it
stays deposited — there is no separate "stake" action.

<a id="buy-vpfi.deposit"></a>

### Deposit VPFI into your vault

An explicit deposit step from your wallet to your vault on the
same chain. Required on every chain — even the canonical one —
because vault deposit is always an explicit user action per
spec. On chains where Permit2 is configured, the app prefers
the single-signature path over the classic approve + deposit
pattern; it falls back gracefully if Permit2 isn't configured
on that chain.

<a id="buy-vpfi.unstake"></a>

### Unstake VPFI from your vault

Withdraw VPFI from your vault back to your wallet. There is
no separate approval leg — the protocol owns the vault and
debits itself. The withdraw triggers an immediate fee-discount
rate re-stamp at the new (lower) balance, applied to every
open loan you're on. There is no grace window where the old
tier still applies.

<a id="buy-vpfi.cross-chain-tier"></a>

### How your VPFI tier travels across chains

You hold VPFI in your vault on Base, the canonical chain, and Base
works out your tier. When you borrow or lend on another chain, that
chain applies a copy of your tier, which Base sends over Chainlink
CCIP after any deposit, withdrawal or other action that changes it.

Three things to know:

- **A tier that rises with time alone needs an action on Base to
  travel.** When your holding period ends, or your average catches
  up, without a deposit or withdrawal, Base's own figure is current
  at once. Other chains learn it with your next deposit or
  withdrawal on Base, of any size.
- **A lower tier travels first.** The protocol sends a lower tier at
  once and pays for a higher one at most once a day per chain.
  Delivery over CCIP then usually takes minutes. Until it lands,
  that chain keeps applying your previous tier.
- **A copy can age out.** After 60 days without a new copy (the
  default), or once a change to the tier table reaches that chain,
  the old copy gives no discount there. A new copy is sent only when
  your tier changes.

The full rules, including the discount switch you need on Base as
well as on the chain you use, are in "How VPFI Discounts Work"
below. The delivery design is in the
[tier push delivery design](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md).

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### About Rewards

The **interaction pool** pays a per-day pro-rata share of a
fixed daily emission, weighted by your settled-interest
contribution to that day's loan volume. Daily windows finalise
lazily on the first claim or settlement after window close.

Rewards are minted directly on the active chain — there is no
cross-chain round-trip for the user. Cross-chain reward
aggregation happens between protocol contracts only.

<a id="rewards.claim"></a>

### Claim Rewards

A single transaction claims your accrued rewards. Interaction
rewards are zero until the relevant daily window finalises (lazy
finalisation triggered by the next non-zero claim or settlement
on that chain). The UI guards the button while the window is
still finalising so users don't under-claim.

<a id="rewards.withdraw-staked"></a>

### Withdraw VPFI from your vault

Identical surface to "Unstake VPFI from your vault" in the VPFI
section — withdraw VPFI from vault back to your wallet. Withdrawn
VPFI exits the discount accumulator immediately (post-balance
re-stamp on every open loan).

---

<a id="chapter.loan-details"></a>

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
transfers your full collateral to the lender, and nothing is
left for you to claim.

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
  interest minus the treasury cut fixed at your loan's creation
  (`{liveValue:treasuryFeeBps}`% for loans created at the current
  rate; further reduced by your time-weighted VPFI yield-fee
  discount when consent is on). Burns the lender position NFT.
- **Initiate early withdrawal** — list the lender position NFT
  for sale at an asking price. A buyer who completes the sale
  takes over your side; you receive the proceeds. Cancellable
  before the sale fills.
- Optionally delegatable to a keeper holding the relevant
  action permission — see Keeper Settings.

<a id="loan-details.actions:borrower"></a>

#### If you're the borrower

- **Repay** — full or partial. Partial reduces outstanding
  and raises HF; full triggers terminal settlement.
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
- **Best-price intent (1inch Fusion)** — for the
  same ERC-20-on-ERC-20 shape, an intent-based alternative to
  the atomic swap above. Instead of routing through Vaipakam's
  on-chain 4-DEX adapter list right now, you commit your
  collateral to a Fusion-style auction: solvers compete on
  price over a short window (defaults to a 60-second to
  10-minute auction), and the winning solver fills the order
  by paying your loan's settlement legs directly to the
  diamond. The settlement waterfall runs atomically with the
  fill in the same transaction; the same lender-protection
  guarantees apply (no partial fills, full reversion if any
  step fails). Note that the custody model differs from the
  atomic surface in one important way: the atomic surface only
  holds your collateral inside the one repay transaction (it
  either fully settles or fully reverts in a single block).
  The intent surface holds your collateral in protocol custody
  **across the entire commit lifecycle** — from the moment you
  commit until the order fills, you cancel, or someone calls
  the permissionless cancel path. Reaching the auction deadline
  does NOT automatically return your collateral; it only opens
  the cancel paths described below. If neither you nor the
  permissionless path acts after the deadline, your collateral
  stays in diamond custody indefinitely. During the entire
  custody window your collateral is in the diamond, not your
  personal vault.
    - *When to use it* — when you're not in a hurry and want
      the resolver competition to surface a slightly better
      price than the live DEX quote. Expected fills are
      minute-scale rather than block-scale. The atomic surface
      above stays the right choice when you need predictable
      timing.
    - *Pending state* — the Loan Details page shows a
      "pending intent" card with the order hash and deadline
      while the auction runs. A 1-second timer drives the
      countdown so the cancel button enables itself the
      moment the deadline passes; you don't have to refresh.
    - *Cancel & return* — after the deadline the current
      borrower-position-NFT holder can cancel the intent. The
      custodial collateral returns to **the loan's original
      borrower vault** (the address recorded on the loan at
      origination, which is usually you — they only diverge
      if the borrower-position NFT was transferred to a new
      holder between commit and cancel; in that case the new
      holder is the authorised caller but the original
      borrower is the destination). If the cancel is never
      called, anyone can call the permissionless
      "cancelExpired" path after a configurable grace window
      (default 24 hours past the deadline) — but only if
      someone actually does call it. The permissionless path
      is an anti-stranding affordance, not an automatic
      recovery: the contract has no scheduled wake-up and
      pays no gas compensation, so an abandoned commit can
      sit in diamond custody indefinitely until someone runs
      the cancel themselves. Treat the cancel surface as
      your own responsibility.
    - *Lender protection* — if HF drops below the liquidation
      threshold or the loan crosses the default boundary
      while your intent is still live, the protocol force-
      cancels the commit (returns collateral to your vault)
      before running the lender-protection action, so the
      intent doesn't compete with the liquidator for the
      same collateral.
- **Preclose direct** — pay the outstanding amount from your
  wallet now, release collateral.
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
  closes the loan as a repayment in the same Seaport
  transaction: the lender's due waits in the lender's vault for
  the lender's claim, the treasury takes its fee, and the rest
  is sent to your wallet (or held for your borrower claim if
  it can't be paid to your wallet). No extra step from you. Cancellable
  any time before the grace window closes. The listing surfaces
  on OpenSea's marketplace UI automatically; you don't sign
  anything off-chain.
- **Claim as borrower** — terminal-only. Returns collateral on
  full repayment; on default or liquidation there may still be a
  surplus, since only enough collateral is taken to cover the debt
  and the cost of closing it — see the Claim Center section above.
  Burns the borrower position NFT.

> **If your repay tx reverts while you have a live OpenSea
> listing** — a buyer's `Seaport.fulfillOrder` may have landed
> in the same block, EVM-ordered before your repay. Both txes
> are competing terminal flows; only one can win. If the buyer's
> tx wins, your loan is **already closed as repaid**: the lender's
> due and the treasury's share came out of the sale proceeds, and
> your remainder (sale price minus those two legs) was sent to your
> wallet, or is held for you in the Claim Center if it could not
> be paid to your wallet.
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
closed as repaid, NFT transferred, sale proceeds split) or fully
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

<a id="chapter.how-liquidation-actually-works"></a>

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

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### About Public Analytics

A wallet-free, single-chain page: it reads the chain the app is
pointed at (the default read chain when no wallet is connected).
There is no cross-chain rollup and no export; to compare chains,
open the page on each. Two sources, each labelled where it is
used:

- the indexer's keyless, open-CORS read API — the loan, offer,
  recycling and loop-closure figures;
- the Diamond's own view functions over a public RPC — the VPFI
  token and fee figures.

Either source can be queried directly to reproduce what the page
shows.

<a id="public-dashboard.loans-offers"></a>

### Loans and Offers

Loan counters by status from `/loans/stats`, including the
settlement-pending, internally matched and remainder buckets, so
the parts add up to the total; the ERC-20 and NFT-rental
subtotals, with any active loan whose asset type is not yet read
named separately; and offer counters from `/offers/stats`. Offers
are the `offers` table only — gasless signed orders are not
counted — and cancelled offers age out of the index, so the offer
total is not a lifetime figure. An absent counter renders "not
reported", and an impossible one "reported, but not a usable
count"; neither is shown as 0.

<a id="public-dashboard.recycling"></a>

### Recycling Account and Loop Closure

The recycling account (`/metrics/recycling`) lists each
programme day's pool, its funding and what was drawn, labelled by
the programme's own day index, with an unfinalized day shown
without a pool and an unarmed day marked as an estimate. Loop
closure (`/metrics/loop-closure`) shows, per UTC day, what claims
paid out, what stayed in vaults and what was absorbed, against
the moment the record reaches. Positive amounts below display
precision are labelled, shares round down, and an unknown figure
is never rendered as zero.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

The Diamond address with an explorer link, the chain, and the
indexer cursor's block and age. Every indexer-sourced figure is
as current as that cursor and no more; when two responses are
combined, the older cursor is the one stated.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token

From `getVPFISnapshot()` on the Diamond: the token address and
`totalSupply` on this chain. On the canonical chain, also the cap,
the headroom (`cap − totalSupply`, what can still be minted) and
the minter. On a mirror chain the snapshot carries no cap or
minter — supply there arrives through the CCIP token pool — so
the page shows the local supply and says the cap and minter belong
to the canonical chain, rather than rendering zeros. An unbound
token and an unreadable snapshot are stated separately.

<a id="public-dashboard.fees"></a>

### Fees and Treasury

From `getTreasuryMetrics()`, `getTreasury()` and
`getNumeraireSymbol()`, read in the same Multicall3 aggregate as
the snapshot and pinned to one block, which the page states with
its age:

- fees since the fee ledger began, and over the last 24 hours and
  7 days, each valued in the numeraire at accrual and never
  revalued;
- a fee the protocol could not value at accrual is logged as 0, and
  the window sums scan at most the latest 10,000 ledger entries;
  both can only understate, and the page says so;
- a numeraire rotation leaves earlier entries in the old unit, so
  after one the totals add amounts in two units under the current
  symbol and can be off in either direction; the page says earlier
  fees are counted in the old unit;
- the treasury address. When it is an external address, fees
  leave on collection and no balance is shown for it. When the
  Diamond is its own treasury, the held figure is shown, priced
  only over assets that appear in open loans and including
  amounts deployed elsewhere on the treasury's behalf.

A view that fails reads "could not be read" and does not hide the
others.

---

<a id="chapter.refinance"></a>

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
3. Marks the old loan repaid. Its position NFTs are not burned:
   both stay with their holders, marked Loan Repaid. The old
   lender claims the repayment with theirs, and the old borrower
   NFT stays as a receipt.
4. Mints new position NFTs.

Reverts if HF on the new terms would be below 1.5.

---

<a id="chapter.preclose"></a>

## Preclose

This page is borrower-only — preclose is initiated by the
borrower on the borrower's loan.

<a id="preclose.overview"></a>

### About Preclose

A borrower-driven early termination. Two paths:

- **Direct** — pay the outstanding amount (principal + accrued
  interest) from your wallet and release collateral.
- **Offset** — initiate the offset to sell part of the
  collateral via the protocol's 4-DEX swap failover for the
  principal asset, complete the offset to repay from
  proceeds, and the remainder of collateral returns to you.

There is no flat early-close penalty.

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.stuck-token-recovery"></a>

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

1. Visit the [recovery page](https://defi.vaipakam.com/recover).
2. Enter the token contract address, the source you sent
   from, and the amount.
3. Review the on-screen acknowledgment carefully.
4. Type "CONFIRM" to enable signing.
5. Sign the EIP-712 acknowledgment in your wallet.
6. Submit the transaction.

Two outcomes:

- **Source clean** → the tokens are added to your vault's
  tracked balance. Withdraw them from your vault as usual; if
  protected account mode is on, its payout delay applies.
- **Source flagged** → tokens stay in the vault, your vault
  gets locked under the protocol's sanctions policy. The
  lock auto-lifts if the address is later removed from the
  sanctions oracle.

<a id="stuck-recovery.disown"></a>

### Disowning unsolicited tokens (compliance audit trail)

If you want a public on-chain record asserting that some
token balance in your vault is NOT yours, the protocol
provides a `disownUntracked(kind, asset, tokenId)` function. It emits an event
(`UntrackedDisowned`) and changes nothing else — tokens stay in
vault as before. Useful in compliance disputes if a CEX or
regulator asks "did you receive these funds?": you can point
to the on-chain event.

The disown function is exposed only via direct contract call
for now; the Vaipakam frontend does not surface it as a
button. Use a block-explorer "Write Contract" UI or a
contract-interaction tool to call it.

<a id="chapter.how-vpfi-discounts-work"></a>

## How VPFI Discounts Work

VPFI held in your vault on Base, the canonical chain, earns you a
discount on the protocol's own fees, on every chain the platform
runs on. The more you hold, and the longer you have held it, the
higher your tier and the larger the discount. The tiers are in the
[tier ladder](#dashboard.fee-discount-consent) above; governance can
change them.

What the discount applies to:

- **As a lender**, the yield fee the protocol keeps from the
  interest you earn. It is read each time interest is settled,
  for example at repayment, preclose or refinance, at your tier at
  that moment, not your tier when the loan began.
- **As a borrower**, the loan initiation fee charged when your loan
  starts. It is read once, at acceptance, and stays with that loan.
  It applies only when the lending asset is liquid; an illiquid
  loan pays the full fee.

The discount is taken off the fee itself, in the loan's own asset,
and no VPFI leaves your vault for it. The one exception is the
lender's discount on a deployment that configures a VPFI price
reference, where it can be settled in VPFI from your vault instead;
none is configured at launch. This chapter covers that holding
discount. A separate paid fee mode, "Full", stays switched off
unless a deployment turns it on.

<a id="vpfi-discounts.turning-on"></a>

### Turning the discount on

The discount is opt-in. The switch is on the VPFI page, and it is
one switch per chain, because each chain keeps its own setting:

- **On the chain where the fee is charged**, the switch must be on,
  or that chain charges the full fee whatever your tier.
- **On Base**, the switch must be on as well, even if you never
  borrow or lend there. While it is off, Base sends every other
  chain a tier of zero for you.

When you switch the discount off on Base, the app follows with a tier
update so that every other chain stops applying it too: Base then sends
them a tier of zero for you. If that second step fails, the page says
so, and the other chains keep your last tier until something sends a new
one. Switching it off on any other chain changes only that chain.

VPFI counts when the protocol records it in your vault: what you deposit
through the VPFI page, and VPFI rewards the protocol delivers into your
vault. Tokens sent straight to your vault address are not tracked by the
protocol and do not raise your tier.

<a id="vpfi-discounts.tier-calculation"></a>

### How your tier is worked out

Your tier comes from three separate checks, and all three must pass:

1. **A minimum holding period.** Your tier stays at zero until your
   current holding has lasted at least 3 days. A holding begins the
   moment your vaulted balance goes above zero and lasts until it
   returns to zero. Adding to it does not restart the clock;
   withdrawing everything does. (3 days is the default; governance
   may set it from 2 to 14.)
2. **A recency-weighted average.** Your balance is averaged over
   the last 30 days, with the last 7 days counting three times as
   much as the days before them. The average never reaches back
   before your current holding began, so a new holder is not
   diluted by days they held nothing. (The window, the recent days
   and the weight are governance settings; the window can be 14 to
   30 days.)
3. **The lowest tier you have touched.** Separately from the
   average, your tier can be no higher than the lowest tier your
   balance reached during the current holding, looking back at most
   30 days. It counts each day's lowest point, so a dip and a
   recovery within the same day still count as a dip.

What this means in practice:

- A deposit just before a loan settles does not lift your tier at
  once. The added amount has to work its way into the average, and
  the lowest point you touched still caps you.
- A withdrawal that takes you below a tier's floor lowers your tier
  straight away.
- A dip more than 30 days ago no longer caps you.

<a id="vpfi-discounts.other-chains"></a>

### Your tier on other chains

Base works out your tier. Every other chain applies a copy of it that
Base sends over Chainlink CCIP. Base updates your tier record when one
of these happens on Base: VPFI enters or leaves your vault (a deposit, a
withdrawal or a reward delivered into it); a loan starts with you as
lender or borrower; a loan step holds or releases VPFI of yours; or you
make the tier-refresh call. Each update sends the other chains a new
copy when the copy would change.

Each chain is delivered on its own. A chain that cannot be reached
does not hold back the others, and **a delivery that cannot go out
never makes your own action fail**: your tier on Base is current at
once, and each other chain is owed the update until it arrives.

The protocol pays for these deliveries, with one limit:

- **A lower tier** is sent straight away, as long as the budget
  can pay for it. Until it arrives, that chain keeps applying your
  previous, higher tier.
- **A higher tier**, or a change to the tier table, is paid for at
  most once a day per chain (a governance setting between 1 hour
  and 7 days). Until then that chain keeps your previous tier.
- An update held back by that wait, or one the budget could not pay,
  **is not resent on its own when the wait ends**. It goes out with the
  next update to your tier record on Base, or when someone makes the
  delivery call for you.
- Anyone can make that call. Once the wait has passed and the budget
  can pay, the protocol pays for it; before then, the caller pays the
  cross-chain fee to deliver sooner. The contracts offer this call; the
  app does not offer it yet.

A copy stops counting, and that chain gives no discount, when:

- it is older than the chain's maximum age (60 days by default,
  never less than 30); or
- it was made under an older tier table than the one that chain
  now knows.

A copy is resent only when something in it would change: your tier, its
discount, how long it stays valid, or the version of the tier table. So
after a tier-table change, the next update to your tier record on Base
sends every chain a fresh copy, even if your tier is the same, unless it
is zero. If none of these has changed, a chain whose copy has aged out
gives no discount until one does.

If your tier rises only because time has passed — the holding period has
ended, or the average has caught up — nothing on Base notices until the
next update to your tier record. The tier-refresh call makes that update
whenever you choose; the app makes it for you only when you switch the
discount off.

<a id="vpfi-discounts.operators"></a>

### For operators

The cross-chain part of the discount needs this configuration. It is
listed here for anyone running their own deployment.

**On Base:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. Without it Base
  computes tiers but sends them nowhere.
- `RewardReporterFacet.setRewardMessenger` pointing at the
  `VaipakamRewardMessenger`, and the messenger's
  `setBroadcastDestinations` listing every other chain.
- A funded broadcast budget: `ProtocolBroadcastFacet.topUpBroadcastBudget()`
  (payable). An empty budget does not block anything. Each delivery
  it cannot pay stays owed and emits `TierPushDeferred` with the
  reason, and `getTierPushStatus(user)` shows every chain's state for
  a user. A short budget means other chains apply old tiers for
  longer, so watch for deferrals and top up.
- The spacing window for paid raises:
  `setTierPushSpacingSec` (default 1 day, 1 hour to 7 days).

**On every other chain:**

- `RewardReporterFacet.setRewardMessenger(addr)`: the only sender
  whose tier updates the chain accepts.
- `RewardReporterFacet.setBaseChainId(chainId)`: Base's EVM chain id
  (8453 on mainnet, 84532 on Base Sepolia), not its CCIP chain
  selector.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: how long a copy
  counts (default 60 days; values under 30 days are refused).
  Lowering it takes effect on the next read.

**Changing the tier table:**

- `setVpfiTierThresholds` and `setVpfiTierDiscountBps` on Base move
  the table's version. Another chain learns the new version from
  the first tier update that carries it, from any user. From then
  on, every copy made under the old table reads as no discount
  until that user's own update arrives, and those updates are
  raises paid at most once per spacing window. Fund the budget
  before changing the table.
- `setTwaMinStakedDays` changes the minimum holding period without
  moving the version. It takes effect on the next read.

<a id="chapter.next-app"></a>

## The Next App

The next version of the Vaipakam app is being built page by page,
beside the current one. A page that is not built yet says so and
links to the current app, which still serves it. Every figure on a
built page is read from the chain and names its source; a figure
that cannot be read is shown as unknown, never as zero.

<a id="advanced-mode"></a>

### Basic and Advanced

Basic shows the capabilities most people need. Advanced adds the
exit and settlement tools, automation, signed orders, keeper
posture and accounting detail. The mode is a display choice kept in
your browser: it changes how much is shown, not what the protocol
lets you do, and it never hides a consent, a blocker or a remedy.

<a id="wallet"></a>

### Your Wallet and Where Your Figures Come From

Your own state (loans, offers, vault, claims) is read from the
chain: through the wallet's provider first, then the read-only RPC
proxy, then the network's public endpoint. The sync line names the
source that answered and the age of the oldest read on the page,
and Refresh re-reads them all. The index is used only for world
figures (the market and history), with its block height and age
shown. A wallet on an unserved network sees nothing of its own
until it switches.

<a id="deployments"></a>

### What the Deployment Supports

The app binds to one Diamond per chain and reads its routed
selectors through the loupe before offering any action. After a
facet refresh that set changes; reading it, rather than assuming
it, lets the app name a missing function instead of failing with
`FunctionDoesNotExist`. While the set cannot be read, no signing
step is offered.

<a id="home-start"></a>

### Home: Choosing a Job

Home leads with a job, not a protocol term: borrow, lend, rent an
NFT, rent out an NFT, or manage what you have. Borrowing and
lending open on matching offers and fall back to posting your own.
Renting covers both sides of an NFT rental, with the NFT held in a
vault throughout. A connected wallet also sees three dismissible
getting-started cards; the dismissals are kept in the browser.

<a id="home-status"></a>

### Home: Protocol Status

Home reads the global pause, the automatic pause window and the
keeper pause on the chain the page describes, and states the result
in every case. A global pause stops new positions, claims,
withdrawals, liquidations, defaults and keeper-driven settlement;
full repayment, partial repayment and adding collateral stay open,
and the paused time is credited to every open loan's deadlines. An
automatic pause window shows its end time; an administrator pause,
if any, outlasts it, and a new automatic window opens only after a
cooldown. A keeper pause only stops steps the service runs on your
behalf. A status that cannot be read, including a re-read that
failed after an earlier answer, is shown at the top as unknown.
Single assets can also be paused; the flows that need one say so.

<a id="home-payouts"></a>

### Home: Ready to Collect

Home walks the claimable views for the lender and the borrower side
page by page and names each payout by loan and side. It shows no
amount: a payout can be paid in more than one asset and through
more than one route, and Claims is where each amount is stated
before you collect. If the walk stops before the end, Home says
more may exist than is shown.

<a id="home-loans"></a>

### Home: Your Loans

Each Active or FallbackPending loan is listed with its side, terms,
collateral and stage, ordered by urgency: past grace, in grace,
fallback, deadline unreadable, due within three days, running. The
due date and grace end come from the protocol's loan clock and
already include paused time, which is shown when non-zero. The
health factor is the 1e18-scaled reading of the dashboard view; a
reading of 0 means none (an unpriced asset, or the reading failed)
and is shown as such. Two or more loans opened from the same offer,
on the same side and in the same ERC-20, are grouped: principal
summed, rate weighted by principal and rounded down, and the lowest
health factor among the priced loans, with the unpriced ones
counted.

A loan that pays interest periodically also has checkpoints, up to and including its due date. Interest still owed when a checkpoint's grace period ends can be paid by selling collateral, and the loan stays open; Home shows the next checkpoint and puts an owed one first, even when it falls on the due date, because its grace period can end before the loan's. The protocol can switch this settlement off; Home then says that no collateral is sold at a checkpoint.

<a id="home-exposure"></a>

### Home: Lent and Borrowed

Each loan's principal is valued in the numeraire at current prices
through the protocol's one valuation rule: a debt rounded up, a
loan you made rounded down. A loan that cannot be valued (an NFT,
or an asset with no price) is counted, not guessed. The larger
side is named only when the unvalued loans could not change the
answer; otherwise Home shows the valued totals and the count.

<a id="home-faucet"></a>

### Home: Test Assets

On a testnet whose deployment record publishes test assets, Home
lists them: test ERC-20s wired to a test price feed and pool
(liquid), ones deliberately left without either (illiquid: loans in
them are unpriced and default in kind), and ERC-4907 rental NFTs. A
mint calls the mock token contract, never the Diamond: 1,000 whole
tokens, or one NFT under a fresh random token id checked unminted
before the wallet opens. The outcome is measured by reading the
balance or `ownerOf` back, and a token mint then offers
`wallet_watchAsset`. A test NFT can be burnt only by its owner or an
approved operator.

<a id="home-fee-discount"></a>

### Home: Fee Discount

`setVPFIDiscountConsent` sets one per-wallet flag on this chain's
Diamond. Off, the hold-tier discount is 0. On, the borrower's loan
initiation fee is reduced at acceptance in the lending asset (the
VPFI pricing route is never part of the borrower path), and the
lender's yield fee is discounted at each settlement at the effective
tier then in force. Delivery follows `getVPFIDiscountConfig`: with
both the VPFI rate and its reference asset set, the discounted fee
is debited in VPFI from the lender's vault and the lender keeps all
the interest; otherwise the treasury fee itself is reduced and no
VPFI moves. If that debit cannot run at a settlement (no live quote,
too little free tracked VPFI in the vault, or that VPFI locked as
collateral), that settlement's fee gets no hold-tier discount. The
call is `whenNotPaused`, so the global pause closes it in both
directions. Turning it on is gated by the Terms, turning it off is
not, and neither broadcasts a tier to the mirrors. The borrower
discount applies only when the lending asset is liquid at acceptance
(an illiquid loan pays the full LIF), and every discount is capped
at 50% of the fee.

<a id="home-rewards"></a>

### Home: Rewards

The headline is `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`, which runs the claim with the Vault venue and always reverts: `InteractionRewardsSimulation(paid, fromDay, toDay)` carries the exact figure, and any other revert is the claim's own refusal (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`), shown by name. Only when no source can run the preview does Home read `previewInteractionRewards`, a lower bound, and it withholds the claim. An exact figure of zero is still offered: the protocol allows a claim that pays nothing only when it moves past reward days that paid nothing, and Home says so. Home claims through `claimInteractionRewardsTo(2)`, which pays at most `MAX_INTERACTION_CLAIM_DAYS` (30) days per call; when a preview read at or after the finished claim's block still answers with a figure, Home offers the remainder. A claim paid from reward entries alone names no day range (0 to 0), and Home says so instead of showing days. The Vault venue is passed for every account, a contract wallet included, because the Default venue pays a contract caller to its wallet: the vault is credited, falling back to the wallet when the credit cannot complete (no vault yet). The outcome is read from the receipt: `InteractionRewardsClaimed` gives what was paid, and the same transaction's VPFI `Transfer` logs to the wallet and to `getUserVaultAddress(user)` give where it landed; when they do not add up to the paid figure, the destination is stated as unknown. Lifetime claimed is not shown: no per-user index route exists for it yet.

<a id="home-rewards-expiry"></a>

### Home: Reward Removal Dates

`ConfigFacet.getRewardClaimHorizonDays()` of 0 means the horizon is dark and no date is shown. Otherwise Home walks `getUserSoonestRewardExpiry(user, offset, 200, 50)` page by page, every page at one block, for up to ten pages; the walk is complete when `nextOffset >= total`, and a walk that stops short is stated as incomplete, never as nothing due. The final notice is shown within 90 days of the soonest estimate. The estimate is the entry's `expiresAt` as of that block: claim-unexecutable time moves the real removal later, and a governance change to the horizon can move it earlier. The amount the entry would remove is not shown on Home.

<a id="home-rewards-held"></a>

### Home: Held Rewards

`getSanctionsHeldReward(user)` is the held balance and `getRewardSanctionsStatus(user)` its decision (Deliver, Hold or Confirmed). With a balance and a Deliver decision, Home offers `claimHeldInteractionRewards(2)`, which pays exactly the held balance without settling anything newly owed and emits `InteractionRewardsClaimed(user, 0, 0, paid)`; it reverts `SanctionedAddress` while the wallet is barred. The re-check before signing re-reads both and simulates the call as the sender. Days earned while a flag is confirmed are forfeited permanently.

<a id="borrow-start"></a>

### Borrow: How It Works

Borrow takes a lender offer (`offerType` 0) of an ERC-20 against ERC-20 collateral directly, with `acceptOffer(offerId, terms, signature)`. In one transaction it opens the borrower's vault if there is none, pulls the collateral into it and delivers the principal less the initiation fee to the wallet, and emits `LoanInitiated`. A borrower can also post a request (`offerType` 1); NFT legs, pair consents and the Advanced options follow in later updates.

<a id="borrow-pair"></a>

### Borrow: Choosing the Tokens

Each token's class is read live: `getAssetPriceStatus(asset)` first (Divergent reads as distrusted and closes new loans), then `checkLiquidityOnActiveNetwork(asset)` (0 liquid, 1 illiquid). A revert of `OraclePriceDivergence` or `OracleCrossCheckDivergence` reads as distrusted; any other failure is shown as unreadable, with its reason. The suggested list is the deployment record's wrapped native token and test tokens; a pasted address is checked for shape only.

<a id="borrow-offers"></a>

### Borrow: Picking an Offer

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` gives the pair's open offer ids and total. For each, the page reads `getOffer`, `getOfferState` and, with a wallet, `previewAccept(offerId, wallet)`, whose `errorCode` is the protocol's refusal. The loan-to-value is `calculateLTV` at today's prices; an illiquid or unpriced leg says why there is none. A direct take binds the lender's `amountMax` at `interestRateBps`. Offers that are borrow requests, carry an NFT leg or are the reader's own are counted, not listed.

<a id="borrow-review"></a>

### Borrow: Review and Signing

The review reads the offer, its state, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, both classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, the wallet's vault, balance and allowance, `previewOfferAcceptBlock` and the fee-discount consent, and reads them again right before the wallet opens. The wallet signs EIP-712 `AcceptTerms` (domain `Vaipakam AcceptOffer`, version 1) built from the stored offer, with a fresh 128-bit nonce and a 30-minute deadline; an illiquid acknowledgement names only a leg the review showed as illiquid. An approval of exactly the collateral follows only when the allowance is short, then `acceptOffer` is simulated with the signature and sent. If it stops after the approval, the app resets the allowance to its earlier value when nothing else changed it. The outcome reads `LoanInitiated` for this offer and wallet and the `Transfer` logs of the receipt. The allowance is read again just before the first prompt, and that value is what a reset restores; a submitted acceptance that reverts, or that the wallet cancels or replaces, gets the same reset from the transaction tracker. The review states `allowsPartialRepay`, `allowsPrepayListing`, `allowsParallelSale` with `parallelSaleOrderHash`, `refinanceTargetLoanId` and the linked loan, and labels the owed figure as the no-pause case, since interest accrues through a pause while the due date moves. Each approval step is judged by the allowance read back at the block its receipt mined in, never by the receipt's status. A token that refuses a change from one non-zero allowance to another, found by a dry run of `approve`, gets a step to zero first, which the review counts as an extra prompt. The Terms acceptance is read again right before the wallet opens. Both sale routes list the collateral as an NFT, so on token collateral a granted listing or sale permission is stated as one the loan cannot use.

<a id="borrow-fee"></a>

### Borrow: The Initiation Fee

The fee is `previewAccept`'s `lifEstimate`: `getLoanInitiationFeeBps` of the principal, in the lending asset, deducted from what is delivered, lowered by the hold-tier discount when the consent is on and the lending asset is liquid, with the tier fixed at acceptance. This page never opts into the Full tariff. No VPFI is collected for the fee and none is rebated. The submitter's share, `getLifMatcherFeeBps` of the fee, is paid to the sender, which on a direct take is the borrower, so the wallet receives the principal less the fee plus that share.

<a id="borrow-risks"></a>

### Borrow: Risks

A loan past its grace end (`getEffectiveGraceSeconds` after the due date, which paused time moves) can be defaulted by anyone: liquid collateral is sold for the lender, illiquid collateral is transferred as-is. Liquid collateral can also be liquidated once the health factor is below 1. `useFullTermInterest` charges the full term's interest on early repayment; a periodic-interest cadence settles a missed period by a forced sale of collateral.

<a id="borrow-request"></a>

### Borrow: Posting Your Own Request

A request is `createOffer` with `offerType` 1, ERC-20 on both legs, sent from the borrower's wallet. It pulls `collateralAmount` into the borrower's vault, creating the vault if there is none, and emits `OfferCreated(offerId, creator, 1)`. A lender takes it with `acceptOffer`: the principal less the fee goes to the borrower's wallet, and the sender's share of the fee goes to the lender who sent it. `cancelOffer` is open to the creator from `MIN_OFFER_CANCEL_DELAY` (5 minutes) after creation, and to anyone once the request has expired; the collateral always returns to the creator.

<a id="borrow-request-terms"></a>

### Borrow: The Request's Terms

Basic posts a single-value request: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing` and `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. Amounts are parsed into base units exactly and the rate is at most 10,000 bps. `durationDays` is capped by the configured maximum read from `getProtocolConfigBundle`. `expiresAt` is 0 (open until cancelled) or a time fixed from the latest block when the review opens, at most `MAX_OFFER_EXPIRY_HORIZON` (365 days) ahead. `useFullTermInterest` defaults to true and `allowsPartialRepay` to false.

<a id="borrow-request-review"></a>

### Borrow: Reviewing and Posting a Request

The review simulates `createOffer` from the wallet and reads both classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, the maximum term, the wallet's vault, balance and allowance, and `calculateLTV` when both legs are liquid; it is read again every block and right before the wallet opens. While the allowance is short the simulation can only reach the collateral pull, so a token's pull error or a revert without a protocol error name is shown as the approval to clear, and a named protocol error is a refusal. After an exact approval `createOffer` is simulated again and sent; a stop after the approval resets the allowance to its earlier value when nothing else changed it. The outcome reads `OfferCreated` for this wallet and the collateral `Transfer` into the vault.

<a id="borrow-nft-collateral"></a>

### Borrow: An NFT as Collateral

The collateral's standard is read with `supportsInterface` (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`); a revert counts as neither, and a failed read offers no request. An ERC-721 request sends `collateralAssetType` 1, `collateralTokenId` the typed id, `collateralQuantity` 1 and `collateralAmount` = `collateralAmountMax` = 0; the risk pair is keyed to that token id. The review reads `ownerOf`, `getApproved` and `isApprovedForAll(wallet, Diamond)` at one block, and a token held elsewhere, or an `ownerOf` that reverts, blocks the request. Without either approval the dry run stops at the token's `ERC721InsufficientApproval`, shown as the approval to clear. The approval is `approve(Diamond, id)`, counted only when `getApproved` reads the Diamond at the receipt's block; a stop afterwards resets it to the earlier address only while it still reads the Diamond and the wallet still holds the token. For an ERC-721, `setApprovalForAll` is never asked. The outcome reads `OfferCreated` and the token's own `Transfer` (four topics) from the wallet to the vault. An ERC-1155 request sends `collateralAssetType` 2, the token id, `collateralQuantity` the typed quantity (1 to 2^128−1) and both amounts 0. The review reads `balanceOf(wallet, id)` and `isApprovedForAll(wallet, Diamond)` at one block; a balance below the quantity blocks the request, and without the approval the dry run stops at `ERC1155MissingApprovalForAll`. The only approval is `setApprovalForAll(Diamond, true)`, counted when it reads back at its receipt's block, and taken back with `setApprovalForAll(Diamond, false)` after the request mines or stops (reading no earlier than the grant's block), unless the wallet had granted it before. The outcome sums the token's `TransferSingle`/`TransferBatch` from the wallet to the vault. Lender offers asking for an NFT still go to the current app.

<a id="borrow-request-range"></a>

### Borrow: A Ranged Request

A range sends `amount` (the smallest) below `amountMax` (the largest), `interestRateBps` = `interestRateBpsMax` (the one rate), and `collateralAmount` (the floor for the smallest loan) at or below `collateralAmountMax` (pulled into the vault at posting); an empty floor sends the two equal. Ranges are offered for ERC-20 collateral only. A direct `acceptOffer` lends `amount` at `interestRateBpsMax` against `collateralAmount` and returns `collateralAmountMax − collateralAmount` to the wallet; `matchOffers` fills between the ends while `getPartialFillEnabled` is true. The `createOffer` dry run applies the offer bound at the largest end and refuses with `MaxLendingAboveCeiling(provided, ceiling)`, whose ceiling the review shows. The direct end is checked by a second dry run of a single-value request at (`amount`, `collateralAmount`); an answer that stops before the bound is stated as unknown. Each end's loan-to-value is `calculateLTV(lending, amount, collateral, collateralAmount)`, and `ZeroCollateral` reads as a collateral worth nothing. The start-of-loan health factor shown is `getMinHealthFactor` while `getDepthTieredLtvEnabled` is false, and 1.0 while it is true. A match locks the lender's pro-rated requirement, raised to `collateralAmount` when the collateral is a range and otherwise left at the requirement, so the largest match is shown at both `collateralAmountMax` and `collateralAmount` (or, without a collateral range, as able to lock less); only the start-of-loan check bounds it, and a failed read of that check is stated, never dropped. In the depth-tiered regime the check also applies the tier's loan-to-value cap. While `getPartialFillEnabled` is true, the collateral a match does not lock stays in the vault for later matches and is refunded only when the request closes (its remaining capacity falls below `amount`) or `cancelOffer` runs.

<a id="borrow-request-fill"></a>

### Borrow: A Request's Fill Mode

`fillMode` is 0 (Partial), 1 (AON) or 2 (IOC) and cannot change after posting. AON requires `amount` = `amountMax` (`AonRequiresSingleValueAmount`), and IOC requires `expiresAt` ≠ 0 (`IocRequiresExpiry`); the form does not offer either refused shape. The amounts, the rate and the collateral can change on an open request through `setOfferAmount`, `setOfferRate`, `setOfferCollateral` and `modifyOffer`, never below `amountFilled` or `collateralAmountFilled`; this app does not call them yet.

<a id="borrow-request-cadence"></a>

### Borrow: A Request's Interest Schedule

`periodicInterestCadence` is 0 (None) to 4 (Annual), with periods of 30, 90, 180 and 365 days. The form offers what `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` admits, which runs the rule `createOffer` enforces, valued at `amount` (the smallest end of a range). Each refusal is stated from its revert data: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid`, or `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. One period's interest is `principal × rate × intervalDays / (10000 × 365)`. A missed period can be settled by anyone through `settlePeriodicInterest` once the grace `getEffectiveGraceSeconds(intervalDays − 1)` has passed; it sells collateral and the loan stays open. The `periodicSettle` keeper pass's arming is shown as the capability service reports it, unknown by default. The schedule cannot change after posting.

<a id="borrow-request-tariff"></a>

### Borrow: A Request's Full Fee Tariff

The opt-in is `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, sent by the creator after `createOffer` and refused with `OfferAlreadyAccepted` once a lender has taken the request; `maxCStar` must be above zero (`FullTariffMaxCStarRequired`). The form shows the switch from `getFeeEntitlementConfig()` and the tariff from `quoteCStar(lendingAsset, principal, durationDays)`, at `amount` and `amountMax` for a range; the ceiling defaults to the quote at `amountMax`. At each accept the charge takes `C*`, priced at that loan's principal, only if the switch is on, the principal is priced and liquid, `C* ≤ maxCStar`, and the vault's free VPFI covers it (the vault balance capped by `getTrackedVPFIBalance`, less active liens, through `getFreeBalance`); otherwise it reverts `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` or `FeeEntitlementTariffAboveAuth`, unless `allowDowngrade` lets the loan open without it. The borrower's loan fee discount rises by `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000), capped at `MAX_FEE_DISCOUNT_BPS` (5000). The review blocks a choice under which every loan would be refused, and the opt-in is measured by reading `getOffer` back (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). Backstop lending for unfilled requests is not offered by this app yet.

<a id="lend-start"></a>

### Lend: How It Works

Lend takes a borrow request (`offerType` 1) of an ERC-20 against ERC-20 collateral directly, with `acceptOffer(offerId, terms, signature)` sent by the lender. In one transaction the principal is pulled from the lender's wallet, under an allowance to the Diamond, into the lender's vault; the borrower receives it less the initiation fee; the collateral already in the borrower's vault becomes the loan's collateral; and `LoanInitiated` is emitted, with a lender and a borrower position NFT. A lending offer (`offerType` 0) is posted from the same page; NFT legs follow in a later update.

<a id="lend-offers"></a>

### Lend: Picking a Request

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` gives the pair's open offer ids. For each, the page reads `getOffer`, `getOfferState`, `getOfferLinkedLoanId` and, with a wallet, `previewAccept(offerId, wallet)`, whose `errorCode` is the protocol's refusal. A direct take binds the request's `amount` (its minimum) at `interestRateBpsMax`, and the loan-to-value is `calculateLTV` on that amount at today's prices. Lender offers, NFT legs, the reader's own requests and lender-position sale vehicles (a borrow-side offer with a non-zero `getOfferLinkedLoanId`) are counted, not listed. The order is fundable first, then rate descending, then amount descending.

<a id="lend-review"></a>

### Lend: Review and Signing

The review reads what Borrow's does (the offer, its state, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, both classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, the wallet's vault, `previewOfferAcceptBlock` and the fee-discount consent) plus `getTreasuryFeeBps`, and measures balance and allowance on the lending asset, the leg the lender pays. A shortfall in it blocks signing, as does a lender-position sale vehicle. The wallet signs EIP-712 `AcceptTerms` (domain `Vaipakam AcceptOffer`, version 1), approves exactly the principal only when the allowance is short (with a zero step first for a token that refuses a non-zero change), and `acceptOffer` is simulated and sent; an allowance left by a stopped flow is reset as on Borrow. The outcome reads `LoanInitiated` for this offer, the principal's `Transfer` out of the wallet and the matcher share's `Transfer` back to it.

<a id="lend-fee"></a>

### Lend: The Fee and the Protocol's Share

The fee is `previewAccept`'s `lifEstimate`, and it is the borrower's: `getLoanInitiationFeeBps` of the principal in the lending asset, deducted from the borrower's delivery, lowered at acceptance by the borrower's hold-tier discount and, when `creatorFull` is set and the charge succeeds, by the Full tariff bonus. The submitter's share, `getLifMatcherFeeBps` of the fee, is paid to the sender, here the lender. The protocol's share of interest is `getTreasuryFeeBps`, fixed per loan when it opens (`treasuryFeeBpsAtInit`); the lender's hold-tier discount, with the consent on, lowers it when interest is settled. The review shows today's rate, and the share at that rate as an upper bound.

<a id="lend-risks"></a>

### Lend: Risks

A loan past its grace end (`getEffectiveGraceSeconds` after the due date, which paused time moves) can be defaulted by anyone: liquid collateral is sold for the lender, illiquid collateral is transferred as-is. With both legs liquid the loan can be liquidated once the health factor is below 1, and the sale pays the lender first. An illiquid leg rules out price-based liquidation, and on default the lender receives all the collateral. `useFullTermInterest` floors the interest on early repayment; without it interest is pro-rata. A periodic-interest cadence settles a missed period by a forced sale of collateral to the lender. The lender's position NFT carries the claim: transferring it transfers the loan.

<a id="lend-offer"></a>

### Lend: Posting Your Own Offer

A lending offer is `createOffer` with `offerType` 0, ERC-20 on both legs, sent from the lender's wallet. It pulls `amountMax` of the lending asset into the lender's vault, creating the vault if there is none, and emits `OfferCreated(offerId, creator, 0)`. A borrower takes it with `acceptOffer`: their collateral is pulled into their vault, the principal less the fee goes to their wallet, and the sender's share of the fee goes to them as the sender. While `getPartialFillEnabled` is true, `matchOffers` may also pair it with a borrower's request; a single-value lender offer then lends its whole amount at its rate, against at least its `collateralAmount`. `cancelOffer` is open to the creator from `MIN_OFFER_CANCEL_DELAY` (5 minutes) after creation, and to anyone once the offer has expired; the amount always returns to the creator.

<a id="lend-offer-terms"></a>

### Lend: The Offer's Terms

Without parts a lending offer is single-value: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (the one collateral a borrower must lock), `fillMode` 0 unless Advanced sets another (next section), `periodicInterestCadence` 0 unless Advanced sets a schedule, `allowsPrepayListing` and `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true, and no Full tariff unless Advanced chooses it. Amounts are parsed into base units exactly and the rate is at most 10,000 bps. `durationDays` is capped by the configured maximum read from `getProtocolConfigBundle`. `expiresAt` is 0 (open until cancelled) or a time fixed from the latest block when the review opens, at most `MAX_OFFER_EXPIRY_HORIZON` (365 days) ahead. `useFullTermInterest` defaults to true and `allowsPartialRepay` to false.

<a id="lend-offer-parts"></a>

### Lend: An Offer in Parts

Parts send `amount` (the smallest part one match may lend) below `amountMax` (the whole amount, which `createOffer` pulls into the vault); `collateralAmount` = `collateralAmountMax` stays the one requirement, stated at `amountMax` (`LenderCollateralRangeNotAllowed` otherwise), and `interestRateBps` = `interestRateBpsMax`. A direct `acceptOffer` of a lending offer lends `amountMax` against `collateralAmount`, and only while `amountFilled` is 0 (`OfferPartiallyFilled` after a match). While `getPartialFillEnabled` is true, `matchOffers` lends the midpoint of the amount overlap, at least `amount`, at the midpoint of the rate overlap, against at least `collateralAmount × matchAmount ÷ amountMax` (rounded down; a borrower's collateral range can raise it). When `amountMax − amountFilled` falls below `amount`, the remainder is withdrawn to the lender's wallet and the offer closes (`OfferClosed`, reason `Dust` or `FullyFilled`). `cancelOffer` on a partly filled offer skips the cooldown and returns `amountMax − amountFilled`. `fillMode` is 0, 1 or 2 as on a request: AON requires `amount` = `amountMax`, IOC requires an expiry, and it cannot change after posting. With both legs liquid, `createOffer` refuses a `collateralAmount` below the floor at `amountMax` with `MinCollateralBelowFloor(provided, floor)`, whose floor the review shows. One loan-to-value is shown, `calculateLTV` at (`amountMax`, `collateralAmount`): a part carries the same ratio, give or take the rounding.

<a id="lend-offer-schedule"></a>

### Lend: An Offer's Interest Schedule

A lending offer's `periodicInterestCadence` follows the request's rule (above), with `previewCadenceAdmission` valued at the offer's `amount`: its smallest part, or the whole amount without parts. `createOffer` admits it there through `requireCadenceAdmitted`, and each loan's origination checks its own principal again (`requireOriginationCadenceAdmitted`). The review states one period's interest at `amountMax` (a direct take) and, with parts, at `amount`. A missed period can be settled by anyone through `settlePeriodicInterest` after its grace: collateral is sold to pay the lender that period's interest, and the loan stays open.

<a id="lend-offer-tariff"></a>

### Lend: The Full Fee Tariff on an Offer

The lender's opt-in is the same `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, sent after `createOffer`. It is refused with `OfferAlreadyAccepted` once the offer is taken in full or closed; a partly matched offer still takes it, for its later loans. The quote is `quoteCStar` at `amount` and `amountMax`, and the ceiling defaults to the quote at `amountMax`. Each loan is checked against `maxCStar` on its own, priced at its principal, under the same conditions as a request (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, or a downgrade where allowed); the lender's check uses the vault's live free VPFI. A charged tariff stamps the loan's `lenderMode` as Full, and every lender yield-fee settlement then adds `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) to the position holder's discount on the protocol's share, capped at `MAX_FEE_DISCOUNT_BPS` (5000), with or without the hold-discount consent. An extension in place (`repriceFeeEntitlementOnExtension`) sets the stamp to None for the new term.

<a id="lend-offer-review"></a>

### Lend: Reviewing and Posting an Offer

The review simulates `createOffer` from the wallet and reads both classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, the maximum term, the wallet's vault, its balance and allowance on the lending asset (the leg the lender locks), and `calculateLTV` when both legs are liquid; it is read again every block and right before the wallet opens. While the allowance is short the simulation can only reach the pull of the amount, so a token's pull error, `VaultDepositFailed` (the protocol's wrap of a pull that reverted without data, as WETH does on a short allowance) or a revert without a protocol error name is shown as the approval to clear, the same rule a request's review uses; any other named protocol error is a refusal. After an exact approval `createOffer` is simulated again and sent; a stop after the approval resets the allowance to its earlier value when nothing else changed it. The outcome reads `OfferCreated` for this wallet with `offerType` 0 and the amount's `Transfer` into the vault.

<a id="lend-offer-fee"></a>

### Lend: Fees on Your Offer

`createOffer` charges the lender nothing. The fee shown is the borrower's: `getLoanInitiationFeeBps` of the amount in the lending asset, at the rate in force when `acceptOffer` runs, lowered then by the borrower's hold-tier discount and deducted from their delivery; the figure shown uses today's rate. The protocol's share of interest is `getTreasuryFeeBps`, fixed per loan when it opens (`treasuryFeeBpsAtInit`); the lender's hold-tier discount, with the consent on, lowers it when interest is settled. The review shows today's rate and the share at that rate as an upper bound; a failed read of `getTreasuryFeeBps` is stated, and no share or amount back is shown.

<a id="positions"></a>

### Positions: How the List Is Read

Positions reads the same inventory as Home through one shared reader: `getUserPositionLoansPaginated` walks the position NFTs the wallet holds, `getLoansBatch` hydrates them, and each side comes from the token held (`lenderTokenId` or `borrowerTokenId`), never from the party recorded at origination. Loans with status Active or FallbackPending are live, with the deadlines, health factor and grouping described under Home. Every other status is ended, newest loan id first, named from `LoanStatus`: Repaid, Defaulted, Settled, or InternalMatched (closed by a match); a status number the app does not know is shown as its number. Payouts follow the claimables rule described under Home: a held position on an ended loan the wallet received from someone else is counted, not guessed.

The side choice filters payouts, live and ended rows by the side held. "Nothing" is said only when the position walk and the payout walk completed and the latest read succeeded; a walk stopped at its cap is stated as incomplete. A row opens `/positions/<id>`, where the eligibility verdict decides each action; the list sends no transaction.

<a id="position"></a>

### Position: How a Loan Is Read

The page reads `getLoanDetails(loanId)` and `ownerOf` for the lender and borrower position NFTs; the role is the token the wallet holds now. For a live loan (Active or FallbackPending) it reads `getLoanDeadlines` (the current term's maturity before pause credit, which an extension or a borrower handover rewrites, pause credit, maturity, grace end), `previewPeriodicSettle` with `getPeriodicInterestEnabled` when the loan has a cadence, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor` and `calculateLTV`; for every loan, `getLoanCollateralLien` and `isSaleVehicleLoan`. Each read stands alone: one that fails is shown as unknown, never as zero, and no date is computed from `startTime` and `durationDays`.

For a priced loan it also reads `getInternalMatchConfigBundle`. While internal matching is on, a loan whose loan-to-value sits from its threshold up to the threshold plus `externalLiquidationPriorityWindowBps` is held for an internal match and every outside liquidation route refuses (`InternalMatchOnlyBand`), so the page states that band. A `loanInitiationFeeBpsAtInit` of 0 (a loan opened before the rate was kept) is shown as not recorded, and a `treasuryFeeBpsAtInit` of 0 as the 1% legacy rate settlement applies. The in-kind warning is for an ERC-20 loan only: an NFT rental has no collateral, and its default ends the renter's use, pays the prepaid rent to the lender less the treasury share and sends the buffer to the treasury, which the page states instead.

Rates are the loan's snapshots: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (none on a sale vehicle) and `liquidationLtvBpsAtInit`. A loan with an Illiquid leg (`principalLiquidity` or `collateralLiquidity`) has no price-based reading: the protocol refuses `calculateHealthFactor` and `calculateLTV` for it, and the page says so instead of unknown. `principal` is what is still owed (a partial repayment lowers it), and `interestRateBps` and `collateralAmount` can change too, so the terms are shown as they stand now; an ended loan with no principal on its record says whether an internal match covered it, and otherwise only that none is recorded; an NFT rental shows its rent per day (`principal`, in `prepayAsset`) and whether returning early still charges every remaining day (`useFullTermInterest`). With `getPeriodicInterestEnabled` false, the page says no collateral is sold at a checkpoint. `collateralLiquidity` Illiquid on a live loan adds the in-kind warning: a default transfers the collateral to the lender without a sale. Its first transaction is the full repayment, below.

<a id="repay"></a>

### Repay in Full: How It Is Sized

The action follows one rule: `repayLoan` is offered for an Active or FallbackPending ERC-20 loan to any wallet that is neither `loan.lender` nor `ownerOf(lenderTokenId)` (`LenderCannotRepayOwnLoan`), held past the effective grace end on an Active loan (`RepaymentPastGracePeriod`) and while `positionLock(borrowerTokenId)` is `SwapToRepayIntent`. A lender listing, a refinance request and the global pause do not hold it. Rentals are not offered here yet.

The review reads `calculateRepaymentAmount(loanId)` at the latest block and again with the block time overridden to `min(now + 30 minutes, grace end)`; the same request reads the block time it ran under, and a connection that ignored the override is passed over. The approval is exactly the second figure, the call is simulated before the wallet opens, and after the receipt the status the repayment left the loan in is read from its `LoanRepaid` log (not at the block, where a later claim can already have settled it), the payment is measured from the `Transfer` logs, and the allowance is reset to its prior value when it reads the approval less the payment. An allowance above that figure, unlimited included, is lowered to it as well, since `repayLoan(loanId)` takes no maximum or deadline; the reset then restores the larger value.

<a id="interest-schedule"></a>

### Interest Schedule: How It Is Read

For an Active ERC-20 loan with a cadence, the card reads `previewPeriodicSettle(loanId)` (cadence, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()` and `paused()`, and states the block time it read. `expected` is one full period at the current `principal` and `interestRateBps`; `periodEndAt` carries the loan's pause credit.

The preview's `canSettleNow` ignores the switch and the pause, so the card puts them together in `settlePeriodicInterest`'s own order: switched off (`PeriodicInterestDisabled`), paused (`whenNotPaused`), then the period's time (`PeriodicSettleNotDue` before `graceEndsAt`). A sale is announced only when the switch is on and the protocol is not paused; an unread switch or pause is stated as unknown. With a zero shortfall the settlement only advances the checkpoint. The keeper's `PERIODIC_SETTLE` arming is not reported to the app, so the card says settling is open to anyone and that the keeper's posture is not known.

<a id="partial-repay"></a>

### Paying Part of a Loan: How It Is Sized

`repayPartial(loanId, amount)` takes `amount` of principal plus the interest accrued since `interestAccrualStart` (net of any periodic credit). It pays the interest first to earlier holders still owed interest from before a sale (`paySellersFirst`), then the current lender-position holder, with the treasury's share split off (a holder the protocol must freeze has its share locked into the lender vault instead, `freezeOrPayActiveLenderFromPayer`); it lowers `principal`, restarts the interest clock and credits the current period; maturity never moves. It refuses past the grace end, below `principal × minPartialBps / 10000` (`getAssetRiskParams`), at or above the whole principal (`PartialWouldRetireFullPrincipal`), on a live intent commit or refinance request, and, for a liquid loan, when the health factor would worsen.

No view returns the partial's interest ahead of the call (#3299), so the review uses `calculateRepaymentAmount` less `principal`, read now and at a moment ahead. That is exact for a pro-rata loan at or before maturity; with `useFullTermInterest` it includes the remaining-term floor, and past maturity a late fee, so it is shown as "at most". The approval is exactly the part plus that upper figure. The finish card measures the `newPrincipal` of the payment's own `PartialRepaid` log (not `principal` at the block, which a later transaction there can move), the wallet's outflow and `previewPeriodicSettle` afterwards. The review refuses the wallet only when it is short of the part, or of the part plus an exact interest figure; when only the upper figure exceeds its balance, the dry run just before the payment is sent decides.

<a id="add-collateral"></a>

### Adding Collateral: What Is Checked

`addCollateral(loanId, amount)` pulls exactly `amount` of the loan's own collateral token from the caller into the borrower's vault, raises `collateralAmount` and the collateral lien, and emits `CollateralAdded` with the new health factor and LTV. It refuses a live swap-to-repay commit, a caller other than `ownerOf(borrowerTokenId)`, a loan that is neither Active nor FallbackPending, a rental, a paused collateral asset (`isAssetPaused`) and collateral `checkLiquidity` does not report as Liquid. It carries no `whenNotPaused`. The deposit goes to the vault of the recorded `loan.borrower`: an Active loan first consolidates a transferred position to the holder (`consolidateToHolder`), so that is the holder's vault, while a FallbackPending loan is not consolidated until it is cured, so the review names the recorded vault. The added tokens count in `collateralAmount`, which liquidation and default consume, and the review says so.

The app reads those inputs, both asset checks live rather than from the loan's opening class, and the dry run is the protocol's last word. No view returns the health factor after a top-up, so the review states `calculateHealthFactor` and `calculateLTV` now and the finish card reads the new figures from the transaction's `CollateralAdded` log. On a FallbackPending loan the top-up cures it when the new health factor reaches the loan's minimum and the LTV is within its opening cap; the finish card checks for `LoanCuredFromFallback`. A standing approval at or above the amount is left as it is, since the pull is exactly the amount; a smaller one is raised to exactly the amount and put back if the top-up does not go through.

<a id="take-back-collateral"></a>

### Taking Back Collateral: What Is Checked

`partialWithdrawCollateral(loanId, amount)` sends `amount` of the collateral from the borrower's vault to the caller's wallet, lowers `collateralAmount` and the collateral lien, and emits `PartialCollateralWithdrawn` with the new health factor and LTV. It carries `whenNotPaused` and refuses, in order: a sanctioned caller, a live swap-to-repay commit, a live refinance request (`RefinanceRequestOpen`), a linked sale listing (`SaleListingActive`), a caller other than `ownerOf(borrowerTokenId)`, a loan that is not Active, an amount above the collateral, collateral `checkLiquidity` does not report as Liquid, and a result below the loan's minimum health factor or above its opening LTV cap.

The form checks the amount against `calculateMaxWithdrawable`, which is zero for a loan that is not Active or whose collateral is illiquid, and which falls as interest accrues. No view exposes a linked sale listing, so the review runs the withdrawal as a dry run and names that refusal; the send runs it again. The finish card reads the collateral left and the new figures from the transaction's `PartialCollateralWithdrawn` log, and the amount received from the token's `Transfer` to the wallet. For a caller running protected account mode, the vault's payout gate queues the withdrawal (`PayoutQueued`) for the account's delay instead of paying it, so the review reads `getProtectedAccount` and the finish card reads that log.

<a id="collect-a-payout"></a>

### Collecting a Payout: What Is Checked

`claimAsLender(loanId)` and `claimAsBorrower(loanId)` carry `whenNotPaused` and pay from the vault of the party recorded for the side (`loan.lender` / `loan.borrower`) to the caller, who must be `ownerOf` that side's position token. The lender may claim on a Repaid, Defaulted, FallbackPending or InternalMatched loan; the borrower on Repaid, Defaulted or InternalMatched only. The lender's claim refuses an already-claimed row (`AlreadyClaimed`) before the holder check and a side with nothing open (`NothingToClaim`) after it; a row a forced close-out recorded at zero still runs and closes the position. The borrower's claim refuses only when its collateral row and its surplus row are both empty or claimed, and pays each on its own flag, with collateral still under the loan's lien in another token beside them.

The review reads `getClaimable` (the lender row already net of past sellers, with `getSellersShareOfLenderClaim` beside it), `getBorrowerSurplusClaim` and `getLoanCollateralLien`, and runs the claim as a dry run, which also applies the sanctions screens. The list follows the position token: `getUserDashboardClaimables` lists the recorded party's claims, so a listed row is kept only while the wallet holds that side, and a held position on an ended loan received from someone else has its claim read directly. The finish card reads `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed` and `LoanSettled`, and the token transfers to the wallet; for a caller in protected account mode it reads `PayoutQueued` (the account's own vault), `PayoutHeldInVault` (a locked account or a full queue) or `PaymentCreditedToVault` (another party's vault). On a FallbackPending loan the lender's claim may run a claim-time internal match that rewrites the row, so the finish card compares the transfers with the protocol's own record.

<a id="claim-everything"></a>

### Claim Everything: What Is Checked

The batch goes through `multicall(calls)`, which runs each call by `delegatecall` into the protocol itself, so `msg.sender` stays your wallet and each call checks its own rules. It takes at most 30 calls, and the app sends each with `allowFailure`, so a refused call reverts alone and the batch carries on. The calls are `claimAsLender` / `claimAsBorrower(loanId)`; `claimInteractionRewardsTo(Vault)`, which also releases a held reward, or `claimHeldInteractionRewards(Vault)` when the rewards preview cannot complete but `getRewardSanctionsStatus` reads Deliver; `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)` for each intent's `availableCapital` from `getLenderIntentsByOwner`; `withdrawVPFIFromVault(amount)` for the `freeHolding` of VPFI; and `withdrawSalary(streamId)` for each stream from `getPayrollStream` whose beneficiary is the wallet, sized by `getWithdrawableSalary`. A lender claim on a FallbackPending loan is left out, since its claim-time match decides what it pays. The review runs the batch as a dry run and reads each call's `success` and revert data, leaving out a refused call with its decoded error, and runs it again at send. The finish card reads each call's own event (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`); a call with none was skipped. Token transfers to the wallet, and `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` for protected mode, are summed per token across the collected calls. The pause (`whenNotPaused` on every call) and a flagged wallet stop the batch before signing.

<a id="payout-queue"></a>

### The Payout Queue: What Is Checked

The list is `getPendingPayoutIds(account)`, with `getPendingPayout(id)` and `requestCode(id)` per row; the code is rendered as six base32 characters by the one shared renderer the alerts use, and rows are ordered by `releaseAt` against the latest block's timestamp, not the browser clock. `releasePayout(id)` is permissionless and refused under a pause until `isEscapeOpen()`. A queued row whose recipient is neither the manager (the account, or its controller once retired) nor on `getAllowlist` is cancelled instead of paid, before the time check; otherwise the row must be due, the account unlocked (`ProtectedVaultLocked`) and, while `requireCosign` is on, co-signed (`CosignRequired`), and the recipient is screened again. `cancelPayout(id)` belongs to the manager or a signer (`NotManagerOrSigner`), works during a pause, and credits the depository ledger so the asset can be withdrawn again. `cosignPayout(id)` belongs to a signer from `getProtectedSigners` (`NotSigner`); the app offers it only while the account requires it and the row is not yet co-signed. Each action runs as a dry run in the review and again at send. The finish card reads `PayoutReleased` (the amount and the protocol's measured `delivered`), `PayoutCancelled` and `PayoutCosigned` for that id. Whether the keeper's `protectedAccount` pass releases due rows is the capability service's answer, unknown by default. A lock cancels every queued row.

<a id="seller-interest"></a>

### Interest from a Position You Sold: What Is Checked

A sale records the seller's earned and unpaid interest as a claim: `getInterestLedger(loanId)` lists the open claims, oldest first, each with its gross figure. `claimAsSeller(loanId)` carries `whenNotPaused` and the sanctions screen. On a Repaid, Defaulted, Settled or InternalMatched loan with claims open it first splits the lender's recovery (`getSellersShareOfLenderClaim`), paying each claim up to its net figure (gross less the loan's `treasuryFeeBpsAtInit` share, rounded down; the legacy 1% where the loan recorded none) and closing all of them; a FallbackPending loan does not split. It then withdraws `getSellerInterestHeld(loanId, seller, asset)` for the principal token, and for the lender claim's token where it differs, from the seller's own vault to the seller's wallet, and refuses `NothingToClaimAsSeller` when that is zero. The app lists loans from the index's activity filed under the wallet as seller (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`); the lookup by number reads the chain alone. In the principal token the review derives the wallet's part exactly from the share; in another token the split is by value and stated as decided when it runs. The withdrawal runs as a dry run in the review and again at send. The finish card reads `SellerInterestClaimClosed` (paid, credited, fully paid) and `SellerInterestWithdrawn`, with `PayoutQueued` or `PayoutHeldInVault` where protected mode queued or kept the payment.

<a id="frozen-proceeds"></a>

### Frozen Payouts: What Is Checked

The app reads `getSanctionsOracle` (zero means no screen on this chain), `sanctionsStatus(wallet)` (Clean, Flagged, or Unavailable when the screen reverts) and `isSanctionsConfirmedFlagged(wallet)`, the registry `refreshSanctionsFlag` syncs from a definitive read. Flagged, or Unavailable with the wallet registered, reads as frozen; Unavailable without registration does not. `claimAsLender` and `claimAsBorrower` screen the caller after `whenNotPaused` and let an outage through; a side whose payout the protocol froze for a recorded party is released fail-closed, reverting `SanctionedAddress` or `SanctionsOracleUnavailable` until that party reads Clean, whoever holds the position by then. The protocol keeps no view of that recorded party, so the app relies on the dry run there and states its refusal in the same words. `claimAsSeller` refuses a flagged seller, and a registered one during an outage. While a loan runs, a lender share parked for a flagged holder adds to `heldForLender` in `getClaimable(loanId, true)`, reserved in the stored lender's vault until the lender's claim pays it. Repayment stays open for a flagged borrower; adding collateral does not.

<a id="extension-reserves"></a>

### Extension Reserves: What Is Checked

`fundExtendReserve(loanId, amount)` deposits the loan's principal token from the borrower-position holder's wallet into their own vault and reserves it for that loan. It carries `whenNotPaused` and the sanctions screen, and is refused unless the loan is Active, an ERC-20 loan, with no periodic cadence. `getExtendFunding(loanId, holder)` returns the token, `reserved`, the holder's other free balance, and what an extension would charge now and at the end of the window; an extension charges only the current holder's vault, reserve first. `withdrawExtendReserve(account, loanId, amount)` carries `whenNotPaused`, requires the caller to be the account's manager (its own wallet, or its controller after a replacement), screens the caller (fail-open in an outage), and reverts `ExtendReserveInsufficient` past what is reserved; it is open whatever the loan's state. The app lists loans from the index's activity filed under the wallet (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`); the lookup by number reads the chain alone. It withdraws the whole reserve the review read, runs the call as a dry run in the review and again at send, and the finish card reads `ExtendReserveWithdrawn` (the amount, and what stays reserved), with `PayoutQueued` or `PayoutHeldInVault` where protected mode queued or kept the payment.

<a id="risk-access"></a>

### Risk Access: Your Risk Level

The gate is `getRiskAccessGateEnabled`. Which step a flow needs is the protocol's own answer: for an acceptance, `previewOfferAcceptBlock` (1 = level too low, 2 = pair consent, 3 = strict-mode acknowledgement, 4 = the illiquid pair the acceptance's acknowledgement once covered; it blocks like 2 and a pair consent clears it) once `previewCreatorBlock` shows the lender is not blocked; for a request, the `createOffer` dry run's `RiskTierTooLow`, `IlliquidPairNotConsented` or `MidTierPairNotAcknowledged`. The step reads in one block `pairRequiredRiskLevel` for the pair (`acceptMidTierAckPair` for an offer), `getVaultRiskTier`, `getEffectiveRiskTier`, `getVaultRiskTierVersion` against `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` and `getRiskTierMutationNonce`, and for a pair `isPairConsentPending` with `hasIlliquidPairConsent`, or `isMidTierAckPending` with `midTierStrictBlocked`. A raise is `setVaultRiskTierChecked(level, nonce, termsVersion)` to the least level the pair needs, so it is refused, changing nothing, if another tier write or a terms change landed after the review. A pair step is `setIlliquidPairConsent(pair, true)` or `setMidTierPairAck(pair)`. A raise still cooling down, or a pair step still pending, is not offered again. No read returns when a pending pair step takes effect, so the review says it cannot read that time; only the step's own finish card gives it, from the receipt block's time plus the cooldown. The outcome is read back at the receipt's block.

<a id="terms-gate"></a>

### The Terms Prompt

`getCurrentTos` returns the version and content hash in force on
the chain an action is scoped to; version 0 means none, and nothing
is gated. A wallet whose `hasAcceptedCurrentTerms` is false is asked
before new exposure, and the prompt links `/terms/v<N>`, the
version-pinned page whose text never changes. Accepting calls
`acceptTerms(version, hash)` once. Before the wallet opens the pair
is read again, so a newer version replaces the one shown and an
acceptance made in another tab lets the action continue. A failed
read is "cannot confirm", with a retry, never "not accepted". Exits
are never gated.
