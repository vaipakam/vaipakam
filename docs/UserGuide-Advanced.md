# Vaipakam — User Guide (Advanced Mode)

Precise, technically-accurate explanations of every card in the app.
Each section corresponds to an `(i)` info icon next to a card title.
In **Advanced** mode, the "Learn more →" link on every tooltip lands
here. Basic mode points at the friendlier guide instead.

The headings below match the in-app card titles. The hidden HTML anchor
under each one matches the card's id, so the app can deep-link to the
exact paragraph. Cross-references to `README.md`,
`TokenomicsTechSpec.md`, `CLAUDE.md`, and the contracts are inline
where useful.

A note on language: the **Offer Book** lender / borrower lists and
the **Create Offer** flow describe situations where lender and
borrower do different things on the same screen, so those sections
name the role explicitly to avoid confusion. Other sections speak
directly to the reader.

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### Your Escrow

A per-user UUPS-upgradeable proxy (`VaipakamEscrowImplementation`
behind an `ERC1967Proxy`) deployed for you the first time you
participate in a loan. One escrow per address per chain. Holds
ERC-20, ERC-721, and ERC-1155 balances tied to your loan positions.
There is no commingling — other users' assets are never in this
contract.

The escrow proxy is the canonical place collateral, lent assets, and
locked VPFI sit. The Diamond authenticates against it on every
deposit/withdraw; the implementation is upgradeable through the
protocol owner with a timelock.

<a id="dashboard.your-loans"></a>

### Your Loans

Every loan involving the connected wallet on this chain — whether
you sit on the lender side, the borrower side, or both across
distinct positions. Computed live from the Diamond's `LoanFacet`
view selectors against your address. Each row deep-links to the
full position page with HF, LTV, accrued interest, the action
surface gated by your role + the loan's status, and the on-chain
`loanId` you can paste into a block explorer.

<a id="dashboard.vpfi-panel"></a>

### VPFI on this chain

Live VPFI accounting for the connected wallet on the active chain:

- Wallet balance (read from the ERC-20).
- Escrow balance (read from the per-user escrow proxy).
- Your share of circulating supply (after subtracting protocol-held
  balances).
- Remaining mintable cap.

Vaipakam ships VPFI cross-chain over LayerZero V2. **Base is the
canonical chain** — `VPFIOFTAdapter` runs the lock/release
semantics there. Every other supported chain runs `VPFIMirror`, a
pure OFT that mints on inbound packets and burns on outbound. Total
supply across all chains is invariant under bridging by
construction.

DVN policy is **3 required + 2 optional, threshold 1-of-2** post the
April 2026 hardening (see `CLAUDE.md` "Cross-Chain Security
Policy"). Default 1/1 DVN config is rejected at deploy gate.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

Wallet-level opt-in flag (`VPFIDiscountFacet.toggleVPFIDiscountConsent`)
that lets the protocol settle the discounted portion of a fee in
VPFI debited from your escrow at terminal events. Default: off. Off
means you pay 100% of every fee in the principal asset; on means
the time-weighted discount applies.

Tier ladder (`VPFI_TIER_TABLE`):

| Tier | Min escrow VPFI | Discount |
| ---- | --------------- | -------- |
| 1    | ≥ 100           | 10%      |
| 2    | ≥ 1,000         | 15%      |
| 3    | ≥ 5,000         | 20%      |
| 4    | > 20,000        | 24%      |

Tier is computed against the **post-mutation** escrow balance via
`LibVPFIDiscount.rollupUserDiscount`, then time-weighted across each
loan's lifetime. An unstake re-stamps the BPS at the new lower
balance immediately for every open loan you're on (closes the
gaming vector where pre-Phase-5 code stamped at pre-mutation
balance).

Discount applies on the lender yield-fee at settlement and on the
borrower Loan Initiation Fee (paid out as a VPFI rebate alongside
`claimAsBorrower`). See `TokenomicsTechSpec.md` §5.2b and §6.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Client-side filters over the lender / borrower offer lists. Filter
on asset address, side, status, and a few other axes. Filters do
not affect "Your Active Offers" — that list is always shown in
full.

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Open offers (status = Active, expiry not yet reached) where
`creator == your address`. Cancellable any time before acceptance
via `OfferFacet.cancelOffer(offerId)`. Acceptance flips offer
status to `Accepted` and triggers `LoanFacet.initiateLoan`, which
mints the two position NFTs (one each for lender and borrower) and
opens the loan in `Active` state.

<a id="offer-book.lender-offers"></a>

### Lender Offers

Active offers where the creator is willing to lend. Acceptance is
performed by a borrower; routes through `OfferFacet.acceptOffer`
→ `LoanFacet.initiateLoan`. Hard gate at the Diamond:
`MIN_HEALTH_FACTOR = 1.5e18` enforced at initiation against the
borrower's collateral basket using `RiskFacet`'s LTV/HF math. The
1% treasury cut on interest (`TREASURY_FEE_BPS = 100`) is debited
at terminal settlement, not up-front.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

Active offers from borrowers who have already locked their
collateral in escrow. Acceptance is performed by a lender; funds
the loan with the principal asset and mints the position NFTs.
Same HF ≥ 1.5 gate at initiation. The fixed APR is set on the
offer at creation and immutable through the loan's lifetime —
refinance creates a fresh loan.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

Selects which side of the offer the creator is on:

- **Lender** — `OfferFacet.createLenderOffer`. The lender supplies
  the principal asset and a collateral spec the borrower must
  meet.
- **Borrower** — `OfferFacet.createBorrowerOffer`. The borrower
  locks the collateral up front; a lender accepts and funds.
- **Rental** sub-type — for ERC-4907 (rentable ERC-721) and
  rentable ERC-1155 NFTs. Routes through the rental flow rather
  than a debt loan; the renter pre-pays
  `duration × dailyFee × (1 + RENTAL_BUFFER_BPS / 1e4)` where
  `RENTAL_BUFFER_BPS = 500`.

<a id="create-offer.lending-asset"></a>

### Lending Asset

Specifies `(asset, amount, aprBps, durationDays)` for a debt offer:

- `asset` — ERC-20 contract address.
- `amount` — principal, denominated in the asset's native decimals.
- `aprBps` — fixed APR in basis points (1/10,000). Snapshot at
  acceptance; not reactive.
- `durationDays` — sets the grace window before
  `DefaultedFacet.markDefaulted` is callable.

Accrued interest is computed continuously per second from
`loan.startTimestamp` until terminal settlement.

<a id="create-offer.lending-asset:lender"></a>

#### If you're the lender

The principal asset and amount that you are willing to offer, plus
the interest rate (APR in %) and duration in days. Rate is fixed
at offer time; duration sets the grace window before the loan can
default. Routes through `OfferFacet.createLenderOffer`; on
acceptance, the principal moves from your escrow into the
borrower's escrow as part of `LoanFacet.initiateLoan`.

<a id="create-offer.lending-asset:borrower"></a>

#### If you're the borrower

The principal asset and amount that you want from the lender,
plus the interest rate (APR in %) and duration in days. Rate is
fixed at offer time; duration sets the grace window before the
loan can default. Routes through `OfferFacet.createBorrowerOffer`;
your collateral is locked in your escrow at offer-creation time
and remains locked until a lender accepts and the loan opens
(or you cancel).

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields. Specifies the NFT contract + token id (and
quantity for ERC-1155), plus `dailyFeeAmount` in the principal
asset. On acceptance, `OfferFacet` debits
`duration × dailyFeeAmount × (1 + 500 / 10_000)` from the renter's
escrow into custody; the NFT itself moves into a delegated state
via ERC-4907's `setUser` (or the equivalent ERC-1155 hook) so the
renter has rights but cannot transfer the NFT itself.

<a id="create-offer.collateral"></a>

### Collateral

Collateral asset spec on the offer. Two liquidity classes:

- **Liquid** — Chainlink price feed registered + ≥ 1 of the 3
  V3-clone factories (Uniswap, PancakeSwap, SushiSwap) returns a
  pool with ≥ $1M depth at the current tick (3-V3-clone OR-logic,
  Phase 7b.1). LTV/HF math applies; HF-based liquidation routes
  through `RiskFacet → LibSwap` (4-DEX failover: 0x → 1inch →
  Uniswap V3 → Balancer V2).
- **Illiquid** — anything that fails the above. Valued at $0
  on-chain. No HF math. On default, full collateral transfer to
  the lender. Both lender and borrower must
  `acceptIlliquidCollateralRisk` at offer creation / acceptance for
  the offer to land.

Secondary price-oracle quorum (Phase 7b.2): Tellor + API3 + DIA,
soft 2-of-N decision rule. Pyth removed.

<a id="create-offer.collateral:lender"></a>

#### If you're the lender

How much you want the borrower to lock to secure the loan. Liquid
ERC-20s (Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math;
illiquid ERC-20s and NFTs have no on-chain valuation and require
both parties to consent to a full-collateral-on-default outcome.
The HF ≥ 1.5e18 gate at `LoanFacet.initiateLoan` is computed
against the collateral basket the borrower presents at acceptance —
sizing the requirement here directly sets the borrower's HF
headroom.

<a id="create-offer.collateral:borrower"></a>

#### If you're the borrower

How much you are willing to lock to secure the loan. Liquid ERC-20s
(Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math; illiquid
ERC-20s and NFTs have no on-chain valuation and require both
parties to consent to a full-collateral-on-default outcome. Your
collateral is locked in your escrow at offer-creation time on a
borrower offer; for a lender offer, your collateral is locked at
offer-acceptance time. Either way, the HF ≥ 1.5e18 gate at
`LoanFacet.initiateLoan` must clear with the basket you present.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Acknowledgement gate before submitting. The same risk surface
applies to both sides; the role-specific tabs below explain how
each one bites differently depending on which side of the offer
you sign. Vaipakam is non-custodial; there is no admin key that
can reverse a landed transaction. Pause levers exist on LZ-facing
contracts only, gated to the timelock; they cannot move assets.

<a id="create-offer.risk-disclosures:lender"></a>

#### If you're the lender

- **Smart-contract risk** — immutable code at runtime; audit but
  not formally verified.
- **Oracle risk** — Chainlink staleness or V3 pool depth
  divergence can delay a HF-based liquidation past the point where
  the collateral covers the principal. The secondary quorum
  (Tellor + API3 + DIA, Soft 2-of-N) catches gross drift but
  small skew can still erode recovery.
- **Liquidation slippage** — `LibSwap`'s 4-DEX failover (0x →
  1inch → Uniswap V3 → Balancer V2) routes to the best execution
  it can find, but cannot guarantee a specific price. Recovery is
  net of slippage and the 1% treasury cut on interest.
- **Illiquid-collateral defaults** — collateral transfers to you
  in full at `markDefaulted` time. No recourse if the asset is
  worth less than `principal + accruedInterest()`.

<a id="create-offer.risk-disclosures:borrower"></a>

#### If you're the borrower

- **Smart-contract risk** — immutable code at runtime; bugs
  affect locked collateral.
- **Oracle risk** — staleness or manipulation can trigger
  HF-based liquidation against you when the real-market price
  would have stayed safe. The HF formula is reactive to oracle
  output; a single bad tick crossing 1.0 is enough.
- **Liquidation slippage** — when `RiskFacet → LibSwap` fires,
  the swap can sell your collateral at slippage-eaten prices. The
  swap is permissionless — anyone can trigger it the instant
  HF < 1e18.
- **Illiquid-collateral defaults** — `markDefaulted` transfers
  your full collateral to the lender. No leftover claim — only
  any unused VPFI LIF rebate via `claimAsBorrower`.

<a id="create-offer.advanced-options"></a>

### Advanced Options

Less-common knobs:

- `expiryTimestamp` — offer self-cancels after this. Default ~7
  days.
- `useFeeDiscountForThisOffer` — local override of the wallet-
  level consent for this specific offer.
- Role-specific options the OfferFacet exposes per side.

Defaults are sensible for most users.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims are pull-style by design — terminal events leave funds in
Diamond / escrow custody and the holder of the position NFT calls
`claimAsLender` / `claimAsBorrower` to move them. Both kinds of
claim can sit in the same wallet at the same time. The role-
specific tabs below describe each.

Each claim burns the holder's position NFT atomically. The NFT
_is_ the bearer instrument — transferring it before claiming
hands the new holder the right to collect.

<a id="claim-center.claims:lender"></a>

#### If you're the lender

`ClaimFacet.claimAsLender(loanId)` returns:

- `principal` back into your wallet on this chain.
- `accruedInterest(loan)` minus the 1% treasury cut
  (`TREASURY_FEE_BPS = 100`) — the cut is itself reduced by your
  time-weighted VPFI fee discount accumulator (Phase 5) when
  consent is on.

Claimable as soon as the loan reaches a terminal state (Settled,
Defaulted, or Liquidated). The lender position NFT is burned in
the same transaction.

<a id="claim-center.claims:borrower"></a>

#### If you're the borrower

`ClaimFacet.claimAsBorrower(loanId)` returns, depending on how
the loan settled:

- **Full repayment / preclose / refinance** — your collateral
  basket back, plus the time-weighted VPFI rebate from the LIF
  (`s.borrowerLifRebate[loanId].rebateAmount`).
- **HF-liquidation or default** — only the unused VPFI LIF
  rebate (which on these terminal paths is zero unless explicitly
  preserved). Collateral has already moved to the lender.

The borrower position NFT is burned in the same transaction.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

On-chain events involving your wallet on the active chain, sourced
live from Diamond logs (`getLogs` over a sliding block window). No
backend cache — every load re-fetches. Events are grouped by
`transactionHash` so multi-event txns (e.g. accept + initiate)
stay together. Newest first. Surfaces offers, loans, repayments,
claims, liquidations, NFT mints/burns, and VPFI buys / stakes /
unstakes.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### Buying VPFI

Two paths:

- **Canonical (Base)** — direct call to
  `VPFIBuyFacet.buyVPFIWithETH` on the Diamond. Mints VPFI
  directly to your wallet on Base.
- **Off-canonical** — `VPFIBuyAdapter.buy()` on the local chain
  sends a LayerZero packet to `VPFIBuyReceiver` on Base, which
  calls the Diamond and OFT-sends the result back. End-to-end
  latency ~1 min on L2-to-L2 pairs. VPFI lands in your wallet on
  the **origin** chain.

Adapter rate limits (post-hardening): 50k VPFI per request, 500k
rolling 24h. Tunable via `setRateLimits` (timelock).

<a id="buy-vpfi.discount-status"></a>

### Your VPFI Discount Status

Live status:

- Current tier (0..4, from
  `VPFIDiscountFacet.getVPFIDiscountTier`).
- Escrow VPFI balance + delta to next tier.
- Discount BPS at the current tier.
- Wallet-level consent flag.

Note that escrow VPFI also accrues 5% APR via the staking pool —
there's no separate "stake" action; depositing into escrow is
staking.

<a id="buy-vpfi.buy"></a>

### Step 1 — Buy VPFI with ETH

Submits the buy. On canonical chains, the Diamond mints directly.
On mirror chains, the buy adapter takes payment, sends a LZ
message, and the receiver executes the buy on Base + OFT-sends
VPFI back. Bridge fee + DVN cost is quoted live by
`useVPFIBuyBridge.quote()` and shown in the form. VPFI does not
auto-deposit to escrow — Step 2 is explicit.

<a id="buy-vpfi.deposit"></a>

### Step 2 — Deposit VPFI into your escrow

`Diamond.depositVPFIToEscrow(amount)`. Required on every chain —
even canonical — because escrow deposit is always an explicit user
action per spec. On chains with Permit2 (Phase 8b), the app
prefers the single-signature path
(`depositVPFIToEscrowWithPermit2`) over approve + deposit. Falls
back gracefully if Permit2 isn't configured on that chain.

<a id="buy-vpfi.unstake"></a>

### Step 3 — Unstake VPFI from your escrow

`Diamond.withdrawVPFIFromEscrow(amount)`. No approval leg — the
Diamond owns the escrow proxy and debits itself. The withdraw
call triggers `LibVPFIDiscount.rollupUserDiscount(user,
postBalance)` so every open loan's BPS accumulator re-stamps at
the new (lower) balance immediately. There is no grace window
where the old tier still applies.

---

## Rewards

<a id="rewards.overview"></a>

### About Rewards

Two streams:

- **Staking pool** — escrow-held VPFI accrues at 5% APR
  continuously. Per-second compounding via
  `RewardFacet.pendingStaking`.
- **Interaction pool** — per-day pro-rata share of a fixed daily
  emission, weighted by your settled-interest contribution to
  that day's loan-volume. Daily windows finalise lazily on first
  claim after window close.

Both rewards are minted directly on the active chain (no LZ
round-trip for the user; cross-chain reward aggregation happens
on `VaipakamRewardOApp` between protocol contracts only).

<a id="rewards.claim"></a>

### Claim Rewards

`RewardFacet.claimRewards()` — single tx, claims both streams.
Staking is always available; interaction is `0n` until the
relevant daily window finalises (lazy finalisation triggered by
the next non-zero claim or settlement on that chain). The UI
guards the button when `interactionWaitingForFinalization` so
users don't under-claim.

<a id="rewards.withdraw-staked"></a>

### Withdraw Staked VPFI

Identical surface to "Step 3 — Unstake" on the Buy VPFI page —
`withdrawVPFIFromEscrow`. Withdrawn VPFI exits the staking pool
immediately (rewards stop accruing for that amount that block)
and exits the discount accumulator immediately (post-balance
re-stamp on every open loan).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (this page)

Single-loan view derived from `LoanFacet.getLoanDetails(loanId)`
plus live HF/LTV from `RiskFacet.calculateHealthFactor`. Renders
terms, collateral risk, parties, the action surface gated by
`getLoanActionAvailability(loan, viewerAddress)`, and inline
keeper status from `useKeeperStatus`.

<a id="loan-details.terms"></a>

### Loan Terms

Immutable parts of the loan:

- `principal` (asset + amount).
- `aprBps` (fixed at offer creation).
- `durationDays`.
- `startTimestamp`, `endTimestamp` (= `startTimestamp +
durationDays * 1 days`).
- `accruedInterest()` — view function, computes from `now -
startTimestamp`.

Refinance creates a fresh `loanId` rather than mutating these.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math via `RiskFacet`. **Health Factor** is
`(collateralUsdValue × liquidationThresholdBps / 1e4) /
debtUsdValue`, scaled to 1e18. HF < 1e18 triggers HF-based
liquidation. **LTV** is `debtUsdValue / collateralUsdValue`.
Liquidation threshold = the LTV at which the position becomes
liquidatable; depends on the volatility class of the collateral
basket (`VOLATILITY_LTV_THRESHOLD_BPS = 11000` for the
high-volatility collapse case).

Illiquid collateral has `usdValue == 0` on-chain; HF/LTV collapse
to n/a and the only terminal path is full transfer on default —
both parties consented at offer creation via the illiquid-risk
acknowledgement.

<a id="loan-details.collateral-risk:lender"></a>

#### If you're the lender

The collateral basket securing this loan is your protection.
HF > 1e18 means the position is over-collateralised vs the
liquidation threshold. As HF drifts toward 1e18, your protection
thins; once HF < 1e18, anyone (you included) can call
`RiskFacet.triggerLiquidation(loanId)` and `LibSwap` will route
the collateral via the 4-DEX failover for your principal asset.
Recovery is net of slippage.

For illiquid collateral, on default the basket transfers to you
in full at `markDefaulted` time — what it's actually worth is
your problem.

<a id="loan-details.collateral-risk:borrower"></a>

#### If you're the borrower

Your locked collateral. Keep HF safely above 1e18 — common buffer
target is ≥ 1.5e18 to ride out volatility. Levers to bring HF up:

- `addCollateral(loanId, …)` — top up the basket; user-only.
- Partial repay via `RepayFacet` — reduces debt, raises HF.

Once HF < 1e18, anyone can trigger HF-based liquidation; the
swap sells your collateral at slippage-eaten prices to repay the
lender. On illiquid collateral, default transfers your full
collateral to the lender — only any unused VPFI LIF rebate
(`s.borrowerLifRebate[loanId].rebateAmount`) is left to claim.

<a id="loan-details.parties"></a>

### Parties

`(lender, borrower, lenderEscrow, borrowerEscrow,
positionNftLender, positionNftBorrower)`. Each NFT is an ERC-721
with on-chain metadata; transferring it transfers the right to
claim. The escrow proxies are deterministic per address (CREATE2)
— same address across deploys.

<a id="loan-details.actions"></a>

### Actions

Action surface, gated per role by `getLoanActionAvailability`.
The role-specific tabs below list each side's available
selectors. Disabled actions surface a hover-reason derived from
the gate (`InsufficientHF`, `NotYetExpired`, `LoanLocked`, etc.).

Permissionless actions available to anyone regardless of role:

- `RiskFacet.triggerLiquidation(loanId)` — when HF < 1e18.
- `DefaultedFacet.markDefaulted(loanId)` — when the grace period
  has expired without full repayment.

<a id="loan-details.actions:lender"></a>

#### If you're the lender

- `ClaimFacet.claimAsLender(loanId)` — terminal-only. Returns
  principal + interest minus the 1% treasury cut (further
  reduced by your time-weighted VPFI yield-fee discount when
  consent is on). Burns the lender position NFT.
- `EarlyWithdrawalFacet.initEarlyWithdrawal(loanId, askPrice)` —
  list the lender NFT for sale at `askPrice`. A buyer calling
  `completeEarlyWithdrawal(saleId)` takes over your side; you
  receive the proceeds. Cancellable before fill.
- Optionally delegatable to a keeper holding the relevant action
  bit (`COMPLETE_LOAN_SALE`, etc.) — see Keeper Settings.

<a id="loan-details.actions:borrower"></a>

#### If you're the borrower

- `RepayFacet.repay(loanId, amount)` — full or partial. Partial
  reduces outstanding and raises HF; full triggers terminal
  settlement, including the time-weighted VPFI LIF rebate via
  `LibVPFIDiscount.settleBorrowerLifProper`.
- `PrecloseFacet.precloseDirect(loanId)` — pay outstanding from
  your wallet now, release collateral, settle LIF rebate.
- `PrecloseFacet.initOffset(loanId, swapParams)` /
  `completeOffset(loanId)` — sell some collateral via `LibSwap`,
  repay from proceeds, return remainder.
- `RefinanceFacet` flow — post a borrower offer for new terms;
  `completeRefinance(oldLoanId, newOfferId)` swaps loans
  atomically with collateral never leaving escrow.
- `ClaimFacet.claimAsBorrower(loanId)` — terminal-only. Returns
  collateral on full repayment, or the unused VPFI LIF rebate
  on default / liquidation. Burns the borrower position NFT.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Lists every ERC-20 `allowance(wallet, diamondAddress)` your
wallet has granted the Diamond on this chain. Sourced by scanning
a candidate-token list against `IERC20.allowance` view calls.
Revoke sets allowance to zero via `IERC20.approve(diamond, 0)`.
Per the exact-amount approval policy, the protocol never asks for
unlimited allowances, so revocations are usually small in count.

Note: Permit2-style flows (Phase 8b) bypass the per-asset
allowance on the Diamond by using a single signature instead, so
a clean list here does not preclude future deposits.

---

## Alerts

<a id="alerts.overview"></a>

### About Alerts

Off-chain Cloudflare worker (`hf-watcher`) polls every active
loan involving your wallet at 5-minute cadence. Reads
`RiskFacet.calculateHealthFactor` for each. On a band crossing in
the unsafe direction, fires once via the configured channels. No
on-chain state, no gas. Alerts are advisory — they don't move
funds.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

User-configured ladder of HF bands. Crossing into a more-
dangerous band fires once and arms the next deeper threshold.
Crossing back above a band rearms it. Defaults: `1.5 → 1.3 →
1.1`. Higher numbers are appropriate for volatile collateral; the
ladder's only job is to get you out before HF < 1e18 triggers
liquidation.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

Two rails:

- **Telegram** — bot DM with the wallet's short address + loan
  id + current HF.
- **Push Protocol** — wallet-direct notification via the
  Vaipakam Push channel.

Both share the threshold ladder; per-channel warn-levels are
intentionally not exposed (avoids drift). Push channel publishing
is stubbed pending channel creation — see Phase 8a notes.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### Verify an NFT

Given `(nftAddress, tokenId)`, fetches:

- `IERC721.ownerOf(tokenId)` (or burn-selector `0x7e273289` =>
  already burned).
- `IERC721.tokenURI(tokenId)` → on-chain JSON metadata.
- Diamond cross-check: derives the underlying `loanId` from
  metadata and reads `LoanFacet.getLoanDetails(loanId)` to
  confirm state.

Surfaces: minted-by-Vaipakam? which chain? loan status? current
holder? Lets you spot a counterfeit, an already-claimed (burned)
position, or a position whose loan has settled and is mid-claim.

The position NFT is the bearer instrument — verify before buying
on a secondary market.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### About Keepers

Per-wallet keeper whitelist (`KeeperSettingsFacet`) of up to 5
keepers (`MAX_KEEPERS = 5`). Each keeper has an action bitmask
(`KEEPER_ACTION_*`) authorising specific maintenance calls on
**your side** of a loan. Money-out paths (repay, claim,
addCollateral, liquidate) are user-only by design and cannot be
delegated.

Two additional gates apply at action time:

1. Master keeper-access switch (one-flip emergency brake;
   disables every keeper without touching the allowlist).
2. Per-loan opt-in toggle (set on Offer Book / Loan Details).

A keeper can act only when `(approved, masterOn, perLoanOn,
actionBitSet)` are all true.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

Bitmask flags currently exposed:

- `COMPLETE_LOAN_SALE` (0x01)
- `COMPLETE_OFFSET` (0x02)
- `INIT_EARLY_WITHDRAW` (0x04)
- `INIT_PRECLOSE` (0x08)
- `REFINANCE` (0x10)

Bits added on-chain without the frontend reflecting them get an
`InvalidKeeperActions` revert. Revocation is
`KeeperSettingsFacet.removeKeeper(addr)` and is instantaneous on
all loans.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### About Public Analytics

Wallet-free aggregator computed live from on-chain Diamond view
calls across every supported chain. No backend / database. Hooks
involved: `useProtocolStats`, `useTVL`, `useTreasuryMetrics`,
`useUserStats`, `useVPFIToken`. CSV / JSON export available; the
Diamond address + view function for every metric is shown for
verifiability.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

Cross-chain rollup. The header reports `chainsCovered` and
`chainsErrored` so an unreachable RPC at fetch time is explicit.
`chainsErrored > 0` means the per-chain table flags which one —
TVL totals are still reported but acknowledge the gap.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Per-chain split of the combined metrics. Useful for spotting TVL
concentration, mismatched VPFI mirror supplies (sum should equal
the canonical adapter's lock balance), or stalled chains.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

On-chain VPFI accounting on the active chain:

- `totalSupply()` — ERC-20 native.
- Circulating supply — `totalSupply()` minus protocol-held
  balances (treasury, reward pools, in-flight LZ packets).
- Remaining mintable cap — derived from `MAX_SUPPLY -
totalSupply()` on canonical; mirror chains report `n/a` for
  cap (mints there are bridge-driven).

Cross-chain invariant: sum of `VPFIMirror.totalSupply()` across
all mirror chains == `VPFIOFTAdapter.lockedBalance()` on
canonical. Watcher monitors and alerts on drift.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

For every metric, lists:

- The block number used as the snapshot.
- Data freshness (max staleness across chains).
- The Diamond address and view function call.

Anyone can re-derive any number on this page from `(rpcUrl,
blockNumber, diamondAddress, fnName)` — that's the bar.

---

## Refinance

This page is borrower-only — refinance is initiated by the
borrower on the borrower's loan.

<a id="refinance.overview"></a>

### About Refinancing

`RefinanceFacet` — atomically pays off your existing loan from
new principal and opens a fresh loan with the new terms, all in
one tx. Collateral stays in your escrow throughout — no
unsecured window. New loan must clear `MIN_HEALTH_FACTOR =
1.5e18` at initiation just like any other loan.

`LibVPFIDiscount.settleBorrowerLifProper(oldLoan)` is called on
the old loan as part of the swap, so any unused LIF VPFI rebate
is credited correctly.

<a id="refinance.position-summary"></a>

### Your Current Position

Snapshot of the loan being refinanced — `loan.principal`,
current `accruedInterest()`, HF/LTV, collateral basket. The new
offer should size at least the outstanding (`principal +
accruedInterest()`); any excess on the new offer is delivered to
your escrow as free principal.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — Post the New Offer

Posts a borrower offer via `OfferFacet.createBorrowerOffer` with
your target terms. The old loan continues accruing interest;
collateral remains locked. The offer appears in the public Offer
Book and any lender can accept it. You can cancel before
acceptance.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

`RefinanceFacet.completeRefinance(oldLoanId, newOfferId)` —
atomic:

1. Funds new loan from accepting lender.
2. Repays old loan in full (principal + interest, less treasury
   cut).
3. Burns old position NFTs.
4. Mints new position NFTs.
5. Settles old loan's LIF rebate via
   `LibVPFIDiscount.settleBorrowerLifProper`.

Reverts on HF < 1.5e18 on the new terms.

---

## Preclose

This page is borrower-only — preclose is initiated by the
borrower on the borrower's loan.

<a id="preclose.overview"></a>

### About Preclose

`PrecloseFacet` — borrower-driven early termination. Two paths:

- **Direct** — `precloseDirect(loanId)`. Pays
  `principal + accruedInterest()` from your wallet, releases
  collateral. Invokes
  `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
- **Offset** — `initOffset(loanId, swapParams)` then
  `completeOffset(loanId)`. Sells part of collateral via
  `LibSwap` (4-DEX failover) for the principal asset, repays
  from proceeds, remainder of collateral returns to you. Same
  LIF rebate settlement.

No flat early-close penalty. Phase 5 time-weighted VPFI math
handles the fairness math.

<a id="preclose.position-summary"></a>

### Your Current Position

Snapshot of the loan being preclosed — outstanding principal,
accrued interest, current HF/LTV. The preclose flow does **not**
require HF ≥ 1.5e18 on exit (it's a closure, not a re-init).

<a id="preclose.in-progress"></a>

### Offset In Progress

State: `initOffset` landed, swap is mid-execution (or quote
consumed but final settle pending). Two exits:

- `completeOffset(loanId)` — settles the loan from realized
  proceeds, returns remainder.
- `cancelOffset(loanId)` — aborts; collateral stays locked, loan
  unchanged. Use when the swap moved against you between init
  and complete.

<a id="preclose.choose-path"></a>

### Choose a Path

Direct path consumes wallet liquidity in the principal asset.
Offset path consumes collateral via DEX swap; preferred when you
don't have the principal asset on hand or you want to exit the
collateral position too. Offset slippage routes through
`LibSwap`'s 4-DEX failover (0x → 1inch → Uniswap V3 → Balancer
V2).

---

## Early Withdrawal (Lender)

This page is lender-only — early withdrawal is initiated by the
lender on the lender's loan.

<a id="early-withdrawal.overview"></a>

### About Lender Early Exit

`EarlyWithdrawalFacet` — secondary-market mechanism for lender
positions. You list your position NFT for sale at a chosen
price; on acceptance, buyer pays, ownership of the lender NFT
transfers to buyer, and the buyer becomes the lender of record
for all future settlement (claim at terminal, etc.). You walk
away with sale proceeds.

Liquidations remain user-only and are NOT delegated through the
sale — only the right to claim transfers.

<a id="early-withdrawal.position-summary"></a>

### Your Current Position

Snapshot — outstanding principal, accrued interest, time
remaining, current HF/LTV of the borrower side. These set the
fair price the buyer market expects: the buyer's payoff is
`principal + interest` at terminal, less liquidation risk over
remaining time.

<a id="early-withdrawal.initiate-sale"></a>

### Initiate the Sale

`initEarlyWithdrawal(loanId, askPrice)`. Lists the position NFT
for sale via the protocol; `completeEarlyWithdrawal(saleId)` is
what a buyer calls to accept. Cancellable before fill via
`cancelEarlyWithdrawal(saleId)`. Optionally delegatable to a
keeper holding the `COMPLETE_LOAN_SALE` action bit; init itself
stays user-only.
