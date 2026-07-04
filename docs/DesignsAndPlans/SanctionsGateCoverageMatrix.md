# Sanctions-Gate Coverage Matrix (#921 item 2 / #954)

> **Canonical behaviour reference:** the single source of truth for each
> action family's sanctions posture is
> [`SanctionsAndTermsGateMatrix.md`](SanctionsAndTermsGateMatrix.md) — the
> per-method action matrix. THIS document is the point-in-time **audit sweep**
> that produced those postures (the methodology + the gaps found/fixed) plus the
> `SanctionsGateGuardrailTest` linkage. When a new state-creating / fund-
> receiving method is added, classify + gate it and update the action matrix;
> this sweep record is not re-run per PR.

Audit of **every external/public facet method** for its intended sanctions
gate, prompted by #921 item 1 finding that `claimInteractionRewards` had
slipped through the Tier-1/Tier-2 classification without its gate (fixed in
#953). That proved the classification is not self-enforcing — a new facet
method can be added without its intended gate and nothing catches it.

## Classification rule (retail deploy — sanctions ON, KYC/country OFF)

The canonical gate is `LibVaipakam._assertNotSanctioned(who)` (reverts
`SanctionedAddress(who)` when `who` is flagged by the on-chain oracle; no-op
while the oracle is unset). Every external/public method is one of:

- **Tier-1** — CREATES protocol state (new position / offer / vault / listing /
  intent) **or** DELIVERS value to the caller (funds / VPFI / collateral /
  rewards / surplus). Must screen the acting party (usually `msg.sender`,
  sometimes a resolved NFT-holder / `owner`) **before** the state/value move.
- **Tier-2** — a CLOSE-OUT that must complete so an **unflagged counterparty**
  is made whole even when the other party is flagged (`repayLoan`,
  `markDefaulted`/`triggerDefault`, time-based liquidation, periodic
  auto-deduct). Must **not** gate the caller. Sanctions are enforced at the
  **proceeds destination** instead — via the #821/#832 *freeze-at-source*
  primitives (`LibSanctionedLock.depositLocked` / `vaultWithdrawERC20MoveOut` /
  the vault-lock), and/or by screening the direct-payout recipient only.
- **N/A** — pure `view`/`pure`; admin/governance config with no caller value
  flow; `msg.sender == address(this)` internal cross-facet entries (screened
  upstream); CCIP inbound (messenger-gated); token-receipt callbacks.

## Method

Four parallel audits swept the facet set by name range (A–D / E–L / M–R / S–Z),
classifying every external/public function and tracing whether a caller screen
is actually *reachable* before the fund/state mutation (a check in a called
helper counts; a check in a different function does not). Every flagged gap was
then re-verified by hand against the source before any fix. Result: **265
external/public functions across 63 facets**; the clear Tier-1 retail
chokepoints were already gated; **4 genuine Tier-1 gaps** and **0
wrongly-gated Tier-2 close-outs** were found.

## Gaps found + fixed

| # | Method | Why it's a Tier-1 gap | Fix |
|---|--------|-----------------------|-----|
| 1 | `BackstopFacet.setOfferBackstopEligible` | Creator opt-in stages an offer for a fill funded by **treasury** capital; gated only by `o.creator == msg.sender`. A wallet flagged *after* `createOffer` could re-stage; downstream `backstopFill → matchIntent` screens only the vault, never the offer creator. | `_assertNotSanctioned(msg.sender)` at opt-in. |
| 2 | `PartialWithdrawalFacet.partialWithdrawCollateral` | Discretionary value-out — borrower pulls excess ERC-20 collateral to `msg.sender` via the plain `vaultWithdrawERC20` (which does not screen the recipient). Loan stays Active, so it is **not** a close-out; blocking a flagged caller strands nothing (collateral keeps backing the loan). A borrower clean at init but flagged later still holds the NFT and could extract unscreened. | `_assertNotSanctioned(msg.sender)` at entry. |
| 3 | `OfferParallelSaleFacet.postParallelSaleListing` | Stages the offer's collateral for a Seaport sale with a seller-baked fee schedule. The whole facet had **zero** sanctions references — unlike every structurally-identical sibling (`NFTPrepayListingFacet` / `NFTPrepayDutchListingFacet` / `NFTPrepayListingAtomicFacet`), which screen both the caller and the fee-leg recipients. | `_assertNotSanctioned(msg.sender)` + `LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned(feeLegs)`, mirroring the siblings. |
| 4 | `SwapToRepayFacet.swapToRepayFull` (surplus payout) | The close-out itself is correctly Tier-2 (a flagged borrower must be able to settle so the honest lender is made whole), but the **surplus** principal was `safeTransfer`'d directly to the (possibly-flagged) holder's EOA — escaping the freeze-at-source that every vault-based close-out enforces. | Keep the call permissionless; when the current holder is sanctioned, freeze the surplus instead of the direct EOA transfer. Park it in the **stored `loan.borrower`'s** vault via `LibSanctionedLock.depositLocked` — NOT the current holder's: a freshly-transferred position may belong to a wallet with no vault, and the receive exemption refuses to mint one for a flagged wallet (`SanctionedRecipientHasNoVault`), which would revert and brick this must-complete close-out (Codex #981 P1). Record it as a dedicated `borrowerSurplusClaims[loanId]` row so the holder can withdraw it via `claimAsBorrower` once delisted — the loan's `borrowerClaims` slot holds the residual collateral (a different asset), so a bare vault balance would be unrealizable (Codex #981 P2). Reserve a VPFI surplus against the unstake path (released at claim) so the stored borrower can't drain a transferred position's proceeds. Unflagged path unchanged (direct EOA). |

## Sweep completion — #954 (Codex #981 / #986)

The initial sweep left five **sibling** close-out surfaces incomplete; #954
finishes them via the shared `LibCloseoutFreeze` helpers so the swap-to-repay
family can't drift on the encumber-all / tier-exclude rules. See the canonical
[`SanctionsAndTermsGateMatrix.md`](SanctionsAndTermsGateMatrix.md) rows for the
per-action postures.

| # | Surface | Was | Now (#954) |
|---|---------|-----|-----------|
| 5 | `swapToRepayFull` **lender leg** | bare `getOrCreateVault(loan.lender)` deposit — bricks for a lender flagged after init | `LibCloseoutFreeze.freezeLenderProceeds` — receive-side `depositLocked` + encumber-all-ERC20 + frozen-VPFI tier-exclude for a transferred-and-sanctioned holder |
| 6 | `swapToRepayFull` **collateral pull + partial-fill refund** | bare vault withdraw / refund — bricks for a flagged self-holder | two NARROW from-side move-out windows (`vaultWithdrawERC20MoveOut` for the pull; `beginMoveOut`/`endMoveOut` for the refund), neither spanning the external swap |
| 7 | `swapToRepayFull` **surplus** encumber | reserved VPFI only | encumber EVERY ERC20 surplus (`freeBalance` gates any-asset signed-offer spend) + `frozenVpfiOwedByVault` tier-exclude |
| 8 | `swapToRepayPartial` direct payouts | unscreened EOA transfers to lender + borrower holders | Tier-1 `_assertNotSanctioned` on both (discretionary → screen, mirrors `repayPartial`) |
| 9 | Fusion intent fill `LibSwapToRepayIntentSettlement._runSettlement` | ZERO sanctions handling | same freeze pattern via `LibCloseoutFreeze` (lender leg + surplus) + residual move-out window; residual re-lien already present |
| 10 | `backstopFill` | creator screened only at opt-in | re-screen `o.creator` at fill, before `executeFill` (Tier-1) |

**Escrow hardening (#954 §2):** a frozen surplus is now encumbered for every
ERC20 (not just VPFI) so the stored party can't spend a transferred position's
proceeds via the signed-offer path; a dedicated per-owner
`frozenVpfiOwedByVault` counter (with exact per-loan release records) keeps
frozen VPFI out of the vault owner's fee tier without touching the shared
`s.encumbered` bucket; `claimAsLender`'s settle predicate keeps a surplus-only
loan open until the surplus is claimed; and the surplus lane is surfaced by
`ClaimFacet.getBorrowerSurplusClaim`, `MetricsFacet.getNFTPositionSummary`, and
the dashboard claimables + a `BorrowerSurplusClaimed` event.

## Confirmed-correct highlights (not gaps)

- **Tier-1 chokepoints already gated:** `createOffer`/`createOfferWithPermit`,
  `acceptOffer`/`WithPermit`, `matchOffers`/`matchSignedOffer`/`matchIntent`,
  `getOrCreateUserVault`, VPFI `deposit`/`withdraw`, `recoverStuckERC20`,
  position-NFT `transferFrom`/`safeTransferFrom` (freeze-at-source screens BOTH
  parties, #821/#832), `triggerLiquidation`(+partial/discounted/split/internal),
  `settlePeriodicInterest`, `precloseDirect`/`transferObligationViaOffer`,
  `refinanceLoan`, `addCollateral`, `extendLoanInPlace`, `sellLoanViaBuyOffer`/
  `createLoanSaleOffer`/`completeLoanSale`, `withdrawSalary`, the NFT-prepay
  listing family, `setLenderIntent`/`fundLenderIntent`/`withdrawLenderIntentCapital`/
  `rollIntentLoan`, `claimInteractionRewards` (#953), the Claim family.
- **Tier-2 close-outs correctly NOT caller-gated:** `repayLoan`,
  `autoDeductDaily`, `triggerDefault`, `completeOffset`, the swap-to-repay
  intent cancels — each either screens only the direct-payout recipient or uses
  `LibSanctionedLock` freeze-at-source; gating the caller would strand the
  honest counterparty.
- **Wind-down / cancel paths deliberately ungated:** `cancelOffer`,
  `cancelLenderIntent`, `cancelSignedOffer`, listing teardowns — no value out,
  analogous to `cancelOffer`.

## Guardrail against silent recurrence

`contracts/test/SanctionsGateGuardrailTest.t.sol` pins the fixed Tier-1 entry
points: it flags a wallet via a mock sanctions oracle and asserts each reverts
`SanctionedAddress`. A future edit that drops one of these gates fails the test.
The curated list is the maintenance surface — when a new state-creating /
fund-receiving facet method is added, classify it (Tier-1 / Tier-2 / N/A) per
the rule above, gate it accordingly, and (if Tier-1) add it to the guardrail.

Origin: #921 (alpha02 review) item 2.
