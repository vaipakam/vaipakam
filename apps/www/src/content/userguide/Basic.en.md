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

<a id="chapter.dashboard"></a>

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
gets you a discount on protocol fees. This card tells you, on the
chain you're connected to:

- How much VPFI sits in your wallet right now.
- How much sits in your vault (which counts toward your discount tier).
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

Vaipakam can give you a discount on protocol fees based on the VPFI
you keep in the vault. For a borrower the discount is simply a
smaller Loan Initiation Fee, taken in the loan's own asset when the
loan starts — no VPFI is spent on it. This switch is the "yes,
please do that" toggle. You only flip it once.

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

Rewards come from **platform interaction** — you earn a little
bit every day for each loan you're part of, on either side. Paid
out in VPFI on the chain you're on, no bridging.

The row has a small chevron arrow on the right. Click it to jump
straight to the full claim card in the Claim Center.

If you haven't earned anything yet the card still renders with
*Total earned: 0 VPFI* plus a hint on how to start. You haven't
done anything wrong — there's just no history to show.

---

<a id="chapter.offer-book"></a>

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
small slice (`{liveValue:treasuryFeeBps}`%) of the interest goes to the protocol treasury at
settlement.
That rate is fixed when the loan is created, so a later change to the
protocol fee leaves an already-open loan on the rate it started with.

---

<a id="chapter.create-offer"></a>

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

<a id="chapter.claim-center"></a>

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
that accrued, minus the treasury cut on the interest portion. That
cut is the percentage fixed when your loan was created — a protocol
fee change after that does not touch it. Loans created at the
current rate carry a `{liveValue:treasuryFeeBps}`% cut. It
becomes claimable as soon as the loan settles — repaid, defaulted,
or liquidated. The claim consumes your lender position NFT
atomically — once it lands, that side of the loan is fully closed
out.

<a id="claim-center.claims:borrower"></a>

#### If you're the borrower

If you repaid the loan in full, your borrower claim returns the
collateral you locked at the start. On default or liquidation,
check anyway. Only as much value is taken as the debt and
the costs of closing it require, and anything beyond that is
recorded as yours. What form it takes depends on how the loan
ended: if the collateral was sold out through an exchange, what
is left reaches you as the loan’s own asset. If it was handed
over instead, the collateral itself is what waits for you. More
than one thing hands it over, whichever way the loan ended: a
liquidator taking it directly at a discount, a close-out matched
inside the protocol against an opposing position rather than
sold, or a sale that could not go through — there you get the collateral unless the lender brings a quote that
works when they claim, which pays you in the loan's own asset instead
— and most claims bring none. An ordinary liquidation
and a default both look for that internal match before going to an
exchange, so neither of those two always ends the same way — read the
claim rather than guessing from how the loan closed. A discounted
seizure is the exception, and it is predictable the other way: it
never sells, so it always leaves you the collateral. Often — on a default over collateral we
cannot price — the whole basket goes and nothing is left, and on that route
that is the rule rather than how it happened to turn out.
Claiming consumes your borrower position NFT. The reverse does
not follow: an NFT still sitting there after a liquidation is not
evidence that anything is waiting. Where nothing was left over there is
nothing to collect, the attempt is refused, and the NFT can be
sitting there all the same. Read what the claim says rather than
taking the NFT as a promise.

---

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Getting VPFI

VPFI is freely transferable. Acquire it on the open market wherever
it trades, or bridge it in — VPFI is a Chainlink CCIP token, so it
moves between supported chains using the official bridge and lands
in your wallet on whichever chain you're connected to.

<a id="buy-vpfi.discount-status"></a>

### Your VPFI Discount Status

Quick read on which discount tier you currently sit in. Tier comes
from how much VPFI is in your **vault** (not your wallet). The
card also tells you (a) how much more VPFI you'd need in the vault to
bump up to the next tier, and (b) whether the consent switch on
the Dashboard is on — the discount only applies while it is.

<a id="buy-vpfi.deposit"></a>

### Deposit VPFI into your vault

VPFI in your wallet doesn't count toward the discount tier. To
unlock the fee discount, move VPFI into your vault yourself. This
is always an explicit click — the app never moves your VPFI
without you asking. One transaction (or a single signature, on
chains that support it) and you're set.

<a id="buy-vpfi.unstake"></a>

### Unstake VPFI from your vault

Want some VPFI back in your wallet? This card sends it from vault
back to you. Be aware: pulling VPFI out drops your discount tier
**immediately**. If you have open loans, the discount math
switches to the lower tier from this moment forward.

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### About Rewards

Vaipakam pays you a **platform-interaction reward**: every dollar
of interest a loan you're part of actually settles earns you a
daily share of a community-wide reward pool.

Rewards pay out in VPFI, minted directly on the chain you're on. No
bridges, no chain switches.

<a id="rewards.claim"></a>

### Claim Rewards

One button claims your accrued rewards in a single transaction.
The interaction-pool share settles once a day, so if you've earned
some since the last settlement, it only goes live shortly after the
next daily window closes.

---

<a id="chapter.loan-details"></a>

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
  treasury cut fixed at your loan's creation
  (`{liveValue:treasuryFeeBps}`% for loans created at the current
  rate). Consumes your lender NFT.
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
  full repayment. On default there may still be a
  surplus: only enough collateral is taken to cover the debt and
  the cost of closing it, so anything you put up beyond that is
  recorded as yours to claim. What that is depends on the path —
  see the Claim Center section.

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### About Alerts

When the price of your collateral drops, your loan's safety score
(its Health Factor) drops with it. Alerts let you opt-in to a
heads-up **before** anyone can liquidate you. A small off-chain
service watches your loans every five minutes and pings you the
moment the score crosses a danger band. There's no gas cost;
nothing happens on-chain.

<a id="alerts-inbox"></a>

### The Alerts inbox

The Alerts page lists the alerts the protocol's index keeps for your wallet on the network you are on, newest first. It is free and there is nothing to sign up for. An alert is written when a loan starts, is repaid in part or in full, defaults or is liquidated, nears its due date, enters or leaves its grace period, or its health falls below 1.5, 1.2 or 1.05, and when a reward entry nears or passes its claim deadline. Each alert opens the loan, whose page reads it from the chain, or Claims for a reward. The bell beside your wallet at the top counts the alerts that arrived since you last opened the page in this browser. If the index cannot be read, the page says so instead of showing an empty inbox. Telegram, push, health warnings and payment reminders are set up just below the inbox. Each alert says how things stood when it was written; open the loan to see where it stands now.

<a id="alerts-channels"></a>

### Telegram, push and warnings

Under the inbox, the Alerts page sets up alerts that reach you outside the app. Each change is a free signature in your wallet, not a transaction. To link Telegram, press Link Telegram, send the one-time code to the Vaipakam bot within ten minutes, then send a test alert: the link counts as working once that message reaches your chat. Push is offered only when the alert service says it can send right now; you also subscribe to the Vaipakam channel in your push app, and unsubscribe there to stop. Health warnings are always on once Telegram or push is set up, at health 1.5, 1.2 and 1.05. Payment reminders can be switched off and on. The page shows what this browser has done; a link or setting made on another device may still exist.

<a id="alerts-paid-push"></a>

### Paid push alerts

On some networks the alert service charges a small fee in VPFI for push alerts about a loan. It can charge you only if you agree first, on chain, and only up to the most you agreed to pay. The Paid push alerts section shows the fee on this network and whether the service charges here. The fee is taken from free VPFI in your vault, at most once per loan side, when the first paid push alert about that loan is sent; a fee already charged is not refunded, and Telegram alerts are free. A fee rise within your cap is charged without asking again. You can withdraw the agreement at any time.

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### About Public Analytics

A wallet-free view of the protocol on one network: the network
the app is reading. You don't need to connect anything. The page
draws on two public sources and says which one each figure comes
from — the public indexer, which anyone can query without a key,
and the platform contract itself — so you never have to take a
number on trust.

<a id="public-dashboard.loans-offers"></a>

### Loans and Offers

Counts of loans by state (active, repaid, defaulted, liquidated
and so on) and of offers by state, from the public indexer. A
count the indexer did not report shows as "not reported", never
as zero. Offers here are on-chain offers only: signed gasless
orders are not counted, though they do appear in the Offer Book.
The offer total is the offers currently on record, not a
lifetime count.

<a id="public-dashboard.recycling"></a>

### Recycling Account and Loop Closure

Where each day's reward pool came from and how much of it was
drawn, and how much of the reward VPFI paid out by claims stays
inside the platform. These are bookkeeping records from the
public indexer; a figure that is not known yet says so instead of
showing zero.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

The platform contract's address, with a link to open it on a
block explorer, the network, the last block the indexer has read
and how long ago that was. The indexer's figures are only as
current as that block, which is why its age is shown.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token

Read straight from the platform contract, not from the indexer:
the VPFI token's address and its supply on this network. On the
network where VPFI is issued it also shows the supply cap, how
much can still be minted under it, and the one address allowed to
mint. On a network VPFI reaches by bridge it shows that network's
supply only.

<a id="public-dashboard.fees"></a>

### Fees and Treasury

Also read from the contract: the fees the protocol has recorded
since recording began, over the last day and over the last week,
and the treasury address they go to. The page names the block it
read at, how old that reading is and the functions it called, and
it states every reason the fee figures can be lower than what was
really collected. After a change of reference currency, earlier
fees stay in the old unit, which can push a total either way; the
page says that too. A figure that could not be read says so
instead of showing zero.

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## The Next App

The next version of the Vaipakam app is being built page by page,
beside the current one. A page that is not built yet says so and
links you to the current app, which still serves it. This chapter
explains the pages that are already built.

<a id="advanced-mode"></a>

### Basic and Advanced

Basic shows what most people need. Advanced adds the exit and
settlement tools, automation, signed orders, keeper status and
accounting detail. Switching modes never hides a consent you have
to give, something that blocks you, or the way to fix it. Every info button (i), after the sentence it explains,
opens the full explanation, and its "Read more" link
opens this guide in the mode you are using.

<a id="wallet"></a>

### Your Wallet and Where Your Figures Come From

The app reads your loans, vault and claims through your wallet's
own connection to the network first. Only when the wallet offers
none does it use a read-only proxy. Your own figures are never
taken from the shared index. The address and network shown at the
top are the ones every figure on the page belongs to. If your
wallet is on a network the app does not serve, nothing of yours is
shown until you switch.

<a id="deployments"></a>

### What the Deployment Supports

Before it offers any action, the app reads which functions the
protocol contract on your network supports right now. An upgrade
can change that list, and reading it lets the app tell you what
changed instead of failing. If the list cannot be read, no signing
step is offered.

<a id="home-start"></a>

### Home: Choosing a Job

Home starts with "I want to…": borrow, lend, rent an NFT, rent out
your NFT, or manage what you have. Each choice opens a guided page.
Borrowing and lending show matching offers first and let you post
your own when none fits. Renting covers both sides: using someone
else's NFT, or letting someone use yours while it stays in a vault.
With a wallet connected, Home also shows three short
getting-started cards, which you can hide.

<a id="home-status"></a>

### Home: Protocol Status

Home always says whether the protocol on your network is running.
While it is paused for an incident, new positions, claims,
withdrawals, liquidations, defaults and keeper steps stop. Full
repayment, partial repayment and adding collateral stay open, and
the paused time is added to every open loan's due date. An
automatic pause lasts a fixed time, and a new one can only start
after a cooldown. The keeper service can be paused on its own; that
never blocks anything you do yourself. If the status cannot be
read, Home says so at the top instead of assuming it is running.

<a id="home-payouts"></a>

### Home: Ready to Collect

A payout is ready when a loan has ended and a claim would pay you
now: the repayment for a lender, the collateral back (or what is
left of it) for a borrower, or an NFT returned at the end of a
rental. Home lists them first and sends you to Claims, which shows
every amount before you collect.

<a id="home-loans"></a>

### Home: Your Loans

Each live loan shows your side, its terms, its collateral and its
next deadline, the most urgent first. A loan is due on its due
date. After that a grace period runs, in which the borrower can
still repay with a late fee. Once the grace period ends, anyone can
start the default, which settles the loan from the collateral. The
health factor compares the collateral's value with the debt: below
1, the loan can be liquidated. A loan in an asset with no price has
no health factor. Loans opened from one of your offers are shown
together.

A loan that pays interest periodically also has checkpoints, up to and including its due date. Interest still owed when a checkpoint's grace period ends can be paid by selling collateral, and the loan stays open; Home shows the next checkpoint and puts an owed one first, even when it falls on the due date, because its grace period can end before the loan's. The protocol can switch this settlement off; Home then says that no collateral is sold at a checkpoint.

<a id="home-exposure"></a>

### Home: Lent and Borrowed

When you both lend and borrow, Home compares the two sides by
today's value. Loans that cannot be valued, such as NFTs or assets
with no price, are counted and left out, and Home names the larger
side only when they could not change the answer.

<a id="home-faucet"></a>

### Home: Test Assets

On a test network, Home offers test tokens and NFTs so you can try
borrowing, lending and renting without real money. They have no
value and are minted by test token contracts, not by the protocol.
Some test tokens have a test price, so loans in them have a health
factor; others have none, so a default hands over the collateral
itself. The test NFTs can be rented out. Each mint shows a receipt
first, and the result is checked on the chain afterwards.

<a id="home-fee-discount"></a>

### Home: Fee Discount

The fee discount is one setting per network for your whole wallet.
While it is off, your fees get no discount, whatever VPFI you hold.
While it is on, the fee charged when you borrow is reduced, and so
is the fee on interest you earn as a lender, by your VPFI discount
tier at the moment each fee is charged; at tier 0 there is none. On
some networks the lender discount is paid in VPFI from your vault,
and the receipt says which before you confirm. Turning it on needs
the current Terms accepted; turning it off never does. While the
protocol is paused it cannot be changed either way. A loan in an
illiquid lending asset still pays the full borrowing fee, and no
discount is ever more than half the fee.

<a id="home-rewards"></a>

### Home: Rewards

Rewards are usage rebates for your lending and borrowing on this network, counted per reward day and paid in VPFI. Home shows exactly what a claim made now would pay, because the app runs the claim as a preview first. If that preview cannot run, Home shows a lower bound instead, labelled as such, and does not offer the claim until the exact figure can be worked out. One claim pays up to 30 reward days; when more remain, Home offers to claim again, and stopping partway is safe. A claim is delivered to your vault, ready to use, or to your wallet when the vault cannot take it; a claim never opens a vault. When a reward day is still waiting to be finalised across networks, or for its funding to reach this network, Home names that day instead of offering a claim that would fail. Rewards are not interest or yield, and claiming never stakes or reinvests anything. Now and then a claim pays nothing but still moves past reward days that paid you nothing, so the days after them can be paid; Home says so and still offers it.

<a id="home-rewards-expiry"></a>

### Home: Reward Removal Dates

On a network where unclaimed rewards can be removed, Home shows the soonest estimated removal date among your rewards, and a final notice in the last 90 days before it. Claiming before then always keeps the reward. The estimate is never later than the real date as things stand: time during which the reward cannot be claimed moves the real date later, but a change to the network's claim window can make it earlier, so check again before relying on it. If not every reward could be checked, Home says so instead of saying nothing is due. Where the network removes nothing, no date is shown.

<a id="home-rewards-held"></a>

### Home: Held Rewards

If the sanctions screen flags your wallet, no rewards are paid to it while it stays flagged. Rewards it earned before the flag are held for it, locked but not lost, and are released once the wallet is no longer flagged; Home then offers to claim exactly that balance on its own. While a flag is confirmed, rewards earned are forfeited for good and VPFI in your vault cannot be moved. If whether the wallet is still flagged cannot be read, nothing is released.

<a id="borrow-start"></a>

### Borrow: How It Works

To borrow, you take a lender's open offer: an amount of one token, a rate, a term and the collateral the lender asks for. Taking it opens a loan in one transaction. Your collateral moves from your wallet into your own vault, where it stays locked while the loan is open, and the amount, less a small initiation fee, arrives in your wallet. You repay the amount plus interest by the due date. When no offer fits, you can also post your own borrow request and wait for a lender.

<a id="borrow-pair"></a>

### Borrow: Choosing the Tokens

First choose what to borrow and what to lock. The app suggests tokens on the network, or you can paste a token address; no token-safety screening runs, so check a pasted address yourself. For each token the app reads what the protocol says about it now. A liquid token is priced, so the loan has a health factor and can be liquidated if the collateral loses value. An illiquid token is valued at zero, and on default the lender receives the collateral itself. When the protocol does not trust a token's price, new loans on it are closed until it does; loans already open are not affected.

<a id="borrow-offers"></a>

### Borrow: Picking an Offer

The page lists the lender offers open for your two tokens, read from the protocol itself. Each shows the amount, rate and term, the collateral asked, the loan-to-value at today's prices, how interest is charged, any interest schedule, when the offer ends and what you would receive after the fee. An offer is taken whole, at the lender's full amount and lowest rate. When the protocol would refuse an offer, the page says why and offers no button. The order is a convenience, not advice.

<a id="borrow-review"></a>

### Borrow: Review and Signing

Before your wallet opens, the review shows every figure: what you receive, the fee, what you lock, the rate, what you owe on the due date, the grace period and what you can lose. You tick a box to agree to the Risk Disclosures and Terms; if the figures change before you confirm, the box clears. Your wallet then asks you to sign the terms, which costs nothing, to approve exactly the collateral if that is needed, and to send the acceptance, which the app first tries as a dry run. If it stops after an approval, the app asks to put the approval back and says whether that happened. Afterwards the app checks on the chain the loan it opened, what arrived and what was locked. It also states the loan's lifecycle terms, each even when it is the default: partial repayment, selling the collateral, and any refinance or linked loan. The amount owed assumes no pause: a pause moves the due date later and interest keeps running through it.

<a id="borrow-fee"></a>

### Borrow: The Initiation Fee

Opening a loan costs a small share of the amount, charged once, in the token you borrow, and taken from what you receive; the review shows the rate in force. You owe interest on the whole amount. Your fee-discount tier lowers the fee when the fee discount is on and the borrowed token is liquid. No VPFI is taken or held for this fee, and nothing is refunded later. Because you send the acceptance yourself, a small share of the fee, the share the protocol pays whoever submits a match, comes back to you with the amount; the review shows it.

<a id="borrow-risks"></a>

### Borrow: Risks

A loan can cost you your collateral. If you have not repaid by the end of the grace period, the loan defaults and the lender is paid from your collateral: sold for them where the protocol can, handed over as-is where it cannot. With liquid collateral, if its value falls until the loan's health factor drops below 1, anyone can liquidate the loan and you lose collateral. With full-term interest you owe the whole term's interest even if you repay early. With an interest schedule, a missed period is paid by selling part of your collateral. Your collateral stays locked until the loan is repaid or settled.

<a id="borrow-request"></a>

### Borrow: Posting Your Own Request

When no offer fits, you can post your own borrow request for your two tokens: the exact amount, the rate you will pay, the term and the collateral you lock. Posting moves the collateral from your wallet into your own vault, where it stays while the request is open. A lender who takes it opens the loan at once, on your terms, without asking you again; the amount, less the initiation fee, arrives in your wallet. You can cancel from five minutes after posting, and the collateral returns to your wallet. A lapsed request can no longer be taken; its collateral stays in your vault until you, or anyone, closes it, and then returns only to your wallet. Until the next app's Offers page is built, you follow, cancel and close a request on the current app's Offers page; the review says so before anything is locked.

<a id="borrow-request-terms"></a>

### Borrow: The Request's Terms

One lender takes the whole amount, or nobody does. Each figure is read exactly as you type it: more decimals than the token has are refused, never rounded, and the rate goes up to 100% a year with two decimals. The terms offered stop at the longest one the network allows; you can also type a term in days. The request stays open until taken or cancelled, or for the number of days you choose, up to a year. Full-term interest, the usual choice, is owed in full even if you repay early; pro-rata charges only for the time the loan is open. The form shows what you would receive at today's fee rate and owe at the due date if a lender took it now.

<a id="borrow-request-review"></a>

### Borrow: Reviewing and Posting a Request

Before your wallet opens, the app asks the protocol to try your request as a dry run, so the review shows the protocol's own answer. It lists what you lock now, the amount, rate and term, what you would receive and how the fee is set (the fee rate in force when a lender takes it, less your fee-discount tier at that moment; the figure shown uses today's rate), what you would owe, every lifecycle term, when the request lapses, the loan-to-value and whether an approval is needed. You tick a box to agree to the Risk Disclosures and Terms. Your wallet approves exactly the collateral if needed, the app tries the request again, and only then posts it. If it stops after an approval, the app asks to put the approval back and says whether that happened. Afterwards the app checks on the chain the request recorded and the collateral locked.

<a id="borrow-nft-collateral"></a>

### Borrow: An NFT as Collateral

A request can lock one NFT instead of a token. Pick the collection as what you lock (the test collections are marked as NFTs, or paste an address); whether an address is a token or an NFT collection is read from its contract. Then type the NFT's number, its token id, shown in your wallet or on the collection's page; the form says at once whether your wallet holds it. The protocol values an NFT at zero, whatever it sells for elsewhere: a loan against one has no loan-to-value and no price-based liquidation, and if you do not repay by the end of the grace period the lender receives the NFT itself. Posting asks your wallet to approve the protocol for that one NFT only, never the rest of your collection, and moving it into your vault clears that approval by itself; if the request stops after the approval, the app asks to put it back and says whether that happened. NFTs that come in quantities (multi-token collections) work the same way with a quantity: type the token's number and how many of it to lock, and the form says how many your wallet holds. Such a collection cannot approve one token, only all of yours in it, so posting grants that approval for this request alone and takes it back in one more wallet step afterwards, whether the request went through or not; an approval you had already given is left as you set it. Taking a lender's offer that asks for an NFT is still done in the current app for now.

<a id="borrow-request-range"></a>

### Borrow: An Amount Range (Advanced)

In Advanced mode a request can accept a range: the smallest and the largest amount a lender may lend, at your one rate, and, if you like, a smaller amount of collateral for the smallest loan. A lender taking the request directly lends the smallest amount and locks only the collateral set for it; the rest goes back to your wallet. Matches may lend more, up to the largest amount, while matching is switched on for the network; the review says whether it is, and that while it is off the range fills once. The protocol refuses a largest amount your collateral does not support at today's prices, and the review names the most it supports. The review shows the loan-to-value at both ends, and warns when a lender could not take the request directly at today's prices. Options set in Advanced still apply if you switch to Basic: the form says so and lets you clear them. A match locks only the collateral its lender asks for, at least the floor, so the review states the largest match from all your collateral down to only the floor, and warns that a matched loan can start riskier than a direct one. While matching is on, the collateral a match does not lock stays with the request for later matches and comes back to your wallet only when the request closes or you cancel it.

<a id="borrow-request-fill"></a>

### Borrow: How a Request Fills (Advanced)

Partial, the default, lets matches fill the request over one or more loans until it is filled, cancelled or lapses. All or none admits one fill of the whole amount, so it cannot be used with a range. Immediate or cancel fills like partial but only until the request lapses, so it needs an expiry. The fill mode cannot be changed after posting; to change it, cancel the request and post a new one. The protocol lets you change the amounts, the rate and the collateral while the request is open, never below what matches have already used, but this app does not offer that yet, so for now a change means cancelling and posting again.

<a id="borrow-request-cadence"></a>

### Borrow: An Interest Schedule (Advanced)

In Advanced mode a request can pay interest on a schedule instead of all at repayment: every month, quarter, six months or year. The form offers only the schedules the protocol allows for your terms, and says under each closed one why: periodic interest is switched off on the network, an asset has no price, the loan is worth less than the protocol's threshold (both figures are shown), or the period is not shorter than the loan. The review shows each period's interest and the grace a missed period gets. If a period is not paid by the end of its grace, anyone may sell part of your collateral to pay it, and the loan stays open. The schedule cannot be changed after posting. Like the other Advanced options, it still applies if you switch to Basic, and the form says so.

<a id="borrow-request-tariff"></a>

### Borrow: The Full Fee Tariff (Advanced)

In Advanced mode a request can take the Full fee tariff: a fee in VPFI, taken from your vault when each loan opens, that adds ten points to the discount on the loan fee, up to the protocol's 50% cap. The loan fee itself is still charged in the lending asset, and the tariff is not refunded. The form offers it only while the protocol has it switched on, and shows today's tariff for your amount and term. You set the most VPFI one loan may take (left blank, today's tariff for the largest loan) and what happens to a loan that cannot take the tariff when it opens: it is refused, or it opens without it. A loan can take it only if, at that moment, the tariff is switched on, the lending asset is priced and liquid, its tariff is within your most, and your vault holds enough free VPFI. The tariff is set by a second transaction after the request posts, so a lender who takes the request before that transaction confirms opens a loan without it. Backstop lending for requests nobody takes is not offered in this app yet.

<a id="lend-start"></a>

### Lend: How It Works

To lend, you fund a borrower's open request: an amount of one token, the rate they will pay, a term, and collateral the borrower has already locked in their own vault. Funding it opens a loan in one transaction. The amount leaves your wallet, the borrower receives it less their initiation fee, and the collateral stays locked for you until the loan ends. Your side of the loan is a position token in your wallet, and whoever holds it is the one repaid. The borrower repays the amount plus interest by the due date, and the protocol keeps its share of the interest. When no request fits, you can post your own lending offer instead, from the same page.

<a id="lend-offers"></a>

### Lend: Picking a Request

First choose what to lend and what collateral you accept; they must be different tokens, and this page offers tokens only. The page lists the borrow requests open for that pair, read from the protocol itself. Each shows the amount, rate and term, the collateral locked, the loan-to-value at today's prices, how interest is charged, any interest schedule, and how much of the borrower's fee comes back to you. A request is funded whole: when it names a range, you lend the borrower's smallest amount at their highest rate. When the protocol would refuse a request, the page says why and offers no button. Your own requests, requests with an NFT and sales of running loans are counted, not listed. The order (requests you can fund first, then the highest rate) is a convenience, not advice.

<a id="lend-review"></a>

### Lend: Review and Signing

Before your wallet opens, the review shows every figure: what leaves your wallet, what the borrower receives, the fee and your share of it, the collateral held for you, the rate, the interest owed at the due date, the protocol's share of it, what comes back to you, the grace period and what you can lose. It also states each lifecycle term, even when it is the default. If your wallet holds less than the amount, the review says how much is missing and offers no signature. You tick a box to agree to the Risk Disclosures and Terms; if the figures change before you confirm, the box clears. Your wallet then asks you to sign the terms, which costs nothing, to approve exactly the amount if that is needed, and to send the acceptance, which the app first tries as a dry run. If it stops after an approval, the app asks to put the approval back and says whether that happened. Afterwards the app checks on the chain the loan it opened, what left your wallet and what came back.

<a id="lend-fee"></a>

### Lend: The Fee and the Protocol's Share

The initiation fee is the borrower's: a small share of the amount, charged once in the lending asset and taken from what the borrower receives. You lend the whole amount, and the borrower owes it back in full with interest. Because you send the acceptance yourself, a small share of that fee, the share the protocol pays whoever submits a match, comes back to your wallet; the review shows it. If the borrower chose the Full fee tariff and it applies when the loan opens, the fee is lower, and so is that share. When interest is paid, the protocol keeps its share of it, at the rate in force when the loan opens; your fee-discount tier can lower that share while your fee-discount setting is on. The review shows today's rate and the most that share can take.

<a id="lend-risks"></a>

### Lend: Risks

Lending can lose you money. If the borrower has not repaid by the end of the grace period, the loan defaults and you are paid from the collateral: sold for you where the protocol can, handed to you as-is where it cannot, and a sale can bring in less than you are owed. With liquid collateral, anyone can liquidate the loan once its health factor drops below 1; the sale repays you first, but a sharp fall can leave less than you are owed. An illiquid token is valued at zero, so there is no price-based liquidation, and on default you receive all the collateral, whatever it is worth. You cannot take the amount back before the loan ends; leaving early means selling your position to another lender. With pro-rata interest, an early repayment earns you less. A pause moves the due date later, and interest keeps accruing through it.

<a id="lend-offer"></a>

### Lend: Posting Your Own Offer

When no request fits, you can post your own lending offer for your two tokens: the exact amount you lend, the rate you ask, the term and the collateral a borrower must lock. Posting moves the amount from your wallet into your own vault, where it stays locked while the offer is open. A borrower who takes it opens the loan at once, on your terms, without asking you again: they receive the amount less their initiation fee, and their collateral is locked in their vault for you. While matching is switched on for the network, anyone may also match your offer with a borrower's request; without parts, that loan lends your whole amount at your rate, against at least the collateral you ask for. The review says whether matching is on now. You can cancel from five minutes after posting, and the amount returns to your wallet. A lapsed offer can no longer be taken; its amount stays in your vault until you, or anyone, closes it, and then returns only to your wallet. Until the next app's Offers page is built, you follow, cancel and close an offer on the current app's Offers page; the review says so before anything is locked.

<a id="lend-offer-terms"></a>

### Lend: The Offer's Terms

Unless you set parts in Advanced mode, one borrower takes the whole amount, or nobody does, and must lock exactly the collateral you set. The form shows how much of the lending token your wallet holds. Each figure is read exactly as you type it: more decimals than the token has are refused, never rounded, and the rate goes up to 100% a year with two decimals. The terms offered stop at the longest one the network allows. The offer stays open until taken or cancelled, or for the number of days you choose, up to a year. Full-term interest, the usual choice, means an early repayment does not lower what you earn; pro-rata pays you only for the time the loan is open. You can also let the borrower repay part early. The form shows what the borrower would owe you at the due date if they took the offer now. In Advanced mode an offer can also be lent in parts, carry a fill mode, pay interest on a schedule and take the Full fee tariff.

<a id="rate-check"></a>

### Checking your rate against recent loans

Under the rate on both posting forms, a lender's offer and a borrower's request, the app shows the middle rate of loans that started on the same pair and term in the last 30 days, and how many there were. If your rate is more than five points away, it warns you and says which way it cuts: a lender far under the market, or a borrower far over it, posts the offer taken first when rates move; the other way, the offer may sit untaken. It only warns, and you can still post. When there are no recent loans to compare with, when the collateral is an NFT, or when the protocol's index cannot be read, the form says so instead of staying silent.

<a id="public-queue"></a>

### Networks with a public queue

On Ethereum, BNB Chain and Polygon (and BNB Testnet and Polygon Amoy), a transaction you send waits in a public queue before it is included, and anyone watching that queue, bots included, can see it and act first: take an offer before your cancel lands, or act on a loan before your repayment does. So on those networks the review of posting, taking or cancelling an offer, repaying and adding collateral says so before your wallet opens. Some wallets can send a transaction privately instead; look in your wallet's network or security settings. The app cannot choose that route for you, and sending the usual way changes only who can see the transaction before it lands. Base, Arbitrum and Optimism keep no public queue, so nothing is shown there.

<a id="lend-offer-parts"></a>

### Lend: An Offer in Parts (Advanced)

In Advanced mode a lending offer can be lent in parts. The amount you type stays the whole amount: posting locks all of it, and a borrower taking your offer directly borrows all of it. You add the smallest part one match may lend. While matching is switched on for the network, matchers may lend your offer to several borrowers, each loan between the smallest part and what is left, at your rate. Each asks at least the share of your collateral that matches its part, rounded down, and the review shows what the smallest part asks. Once a match has lent a part, no borrower can take the rest directly; only more matches can, and you can cancel the offer to take the rest back. When less than the smallest part is left, the protocol returns it to your wallet and closes the offer. The review says whether matching is on now; while it is off, only a borrower taking all of it opens a loan. The fill mode works as on a request: partial by default, all or none for one loan of the whole amount (so no parts), or immediate or cancel, which needs an expiry; it cannot be changed after posting. The protocol refuses an offer that asks for less collateral than the whole amount needs at today's prices, and the review names the least it asks. Options set in Advanced still apply if you switch to Basic: the form says so and lets you clear them.

<a id="lend-offer-schedule"></a>

### Lend: An Offer's Interest Schedule (Advanced)

In Advanced mode a lending offer can carry an interest schedule, as a request can: every month, quarter, six months or year. The form offers only the schedules the protocol allows for your terms, and says under each closed one why. With parts, the protocol checks the smallest part when you post, so a smallest part below its threshold closes the finer schedules; each loan is checked again when it opens. The review shows each period's interest if a borrower takes all of it and, with parts, on a loan of the smallest part, and the grace a missed period gets. If a period is not paid by the end of its grace, anyone may sell part of the borrower's collateral to pay it to you, and the loan stays open. The schedule cannot be changed after posting.

<a id="lend-offer-tariff"></a>

### Lend: The Full Fee Tariff on an Offer (Advanced)

In Advanced mode a lending offer can take the Full fee tariff: a fee in VPFI, taken from your vault when each loan from the offer opens, priced for that loan's amount and term. In return, the protocol's share of that loan's interest gets ten more points of discount, up to its 50% cap; the share is still taken in the lending asset. The extra points last for the loan's term: if the loan is extended for a new term, they end for that term. They belong to the lender position, so whoever holds it when interest is paid receives them. The tariff is not refunded. The form shows today's tariff for the whole amount, the largest loan the offer opens. You set the most VPFI one loan may take, and whether a loan that cannot take the tariff is refused or opens without it. A loan can take it only if, at that moment, the tariff is switched on, the lending asset is priced and liquid, its tariff is within your most, and your vault holds enough free VPFI. The tariff is set by a second transaction after the offer posts, so a loan opened from the offer before that transaction confirms, by a borrower or by a match, opens without it.

<a id="lend-offer-review"></a>

### Lend: Reviewing and Posting an Offer

Before your wallet opens, the app asks the protocol to try your offer as a dry run, so the review shows the protocol's own answer. It lists what you lock now, the amount a borrower takes, the collateral they must lock, the rate and term, what the borrower would receive at today's fee rate, the interest at the due date, the protocol's share of it and what comes back to you, every lifecycle term, when the offer lapses, the loan-to-value at today's prices and whether an approval is needed. If your wallet holds less than the amount, the review says how much is missing and offers no signature. You tick a box to agree to the Risk Disclosures and Terms. Your wallet approves exactly the amount if needed, the app tries the offer again, and only then posts it. If it stops after an approval, the app asks to put the approval back and says whether that happened. Afterwards the app checks on the chain the offer recorded and the amount locked in your vault.

<a id="lend-offer-fee"></a>

### Lend: Fees on Your Offer

Posting an offer charges you no fee. The initiation fee is the borrower's: a small share of the amount, charged once in the lending asset when a borrower takes your offer, at the rate in force then, and taken from what they receive. You lend the whole amount, and the borrower owes it back in full with interest. When interest is paid, the protocol keeps its share of it, at the rate in force when the loan opens; your fee-discount tier can lower that share while your fee-discount setting is on. The review shows today's rate and the most that share can take; if that rate cannot be read, the review says so instead of showing a figure.

<a id="positions"></a>

### Positions: Your Loan Positions

Positions lists every loan you lent or borrowed in on this network, from the position tokens your wallet holds, so a position you transferred to someone else leaves your list. Payouts ready to collect come first and open Claims. Live loans follow, the most urgent deadline first, as on Home. Ended loans come last, each with how it ended: repaid, defaulted, settled, or closed by a match. An ended loan whose payout is still waiting points you to Claims.

All, Lent and Borrowed narrow the three lists at once. Positions says you have nothing only after reading everything; if a list could not be read in full, it says so. Each loan opens its own page, which shows the actions open to you. The list itself never signs anything.

<a id="position"></a>

### Position: One Loan

Each loan has its own page. It starts with the loan's status, then your role: the side your wallet holds now, since position tokens can be sold or transferred. If you hold neither side, you are viewing. A deadline that needs you is worded for your side. Once the grace period is over, the page says anyone may now start the default, and only when the protocol confirms it.

Below that come the loan's dates (the due date of its current term before any pause credit, any time added while the protocol was paused, the due date and the end of the grace period), its terms as they stand now (a partial repayment lowers the principal still owed), its health factor, and where its collateral is held. A figure that could not be read is shown as unknown. If the collateral has no price, a default hands the lender the collateral itself, and the page says so. Where the network holds a band just above the liquidation threshold for an internal match with another loan, the page states it: inside that band no outside sale can close the loan. An NFT rental has no collateral: if it defaults, the renter's use ends, the prepaid rent goes to the lender less the protocol's share, and the buffer goes to the treasury. Repaying in full, paying part, adding collateral and taking it back are its first actions; the others come in later updates.

<a id="repay"></a>

### Repay in Full

On a running loan, the page offers to repay it in full. Anyone may repay except the lender. If you do not hold the borrower position, paying gives you no right to the collateral: only its holder can collect it. Repaying is held once the grace period has ended (the loan then goes to default), and while a swap-to-repay order is pending.

What you owe grows by the second, and the protocol takes the amount as of the moment your repayment confirms. The review shows two figures: what it costs now, and what it would cost about thirty minutes ahead. Your wallet approves exactly the second figure. If you had already approved more, even an unlimited amount, it is lowered to that figure for the repayment, since the repayment takes no maximum of its own. The approval limits the amount, not the time: a repayment that confirms later goes through only while what is owed still fits within it, and is otherwise refused with nothing moved. On a loan that charges the full term, the amount does not grow before the due date, so a later repayment can still go through. Whatever it does not use of the approval is put back afterwards. Then the borrower collects the collateral and the lender collects principal and interest on Claims.

<a id="interest-schedule"></a>

### Interest Schedule

A loan with an interest schedule owes interest every period (a month, a quarter, six months or a year), not only at the end. Its page shows the current period: when it ends, when its grace period ends, the interest it owes, what has been paid toward it and what is still owed. The interest for a period is figured on the principal and rate as they stand now, so a partial repayment lowers it.

Once a period and its grace are over, anyone may settle it. A paid period only moves the checkpoint forward; one that is still short sells just enough of the borrower's collateral to cover what is owed and the sale's charges. The page says whether settling is open now. It names the network's periodic-settlement switch when it is off (then nothing can be settled and no collateral is sold), and the protocol pause while it lasts (settlement stops, and the paused time is added to the period's dates). A pause moves the period's dates later by the paused time, but the interest a period owes stays one period's worth; interest keeps accruing through the pause, and any interest a repayment pays counts toward the period.

<a id="partial-repay"></a>

### Paying Part of a Loan

The holder of the borrower position can pay part of a running loan's principal from its page, when the loan's terms allow it. Type the principal part: the protocol takes at least its minimum part for the lending token, and less than the whole principal (paying all of it is Repay in full). The interest accrued since the loan's interest was last paid is added on top. The loan keeps running with the lower principal, and its due date does not move.

The review shows the part, the interest, the principal left and what the approval covers. On a pro-rata loan before its due date the interest is exact. On a full-term loan, or past the due date, it reads "at most": the protocol figure the app reads also counts the rest of the term or a late fee, which a part payment does not charge. Paying part is held while a refinance request on the loan or an offset offer on the borrower position is live, and once the grace period has ended.

<a id="add-collateral"></a>

### Adding Collateral

The holder of the borrower position can add collateral to a running loan from its page. Adding collateral raises the loan's health factor and lowers its loan-to-value, which keeps it further from liquidation. You add more of the same token the loan already holds: the protocol takes no other, and it takes a top-up only for collateral it prices now. Type the amount; the form shows what your wallet holds.

The review shows the collateral now and after, where it is held (your vault, locked to the loan until it ends), and the loan's health factor and loan-to-value now. Your wallet approves exactly the amount if your approval does not already cover it, and the app first tries the top-up as a dry run. Afterwards the app shows the protocol's own health factor and loan-to-value after the top-up. Adding collateral stays open even while the protocol is paused. A loan in fallback returns to running if the top-up restores the protocol's opening limits; otherwise the collateral is added and the loan stays in fallback. Collateral you add can be lost with the rest if the loan is liquidated or defaults. If you took over the borrower position and the loan is in fallback, the top-up goes to the vault of the borrower the loan records, and moves to yours only if it returns the loan to running.

<a id="take-back-collateral"></a>

### Taking Back Collateral

While a loan runs, the holder of the borrower position can take back collateral above what the loan needs, from the loan's page. The protocol works out the most that can be taken back so that the health factor stays at or above the loan's minimum and the loan-to-value within its opening cap. That limit moves with prices and as interest accrues, and the form shows it as you type. Taking back collateral moves the loan closer to liquidation.

The review shows the collateral now and after, that it goes from your vault to your wallet, the limit now, and the loan's health factor and loan-to-value now. No approval is needed, so your wallet asks once, after the app tries the withdrawal as a dry run. The protocol checks its limits again when the withdrawal confirms: if prices moved and the amount no longer fits, it is refused and nothing moves. A protocol pause, a pending swap-to-repay order, a standing refinance request or a lender's sale listing holds it, and the protocol lets collateral be taken back only for a token it prices. If your account has protected mode on, the collateral waits in its payout queue for the account's delay before reaching your wallet, and the review says so.

<a id="collect-a-payout"></a>

### Collecting a Payout

When a loan ends, the protocol records what each side is owed, and the holder of each position collects it from the loan's page or from Claims. It pays whoever holds the position now, so a position you bought pays you. The lender's payout is the principal and interest, or what a default or liquidation recovered, plus any funds held for the lender and, on a rental, the NFT that was rented out. The borrower's payout is the collateral back or what was left over, plus any surplus held for the borrower. Collecting burns your position token, and once both sides have collected, the loan is settled.

The review lists every payout the claim makes, what past sellers of a lender position take first (interest they earned and were not paid), and where the payment lands: your wallet, or, with protected mode on, your account's payout queue or your vault. No approval is needed, so your wallet asks once, after the app tries the claim as a dry run. A protocol pause stops every claim. While a loan is in fallback, the borrower's payout waits until the lender collects, and the lender collecting ends the fallback: the borrower can no longer cure it. The finish card shows what the transaction actually paid.

<a id="claim-everything"></a>

### Claim Everything

Claims opens with Claim everything: every payout you can collect right now, gathered into one transaction. It lists loan payouts on ended loans whose position you hold, interaction rewards, the un-lent capital of your standing offers, free VPFI in your vault and, if you are a payee, withdrawable payroll. Each payout has a switch, so you can leave any of them out. Free vault VPFI is off unless you turn it on, because it sets your fee-discount tier, and so is the capital of a standing offer that is still lending. Interest owed to you from a position you sold, and a loan in fallback, are collected on their own. Each payout runs on its own inside the transaction: one the protocol refuses is skipped and stays listed, and the rest still pay. One transaction carries at most 30 payouts; the rest wait for a second one. Nothing leaves your wallet, so your wallet asks once, after a dry run, and the finish card shows each payout collected or skipped and where the money landed. A pause stops every claim.

<a id="payout-queue"></a>

### Payouts Waiting in Your Queue

With protected mode on, everything leaving your vault for your wallet waits out your account's delay in a payout queue. Claims lists what waits there, soonest first, each with a short request code: every alert about a payout prints the same code, so you can match a message to a request. Each row says what it pays, where it goes and when it can be released. Once a payout is due, anyone can release it, and it only ever pays the destination it recorded; if that destination is no longer allowed, releasing it cancels it instead. You, or one of your secondary signers, can cancel a payout at any time, even during a pause, and the asset stays in your vault. If your account requires approval, a secondary signer approves each payout first; a signer finds your account in Advanced mode by pasting its address. A pause holds releases until it ends or, after a long pause, its escape route opens. Each action asks your wallet once, and the finish card shows what the transaction did.

<a id="seller-interest"></a>

### Interest from a Position You Sold

When you sell a lender position, the interest you earned while you held it, and were not yet paid, stays yours as a claim on the loan. Claims lists every loan where you hold such a claim, with what you are owed after the protocol's share of interest and what already waits in your vault. While the loan runs, each interest payment pays the open claims first, oldest first, into each seller's own vault; until some reaches yours there is nothing to withdraw. Once the loan has ended, withdrawing first splits what the lender side recovered: the holder's principal first, then each seller's claim, oldest first. Every open claim closes then, and whatever a claim is not paid stays unpaid. The loans are found in the app's index; if it cannot list them, look a loan up by its number, which reads the chain alone. No approval is needed, so your wallet asks once, after a dry run, and the finish card shows what the transaction paid.

<a id="frozen-proceeds"></a>

### When a Payout Is Frozen

If the sanctions screen flags your wallet, the protocol takes nothing you are owed and never stops a loan from closing: the other party still receives what its side recovers. Your share is parked in a vault, locked, and released once your wallet is de-listed. Claims and the loan's page then say "Frozen, awaiting de-listing" and offer no button to collect. If the screen cannot be read and your wallet was confirmed flagged before, a frozen payout stays locked until the screen answers again, and a payment due to your wallet in that time is parked the same way, since the protocol still treats it as flagged; an outage alone never freezes a wallet never confirmed flagged. On a running loan, the loan's page also shows what the loan already paid that is reserved for the lender position until the lender collects it, and a repaid loan says when it waits for a surplus the borrower has not yet collected.

<a id="extension-reserves"></a>

### Extension Reserves

If you hold a loan's borrower position, you can set aside the loan's token in your own vault for its extensions. An extension, the keeper's or your own, draws on that reserve first. The reserve stays yours. Claims lists every loan where you have some left, and says whether an extension can still draw on it: only while the loan runs and you hold its borrower position. You can take the whole reserve back at any time while the protocol is not paused, whatever the loan's state; if the loan is still running, its next extension then draws on your other balance of the token instead. The loans are found in the app's index; if it cannot list them, look a loan up by its number. No approval is needed, so your wallet asks once, after a dry run, and the finish card shows where the money landed.

<a id="vault-holdings"></a>

### Your Vault

Vault shows your own vault on the network you are connected to: its full address, with a link to the explorer. It is a contract the protocol keeps for your wallet alone; nothing in it is pooled with anyone else's, and assets leave it only by the protocol's rules. If you have no vault yet, the page says so and offers to create one; your first deposit or offer would create it anyway. Creating it moves nothing and asks no approval, so your wallet asks once. Each asset shows three figures from the protocol: In your vault (what the protocol counts as yours there), Free to withdraw now, and Held by your positions (what your loans, offers, claims, reserves or queued payouts keep). A token sent to your vault by a plain transfer is not counted and cannot be withdrawn until you adopt it; the row says so and links to where you adopt or disown it. The page lists the assets you deposited and the assets your loans, the offers you made and your standing offers name, so a token sent by a plain transfer shows only if one of those names it. Small and empty rows are hidden behind a switch that counts them. VPFI in your vault sets your fee-discount tier; holding it for that does not pledge it, and VPFI you pledge to a loan or offer shows as held. Each asset with something free has a Withdraw button.

<a id="vault-deposit"></a>

### Deposit into your vault

Deposit on the Vault page moves a token or an NFT from your wallet into your own vault, outside any loan. Choose what to deposit: a suggested token or test collection, or paste an address; whether it is a token, an NFT or a multi-token collection is read from its contract. Then type the amount, the NFT's token id, or the token id and how many. If Terms of Service are in force that you have not accepted, the app asks for them first, and asks again before you sign if you switch to a wallet that has not accepted them. The review says what leaves your wallet and into which vault; if you have no vault yet, the deposit creates it. A token asks for an approval of exactly the amount, an NFT for that one token only, and a multi-token collection for an approval that is taken back right after the deposit, in one more wallet step. The protocol checks the deposit before your wallet sends it, and refuses a token that does not arrive in full, such as one that charges a fee on transfer. If the deposit does not go through, the app asks to put an approval back. What arrives is counted as yours. Without protected mode you can withdraw it at once; with it, a withdrawal waits out your account's delay, and nothing leaves while the account is locked. The review says which applies. While the protocol is paused, deposits are closed.

<a id="vault-withdraw"></a>

### Withdraw from your vault

Withdraw on an asset of the Vault page takes what is free back to your wallet. Free means not held by any loan, offer, claim, standing offer or queued payout; the protocol's own figure decides, and the form shows it and refuses more. An NFT your deposit record names only by its collection is withdrawn by typing its token id under that collection. The app withdraws only to the wallet that signs. The review says what leaves which vault and where it goes. Without protected mode it reaches your wallet at once. With it, the protocol queues it for your account's delay, with a secondary signer's approval if your account requires one; you can cancel a queued withdrawal from the payout queue on the Claims page, and it then stays in your vault. While the account is locked nothing can be withdrawn. Nothing leaves your wallet and no approval is asked. While the protocol is paused, withdrawals are closed until its escape route opens; see When the protocol is paused.

<a id="vault-safety"></a>

### Account safety

The Account safety card on the Vault page shows whether your account runs protected mode, its delay, whether a secondary signer must approve each release, whether your position NFTs are protected, how many payouts wait in its queue, and every change still pending. Turning protected mode on makes every payout from your vault to your wallet wait a delay, so a thief who takes your wallet cannot empty your vault before you notice; a payment to you from anyone else's vault lands in your vault instead, and nothing you owe others is delayed. In Basic mode the delay is the shortest the protocol allows, two days, and position NFT protection stays off; Advanced mode lets you choose up to five days and protect your position NFTs. Lock now cancels every queued payout (the assets stay in your vault), stops new positions and drops every pending change; repaying and adding collateral keep working, and a lock works even during a pause. Unlocking is a request that takes effect only after your account's delay; once it is due, Apply due changes applies it, together with any other change that is due. Your payout queue is shown under the card. If the protocol on this network has no protected mode, the card says it is unavailable; if it cannot be read, the card offers no control and says not to assume it is off. Each action asks your wallet once, and the finish card shows what the protocol recorded.

<a id="vault-escape"></a>

### When the protocol is paused

While the protocol is paused, the Vault page says so at the top: withdrawals are closed, while full and partial repayment and adding collateral stay open. If the pause is an administrative one, it also says when its escape route opens, as the protocol reports it, with a countdown. Once the route is open, Withdraw on any asset with something free takes what is yours straight back to your wallet; the review says it goes through the escape route, and the route never returns what a loan, offer or claim holds. With protected mode on, your withdrawals still wait your account's delay in the payout queue, as usual. An automatic pause, or a protocol not yet launched, opens no escape route, and the page says none is scheduled.

<a id="my-offers"></a>

### Your offers

Offers lists every offer you made on the network you are connected to, and every offer whose position token you hold now, newest first. Each shows the state the protocol reports: open, filled, sold, expired or cancelled, and the filters above the list count each state. A borrowing request reads as sold when its collateral was sold through its marketplace listing before anyone accepted it: no loan opened, and the sale's proceeds went to the creator's vault. An open offer keeps what it lends or pledges in your vault until it is filled or cancelled; an expired one keeps it there until it is cleaned up. When the protocol cancels an offer that nothing filled, it clears the offer's terms, so the page shows only its number and state. If another wallet holds the position token of an offer you made, you can still cancel it and its return comes to you; if you hold one that another wallet made, only that wallet can cancel it before it expires. Below your offers is the offer book, described next.

<a id="offer-book"></a>

### The offer book

Below your offers, the offer book lists every open offer on the network, newest first; it is read only once you connect a wallet. Tabs split loans of a token from NFT rentals, a filter shows lenders' offers, borrowers' requests or both, and once connected you can hide your own offers. Older offers load with Show older offers; the filters apply to what has been read, and the count line says how many that is. The book comes from the protocol's index, which can lag the chain by a few minutes, so it only points you at offers: open one to see it as the chain holds it. An offer past its expiry is tagged expired; anyone may clean it up, and what it locked returns to its creator. If the index cannot be read, the book says so instead of showing no offers.

<a id="offer-detail"></a>

### An offer's page

Each offer has its own page, read from the chain once a wallet is connected. It shows who posted it, the amount, what is already filled, the collateral, the term and when the offer lapses. From there you can take an open loan offer whole, through the same review and consent as Borrow and Lend: borrow from a lender's offer, or fund a borrower's request. Cancel and Clean up work there as they do on your offers. Rentals, offers with NFT collateral, sales of a running loan and early-close offers are taken in the current app for now, and the page links to it. An offer is not reserved while you review it; someone else may take or cancel it first.

<a id="offer-cancel"></a>

### Cancel an offer

Cancel on an open offer you made takes it off the book and returns what it still locks in your vault: a lending offer's unlent amount or its NFT, a request's unused collateral, or a rental request's prepaid fee and buffer. An offer nothing has filled cannot be cancelled in its first five minutes, so a cancel never races someone's accept; the review says when it can be, and lifts the block by itself. Part of an offer already filled stays filled. An expired offer has a Clean up button that returns what it locked in the same way; anyone may clean up an expired offer, and the return always goes to its creator. The review says what returns and where: without protected mode it reaches your wallet at once; with it, it waits your account's delay in the payout queue, or stays in your vault while the account is locked. Where the app cannot size the return, such as for an offer tied to a running loan, the review says so and the finish card shows what moved. While the protocol is paused, cancelling is closed. Nothing leaves your wallet and no approval is asked, so your wallet asks once.

<a id="risk-access"></a>

### Risk Access: Your Risk Level

Every account starts at the lowest risk level, blue-chip assets only, and only you can raise it. A pair needs the level of its riskier token: blue-chip tokens need nothing, other liquid tokens need “Liquid assets”, and an illiquid token needs “Any asset, including illiquid ones” plus your agreement to that exact pair. When taking an offer or posting a request needs a step like this, the review says so in place and offers it as one wallet confirmation with its own receipt: what changes, which pairs it reaches, when it takes effect, and that no funds move. Raising your level, or agreeing to a pair, can wait out a period the protocol sets; for a raised level the app shows the time it takes effect, read from the chain, for an agreement it says the protocol does not publish that time yet, and it never offers the same step twice, because a second one would start the wait over. Lowering your level always takes effect at once. When the protocol publishes new risk terms, your level and agreements stop counting until you confirm them again. If you turned on strict mode, each liquid pair also needs your acknowledgement. A block that comes from the lender's own risk level is shown as theirs: nothing in your account would change it.

<a id="terms-gate"></a>

### The Terms Prompt

Where a Terms of Service version is in force, the app asks you to
accept it before an action that starts something new, such as
turning on the fee discount, and names the action that asked. It
shows the version, a fingerprint of its text and a link to that
exact version, whose text never changes. Accepting is one wallet
confirmation and moves no funds. If the app cannot read whether you
accepted, it says so and lets you try again instead of treating it
as a no. Repaying, claiming, withdrawing your own assets, cancelling
your own offers and turning a consent off are never held back.

<a id="settings"></a>

### Settings

Settings is at the foot of the menu. Mode, theme and language need no wallet and stay in this browser. The theme follows your device until you choose one, and a language not translated yet shows English until it is. With a wallet connected, Settings shows which Terms of Service version you accepted on this network, or that a version is in force and not accepted yet; you are asked at the first action that needs it, never there. The fee-discount setting is the same one as on Home. Settings also says what this browser keeps for the app, that nothing secret is stored, and that the app sends no error reports or diagnostics. Settings can also download the app's records in this browser as a file, or erase everything this site keeps here. Before you erase, it says how many items will go; erasing disconnects your wallet, resets mode, theme and language, and then shows what was removed. Your positions on chain, your alert settings with the alert service, the marketing site and your wallet app are not affected.

Settings also shows your risk level on this network in words, whether this network enforces it, and whether strict mode is on. If new risk terms stopped your level from counting, you can confirm it again there in one wallet step. To raise or lower your level, or to turn strict mode on or off, switch to **Advanced** mode: each change is one wallet confirmation with its own receipt, and moves no funds. Lowering takes effect at once and closes pairs above the new level to new offers and requests, your own open ones included; loans you already have are not affected. Raising can wait out the protocol's period, and the app shows when it counts.

Settings also lists the standing approvals your wallet gives the protocol on this network: how much of a token it may move without asking you again, or an approval over an NFT collection or a single NFT. Each can be withdrawn in one wallet confirmation, which moves no funds. The list checks the suggested assets and every asset your deposits, loans and offers here name, and you can add another token to check; an approval for any other token is not found there, so your wallet can show the rest. If another approval also covers the same asset, such as the whole collection's for one NFT, the review names it as staying after the withdrawal.

Settings also shows whether keepers may act for your wallet on this network, and which keepers you approved. Everything starts off. A keeper acts only while keeper access is on and it holds the action; a step on a loan also needs that loan or offer to name the keeper. A keeper never receives your funds and cannot claim, withdraw or transfer anything. You can turn keeper access off or remove a keeper in one wallet confirmation in either mode; to turn access on, approve a keeper or change what it may do, switch to **Advanced** mode.

You can also install the app on your phone or computer, so it opens from your home screen or app list with shortcuts to Offers, Positions, Vault and Alerts. Use your browser's Install app or Add to Home Screen option (on an iPhone or iPad: Safari, then Share, then Add to Home Screen), or, in **Advanced** mode, Install the app in Settings where your browser offers it. The app keeps copies of its own code files so it opens faster; your positions and every figure are always read from the network.

<a id="rent-review"></a>

### Rent: Renting an NFT

Rent, in the menu, lists the NFTs owners have listed for rent on your network; when nothing is listed on a test network, it points you to the faucet for a test NFT and test tokens. A rental gives you the right to use an NFT for a set number of days, never the NFT itself: it stays in the owner's vault, which records you as its user until the rental ends. Open a listing and choose Rent this NFT. The review shows what moves from your wallet into your own vault: the daily fee for the whole term plus a buffer, a small share of the rent that the listing fixed when it was posted. It also shows the rent rule (pro-rata, the days you use with a part day counted as a whole day, or full term), what comes back when you close on time, the grace period and the late fee taken from the buffer. A rental has no collateral and no health factor. If your wallet holds less than the rent plus buffer, the review says so before any wallet step. Your wallet then asks you to sign the terms, which costs nothing, to approve exactly that amount if needed, and to start the rental, which the app first tries as a dry run. Afterwards the app checks on the chain the rental it started, the payment into your vault and that you are now the NFT's user. Taking a renter's request is done on the current app for now.

<a id="rent-risks"></a>

### Rent: Risks

You never own a rented NFT, and your right to use it ends when the rental ends. The rent and buffer stay in your vault for the rental and cannot be withdrawn while it is open. A rental does not close by itself at the end of its term: close it from its page in the current app, since the next app cannot close a rental yet. Closing during the grace period costs a late fee, taken from the buffer; after the grace period the rental defaults, the rent left in your vault goes to the owner and the buffer to the protocol, and nothing comes back to you. With full-term rent the whole term is owed even if you close early.

<a id="rent-list"></a>

### Rent: Listing Your NFT for Rent

On Rent, List an NFT for rent opens a short form: the collection (a test collection on a test network, or a pasted address), the token's number and, for a multi-token collection, the quantity; the token renters pay in; the daily fee, a single figure; the term in days; the rent rule, pro-rata or full term; and how long the listing stays open. There are no collateral or rate fields: a rental has neither. The review shows that the NFT moves from your wallet into your own vault, what a renter pays up front, the buffer share this listing fixes at today's setting, what you receive (the rent due, less the protocol's share, which is fixed when a renter takes the listing), the grace period and what a default does. If your wallet does not hold the NFT, the review says so before any wallet step. Your wallet then asks you to let the protocol move that one token (for a multi-token collection, the whole collection for this listing only, taken back in one more step afterwards) and to post the listing, which the app first tries as a dry run. Afterwards the app checks on the chain that the listing was recorded and the NFT reached your vault, and links to the listing's page.

<a id="rent-list-risks"></a>

### Rent: Risks of Listing

The NFT stays in your vault while the listing is open and while it is rented, and you cannot withdraw it until the listing or the rental ends. While nobody has rented it, you can cancel the listing from its page after its first five minutes. Once rented, the renter holds the right to use the NFT until the rental ends, and you cannot take that right back early. A rental does not close by itself: the renter closes it, or after the grace period anyone can close it as a default; then the rent comes to you and the buffer goes to the protocol. A listing that lapses keeps the NFT in your vault until it is closed.

<a id="rent-request"></a>

### Rent: Asking to Rent an NFT

On Rent, Post a rental request opens the same short form as a listing, worded for you as the renter: the collection and the token's number (and, for a multi-token collection, the quantity), the token you pay in, the daily fee as a single figure, the term in days, the rent rule and how long the request stays open. The review shows that the rent for the whole term and a buffer move from your wallet into your own vault now, the buffer share this request fixes at today's setting, that the term runs from when an owner takes the request, and that an owner who takes it starts the rental at once, with no further step from you. If your wallet holds too little, or already holds that NFT, the review says so before any wallet step; a token that does not exist yet is noted. Your wallet then approves exactly the rent and buffer and posts the request, which the app first tries as a dry run. Afterwards the app checks on the chain that the request was recorded and the rent and buffer reached your vault, and links to the request's page.

<a id="rent-request-risks"></a>

### Rent: Risks of a Rental Request

The rent and buffer stay in your vault while the request is open, and you cannot withdraw them until you cancel it or it ends. While no owner has taken it, you can cancel the request from its page after its first five minutes, and they come back to your wallet. An owner who takes it starts the rental at once on exactly these terms: you hold the right to use the NFT, never the NFT itself. A rental does not close by itself: close it from its position page. Closing late costs a late fee from the buffer, and if it defaults the rent goes to the owner and the buffer to the protocol. A request that lapses keeps the rent and buffer in your vault until it is closed.
