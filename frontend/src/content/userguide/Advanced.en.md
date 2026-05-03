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

<a id="dashboard.your-escrow"></a>

### Your Escrow

An upgradeable per-user contract — your private vault on this chain
— created for you the first time you take part in a loan. One
escrow per address per chain. Holds the ERC-20, ERC-721, and ERC-1155
balances tied to your loan positions. There is no commingling: other
users' assets are never in this contract.

The escrow is the only place collateral, lent assets, and your
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
- Escrow balance.
- Your share of circulating supply (after subtracting protocol-held
  balances).
- Remaining mintable cap.

Vaipakam ships VPFI cross-chain over LayerZero V2. **Base is the
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
discounted portion of a fee in VPFI debited from your escrow at
terminal events. Default: off. Off means you pay 100% of every
fee in the principal asset; on means the time-weighted discount
applies.

Tier ladder:

| Tier | Min escrow VPFI                  | Discount                          |
| ---- | -------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`         | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`         | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`         | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`         | `{liveValue:tier4DiscountBps}`%   |

Tier is computed against your **post-change** escrow balance the
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
  APR on your escrow balance, plus every staking reward
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
collateral in escrow. Acceptance is performed by a lender; this
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
escrow into the borrower's escrow as part of loan initiation.

<a id="create-offer.lending-asset:borrower"></a>

#### If you're the borrower

The principal asset and amount that you want from the lender,
plus the interest rate (APR in %) and duration in days. Rate is
fixed at offer time; duration sets the grace window before the
loan can default. Your collateral is locked in your escrow at
offer-creation time and remains locked until a lender accepts
and the loan opens (or you cancel).

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields. Specifies the NFT contract and token id
(and quantity for ERC-1155), plus the daily rental fee in the
principal asset. On acceptance, the protocol debits the prepaid
rental from the renter's escrow into custody — that's
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
outcome. Your collateral is locked in your escrow at
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
  LayerZero packet to the canonical receiver on Base, which
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
- Escrow VPFI balance plus the gap to the next tier.
- Discount percentage at the current tier.
- Wallet-level consent flag.

Note that escrow VPFI also accrues 5% APR via the staking
pool — there is no separate "stake" action. Depositing VPFI
into your escrow IS staking.

<a id="buy-vpfi.buy"></a>

### Step 1 — Buy VPFI with ETH

Submits the buy. On the canonical chain, the protocol mints
directly. On mirror chains, the buy adapter takes payment,
sends a cross-chain message, and the receiver executes the buy
on Base and bridges VPFI back. The bridge fee plus
verifier-network cost is quoted live and shown in the form.
VPFI does not auto-deposit into your escrow — Step 2 is an
explicit user action by design.

<a id="buy-vpfi.deposit"></a>

### Step 2 — Deposit VPFI into your escrow

A separate explicit deposit step from your wallet to your
escrow on the same chain. Required on every chain — even the
canonical one — because escrow deposit is always an explicit
user action per spec. On chains where Permit2 is configured,
the app prefers the single-signature path over the classic
approve + deposit pattern; it falls back gracefully if Permit2
isn't configured on that chain.

<a id="buy-vpfi.unstake"></a>

### Step 3 — Unstake VPFI from your escrow

Withdraw VPFI from your escrow back to your wallet. There is
no separate approval leg — the protocol owns the escrow and
debits itself. The withdraw triggers an immediate fee-discount
rate re-stamp at the new (lower) balance, applied to every
open loan you're on. There is no grace window where the old
tier still applies.

---

## Rewards

<a id="rewards.overview"></a>

### About Rewards

Two streams:

- **Staking pool** — escrow-held VPFI accrues at 5% APR
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
withdraw VPFI from escrow back to your wallet. Withdrawn VPFI
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

Lender, borrower, lender escrow, borrower escrow, and the two
position NFTs (one for each side). Each NFT is an ERC-721
with on-chain metadata; transferring it transfers the right to
claim. The escrow contracts are deterministic per address —
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
- **Preclose direct** — pay the outstanding amount from your
  wallet now, release collateral, settle the rebate.
- **Preclose offset** — sell some collateral via the protocol's
  swap router, repay from proceeds, and return the remainder.
  Two-step: initiate, then complete.
- **Refinance** — post a borrower offer for new terms; once a
  lender accepts, complete refinance swaps the loans
  atomically with the collateral never leaving your escrow.
- **Claim as borrower** — terminal-only. Returns collateral on
  full repayment, or the unused VPFI Loan Initiation Fee
  rebate on default / liquidation. Burns the borrower position
  NFT.

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
one transaction. Collateral stays in your escrow throughout —
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
is delivered to your escrow as free principal.

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
bottom — declaring an incorrect source can lock your escrow
under the protocol's sanctions policy.

<a id="stuck-recovery.what"></a>

### What "stuck token" means

Your per-user escrow proxy is internal protocol storage. It
is NOT a deposit address. Every protocol-supported deposit
flows through Vaipakam's facet entry points, which pull
funds from your wallet to your escrow as part of an offer
creation, loan acceptance, or stake operation. Tokens that
arrive at the escrow OUTSIDE that flow — a direct
`IERC20.transfer` from a wallet or a CEX withdrawal that
copy-pasted your escrow address — sit there without
protocol bookkeeping. The Asset Viewer hides them by
showing only the protocol-tracked balance.

Two ways tokens get stuck:

1. **You sent them yourself.** You copied your escrow address
   (from the Dashboard or a block explorer) into a CEX
   withdrawal field or a wallet's send-tokens form, and
   submitted. The tokens landed in your escrow without going
   through the protocol's deposit path.

2. **A third party sent them ("dust attack").** Someone
   transferred a small amount to your escrow from a flagged
   wallet, hoping to associate your address with their
   reputation. This is a real attack vector against
   high-profile addresses on permissionless chains.

<a id="stuck-recovery.taint-poisoning"></a>

### About "taint poisoning"

If the third-party sender is on a sanctions list, generic
on-chain analytics tools may flag your escrow as
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
escrow gets locked under the protocol's sanctions policy
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
- **Source flagged** → tokens stay in escrow, your escrow
  gets locked under the protocol's sanctions policy. The
  lock auto-lifts if the address is later removed from the
  sanctions oracle.

<a id="stuck-recovery.disown"></a>

### Disowning unsolicited tokens (compliance audit trail)

If you want a public on-chain record asserting that some
token balance in your escrow is NOT yours, the protocol
provides a `disown(token)` function. It emits an event
(`TokenDisowned`) and changes nothing else — tokens stay in
escrow as before. Useful in compliance disputes if a CEX or
regulator asks "did you receive these funds?": you can point
to the on-chain event.

The disown function is exposed only via direct contract call
for now; the Vaipakam frontend does not surface it as a
button. Use a block-explorer "Write Contract" UI or a
contract-interaction tool to call it.
