# Vaipakam Engineering Roadmap (Internal)

> **Internal-only.** Not linked from the website, the whitepaper, the
> overview, or the user guide. Tracks phase tagging and forward
> planning for engineering use. Public surfaces describe Vaipakam as
> the end-state product without phase markers.

---

## Why this file exists

The public whitepaper, overview, and user guide describe Vaipakam as
the production protocol — no "Phase 1", no "Phase 2 planned", no "KYC
coming later". This is intentional: phase scaffolding on the public
docs is an onboarding tax (KYC is only for Enterprice users and that is a differernt product all together), and a public
roadmap is a public commitment that boxes in flexibility.

Engineering still needs the phase correlation — when did `LibSwap`
ship, why does the storage struct have `kycEnforcementEnabled`, what's
the difference between Phase 5 borrower LIF and the original LIF.
That's what this file is for.

---

## Phase tag → feature map (shipped)

The phase tags survive in source-code comments, commit messages, and
test-file names. Use this table to correlate a tag with the feature it
shipped.

| Phase | Date          | Feature                                                                            | Key files                                                                                                                                          |
| ----- | ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 2025–2026 Q1  | Core P2P lending, escrow, oracle, liquidation, rewards, VPFI                       | All baseline facets                                                                                                                                |
| 5     | 2026-04-23/24 | Time-weighted borrower LIF rebate (`vpfiHeld` custody, settle/forfeit on terminal) | `LibVPFIDiscount`, `LoanFacet._snapshotBorrowerDiscount`, `ClaimFacet.claimAsBorrower`                                                             |
| 6     | 2026-04-24    | Keeper per-action authorization (bitmask + per-loan/per-offer enables)             | `LibAuth.requireKeeperFor`, `ProfileFacet.setKeeperAccess` / `setLoanKeeperEnabled` / `setKeeperActions`, frontend `LoanDetails` keeper picker     |
| 7a    | 2026-04-25    | 4-DEX swap failover + adapter registry                                             | `LibSwap`, 4 adapter contracts, `AdminFacet` registration, frontend `swapQuoteService`, Cloudflare `/quote/*` worker, HF watcher autonomous keeper |
| 7b.1  | 2026-04-25    | 3-V3-clone OR-logic liquidity classification + frontend 0x preflight               | `OracleFacet` factory.getPool() discovery, frontend liquidity guard                                                                                |
| 7b.2  | 2026-04-25    | Tellor + API3 + DIA secondary price-oracle quorum (Soft 2-of-N)                    | `OracleFacet` quorum, `SecondaryQuorumTest`, Pyth removed                                                                                          |
| 8a    | 2026-04-25    | UX polish — ENS resolution, liquidation calc, HF alerts, revoke UI                 | Frontend `useEnsName`, `LiquidationCalculator`, `HFAlertsPanel`, `RevokeUI`                                                                        |
| 8b    | 2026-04-25    | Permit2 + Blockaid simulation + real-Permit2 fork tests                            | `LibPermit2`, `useTxSimulation`, `SimulationPreview`                                                                                               |
| 9     | 2026-04-25    | PWA, Farcaster Frame, standalone keeper-bot reference repo                         | `frontend/public/manifest.json` + `sw.js`, hf-watcher Frame routes, `vaipakam-keeper-bot` sibling repo                                             |
| i18n  | 2026-04-26/27 | 10-locale i18n with SEO routes, Intl.\* formatting, RTL polish for Arabic          | `LocaleResolver`, `withLocalePrefix`, per-locale shells, generate-sitemap, Cloudflare `_redirects`                                                 |

---

## Pending operational items before mainnet cutover

(Not architectural — pre-flight checklist.)

- Final DVN operator address selection (3 required + 2 optional) per the
  cross-chain security policy.
- Mainnet runbook execution: `ConfigureLZConfig.s.sol` against every
  (OApp, eid) pair, governance handover (`TransferAdminToTimelock`),
  swap-adapter registration via `AdminFacet`.
- Third-party security audit completion (Diamond core, swap failover,
  secondary oracle quorum, cross-chain reward mesh, borrower LIF
  custody, LayerZero OApp surface).
- Bug bounty program publication.
- `LZConfig.t.sol` + `GovernanceHandover.t.sol` +
  `LiquidationMinOutputInvariant.t.sol` +
  `SecondaryQuorumTest.t.sol` + `FeedOverride.t.sol` +
  `Permit2RealForkTest.t.sol` green on the target network's fork.

---

## Industrial-user fork (separate deploy)

The retail Vaipakam deploy is permissionless: KYC, sanctions screening,
and country-pair trade restrictions are runtime-disabled by default
and stay off (see `CLAUDE.md` "Retail-deploy policy"). The
**industrial-user variant** is a separate fork / separate deploy that
re-uses the same contracts with these gates flipped on for compliance-
driven customers (institutions, fintech B2B integrations).

The industrial fork's scope (in addition to retail features):

- `AdminFacet.setKYCEnforcement(true)` flipped on at deploy time. Per-
  user KYC tier provisioning via `ProfileFacet.updateKYCTier`. Tiered
  thresholds calibrated to the customer's compliance regime via
  `ProfileFacet.updateKYCThresholds`.
- `ProfileFacet.setSanctionsOracle(<oracle>)` configured per chain
  (Chainalysis or equivalent). Offer creation + acceptance check
  caller / counterparty on the configured oracle.
- `LibVaipakam.canTradeBetween` replaced with the gated implementation
  that consults the `allowedTrades[bytes32][bytes32]` storage. Pairs
  populated via `ProfileFacet.setTradeAllowance` per the customer's
  jurisdictional matrix.
- Three-tier KYC framework already retained in storage:
  - Tier 0 — transactions `< $1,000` USD-equivalent; no KYC
  - Tier 1 — `$1,000–$9,999`; basic identity verification
  - Tier 2 — `≥ $10,000`; comprehensive identity verification + AML
  - Valuation via Chainlink at offer-acceptance time.
- Optional: decentralized identity integration (Civic / Verite /
  ComplyCube) instead of admin-set tier.

The fork is a separate repo / separate deploy. Don't backport its
config to the retail deploy. Don't mention KYC, sanctions, or country
gating on the retail website / whitepaper / overview / user guide.

---

## Forward planning (engineering-only)

Items under consideration; not commitments. Nothing here should
appear on a public surface.

### Governance activation

Move from multisig + timelock to on-chain Governor (`OpenZeppelin
Governor` or equivalent): proposals, voting, quorum, majority
threshold. Deferred until token distribution is wide enough that on-
chain votes have meaningful turnout.

### Auto-defender keeper

A protocol-operated keeper that's whitelisted-by-default for users
who opt in, executing HF-rescue actions (add collateral from a pre-
funded reserve, partial preclose) on positions about to liquidate.
Sits on top of the Phase 6 keeper authorization surface — uses the
existing per-action bitmask, just adds a default opt-in flow.

### Polygon PoS reactivation

Currently out of Phase 1 cross-chain scope (weaker bridge trust). Re-
evaluate when AggLayer matures and PoS-side LayerZero security
posture is closer to the rollup-rooted L2s.

### Partial lending / partial borrowing

Multiple loans per offer (one offer fills against multiple
counterparties), dynamic re-pricing for very-short-tenor loans.
Affects `OfferFacet.acceptOffer` semantics — not a small change,
needs careful invariant work around `loanToOffsetOfferId` / claim
exclusivity.

### Reward UX expansion

Staking reward batch claim. Broader claimable-reward UI surface
(currently the rewards aggregation lives in `VaipakamRewardOApp` and
the per-user claim flow is minimal).

### Non-rollup chain expansion

BSC, Avalanche, Solana — once the LayerZero DVN policy on those
chains is verified to match the retail deploy's hardening profile.
Solana specifically is out of scope for all phases until further
notice.

### Insurance / surplus rule maturity

Current 2% surplus rule. Long-term: a real insurance pool sized
against historical loss data, with explicit claim-paying authority
and a funded reserve.

---

## How to update this file

- When a new phase ships, add a row to the phase-tag table with the
  date, feature, and key files. Don't add a phase marker to the
  whitepaper or user-facing copy — keep the public docs version-
  neutral.
- When a forward-planning item ships, move it from "Forward planning"
  into the phase-tag table with the new phase number / date.
- When a forward-planning item is decided to be dropped, delete it
  outright. Don't leave "previously considered" cruft.
- When the industrial fork ships, this file's "Industrial-user fork"
  section moves to the fork's repo. The retail repo's copy of this
  file shrinks to just "see the industrial-fork repo for compliance
  scope."
