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
  must stay available so an **unflagged counterparty can be made whole** even
  when the other party is flagged. A flagged borrower can still be repaid /
  defaulted / liquidated against; any protocol value owed to a flagged
  *recipient* is **deferred to a Tier-1 claim** rather than paid inline, so the
  recovery path never routes fresh value to a flagged wallet.
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
| Permissionless matcher fills | **Tier-1 BLOCK** | the matcher (LIF/incentive recipient) | `RiskMatchLiquidationFacet` | gap — see Test gaps |
| VPFI deposit / withdraw | **Tier-1 BLOCK** | the caller (value in/out) | `VPFIDiscountFacet` | `VPFIDiscountFacetTest.t.sol::test_depositVPFIToVault_RevertsWhenSanctioned`, `…::test_withdrawVPFIFromVault_RevertsWhenSanctioned` |
| HF-based liquidation (`triggerLiquidation`, partial, discounted, split) | **Tier-1 BLOCK** | the liquidator (3% bonus recipient) | `RiskFacet`, `RiskSplitLiquidationFacet` | `…::test_triggerLiquidation_RevertsWhenSanctionedLiquidator`, `…::testPartialLiq_SanctionedCallerReverts` |
| Time-based default (`markDefaulted` / `triggerDefault`) | **Tier-2 ALLOW** | not caller-gated — value flows to the lender, not the caller; protects the unflagged lender | `DefaultedFacet` (no gate) | covered indirectly via the wind-down repay test + design intent |
| Repayment (`repayLoan`, periodic) | **Tier-2 ALLOW** for a flagged **borrower** (repay stays open); the **lender recipient** is Tier-1 screened — a flagged current lender-holder cannot receive inline, proceeds defer to a gated claim | `RepayFacet`, `RepayPeriodicFacet` (gate on `lenderRecipient`) | `…::test_SanctionedBorrower_CanStillRepay_LenderRecovers` |
| Claims (`claimAsLender`, `claimAsBorrower`, backstop opt-in) | **Tier-1 BLOCK** | the **claimant** (recipient) — unconditional, before any distribution | `ClaimFacet` | `…::test_claimAsLender_RevertsWhenSanctioned`, `…::test_claimAsBorrower_RevertsWhenSanctioned` |
| Refinance (`refinanceLoan`) | **Tier-1 BLOCK** | the borrower **and** the current borrower-NFT holder | `RefinanceFacet` | gap — see Test gaps |
| Obligation transfer / preclose | **Tier-1 BLOCK** | the initiating borrower | `PrecloseFacet` | gap — see Test gaps |
| Loan-sale / prepay listing & settlement | **Tier-1 BLOCK** | the caller / borrower wallet | `NFTPrepayListingAtomicFacet`, `PrepayListingFacet`, `NFTPrepayAutoListFacet` | gap — see Test gaps |
| Early withdrawal | **Tier-1 BLOCK** | the lender (early-withdrawal recipient) | `EarlyWithdrawalFacet` | gap — see Test gaps |
| Keeper-driven auto-lifecycle (auto-refinance / auto-extend) | **Tier-1 BLOCK** | the keeper **and** the participating NFT holders | `AutoLifecycleFacet`, `LenderIntentFacet` | gap — see Test gaps |
| Keeper reward payout (VPFI housekeeping reward) | **Soft-skip (NOT a revert)** — when the keeper is flagged the reward is forfeited (returns 0 + emits `KeeperRewardSkipped("sanctioned-keeper")`) so the housekeeping/sweep tx still completes; liveness is preserved and no value reaches the flagged keeper | the keeper (reward recipient) | `LibKeeperReward.payVpfiReward` | gap — see Test gaps |
| Offer cancel | **Not sanctions-gated** — the creator may cancel their own offer unconditionally (anyone after expiry), returning the creator's OWN escrowed funds; this is a wind-down/recovery of one's own capital, so there is no sanctions revert today | n/a | `OfferCancelFacet.cancelOffer` (no gate) | n/a |

**Invariant:** no Tier-1 path may route fresh value to a flagged wallet, and no
Tier-2 path may be turned into a fresh-value path for a flagged wallet (value
owed to a flagged recipient on a wind-down path always defers to a Tier-1 claim).

## Action matrix — Terms-of-Service gate

The Terms gate is a **versioned on-chain acceptance** (`LegalFacet`): a user must
have accepted the **current** Terms version **and** content hash before the gated
app routes. Governance bumps the version/hash via `setCurrentTos`; a bump or hash
change invalidates every prior acceptance.

| State | `hasAcceptedCurrentTerms` | UI behaviour | Tested by |
| --- | --- | --- | --- |
| Disabled (`currentTosVersion == 0`) — testnet / pre-launch | `true` for everyone | no prompt; `/app/*` routes open | `LegalFacet.t.sol::test_Initial_GateDisabled_EveryoneTreatedAsAccepted` |
| Enabled, user accepted current (version + hash match) | `true` | routes open | `…::test_acceptTerms_Success_EmitsEvent` |
| Enabled, user never accepted | `false` | prompt to accept before gated routes | `…::test_acceptTerms_RevertOnVersionMismatch` / `…RevertOnHashMismatch` |
| Stale — Terms re-published (version bumped, with a new hash) since acceptance | `false` | prompt to re-accept | `…::test_VersionBump_InvalidatesPriorAcceptance`, `…::test_SameVersion_HashDrift_InvalidatesAcceptance` |

`setCurrentTos` enforces a **strictly increasing** version (it reverts otherwise),
so a new Terms hash is always published alongside a version bump — there is no
reachable "same version, new hash" public-governance state (the
`test_SameVersion_HashDrift…` case exercises a v1→v2 bump with a new hash; a
literal same-version hash change is only reachable by direct storage corruption,
not by governance). `acceptTerms(version, hash)` reverts `InvalidTosVersion`
unless the submitted pair matches the live `(currentTosVersion, currentTosHash)`,
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
  (list + accept), Create Offer, Loan Details, Claim Center, and the VPFI
  Vault**. The standalone **Offer Detail** (`/offers/:offerId`) and
  **vault-recovery** (`/recover`) surfaces do **not** yet mount the banner —
  adding them is a tracked gap (see Test coverage & gaps), not a claim of current
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

## Test coverage & gaps

**Covered today:**

- Sanctions: fail-open (oracle unset + read-revert), Tier-1 block on vault
  creation / offer create / offer accept (acceptor + post-posting creator) /
  liquidation (full + partial) / claims (lender + borrower), and the Tier-2
  wind-down (sanctioned borrower repays → unflagged lender recovers) —
  `contracts/test/SanctionsOracle.t.sol` (mock: `test/mocks/MockSanctionsList.sol`).
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

- The Tier-1 matrix rows still marked "gap" in the Tested-by column (matcher
  fill, refinance, obligation transfer, loan-sale, early withdrawal,
  auto-lifecycle) share the identical centralised `_assertNotSanctioned` Tier-1
  pattern already proven across the representative families above (vault / offer
  / liquidation / claims / VPFI). The gate helper is uniformly applied, so the
  result is the same; a per-row scenario test is low-priority.
- **UI submit-disable on the flagged signal.** Pages warn via `SanctionsBanner`
  but do not yet disable their submit buttons on `useSanctionsCheck().isSanctioned`;
  wiring that (so the app never offers a clickable Tier-1 action to a flagged
  wallet) is a recommended hardening.
- **Banner not mounted on Offer Detail (`/offers/:offerId`) and vault-recovery
  (`/recover`).** Adding `SanctionsBanner` there closes the two surfaces this
  matrix flags as not-yet-covered.
- The keeper-reward **soft-skip** and the **offer-cancel ungated** rows are
  documentation of current behaviour (not value-to-a-flagged-wallet paths), so
  they need no Tier-1 revert test.
