# User-value enhancement opportunities — spec review findings & recommendations

**Status:** research/design note for **decisions and sequencing**. No code lands
from this document directly; each accepted item becomes its own Issue on the
`@vaipakam-labs` board (and, where it changes specified economics, its own
FunctionalSpecs update behind an explicit owner decision).

**Sources reviewed:** the full `docs/FunctionalSpecs/ProjectDetailsREADME.md`
and `docs/FunctionalSpecs/TokenomicsTechSpec.md` as of 2026-07-13, plus owner
clarifications of the same date (fixed-rate commitment; NFT floor-oracle
reliability). All findings respect the standing constraints: the #687
legal-surface excision (no staking yield, no fixed-rate sale, no insurance
framing) and the retail permissionless posture.

---

## 1. Owner clarification A — fixed-term interest rate as a commitment product

### The question

Vaipakam quotes a **fixed rate for a fixed term**, unlike the variable
(utilization-driven) rates of Aave / Compound / Spark. How do we make that
fixed-rate promise *more valuable* — and how do we encourage users to stick to
their agreements so the promise actually holds?

### Why fixed-term fixed-rate is a genuine differentiator (not a handicap)

- On pooled platforms the borrower's rate can spike without warning: utilization
  jumps → borrow APR jumps → positions that were affordable become distressed.
  The lender's supply APR is equally unpredictable.
- Vaipakam's rate is **agreed between two humans at origination and snapshotted
  for the life of the loan** (treasury fee rates are snapshotted at origination
  too). Both sides can plan cash flows to the day. That certainty is the
  product; it is what TradFi fixed-rate lending sells and what pooled DeFi
  cannot offer.
- The certainty is only real if the term is honoured. A fixed rate that either
  party can walk away from cheaply is just a variable rate with extra steps.
  So commitment mechanics are not a nice-to-have — they are what makes the
  headline feature true.

### What already enforces commitment (keep these — owner directive 2026-07-13)

The spec already prices early exit so that breaking the agreement is never
free, and the owner has confirmed these stay:

| Party | Early-exit path | Commitment cost (existing spec) |
| --- | --- | --- |
| Borrower | Standard early repayment (Preclose Option 1) | pays the **full original-term interest** — prepaying saves nothing on interest |
| Borrower | Loan transfer / offset (Preclose Options 2–3) | pays accrued interest **plus a shortfall top-up** so the original lender is never worse off |
| Lender | Sell position (Early-Withdrawal Option 1) | forfeits accrued interest |
| Lender | Sale-vehicle path (Option 2) | no fresh LIF, but all-or-nothing and lender bears pricing |

An earlier draft of this review suggested softening the borrower's
full-term-interest rule toward "accrued + break fee." **That suggestion is
withdrawn** per the owner clarification: the full-term-interest rule *is* the
commitment device that makes the fixed rate credible, and it stays the default.
(A per-loan pro-rata opt already exists for pairs who explicitly want it; that
remains an offer-time choice made by the lender, never a protocol default.)

### The key design principle: **transfer, don't break**

The right way to give participants liquidity without weakening the fixed-term
promise is to route every exit through **position transfer**, not term
mutation:

- When a lender sells their position NFT, **the loan's terms do not change**.
  The borrower keeps exactly the rate and maturity they signed; only the party
  entitled to the proceeds changes. Lender-side liquidity is therefore *fully
  compatible* with the fixed-rate promise — improving it strengthens the
  product rather than diluting it.
- The same holds for borrower Preclose Options 2–3 (transfer / offset): the
  economic terms owed to the original lender are preserved by construction
  (shortfall top-ups), so these are "commitment-preserving exits."
- Only Preclose Option 1 (outright early close) truly ends the term early, and
  it charges full-term interest — the lender receives everything they were
  promised, so even this path honours the agreement economically.

**Recommendation A-1 (accepted direction):** improve exit *liquidity* only on
the transfer paths — price accrued interest into the lender position sale
(buyer compensates seller for accrued yield instead of the seller forfeiting it
to treasury) and make sale-vehicle listings matchable/partial-fillable. Both
changes move value between the *exiting* and *entering* party; the committed
counterparty's terms are untouched. This needs an owner economics decision
(the accrued-interest-forfeiture rule is currently specified) and a
FunctionalSpecs edit before code.

### Positive incentives to hold to maturity (new proposals)

Penalties alone make exits costly; these make *staying* rewarding. All are
usage-earned (interaction-reward-shaped), not issuer yield, so they fit the
#687 posture — but each still gets a legal-surface glance before build:

1. **Held-to-maturity reward multiplier.** Borrower-side interaction rewards
   already require clean full repayment. Extend with a small multiplier
   (e.g. bounded 1.0–1.25×, governance-tunable) on interaction rewards for
   loans carried to natural maturity by the *original* party, funded from the
   same 69M interaction pool and inside the same per-day cap machinery. A
   party who exits early simply earns the unmultiplied base — nothing is
   confiscated, so no new penalty surface.
2. **On-chain completion history ("commitment streak").** A non-transferable,
   per-wallet counter of cleanly completed loans (count + notional band, no
   PII). Surfaced in the Offer Book next to counterparties so lenders can
   prefer proven completers, and usable as an *optional* offer filter
   ("only accept borrowers with ≥ N clean completions"). This creates a
   market-driven reason to protect one's streak — the strongest commitment
   incentive available to a permissionless protocol. It is deliberately a
   display/filter signal, not an on-chain credit score that changes protocol
   risk parameters.
3. **Commitment pool (flagged — needs legal review).** Route a slice of the
   value generated by early exits (e.g. part of the treasury share of
   forfeited accrued interest) into a pool distributed pro-rata to
   participants who completed loans to maturity that epoch. Economically this
   pays committers with defectors' money — a clean incentive alignment — but
   because it resembles a yield distribution it must pass the same legal
   review that removed the staking APR before it goes anywhere.
4. **Sell the certainty in the UI.** At accept time, show the borrower
   "your rate is locked: on a variable-rate venue this position's rate could
   have ranged X–Y% over the last 90 days" (from public Aave/Compound rate
   history, advisory only). Users can't value rate certainty they can't see.

**Recommendation:** adopt 1, 2, 4; hold 3 for legal review. None of these
change existing loan economics, so they are additive Issues rather than spec
amendments — except 1, which touches the interaction-reward formula and
therefore needs a TokenomicsTechSpec §4 edit with an owner decision on the
multiplier bound.

---

## 2. Owner clarification B — how reliable is an NFT floor-price oracle?

### The question

NFT values are highly volatile — is a floor-price oracle path actually
reliable? And do NFTfi / BendDAO / Arcade use such oracles?

### What the market actually does (researched 2026-07-13)

- **NFTfi and Arcade do NOT use price oracles.** Both are peer-to-peer:
  the lender appraises the NFT themselves (floor prices, project averages,
  third-party valuations like NFTBank are *advisory inputs to the human*),
  negotiates terms directly, and on default simply receives the NFT. There is
  no oracle in the loan's trust path and no oracle-triggered liquidation.
  This is **the same model Vaipakam already ships**: NFT collateral is valued
  at $0 by the protocol, both parties explicitly consent, and default
  transfers the collateral in kind.
- **BendDAO (peer-to-pool) is the counterexample that used an oracle** — an
  off-chain aggregator pulling OpenSea/LooksRare floor prices through a filter
  algorithm plus a TWAP (~6h) to smooth manipulation, feeding
  oracle-triggered auctions. Its **August 2022 crisis** is the canonical
  failure case: floor prices slumped, oracle-triggered liquidations found no
  auction bidders (bids were floored near the oracle price), reserves were
  run on, borrow rates spiked toward 100%, and governance had to cut the
  liquidation threshold from 90% to 70% and slash the auction window. The
  lesson is not "the oracle reported wrong numbers" — it is that **a floor
  price is not an executable price**: in a stressed market nobody will pay
  floor, so oracle-based LTV overstates recoverable value exactly when it
  matters.
- **Chainlink's NFT Floor Price feeds (the Coinbase-data feeds this review
  originally pointed at) are deprecated/unavailable.** The dedicated feed
  product is no longer a dependable primitive to build a lending LTV on.

Sources:
[Chainlink NFT floor-price feed addresses (deprecation notice)](https://docs.chain.link/data-feeds/nft-floor-price/addresses),
[BendDAO liquidation FAQ](https://github.com/BendDAO/bend-gitbook-portal/blob/main/faq/liquidation.md),
[MixBytes BendDAO protocol overview](https://mixbytes.io/blog/benddao-protocol-overview),
[CoinDesk — What is NFT lending](https://www.coindesk.com/learn/what-is-nft-lending),
[Fenbushi — NFT financialization overview](https://fenbushi.vc/2024/01/24/an-overview-of-nft-financialization/),
[coincrunch — BendDAO liquidation crisis](https://www.coincrunch.news/p/blue-chip-nft-bayc-liquidation-benddao).

### Revised recommendation (supersedes the earlier "floor-oracle LTV" idea)

The earlier suggestion to give NFT collateral a nonzero protocol LTV via a
floor oracle is **downgraded**. Vaipakam's current consent-based $0-LTV model
is not a gap — it is the surviving industry model (NFTfi/Arcade-shaped), and
the oracle-LTV alternative both lost its best data source (Chainlink feed
deprecation) and carries a demonstrated death-spiral failure mode (BendDAO).
Vaipakam is additionally P2P with in-kind default transfer, so it does not
even need an oracle to clear defaults the way a pool does.

What we adopt instead:

1. **Advisory valuation in the UI, never in the trust path.** Show floor /
   trait / recent-sale context (marketplace APIs, aggregators) next to
   NFT-collateral offers so the *human lender* can appraise faster — exactly
   the NFTfi-style role for pricing data. If every data source is down, the
   offer flow is unaffected; nothing on-chain reads it.
2. **Keep protocol LTV for NFTs at $0.** No oracle-triggered HF or
   liquidation for NFT collateral in Phase 1 or 2.
3. **Revisit only behind strict preconditions** (a future design doc, not a
   commitment): a protocol-LTV path for a small allowlisted blue-chip set
   would require ≥2 independent, manipulation-resistant valuation sources
   with a long TWAP, a severe haircut (BendDAO's post-crisis 70% threshold is
   the *ceiling* of what stressed reality supported — we would start far
   below), per-collection caps, and an explicit answer to "who buys at floor
   in a crash." Absent all of that, the answer stays no.

---

## 3. Accepted enhancement set (owner sign-off 2026-07-13, this doc records it)

The owner accepted the remaining findings as proposed. Grouped by theme, with
the decision surface each one needs before code:

### 3.1 Tokenomics / VPFI utility

| # | Item | What it is | Needs |
| --- | --- | --- | --- |
| E-1 | **Decouple the lender yield-fee discount from the VPFI pricing peg** | The lender discount is "X% off a fee" and does not inherently need a VPFI/ETH price; today it is disabled whenever the peg is unset because `quoteYieldFee` shares the borrower path's conversion helper. Decoupling gives vault-held VPFI real day-one utility while the peg stays unconfigured (the documented Phase-1 posture). | Owner decision that the coupling is accidental, TokenomicsTechSpec §6b edit, contract change + tests |
| E-2 | **Usage-earned VPFI perks** | Tiered protocol-feature unlocks by vaulted balance (reduced notification fees, priority solver routing, higher auto-lifecycle limits) and a referral mechanic funded from the 2% Ecosystem bucket. | Legal-surface glance (perks, not yield), then per-item Issues |
| E-3 | **Rewards timeline UI** | Per-day earned / capped / pending-broadcast state for interaction rewards, so bounded claims and waiting days are legible instead of looking like missing money. | Frontend-only Issue |

### 3.2 Borrower protection & automation

| # | Item | What it is | Needs |
| --- | --- | --- | --- |
| E-4 | **Auto-protect** | Opt-in keeper action: when HF crosses a user-set band, top up collateral (or partial swap-to-repay) from the user's free vault balance. Composes existing keeper grants + swap-to-repay; converts the platform's worst outcome (liquidation) into a serviced event. | Design doc (encumbrance interaction), spec edit, then build |
| E-5 | **Borrower standing intents** | Symmetric counterpart to lender intents: "borrow up to X against this collateral at ≤ Y% for Z days," solver-fillable. | Design doc; reuses intent/solver infra |
| E-6 | **Total-cost-of-loan simulator** | Accept-time view of best case / late case / liquidated case as one number each (LIF + yield fee + late fees + handling + incentives). | Frontend-only Issue |

### 3.3 Exit liquidity (transfer-path only — see §1)

| # | Item | What it is | Needs |
| --- | --- | --- | --- |
| E-7 | **Accrued interest priced into lender position sale** | Buyer pays seller for accrued yield instead of the seller forfeiting it to treasury. Terms of the loan untouched. | Owner economics decision + spec edit |
| E-8 | **Matchable / partial-fillable sale-vehicle listings** | Let lender-sale listings sit in the Range-Order book instead of direct-accept-only, all-or-nothing. | Design doc (interacts with `LenderSaleVehicleRedesign.md`) |
| E-9 | **Native secondary order book for position NFTs** | In-app listing/trading of position NFTs (Claim Center is already secondary-holder-aware) instead of relying on OpenSea. | Larger; scope after E-7/E-8 |

### 3.4 UX / surface polish

| # | Item | What it is | Needs |
| --- | --- | --- | --- |
| E-10 | **Claim-All batching** | One-click multicall claim across loans, rewards, and rebates; optional keeper-swept claims. | Contract read of claim paths, then Issue |
| E-11 | **In-app notification center** | Free in-app inbox from the existing indexer/D1 data; paid channels stay for off-chain delivery only. | Frontend + indexer Issue |
| E-12 | **Bundle mandatory vault upgrades** | Fold the required vault-upgrade call into the user's next action tx instead of a separate blocking step. | Contract + frontend Issue |
| E-13 | **Cross-chain portfolio view** | Read-only aggregation of positions/claims across the five Diamonds (multi-RPC reads; no cross-chain tx). | Frontend Issue |
| E-14 | **Consent-friction tuning** | Session-scoped consent caching where legally safe; "what changed" diff on terms-version bumps instead of full re-affirmation walls. | Legal glance, then frontend Issue |

### 3.5 Bigger bets (evaluate via their own design docs; no commitment implied)

- **Passive-lender ERC-4626 wrapper** over standing intents ("deposit and
  forget" entry point without abandoning the P2P model).
- **Account abstraction / gas sponsorship (ERC-4337 paymaster)** — extend
  gaslessness from offer signing to *exits* (repay/claim), where a gas spike
  can otherwise cause a liquidation.
- **Realized-APY / P&L / tax-export (CSV) analytics** from the existing
  public view-function surface.
- **Fiat on-ramp + in-app swap widget** (embedded third-party) to remove the
  acquire-everything-externally onboarding cliff.

---

## 4. Sequencing recommendation

1. **E-1** (peg decoupling) — smallest contract change, unlocks day-one VPFI
   utility; likely an unintended coupling, so decide first.
2. **E-4** (auto-protect) — highest user-protection value per unit of new
   surface; start its design doc now.
3. **E-7 + E-8** (lender exit economics on transfer paths) — supply-side
   retention; needs the owner economics decision from §1.
4. **E-10 + E-11** (Claim-All + notification center) — pure UX lift, no new
   economic surface.
5. §1 incentives 1/2/4 (maturity multiplier, completion streak, rate-certainty
   display) — the fixed-rate commitment programme.
6. NFT advisory valuation (§2 item 1) — frontend-only, replaces the
   withdrawn oracle-LTV idea.

Each item lands on the `@vaipakam-labs` board as its own Issue per the task
tracking convention; items marked "spec edit" additionally follow the
per-PR FunctionalSpecs discipline.
