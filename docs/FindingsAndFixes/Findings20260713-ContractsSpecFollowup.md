# Contracts vs Functional Specs Follow-up Review — 2026-07-13

This note records a focused follow-up review of the current `contracts/` tree
against the two functional-spec references requested by the owner:

- `docs/FunctionalSpecs/ProjectDetailsREADME.md`
- `docs/FunctionalSpecs/TokenomicsTechSpec.md`

The review concentrated on the post-2026-07-12 consolidation items in the
functional specs, VPFI tokenomics, the CCIP migration, and prior high-risk
areas from the 2026-07-05 spec-vs-code review. It is not a replacement for a
fresh full audit of every Solidity branch, but it does record the discrepancies
that were still visible in the current tree.

## Method

- Read the owner-requested functional specs as the intended-behaviour oracle.
- Spot-checked the current Solidity implementation under `contracts/src/`,
  deploy/configuration scripts under `contracts/script/`, and operator-facing
  contract documentation under `contracts/README.md`.
- Re-checked previously sensitive areas: VPFI supply constants, interaction
  reward finalization/capping, refinance/forced-close interest netting,
  preclose/refinance reward-entry closure, and CCIP-vs-retired-LayerZero
  terminology.
- Ran repository searches for removed or superseded concepts such as
  `LayerZero`, `OFT`, `VPFIBuyAdapter`, fixed-rate VPFI sale, and the removed
  staking-yield surface.

## Executive summary

No new blocking Solidity logic discrepancy was identified in this focused pass.
Several previously high-risk spec-vs-code areas appear to have been corrected
in the current contracts, including mode-aware refinance settlement,
forced-close netting of periodically settled interest, per-day interaction
reward capping, and explicit reward-entry closure on refinance.

The remaining discrepancies were documentation / NatSpec drift inside the
`contracts/` tree. They matter because the functional specs now explicitly say
public or generated contract documentation must describe the current Chainlink
CCIP architecture and must avoid retired LayerZero / OApp wording. These are
low-severity operational and documentation findings, not current fund-loss
bugs.

**Status (2026-07-13): all three findings fixed** in the same change as this
note. The corrections are NatSpec / operator-doc only — no ABI, selector, or
runtime-bytecode change — so no ABI re-export or facet re-cut is required.
While fixing F3, the same #687-A buy-flow drift was found (and corrected) in
two deploy-script headers as well; see the note under F3.

## Findings

### F1 — `VPFITokenFacet` NatSpec still describes mirror VPFI as OFT / LZ peer mesh

- **Severity:** Low
- **Classification:** Stale contract NatSpec / generated-doc risk
- **Spec reference:** `TokenomicsTechSpec.md` §12 says provider-specific terms
  should stay isolated to the approved CCIP messenger adapter and that public or
  generated documentation should not describe the current system with retired
  LayerZero / OApp terminology. `ProjectDetailsREADME.md` repeats that generated
  contract documentation must use the current Chainlink CCIP architecture.
- **Code reference:** `contracts/src/facets/VPFITokenFacet.sol` still says the
  mirror token is a "pure OFT", that mirror supply arrives via the "LZ peer
  mesh", and that the canonical Diamond hosts an "OFT adapter". The logic in
  this facet is storage/config only and appears compatible with the current
  CCIP model, but the public NatSpec is stale.
- **Impact:** Generated API docs or operator notes can mislead deployers or
  integrators into looking for removed LayerZero/OFT contracts or assuming the
  wrong bridge trust model.
- **Recommended fix:** Update the facet NatSpec to say mirror VPFI is
  `VPFIMirrorToken` paired with the CCIP `BurnMintTokenPool`, canonical VPFI is
  paired with a CCIP `LockReleaseTokenPool`, and mirror supply arrives through
  the CCIP CCT token-pool lane. Remove "pure OFT", "LZ peer mesh", and "OFT
  adapter" wording from this facet.
- **Status: FIXED (2026-07-13).** `VPFITokenFacet.sol` NatSpec now describes
  the mirror token as `VPFIMirrorToken` + CCIP `BurnMintTokenPool`, the
  canonical token as `VPFIToken` + CCIP `LockReleaseTokenPool`, and mirror
  supply as arriving via the CCIP CCT token-pool lane (header, plus the
  `setCanonicalVPFIChain`, `getVPFICap`, and `getVPFIMinter` doc blocks). All
  "pure OFT" / "LZ peer mesh" / "OFT adapter" wording is gone.

### F2 — `IVPFIToken` interface NatSpec still says mirror supply flows through an OFT peer mesh

- **Severity:** Low
- **Classification:** Stale contract NatSpec / generated-doc risk
- **Spec reference:** Same CCIP-only public-documentation requirement as F1.
- **Code reference:** `contracts/src/interfaces/IVPFIToken.sol` still describes
  mirror-chain supply as flowing through the "OFT peer mesh". The interface
  constants and methods themselves match the tokenomics headline values, but the
  bridging wording is obsolete.
- **Impact:** Any generated developer docs for the token interface contradict
  the current Chainlink CCIP CCT design and the tokenomics spec.
- **Recommended fix:** Replace the OFT peer-mesh note with the current CCIP CCT
  topology: canonical `VPFIToken` plus `LockReleaseTokenPool`, mirror
  `VPFIMirrorToken` plus `BurnMintTokenPool`, with global cap enforced by
  canonical lock/release backing.
- **Status: FIXED (2026-07-13).** `IVPFIToken.sol`'s cross-chain-semantics
  note now states the canonical token is paired with a `LockReleaseTokenPool`
  and the mirror `VPFIMirrorToken` with a `BurnMintTokenPool`, with mirror
  supply flowing via the CCIP CCT token-pool lane and the global cap enforced
  by the canonical lock/release backing. The "OFT peer mesh" wording is gone.

### F3 — `contracts/README.md` still documents removed fixed-rate VPFI buy contracts and stale guardian wiring

- **Severity:** Low
- **Classification:** Stale contracts operator documentation
- **Spec reference:** `TokenomicsTechSpec.md` supersede banner removes the
  fixed-rate VPFI sale / Early Fixed-Rate Purchase Program from scope, while
  keeping fee-discount tiers and interaction rewards. `ProjectDetailsREADME.md`
  requires generated/public contract documentation to describe the current CCIP
  architecture accurately.
- **Code reference:** The README still lists `VpfiBuyAdapter.sol`,
  `VpfiBuyReceiver.sol`, and `IVpfiBuyCcipMessages.sol` in the cross-chain
  layout; still states buy contracts extend `GuardianPausable`; and still says
  `ConfigureCcip` does not set a guardian on `VPFIMirrorToken`. The current
  `ConfigureCcip.s.sol` comments and implementation say #687-A removed the buy
  adapter/receiver from this script and that `_setGuardians` wires
  `VPFIMirrorToken` on mirror chains.
- **Impact:** A deployer following the README may expect files or runtime
  contracts that no longer exist in `contracts/src/crosschain/`, or may perform
  unnecessary/manual guardian steps that the current script already handles.
- **Recommended fix:** Refresh `contracts/README.md` to remove the deleted
  fixed-rate buy contracts and message interface, describe only the retained
  fee-discount configuration where applicable, and align the `CCIP_GUARDIAN`
  row with the current `ConfigureCcip._setGuardians` behavior.
- **Status: FIXED (2026-07-13).** `contracts/README.md` was refreshed:
  - The `crosschain/` directory tree and the "pause levers" list drop
    `VpfiBuyAdapter` / `VpfiBuyReceiver` / `IVpfiBuyCcipMessages` and add the
    retained `RewardRemittanceReceiver` (mirror) and `BuybackRemittanceReceiver`
    (Base).
  - The `DeployCrosschain` env table + example drop the removed
    `TREASURY_ADDRESS` / `VPFI_BUY_PAYMENT_TOKEN` / `VPFI_BUY_REFUND_TIMEOUT`
    vars (confirmed no longer read by the script), and the deploy-step prose
    now names the remittance receivers instead of the buy adapter/receiver.
  - The `CCIP_GUARDIAN` row now reflects `_setGuardians`' real coverage
    (`CcipMessenger` + `VaipakamRewardMessenger` everywhere, plus
    `VPFIMirrorToken` + `RewardRemittanceReceiver` on mirrors and
    `BuybackRemittanceReceiver` on Base) and that it is **required** (#857).
  - Channel references switch from the removed `vpfi-buy` to the actual
    `vpfi-reward` / `vpfi-buyback` / `vpfi-reward-budget` channels; the
    Anvil-rehearsal and failure-model paragraphs and the script-reference rows
    for `DeployCrosschain` / `ConfigureVPFIBuy` are aligned to the current
    (fee-discount-only) reality.
- **Extended fix — deploy-script headers:** the same #687-A drift was still in
  two script NatSpec headers and was corrected in this change:
  `DeployCrosschain.s.sol` (dropped the buy-adapter env vars, added the
  remittance receivers to the deploy list) and `ConfigureCcip.s.sol` (switched
  the `vpfi-buy` channel references to the reward/buyback/reward-budget
  channels and moved `CCIP_GUARDIAN` from Optional to Required per #857).

## Verified spot-checks with no new discrepancy found

The following checks were performed because they were historically sensitive or
explicitly called out by the specs:

- **VPFI token constants:** `VPFIToken.TOTAL_SUPPLY_CAP` remains
  `230_000_000 ether` and `INITIAL_MINT` remains `23_000_000 ether`, matching
  `TokenomicsTechSpec.md` §2.
- **Removed staking-yield program:** the deploy code comments and selector
  lists show `StakingRewardsFacet` / `setStakingApr` were removed with the
  5% staking-yield excision. The remaining `stake` terminology is used for
  vault-held VPFI discount-tier accounting, not for a yield program.
- **Removed fixed-rate VPFI sale:** deploy and configuration scripts describe
  #687-A removal of the issuer sale; remaining `ConfigureVPFIBuy` wording is
  framed as fee-discount price configuration rather than an issuer sale.
- **Interaction rewards:** the current library has capped cumulative
  reward-per-numeraire tracks (`cumMin*Rpn18`) and finalization-time
  `dayCapThreshold18`, matching the spec's per-day cap snapshot direction.
- **Refinance/forced close interest netting:** `RefinanceFacet`, `RiskFacet`,
  `DefaultedFacet`, and `LibFallback` now contain explicit comments and paths
  that net `interestSettled` or route through `settlementInterestNet`, matching
  the 2026-07-12 consolidation rule that forced-close paths should not charge
  the same interest twice.
- **Reward closure on refinance:** `RefinanceFacet` now calls
  `LibInteractionRewards.closeLoan` for the old loan, addressing the prior
  class where retired principal could continue accruing interaction rewards.

## Decision log

No product or economic decision was needed for this PR. The findings above are
trivial documentation/NatSpec corrections: the intended direction is already
settled by the functional specs and current CCIP implementation.
