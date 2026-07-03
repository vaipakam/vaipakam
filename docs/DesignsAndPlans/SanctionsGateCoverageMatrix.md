# Sanctions-Gate Coverage Matrix (#921 item 2 / #954)

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
| 4 | `SwapToRepayFacet.swapToRepayFull` (surplus payout) | The close-out itself is correctly Tier-2 (a flagged borrower must be able to settle so the honest lender is made whole), but the **surplus** principal was `safeTransfer`'d directly to the (possibly-flagged) holder's EOA — escaping the freeze-at-source that every vault-based close-out enforces. | Keep the call permissionless; when the holder is sanctioned, freeze the surplus at source via `LibSanctionedLock.depositLocked` (fires `SanctionedProceedsLocked`) instead of the direct EOA transfer. Unflagged path unchanged. |

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
