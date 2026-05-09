# Vaipakam — User Guide (Basic Mode)

Friendly, plain-English explanations of every card in the app. Each
section corresponds to an `(i)` info icon next to a card title.

> **You're reading the Basic version.** It matches the app's
> **Basic** mode (the simpler view with fewer controls and safer
> defaults). For a more technical, detailed walkthrough, switch the
> app to **Advanced** mode — open Settings (gear icon at the top
> right) → **Mode** → **Advanced**. The (i) "Learn more" links
> inside the app will then start opening the Advanced guide.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### Your Vaipakam Vault

Think of your **vault** as your private vault inside Vaipakam. It is
a small contract that only you control. Whenever you take part in a
loan — either by putting up collateral or by lending out an asset —
the assets move from your wallet into this vault. They never get
mixed with anyone else's money. When the loan ends, you claim them
straight back out.

You don't have to "create" a vault yourself; the app makes one the
first time you need it. Once it exists it stays as your dedicated
home on this chain.

<a id="dashboard.your-loans"></a>

### Your Loans

Every loan you're part of on this chain shows up here — whether
you're the lender (the one putting up the asset to lend) or the
borrower (the one who took it). Each row is a single position. Click
into it and you get the full picture: how healthy the loan is, what's
locked as collateral, when interest accrued, and the buttons to
repay, claim, or liquidate when the time comes.

If a loan straddles two roles (you lent on one, borrowed on another),
both show up — same place, different rows.

<a id="dashboard.vpfi-panel"></a>

### VPFI on this chain

**VPFI** is the protocol's own token. Holding some in your vault
gets you a discount on protocol fees and earns you a small passive
yield (5% APR). This card tells you, on the chain you're connected
to:

- How much VPFI sits in your wallet right now.
- How much sits in your vault (which counts as "staked").
- What share of the total VPFI supply you hold.
- How much VPFI is left to be minted overall (the protocol has a
  hard cap).

Vaipakam runs on multiple chains. One of them (Base) is the
**canonical** chain where new VPFI is minted; the others are
**mirrors** that hold copies kept in sync via a cross-chain bridge.
From your point of view you don't have to think about it — the
balance you see is real on whichever chain you're on.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

Vaipakam can pay you a discount on protocol fees by using some of
the VPFI you've parked in the vault. This switch is the "yes, please
do that" toggle. You only flip it once.

How big the discount is depends on how much VPFI you keep in the vault:

- **Tier 1** — `{liveValue:tier1Min}` VPFI or more → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` VPFI or more → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` VPFI or more → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — more than `{liveValue:tier4Min}` VPFI → `{liveValue:tier4DiscountBps}`% off

You can turn the switch off at any time. If you withdraw VPFI from
vault your tier drops in real time.

> **Note on blockchain network gas.** The discount above applies to
> Vaipakam's **protocol fees** (the Yield Fee and Loan Initiation
> Fee). The small **network gas fee** every on-chain action also
> requires — paid to the blockchain validators when you create an
> offer, accept, repay, claim, etc. — is a separate charge that goes
> to the network, not to Vaipakam. The protocol can't discount it
> because the protocol never receives it.

<a id="dashboard.rewards-summary"></a>

### Your VPFI rewards

This card brings together every VPFI reward you've earned from
the protocol in one place. The big number at the top is the
combined total — what you've already claimed plus what's
sitting waiting to be claimed.

There are two reward streams and the card breaks the total
down by each one:

- **Staking yield** — earned automatically on any VPFI you keep
  in your vault. Rate is the protocol APR shown on the Buy
  VPFI page.
- **Platform-interaction rewards** — earned a little bit every
  day for each loan you're part of, on either side. Paid out
  in VPFI on the chain you're on, no bridging.

Each row has a small chevron arrow on the right. Click it to
jump straight to the full claim card for that stream — staking
lives on the Buy VPFI page, platform-interaction lives on the
Claim Center.

If you haven't earned anything yet the card still renders with
*Total earned: 0 VPFI* plus a hint on how to start. You haven't
done anything wrong — there's just no history to show.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

The market lists below can be long. Filters narrow them by which
asset the loan is in, whether it's a lender's offer or a borrower's
offer, and a few other knobs. Your own active offers always stay
visible at the top of the page — filters only affect what other
people are showing you.

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Offers **you** posted that nobody has accepted yet. While an offer
is sitting here you can cancel it free of charge. Once someone
accepts, the position becomes a real loan and moves to "Your Loans"
on the Dashboard.

<a id="offer-book.lender-offers"></a>

### Lender Offers

Posts from people offering to lend. Each one says: "I'll lend X
units of asset Y at Z% interest for D days, in return for this much
collateral".

A borrower accepting one of these becomes the borrower-of-record
for the loan: the borrower's collateral is locked in the vault, the
principal asset arrives in the borrower's wallet, and interest
accrues until the borrower repays.

The protocol enforces one safety rule on the borrower's side at
acceptance: the collateral must be worth at least 1.5× the loan.
(That number is called **Health Factor 1.5**.) If the borrower's
collateral isn't enough, the loan does not start.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

Posts from borrowers who have already locked their collateral and
are waiting for someone to fund the loan.

A lender accepting one of these funds the loan: the lender's asset
goes to the borrower, the lender becomes the lender-of-record, and
the lender earns interest at the offer's rate over the duration. A
small slice (1%) of the interest goes to the protocol treasury at
settlement.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

Pick a side:

- **Lender** — the lender supplies an asset and earns interest while
  it is outstanding.
- **Borrower** — the borrower locks collateral and requests another
  asset against it.

A **Rental** sub-option exists for "rentable" NFTs (a special class
of NFT that can be temporarily delegated). Rentals don't lend money
— the NFT itself is rented out for a daily fee.

<a id="create-offer.lending-asset"></a>

### Lending Asset

The asset and amount in play, plus the interest rate (APR in %) and
the duration in days. The rate is fixed when the offer is posted;
nobody can change it later. After the duration ends a short grace
window applies — if the borrower hasn't repaid by then the loan
can be defaulted and the lender's collateral claim kicks in.

<a id="create-offer.lending-asset:lender"></a>

#### If you're the lender

The principal asset and amount that you are willing to offer, plus
the interest rate (APR in %) and duration in days. Rate is fixed at
offer time; duration sets the grace window before the loan can
default.

<a id="create-offer.lending-asset:borrower"></a>

#### If you're the borrower

The principal asset and amount that you want from the lender,
plus the interest rate (APR in %) and duration in days. Rate is
fixed at offer time; duration sets the grace window before the loan
can default.

<a id="create-offer.nft-details"></a>

### NFT Details

For a rental offer, this card sets the daily rental fee. The renter
pays the full rental cost up front when accepting, plus a small 5%
buffer in case the deal runs slightly long. The NFT itself stays in
vault throughout — the renter has rights to use it but cannot
move it.

<a id="create-offer.collateral"></a>

### Collateral

What gets locked to secure the loan. Two flavours:

- **Liquid** — a well-known token with a live price feed
  (Chainlink + a deep enough on-chain pool). The protocol can value
  it in real time and automatically liquidate the position if the
  price moves against the loan.
- **Illiquid** — NFTs, or tokens without a price feed. The
  protocol can't value these, so on default the lender simply takes
  the whole collateral. Both lender and borrower must tick a box
  agreeing to this before the offer can be made.

<a id="create-offer.collateral:lender"></a>

#### If you're the lender

How much you want the borrower to lock to secure the loan. Liquid
ERC-20s (Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math;
illiquid ERC-20s and NFTs have no on-chain valuation and require
both parties to consent to a full-collateral-on-default outcome.

<a id="create-offer.collateral:borrower"></a>

#### If you're the borrower

How much you are willing to lock to secure the loan. Liquid ERC-20s
(Chainlink feed + ≥$1M v3 pool depth) get LTV/HF math; illiquid
ERC-20s and NFTs have no on-chain valuation and require both
parties to consent to a full-collateral-on-default outcome.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Lending and borrowing on Vaipakam carries real risk. Before an
offer is signed, this card asks for an explicit acknowledgement
from the side that's signing. The risks below apply to both sides;
the role-specific tabs below highlight which way each one tends to
bite.

Vaipakam is non-custodial. There is no support desk to reverse a
landed transaction. Read these carefully before signing.

<a id="create-offer.risk-disclosures:lender"></a>

#### If you're the lender

- **Smart-contract risk** — the contracts are immutable code; an
  unknown bug could affect funds.
- **Oracle risk** — a stale or manipulated price feed can delay
  liquidation past the point where the collateral covers your
  principal. You may not be made whole.
- **Liquidation slippage** — even when liquidation fires on time,
  the DEX swap can land at a worse price than the quote, shaving
  what you actually recover.
- **Illiquid collateral** — on default the collateral transfers to
  you in full, but if it's worth less than the loan you have no
  further claim. You agreed to this trade-off at offer creation.

<a id="create-offer.risk-disclosures:borrower"></a>

#### If you're the borrower

- **Smart-contract risk** — the contracts are immutable code; an
  unknown bug could affect your locked collateral.
- **Oracle risk** — a stale or manipulated price feed can trigger
  liquidation against you at the wrong moment, even when the real-
  market price would have stayed safe.
- **Liquidation slippage** — when liquidation fires, the DEX swap
  can sell your collateral at a worse price than expected.
- **Illiquid collateral** — on default your full collateral
  transfers to the lender, with no leftover claim back to you. You
  agreed to this trade-off at offer creation.

<a id="create-offer.advanced-options"></a>

### Advanced Options

Extra knobs for users who want them — most people leave these
alone. Things like how long an offer stays open before it expires,
whether to use VPFI for the fee discount on this specific offer,
and a couple of role-specific toggles. Safe to skip on a first
offer.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

After a loan finishes — paid back, defaulted, or liquidated — your
share of the result doesn't move into your wallet automatically.
You have to click **Claim** for it. This page is the list of every
unfinished claim you have on this chain.

A user can hold both lender claims (from loans they funded) and
borrower claims (from loans they took) at the same time — both
appear in the same list. The two role-specific tabs below describe
what each kind of claim returns.

<a id="claim-center.claims:lender"></a>

#### If you're the lender

Your lender claim returns the loan's principal plus the interest
that accrued, minus a 1% treasury cut on the interest portion. It
becomes claimable as soon as the loan settles — repaid, defaulted,
or liquidated. The claim consumes your lender position NFT
atomically — once it lands, that side of the loan is fully closed
out.

<a id="claim-center.claims:borrower"></a>

#### If you're the borrower

If you repaid the loan in full, your borrower claim returns the
collateral you locked at the start. On default or liquidation,
only any unused VPFI rebate from the Loan Initiation Fee is
returned — the collateral itself has already gone to the lender.
The claim consumes your borrower position NFT atomically.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

Every on-chain event involving your wallet on the chain you're
connected to — every offer you posted or accepted, every loan,
every repayment, every claim, every liquidation. It's all read live
from the chain itself; there is no central server that could go
offline. Newest first, grouped by transaction so things you did in
the same click stay together.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### Buying VPFI

The buy page lets you swap ETH for VPFI at the protocol's fixed
early-stage rate. You can do this from any supported chain — we'll
route the trade for you under the hood. VPFI always lands back in
your wallet on the same chain you're connected to. No need to
switch networks.

<a id="buy-vpfi.discount-status"></a>

### Your VPFI Discount Status

Quick read on which discount tier you currently sit in. Tier comes
from how much VPFI is in your **vault** (not your wallet). The
card also tells you (a) how much more VPFI you'd need in the vault to
bump up to the next tier, and (b) whether the consent switch on
the Dashboard is on — the discount only applies while it is.

The same VPFI in your vault is also "staked" automatically and
earns you 5% APR.

<a id="buy-vpfi.buy"></a>

### Step 1 — Buy VPFI with ETH

Type how much ETH you want to spend, hit Buy, sign the
transaction. That's it. There's a per-purchase cap and a rolling
24-hour cap to prevent abuse — you'll see the live numbers next to
the form so you know how much you have left.

<a id="buy-vpfi.deposit"></a>

### Step 2 — Deposit VPFI into your vault

Buying VPFI puts it in your wallet, not your vault. To get the
fee discount and the 5% staking yield, you need to move it into
the vault yourself. This is always an explicit click — the app
never moves your VPFI without you asking. One transaction (or a
single signature, on chains that support it) and you're set.

<a id="buy-vpfi.unstake"></a>

### Step 3 — Unstake VPFI from your vault

Want some VPFI back in your wallet? This card sends it from vault
back to you. Be aware: pulling VPFI out drops your discount tier
**immediately**. If you have open loans, the discount math
switches to the lower tier from this moment forward.

---

## Rewards

<a id="rewards.overview"></a>

### About Rewards

Vaipakam pays you for two things:

1. **Staking** — VPFI you keep in the vault earns 5% APR,
   automatically.
2. **Interaction** — every dollar of interest a loan you're part of
   actually settles earns you a daily share of a community-wide
   reward pool.

Both pay out in VPFI, minted directly on the chain you're on. No
bridges, no chain switches.

<a id="rewards.claim"></a>

### Claim Rewards

One button claims everything from both reward streams in a single
transaction. Staking rewards are always claimable in real time.
The interaction-pool share settles once a day, so if you've earned
some since the last settlement, the interaction part of the total
only goes live shortly after the next daily window closes.

<a id="rewards.withdraw-staked"></a>

### Withdraw Staked VPFI

Move VPFI out of your vault back to your wallet. Once it's in the
wallet it stops earning the 5% APR and stops counting toward your
discount tier. Same as the "unstake" step on the Buy VPFI page —
same action, just lives here too for convenience.

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (this page)

Everything about a single loan, on one page. The terms it was
opened under, how healthy it is right now, who's on each side, and
every button you can press on it given the role you're playing —
repay, claim, liquidate, close early, refinance.

<a id="loan-details.terms"></a>

### Loan Terms

The fixed parts of the loan: which asset was lent, how much, the
interest rate, the duration, and how much interest has piled up so
far. None of these change once the loan is open. (If different
terms are needed, refinance — the app creates a fresh loan and
pays this one off in the same transaction.)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

The collateral on this loan, plus the live risk numbers — Health
Factor and LTV. **Health Factor** is a single safety score: above
1 means the collateral comfortably covers the loan; near 1 means
it's risky and the loan could be liquidated. **LTV** is "how much
was borrowed vs. the value of what was put up". The thresholds
where the position becomes unsafe are on the same card.

If the collateral is illiquid (an NFT or a token with no live
price feed), these numbers can't be computed. Both sides agreed to
that outcome at offer creation.

<a id="loan-details.collateral-risk:lender"></a>

#### If you're the lender

This is the borrower's collateral — your protection. As long as HF
stays above 1, you're well-covered. When HF drops, your protection
thins; if it crosses 1, anyone (you included) can trigger
liquidation, and the DEX swap converts the collateral to your
principal asset to repay you. On illiquid collateral, default
transfers the collateral to you in full — you take whatever it's
worth.

<a id="loan-details.collateral-risk:borrower"></a>

#### If you're the borrower

This is your locked collateral. Keep HF safely above 1 — when it
gets close, you're at liquidation risk. You can usually pull HF
back up by adding more collateral or repaying part of the loan.
If HF crosses 1, anyone can trigger liquidation, and the DEX swap
will sell your collateral at slippage-eaten prices to repay the
lender. On illiquid collateral, default transfers your full
collateral to the lender with no leftover claim back to you.

<a id="loan-details.parties"></a>

### Parties

The two wallet addresses on this loan — lender and borrower — and
the vault vaults that hold their assets. Each side also got a
"position NFT" when the loan opened. That NFT _is_ the right to
that side's share of the outcome — keep it safe. If a holder
transfers it to someone else, the new holder gets to claim
instead.

<a id="loan-details.actions"></a>

### Actions

Every button available on this loan. The set you see depends on
your role on this specific loan — the role-specific tabs below
list each side's options. Buttons that aren't available right now
will be greyed out, with a small tooltip explaining why.

<a id="loan-details.actions:lender"></a>

#### If you're the lender

- **Claim** — once the loan settles (repaid, defaulted, or
  liquidated), unlocks the principal back plus interest, less the
  1% treasury cut on interest. Consumes your lender NFT.
- **Initiate Early Withdrawal** — list your lender NFT for sale to
  another buyer mid-loan. The buyer takes over your side; you walk
  away with the sale proceeds.
- **Liquidate** — anyone (you included) can trigger this when HF
  drops below 1 or the grace period expires.

<a id="loan-details.actions:borrower"></a>

#### If you're the borrower

- **Repay** — full or partial. Partial repayment lowers your
  outstanding and improves HF; full repayment closes the loan and
  unlocks your collateral via Claim.
- **Preclose** — close the loan early. Direct path: pay the full
  outstanding from your wallet now. Offset path: sell some of the
  collateral on a DEX, use the proceeds to repay, get whatever's
  left back.
- **Refinance** — roll into a new loan with new terms; the
  protocol pays off the old loan from the new principal in one
  transaction. Collateral never leaves vault.
- **Claim** — once the loan settles, returns your collateral on
  full repayment, or any leftover VPFI rebate from the loan-
  initiation fee on default.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

When you accept an offer, your wallet sometimes "approves"
Vaipakam to move a specific token on your behalf. Some wallets
have habits of keeping these approvals open longer than necessary.
This page lists every approval you have given Vaipakam on this
chain and lets you turn any of them off in one click. Non-zero
approvals (the ones that are actually live) appear at the top.

A clean approvals list is a hygienic habit — same as on Uniswap or
1inch.

---

## Alerts

<a id="alerts.overview"></a>

### About Alerts

When the price of your collateral drops, your loan's safety score
(its Health Factor) drops with it. Alerts let you opt-in to a
heads-up **before** anyone can liquidate you. A small off-chain
service watches your loans every five minutes and pings you the
moment the score crosses a danger band. There's no gas cost;
nothing happens on-chain.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

The danger bands the watcher uses. Crossing into a more-dangerous
band fires once. The next ping only happens if you cross another
band deeper. If you climb back to a safer band the ladder resets.
The defaults are tuned for typical loans; if you're holding very
volatile collateral you may want to set higher thresholds.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

Where the pings actually go. You can pick Telegram (a bot DMs
you), or Push Protocol (notifications direct to your wallet), or
both. Both rails share the same threshold ladder above — you
don't tune them separately.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### Verify an NFT

Vaipakam position NFTs sometimes show up on secondary markets.
Before you buy one off another holder, paste the NFT contract
address and token ID here. The verifier confirms (a) that it
really was minted by Vaipakam, (b) which chain the underlying
loan lives on, (c) what state that loan is in, and (d) who
currently holds the NFT on-chain.

The position NFT _is_ the right to claim from the loan. Spotting
a fake — or a position that already settled — saves you the bad
trade.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### About Keepers

A "keeper" is a wallet you trust to perform specific maintenance
actions on your loans for you — completing an early withdrawal,
finalising a refinance, things like that. Keepers can never spend
your money — repaying, adding collateral, claiming, and
liquidating all stay user-only. You can approve up to 5 keepers,
and you can turn off the master switch any time to disable all
of them at once.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

Each keeper on the list can do **only the actions you ticked**
for them. So a keeper with just "complete early withdrawal"
allowed cannot start one on your behalf — they can only finish
one you started. If you change your mind, edit the ticks; if you
want a keeper gone entirely, remove them from the list.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### About Public Analytics

A wallet-free, transparent view of the whole protocol: total
value locked, loan volumes, default rates, VPFI supply, recent
activity. All of it is computed live from on-chain data — there's
no private database behind any number on this page.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

The protocol-wide totals, summed across every supported chain.
The small "X chains covered, Y unreachable" line tells whether
any chain's network was offline at the time the page loaded — if
so, the specific chain is flagged in the per-chain table below.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

The same totals, split per chain. Useful to see which chain holds
the most TVL, where most loans are happening, or to spot when one
chain has stalled.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

The live state of VPFI on this chain — how much exists in total,
how much is actually circulating (after subtracting protocol-held
balances), and how much is still mintable under the cap. Across
all chains the supply stays bounded by design.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

Every number on this page can be re-derived directly from the
blockchain. This card lists the snapshot block, how recently the
data was fetched, and the contract address each metric came
from. If anyone wants to verify a number, this is where to start.

---

## Refinance

This page is borrower-only — refinance is initiated by the
borrower on the borrower's loan.

<a id="refinance.overview"></a>

### About Refinancing

Refinancing rolls your existing loan into a new one without
touching your collateral. You post a fresh borrower-side offer
with the new terms; once a lender accepts, the protocol pays off
the old loan and opens the new one in a single transaction.
There's no point in time where your collateral is unguarded.

<a id="refinance.position-summary"></a>

### Your Current Position

A snapshot of the loan you're refinancing — what's outstanding,
how much interest has accrued, how healthy it is, what's locked.
Use these numbers to size the new offer sensibly.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — Post the New Offer

You post a borrower offer with the asset, amount, rate, and
duration you want for the refinance. While it's listed, the old
loan keeps running normally — interest still accrues, your
collateral stays put. Other users see this offer in the Offer
Book.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

Once a lender accepts your refinance offer, click Complete. The
protocol then, atomically: pays back the old loan from the new
principal, opens the new loan, and keeps your collateral locked
the whole time. One transaction, two-state change, no exposure
window.

---

## Preclose

This page is borrower-only — preclose is initiated by the
borrower on the borrower's loan.

<a id="preclose.overview"></a>

### About Preclose

Preclose is "close my loan early". You have two paths:

- **Direct** — pay the full outstanding balance from your wallet
  now.
- **Offset** — sell some of your collateral on a DEX and use the
  proceeds to pay off the loan. You get back whatever's left.

Direct is cheaper if you have the cash. Offset is the answer when
you don't, but you don't want the loan running anymore either.

<a id="preclose.position-summary"></a>

### Your Current Position

A snapshot of the loan you're closing early — outstanding,
accrued interest, current health. Closing early is fee-fair —
there's no flat penalty; the protocol's time-weighted VPFI math
handles the accounting.

<a id="preclose.in-progress"></a>

### Offset In Progress

You started an offset preclose a moment ago and the swap step is
mid-flight. You can either complete it (the proceeds settle the
loan and any remainder comes back to you), or — if the price
moved while you were thinking — cancel and try again at a fresh
quote.

<a id="preclose.choose-path"></a>

### Choose a Path

Pick **Direct** if you have the cash to pay off the loan now.
Pick **Offset** if you'd rather sell part of the collateral on
the way out. Either path closes the loan in full; you can't
half-close with preclose.

---

## Early Withdrawal (Lender)

This page is lender-only — early withdrawal is initiated by the
lender on the lender's loan.

<a id="early-withdrawal.overview"></a>

### About Lender Early Exit

If you want out of a loan before the duration ends, you can list
your lender NFT for sale through the protocol. The buyer pays you
for it; in return, they take over your side of the loan — they
collect the eventual repayment + interest. You walk away with
your money plus whatever premium the buyer paid.

<a id="early-withdrawal.position-summary"></a>

### Your Current Position

A snapshot of the loan you're stepping out of — principal,
interest accrued so far, time remaining, and the borrower's
current health score. These are the numbers a buyer will look at
when deciding what your NFT is worth.

<a id="early-withdrawal.initiate-sale"></a>

### Initiate the Sale

You set the asking price, the protocol lists your lender NFT,
and you wait for a buyer. As soon as a buyer accepts, the
proceeds land in your wallet and the loan continues — but you
are no longer on the hook for it. While the listing is open and
unfilled you can cancel it.
