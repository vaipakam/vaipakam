# Welcome to Vaipakam

Vaipakam is a peer-to-peer lending platform. You lend assets and earn
interest. You borrow assets and post collateral. You rent NFTs and the
owner gets daily fees. Everything happens directly between two
wallets, with the smart contracts holding the assets in escrow until
the loan or rental ends.

This page is the **friendly tour**. If you want technical depth, use
the **User Guide** tab for per-screen help, or the **Technical** tab
for the full whitepaper. If you just want to know "what is this and
how do I use it" — keep reading.

---

## What you can do

Vaipakam is for four kinds of people:

- **Lenders** — you have an asset (USDC, ETH, USDT, etc.) sitting
  idle. You'd like it to earn interest while staying safe. You post a
  lender offer; a borrower accepts; you earn interest on your terms.
- **Borrowers** — you need cash for a few days, weeks, or months and
  you don't want to sell your collateral (because you think it'll go
  up, or because it's an NFT you can't part with). You post your
  collateral; you get the loan; you pay it back at the agreed rate.
- **NFT owners** — you have a valuable NFT that grants in-game or
  in-app utility. Selling it would mean losing the utility forever.
  Renting it out lets someone else use it for a few days while you
  keep ownership and collect daily rent.
- **NFT renters** — you want temporary access to an NFT (a game asset,
  a membership pass, a domain) without paying full price. You rent it,
  use it during the rental window, and the owner keeps the asset.

You don't sign up. You don't fill in a profile. You connect a wallet
and you can lend, borrow, or rent.

---

## How a loan works (concrete example)

Say you have **1,000 USDC** sitting in your wallet on Base. You'd
like to earn interest. Here's the full lifecycle.

### Step 1 — Create an offer

You open the Vaipakam app, connect your wallet, and click **Create
Offer**. You're a lender, so you fill in:

- I'm lending **1,000 USDC**
- I want **8% APR**
- Acceptable collateral: **WETH**, with **maximum 70% LTV**
- Loan duration: **30 days**

You sign one transaction. Your 1,000 USDC moves from your wallet into
your **personal escrow** (a private vault that only you control). It
stays there until a borrower accepts your offer.

### Step 2 — A borrower accepts

Maybe an hour later, someone else sees your offer in the **Offer
Book**. They have WETH and want to borrow USDC against it for a
month. They click **Accept** and post WETH worth, say, $1,500
(an LTV of about 67% — under your 70% cap, so the offer accepts).

The instant they accept:

- Your 1,000 USDC moves from your escrow to theirs
- Their WETH is locked in their escrow as collateral
- Both of you receive a position NFT — yours says "I'm owed 1,000 USDC
  + interest"; theirs says "I'm owed my WETH back when I repay"
- The loan clock starts ticking

A small **Loan Initiation Fee (0.1%)** is taken from the loaned
amount and routed to the protocol treasury. So the borrower receives
999 USDC, not 1,000. (You can pay the fee in **VPFI** instead and the
borrower receives the full 1,000 — more on VPFI below.)

### Step 3 — Time passes; the borrower repays

After 30 days, the borrower owes you the principal plus interest:

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

They click **Repay**, sign a transaction, and 1,006.58 USDC moves
into the loan settlement. From this:

- You receive **1,005.51 USDC** (principal + interest minus a 1%
  Yield Fee on the interest portion only)
- The treasury receives **1.07 USDC** as the Yield Fee
- The borrower's WETH is unlocked

You see a **Claim** button on your dashboard. You click it and the
1,005.51 USDC moves from settlement into your wallet. The borrower
clicks claim and their WETH moves back to their wallet. The loan is
closed.

### Step 4 — What if the borrower doesn't repay?

Two things can go wrong, and the protocol handles each automatically.

**The collateral price crashes mid-loan.** Vaipakam tracks every
loan's **Health Factor** (a single number that compares collateral
value to debt). If it dips below 1.0, anyone — yes, anyone, including
a passing bot — can call **Liquidate**. The protocol routes the
collateral through up to four DEX aggregators (0x, 1inch, Uniswap,
Balancer), takes the best fill, pays you back what you're owed, gives
the liquidator a small bonus, and returns any leftover to the
borrower.

**The borrower disappears past the due date.** After a configurable
**grace period** (an hour for short loans, two weeks for year-long
ones), anyone can call **Default**. Same liquidation path runs.

In rare cases — every aggregator returns a bad price, or the
collateral has crashed badly — the protocol *refuses to dump* into a
bad market. Instead, you receive the collateral itself plus a small
premium, and you can hold or sell it whenever you choose. This
**fallback path** is documented up front and you accept it as part of
the loan terms.

### Step 5 — Anyone can repay

If a friend or a delegated keeper wants to pay off your borrower's
loan, they can. The collateral still goes back to the borrower (not
to the helpful third party). It's a one-way door: paying for someone
else's loan doesn't get you their collateral.

---

## How NFT rentals work

Same flow as a loan, with two differences:

- **The NFT stays in escrow**; the renter never holds it directly.
  Instead, the protocol uses **ERC-4907** to give the renter "user
  rights" on the NFT for the rental window. Compatible games and apps
  read user rights, so the renter can play, log in, or use the NFT's
  utility without owning it.
- **Daily fees auto-deduct** from a prepaid pool. The renter prepays
  the entire rental upfront plus a 5% buffer. Each day the protocol
  releases that day's fee to the owner. If the renter wants to end
  early, the unused days refund.

When the rental ends (by expiry or by default), the NFT returns to
the owner's escrow. The owner can then re-list it or claim it back to
their wallet.

---

## What protects me?

Lending and borrowing on Vaipakam isn't risk-free. But the protocol
has several layers built in:

- **Per-user escrow.** Your assets sit in your own vault. The
  protocol never pools them with other users' funds. This means a bug
  affecting another user can't drain you.
- **Health Factor enforcement.** A loan can only start if collateral
  is at least 1.5× the loan value at origination. If the price moves
  against the borrower mid-loan, anyone can liquidate before the
  collateral is worth less than the debt — protecting the lender.
- **Multi-source price oracle.** Prices come from Chainlink first,
  then cross-checked against Tellor, API3, and DIA. If they disagree
  by more than a configured threshold, the loan can't open and an
  ongoing position can't be liquidated unfairly. An attacker would
  need to corrupt **multiple independent oracles in the same block**
  to fake a price.
- **Slippage cap.** Liquidations refuse to dump collateral at worse
  than 6% slippage. If the market is too thin, the protocol falls
  back to giving you the collateral directly.
- **L2 sequencer awareness.** On L2 chains, liquidation pauses
  briefly when the chain's sequencer just came back from downtime, so
  attackers can't use the stale-price window to grief you.
- **Pause switches.** Every contract has emergency pause levers so
  the operator can stop new business in seconds if something looks
  wrong, while letting existing users wind down their positions
  safely.
- **Independent audits.** Every contract on every chain ships only
  after third-party security review. Audit reports and bug bounty
  scope are public.

You should still understand what you're signing up for. Read the
combined **risk consent** that appears before every loan — it
explains the abnormal-market fallback path and the in-kind settlement
path for illiquid collateral. The app won't let you accept until you
tick the consent box.

---

## What does it cost?

Two fees, both tiny:

- **Yield Fee — 1%** of the **interest** you earn as a lender (not
  1% of principal). On a 30-day 8% APR loan of 1,000 USDC, the lender
  earns ~6.58 USDC of interest, of which ~0.066 USDC is the Yield
  Fee.
- **Loan Initiation Fee — 0.1%** of the lending amount, paid by the
  borrower at origination. On a 1,000 USDC loan, that's 1 USDC.

Both fees can be **discounted up to 24%** by holding VPFI in escrow
(see below). On default or liquidation, no Yield Fee is collected on
the recovered interest — the protocol doesn't profit from a failed
loan.

There are no withdrawal fees, no idle fees, no streaming fees, no
"performance" fees on principal. The only money the protocol takes
is the two numbers above.

---

## What's VPFI?

**VPFI** is Vaipakam's utility token. It does three things:

### 1. Fee discounts

If you hold VPFI in your escrow on a chain, it discounts your
protocol fees on loans you participate in on that chain:

| VPFI in escrow | Fee discount |
|---|---|
| 100 – 999 | 10% |
| 1,000 – 4,999 | 15% |
| 5,000 – 20,000 | 20% |
| Above 20,000 | 24% |

Discounts apply to both lender and borrower fees. The discount is
**time-weighted across the loan's life**, so topping up just before
a loan ends doesn't game the calculation — you earn the discount in
proportion to how long you actually held the tier.

### 2. Staking — 5% APR

Any VPFI sitting in your escrow automatically earns staking rewards
at 5% annual yield. There's no separate staking action, no lock-up,
no "unstake" wait. Move VPFI into your escrow and it earns from that
moment. Move it out and accrual stops.

### 3. Platform interaction rewards

Every day, a fixed pool of VPFI is distributed to lenders and
borrowers proportional to the **interest** moved through the
protocol. You earn a share if you earned interest as a lender, or
if you paid interest cleanly as a borrower (no late fees, no
default).

The reward pool is biggest in the first six months and tapers over
seven years. Early users get the largest emissions.

### How to get VPFI

Three paths:

- **Earn it** — by participating (interaction rewards above).
- **Buy it** — at a fixed rate (`1 VPFI = 0.001 ETH`) on the
  **Buy VPFI** page. The fixed-rate program is capped per wallet
  per chain.
- **Bridge it** — VPFI is a LayerZero OFT V2 token, so it moves
  between supported chains using the official bridge.

---

## Which chains?

Vaipakam runs as an independent deployment on each supported chain:
**Ethereum**, **Base**, **Arbitrum**, **Optimism**, **Polygon zkEVM**,
**BNB Chain**.

A loan opened on Base settles on Base. A loan opened on Arbitrum
settles on Arbitrum. There's no cross-chain debt. The only thing that
crosses chains is the VPFI token and the daily reward denominator
(which makes sure rewards are fair across busy and quiet chains).

---

## Where to start

If you want to **lend**:

1. Open the Vaipakam app, connect your wallet.
2. Go to **Create Offer**, pick "Lender".
3. Set your asset, amount, APR, accepted collateral, and duration.
4. Sign two transactions (one approval, one create) and your offer is
   live.
5. Wait for a borrower to accept. The dashboard shows your active
   loans.

If you want to **borrow**:

1. Open the app, connect your wallet.
2. Browse the **Offer Book** for an offer that matches your
   collateral and the APR you can pay.
3. Click **Accept**, sign two transactions, and you receive the loan
   amount in your wallet (minus the 0.1% Loan Initiation Fee).
4. Repay before the due date plus grace period. Your collateral
   unlocks back to your wallet.

If you want to **rent or list an NFT**:

Same flow, but on the **Create Offer** page you pick "NFT rental"
instead of ERC-20 lending. The form will guide you.

If you just want to **earn passive yield on your VPFI**, deposit it
into your escrow on the **Dashboard** page. That's it — staking is
automatic from that moment.

---

## A note on what we *don't* do

A few things that other DeFi platforms do that we deliberately
**don't**:

- **No pooled lending.** Every loan is between two specific wallets
  with terms they both signed up for. No shared liquidity pool, no
  utilization curve, no surprise rate spikes.
- **No proxy custody.** Your assets sit in your own escrow, not in a
  shared vault. The protocol moves them only on actions you sign.
- **No leveraged loops by default.** You can rebroadcast borrowed
  funds as a new lender offer if you want, but the protocol doesn't
  build automatic looping into the UX. We think that's a footgun.
- **No surprise upgrades.** Escrow upgrades are gated; mandatory
  upgrades show up in the app for you to apply explicitly. Nothing
  rewrites your vault behind your back.

---

## Need more?

- The **User Guide** tab walks through every screen of the app one
  card at a time. Good for "what does this button do?" questions.
- The **Technical** tab is the full whitepaper. Good for "how does
  the liquidation engine actually work?" questions.
- The **FAQ** page handles the most common one-liners.
- The Discord and the GitHub repo are both linked from the app
  footer.

That's Vaipakam. Connect a wallet and you're in.
