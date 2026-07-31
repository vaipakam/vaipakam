# Early-Repayment Options UX Design

Status: Phase 1 implemented on alpha02 (branch
`claude/early-repayment-options-ui-re7wc1`); later phases proposed.
Companion to [`BasicUserUXSimplification.md`](BasicUserUXSimplification.md)
(whose wording rules and mode boundary this document inherits) and to
`docs/FunctionalSpecs/ProjectDetailsREADME.md` §8, the intended-behaviour
source for the borrower preclose options. The platform is prelive: there
are no existing users to migrate and no compatibility constraints — we can
and should get the shape right now, before habits form around a wrong one.

## Purpose

The protocol gives a borrower six ways out of an active ERC-20 loan
before maturity; the app historically surfaced one of them plainly
(full repayment) and folded three more into unadvertised Advanced
cards, while the two obligation-moving paths (handover to a new
borrower, offset into a lender position) had no surface at all.

The naive-user risk runs in both directions:

- **Under-exposure** (the old state): a borrower who could exit a
  full-term loan cheaply via a handover pays the whole term's interest
  because the app never told them another door existed.
- **Over-exposure** (the naive fix): a wall of six financial
  instruments with formulas on the loan page, which teaches nothing,
  frightens correctly-behaving users, and invites wrong choices.

This document specifies how the options are exposed **in layers**, so a
basic user keeps a one-button experience while every path stays
discoverable the moment it becomes relevant.

## Vocabulary — plain words before mechanics

Protocol names never appear on user surfaces. The canonical renames:

| Protocol / spec term | User-facing words |
| --- | --- |
| Full repayment (`repayLoan`) | "Repay in full" |
| Partial repayment (`repayPartial`) | "Repay part of it" |
| Direct preclose (`precloseDirect`) | "Close early (pay and settle now)" |
| Obligation transfer (§8 Option 2, `transferObligationViaOffer`) | "Hand the loan to another borrower" |
| Offset (§8 Option 3, `offsetWithNewOffer`) | "Exit by becoming a lender" |
| Refinance (tagged offer) | "Refinance to a new lender" |
| Rate shortfall | "lender rate top-up" |
| Accrued interest | "interest built up so far" |
| Position-NFT transfer lock | "your position is transfer-locked" |

Numbers follow the same rule: totals are quoted as "about X" in token
units with the note that the exact figure is computed on-chain at
execution — never bps, wei, or the shortfall formula. The formula
lives in this document and the functional spec, not in the app.

## The layered disclosure model

Four layers, each answering a different user question. A user only
descends a layer by their own explicit action.

### Layer 0 — the primary action (Basic mode, unchanged)

The loan page keeps exactly ONE primary action per state
(BasicUserUXSimplification "Manage Position Flow"): an active
borrower's primary action is **Repay**. Nothing in this design adds a
second primary button, moves the repay button, or interrupts the
repay journey with alternatives. A user who only ever wants "pay it
back" never meets the rest of this document.

### Layer 1 — awareness: the chooser card (both modes)

One card — "Ways to repay or exit early" — sits on the borrower's
active-loan page in BOTH modes. Its job is strictly *awareness*, not
action:

- Each path gets a **name, one plain sentence of what it does, and one
  sentence of what it costs** — the §8 path-specific interest
  implication, stated before any flow opens (e.g. "Costs the full
  agreed term's interest even though you're closing early — that's
  this loan's interest mode").
- The card never submits, never prompts a wallet, never quotes a
  moving number. It is safe to read top to bottom with zero risk.
- Paths that don't currently apply say WHY in one line ("Not offered
  on this loan — the lender didn't enable partial repayments"; "no
  longer available this close to the due date") instead of vanishing.
  An option that silently disappears reads as a bug; one that
  explains itself teaches the rule.
- In Basic mode the advanced paths share ONE clearly labelled action:
  "Show these tools (switches to Advanced view)". The mode flip is
  the user's own deliberate choice — never a side effect of tapping a
  row — and a sub-line says the switch submits nothing. This keeps
  the BasicUserUXSimplification rule that Advanced is progressive
  disclosure, not a hidden second product.
- In Advanced mode each row jumps (scrolls) to the matching tool's
  own card. The chooser holds no state and duplicates no controls.

Why a card and not a menu/wizard at Layer 1: a menu forces a choice
before understanding; a card can be read and ignored. The wizard
("help me choose") is a later phase, layered ON TOP of this, not a
replacement (see Roadmap).

### Layer 2 — the tools (Advanced mode)

Each path is its own card with its own gates, quotes, disclosures, and
review receipt — the standard six-row receipt and single-open-confirm
rule apply unchanged. Layer-2 rules that specifically protect the
naive user who just switched modes:

1. **Cost before commitment.** Every candidate/tool quotes the
   user's cost up front (the handover picker prints "Your cost today:
   about X" on every row, cheapest first) so comparison happens
   before any selection, and selection happens before any signature.
2. **Must-know disclosures render before the review opens**, and
   repeat inside it. For the offset: the transfer lock on the
   position token, and the keep-your-wallet-funded rule ("posting
   locks X now; keep about Y more available — the payoff is pulled
   automatically when someone accepts"). A disclosure that first
   appears on the confirm screen is too late; one that only appears
   before it can be forgotten.
3. **Failure is always framed as safe.** Every receipt's "you can
   lose" row states the atomicity honestly: "if anything doesn't
   check out, the whole handover fails and your loan continues
   unchanged"; "if your wallet is short when someone accepts, their
   acceptance simply fails — nothing is taken". The naive user's real
   fear is a half-completed exit; the contracts guarantee atomicity,
   so the copy must spend that guarantee.
4. **Only offerable things are offered.** The handover picker mirrors
   the contract's admission rules client-side (same assets, amount
   range covering the outstanding principal, ≥ collateral, term
   inside maturity, not your own or an already-promised request), so
   a listed candidate is one the chain would accept — then everything
   is re-verified live at submit anyway. Loading, empty, and
   unavailable states are visually distinct (the app-wide rule).
5. **Approvals are bounded and explained.** No `MaxUint256`
   approvals anywhere in these flows. The offset grants one approval
   sized exactly to posting escrow + the largest completion pull any
   acceptance could make; the handover approves the quoted cost plus
   a small time-in-flight pad. The quoted keep-available figure IS
   the approval bound — the user never authorizes an undisclosed
   amount.

### Layer 3 — linked-vehicle pending states (chain-authoritative)

A posted offset (and, already, a refinance request) is a *standing
commitment* that outlives page visits, mode switches, and devices.
Its surface therefore:

- renders on the CHAIN's say-so (the position lock), not a local
  marker — an offset made on another device still shows;
- takes over the page's story while live: the strategy cards that
  would strand the linked offer are held with a one-line explanation,
  and the always-open full-repay review carries a warning instead of
  a block (repay is the safety valve and is never blocked);
- watches the completion funding (balance + standing approval) and
  says plainly what a shortfall means and how to fix it (restore
  approval / top up / cancel) — never a warning without a remedy;
- offers cancel, gated by the protocol cooldown, worded as a full
  unwind ("your position is unlocked and your lending money is back
  in your vault").

## Decision guidance the chooser encodes

The cost sentences are not boilerplate — they encode the real
decision table, so reading the card IS the comparison:

| Path | When it genuinely fits | Cost shape |
| --- | --- | --- |
| Repay in full / Close early | Have the cash; want out today | Principal + full-term interest (or accrued-only on a day-by-day loan) |
| Repay part | Have some cash; want smaller future interest | Amount + interest accrued so far |
| Hand over the loan | A matching borrow request exists; want out without repaying principal | Accrued interest + lender rate top-up |
| Exit by becoming a lender | Have lendable capital; want to flip sides | Fresh principal now + payoff (principal + accrued + top-up) at completion |
| Refinance | Better rate available; want to stay borrowing | Payoff (always full remaining-term interest) rolled into a new loan |

The subtle but load-bearing teaching moment: on a **full-term-interest
loan** (the protocol default), "Repay in full" and "Close early" cost
the whole term's interest no matter how early — while a handover or
offset costs only accrued + top-up. The chooser's cost lines make that
contrast readable without ever showing the formula. On a **pro-rata**
loan the contrast collapses, and the cost lines switch wording
accordingly (the interest mode is read live; when unknown the
conservative full-term wording shows).

## What we deliberately do NOT show

- The shortfall formula, seconds-precision accrual, or any bps figure
  on these surfaces (bps stay in Rate Desk tooltips per the existing
  convention).
- A live side-by-side "cheapest path" ranking on the chooser (Layer 1
  must stay quote-free; ranking moves to the Phase-2 wizard where the
  user has asked for it).
- The keeper-delegation story (keepers can initiate these flows, but
  that is Settings/keeper-card territory, not the chooser's).
- Anything for NFT rentals: a rental is not debt (app-wide rule); its
  close path stays the rental-close button, and the chooser does not
  render. The §8 handover option for rentals is deferred until the
  rental UX gets its own design pass.
- `completeOffset` as a button on the happy path — completion is
  automatic inside the acceptance; the manual hook is a recovery
  affordance, surfaced only if we later see stuck offsets in
  practice (it stays reachable to keepers meanwhile).

## Safety rails carried over from existing conventions

Unchanged, but restated because every new flow must obey them: one
confirm surface open at a time page-wide; any term edit or moved
figure voids a ticked consent; every gate that involves money or time
is judged by chain time against live reads at submit (the render-time
gates are advisory); Tier-1 sanctions screens run live before any
wallet prompt on the strategy paths while the wind-down repay stays
unscreened; done-states latch so a lagging indexer can't resurrect a
consumed action.

## Prelive posture

- **No migration debt.** Copy keys, component boundaries, and the
  chooser's shape can still change freely; nothing in this design is
  frozen by user habit. Prefer breaking changes now over carrying a
  wrong shape into launch.
- **Contract redeploys are expected.** Other contract-side work is in
  flight; after redeploy the fork-tier e2e lane (currently red at
  HEAD on the deep-link accept step, independent of this feature) is
  expected to recover, and `25-early-repay-options.spec.ts` runs with
  it. If any of the consumed selectors change shape
  (`transferObligationViaOffer`, `offsetWithNewOffer`, `getOffer*`,
  `positionLock`), the standard frontend ABI re-export + typecheck
  cycle applies (CLAUDE.md "Frontend ABI sync").
- **Live-review DoD still applies** once the redeployed testnet is
  up: drive the chooser (Basic), an offset post + cancel, and a
  handover with the second dev wallet's standing request on the
  deployed site.

## Roadmap

**Phase 1 — shipped with this design.** Chooser card (both modes),
handover flow, offset flow + pending card, interlocks, fork-tier spec,
functional-spec section.

**Phase 2 — "help me choose" (proposed).** An opt-in, question-first
wizard layered on the chooser: "Do you have the cash to repay? →
Do you want to keep borrowing? → Would you rather lend?" ending in ONE
recommended path with its live quote, and the runner-up named. Only at
this point do live side-by-side quotes appear, because the user asked
for a recommendation. Needs: a quote helper that prices all paths from
one batched read; wording that never promises the recommendation is
cheapest under future rate movement.

**Phase 3 — swap-to-repay surface (proposed).** "Repay using your
collateral" — the last unexposed contract path. Gated on the
adapter-routing story (keeper-ranked DEX try-lists) having a safe
client-side quoting source; slippage framed in plain words with the
protocol's borrower-tighter cap. Advanced-only at introduction; the
chooser gains its row (with cost line "sells some collateral at
market price to pay the loan") only when the flow ships.

**Phase 4 — rentals pass (proposed).** Decide whether rental handover
(§8 Option 2 applies to rentals contract-side) is worth a surface, and
what "early close" guidance a renter needs beyond the existing close
button.

## Open questions

1. Should the chooser collapse to a single summary line once a user
   has dismissed it (per-device), keeping the page short for repeat
   visitors? Leaning yes, post-live-review.
2. Basic-mode placement: the chooser currently sits above the
   strategy cards; if live review shows it competing with the
   "make it safer" add-collateral card during risk events, the risk
   card should win the slot and the chooser demote below it.
3. Handover candidate volume: on a busy book the eligible list is
   windowed like every other list (25 + "Show more"); do we
   additionally cap by cost proximity to the cheapest? Defer until a
   real book exists.
4. Should a live offset's linked offer render a compact receipt of
   its own terms (rate/duration/collateral) on the pending card? The
   data is one `getOfferDetails` read away; add if live review shows
   users cancelling because they forgot what they posted.
