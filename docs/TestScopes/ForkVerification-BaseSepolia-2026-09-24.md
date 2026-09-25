# Fork verification of the live Base Sepolia deployment — 2026-09-24

An advanced-user walkthrough of the deployment that is **live right now**,
driven against a local fork of it rather than a fresh local deploy, so that
what is under test is the deployed bytecode and the deployment's own
configuration — not the source tree's idea of them.

- **Target** — Diamond `0xd89fd7F787e4415460b23891E97570a4881fb995`, chain
  84532 (Base Sepolia), forked at block 47,228,632.
- **Driver** — [`contracts/script/fork-scenarios/`](../../contracts/script/fork-scenarios/README.md),
  committed with this document. `node run-all.mjs` reproduces every row.
- **Result** — 129 scenarios: **118 PASS, 10 INFO, 1 FAIL**, no aborted
  file. The INFOs are observations with no assertion behind them, not soft
  failures — the ledger's API makes a row either an assertion (PASS/FAIL
  only) or an observation (INFO only), so no failure can land as INFO; each
  is listed in §7. The one FAIL is **A11.5**, and it is deliberate: after
  the owner's #2317 decision (§3D) that row asserts the SPEC — sell only what
  the debt needs — and the live bytecode sells the whole cap. It turns green
  when the #2317 fix is deployed.
- **Node** — the figures above are from a re-run on **Anvil** (2026-09-25,
  forked at block 47,274,237). The first run used a hardhat fork node and
  reported 123 / 6 / 0. The differences are the A11.5 oracle change above,
  and four rows that recorded a deployment's CONFIGURED value as a PASS and
  now observe it instead (§7). The re-run also found three defects in the
  HARNESS that the hardhat node had hidden — see
  [§0](#0-re-run-on-anvil-and-three-harness-defects-it-exposed).
- **Assets** — the deployment's own faucet mocks: `tLIQ` priced $2,000,
  `tLIQ2` priced $1.00, plus `illiquidToken` (unpriced).

Two things this run did **not** cover, stated up front so the coverage is not
read as wider than it is: the **contracts were not refreshed on-chain** (that
needs the Diamond admin's key — see §6; the ABI re-export, by contrast, was
run and found nothing to change), and the **full Foundry regression was
deliberately not run**, per the standing per-PR rule that it is a pre-deploy
gate only.

---

## 0. Re-run on Anvil, and three harness defects it exposed

The first run was driven against a hardhat fork node because Foundry could
not be installed from GitHub releases in the session container. Foundry's
official npm packages (`@foundry-rs/anvil`, `@foundry-rs/forge`) install
from the npm registry, and the whole suite was re-run on Anvil. Its first
pass aborted two files and turned three accepts into
`AcceptSignatureInvalid()`. None of that was the protocol; all three causes
were in the harness, and each is now fixed at the root rather than per
scenario:

1. **The published test-mnemonic keys are not clean on a public testnet.**
   On Base Sepolia the second and third default accounts carry **EIP-7702
   delegations** (`0xef0100…` code). The Diamond therefore saw a contract
   where the scenario meant a wallet: an accept signature went down the
   ERC-1271 path and failed, and minting a position NFT to one called a
   receiver hook that reverted (`NFTMintFailed`). The hardhat node did not
   reproduce those delegations, which is why the first run passed.
   **Fix:** the driver generates fresh keys every run, funds them, and
   refuses to start if any actor has code.
2. **An aborted file leaked its state into every later file.** One abort in
   A3 left the debt asset priced 2.5×, and every file after it failed with
   an unrelated-looking `IlliquidAssetNotAcknowledged`. **Fix:** each file
   runs inside an `evm_snapshot` / `evm_revert` pair, so it starts from the
   same fork state whatever ran before it.
3. **Anvil under-estimates gas for a loan-closing call.** `repayLoan` after a
   partial estimated 573,777 and reverted at 565,251 with "not enough gas for
   reentrancy sentry" — the EIP-2200 rule that an SSTORE needs more than
   2,300 gas left. Closing a loan clears enough storage that the refund hides
   the peak. **Fix:** a 20% margin on every estimate, plus a replay of any
   send that still reverts on-chain, so the abort line says whether it was a
   refusal or a gas shortfall.

   This was observed on **Anvil's** estimator only. A production node that
   binary-searches the estimate should not return a figure that fails, and
   this run did not test one — so it is recorded as a harness fact, not as a
   finding about the connected app, which sends viem/wagmi estimates without
   a margin. Whether a real Base Sepolia node's estimate for the same call
   clears the sentry is **unverified**.

With those fixed, the Anvil run ran all 129 rows with no aborts. Every row
that passed in the first run passes again — most now against a STRICTER
condition — except A11.5, whose oracle changed on purpose, and four
configuration rows that are now observations rather than passes.

The review of this document then found the ledger itself too lenient, in two
shapes: rows that printed a number under a hard-coded PASS (the forced-close
bonus, the claims after a default, the listing and refinance steps), and rows
whose failure branch was INFO rather than FAIL (the handover, both lender
sales, the rental custody checks), so a regression on either read as green.
The fix is in the ledger's API, not row by row: a row is now `check`
(PASS/FAIL, needs a condition), `observe` (INFO, no assertion) or an abort,
and there is no way left to write a verdict string. Every former
unconditional PASS was given a real condition — an exact expected value, the
refusal's name, both sides of a transfer — and all of them hold on the live
bytecode. Figures that depend on ELAPSED time — accrued interest, and so the
forced-close splits in §2.1 — differ from the first run's in the sixth
decimal, because the time warps land on different seconds; every fee rate,
cap, ratio and fixed-amount figure is identical.

## 1. What the walkthrough establishes

### 1.1 Money moves exactly where the specification says

Every scenario snapshots both parties' wallets, both parties' vaults, the
Diamond and the treasury before and after each state change, so a claim like
"the repay worked" is replaced by an exact ledger. On a 1,000 tLIQ2 loan
against 1.25 tLIQ of collateral, at 500 bps over 7 days:

| Step | lender wallet | lender vault | borrower wallet | borrower vault | treasury |
| --- | --- | --- | --- | --- | --- |
| create offer | −1,000 | +1,000 | — | — | — |
| accept | — | −1,000 | +998.02 tLIQ2, −1.25 tLIQ | +1.25 tLIQ | +1.98 |
| repay | — | +1,000.9397 | −1,000.9589 | — | +0.01918 |
| claim (borrower) | — | — | +1.25 tLIQ | −1.25 tLIQ | — |

Read off that ledger:

- **The lender's principal is escrowed in the lender's OWN vault** at offer
  creation, not in the Diamond. It leaves that vault only when the offer is
  accepted.
- **The borrower's collateral never leaves the borrower's own vault.** It is
  *encumbered by a lien*, not transferred. This is the single most
  consequential structural fact in the walkthrough and it is easy to
  mis-describe as an escrow.
- **The loan-initiation fee is 0.2% of the principal, charged in the LENDING
  asset** (not in VPFI — the #1352 posture), and it is **split 99 / 1 between
  the treasury and the matcher**. On this accept the borrower was also the
  matcher (they called `acceptOffer`), which is why they net 998.02 rather
  than 998.00. That 1% kickback is the same one the functional spec documents
  for the keeper-matcher path.
- **The treasury takes 2% of the INTEREST and nothing of the principal.**
  0.019178 on 0.958904 of interest, to the wei.
- **The payoff quote is principal + simple interest over the full term** —
  1,000 × 500 bps × 7/365 = 0.958904109589041095, matched exactly.

### 1.2 Per-loan fee stamps hold

`treasuryFeeBpsAtInit = 200`, `loanInitiationFeeBpsAtInit = 20` and
`minHealthFactorAtInit = 1.5e18` are all written onto the loan record at
initiation. A governance retune therefore cannot re-price an open loan —
which is the whole point of the rev-8 freeze, and it is now observed rather
than assumed.

### 1.3 Repay settles the money; the claim releases the collateral

This is a **two-step close, and the second step is the borrower's**. After a
full repay the loan is already `Repaid`, the lender is already credited and
the treasury already paid — but `getLoanCollateralLien` still reports
`released: false`, and the borrower's vault balance is still fully
encumbered. `claimAsBorrower` is what releases the lien and returns the
tokens.

An interface that treats "Repaid" as "done" would leave the borrower's
collateral locked with no prompt, so a status surface has to distinguish
*repaid* from *repaid and claimed*.

**The connected app already does.** Checked after this run rather than
assumed: `apps/app` carries a Claims page and a `ClaimAllCard`, the
close-early confirmation reads "Your collateral is ready — claim it below or
from the Claim Center", and the push hints for `loan_repaid` /
`loan_defaulted` / `internal_matched` all route to what is claimable. This
paragraph records a real protocol shape a *new* surface has to honour — not
a gap in the shipped one.

The same shape applies on the lender side: a repay credits the lender's
**vault**, and `claimAsLender` sweeps it to their wallet. The sweep creates
no new money — the Diamond's balance is unchanged across it — and a second
claim on either side reverts and moves nothing.

### 1.4 Position NFTs survive terminalization, and are spent by the claim

Two distinct facts that are easy to collapse into one:

- **At terminalization both position NFTs still resolve.** After the loan
  went `Repaid`, `ownerOf` answered for both the lender and the borrower
  token. They are status-updated, not burned — exactly the invariant
  `CLAUDE.md` states for the refinance path.
- **The claim spends the claiming side's receipt.** After
  `claimAsBorrower`, the borrower's token no longer resolves; the lender's
  still does.

So "a terminal loan's NFTs are gone" is wrong, and "a terminal loan's NFTs
always resolve" is also wrong. An indexer needs both halves.

---

## 2. The forced-close routes

### 2.1 Time-based default

Grace behaves as documented and the boundary is observable: a healthy in-term
loan is not defaultable; half a day past a 7-day term it is still not
defaultable (inside this deployment's 1-day grace for that term); past term
*and* grace it is.

`triggerDefault` is **permissionless** — an unrelated third party closed the
position — and the settlement on 1.25 tLIQ of collateral sold for 2,500
tLIQ2 came out as:

| Recipient | Amount | Basis |
| --- | --- | --- |
| caller (liquidator) | 75.000000 | 300 bps of proceeds, the loan's stamped `fallbackLenderBonusBpsAtInit`, taken off the top |
| lender | 1,054.101373 | debt owed, net of the treasury's cut |
| treasury | 51.104110 | the loan's stamped treasury bps |
| borrower (surplus) | 1,319.794517 | what is left, returned to the borrower |
| **total** | **2,500.000000** | reconciles exactly |

The borrower surplus is the part worth stating on any liquidation surface:
an over-collateralised position that is force-closed does **not** forfeit the
excess.

### 2.2 A forced close that cannot route refuses, rather than mis-settling

`triggerDefault` with an empty swap try-list reverts `NoEnabledSwapRoute`.
It does not fall through to a full-collateral transfer. That is the correct
posture — a permissionless caller must not be able to push a liquid position
into the fallback path by simply declining to name a venue — and it means a
keeper that cannot quote a route must report that, not retry blindly.

### 2.3 Health-factor liquidation, and the gap between 1.5 and 1.0

The two thresholds are distinct and both were exercised:

- At **HF 1.1** — below the 1.5 initiation floor — `triggerLiquidation`
  refuses with `HealthFactorNotLow()`. The 1.5 floor binds at *initiation*
  only; a live position is not liquidatable until HF < 1.0.
- At **HF 0.8**, liquidation succeeds, permissionlessly, and pays the caller
  a 30 tLIQ2 bonus out of 1,000 tLIQ2 of proceeds (3%), with the remaining
  970 credited to the lender. There was no surplus and no treasury cut,
  because the proceeds did not cover the debt — the lender takes the
  shortfall, and the bonus comes off the top regardless.

### 2.4 FINDING — on this deployment a collateral crash closes the HF-swap route

**Observed:** the seeded `tLIQ` / WETH pool sits barely above the on-chain
depth floor at the seeded price. Repricing `tLIQ` downward flips it from
Liquid (tier 3) to Illiquid (tier 0) at a **20% drawdown**:

| tLIQ price | `checkLiquidity` | tier |
| --- | --- | --- |
| $2,000 (seeded) | Liquid | 3 |
| $1,600 | Illiquid | 0 |
| $1,400 … $900 | Illiquid | 0 |

Because `triggerLiquidation` re-checks liquidity **live** (it will not swap
an asset it can no longer route) it then refuses with `NonLiquidAsset()` —
even though HF is below 1 and the loan is otherwise liquidatable.

Any collateral drawdown large enough to make a position unhealthy on this
deployment is therefore also large enough to close the route that would
resolve it, leaving only the slower time-based default. The HF-liquidation
payout above had to be driven from the **debt** side (repricing `tLIQ2`
upward) to keep the collateral routable.

**Classification:** this is a property of the *testnet mock pool seeding*,
not a contract defect — the refusal is correct behaviour, and refusing is
strictly better than swapping into a pool that cannot absorb the trade. But
it does mean **HF liquidation is effectively untestable on Base Sepolia
through a collateral price move**, which matters for any rehearsal that
claims to have exercised it. The remedy is operational: seed the mock pool
with materially more depth, so the asset stays above the floor across a
realistic drawdown.

---

## 3. Early exits

### 3.1 FINDING — precloseDirect under a full-term-interest offer saves nothing

`precloseDirect` on **day 1 of a 7-day term** charged
1,000.958904109589041095 — byte-identical to the full-term payoff quote. The
offer carried `useFullTermInterest: true`, so this is the flag behaving as
named, not a bug.

It is still a transparency obligation. A borrower reading "close early" will
reasonably expect a pro-rated interest saving, and on a full-term-interest
offer there is none. Any preclose quote surface must state that the full
term's interest is due, and must distinguish a full-term offer from one that
accrues pro rata, before the borrower signs.

**The connected app already does, and does it more carefully than a
straight disclosure would.** Checked after this run rather than assumed:
`EarlyRepayOptionsCard` reads the loan's interest mode live and is
deliberately **tri-state** — `closeEarlyCostFullTerm` ("Costs the full agreed
term's interest even though you're closing early"),
`closeEarlyCostProRata`, and a neutral `closeEarlyCostChecking` while the
mode is unknown. It never falls back to the full-term default, because doing
so would misprice a *pro-rata* loan's close. That tri-state was itself the
product of a review round (Codex #1500 r2/r3).

Recorded here because the underlying protocol behaviour is easy to
misremember, and because any NEW surface that quotes an early payoff has to
reproduce all three states — not because the shipped surface is missing it.

### 3.2 Partial repayment

With `allowsPartialRepay` set on the offer, the flag carries onto the loan, a
400-of-1,000 payment reduces the recorded principal to 600 and leaves the
loan `Active`, the payoff quote re-quotes at 600.575342, and the final
`repayLoan` terminalizes to `Repaid`.

One asymmetry worth noting for interface work: the **partial** payment went
straight to the lender's **wallet**, while a **full** repay credits the
lender's **vault**. Both are correct; a balance display that assumes one
shape will be wrong about the other.

### 3.3 Lender exit — listed and direct

`createLoanSaleOffer` accepts a listing from the lender, **refuses a zero
listing window** (`SaleListingWindowInvalid`) — so there are no perpetual
sale listings — and refuses a third party attempting to list someone else's
position (`KeeperAccessRequired`).

Followed through to a sale (A8), both routes hand the lender side of a live
loan to a new lender while the borrower's position runs on **unchanged** —
same borrower, principal, rate, term and `Active` status:

- **Listed.** Filling the listing completes the sale **in the same
  transaction**, the same auto-link shape as the borrower's offset route
  (§3A.3); `completeLoanSale` afterwards is refused with `SaleNotLinked()`.
  The vehicle is the offset vehicle's mirror image: a **BORROWER-side offer
  posted by the LENDER**. Classify the two by `offerType` alone and both land
  under the wrong party. `createLoanSaleOffer` returns nothing, so the
  vehicle's id is read from the `LoanSaleOfferLinked` event.
- **Direct.** `sellLoanViaBuyOffer` sells straight into a buyer's standing
  lender offer in one transaction, with no listing. A non-lender caller is
  refused with `NotNFTOwner()` — the lender position NFT authorises, as the
  borrower NFT does on the borrower side (§3A.1).

On both, the buyer paid exactly the principal and the seller received it
less a small treasury amount (≈1.7×10⁻⁵ tLIQ2 on a position held for
seconds). **This run does not assert how that amount is composed** — it is
consistent with a treasury cut on interest accrued to the sale, but the
figure is too small here to distinguish that from other readings, and
settling it needs a sale taken meaningfully into a loan's term.

---

## 3A. Two things that move funds on an OPEN position

### 3A.1 Releasing surplus collateral — the boundary is the 1.5 floor

On a loan opened at HF 4 (2.5 tLIQ against 1,000 tLIQ2), the protocol quotes
**1.5625 tLIQ** as releasable, and releasing exactly that lands the position
at **HF 1.5000** — the same floor that binds at initiation. So the surplus is
defined as *everything down to the initiation floor*, not some softer margin.

- One wei past the quote is refused with `HealthFactorTooLow()`. It is not
  clamped to the maximum, which matters: a caller who miscalculates gets an
  error rather than a silently different outcome.
- A second quote afterwards reports **0**.
- A third party attempting the release is refused with `NotNFTOwner()` —
  worth noting because it names the authorisation model: the borrower
  **position NFT** is what authorises, not the borrower address recorded on
  the loan. A transferred position carries the right with it.

### 3A.2 Refinance is a consent-gated, single-purpose path

The CLAUDE.md invariant is confirmed exactly: a completed refinance leaves
**two loan records and four distinct position NFTs, all four still
resolving**. The original loan terminalizes to `Repaid`, the replacement is a
separate record with the new rate and the new lender, and the old borrower
token still answers `ownerOf` as a redeemable receipt on the original
position. An indexer assuming one NFT per loan, or that a terminal loan's
NFTs are gone, is wrong on both counts.

What was not obvious until it was driven is **how much has to be true before
a refinance-tagged offer can even be created**. It must be a Borrower offer,
all-or-nothing fill, on the same lending / collateral / prepay assets, with
`amount <= oldPrincipal <= amountMax` — and, the interesting one:

> **The borrower must have consented in advance**, by enabling
> auto-refinance caps on the loan. Without them, creating the offer is
> refused with `RefinanceCapsRequired()`. With them, an offer above the
> consented rate is refused with `RefinanceRateExceedsCap()`.

So the terms a third party may move a borrower onto are bounded by something
the borrower set first, not by the offer alone. Enabling the caps with no
expiry is itself refused (`InvalidCaps()`), so the consent always carries a
deadline — even though the downstream checker reads a zero expiry as "no
cap". The setter is deliberately the stricter of the two.

### 3A.3 The offset route completes ITSELF

`offsetWithNewOffer` posts a replacement offer and leaves the original loan
**Active** — it is an offer, not a close. What matters is what happens when
somebody fills it: accepting the offset offer **closes the original loan
inside that same transaction**. `completeOffset` afterwards is refused with
`LoanNotActive()`.

A surface that shows "offset posted → now complete it" is waiting for a step
that already happened. The facet has two completion entries for exactly this
reason — an external one and an `address(this)`-gated one the accept path
invokes — and only the second is ever used on this route.

Two details the run turned up that are not obvious from the name:

- **The vehicle is a LENDER-side offer posted by the BORROWER.** The offset
  works by the exiting borrower standing on the other side of a replacement
  loan. Anything that classifies offers by `offerType` alone will file this
  one under the wrong party.
- **The maturity bound is seconds-precise.** The replacement may not mature
  later than the original: `now + newTerm <= startTime + oldTerm`. A
  *same-length* replacement therefore only fits in the same second the loan
  originated, and is refused a minute later. That is also why a
  simulate-then-send pair can disagree on this call — the send lands a block
  later than the simulation.

The settlement reconciles: the borrower repays principal plus accrued
interest, their escrowed offer principal is released, the original lender is
made whole, the incoming party receives the net new principal and posts the
collateral, and the treasury takes the LIF on the new loan.

### 3A.4 Obligation handover keeps the loan; refinance replaces it

`transferObligationViaOffer` hands a live loan to a replacement borrower who
has a standing offer, and — unlike refinance — the **loan record survives**.
Its `borrower` is rewritten in place, the lender and principal are untouched,
the exiting borrower pays only the interest accrued so far and takes their
collateral back, and the loan stays `Active`.

So the two "move this position to someone else" paths differ in a way any
indexer has to model: refinance ends one loan and starts another; handover
mutates one. Both are gated on the same seconds-precise maturity bound, and
both refuse a caller who is not the exiting borrower with
`KeeperAccessRequired()`.

## 3B. Periodic interest ships dormant — and what it does when armed

**The deployed posture.** The master switch is **off** on this deployment
(`getPeriodicInterestEnabled = false`), which is the intended default: the
facet's own natspec says the feature "ships dormant; flipped on by governance
when ready". While it is off, an offer carrying any cadence is **refused
outright** (`PeriodicInterestDisabled()`) rather than silently downgraded to
no cadence — the honest failure mode. Offer terms are separately capped at
365 days (`OfferDurationExceedsCap(400, 365)`).

**Operational-posture check on the app.** The rule that a config-hidden
capability must be disclosed does not bite here, and it is worth saying why
rather than assuming it: the connected app's offer form **never offers a
cadence at all** — it hard-defaults to none, and only carries an existing
position's cadence through accept, sale and refinance. Nothing is hidden
behind the flag from the user's side. The app does ship translated copy for
`PeriodicInterestDisabled`, so the refusal is explained if it is ever reached.

**Armed on the fork only, then restored.** To exercise the settlement path
the deployment cannot currently reach, the switch was admin-armed on the fork
and put back afterwards (confirmed `false` after the run):

- **Admission is strict and names its reasons.** A monthly cadence needs a
  principal of at least the finer-cadence threshold — **100,000 in numeraire
  units** on this deployment — and a term longer than one interval. Both
  refusals carry the numbers: `CadenceNotAllowed(1, 20, …)` for a 20-day
  term, `CadenceNotAllowed(1, 90, 10e18, 100000e18)` for a $10 principal.
  So periodic interest is, by configuration, a large-loan feature here.
- **Before the boundary, nothing settles** (`PeriodicSettleNotDue`), and
  after it a preview reports the period's due interest before anything
  moves — 410.96 on 100,000 at 500 bps for 30 days, to the wei.
- **An unpaid period is closed by selling collateral**, and the protocol
  refuses to stamp it closed without a route
  (`PeriodicSettleSwapPathRequired`). With a route, a permissionless settler
  sold 0.2178 tLIQ (435.62 tLIQ2): lender 413.84, settler 13.07 (3%),
  treasury 8.71 (2%), and the loan stayed **Active**. The lender received
  about 0.7% *more* than the 410.96 due — consistent with the sale being
  sized to cover the bonus and fee with a small margin, but this run does not
  assert the sizing rule. A second settle of the same period is refused.
- **A period the borrower pays voluntarily closes itself.** Paying the due
  amount through a partial repayment advanced the period's settled-at stamp
  by exactly one interval **inside the repayment**, so there is no separate
  "stamp" call left to make — one is refused `PeriodicSettleNotDue`. The
  facet's natspec describes a separate just-stamp call for a period the
  borrower already covered; in this flow the repayment does the stamping
  itself. That is recorded as observed behaviour, not as a divergence — the
  natspec's path may cover repayments made before the boundary.

## 3C. NFT rental, checked against the spec rather than the code

The oracle for this section is `docs/FunctionalSpecs/ProjectDetailsREADME.md`
— its ERC-721 rental model and its "NFT Rental Outcome" — and every point it
states was observed:

| The spec says | Observed |
| --- | --- |
| the NFT is held in a Vaipakam vault during the rental | listing moves it into the **lender's own vault**; it stays there throughout |
| the renter gets only the ERC-4907 `user` right and never custody | `userOf` = renter, `ownerOf` = the lender's vault |
| rent is prepaid, plus a buffer | 73.5 up front = 70 (7 days × 10) + 3.5 (5% buffer), into the **renter's own vault** |
| on an early close the lender is owed the rent due | closed on day 3: **30** taken (3 × 10) — lender 29.4, treasury 0.6 (2%) |
| the renter is owed the unused prepayment and the buffer | renter reclaimed **43.5** = 40 unused rent + the full 3.5 buffer |
| the `user` right is revoked; the NFT stays in custody | `userOf` → zero address after the close, `ownerOf` unchanged |
| after claims the positions settle | lender's claim returns the NFT to the lender's wallet |

Across the rental's whole life the prepay token is **conserved to the wei**:
the renter's net cost was exactly three days' rent, split lender/treasury,
with nothing created or lost.

Two further points:

- **A rented NFT needs the renter's explicit acknowledgement.** Accepting
  without naming the NFT in the acknowledgement is refused
  (`IlliquidAssetNotAcknowledged`) — the same dual-consent gate as illiquid
  collateral (§4.3), here applied to the *lent* asset.
- **A rental has no health factor, and says so with a DIFFERENT error.**
  `calculateHealthFactor` on a rental returns `InvalidLoan()`, where an
  illiquid-collateral loan returns `IlliquidLoanNoRiskMath()`. Both are
  honest refusals, but a surface rendering HF must handle both names — one
  "not applicable" state reached by two refusals. This also resolves an
  observation from the start of this session: an active loan that answered
  `InvalidLoan()` with zero collateral was an NFT rental behaving correctly,
  not a defect.

## 3D. Swap-to-repay — and a divergence on the cap (owner-decided: the code is the bug)

Swap-to-repay lets a borrower settle without holding the principal asset:
collateral is sold for principal and applied to the repayment in one
transaction. Checked against the spec's swap-to-repay bullets:

- **Authority follows the borrower-position NFT** — a third party is refused
  `NotNFTOwner()`, as the spec requires.
- **A cap above the collateral held is refused** (`InvalidAmount()`), and
  with no swap route the call is refused rather than attempted
  (`NoEnabledSwapRoute`).
- **Full mode closes the loan in one transaction**, and the sale is
  accounted to the wei: proceeds = the debt (lender + treasury) + a surplus
  paid to the borrower's **wallet** as the principal asset, exactly as the
  spec says surplus should travel. Unsold collateral stays pledged and
  becomes borrower-claimable.
- **Partial mode needs the offer's partial-repay opt-in** (refused
  `PartialRepayNotAllowed()` without it) and **never leaves the position
  less healthy**: 0.1 collateral sold, principal 1,000 → 800, HF 2.0 → 2.3.

**The divergence.** The sale is **exact-in on the caller's cap**:
`maxCollateralIn` is the amount sold, not an upper bound on it. A 0.6 cap
sold all 0.6 and returned 199.04 of surplus; the full 1.25 cap sold
everything and returned 1,499.04. The spec frames surplus as arising from a
*favourable quote* on a sale sized to the debt, and the natspec calls the
parameter an "upper bound" — both read as "sell up to this much". So an
over-sized cap converts collateral into the principal asset well beyond what
the repayment needs.

No value is lost beyond slippage, and **no shipped surface drives this path**
(`apps/app` does not call it; only the indexer observes its events), so there
is no current user exposure.

**Owner decision (2026-09-25): the spec is the intent and the code is the
defect.** `maxCollateralIn` is an upper bound; the sale is sized to what the
debt needs, and collateral the debt does not need stays pledged and
claimable. The fix is tracked as **#2317** and recorded in
[`_CodeVsDocsAudit.md`](../FunctionalSpecs/_CodeVsDocsAudit.md). A11.5 now
asserts that intent, so it **FAILS against the live bytecode** and will pass
once the fix is deployed — a red row that means exactly what it says,
rather than a green one that certified the defect.

## 4. The three gates

### 4.1 Sanctions — the Tier-1 / Tier-2 split works exactly as documented

With a stub oracle armed so that every address reads as flagged:

| Path | Tier | Result |
| --- | --- | --- |
| `createOffer` | 1 | `SanctionedAddress(address)` |
| `getOrCreateUserVault` | 1 | `SanctionedAddress(address)` |
| `repayLoan` | 2 | **open** — simulates clean |
| default readback | 2 | **open** |

Position-creating and fund-receiving paths refuse; close-out paths stay open
so the unflagged counterparty can be made whole. Disarming restores
permissionless access immediately.

The live deployment currently has **no oracle set** (`address(0)`), which is
the documented fail-open deploy window. `ProfileFacet.setSanctionsOracle`
remains an outstanding retail post-deploy step.

### 4.2 FINDING — KYC enforcement binds at ACCEPT, not at offer creation

The knob is dormant on retail, as required: `isKYCVerified` and
`meetsKYCRequirement` short-circuit to `true`. Flipping
`setKYCEnforcement(true)` makes both report `false` for an unverified wallet,
and flipping it back restores the retail posture — the knob is clean in both
directions.

But with enforcement **armed**, a $50,000 `createOffer` was still **allowed**;
it was the **accept** that refused, with `KYCRequired()`.

This is not wrong — the offer creates no position — but it is a real
interface consequence for the industrial fork: a maker can post an offer they
are not permitted to have filled, and the refusal lands on the *taker's*
transaction. An industrial-fork interface needs to surface the maker-side
requirement at creation time rather than letting the offer sit un-fillable.
Recorded here rather than acted on, because retail never arms this knob.

### 4.3 Illiquid collateral — dual consent, and an honest refusal

`illiquidToken` reads back with no usable price (`tryGetAssetPrice` →
`false`) and `checkLiquidity` → Illiquid. Against it:

- an offer **is** creatable;
- accepting **without** the explicit acknowledgement is refused with
  `IlliquidAssetNotAcknowledged(address)`;
- accepting **with** `acknowledgedIlliquidCollateralAsset` set succeeds — the
  explicit per-asset consent is the gate;
- and the resulting loan answers `calculateHealthFactor` with
  **`IlliquidLoanNoRiskMath()`** rather than a number.

That last one is the behaviour to protect. The protocol refuses to state a
health factor it cannot substantiate, instead of deriving one from a $0
valuation. Any surface rendering HF must carry the "not applicable — this
position has no priceable collateral" case, and must never coerce the
refusal into `0` or `∞`.

---

## 5. FINDING — the committed deployment artifact does not describe the live Diamond

Independent of the scenarios, and the most actionable item in this document.

`contracts/deployments/base-sepolia/addresses.json` is **internally
inconsistent** and **behind the chain**:

| Source | Count |
| --- | --- |
| `facetCount` field in the artifact | 84 |
| `.facets` keys actually present in the artifact | 78 |
| addresses routed live per `facetAddresses()` | 84 |
| live addresses recorded under **no** `.facets` key | **7** |

(77 of the 78 keys map to a live routed address; the 78th is
`diamondCutFacet`, which the constructor installs outside the `facetAddresses()`
enumeration and so is correctly absent from it.)

The seven unrecorded implementations, by address and routed selector count:

```
0x3480d4cf57a54a387e6d97c694ede7526f68b5cd   2 selectors
0x5e0b36b7c9c766d1d1aef32e007262c1cb9fe69b   1
0xc3a16f0465660a8ddaf7a7b898971161e99e78ca   2
0x64fd15903602ab91d55d205e6f751d8d1155d6d9   3
0x8f81848718c090a0b04c83ba952434fa95c61bdd   1
0x953381520af2482c8d339021b66d3f2f69b3245f   1
0xe1616a1c9e893d1c06be36ddeaaed4d1dc128c28   1
```

Separately, `contracts/deployments/base-sepolia/deployment_source.json` names
a **different diamond entirely** (`0x725C7912956b254030A2DBF152B2F739C46C07c0`)
and a `deployedAt` of 2026-05-11. It is stale.

**This is the `writeFacet`-omission class that #1793 catalogued and #1800
closed.** The guard #1800 added — `DeployDiamond` Step 7b, which reads the
artifact back and requires every address `facetAddresses()` reports to appear
under some `.facets` key — would **fail** on an artifact in this state. The
live deployment predates that guard, which is exactly why it is in this
state.

**No address is lost.** Every implementation stays recoverable on-chain via
`DiamondLoupeFacet.facetAddress(bytes4)` / `facetAddresses()`, and from the
broadcast logs. The cost is inventory accuracy, not funds.

**Remedy:** the refresh-and-re-export that this session could not perform
(§6) is the fix — a `DeployDiamond` or `RefreshAllFacetsInPlace` run today
writes all the keys and the Step 7b readback then holds the artifact honest
from here on.

---

## 6. The refresh-and-re-export half: what has and has not been done

The request had two halves. The verification half is above. The other half —
**refresh the contracts on Base Sepolia and re-export the ABIs** — splits
into two parts that turned out to have different answers:

- **ABI re-export — run, and a no-op.** With Foundry installed from its
  official npm packages, `exportFrontendAbis.sh` ran end to end on
  2026-09-25 (it compiles `src/` + `script/` only, `forge build --skip test`,
  which fits this container's 15 GB comfortably — the ≈17.7 GB figure is the
  test-inclusive default build, which the export does not need). Every
  per-facet ABI it regenerated was byte-identical to the committed one; the
  only change was the provenance stamp, which was not committed. The
  frontend, Workers and this driver are therefore already reading ABIs that
  match the source tree.
- **On-chain refresh — still an operator action.** The live Diamond's owner
  is `0xF718BaE5e0dc36140F16dAEF73289294c2372030` (read from `owner()`, and
  it matches the artifact's `admin`). `RefreshAllFacetsInPlace.s.sol` signs
  its cuts with `ADMIN_PRIVATE_KEY`, which must be that account's key. None
  of the dev test wallets supplied for this work is that account, so they
  cannot perform the cut — a refresh needs the admin key provisioned to the
  environment as a secret, never pasted into a conversation. A fork
  REHEARSAL of the same refresh (impersonating the admin on Anvil) needs no
  key and is the natural first step once the swap-to-repay fix (#2317) is
  in the source, so the refresh ships that too.

Nothing was merged to `main` on the refresh half: a "refreshed" deployment
record with no deploy behind it would be worse than the stale one it would
replace.

## 7. Ledger

The full 129-row ledger, with per-scenario verdicts and observed numbers, is
regenerated as `contracts/script/fork-scenarios/last-run.json` on every run
(untracked). Scenario ids map to the driver's files:

| Ids | File | Covers |
| --- | --- | --- |
| A1.* | `01-config-and-vault.mjs` | deployment config, per-user vault, Diamond-internal gating |
| A2.* | `02-lifecycle-fees.mjs` | offer → accept → fees → repay → claim, position NFTs |
| A3.* | `03-forced-close.mjs` | time-based default, HF liquidation, depth-floor finding |
| A4.* | `04-early-exit.mjs` | preclose, partial repay, lender sale listing |
| A5.* | `05-gates.mjs` | sanctions, KYC, illiquid dual consent |
| A6.* | `06-collateral-and-refinance.mjs` | surplus-collateral release, refinance consent + the four-NFT invariant |
| A7.* | `07-offset-and-handover.mjs` | the offset route's automatic completion, obligation handover |
| A8.* | `08-lender-exit.mjs` | the lender's listed sale through to completion, and the direct sale |
| A9.* | `09-periodic-interest.mjs` | periodic interest: the dormant posture, admission rules, both settlement paths |
| A10.* | `10-nft-rental.mjs` | ERC-721 rental against the spec's custody-vs-use model, early close, claims |
| A11.* | `11-swap-to-repay.mjs` | repaying from collateral: authority, the cap, full and partial modes |

The ten `INFO` rows, each an observation with no assertion behind it:

- **Deployment configuration** — the sanctions oracle and KYC posture (A1.2,
  A5.1) and the periodic-interest switch (A9.1). These are values an
  operator or governance sets, so a later deploy that wires the oracle or
  arms the feature must not keep reporting a green "unset". (The first run
  recorded them as PASS.)
- **The live facet count** (A1.6), an observation feeding §5.
- **Findings written up rather than certified** — the depth-floor flip
  (A3.10, §2.4) and where the KYC gate binds (A5.9, §4.2; the first run
  recorded it as PASS, which would have certified a behaviour this document
  calls a finding).
- **Shapes worth writing down** — the two post-claim NFT readbacks (A2.16,
  §1.4), the offset vehicle's offer type (A7.2b, §3A.3; its mirror, the sale
  vehicle, is asserted as A8.1), and a rental's health-factor refusal
  (A10.5, §3C).

A3.2 asserts RELATIVE to what the chain reports: it reads this deployment's
effective grace window — **1 day for a 7-day loan** — and requires the loan
not to be defaultable half a day past term. (The first revision of this
document said 3 days; the chain answers 86,400 s. The probe warps HALF a day,
because a full day lands exactly on a 1-day boundary and flipped with the
second the warp landed on.)

---

## 8. Follow-ups this run raises

1. **Refresh Base Sepolia and re-export the ABIs + deployments** (operator —
   §6), which also repairs the artifact drift in §5 and the stale
   `deployment_source.json` — tracked as **#2313**.
2. **Re-seed the mock `tLIQ` pool with more depth** so HF liquidation is
   exercisable on the testnet through a collateral price move (§2.4) —
   tracked as **#2314**.
3. **Fix swap-to-repay to sell only what the debt needs** — the owner
   decided on 2026-09-25 that `maxCollateralIn` is an upper bound, as the
   spec and natspec say, and the live exact-in behaviour is the defect (§3D)
   — tracked as **#2317**, recorded in `_CodeVsDocsAudit.md`; A11.5 is the
   row that turns green when it ships.

Two items were on this list in the first revision of this document and have
been **withdrawn**, because scouting `apps/app` afterwards found both already
shipped — stating full-term interest in the preclose quote (§3.1, done
tri-state via `EarlyRepayOptionsCard` + the three `closeEarlyCost*` strings)
and distinguishing *repaid* from *repaid and claimed* (§1.3, done via the
Claims page, `ClaimAllCard` and the close-early confirmation copy). They are
recorded as withdrawn rather than deleted: a verification record that quietly
drops a claim it made is harder to trust than one that says it was wrong.
Both observations remain in their sections as protocol shapes a *new* surface
must honour.
