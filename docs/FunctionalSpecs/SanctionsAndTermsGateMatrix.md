# Sanctions & Terms-Gate Action Matrix

**Status:** intended-behaviour specification (the test oracle). This document is
sourced from the canonical specs — `docs/FunctionalSpecs/ProjectDetailsREADME.md`
§ *Regulatory Compliance Considerations* and `docs/FunctionalSpecs/WebsiteReadme.md`
§ *Legal and data-rights requirements* / *Sanctions-screening UX* — not
transcribed from the contracts. The "Verified at" / "Tested by" columns are
references to where the behaviour is enforced and exercised today; if the code
ever diverges from the intended behaviour below, that divergence is a bug to be
logged in `_CodeVsDocsAudit.md`, not a reason to edit this matrix.

This addresses GitHub issue #800 (sanctions + Terms-gate consistency across
protocol and UI). It is the single place that states, per action family, what
the protocol and UI are *meant* to do for a sanctions-flagged wallet and for the
Terms-of-Service gate.

## Retail policy context

Per the retail-deploy policy (`CLAUDE.md` → *Retail-deploy policy — sanctions
ON; KYC / country-pair OFF*):

- **Sanctions screening is REQUIRED** on the retail deploy once the on-chain
  oracle address is configured (`ProfileFacet.setSanctionsOracle`). KYC and
  country-pair gating stay **disabled** on retail and are out of scope here
  (they are the dormant industrial-fork knobs).
- This matrix therefore covers **sanctions** and the **versioned Terms-of-Service
  gate** only — the two compliance gates that are live on the retail product.

## Sanctions tier model

Address-level screening splits every action into one of three buckets:

- **Tier-1 — BLOCK.** Reverts `SanctionedAddress(who)` for a flagged wallet.
  Applied to entry points that **create fresh state for the caller, take in or
  route new value, pay the caller a protocol incentive, or pay protocol value
  OUT to the caller (claims)**.
- **Tier-2 — ALLOW (wind-down / recovery).** Debt-closing and safety paths that
  are *intended* to stay available so an **unflagged counterparty can be made
  whole** even when the other party is flagged. A flagged borrower can still be
  repaid / defaulted / liquidated against. **Important divergence (see Open
  gaps):** the *intent* is that any protocol value owed to a flagged *recipient*
  defers to a Tier-1 claim rather than being paid inline — but the current
  implementation only achieves that where an explicit held-proceeds escrow or the
  consolidation-move-out exemption applies. Most settlement branches deposit the
  recipient's share through `vaultDepositERC20From(...)` / `LibFacet.getOrCreateVault(...)`,
  which resolve the recipient's vault via `getOrCreateUserVault`, and that helper
  **screens the vault owner** (`_assertNotSanctioned`) for everyone except the
  narrow consolidation-move-out exemption. So when the **flagged party is the
  recipient loan party** (e.g. a flagged `loan.lender` on full `repayLoan`, or a
  flagged surplus-recipient `loan.borrower` on liquidation/default), the close-out
  currently **reverts** rather than deferring cleanly — the unflagged counterparty
  is *not* made whole until the flag clears or the path is hardened. This is a
  cross-cutting enforcement gap, recorded below.
- **Fail-open while unconfigured (with one fail-safe exception).** While the
  sanctions oracle is unset (`address(0)`), `isSanctionedAddress` returns `false`
  for everyone and every ordinary gate is a no-op — the intentional fail-open
  during the deploy window. An oracle **read revert** also fails open (treated as
  "not sanctioned") so an oracle outage cannot freeze the protocol. **Exception —
  stuck-vault recovery is deliberately fail-SAFE:** `VaultFactoryFacet.recoverStuckERC20`
  re-validates the declared recovery source and **reverts `SanctionsOracleUnavailable`
  when the oracle is unset or reverts**, rather than fail-open, because routing a
  recovery while screening is unavailable would be the dangerous direction. The
  vault-recovery flow therefore does NOT inherit the general fail-open posture.

Canonical helper: `LibVaipakam._assertNotSanctioned(who)` (the shared Tier-1
gate). Read-only screen: `LibVaipakam.isSanctionedAddress(who)` (also exposed as
`ProfileFacet.isSanctionedAddress` for the UI).

## Action matrix — sanctions

| Action family | Sanctions behaviour | Who is screened | Verified at | Tested by |
| --- | --- | --- | --- | --- |
| Vault creation (`getOrCreateUserVault`) | **Tier-1 BLOCK** | the user the vault is for | `VaultFactoryFacet` | `SanctionsOracle.t.sol::test_getOrCreateUserVault_RevertsWhenSanctioned` |
| Offer create | **Tier-1 BLOCK** | offer creator | `OfferCreateFacet` | `…::test_createOffer_RevertsWhenCallerSanctioned` |
| Offer accept | **Tier-1 BLOCK** | acceptor **and** offer creator (so a creator flagged after posting can't drag in an unflagged acceptor) | `OfferAcceptFacet` | `…::test_acceptOffer_RevertsWhenAcceptorSanctioned`, `…::test_acceptOffer_RevertsWhenCreatorSanctionedAfterPosting` |
| Permissionless matcher fills | **Tier-1 BLOCK** | the matcher (LIF/incentive recipient); the signed-fill path also screens the resolved `lender` | `OfferMatchFacet` (`_assertNotSanctioned(msg.sender)` on the fill paths) | `MatchOffersScaffoldTest.t.sol::test_matchOffers_sanctionedMatcher_reverts` |
| VPFI deposit / withdraw | **Tier-1 BLOCK** | the caller (value in/out). NOTE the **Permit2 deposit** (`depositVPFIToVaultWithPermit`) is a separate selector with its **own** sanctions gate — exercised by code review, **not** by the #800 tests (which cover only classic `depositVPFIToVault` + withdraw); see test gaps | `VPFIDiscountFacet` | `VPFIDiscountFacetTest.t.sol::test_depositVPFIToVault_RevertsWhenSanctioned`, `…::test_withdrawVPFIFromVault_RevertsWhenSanctioned` (classic path only) |
| Salary withdrawal (`PayrollFacet.withdrawSalary`) | **Tier-1 BLOCK** — a protocol-funded value-OUT path to `msg.sender`, gated `_assertNotSanctioned(msg.sender)` | the caller (recipient) | `PayrollFacet` | gap — see Open gaps |
| Standing lender-intent capital (`setLenderIntent`, `fundLenderIntent`, `withdrawLenderIntentCapital`, `rollIntentLoan`) | **Tier-1 BLOCK** — each creates a lending commitment, takes capital into custody, returns capital, or recommits proceeds, and carries its own sanctions screen (separate from the auto-lifecycle keeper rows below) | the intent owner / caller | `LenderIntentFacet` | gap — see Open gaps |
| VPFI tier-poke broadcast (`pokeMyTier`) | **Tier-1 BLOCK** | the caller — a user-initiated state mutation that can drive a protocol-funded CCIP tier broadcast | `VPFIDiscountFacet.pokeMyTier` | `PokeMyTierTest.t.sol::test_PokeMyTier_SanctionedCaller_Reverts` |
| Collateral top-up (`addCollateral`) | **Tier-1 BLOCK** (#820) — screens the payer / current borrower-NFT holder (`_assertNotSanctioned(msg.sender)`, who `requireBorrowerNftOwner` binds to the current holder) in addition to the stored `loan.borrower` vault screen | the payer / current borrower-NFT holder | `AddCollateralFacet` | `AddCollateralFacetTest.t.sol::test_addCollateral_RevertsWhenTransferredHolderSanctioned` |
| Offer mutation (`setOfferAmount` / `setOfferRate` / `setOfferCollateral` / `modifyOffer`) | **Tier-1 BLOCK** | the offer creator | `OfferMutateFacet` | `OfferModificationTest.t.sol` (sanctions cases) |
| HF-based liquidation (`triggerLiquidation`, partial, split) | **Tier-1 BLOCK on the liquidator** (3% bonus recipient). Note the same loan-party divergence as default: the settlement branch resolves `loan.lender`'s (and any surplus `loan.borrower`'s) vault via `getOrCreateVault` → `getOrCreateUserVault`, which screens that owner, so a **flagged loan party bricks the liquidation** rather than deferring — an enforcement gap | the liquidator (Tier-1); flagged **loan party bricks** settlement (gap) | `RiskFacet`, `RiskSplitLiquidationFacet` | `…::test_triggerLiquidation_RevertsWhenSanctionedLiquidator`, `…::testPartialLiq_SanctionedCallerReverts` |
| HF-based liquidation — discounted (`triggerLiquidationDiscounted`) | **Tier-1 BLOCK on the caller AND the seized-collateral `recipient`** (#816) — both are screened (`_assertNotSanctioned`), so a clean liquidator can't route bought collateral to a flagged recipient. (The loan-party-vault brick on the lender/borrower settlement side is the cross-cutting #821 gap, as in the atomic liquidation row.) | the caller and the `recipient` | `RiskFacet.triggerLiquidationDiscounted` | `RiskFacetTest.t.sol::test_triggerLiquidationDiscounted_RevertsWhenRecipientSanctioned` |
| Time-based default (`triggerDefault`) | **Tier-2 ALLOW (intended)** — not caller-gated; settlement value flows to the loan's parties, not the caller. The internal-match auto-dispatch matcher bonus is now **screened (#817)**: for a sanctioned matcher the objective match still executes (skipping it would let a flagged caller degrade settlement to the external/FallbackPending path) but the 1% incentive is zeroed and folded into the lenders' shares, so no bonus reaches the flagged wallet. **Remaining divergence (#821):** the settlement branches call `LibFacet.getOrCreateVault(loan.lender)` and, on surplus, `getOrCreateVault(loan.borrower)`, which screen those vault owners — so a **flagged loan party (lender, or surplus-recipient borrower) bricks the default** rather than deferring cleanly | not the caller (bonus skipped for a flagged matcher); flagged **loan party bricks** settlement (#821) | `DefaultedFacet` (no caller gate); auto-dispatch screen in `RiskMatchLiquidationFacet` | `InternalMatchAutoDispatch.t.sol::test_attemptAutoDispatch_sanctionedMatcher_settlesWithoutBonus`; loan-party-brick tracked under #821 |
| Repayment — full (`repayLoan`) | **Tier-2 ALLOW for a flagged borrower** (full repay stays open — tested). **Flagged lender diverges from intent:** in the common case where the current lender is still `loan.lender`, the path deposits `plan.lenderDue` via `vaultDepositERC20From(…, loan.lender, …)` → `getOrCreateUserVault(loan.lender)`, which screens and **reverts** for a flagged `loan.lender`. So a flagged lender currently **bricks full repay** rather than the proceeds deferring to a Tier-1 claim — an enforcement gap, not the clean deferral originally intended | flagged **borrower** OK (tested); flagged **lender bricks** repay (gap) | `RepayFacet.repayLoan` | `SanctionsOracle.t.sol::test_SanctionedBorrower_CanStillRepay_LenderRecovers` (borrower-flagged direction only) |
| Repayment — periodic / direct-partial (`autoDeductDaily`, `settlePeriodicInterest`, `repayPartial`) | **Per-entry-point, branch-dependent.** `settlePeriodicInterest` screens the **settler (`msg.sender`) first**; then if `shortfall == 0` it only advances the checkpoint and returns (**no lender screen** on that just-stamp path), and the lender recipient is screened **only in the auto-liquidate payout branch** (a flagged lender makes that branch **revert**, no deferred claim). `autoDeductDaily` (permissionless NFT-rental deduction) does **NOT** screen the caller at all — it screens **only the resolved `lenderRecipient`** on the inline transfer. `repayPartial` likewise screens the resolved lender recipient inline | `settlePeriodicInterest`: settler **and** (payout-branch) lender; `autoDeductDaily` / `repayPartial`: lender recipient only (**caller unscreened**) | `RepayPeriodicFacet` (`autoDeductDaily` L184 lender-only; `settlePeriodicInterest` L431 settler + payout-branch lender), `RepayFacet.repayPartial` | gap — see Open gaps |
| Claims (`claimAsLender`, `claimAsBorrower`, backstop opt-in) | **Tier-1 BLOCK** | the **claimant** (recipient) — unconditional, before any distribution | `ClaimFacet` | `…::test_claimAsLender_RevertsWhenSanctioned`, `…::test_claimAsBorrower_RevertsWhenSanctioned` (the **backstop opt-in** entry point shares the same gate but has **no dedicated test** — see test gaps) |
| Refinance (`refinanceLoan`) | **Tier-1 BLOCK** | the borrower **and** the current borrower-NFT holder | `RefinanceFacet` | gap — see Open gaps |
| Obligation transfer / preclose | **Tier-1 on the caller AND the current holder** for the **initiation** path (#819): `transferObligationViaOffer` now screens the exiting borrower-position holder (`_assertNotSanctioned(ownerOf(borrowerTokenId))`), not just `msg.sender`, so a keeper can't withdraw exiting collateral to a flagged holder. (`precloseDirect` already defers the exiting borrower's proceeds to a Tier-1-gated `claimAsBorrower`, so the holder is screened at claim time.) The `completeOffset` **completion** path's flagged-after-initiation residual is the #821 deferred-proceeds case | the caller and (initiation) the current holder | `PrecloseFacet` | `PrecloseFacetTest.t.sol::test_transferObligationViaOffer_RevertsWhenTransferredHolderSanctioned_viaKeeper` |
| Loan-sale / prepay listing & settlement | **Tier-1 BLOCK** (#818 + #825-r3) — the atomic-match, auto-list, and executor-callback paths were already gated; the manual fixed-price `postPrepayListing` / `updatePrepayListing` AND the Dutch `postPrepayDutchListing` / `updatePrepayDutchListing` paths now also call `_assertNotSanctioned` on the holder (`holder == msg.sender`) AND on every caller-supplied **fee-leg recipient** (`LibPrepayListingWiring.assertFeeLegRecipientsNotSanctioned`). To close the sign-time-vs-fill-time gap, the Seaport **fill** is also re-screened: `CollateralListingExecutor._checkOrderPreconditions` (run from `authorizeOrder` + `validateOrder`) rejects the fill if the live current borrower recipient or any recorded fee-leg recipient is flagged at fill time — so a recipient flagged AFTER posting can't be paid on fill (the buyer's funds are never committed, so nothing is stranded) | the caller / holder + fee-leg recipients at post/update; the live borrower + fee-leg recipients at fill | `NFTPrepayListingFacet` / `NFTPrepayDutchListingFacet` post+update; `CollateralListingExecutor` fill | `NFTPrepayListingFacetTest.t.sol::test_postPrepayListing_revertsWhenHolderSanctioned`, `…::test_postPrepayListing_revertsWhenFeeLegRecipientSanctioned`, `CollateralListingExecutorTest.t.sol::test_authorizeOrder_revertsWhenBorrowerRecipientSanctioned`, `…::test_authorizeOrder_revertsWhenFeeLegRecipientSanctioned` |
| Early withdrawal | **Tier-1 on the caller AND the lender holder** for the **initiation** path (#819): `createLoanSaleOffer` now screens the current lender-position holder (`_assertNotSanctioned(ownerOf(lenderTokenId))`), not just `msg.sender`, so a keeper can't list a flagged holder's position for sale. The `completeLoanSale` **completion** path's flagged-after-listing residual (a committed buyer) is the #821 deferred-proceeds case | the caller and (initiation) the lender holder | `EarlyWithdrawalFacet` | `EarlyWithdrawalFacetTest.t.sol::test_createLoanSaleOffer_RevertsWhenLenderHolderSanctioned_viaKeeper` |
| Keeper-driven auto-lifecycle (auto-refinance / auto-extend) | **Tier-1 BLOCK** | the keeper **and** the participating NFT holders | auto-refinance: `RefinanceFacet._refinanceLoanLogic` (screens `msg.sender` + `currentBorrowerNftOwner`); auto-extend: `AutoLifecycleFacet` | gap — see Open gaps |
| Keeper reward payout (VPFI housekeeping reward) | **Soft-skip (NOT a revert)** — when the keeper is flagged the reward is forfeited (returns 0 + emits `KeeperRewardSkipped("sanctioned-keeper")`) so the housekeeping/sweep tx still completes; liveness is preserved and no value reaches the flagged keeper | the keeper (reward recipient) | `LibKeeperReward.payVpfiReward` | gap — see Open gaps |
| Offer cancel | **No direct gate, but indirectly blocked — enforcement gap.** `cancelOffer` itself calls no `_assertNotSanctioned`, but the refund routes through `VaultFactoryFacet.vaultWithdraw*` with `creator` as the vault owner, which resolves the creator's vault via `getOrCreateUserVault(creator)` → screens the creator. So a creator **flagged after posting** an unfilled offer (or a third party clearing that creator's expired offer) **reverts before the refund** — the creator's own escrowed capital can't be wound down while flagged. Intended as wind-down of one's own capital; the recipient-vault screen diverges | the **creator** (indirectly, via the refund vault) | `OfferCancelFacet.cancelOffer` (no direct gate; indirect vault-owner screen) | gap — see Open gaps |

**Invariant (intent):** no Tier-1 path may route fresh value to a flagged wallet,
and no Tier-2 path may be turned into a fresh-value path for a flagged wallet.
The mechanism is that value owed to a flagged recipient on a wind-down path is
**parked in that recipient's own vault, LOCKED** behind the Tier-1 claim gate
(see #821 below), so the close-out completes (the unflagged counterparty is made
whole) without routing spendable value to the flagged wallet. The remaining gaps
are now of one kind:

- **Liveness bricks (#821: RESOLVED for repay/default/liquidation).** The
  wind-down close-outs (`repayLoan` full, `triggerDefault`, HF-based liquidation)
  used to **revert** when the recipient loan party was flagged (the
  `getOrCreateUserVault` recipient screen), bricking the close-out. Now a
  receive-side exemption parks the flagged recipient's share in their own
  existing vault, frozen behind the claim-side stored-owner screen, so the
  counterparty is made whole. `cancelOffer` intentionally still reverts (the
  creator's own escrow → freeze, no counterparty to make whole). The one
  remaining liveness residual is the `completeLoanSale` / `completeOffset`
  **completion** paths (a committed buyer) — a tracked follow-up in
  `_CodeVsDocsAudit.md`.
- **Value-to-flagged bypasses (the safe direction is also breached).** Several
  gaps let value actually reach or benefit a flagged wallet: a flagged
  `triggerLiquidationDiscounted` `recipient` receives the bought collateral
  (gap (c)); the default auto-dispatch pays an unscreened caller the matcher
  bonus (gap (d)); a flagged borrower-NFT holder can post/update a
  collateral-sale listing (gap (a)); a sanctioned current holder can top up
  collateral (gap (e)); and the keeper preclose / early-withdrawal paths can
  route exiting collateral to a flagged holder (gap (b)). These are
  value-out compliance bypasses, not liveness-only issues.

So the invariant holds on the **centralised Tier-1 entry points** but is broken
by the enumerated enforcement gaps in both directions — see Open gaps and the
`_CodeVsDocsAudit.md` findings.

## Action matrix — Terms-of-Service gate

The Terms gate is a **versioned on-chain acceptance** (`LegalFacet`): a user must
have accepted the **current** Terms version **and** content hash before the gated
app routes. Governance bumps the version/hash via `setCurrentTos`; a bump or hash
change invalidates every prior acceptance.

| State | `hasAcceptedCurrentTerms` | UI behaviour | Tested by |
| --- | --- | --- | --- |
| Disabled (`currentTosVersion == 0`) — testnet / pre-launch | `true` for everyone | no prompt; the connected-app routes stay open | `LegalFacet.t.sol::test_Initial_GateDisabled_EveryoneTreatedAsAccepted` |
| Enabled, user accepted current (version + hash match) | `true` | routes open | `…::test_acceptTerms_Success_EmitsEvent` |
| Enabled, user never accepted | `false` | prompt to accept before gated routes | `…::test_acceptTerms_RevertOnVersionMismatch` / `…RevertOnHashMismatch` |
| Stale — Terms re-published (version bumped) since acceptance | `false` | prompt to re-accept | `…::test_VersionBump_InvalidatesPriorAcceptance`, `…::test_SameVersion_HashDrift_InvalidatesAcceptance` |

`setCurrentTos` enforces a **strictly increasing** version (it reverts otherwise)
and requires a non-zero hash, but does **not** require the hash to *differ* from
the previous one — so a version-only bump (new version, same content hash) is a
valid governance action and still invalidates every prior acceptance via the
version mismatch. There is therefore no reachable "same version, new hash"
public-governance state (the `test_SameVersion_HashDrift…` case exercises a
v1→v2 bump with a new hash; a literal same-version hash change is only reachable
by direct storage corruption, not by governance). `acceptTerms(version, hash)`
reverts `InvalidTosVersion` unless the submitted pair matches the live
`(currentTosVersion, currentTosHash)`,
so a client can never record acceptance of a stale or mismatched Terms revision.

## UI rules

**Sanctions banner (`SanctionsBanner` + `useSanctionsCheck`):**

- Shows **only** when the relevant address is flagged — the connected wallet, or
  a relevant counterparty (e.g. an offer's creator before accepting). A clean
  wallet sees **no** persistent sanctions banner.
- Fails open: while the oracle is unset or a read errors, the banner renders
  nothing (matches the protocol's fail-open).
- Copy must distinguish **blocked fresh-value actions** from **permitted
  recovery / wind-down paths**, and point the user to the sanctions-data
  provider (Chainalysis) for recourse — never present a flagged wallet as
  permanently and totally frozen when close-out paths remain open.
- Currently mounted on these connected-app surfaces: **Dashboard, Offer Book
  (the accept/review modal only — NOT the offer-list page itself), Create Offer,
  Loan Details, Claim Center, and the VPFI Vault**. A flagged wallet browsing the
  Offer Book list sees no banner until it opens an offer to accept. The standalone
  **Offer Detail** (`/offers/:offerId`) and **vault-recovery** (`/recover`)
  surfaces do **not** mount the banner either — the offer-list surface, Offer
  Detail, and vault-recovery are tracked gaps (see Open gaps), not current
  coverage.

**App-permits-but-protocol-rejects consistency (intended end-state + current
reality):** the protocol is the hard gate — a Tier-1 action by a flagged wallet
reverts regardless of the UI. The sanctions banner *warns* on the surfaces above
so a flagged user is told why the next action will fail. Note the current
limitation: pages do not yet *disable* their submit buttons on the
`useSanctionsCheck().isSanctioned` signal (submit-disable is wired off
loading/input validity only), so a flagged wallet may still see a transaction as
clickable and learn definitively at the protocol revert. Disabling the
submit/action on the flagged signal — to make the app's "what you can do" fully
consistent with the protocol's Tier-1/Tier-2 split — is a recommended hardening,
tracked as a gap rather than asserted as done.

**Terms gate (dapp):** when the gate is enabled and the connected wallet hasn't
accepted the current Terms (version + hash), the app prompts for acceptance
before the gated routes; a version/hash change re-prompts. While disabled
(`currentTosVersion == 0`) the app does not prompt.

**Terms gate — read-failure / loading posture (fail-CLOSED, #822).** Unlike
sanctions, the Terms gate has **no per-action on-chain revert** — it is a
dapp-side routing gate over the on-chain acceptance record, so there is no
protocol backstop if the gate is bypassed in the UI. It therefore **fails
CLOSED** when the gate is enabled but the acceptance/version read is still
loading or fails — the opposite of the sanctions banner's fail-open, because here
a fail-open would let a non-accepting wallet reach gated routes with nothing else
stopping it. `useTosAcceptance` gates `hasAccepted` on a `readOk` flag (true only
after a successful read) and resets `currentVersion = 0` on a read error, so the
unread/errored default is never mistaken for the genuine gate-disabled state;
`LegalGate` renders a neutral loading state while `loading` and a retry state on
a failed read, passing the gated routes through only after a successful read
shows accepted (or genuinely disabled). (Pre-#822 it rendered `children` during
`loading` and treated the errored default `currentVersion = 0` as
gate-disabled — a route-gate bypass.)

## Test coverage & gaps

**Covered today:**

- Sanctions: fail-open (oracle unset + read-revert), Tier-1 block on vault
  creation / offer create / offer accept (acceptor + post-posting creator) /
  liquidation (full + partial) / claims (lender + borrower), and the Tier-2
  wind-down (sanctioned borrower repays → unflagged lender recovers) —
  `contracts/test/SanctionsOracle.t.sol` (mock: `test/mocks/MockSanctionsList.sol`).
  Permissionless matcher fill is covered separately by
  `MatchOffersScaffoldTest.t.sol::test_matchOffers_sanctionedMatcher_reverts`.
- Terms gate: disabled-state, accept-success, version-mismatch / hash-mismatch
  reverts, version-bump and hash-drift invalidation —
  `contracts/test/LegalFacet.t.sol` + `contracts/test/LibAcceptTermsTest.t.sol`.

**Gaps closed alongside this matrix (see the #800 PR):**

- Contract: Tier-1 sanctions revert on **VPFI deposit** (value-in) **and VPFI
  withdraw** (value-out) — the VPFI value paths the prior suite couldn't reach
  (`SanctionsOracle.t.sol`'s diamond doesn't cut the VPFIDiscountFacet
  selectors). Added in `VPFIDiscountFacetTest.t.sol` next to that facet's
  fixture.
- Frontend: `SanctionsBanner` renders for a flagged address and renders nothing
  for a clean address / while loading / when the wallet is unset
  (`apps/defi/test/components/SanctionsBanner.test.tsx`).

**Open gaps (tracked follow-up, not blockers):**

- **Test gaps (gate exists, no dedicated test yet).** The Tier-1 rows marked
  "gap" in the Tested-by column (collateral top-up's `loan.borrower` screen,
  refinance, early withdrawal, auto-lifecycle, standing
  lender-intent capital, `PayrollFacet.withdrawSalary`, the claims **backstop
  opt-in** entry point, the **Permit2** VPFI deposit `depositVPFIToVaultWithPermit`,
  and the periodic / direct-partial repay
  lender-recipient screen) share the identical centralised `_assertNotSanctioned`
  Tier-1 pattern already proven across the representative families (vault / offer
  / matcher fill / liquidation / claims / classic VPFI deposit+withdraw /
  `pokeMyTier`). The gate helper is uniformly applied, so the result is the same;
  a per-row scenario test is low-priority follow-up. The Permit2 deposit
  specifically has its **own** gate on a separate selector, so its test gap means
  a regression there would not be caught by the classic-deposit test.
- **Enforcement gaps — value-to-flagged (CLOSED, #815 group A).** These five
  let a flagged wallet actually receive / benefit from value; all are now
  screened (PRs under #815):
  (a) the fixed-price `postPrepayListing` / `updatePrepayListing` and the Dutch
  `postPrepayDutchListing` / `updatePrepayDutchListing` paths now call
  `_assertNotSanctioned` on the holder (was: ungated) — #818. (b) the
  obligation-transfer (`transferObligationViaOffer`) and loan-sale-listing
  (`createLoanSaleOffer`) **initiation** paths now screen the current position
  holder, not just `msg.sender`, so a keeper can't act for a flagged holder —
  #819. (c) `triggerLiquidationDiscounted` now screens the seized-collateral
  `recipient` arg — #816. (d) `triggerDefault` / HF-liquidation internal-match
  auto-dispatch still **executes the objective match** for a sanctioned matcher
  (skipping it would let a flagged caller degrade settlement to the
  external/FallbackPending path) but **zeroes the 1% incentive**, folding it into
  the lenders' shares, so no bonus reaches the flagged wallet — #817. (e) `addCollateral` now screens the payer / current holder, not just the
  stored `loan.borrower` — #820.
- **Enforcement gap — liveness brick (CLOSED, #821: vault-lock + freeze).**
  (f) The wind-down close-outs (`repayLoan` full, `triggerDefault`, HF-based
  liquidation) deposit the recipient's share through `getOrCreateUserVault`,
  which screens the vault **owner** — previously a flagged *recipient loan party*
  bricked the whole close-out. **Resolved by parking the share in the recipient's
  OWN vault, LOCKED:** a receive-side `getOrCreateUserVault` exemption
  (`sanctionedDepositExemptUser`, mirroring the move-out pin; never mints a new
  vault for a flagged wallet) lets the close-out complete so the unflagged
  counterparty is made whole, while `claimAsLender` / `claimAsBorrower` now screen
  the **stored vault owner**, so a flagged party's vault assets don't move — even
  to a clean current NFT holder (closing the transfer-position-then-claim
  loophole; protocol position sales migrate the stored party, so legitimate
  buyers settle to their own vault unaffected). The vault is isolated per-user, so
  nothing commingles in the Diamond. A `SanctionedProceedsLocked` event records
  each park. The parallel-sale `recordOfferSaleProceeds` live-lender-holder leg is
  screened at fill (atomic, no stranding). **`cancelOffer` is intentionally NOT
  vault-locked:** its refund returns the creator's OWN escrowed funds (a move-OUT
  from their own vault), so with no counterparty to make whole the existing revert
  IS the desired freeze — the flagged creator's escrow stays put until the flag
  clears. (The `completeLoanSale` / `completeOffset` completion-path residual from
  (b) remains the one open follow-up — see the new `_CodeVsDocsAudit.md` finding.)
- **UI submit-disable on the flagged signal.** Pages warn via `SanctionsBanner`
  but do not yet disable their submit buttons on `useSanctionsCheck().isSanctioned`;
  wiring that (so the app never offers a clickable Tier-1 action to a flagged
  wallet) is a recommended hardening.
- **Banner not mounted on several action surfaces.** The banner is on the Offer
  Book accept modal but not the offer-list page, and not on Offer Detail
  (`/offers/:offerId`), vault-recovery (`/recover`), or the routed action pages
  (`/loans/:loanId/preclose`, `/early-withdrawal`, `/refinance`). Adding it to
  those closes the not-yet-covered surfaces.
- The keeper-reward **soft-skip** row is documentation of current behaviour (not
  a value-to-a-flagged-wallet path), so it needs no Tier-1 revert test. The
  **offer-cancel** row is folded into the recipient-vault-brick gap (f) above: it
  is not a fresh-value-to-flagged path, but the indirect refund screen means a
  flagged creator can't wind down their own escrow — that's the liveness gap, not
  a missing block.
