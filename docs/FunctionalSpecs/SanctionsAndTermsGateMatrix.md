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
| Collateral top-up (`addCollateral`) | **Partial — enforcement gap.** It uses the `Tier2CloseOut` consolidation context (which *skips* screening the sanctioned current holder) and then deposits via `vaultDepositERC20From(msg.sender, loan.borrower, …)`, so the only vault screen is on the stored `loan.borrower`. The **payer / current borrower-NFT holder is not screened** — a sanctioned current holder can still top up | the stored `loan.borrower` only (payer / current holder **unscreened**) | `AddCollateralFacet` | gap — see Open gaps |
| Offer mutation (`setOfferAmount` / `setOfferRate` / `setOfferCollateral` / `modifyOffer`) | **Tier-1 BLOCK** | the offer creator | `OfferMutateFacet` | `OfferModificationTest.t.sol` (sanctions cases) |
| HF-based liquidation (`triggerLiquidation`, partial, split) | **Tier-1 BLOCK on the liquidator** (3% bonus recipient). Note the same loan-party divergence as default: the settlement branch resolves `loan.lender`'s (and any surplus `loan.borrower`'s) vault via `getOrCreateVault` → `getOrCreateUserVault`, which screens that owner, so a **flagged loan party bricks the liquidation** rather than deferring — an enforcement gap | the liquidator (Tier-1); flagged **loan party bricks** settlement (gap) | `RiskFacet`, `RiskSplitLiquidationFacet` | `…::test_triggerLiquidation_RevertsWhenSanctionedLiquidator`, `…::testPartialLiq_SanctionedCallerReverts` |
| HF-based liquidation — discounted (`triggerLiquidationDiscounted`) | **Tier-1 on the caller**, but the seized collateral goes to an arbitrary `recipient` arg that is **not separately screened** — a flagged `recipient` can receive the bought collateral. Recipient-screening is an enforcement **gap** | the caller (recipient unscreened) | `RiskFacet.triggerLiquidationDiscounted` | gap — see Open gaps |
| Time-based default (`triggerDefault`) | **Tier-2 ALLOW (intended)** — not caller-gated; settlement value flows to the loan's parties, not the caller. **Two divergences:** (a) the settlement branches call `LibFacet.getOrCreateVault(loan.lender)` and, on surplus, `getOrCreateVault(loan.borrower)`, which screen those vault owners — so a **flagged loan party (lender, or surplus-recipient borrower) bricks the default** rather than deferring cleanly; (b) the internal-match auto-dispatch (`attemptInternalMatchAutoDispatch`) pays the caller the 1% matcher bonus and does **not** screen the caller — a gap for a flagged caller earning the bonus | not the caller (bonus path **unscreened**); flagged **loan party bricks** settlement | `DefaultedFacet` (no caller gate; vault-owner screen on loan parties) | covered indirectly via the wind-down repay test + design intent; loan-party-brick and match-dispatch screening are gaps |
| Repayment — full (`repayLoan`) | **Tier-2 ALLOW for a flagged borrower** (full repay stays open — tested). **Flagged lender diverges from intent:** in the common case where the current lender is still `loan.lender`, the path deposits `plan.lenderDue` via `vaultDepositERC20From(…, loan.lender, …)` → `getOrCreateUserVault(loan.lender)`, which screens and **reverts** for a flagged `loan.lender`. So a flagged lender currently **bricks full repay** rather than the proceeds deferring to a Tier-1 claim — an enforcement gap, not the clean deferral originally intended | flagged **borrower** OK (tested); flagged **lender bricks** repay (gap) | `RepayFacet.repayLoan` | `SanctionsOracle.t.sol::test_SanctionedBorrower_CanStillRepay_LenderRecovers` (borrower-flagged direction only) |
| Repayment — periodic / direct-partial (`autoDeductDaily`, `settlePeriodicInterest`, `repayPartial`) | **Per-entry-point, branch-dependent.** `settlePeriodicInterest` screens the **settler (`msg.sender`) first**; then if `shortfall == 0` it only advances the checkpoint and returns (**no lender screen** on that just-stamp path), and the lender recipient is screened **only in the auto-liquidate payout branch** (a flagged lender makes that branch **revert**, no deferred claim). `autoDeductDaily` (permissionless NFT-rental deduction) does **NOT** screen the caller at all — it screens **only the resolved `lenderRecipient`** on the inline transfer. `repayPartial` likewise screens the resolved lender recipient inline | `settlePeriodicInterest`: settler **and** (payout-branch) lender; `autoDeductDaily` / `repayPartial`: lender recipient only (**caller unscreened**) | `RepayPeriodicFacet` (`autoDeductDaily` L184 lender-only; `settlePeriodicInterest` L431 settler + payout-branch lender), `RepayFacet.repayPartial` | gap — see Open gaps |
| Claims (`claimAsLender`, `claimAsBorrower`, backstop opt-in) | **Tier-1 BLOCK** | the **claimant** (recipient) — unconditional, before any distribution | `ClaimFacet` | `…::test_claimAsLender_RevertsWhenSanctioned`, `…::test_claimAsBorrower_RevertsWhenSanctioned` (the **backstop opt-in** entry point shares the same gate but has **no dedicated test** — see test gaps) |
| Refinance (`refinanceLoan`) | **Tier-1 BLOCK** | the borrower **and** the current borrower-NFT holder | `RefinanceFacet` | gap — see Open gaps |
| Obligation transfer / preclose | **Tier-1 on the caller** (`_assertNotSanctioned(msg.sender)`) — but the current NFT **holder is not separately screened**: an unsanctioned keeper acting for a flagged borrower-holder can still withdraw exiting collateral to that flagged holder. Holder-screening is an enforcement **gap** | the caller (holder unscreened) | `PrecloseFacet` | gap — see Open gaps |
| Loan-sale / prepay listing & settlement | **Mixed — enforcement gap.** The atomic-match, auto-list, and executor-callback paths ARE Tier-1 gated, but the fixed-price `postPrepayListing` / `updatePrepayListing` AND the Dutch `postPrepayDutchListing` / `updatePrepayDutchListing` paths only check borrower-NFT ownership and do **NOT** call `_assertNotSanctioned`, so a flagged holder can post/update a fixed or Dutch collateral-sale listing | the caller / borrower (post + update **unscreened**) | `NFTPrepayListingAtomicFacet` + auto-list/executor (gated); `NFTPrepayListingFacet` / `NFTPrepayDutchListingFacet` post+update (**ungated gap**) | gap — see Open gaps |
| Early withdrawal | **Tier-1 on the caller** (`_assertNotSanctioned(msg.sender)`) — but, like preclose, the current NFT **holder is not separately screened**: a keeper invoking `createLoanSaleOffer` / `completeLoanSale` for a flagged lender-holder passes only the caller screen. Holder-screening is an enforcement **gap** | the caller (holder unscreened) | `EarlyWithdrawalFacet` | gap — see Open gaps |
| Keeper-driven auto-lifecycle (auto-refinance / auto-extend) | **Tier-1 BLOCK** | the keeper **and** the participating NFT holders | auto-refinance: `RefinanceFacet._refinanceLoanLogic` (screens `msg.sender` + `currentBorrowerNftOwner`); auto-extend: `AutoLifecycleFacet` | gap — see Open gaps |
| Keeper reward payout (VPFI housekeeping reward) | **Soft-skip (NOT a revert)** — when the keeper is flagged the reward is forfeited (returns 0 + emits `KeeperRewardSkipped("sanctioned-keeper")`) so the housekeeping/sweep tx still completes; liveness is preserved and no value reaches the flagged keeper | the keeper (reward recipient) | `LibKeeperReward.payVpfiReward` | gap — see Open gaps |
| Offer cancel | **No direct gate, but indirectly blocked — enforcement gap.** `cancelOffer` itself calls no `_assertNotSanctioned`, but the refund routes through `VaultFactoryFacet.vaultWithdraw*` with `creator` as the vault owner, which resolves the creator's vault via `getOrCreateUserVault(creator)` → screens the creator. So a creator **flagged after posting** an unfilled offer (or a third party clearing that creator's expired offer) **reverts before the refund** — the creator's own escrowed capital can't be wound down while flagged. Intended as wind-down of one's own capital; the recipient-vault screen diverges | the **creator** (indirectly, via the refund vault) | `OfferCancelFacet.cancelOffer` (no direct gate; indirect vault-owner screen) | gap — see Open gaps |

**Invariant (intent):** no Tier-1 path may route fresh value to a flagged wallet,
and no Tier-2 path may be turned into a fresh-value path for a flagged wallet.
The *intended* mechanism is that value owed to a flagged recipient on a wind-down
path defers to a Tier-1 claim. **Current reality (gap):** that deferral only
holds where an explicit held-proceeds escrow or the consolidation-move-out
exemption applies; on the direct-deposit close-out branches the recipient-vault
screen in `getOrCreateUserVault` instead causes the path to **revert** when the
recipient loan party is flagged. So the invariant is upheld in the safe direction
(no fresh value reaches a flagged wallet) but the liveness half (unflagged
counterparty always made whole) is **not** yet guaranteed — see Open gaps.

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

**Terms gate — read-failure / loading posture (intended fail-CLOSED; the dapp
currently fails OPEN — a confirmed divergence).** Unlike sanctions, the Terms gate
has **no per-action on-chain revert** — it is a dapp-side routing gate over the
on-chain acceptance record, so there is no protocol backstop if the gate is
bypassed in the UI. The **intended** behaviour when the gate is enabled but the
acceptance/version read is still loading or fails is **fail-CLOSED** (hold the
gated routes behind the prompt / a neutral loading state until the read resolves)
— the opposite of the sanctions banner's fail-open, because here a fail-open lets
a non-accepting wallet reach gated routes with nothing else stopping it.
**Current code diverges:** `LegalGate` renders `children` during `loading`, and
on a read error `useTosAcceptance` leaves `currentVersion` at its default `0`,
which makes `hasAccepted` evaluate `true` (the gate-disabled branch) — so a
loading or failed read currently lets the gated route render. This is a confirmed
route-gate bypass logged in `_CodeVsDocsAudit.md` (see Open gaps).

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
- **Enforcement gaps (the code does NOT gate as intended — these are real, not
  just untested).**
  (a) the fixed-price `postPrepayListing` / `updatePrepayListing` and the Dutch
  `postPrepayDutchListing` / `updatePrepayDutchListing` paths don't call
  `_assertNotSanctioned`, so a flagged borrower-NFT holder can post/update a
  collateral-sale listing. (b) The preclose / obligation-transfer **and** the
  early-withdrawal (`createLoanSaleOffer` / `completeLoanSale`) keeper paths screen
  only `msg.sender`, not the current NFT holder, so a keeper acting for a flagged
  holder can route exiting collateral / proceeds to that holder. (c)
  `triggerLiquidationDiscounted` screens the caller but not the seized-collateral
  `recipient` arg. (d) `triggerDefault`'s internal-match auto-dispatch
  (`attemptInternalMatchAutoDispatch`) pays the caller the 1% matcher bonus
  without screening that caller. (e) `addCollateral` screens only the stored
  `loan.borrower`, not the payer / current borrower-NFT holder (the `Tier2CloseOut`
  context skips the current holder). (f) **Cross-cutting recipient-vault brick:**
  the wind-down close-outs (`repayLoan` full, `triggerDefault`, HF-based
  liquidation, and the `cancelOffer` refund) deposit/refund the recipient's share
  through `getOrCreateUserVault`, which screens the vault **owner**. So a flagged
  *recipient loan party* (lender on repay/liquidation/default, surplus borrower on
  liquidation/default, or the offer creator on cancel) makes the whole close-out
  **revert** instead of the value deferring to a Tier-1 claim — the unflagged
  counterparty is not made whole until the flag clears. The principled fix is a
  held-proceeds escrow on these paths (mirroring the consolidation-move-out
  exemption) so the close-out completes and the flagged recipient's share waits
  behind a Tier-1 claim. Each gap should either be hardened or consciously
  accepted; this matrix records them so they aren't mistaken for covered.
- **Terms-gate read-failure currently fails OPEN (confirmed divergence).** The
  Terms gate has no on-chain per-action backstop (it is a dapp routing gate). The
  intended posture is fail-CLOSED, but `LegalGate` renders the gated routes while
  the read is `loading` and on a read error `useTosAcceptance` leaves
  `currentVersion = 0`, so `hasAccepted` is `true` (gate-disabled branch) and the
  route renders — a live route-gate bypass on loading / read-failure paths. Logged
  in `_CodeVsDocsAudit.md`; fix = hold closed (don't render children until the read
  resolves successfully; treat an unread/errored version as not-accepted).
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
