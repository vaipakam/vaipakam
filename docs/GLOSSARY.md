# Vaipakam Glossary

Domain terms used across `contracts/`, `apps/`, `packages/`, and `docs/`.
Reduces audit-question overhead: when a reviewer encounters a term in
the code or docs, this file is the canonical short-form definition.

For deeper treatment of any term, follow the cross-reference into
`docs/FunctionalSpecs/`, `docs/DesignsAndPlans/`, or
`CLAUDE.md` — the entries here are deliberately one or two paragraphs.

Terms are listed in alphabetical order. When you add a new
project-specific term to the code or docs, add it here in the same PR.

---

## A

**ABI sync** — the process of regenerating per-facet ABI JSONs (via
`forge inspect <Facet> abi --json`) and copying them into the
consumers (`packages/contracts/src/abis/` for every monorepo
consumer; `vaipakam-keeper-bot/src/abis/` for the public reference
bot). Done after any selector-changing contract edit. See
`CLAUDE.md` § "Keeper-bot ABI sync" and § "Frontend ABI sync".

**Accumulator (time-weighted)** — a per-user running sum of
`(BPS × seconds elapsed since last touch)`. Re-stamped on every
balance mutation at the **post-mutation** balance. Used to compute
the average VPFI tier a user held over a loan's lifetime — see
`LibVPFIDiscount.rollupUserDiscount` and ADR-0003.

**Advisory (Codex finding)** — a `P3` finding. Not a merge-blocker;
maintainer applies fix or rationale + closes the thread.

**Adversarial review** — a Codex review mode (`@codex review
adversarial`) focused on failure modes, abuse cases, replay, race
conditions, and stuck-state scenarios. Distinct from `normal` (which
checks correctness + integration). See `AGENTS.md`.

**Allowed-trade gate (industrial fork)** — pair-based trade-allowance
mapping flipped on by `LibVaipakam._canTradeBetweenStorageGated`.
**Off** on the retail deploy (the retail `canTradeBetween` pure-trues).
See `CLAUDE.md` § "Retail-deploy policy".

**Anvil rehearsal** — an end-to-end execution of the deploy + config
scripts against a local `anvil` chain (or, for CCIP, two simulated
chains via `chainlink-local`'s `CCIPLocalSimulator`). Proves the
scripts; not a contract regression test.

## B

**BPS (basis points)** — 1/10,000. Used for interest rates, fees,
LTV, treasury cuts. Example: `TREASURY_FEE_BPS = 100` = 1% cut on
interest. See `LibVaipakam.sol`.

**BSL-1.1** — Business Source License 1.1. The repo's license — a
DeFi-standard time-delayed-permissive license that converts to
permissive (typically MIT) after a delay. See ADR-0009.

**Buy adapter / receiver (VPFI)** — cross-chain VPFI purchase flow.
`VpfiBuyAdapter` (on mirror chains) pulls user funds, sends a
BUY_REQUEST via CCIP to `VpfiBuyReceiver` (on Base), which mints +
ships VPFI back. Two-step release with refund on failure.

## C

**Cancel cooldown** — a delay enforced by `OfferCancelFacet` between
an offer being created and the same maker being able to cancel +
re-post a same-collateral-same-debt offer. MEV defense.

**Canonical chain (VPFI)** — the chain where VPFI is the native ERC-20.
Currently Base (mainnet) / Base Sepolia (testnet). Mirror chains
hold a `VPFIMirrorToken` proxy backed by a CCIP `BurnMintTokenPool`.

**CCIP (Chainlink Cross-Chain Interoperability Protocol)** —
post-T-068 cross-chain message + token transport layer. Operated by
Chainlink (committing DON + executing DON + independent Risk
Management Network). Uniform security for every integrator — no
DVN fleet to configure. See ADR-0004.

**CCT (Cross-Chain Token)** — the CCIP-native pattern for moving
ERC-20s across chains via per-chain TokenPools registered in
`TokenAdminRegistry`. Vaipakam's VPFI is a CCT (LockReleasePool on
canonical, BurnMintPool on mirrors).

**Claim (borrower / lender)** — terminal step on a loan after
settlement / default. `ClaimFacet.claimAsBorrower` returns
collateral + LIF rebate to the borrower; `claimAsLender` settles
proceeds + interest to the lender.

**CODEOWNERS** — `.github/CODEOWNERS`. Path-based review routing
defined by GitHub. Documents ownership for auditors.

**Codex** — the GitHub Codex app that auto-reviews PRs on this repo.
Commands defined in [`AGENTS.md`](../AGENTS.md). See ADR section
on review profiles.

**Codex Cloud (NOT used)** — the *interactive* Codex agent (separate
from the auto-review GitHub app). Requires a Codex Cloud environment
configured per repo. Vaipakam doesn't use this path — `@codex` on a
PR triggers the auto-reviewer, not the interactive agent.

**Contributor Covenant** — the canonical Code of Conduct text used
by `CODE_OF_CONDUCT.md`. v2.1 is the version pinned in this repo.

**Cross-layer linker** — `graphify-out/cross_layer_link.py` (local-
only, gitignored). Name-matches Solidity contracts to ABI JSONs /
doc mentions / frontend imports via `mirrors_contract` INFERRED
edges. Recreate from session state.

## D

**Deploy-sanity suite** — the small set of static guardrails under
`contracts/test/deploy/` that catch deploy-breaking mistakes at
`forge test` time (EIP-170 size, selector coverage, deploy-
integration loupe assertions). See `CLAUDE.md` § "Deploy-sanity
suite".

**Detect-changes** — the first CI job (path-filter) that diffs PR
head vs base and exports two booleans (`contracts`, `workspaces`)
downstream jobs `if:`-guard on. Docs-only PRs merge in <1 min.

**Diamond** — `VaipakamDiamond.sol`, the EIP-2535 multi-facet proxy
that is the protocol's single entry point. All calls land in its
`fallback()`, which routes by selector to the appropriate facet.
See ADR-0001.

**Diamond cut** — the operation that adds, replaces, or removes a
facet's selectors on the Diamond. Run from `DeployDiamond.s.sol`
at deploy time; ongoing cuts are admin-gated and timelock-routed.

**DEX failover (Phase 7a)** — liquidation swap path tries 0x → 1inch
→ Balancer → curl-direct sequentially, accepting the first
adequately-priced quote. Reduces single-DEX dependency.

## E

**EIP-170** — the 24,576-byte runtime-bytecode limit per Ethereum
contract. `FacetSizeLimitTest` (Issue #66) enforces it at
`forge test` time so a facet split is forced before deploy fails.

**EIP-2535 (Diamond Standard)** — the multi-facet proxy standard.
See ADR-0001.

**Vault (per-user)** — a `ERC1967Proxy` over `VaipakamVault
Implementation`, deployed lazily by `VaultFactoryFacet` the first
time a user interacts with the protocol. Each user's collateral
lives in their own isolated vault — no commingling. See ADR-0008.

## F

**Fail-closed** — the asset-classification stance when an oracle
returns a stale price or a depth probe finds insufficient liquidity:
the asset is treated as illiquid (LTV 0, no HF check, no swap
liquidation path), not as a price-of-zero. See
[`apps/www/src/content/whitepaper/Whitepaper.en.md`](../apps/www/src/content/whitepaper/Whitepaper.en.md)
§4.4.

**Fast-build** — the `contracts-fast` CI job; runs `forge build` +
deploy-sanity suite. Required check. 1-2 min warm, 8-12 min cold.

**Forfeit (LIF)** — at default or HF-liquidation: borrower's
custody-held VPFI LIF is forwarded to treasury in full, no rebate.
See `LibVPFIDiscount.forfeitBorrowerLif`.

**Functional Spec** — `docs/FunctionalSpecs/<domain>.md`. The
**code-independent** specification of intended platform behaviour
— the test oracle. Sourced from documents, never from code. See
ADR-0007.

## G

**Glossary** — this file.

**graphify** — the knowledge-graph tool. Outputs to
`graphify-out/` (gitignored). `graphify query "..."` traverses
the graph; preferred over grep for cross-module reasoning. See
`CLAUDE.md` § "graphify" and the agent-memory note.

**Guardian** — a non-owner role with `pause()` authority on
`GuardianPausable`. Can stop a contract; cannot unpause (owner-only)
or upgrade. Every cross-chain contract carries this lever.

## H

**Handbook** — `docs/internal/ProjectProcedures.md`. The operator
handbook covering repository topology, git procedures, PR workflow,
post-merge sweep, etc.

**Handbook profile (Codex)** — `@codex review handbook`. A
project-specific Codex review profile defined in
[`AGENTS.md`](../AGENTS.md) for operator-handbook-class PRs.
Equivalent to `review normal` with handbook-specific focus areas.

**HF (Health Factor)** — `RiskFacet.calculateHealthFactor`. Ratio of
collateral value (× LTV) to debt value, scaled 1e18. HF >= 1.5e18
at loan initiation (`MIN_HEALTH_FACTOR`); HF < 1e18 permits
permissionless liquidation.

## I

**Illiquid asset** — an asset without a Chainlink feed OR without
sufficient v3-pool depth (`PAA × {Uni/Pancake/Sushi V3}` route at
≤2% slippage; thresholds from `ProtocolConfig`). Valued at $0,
default settlement = full collateral transfer.

**Initiation gate** — `LoanFacet._checkInitialLtvAndHf`. Enforces
HF >= 1.5 + LTV-cap-by-tier at the moment of loan init. The cap
tier depends on the kill-switch state — see ADR-0005.

**Iteration / Sprint (project board)** — two iteration-type fields
on the `@vaipakam-labs` project. Iteration = 7-day Monday-aligned;
Sprint = 14-day. Functional discipline; the user reviews work when
status is "In review". See `ProjectProcedures.md` §5.

## K

**Keeper (apps/keeper)** — the production-grade keeper Cloudflare
Worker. Liquidator + (planned) matcher. Reads ABIs from
`@vaipakam/contracts/abis`. Distinct from the public reference bot
in the sibling `vaipakam-keeper-bot` repo.

**KYC (off on retail)** — `s.kycEnforcementEnabled = false` on the
retail deploy. The industrial fork can flip it on without a storage
migration. See `CLAUDE.md` § "Retail-deploy policy" and ADR-0002.

## L

**LayerZero (legacy)** — the pre-T-068 cross-chain transport. Fully
removed in April 2026; CCIP replaced it. See ADR-0004.

**Lender-gated partial repay** — `Offer.allowsPartialRepay`. A creator-
set opt-in; acceptor consents by accepting. Landed 2026-04-29.

**LIF (Loan Initiation Fee)** — the 0.1% fee borrowers pay on the
VPFI path. Held in Diamond custody until terminal; split into a
time-weighted-tier-based rebate (proper close) or forfeited to
treasury (default / liquidation). See `CLAUDE.md` § "VPFI Fee
Discounts" and ADR-0003.

**Liquid asset** — meets the on-chain liquidity threshold (depth +
oracle). Eligible for LTV/HF-based loans and DEX-swap liquidation.

**Liquidation paths (two)** — (1) HF-based, permissionless, swap via
DEX failover when HF < 1e18; (2) time-based, after grace period
expires (`DefaultedFacet`), with liquid assets swapped and illiquid
transferred whole to the lender.

**LockReleaseTokenPool** — the canonical-chain (Base) CCIP TokenPool
for VPFI. Locks VPFI on outbound CCIP message, releases on inbound.

**LTV (Loan-to-Value)** — debt / collateral × 10000, in BPS.
Maximum LTV at init is the lower of the asset's `maxLtvBps` AND
(if depth-tiered LTV is on) the tier's cap (e.g. 50% Tier-1, 60%
Tier-2, 65% Tier-3). See ADR-0005.

## M

**Mainnet-gate** — `.github/workflows/mainnet-gate.yml`. Hard CI
gate that runs `predeploy-check.sh --full` on every push to
`release/**`, PR to `release/**`, `v*` tag push, and
`workflow_dispatch`. Full forge regression must pass before any
release-track ref ships.

**Matcher (Range Orders Phase 1)** — `OfferMatchFacet.matchOffers`.
Bot-callable function that pair-matches a lending offer against
a borrowing offer in their overlap range. Pays a 1% LIF kickback
to the matcher.

**Mirror chain** — a non-canonical chain hosting VPFI as a
`VPFIMirrorToken` proxy. Inbound CCIP messages mint, outbound burn,
via the `BurnMintTokenPool`.

## N

**Non-canonical (mirror) VPFI** — see Mirror chain.

**Notifications poller** — `~/.claude/scripts/pr-poll.sh --watch-all`.
Watches the GitHub `/notifications` endpoint for any repo activity.
The default per-PR mode (no `--watch-all`) polls a single PR.

## O

**Offer (lending / borrowing)** — the canonical proto-loan. Either
side can post; the other accepts (or, with range overlap, the
matcher pairs them). Cancellable subject to cancel cooldown.

**Offer-mutation event category** — `state-change/offer-mutation`
NatSpec tag on contract events. The indexer's `check-event-
coverage.mjs` script fails CI if a tagged event has no handler or
allowlist entry.

## P

**PAA (Predominantly Available Denominator)** — the per-chain set
of quote tokens the depth probe considers when classifying
collateral liquidity. Default = `[wethContract]`. Configurable per
chain via `Storage.paaAssets[]`. Origin: T-048.

**Partial-fill (borrower-side, planned #102)** — the symmetric
inverse of the lender-side partial path. Lets a borrowing offer
be filled by less than the full ask, leaving a residual open.

**Partial repay (lender-gated)** — see Lender-gated partial repay.

**Path-filter (CI)** — see Detect-changes.

**Permit2** — Uniswap's signature-based ERC-20 approval router.
The acceptOffer / createOffer / VPFI-deposit paths try Permit2
first, fall back to plain `approve` on failure. Landed Phase 8b.

**Phase X** — pre-Stage-3 phase numbers (Phase 5 = LIF discount,
Phase 6 = keeper per-action auth, Phase 7a = DEX failover, etc.).
Replaced by Issue + Project-card discipline going forward; phase
references survive in `docs/ReleaseNotes/`.

**PR poll script** — `~/.claude/scripts/pr-poll.sh`. The canonical
PR-status poller (reviews + reactions + inline suggestions + check-
runs + workflow-runs via one GraphQL snapshot).

**Predeploy check** — `contracts/script/predeploy-check.sh`. Cohesive
deploy gate that runs `forge build`, the deploy-sanity suite (or
`--full` regression), shell-lints the deploy scripts, and verifies
every committed per-facet ABI matches `forge inspect`.

## R

**Range order (Phase 1)** — an offer that specifies a range (min /
max amount, possibly with step). Mediated by `OfferMatchFacet` +
`LibOfferMatch` + `LibRiskMath`.

**Refinance** — `RefinanceFacet`. Mid-loan replacement of the lender,
preserving the borrower's position. HF-re-checked.

**Release-drafter (planned #99)** — workflow that auto-drafts a
GitHub Release from merged PRs, grouped by label.

**Release notes** — per-PR fragments under
`docs/ReleaseNotes/unreleased/`, folded into the dated file via
`bash docs/ReleaseNotes/assemble.sh`. Plain English, no code. See
`CLAUDE.md` § "Release notes".

**Repay / Preclose** — terminal "good" paths. `RepayFacet` handles
on-time + partial; `PrecloseFacet` handles direct + offset early
close.

**Risk Management Network (CCIP)** — Chainlink's independent
second-codebase / second-operator-set network that re-verifies
every committed CCIP message before execution. The structural
reason CCIP avoids the LayerZero-style "1-required / 0-optional
DVN" footgun.

## S

**Same-asset guard** — `LibVaipakam`'s rule that an offer cannot use
the same asset as both collateral and debt. See
[`apps/www/src/content/whitepaper/Whitepaper.en.md`](../apps/www/src/content/whitepaper/Whitepaper.en.md)
§4.3.

**Sanctioned address** — an address flagged by the configured
sanctions oracle. `LibVaipakam.isSanctionedAddress(...)`. Tier-1
entry points revert; Tier-2 close-out paths stay open so the
unflagged counterparty can be made whole. See `CLAUDE.md` §
"Retail-deploy policy — sanctions ON".

**Secondary oracle quorum (Phase 7b.2)** — Tellor + API3 + DIA Soft
2-of-N. Activates when primary (Chainlink) is stale / missing.
Per-asset config from `asset.symbol()`; no governance config.

**Selector coverage** — `SelectorCoverageTest`. Every external /
public function compiled into a facet is asserted to be cut into
the Diamond, with no 4-byte collision. Part of the deploy-sanity
suite.

**Settler (0x)** — the 0x Protocol's swap router. NOT the recipient
of the ERC-20 allowance (allowance goes to the AllowanceHolder).
The split is enforced by `AggregatorAdapterBase`.

**SSH commit signing** — verified-commit channel for `main`. Setup
verified end-to-end 2026-05-19.

**Submodule** — pinned-SHA dependency under `contracts/lib/`. Updates
require a deliberate, reviewed, re-audited PR. Dependabot is
intentionally not configured for `gitsubmodule`. See `CLAUDE.md`
§ "Dependabot".

## T

**TokenAdminRegistry (CCIP)** — the registry that knows which
TokenPool serves which token on which chain. The CCT admin (= the
project's multisig → timelock) registers pools here.

**Tier 1 / 2 / 3 (Codex finding)** — severity badges on Codex
output. P0/P1 = blocker, P2 = should-fix, P3 = advisory. Distinct
from "Tier 1 / 2 / 3 best-practices" arc — see Tier-N (best
practices) below.

**Tier-N (best practices)** — the pre-audit best-practices arc
(#92/#93/#94 = Tier 1/2/3). Distinct from Codex's severity tiers
above.

**Time-weighted discount accumulator** — see Accumulator
(time-weighted).

**Timelock** — Governance timelock contract; the eventual owner of
every Diamond + cross-chain contract at mainnet. Multisig → timelock
is the canonical mainnet handover pattern (see `CLAUDE.md` §
"Cross-Chain Security Policy").

## V

**Vaipakam** — Tamil for "Bank". The project name.

**Vault (formerly Escrow)** — the per-user UUPS proxy that holds a single
user's assets (ERC-20 / ERC-721 / ERC-1155). Deployed by `VaultFactoryFacet`
(renamed from `EscrowFactoryFacet` in #227 pre-mainnet); shares a common
upgradable `VaipakamVaultImplementation` owned by the Diamond. The legal
connotations of "escrow" (regulated fiduciary holder under multiple
jurisdictions) didn't fit a permissionless DeFi protocol — Yearn, Curve,
Morpho, and Aave all use "Vault" as the DeFi-native term, with no
equivalent regulatory baggage. The on-chain semantics are unchanged: still
a per-user isolated proxy with no commingling. See ADR-0008
(`docs/adr/0008-per-user-vault-factory.md`).

**Viaduct (viaIR)** — Solidity 0.8.29's intermediate-representation
compilation pipeline (`viaIR = true`). Adopted protocol-wide for
optimizer determinism. Cost: 5-15 min builds, 8 GB RSS — hence the
`nice -n -10 ionice -c 2 -n 0` prefix convention.

**VPFI** — the protocol token. ERC-20 on the canonical chain (Base);
`VPFIMirrorToken` proxy on mirror chains. Wired for fee discounts,
vault-based staking, and locally-claimable interaction rewards.

**VPFI tier (1/2/3/4)** — discrete fee-discount tier derived from
the user's VPFI vault balance × `time-weighted accumulator`.
Higher tier = larger LIF rebate at proper-close terminal.
