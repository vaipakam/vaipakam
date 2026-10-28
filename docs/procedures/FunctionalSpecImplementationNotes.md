# Functional Spec Implementation Reference

This file preserves implementation guidance, historical verification inventories,
and superseded operational descriptions separated from the functional specs.
It is supporting evidence, not a statement that every described component or
procedure is current. The documents in [FunctionalSpecs](../FunctionalSpecs/README.md)
state intended behavior; unresolved implementation differences remain in the
[divergence audit](FunctionalSpecsCodeVsDocsAudit.md). In particular, the keeper's
intended destination is a dedicated Cloudflare database and separate Oracle Cloud
VM; older hosting descriptions below are historical.

## Superseded keeper hosting description

- **The keeper may be hosted as a Cloudflare Worker or as one long-running process on an always-on machine** (#2500), and it does the same thing on either. Both hosts run one shared definition of a tick, so the duties, how often each runs, the switches that arm them and every rule above are identical. Both use the same shared database, because the keeper shares it with the services that record user alert settings and own its layout. The rules a host must keep:
    - exactly one copy of the keeper runs for one signing key, counting a Worker that is still scheduled, because ordering transactions across copies is not provided (see above);
    - every tick, on either host, first claims a single shared lease under the running copy's own name, and does nothing while another copy holds it, saying which copy holds it and until when (#2503). A copy with no name, or one that cannot reach the lease, does nothing either, because it cannot confirm it is the only one. A copy renews its lease every minute, including on minutes it skips for a tick still running, and a lease that stops being renewed lapses after ten minutes, so a copy that died hands over by itself. Whether a lease is still live is judged by one shared clock, the database's, never a copy's own, so a copy whose clock is wrong can neither take a live lease nor keep one past its time. A machine is named after its host unless its settings name it otherwise. The lease stops a second copy from starting ticks; it is not a promise that a duty started before a hand-over cannot overlap one started after it, so the one-copy procedure above still applies;
    - ticks on the machine never overlap: a minute that arrives while the previous tick is still running is skipped, and the log names the duties still running;
    - before each tick on the machine, the keeper confirms that the database has every layout change the running code was written for, and declines the tick by name while one is missing. On the Worker, the deploy refuses to publish until the same check passes; a machine has no deploy step, so the check moves into the tick;
    - with no database configured, the keeper reads and writes nothing and says so on every tick;
    - stopping the process lets the tick in flight finish, so a restart never cuts off a transaction between signing and sending;
    - a setting left empty on the machine counts as unset, exactly as an unbound setting does on the Worker, so it takes the documented default rather than an empty value;
    - on the machine, a merge to the branch it follows is its deploy, as it is for the Workers. A new build replaces the running one only after it has been built and shown to load, and the switch waits for the tick in flight. A merge that does not change the keeper does not restart it, and a build that fails leaves the running keeper as it was;
    - each release is built from that commit's own source, in a throwaway account that cannot read the keeper's settings or signing key, cannot change any release already installed, and keeps nothing from one build to the next, so no build can leave tools behind for a later one; builds never run two at once; only the privileged updater installs a release, under the commit it was built from. A release always runs under the service settings and updater of the same commit, so a change to how the keeper must be run arrives together with the code that needs it, and reinstalling the machine never puts newer settings under an older release; The keeper itself runs with no standing account of its own. The machine's administrator can read the keeper's settings and key, and the setup guide says so;
    - nothing stops the keeper by force on a timer. A stop that hangs is left to the operator, because a forced stop can cut a transaction off between sending and recording.
  The machine reaches the database with a credential that Cloudflare cannot narrow to one database, so it can read and write every database in the account. The setup guide says so and treats that credential like the signing key.

## Contract architecture and component inventory

- **Language:** Solidity (latest stable version, e.g., 0.8.x, specify version like 0.8.29 if decided).
- **Core Contracts (Examples):**
  - `VaipakamOfferManagement.sol`: Handles creation, cancellation, and matching of lender/borrower offers.
  - `OfferMatchFacet` or equivalent matching facet: Hosts bot-facing Range Orders preview / match entrypoints when needed to keep the offer-management facet under the EIP-170 runtime bytecode ceiling. Range Orders pushed ordinary offer management past the real-chain bytecode limit, so matching and ordinary create / accept / cancel logic should remain split where necessary for deployability.
  - **Deployability splits, generally.** The bytecode ceiling is a real-chain constraint, not a design preference, so a facet that outgrows it is expected to be split rather than trimmed of behaviour. Two rules govern where the seam goes. First, the seam follows a boundary the product already has — a distinct user-facing route, a distinct actor, a distinct lifecycle stage — never an arbitrary bisection chosen to balance byte counts. Second, halves that are only correct when read together stay together: where two entry points share an invariant (a link one writes and the other clears, a one-at-a-time rule, a cooldown), splitting between them turns a locally-checkable rule into a cross-facet one and is the wrong seam even when it would free more space. Third, and cheapest where it is available: where a facet already reaches part of its own work through an internal self-call — a step deliberately run in its own execution context, typically to bound how much of the work is charged to one call frame — that self-call is a boundary the code already crosses on every run, and moving the step to the other side of it is the least disruptive seam there is. Nothing about the observable sequence changes, because the boundary is not new; only which address hosts the step beyond it. This third case is not an exception to the second rule but a limit of it: what the second rule protects is the ability to check a rule by reading one place, and a step that already executes behind a self-call is already being read that way. A split changes deployment shape only — the routes it separates keep the same behaviour, the same shared state, the same single transaction (any failure past the boundary still unwinds the whole acceptance), and the same single address that callers use.
  - `EarlyWithdrawalDirectFacet` or equivalent direct lender-exit facet: hosts the one-transaction lender exit (selling a position straight into a standing lender offer) when the listed-sale route's facet needs the room. The two lender-exit routes are separate user-facing choices that share no internals, whereas the listed route's own two stages — putting the position up for sale, and completing the sale once a buyer takes it — share the listing's binding and lifecycle rules and are expected to stay in one facet.
  - `VaipakamLoanManagement.sol`: Manages active loans, repayments, defaults, and liquidations.
  - `VaipakamVault.sol`: Holds collateral, ERC-721/1155 rental NFTs, and funds during various stages.
  - `VaipakamNFT.sol`: The ERC-721 contract responsible for minting and managing Vaipakam NFTs.
  - `VaipakamGovernance.sol` (Phase 2): Manages proposals and voting.
  - `VaipakamTreasury.sol`: Collects and manages platform fees.
  - VPFI tokenomics facets (Phase 1): Manage VPFI vault deposit / withdraw utility, fee-discount accounting, treasury routing, and interaction-reward claims.
  - `ConfigFacet`: Exposes mutable governance configuration and compile-time protocol constants that the frontend uses for live copy, tier tables, thresholds, and tooltips.
  - `OracleAdminFacet`: Exposes oracle-admin setters and getters, including Pyth cross-check, secondary-oracle, PAD, and direct-feed override configuration used by protocol-console tooling.
  - `RewardReporterFacet`: Exposes cross-chain reward reporting and grace-window configuration used by tokenomics accounting and protocol-console tooling.
  - `ClaimFacet`: Exposes claimable positions and fallback-settlement snapshots used by Loan Details, Claim Center, and claim readiness surfaces.
- **Libraries:**
  - OpenZeppelin Contracts: For robust implementations of ERC-20, ERC-721, ERC-1155 (if Vaipakam mints its own utility NFTs beyond offer/loan representations), AccessControl, ReentrancyGuard, and potentially Governor.

## Frontend implementation guidance

- **Framework:** React with wagmi v2 and viem for wallet connection, contract reads/writes, multicall batching, and direct JSON-RPC control.

## Frontend implementation guidance

- **Legacy Provider Policy:** The frontend should not retain ethers.js compatibility shims or ethers as a production dependency after the wagmi / viem migration.

## Frontend implementation guidance

- **State Management:** Robust state management solution (e.g., Redux, Zustand).

## Frontend implementation guidance

- **API Standards:** Frontend will interact with smart contracts using standardized data formats (e.g., JSON-like structs or arrays returned by view functions).

## Frontend implementation guidance

- **ABI Sync:** After any contract release that changes selectors, structs, events, or frontend-consumed ABIs, run the ABI export phase after `forge build` so `@vaipakam/contracts/abis`, app-local provenance files, and every consumer bundle match the deployed contract build and carry the source commit hash. When keeper-bot-consumed facets change, run the keeper-bot ABI export as well so bot JSONs and provenance stay aligned with the monorepo build.

## Frontend implementation guidance

- **Worker ABI Sync:** Agent, keeper, indexer, and watcher-style workers must import generated JSON ABI bundles from the same compiled contract artifacts as the frontend and keeper-bot ABIs. Hand-typed selector strings or positional tuples for structs such as `Offer` or `Loan` are not acceptable because a renamed selector or inserted field can silently break production reads. Deploy scripts should run worker ABI exports alongside other ABI exports, and worker bundles should carry provenance stamps.

## Frontend implementation guidance

- **Ready Diamond Read Helper:** Frontend hooks that read from the Diamond should use a shared ready-Diamond handle that returns null when the active chain has no Diamond address. Hooks must short-circuit in that state rather than calling `readContract`, multicall, or protocol-config reads against `ZERO_ADDRESS`.

## Frontend implementation guidance

- **App-Chain-Pinned Public Client:** Diamond reads should use a shared public-client wrapper pinned to the app-selected chain id, not bare `usePublicClient()` from wagmi, because the wallet chain and app read chain can diverge during switch flows. Lint or review rules should reject new direct wagmi `usePublicClient` imports outside the wrapper, with documented carve-outs only for intentionally cross-chain utilities that receive an explicit chain id.

## Verification procedures and coverage inventory

### Testing and Auditing

- **Testing:** Comprehensive test suites should cover unit, integration, and end-to-end flows, including positive/negative paths, edge cases, metadata/event checks, and various asset-handling scenarios.
- **Internal Audits:** Static analysis tools and internal code reviews should be part of the standard development process.
- **Fuzz Testing:** Financial math, defaults, and LTV / health-factor edge cases should be fuzz tested.
- **Open-Source Tests:** Test cases may be made open-source after mainnet deployment for community review.
- **External Auditing:** Mandatory third-party security audits should be completed before mainnet launch, with reports published where appropriate.
- **Bug Bounty:** A public bug bounty program should be defined before mainnet launch, including scope, severity levels, reward ranges, and a public reporting link. The website footer should link to that program once published.
- **Secret Hygiene:** Repository-tracked configuration must not contain private keys, even well-known local development keys; local Anvil or testnet keys should be supplied through local-only environment files or shell configuration outside committed allowlists.
- **Liquidation Invariants:** Tests must assert that liquidation swap calldata uses the protocol-computed oracle-derived minimum output and that callers cannot influence the slippage floor.
- **Oracle-Hardening Tests:** Tests should cover per-feed override admin gating, staleness override behavior, minimum-answer floor behavior, secondary-oracle agreement, divergence, stale secondary data, and missing secondary data, the three price statuses (priced, unavailable for a missing feed or a stale primary, distrusted when every responding secondary disagrees or the Pyth cross-check diverges, and unavailable for any other revert), and the Tellor dispute buffer: the read asks only for reports older than the buffer, a fresh report is not consumed until it has aged past the buffer, the newest report outside the buffer is the one used, and a chain younger than the buffer reads Tellor as unavailable.
- **Autonomous Tier-LTV Tests:** Tests should cover peer-read not-listed / reverted cases, peer plausibility bounds, peer disagreement filtering, insufficient readings, no-reference-assets rejection, out-of-band-low / out-of-band-high rejection, per-tier independent refresh behavior, cache TTL fallback to the governance-configured per-tier max-init-LTV caps (defaults `50%` / `60%` / `65%`), stale-cache warning events, and loan-init / match-preview use of `effectiveTierMaxInitLtvBps`.
- **Tier Safety-Box Tests:** Tests should cover `setTierLtvParams` admin gating, floor / ceiling consistency, haircut bounds, cross-tier non-overlap, atomic all-tier updates, and zero-storage fallback to library constants.
- **Failed-Swap Fallback Tests:** Tests should cover failed liquidation with fresh oracle quorum using the fair-value collateral split, failed liquidation with stale or unavailable quorum using the full-collateral branch, emission of the dedicated oracle-unavailable fallback event, and a fully priced loan whose lender entitlement is worth less than one collateral unit taking the fair-value split (the lender's share rounded up to the collateral that covers it) rather than the oracle-unavailable branch. They should cover a distrusted collateral or principal price refusing the fallback with the distrusted read's own error (the quorum's or the cross-check's) with the loan still active and nothing recorded, a missing price on one leg winning over a distrusted price on the other (the full-collateral branch), and the settlement-time liquidity classification refusing when the collateral's price (the wrapped native token's included), or a quote asset with a pool deep enough for the floor, is distrusted, while staying illiquid when the price is merely missing or the distrusted quote asset has no pool, only an empty one, or only one too shallow for the floor. They should also cover the custody rule for the fallback: after a failed liquidation or time-based default the protocol's own balance holds none of the collateral and the borrower's vault holds all of it, locked, with the loan's fallback record equal to the fallback split's total; every share that leaves the borrower's vault — to the treasury, the lender, the keeper backstop, a retry or an internal-match leg (including a match in which both legs are fallback-pending, each paying its own leg) — lowers both the lock and the fallback record by exactly that share; a failed retry puts back exactly what it drew; after an in-kind settlement the record is zero and the lock is exactly the borrower's retained share plus any top-up; a cure by top-up or a full repayment moves no tokens and returns the whole fallback amount to the ordinary collateral lock; every movement is announced with its amount; a VPFI fallback is excluded from the borrower's fee tier by exactly the amount the record holds; a borrower sanctioned after the fallback cannot block the lender's claim; a fallback row recorded under the old custody is refused at every settlement path; and a time-based default that moves VPFI collateral out of the borrower's vault, by swap or in kind, leaves the borrower's fee-tier stamp equal to the VPFI the vault then holds.
- **Discounted Liquidation Tests:** Tests should cover the discount-path master switch, zero recipient, inactive loan, sequencer unhealthy, Health Factor not liquidatable, untierable collateral, stale oracle quorum, happy-path tier settlement with exact debt / collateral seized / borrower surplus math, and event emission.
- **Discount Config Tests:** Tests should cover `setTierLiqDiscountBps` admin gating, per-tier floor / ceiling bounds, cross-tier monotonicity, zero-fallback behavior against library defaults, kill-switch toggling, and event emission.
- **Flash-Loan Receiver Tests:** Tests should cover constructor guards, owner-gated entry points, provider-not-configured branches, callback in-flight guards, unprofitable-trade reverts (including a loss that only the receiver's standing balance could cover), net profit reported per run, swap-target-reverts, an adapter the platform does not route or has disabled, a quote naming a call target outside the adapter's allow-list, the adapter being the only address approved, Aave and Balancer happy paths, and profit withdrawal / rescue flows.
- **Flash-Loan Atomicity Tests:** Tests and review should verify that keeper-funded flash-loan liquidation is atomic: the Diamond receives or pulls the principal repayment before collateral is released, the flash-loan callback reverts the whole transaction if debt plus fee cannot be repaid, and the keeper receiver does not retain custody of user funds between transactions.
- **Internal-Match Liquidation Tests:** Tests should cover internal-match enablement defaulting off, per-tier liquidation-threshold snapshots at loan initiation, two-loan reciprocal matches, three-loan cycle matches, priority-window blocking of external liquidation, reopening external liquidation after the window, per-leg incentive bounds, partial-match residual claimability, terminal-state claim behavior, lender-side claim of matched proceeds by the current (possibly transferred) lender-position holder, two-sided order-independent settlement (lender-first and borrower-first) including zero-residual settlement on the lender claim alone, the stored lender being unable to extract the proceeds after a position transfer, sanctions rejection of a flagged lender claimant, claim-time auto-dispatch paying the triggering holder, fallback-pending full rescue, fallback-pending partial residual scaling, oracle-unpriceable fallback-pending rejection, active-to-internally-matched and fallback-pending-to-internally-matched lifecycle edges, and event/indexer compatibility.
- **Offer-System Behaviour Tests:** Tests should cover fill-mode behaviour, offer expiry and cleanup, in-place offer modification without orphaning already-filled obligations, direct-accept preview parity with actual acceptance, and self-trade prevention across both direct acceptance and permissionless matching.
- **NFT Collateral Listing Tests:** Tests should cover borrower opt-in, lender-side permission, minimum sale-floor enforcement, approved marketplace transfer paths, full-position ERC-1155 sales, listing update and cancellation, marketplace-fill settlement order, grace-boundary expiry, default after an unfilled listing, proper close after a sale, stale-listing cleanup after other terminal paths, offer consumed by sale before lender acceptance, sale-versus-accept race handling, Dutch-decay monotonicity and auction-window bounds, atomic OpenSea-offer match rotation, fee-enforced collection fulfillment-data handling, sibling-listing approval isolation, current-borrower-holder release authority, and sanctions checks at fill time where sanctions screening is active.
- **Swap-to-Repay Tests:** Tests should cover full-close and partial-reduction modes, partial-mode rejection when the swap would close the loan, current borrower-position NFT authority, lender-self-repay rejection, all-routes-failed atomic revert, slippage-cap enforcement, settlement waterfall parity with ordinary repayment, borrower surplus principal delivery, full-close sale sizing to the debt (independent of a generous bound, with a bound too small to cover the debt refused, and across assets and price feeds of different decimals), resolver-filled intent lot sizing (the lot sized to the debt and not to the asked price, the whole collateral staying in the borrower's vault and pledged until the fill, the remainder released through the claim after a fill, a cancel that moves nothing, a higher ask paid out as surplus, a loan with a live auction excluded from internal matching, and a commit refused when no lot can cover the debt), resolver-filled intent fills driven through the whole limit-order fill in one transaction (the lot taken exactly and only inside its fill, every re-entry during the fill refused and the same calls admitted outside it, a nested fill refused, a fill funded by exactly the taking amount, a collateral token taking other than exactly the lot out of the vault failing the fill while the auction stays cancellable, a borrower flagged after committing blocking neither the fill nor a cancellation, a pause stopping fills, a mandatory vault upgrade holding a fill until anyone runs it, the borrower's vault as the order's seller signing only for its own live auctions with an approval equal to the sum of their lots, and a commit recorded under the old custody refused by name), unused collateral claim creation, prepay-listing cleanup, and event/indexer compatibility for Activity and Loan Details timelines.
- **Auto-Lifecycle Tests:** Tests should cover per-user auto-lend / offer-posting and auto-opt-in flags, default and per-loan auto-refinance caps, default-off behavior for illiquid and NFT-collateral loans, refinance-target offer tagging at create and accept time, atomic accept-and-refinance for direct and matched accept paths, stale-cap rejection after NFT transfer, keeper-driven refinance fund routing through the current borrower-position holder, wallet-approval source-of-funds expectations, auto-extend both-side cap intersection, kill-switch reverts, sanctions checks, periodic-interest settle-first protection, pre-grace watcher throttling and the rule that no offer in the book suppresses the warning, and keeper reward behavior.
- **Production-Superset Test Harness:** Shared test scaffolding should route every production Diamond facet selector plus any explicit test-only helpers. A test should not pass by accidentally hitting a missing selector where production would route the call, especially for pause, legal, reward, oracle-admin, vault, and tokenomics surfaces.
- **Off-Chain Data-Flow Audit:** Before mainnet, the project should maintain a catalog of off-chain reads and writes used by the frontend, workers, indexer, keeper, and operator tools. Each entry should identify signer requirements, freshness or time-to-live assumptions, fail-open or fail-closed behavior, plausibility checks, and blast radius. External reads that influence money-moving decisions should have explicit stale-data handling, and keeper writes should remain bounded by on-chain checks.
- **Off-Chain Data Resilience:** Before mainnet, production off-chain data needed for usability and compliance should have an encrypted backup path outside the primary hosting account and billing boundary. The backup set should include indexed offer / loan data, diagnostics needed for support, legal-hold audit records, and legal-document storage. Operators should verify backup readability on a recurring schedule and maintain a documented restore path for a fresh hosting account. Every record users create off chain, such as signed offers, belongs in that backup set, and every off-chain table has a decided restore treatment: it is either restored from the backup or rebuilt from the chain, and where part of a record comes from the chain, that part is rebuilt from the chain rather than trusted from the backup.
- **Risk Sign-Off Package:** Before each mainnet launch or material risk-control activation, operators should archive a risk sign-off covering audit posture, parameter sanity, emergency controls, bot and external dependency readiness, chain-specific deployment readbacks, liquidation economics, sequencer and oracle outage behavior, and the exact scope being approved.
- **Release-Notes Discipline:** Behaviour-changing pull requests should carry their own unreleased release-note fragment so operator-facing change history lands atomically with the work. Daily or release-cut assembly may fold those fragments into dated release notes, and CI should warn when app or contract behaviour changes without a corresponding release-note entry.
- **Required CI Gate:** The protected main branch should require fast deploy-sanity, positive-flow, and workspace-validation checks, plus the change-detection gate that decides which checks are relevant for a pull request. Per-PR contracts CI should use the narrow `cifast` Foundry profile for the deploy-sanity and positive-flow surface so routine PRs stay within hosted-runner memory limits. Slow full-regression and gas-cost review checks are operator-local on ordinary pull requests, while release branches and version tags must run the full predeploy regression as a hard mainnet gate before cutover. The removed `contracts-full` and `gas-snapshot` jobs should not be referenced as live PR gates in FunctionalSpecs, runbooks, or comments.
- **Deploy Guardrails:** Deploy sanity coverage should fail before broadcast when a facet would exceed the EVM runtime-size limit, when a public selector is missing, duplicated, or routed to the wrong facet, when the expected facet count does not exactly match the deployed Diamond, or when committed ABI files are stale or missing. These checks protect deployability and consumer compatibility rather than changing user behavior.
- **Worker Environment Preservation:** Each Worker that relies on operator-tuned environment values managed outside its checked-in configuration should declare, in that configuration, that such values survive a deployment.
  - Preservation is a property of the **Worker**, not of the command used to deploy it: any ordinary deployment of that Worker should leave operator-managed values intact, whatever route or wording is used to trigger it, and whether the deployment publishes immediately or stages a version.
  - This matters because those values govern live behaviour — liquidation thresholds and confidence windows for the keeper, recipient-token validation and marketplace pagination for the agent — so losing them silently reverts risk behaviour to defaults at the moment it starts mattering. Deleting such a value should be a deliberate operator action, never a side effect of shipping code.
  - Automated checks should verify this preservation is declared. The verification should read configurations **structurally**, discover them rather than trust a list, and require the declaration on **every deployment configuration in the tree** — not only the canonical one per Worker, and not only those a check judges to be for a Worker that has values to lose. Which configuration a deployment loads, and which Worker it targets, are decided on the command line: the stored name can be overridden, a missing compatibility date supplied, a named environment selected, and an arbitrary path chosen. A check cannot answer any of that from the files alone, and an attempt to do so is the same unbounded inference this specification rejects elsewhere. Requiring the declaration everywhere removes the question. A Worker with no operator-managed values today should declare it too, so that gaining one later is not also a moment of exposure. Two bounded exceptions follow from the deployment tool's own rules rather than from judgement about the file: a **project mode the tool refuses the declaration for** is exempt, identified by that mode's own marker, since requiring it would leave no version of the file that satisfies both the tool and the check; and a **named environment within a configuration** is not separately required to declare it, because the setting is top-level-only and the top-level value is what a deployment reads once an environment is selected. Where such a rule is unclear, the answer is to establish what the tool does — not to require the cautious-looking thing, which here would mean an unsupported field.
  - A secondary check **may** additionally reject individual deployment commands that would not preserve them, for Workers where the declaration is absent. That allowance stands and is deliberately not withdrawn; the platform simply does not exercise it, because the one case such a check demonstrably added — a command selecting a non-canonical configuration — is answerable as a property of configurations, above, and everything else it attempted was not. Any future secondary check must still meet the constraints the platform has already ratified for one: admit only a **semantics-preserving normalisation of a known notation**, never an inference about which text is executable or what a name stands for; **establish** a runner's behaviour rather than assume it, and where it cannot be established, judge the command on its own terms instead of guessing in either direction; prefer **missing an exotic spelling over reporting text that performs no write**, because it runs inside routine validation where a false report blocks correct work; and **record and pin by a test** every miss it knowingly keeps. The fuller account of why three attempts at such a check were withdrawn is in [`DeployGuardRewriteScanRecord.md`](../DesignsAndPlans/DeployGuardRewriteScanRecord.md), which is a record and binds nothing.
  - Where a check would need another system's execution model to answer correctly — a continuous-integration system's, a document format's grammar, a build tool's variable language — the correct answer is a **declaration from the deployment itself** rather than a better approximation in the check.
  - What the declaration does not cover should be **stated where the checking lives** rather than left to be inferred: a deployment that explicitly overrides the declaration on the command line, a configuration that does not exist in the tree at checking time because it is generated — which a command-level check could refuse by declining to trust an unreadable selection, so removing one is a real reduction in coverage and not merely an unchanged limitation — and a configuration checked in under a name that does not follow the deployment tool's own convention. The last two are **reductions** rather than limitations the platform always had — a command-level check covered both, one by declining to trust an unreadable selection and one by following whatever path a command named — and a specification that lists them without saying so understates what an approver is accepting. Recognising the naming case again would mean classifying arbitrary files by their contents, which is the failure mode that produces false reports on correct work, so the convention is stated as a rule for contributors instead.
- **Static-Analysis Closure:** Static-analysis findings should be triaged to zero open high-risk findings before mainnet readiness. Dismissed findings need written rationale, dependency findings should be filtered when they belong to unmodified audited libraries, and real dead-code findings should be removed instead of suppressed.
- **Generated Contract Documentation:** Public NatSpec documentation must describe the current Chainlink CCIP cross-chain architecture and avoid stale LayerZero / OApp wording. If generated public docs are known to be materially stale during a migration, the published site should visibly warn readers until the wording is corrected, and that warning should be retired once the docs are current.
- **Governance-Handover Tests:** Tests should verify that Governance Safe, Timelock, Pauser / Guardian Safe, and any KYC operator role are installed correctly, that `UNPAUSER_ROLE` is Timelock-held, that `PAUSER_ROLE` alone cannot unpause globally or per asset, and that the deployer EOA retains no residual privileged authority after handover. A test of a model Diamond is not evidence about a deployment: the live handover check above is what proves a chain, and its own tests must show it fails on an unnamed holder, an unaccepted transfer, a wrong guardian and a truncated history.
- **Testnet E2E Baseline:** After a fresh testnet redeploy, operators should run the full positive-flow E2E suite on the canonical testnet and partial-flow E2Es on mirror testnets. The 2026-05-11 rehearsal baseline used Base Sepolia as canonical and Sepolia as the active mirror after retiring Arb Sepolia from the exported bundle until it is redeployed and re-wired; Base Sepolia completed preflight, fresh contracts, configure, verify, and full flow tests, while Sepolia completed preflight, fresh contracts, configure, and verify. The 2026-05-10 rehearsal baseline covered Base Sepolia, Arb Sepolia, and Sepolia with the phase-based deploy ceremony; Base Sepolia and Sepolia completed handover plus `DeployerZeroRolesTest`, while Arb Sepolia deliberately stopped before handover because Safe bytecode was absent at the configured addresses. Flow sweeps should preserve the same chain-agnostic signature as local Anvil: full PositiveFlows on canonical rehearsal chains and PartialFlows on mirror chains. The older 2026-04-30 baseline covered 15 lifecycle scenarios on Base Sepolia with 204 / 204 successful receipts, and left Sepolia + BNB Testnet in frontend-testable midpoint states.

#### Positive-flow coverage map

Every spec-mandated happy path has a dedicated test. Run from `contracts/`:
`forge test --match-contract <ContractName> -vv`. The list below mirrors the
flow list in the Phase-1 gap audit (see CHANGELOG `[Unreleased]`).

**End-to-end scenario suites** — full create / accept / resolve lifecycles:

- **ERC-20 lending lifecycle** — [contracts/test/scenarios/Scenario1_ERC20LendingLifecycle.t.sol](../../contracts/test/scenarios/Scenario1_ERC20LendingLifecycle.t.sol)
  - `test_Scenario1a_CreateOffer_Accept_Repay_Claims` — happy-path repay+claim.
  - `test_Scenario1b_CreateOffer_Accept_Default_LenderClaims` — default → lender claim.
  - `test_Scenario1c_ThirdPartyRepays_BorrowerClaimsCollateral` — non-borrower repayment, borrower reclaims collateral.
- **NFT rental (ERC-721)** — [contracts/test/scenarios/Scenario2_NFTRentalLending.t.sol](../../contracts/test/scenarios/Scenario2_NFTRentalLending.t.sol)
  - `test_Scenario2a_ERC721Rental_FullLifecycle` / `..._Default`.
- **NFT rental (ERC-1155)** — [contracts/test/scenarios/Scenario2b_ERC1155RentalLending.t.sol](../../contracts/test/scenarios/Scenario2b_ERC1155RentalLending.t.sol)
  - `test_Scenario2b_ERC1155Rental_FullLifecycle` / `..._Default`.
- **Illiquid collateral** — [contracts/test/scenarios/Scenario4_IlliquidCollateral.t.sol](../../contracts/test/scenarios/Scenario4_IlliquidCollateral.t.sol)
  - `test_Scenario4a_IlliquidCollateral_Default_FullTransferToLender`.
- **Lender early-withdrawal** — [contracts/test/scenarios/Scenario7_LenderEarlyWithdrawal.t.sol](../../contracts/test/scenarios/Scenario7_LenderEarlyWithdrawal.t.sol)
  - `test_Scenario7a_SellLoanViaBuyOffer` / `test_Scenario7b_CreateSaleOffer_NewLenderAccepts`.
- **Borrower preclose** — [contracts/test/scenarios/Scenario8_BorrowerPreclose.t.sol](../../contracts/test/scenarios/Scenario8_BorrowerPreclose.t.sol)
  - `test_Scenario8a_TransferObligationViaOffer` / `test_Scenario8b_OffsetWithNewOffer_ThenAccept`.
- **Fallback-claim race** — [contracts/test/scenarios/ScenarioFallbackClaimRace.t.sol](../../contracts/test/scenarios/ScenarioFallbackClaimRace.t.sol)
  - `test_ScenarioA_BorrowerRepaysBeforeLenderClaim` / `...B_AddsCollateralBeforeDefault` / `...C_PartialThenFullRepay`.

**Gap-filler positive tests** — spec-mandated flows that weren't covered by the scenarios:

- [contracts/test/scenarios/PositiveFlowsGapFillers.t.sol](../../contracts/test/scenarios/PositiveFlowsGapFillers.t.sol)
  - `test_Positive_CountryPairAllow_FullLifecycle` — explicit allow-path lifecycle (Flow 15).
  - `test_Positive_LoanInitiationFee_ExactDeduction` — asserts exact 0.1% fee to treasury (Flow 29).
  - `test_Positive_PartialRepay_TwoStep_CompletesWithNoDust` — partial-then-full repay with remaining-balance assertion (Flow 9).
  - `test_Positive_KeeperTwoLayerOptIn_StateRecorded` — profile-level + per-loan keeper flag ledger (Flow 25).

**Phase-1 compliance integration** — the load-bearing KYC gate:

- [contracts/test/KYCTierEnforcementIntegration.t.sol](../../contracts/test/KYCTierEnforcementIntegration.t.sol) — full Tier 0 / 1 / 2 matrix across OfferFacet.acceptOffer:
  - `test_Tier0_AllowedBelowTier0Threshold` (< $1k).
  - `test_Tier0_BlockedAboveTier0Threshold` (reverts `KYCRequired` above $1k).
  - `test_Tier1_AllowedInMiddleBand` (between $1k and $10k).
  - `test_Tier1_BlockedAboveTier1Threshold` (reverts above $10k).
  - `test_Tier2_AllowedAboveTier1Threshold` (any amount).
  - `test_EnforcementOff_Tier0AllowedAboveThreshold` — confirms the `AdminFacet.setKYCEnforcement(false)` bypass.

**Per-facet positive tests** — happy-path coverage of individual entrypoints (file per facet):

- [contracts/test/OfferFacetTest.t.sol](../../contracts/test/OfferFacetTest.t.sol) — createOffer / acceptOffer / cancelOffer positives.
- [contracts/test/LoanFacetTest.t.sol](../../contracts/test/LoanFacetTest.t.sol) — initiateLoan, getLoanDetails, and combined Risk Disclosures / Terms consent state.
- [contracts/test/RepayFacetTest.t.sol](../../contracts/test/RepayFacetTest.t.sol) — repayLoan, repayPartial, autoDeductDaily.
- [contracts/test/AddCollateralFacetTest.t.sol](../../contracts/test/AddCollateralFacetTest.t.sol) — addCollateral HF improvement.
- [contracts/test/ClaimFacetTest.t.sol](../../contracts/test/ClaimFacetTest.t.sol) — claimAsLender, claimAsBorrower.
- [contracts/test/DefaultedFacetTest.t.sol](../../contracts/test/DefaultedFacetTest.t.sol) — triggerDefault / triggerLiquidation, both liquid + illiquid paths.
- [contracts/test/PrecloseFacetTest.t.sol](../../contracts/test/PrecloseFacetTest.t.sol) — direct preclose, transfer-offer, offset-offer.
- [contracts/test/RefinanceFacetTest.t.sol](../../contracts/test/RefinanceFacetTest.t.sol) — refinanceLoan atomic settlement.
- [contracts/test/EarlyWithdrawalFacetTest.t.sol](../../contracts/test/EarlyWithdrawalFacetTest.t.sol) — sell-loan, buy-offer, wait-to-maturity.
- [contracts/test/PartialWithdrawalFacetTest.t.sol](../../contracts/test/PartialWithdrawalFacetTest.t.sol) — partial collateral withdrawal when HF allows.
- [contracts/test/ProfileFacetTest.t.sol](../../contracts/test/ProfileFacetTest.t.sol) — KYC tier updates, keeper opt-in/whitelist, country setting.
- [contracts/test/ConfigFacetTest.t.sol](../../contracts/test/ConfigFacetTest.t.sol) — all runtime-tunable setters + getters.
- [contracts/test/OracleFacetTest.t.sol](../../contracts/test/OracleFacetTest.t.sol) / [OracleAdminFacetTest.t.sol](../../contracts/test/OracleAdminFacetTest.t.sol) — price reads, sequencer uptime, staleness.
- [contracts/test/RiskFacetTest.t.sol](../../contracts/test/RiskFacetTest.t.sol) — LTV / HF calculation, liquid HF-based liquidation.
- [contracts/test/MetricsDashboardFacetTest.t.sol](../../contracts/test/MetricsDashboardFacetTest.t.sol) and related metrics suites — per-user indexed dashboard reads, active-offer asset-pair pagination, and struct-returning per-user offer rows should stay covered without walking global active sets.
- MetricsFacet tests should cover current-holder position views for secondary-market recipients: transfer lender, borrower, and offer position NFTs; assert `getUserPositionLoans` / `getUserPositionOffers` follow the current NFT owner; and assert the sum of resolved loan / offer positions matches the holder's Vaipakam position-NFT balance where appropriate.
- [contracts/test/AdminFacetTest.t.sol](../../contracts/test/AdminFacetTest.t.sol) — treasury / 0x proxy / pause toggles.
- [contracts/test/DiamondBornPausedTest.t.sol](../../contracts/test/DiamondBornPausedTest.t.sol) — fresh Diamonds start paused through constructor and remain paused after the deploy. [contracts/test/deploy/LaunchTest.t.sol](../../contracts/test/deploy/LaunchTest.t.sol) — the launch step's per-chain rules: local warns and unpauses, a testnet refuses an unmet requirement, a production chain refuses anything short of every requirement met and a complete handover, and only prints the Timelock proposal; the Timelock's execution reverts when a requirement stopped holding during the delay, when the deploy key regained a role, or when a pause was recorded after the proposal; and an unpause outside the launch step is refused rather than recorded.
- [contracts/test/AccessControlTransferAdminTest.t.sol](../../contracts/test/AccessControlTransferAdminTest.t.sol) — atomic admin / role / ERC-173 ownership transfer and lockout of the former admin.
- [contracts/test/TreasuryFacetTest.t.sol](../../contracts/test/TreasuryFacetTest.t.sol) — claimTreasuryFees.
- [contracts/test/TreasuryMintVPFITest.t.sol](../../contracts/test/TreasuryMintVPFITest.t.sol) — VPFI mint for treasury-funded flows.
- [contracts/test/VaultFactoryFacetTest.t.sol](../../contracts/test/VaultFactoryFacetTest.t.sol) — per-user vault proxy creation, mandatory upgrade gating (a mandatory version above the current one refused, the change announced, and a user's own upgrade clearing a reachable one), the implementation contract refusing initialization, versioned upgrade event.
- [contracts/test/deploy/DeployAdminGuardTest.t.sol](../../contracts/test/deploy/DeployAdminGuardTest.t.sol) — the deploy refuses a zero admin, an admin that is not the supplied admin key's address, and, on a production chain, an admin equal to the deployer, before anything is deployed.
- [contracts/test/VaultRecoveryTest.t.sol](../../contracts/test/VaultRecoveryTest.t.sol) — protocol-tracked ERC-20 balances, unsolicited dust clamp, EIP-712 stuck-token recovery, disown event, and sanctions-source outcomes.
- [contracts/test/VaipakamNFTFacetTest.t.sol](../../contracts/test/VaipakamNFTFacetTest.t.sol) — position NFT mint / update / burn lifecycle.
- [contracts/test/MetricsFacetTest.t.sol](../../contracts/test/MetricsFacetTest.t.sol) — read-only analytics getters.
- [contracts/test/AccessControlFacetTest.t.sol](../../contracts/test/AccessControlFacetTest.t.sol) — role grants / revocations / emergency revoke.
- [contracts/test/AdminFacetTest.t.sol](../../contracts/test/AdminFacetTest.t.sol) / [PerAssetPauseTest.t.sol](../../contracts/test/PerAssetPauseTest.t.sol) — per-asset pause ON → blocks, OFF → unblocks.
- pause tests should cover the asymmetric role split: `PAUSER_ROLE` can pause but cannot unpause, `UNPAUSER_ROLE` can unpause but cannot act as the fast pauser unless separately granted, and per-asset unpause follows the same separation as global unpause.
- [contracts/test/PauseGatingTest.t.sol](../../contracts/test/PauseGatingTest.t.sol) — whenNotPaused modifier coverage across 15+ facet entrypoints.
- [contracts/test/VPFIDiscountFacetTest.t.sol](../../contracts/test/VPFIDiscountFacetTest.t.sol) / [VPFIDiscountBoundariesTest.t.sol](../../contracts/test/VPFIDiscountBoundariesTest.t.sol) — tier table, vault deposit / withdraw, fee discount application.
- VPFI token tests should cover canonical + cross-chain mirror mechanics, including rate limits, allowed lanes, and source-chain identity checks.
- [contracts/test/InteractionRewardsCoverageTest.t.sol](../../contracts/test/InteractionRewardsCoverageTest.t.sol) / [InteractionRewardCapTest.t.sol](../../contracts/test/InteractionRewardCapTest.t.sol) — interaction rewards emission schedule and pool-cap truncation.
- [contracts/test/Permit2IntegrationTest.t.sol](../../contracts/test/Permit2IntegrationTest.t.sol) / [contracts/test/fork/Permit2RealForkTest.t.sol](../../contracts/test/fork/Permit2RealForkTest.t.sol) — Permit2 integration against the local mock and real canonical Permit2 on a fork, including expired deadline, wrong amount, nonce reuse, and spender mismatch cases.
- Cross-chain reward plumbing tests should cover canonical broadcast + mirror aggregate reporting through the approved messenger and EVM chain-id model.
- swap-adapter tests should cover immutable allowance target approval, rejection of unallowlisted swap destinations, owner-gated allowlist edits, and protection against removing the last allowed destination.
- [contracts/test/GracePeriodTiersTest.t.sol](../../contracts/test/GracePeriodTiersTest.t.sol) — default grace-period tier transitions.
- [contracts/test/GraceBucketsTest.t.sol](../../contracts/test/GraceBucketsTest.t.sol) — admin-configurable six-slot grace schedule, bounds, defaults, event emission, and rollback to compile-time defaults.
- [contracts/test/PeriodicInterestCadenceTest.t.sol](../../contracts/test/PeriodicInterestCadenceTest.t.sol) / [contracts/test/PeriodicInterestSettleTest.t.sol](../../contracts/test/PeriodicInterestSettleTest.t.sol) — cadence eligibility, numeraire threshold validation, periodic settlement, interest-first partial repayments, auto-liquidation, and refinance settle-first protection.
- [contracts/test/VolatilityLTVTest.t.sol](../../contracts/test/VolatilityLTVTest.t.sol) — collapse-trigger (LTV > 110%) fallback path.
- [contracts/test/FallbackCureTest.t.sol](../../contracts/test/FallbackCureTest.t.sol) — borrower cures before fallback settlement.
- [contracts/test/StalenessHybridTest.t.sol](../../contracts/test/StalenessHybridTest.t.sol) — Chainlink hybrid staleness (peg tolerance).
- [contracts/test/SequencerUptimeCheckTest.t.sol](../../contracts/test/SequencerUptimeCheckTest.t.sol) — L2 sequencer circuit breaker.
- [contracts/test/EnumerationTest.t.sol](../../contracts/test/EnumerationTest.t.sol) — paginated offer / loan enumeration.
- [contracts/test/WorkflowComplianceAndRejection.t.sol](../../contracts/test/WorkflowComplianceAndRejection.t.sol) — full-stack sanctions / KYC rejection paths (5 tests `vm.skip`-marked for Phase 1, awaiting Phase-2 re-activation).
- [contracts/test/DeployerZeroRolesTest.t.sol](../../contracts/test/DeployerZeroRolesTest.t.sol) — post-handover role invariant, as a unit model on a throwaway Diamond. It never reads a deployed chain, so it is not evidence about one; the live check is [contracts/script/HandoverGate.s.sol](../../contracts/script/HandoverGate.s.sol) (`--phase handover-gate`), exercised by [contracts/test/deploy/HandoverGateTest.t.sol](../../contracts/test/deploy/HandoverGateTest.t.sol). (A `Create2DeploymentTest` was cited here for months after it left with the CREATE2 reward bootstrap in T-068; there is no deterministic-address deploy to test — see the retired CREATE2 bullets below.)

**Property / invariant suites** — stateful fuzzing, 100 runs × 50k calls each:

- [contracts/test/invariants/ConfigBounds.invariant.t.sol](../../contracts/test/invariants/ConfigBounds.invariant.t.sol) — ConfigFacet setters never breach MAX_FEE / SLIPPAGE / INCENTIVE / DISCOUNT caps.
- [contracts/test/invariants/InterestMonotonicity.invariant.t.sol](../../contracts/test/invariants/InterestMonotonicity.invariant.t.sol) — amount-due non-decreasing as time advances.
- [contracts/test/invariants/PerAssetPause.invariant.t.sol](../../contracts/test/invariants/PerAssetPause.invariant.t.sol) — paused-asset blocks new create/accept across all flows.
- [contracts/test/invariants/OfferLoanLinkage.invariant.t.sol](../../contracts/test/invariants/OfferLoanLinkage.invariant.t.sol) — every loan points to an accepted offer.
- [contracts/test/invariants/DefaultTiming.invariant.t.sol](../../contracts/test/invariants/DefaultTiming.invariant.t.sol) — defaults only trigger after grace-period window.
- [contracts/test/invariants/FundsConservation.invariant.t.sol](../../contracts/test/invariants/FundsConservation.invariant.t.sol) / [VaultSolvency.invariant.t.sol](../../contracts/test/invariants/VaultSolvency.invariant.t.sol) — no phantom funds, vault balances conserved.
- [contracts/test/invariants/LoanStatusMonotonicity.invariant.t.sol](../../contracts/test/invariants/LoanStatusMonotonicity.invariant.t.sol) — loan status only moves forward.
- [contracts/test/invariants/ClaimExclusivity.invariant.t.sol](../../contracts/test/invariants/ClaimExclusivity.invariant.t.sol) — each party claims at most once per loan.
- [contracts/test/invariants/CollateralMonotonicity.invariant.t.sol](../../contracts/test/invariants/CollateralMonotonicity.invariant.t.sol) — collateral balance only grows during loan life (addCollateral-only).
- [contracts/test/invariants/FallbackSettlement.invariant.t.sol](../../contracts/test/invariants/FallbackSettlement.invariant.t.sol) — fallback settlement consistent with HF/LTV collapse flags.
- [contracts/test/invariants/InteractionRewards.invariant.t.sol](../../contracts/test/invariants/InteractionRewards.invariant.t.sol) — reward emission stays within schedule + per-user cap.
- [contracts/test/invariants/VPFISupplyCap.invariant.t.sol](../../contracts/test/invariants/VPFISupplyCap.invariant.t.sol) — total VPFI supply never exceeds hard cap.
- [contracts/test/invariants/MetricsCountersParity.invariant.t.sol](../../contracts/test/invariants/MetricsCountersParity.invariant.t.sol) — MetricsFacet counters match raw storage.
- [contracts/test/invariants/NFTCountParity.invariant.t.sol](../../contracts/test/invariants/NFTCountParity.invariant.t.sol) / [NFTOwnerAuthority.invariant.t.sol](../../contracts/test/invariants/NFTOwnerAuthority.invariant.t.sol) — position-NFT count + authority correctness.
- [contracts/test/invariants/OfferAcceptanceIntegrity.invariant.t.sol](../../contracts/test/invariants/OfferAcceptanceIntegrity.invariant.t.sol) — accepted offers become loans; canceled offers never accept.
- [contracts/test/invariants/VaultUniqueness.invariant.t.sol](../../contracts/test/invariants/VaultUniqueness.invariant.t.sol) — one vault per user, no dupes.
- [contracts/test/invariants/SelfDealingPrevention.invariant.t.sol](../../contracts/test/invariants/SelfDealingPrevention.invariant.t.sol) — no lender == borrower loans.

Mainnet-cutover checklist: every `contracts/test/Scenario*.t.sol` + every
`contracts/test/invariants/*.invariant.t.sol` suite must be green on the
target network's fork before the `-mainnet-rc` tag is cut. See
[CHANGELOG.md](../../CHANGELOG.md).

## Development architecture and storage mechanics

## Developement Approach

The Diamond Standard (EIP-2535) need to be followed for smart contract developement

- All facets must use the same `LibVaipakam.Storage` layout through the fixed diamond storage slot.
- Existing fields in the shared diamond storage layout must never be reordered or removed.
- New shared storage fields must only be appended at the end of the storage struct or other shared storage layouts.
- Proxy-style `__gap` arrays are not required inside the main diamond storage struct for this architecture; upgrade safety depends on disciplined append-only evolution of the shared diamond storage layout.
- The append-only rule is enforced by the repository, not left to review. Every change is compared against the storage layout it replaces: every namespaced storage area of the Diamond, every upgradeable (UUPS) implementation behind a proxy, and the library storage areas those implementations keep their state in. A change fails if any field the previous layout placed somewhere is no longer at that place, with that type and that name. A struct nested inside the layout follows the same rule. It may grow only where nothing follows it, or where it is the value of a mapping. An array of structs may never change its element size. Enum members may only be added at the end. A namespace's storage position may never change.
- A field may be renamed only by declaring the rename, which states that the field kept its place and its meaning. A field given a new meaning under a new name is a break, not a rename.
- A deliberate break must be acknowledged against the exact previous layout it was measured on. It means no live contract may be upgraded in place across that change; such a chain gets a fresh deploy. An acknowledgement never lets an in-place upgrade through.
- Each deployed chain keeps a record of the storage layout its code was deployed or last upgraded with. An in-place upgrade of a chain is refused, before anything is sent, unless the new code keeps every fact in that chain's record; a chain with no record is refused, because the layout it runs is unknown. Declared renames apply to this check and acknowledgements never do. The record is bound to the deployment it describes: an upgrade is also refused when any of the chain's code the record covers (the Diamond and every upgradeable contract it runs alongside) has changed since its record was written, so a record that another upgrade left out of date is never trusted. A fresh deploy and every completed in-place upgrade rewrite the chain's record. Two upgrades of one chain must not run at the same time, because both could pass before either lands.
- A storage area or upgradeable implementation that the check does not list fails the check, and so does code that reads a listed storage area as a different structure. A facet that declares an ordinary state variable also fails it, because such a variable writes to the Diamond's own low slots.
- Reentrancy protection in the diamond should use a shared guard state stored in common diamond storage rather than separate facet-local guard state.
- Cross-facet internal execution paths must be designed so intended `address(this)` / cross-facet calls do not fail due to false-positive reentrancy checks, while still preserving a single global reentrancy lock for true external-entry protection.

## Historical development reminders

## Other Notes:

- Keep governance, partial loan, flexible interest for later development (for phase 2) and complete other features first.
- Follow the coding standards, style conventions and develop code by following best practices approach and with proper nat comments
- Use Foundry for testing/fuzzing. Slither/Mythril for audits. Optimize: Batch claims, minimal storage.

## Legacy reward calculation notation

Exact daily reward formula:

```solidity
rawReward = (1/2) * (userDailyInterestNumeraire / totalDailyInterestNumeraire)
            * currentAnnualRate
            * (1/365)
            * 23_000_000
```

Per-user interaction reward cap:

```solidity
userRewardCap = eligibleUserInterestETHEquivalent * 500

finalReward = min(rawReward, userRewardCap)
```

## Tokenomics implementation and historical acceptance instructions

## 12. Implementation Requirements

Architecture requirements:

- integrate with the existing Diamond pattern
- keep tokenomics logic primarily in `TreasuryFacet` plus a new lightweight `VPFITokenFacet`
- keep the token contract itself in `contracts/src/token/`

Coding standards:

- full NatSpec on every new function
- use `ReentrancyGuard` and `Pausable` where appropriate
- use project-standard custom errors via `IVaipakamErrors`
- emit events for every mint, claim, buyback, discount-sensitive action where relevant, and every rate change
- prioritize gas efficiency and reuse shared protocol libraries where it makes sense, including `LibVaipakam`, existing oracle logic, and shared accounting helpers
- protect all new VPFI purchase, vault deposit, fee deduction, and treasury-receipt functions with the project-standard reentrancy guard and global pausable mechanism unless the function is a pure/view helper
- every public or external function added for VPFI purchase, vault deposit, fee deduction, or treasury receipt must have NatSpec that describes the fee source, custody behavior, and settlement outcome

Storage and event requirements:

- track the **Full-tariff** state — the per-loan notional `cStar` + reward-haircut snapshot, per-party `tariffPaid` / `loanSideRewardPaidVpfi`, and the recycle-bucket credit — and emit the `credit(FullTariff, …)` / `VpfiRecycled` event on the tariff pull
- the lending-asset LIF (HoldOnly / None) moves no VPFI and needs no custody state. There is no borrower-LIF custody, rebate, or forfeit state and no such event: that path was removed in #1980 (§6b), and its per-loan record keeps its storage position only, marked retired
- emit vault-deposit and treasury-receipt events in the relevant facets

Testing requirements:

> **Borrower LIF tests (#1980).** The borrower model is HoldOnly / Full
> (§6b). The peg-custody tests that once covered an up-front VPFI LIF, a
> rebate on proper close and a forfeit on default were removed with that
> path; nothing below asks for them, and no implementation may rebuild the
> path to satisfy an older copy of this list.

- extend the existing scenario tests
- extend invariant coverage
- include supply-cap enforcement tests
- include cross-chain token and messenger configuration tests where practical
- include reward-accounting and vesting tests
- include buyback-routing tests
- include explicit wallet-to-vault deposit tests for both Permit2 and classic approve-plus-deposit paths
- include liquid-asset borrower LIF tests across every discount tier, proving the HoldOnly reduction is charged in the lending asset and moves no VPFI
- include effective-tier borrower discount tests at acceptance for min-history pending, last-minute top-up, withdraw-down, mirror-cache stale, and governance-tier-version-change cases
- include illiquid-asset fallback tests where the borrower pays the normal lending-asset LIF
- include Full-tariff tests proving each opted-in party's `C*` is credited to the recycle bucket at initiation and is refunded on no outcome
- include normal repayment, borrower preclose, refinance, default, and HF-liquidation tests proving that no loan takes VPFI into protocol custody for its LIF and that no close pays a borrower VPFI rebate or forfeits borrower VPFI
- include tests that vault-held VPFI updates fee-discount accrual without being counted as collateral

Frontend integration requirements:

> **Borrower LIF copy (#1980).** The borrower model is HoldOnly / Full
> (§6b): HoldOnly charges the LIF in the **lending asset** (no VPFI moved),
> and Full is an optional, non-refundable native-VPFI **tariff** with no
> rebate. No copy tells a borrower they pay the LIF in VPFI, that VPFI is
> held for the loan, or that a rebate follows. (The full copy treatment ships
> with the M2 frontend card #1355.)

- Phase 1 frontend requirements should focus on token-address transparency, supply
  visibility, mint/cap visibility where exposed, fee-discount status, and clear
  separation between the cross-chain VPFI token and the single-chain core protocol
- `Dashboard` should surface the shared fee-discount consent control for vaulted
  VPFI usage and may summarize interaction rewards, but it should not show a
  staking-yield stream
- the VPFI tier / discount-status table should live on the connected-app VPFI
  vault page near the deposit / withdraw decision, while Dashboard remains the
  home for the fee-discount consent toggle
- protocol-config-dependent UI copy should read live values from the Diamond
  wherever possible, including mutable config from `getProtocolConfigBundle()`
  and compile-time constants exposed through `getProtocolConstants()`
- tier tables, rental buffer displays, max slippage, treasury fee, LIF, and
  minimum Health Factor copy should use live config placeholders instead of
  hardcoded locale text
- VPFI tier thresholds returned in base units should be converted through shared
  token-display helpers before they appear in tier tables, consent copy, or
  tooltip placeholders
- the connected-app VPFI page should let users deposit externally acquired VPFI
  into their Vaipakam Vault, withdraw free protocol-tracked VPFI, inspect raw and
  effective discount-tier state, and understand mirror-cache freshness
- the page must not present a Vaipakam fixed-rate buy form, sale allowance, sale
  cap, staking APR, or staking-reward claim
- the deposit step should prefer Permit2 where supported, fall back cleanly to
  classic approval, and explain that Permit2 is optional convenience rather than
  a replacement for token-level allowance control
- transaction review for depositing / withdrawing VPFI and accepting a loan
  should include the standard transaction-preview surface
  where available and fail soft if preview is unavailable
- borrower-facing pages should show current protocol-tracked VPFI balance,
  current tier, discount eligibility for liquid assets, and whether the current
  chain is using canonical or mirror-cached tier data
- `Create Offer` and `Loan Details` may provide clear entry points into the VPFI
  vault page when fee-discount utility is relevant
- `Offer Book` accept-review copy should explain that the borrower's LIF is
  charged in the lending asset at acceptance, reduced by their effective tier
  discount, and that the borrower receives the principal net of that fee
- `Create Offer` borrower-tip copy should frame the benefit as a reduced Loan
  Initiation Fee at acceptance, never as a later VPFI rebate
- `Claim Center` should host platform-interaction reward claims, including
  lifetime claimed and contributing-loan context
- `Claim Center` should treat the chain as authoritative for per-loan claimability.
  Indexed claim rows are discovery hints only: before showing a claim action as
  available, the app should confirm that the connected wallet is the current
  holder of the relevant position NFT and that the loan side has an unclaimed
  payout. Candidate discovery should include both indexed wallet loans and
  on-chain position ownership, so a secondary-market buyer who was never an
  original loan party can still discover and claim their position proceeds.

Acceptance criteria:

- users can deposit externally acquired VPFI into their Vaipakam Vault and later
  withdraw only the free, protocol-tracked portion
- the connected app does not expose a protocol fixed-rate VPFI purchase flow or
  staking-yield claim path
- eligible liquid-asset loan acceptance checks liquidity, fee-discount consent,
  and effective-tier availability, charges the LIF in the lending asset reduced
  by the borrower's discount (HoldOnly), takes a confirmed Full opt-in's `C*`
  tariff into the recycle bucket (non-refundable), and delivers the principal
  net of the fee. No loan takes VPFI into protocol custody for its LIF
- no proper close, default, or HF-based liquidation pays a borrower VPFI rebate
  or forfeits borrower VPFI
- event transparency, NatSpec coverage, and Diamond storage compatibility are
  satisfied

---

## Analytics implementation preferences

Implementation requirements:

- follow existing frontend conventions, theme handling, and shared mode handling
- use `ThemeContext.tsx` and `ModeContext.tsx` for theme and Basic / Advanced presentation behavior
- prefer `useDiamond.ts`, multicall utilities, and existing formatting helpers such as `lib/format.ts`
- existing token metadata and market-data helpers may be reused where they help with labels or presentation, but the protocol metrics themselves must remain on-chain derived
- preferred new hooks are `useProtocolStats.ts`, `useTVL.ts`, `useUserStats.ts`, and `useHistoricalData.ts`
- public analytics queries should use caching with approximately `30` seconds of stale time
- loading and error states should follow the product patterns already used in pages such as `Dashboard.tsx` and `OfferBook.tsx`
- the page should be mobile-first and remain usable on both small and large screens
- charting should stay lightweight and consistent with the rest of the frontend stack

## Lender entitlement implementation findings

- the bump is honored on the **primary** lender-yield settlement paths (terminal repay, preclose direct close, refinance, auto-lifecycle held by the recorded lender) and on the **swap-to-repay** paths (full close-out, partial, and the Fusion swap-to-repay intent fill). On the paths that do not consolidate the lender to the current position-NFT holder — swap-to-repay-partial, the intent fill, and the secondary paths still pending below — the discount is keyed on the **current holder**, since the hold-tier discount is an instantaneous per-address read and the Full `+10%` is loan-scoped. Of the paths once listed as pending, five now honor it: preclose obligation-transfer, preclose offset, **partial repay**, **periodic-interest** (its ordinary leg), and the **auto-lifecycle transferred-position** case each resolve the lender's eligibility the same way, keyed on the settling party.

**The collateral-sale terminals ARE inside the rule since #2740, and do not
honor it yet.** A prepay or parallel collateral sale that closes the loan now
owes what a full repayment owes and splits it the same way
(`LibCollateralSettlement.saleLegs`): the treasury leg is the ordinary cut OF
the lender's interest and late fee, and the lender receives the rest. So the
lender bears the yield fee there exactly as on a repayment, and §F2's "at every
lender-yield settlement" reaches these terminals. Neither honors the discount:
the loan-keyed listing pays its treasury leg to the treasury directly inside the
marketplace fill, and the parallel-sale settlement pays it with no eligibility
call. (The swap-to-repay intent fill, the third sale-shaped close, already
resolves it through the host.)

An earlier revision of this section excluded these terminals on the ground that
the lender did not bear the fee, which was then true: the sale legs paid the
lender its whole interest and added the treasury leg on top, out of the
borrower's remainder. #2740 removed that charge-on-top because it made a sale
cost the borrower more than repaying, and with it the ground for the exclusion.

Delivering the discount on the loan-keyed listing is not a resolver call: the
treasury leg leaves inside the marketplace fill, before any Diamond code can
shift it, so the order shape has to change (for example, routing that leg
through the Diamond's settlement hook). That is a design step, and it is a
third family on the cut-over blocker below, tracked with the parallel-sale
settlement in #2876.

**Refinance is a separate case and is NOT safe.** It honors the stamp, but resolves it against the STORED lender rather than the current position-NFT holder. It attempts a Tier-2 consolidation first — and that consolidation is skip-not-block, declining rather than reverting for a sanctioned holder or an excluded lender state — so on a transferred position the stored field can still be stale when the resolve runs. With the peg configured, the previous lender's vault funds a discount the buyer receives. Refinance therefore belongs in the current-holder blocker below, not in the list above. **Rental-prepay is no longer a blocker and never could have been** — a rental cannot carry the paid Full stamp at all, because the tariff is charged only on ERC-20 originations and a rental pays no loan-initiation fee to be tariffed alongside. There is no rental lender who paid `C*` and could be owed the bump.

What IS outstanding is the **recovery** set, and it has **five** entry points: **time-based default**, **liquidation**, **discounted liquidation** (a separately gated entry, easily missed because it sits beside the ordinary one), **split liquidation**, and **partial liquidation** — which does not end the loan at all, it keeps it Active and takes a cut from the interest it recovers on the way. Each of these takes the ordinary treasury cut on recovered lender interest through `LibEntitlement.splitTreasury`, and none of the three facets hosting them contains a single eligibility or resolver call, so a Full lender who paid `C*` receives no `+10%` on that interest.

**The periodic-interest auto-liquidation leg is NOT one of them, and an earlier revision of this section wrongly counted it as a sixth.** `RepayPeriodicFacet._autoLiquidatePeriodShortfall` sells collateral to cover an overdue period and deducts a **liquidation handling fee taken as a percentage of total swap proceeds** — not a yield fee on interest. It never calls `splitTreasury` and never computes `interest × effectiveTreasuryFeeBps`. There is therefore no lender yield fee on that path for the Full bump to reduce: requiring one would either discount an unrelated liquidation-service fee or introduce a yield fee the path does not charge, and either would need an owner decision widening §F2, not a bug fix. The leg was miscounted because the *facet* around it does honor the stamp on its ordinary daily-deduction leg — the same shape that made it easy to miss in the other direction.

**This is a CODE DIVERGENCE from a frozen decision, not an open question.** The rev-8 §F2 statement (`VpfiAbsorptionDistributionFormulaRedesign.md` → `### F2 — Lender yield fee`, the frozen source; this document has no §F2 of its own) is *"at every lender-yield settlement"*, and the PR-6 requirements forbid settlement math that ignores Full; the four-item enumeration above is a list of the paths that were implemented, not a definition of where the entitlement applies. Recovered interest is lender interest — this section itself has the ordinary yield-fee cut taken from it — so the recovery paths are inside the frozen rule and are simply not honoring it yet. Recording them as an "intended exclusion" would silently narrow a ratified product decision, and only the owner can do that.

> **IMPLEMENTED IN THE TREE (#1383), except family 3, which #2740 added and #2876 tracks.** Everything else the criterion below asks for is now written: all five recovery entry points resolve the discount through `LibLenderYieldFeeHost`, refinance is re-keyed, and partial liquidation's payout pays the current holder. **That is not the same as discharged.** The cut-over gate is about what is LIVE ON A GIVEN DIAMOND, and this fix has not been deployed anywhere — the criterion stands as the thing to verify by readback, per the GovernanceRunbook's M7 Step 1. Two coverage limits worth stating: the automated tests cover the payout re-key and the discount mechanism on the ordinary liquidation path (both mutation-verified); the other four entry points, the refinance re-key and the rental leg share that same helper but have no test of their own yet.

**The divergence is the remaining hard blocker on the `feeEntitlementEnabled` cut-over,** and it is discharged only by clearing **three independent families**:

  1. **the five recovery entry points** must honor the bump on recovered lender interest;
  2. **refinance** must be re-keyed onto the current holder — its defect is that the wrong party is debited, which is independent of whether recovered interest is entitled at all;
  3. **the two collateral-sale terminals** (the loan-keyed listing and the parallel-sale settlement) must honor the discount on the interest share the lender now bears there (#2740, #2876).

**Partial liquidation carries a SECOND, larger defect that fixing the resolver does not touch,** and the criterion requires that too. `RiskFacet.triggerPartialLiquidation` deposits the whole recovered lender share into the lender recorded in the loan's vault (`:1216`) and **deliberately writes no the loan’s lender-claim record** (`:1210`) — the comment records the reason: claims are reserved for terminal events, and this path leaves the loan Active. Every other recovery entry pairs its deposit with a claim record (`RiskFacet:845` / `:1550`, `RiskSplitLiquidationFacet:296`, `DefaultedFacet:514` / `:729`), and `ClaimFacet.claimAsLender` is `ownerOf`-gated, so on those paths the current holder is who is ultimately paid. Partial has no such route. On a transferred position where the skip-not-block consolidation declined, the previous lender receives **the payment itself**, permanently, and the current holder has nothing to claim against. Discharging #1947 therefore requires the partial-liquidation payout to be keyed on — or safely parked for — the current lender-position NFT holder, not only its discount resolver. A fix that satisfies the resolver requirement alone leaves a fund-loss path open.

Every resolver must key on the **current position-NFT holder** (the current lender-position NFT holder), not the stored lender. Every recovery entry attempts a Tier-2 consolidation, and that consolidation is deliberately *skip-not-block*: it declines rather than reverting for a sanctioned holder or an excluded lender state, leaving the stored field stale. A resolver keyed on the stored lender would then price the previous lender's hold tier and, once the peg is set, debit that party's VPFI vault for a discount the current holder receives — the exact defect the repayment-path sweep was corrected for.

**An owner decision that recovered interest is out of scope discharges family (1) ONLY** — and only as an explicit superseding decision recorded against the frozen §F2 in `VpfiAbsorptionDistributionFormulaRedesign.md` first, with the enumeration above amended to match. It cannot reach (2), whose defect is that the wrong party is debited and which must be fixed or separately superseded whatever is decided about recovery. **Nor can it reach the partial-liquidation PAYOUT re-key above**, even though partial liquidation sits inside family (1): that defect is misrouted principal and interest, not a yield-fee discount, so a decision about whether recovered interest earns the Full bump has no bearing on it. It survives any supersession of family (1) and remains an obligation. What must not happen is enabling Full while a lender's entitlement depends on how their loan happened to end

## Additional implementation references separated from behavior

From ProjectDetailsREADME.md:

- **Metadata Updates:** The NFT metadata (specifically the status and potentially the image URL pointer) is updated by authorized smart contract roles (e.g., `VaipakamOfferManagement.sol`) when an offer or loan state changes (e.g., accepted, cancelled).

From ProjectDetailsREADME.md:

- **CCIP Deploy and Wire Flow:** Cross-chain deployment should be split into a per-chain deploy pass and a deliberate topology-wiring pass. The deploy pass creates the local messenger, token pool, rate-limit governor, reward messenger, according to the chain's own identity. The wiring pass should run only after all participating chains have deployment artifacts, then configure chain selectors, remote messengers, reward channels, token-pool rate limits, and Cross-Chain Token registration from those artifacts.

From ProjectDetailsREADME.md:

- **ABI Completeness Gate:** Consumer-facing ABI exports must be complete as well as current. Pre-deploy checks should fail when a required frontend ABI is missing entirely, and should warn for any missing separately deployed keeper-bot ABI according to the keeper deployment policy.

From ProjectDetailsREADME.md:

- **Fresh Redeploy Guardrails:** If `addresses.json` already contains a Diamond for a chain, contract deployment phases should refuse by default. Testnet redeploys may proceed only with `--fresh`; mainnet redeploys require both `--fresh` and an explicit mainnet-purge confirmation flag. Before wiping live deployment state, scripts should archive prior `addresses.json`, `deployment_source.json`, `.markers/`, `.history/`, and rehearsal sidecars into a timestamped `.archive/` folder for forensics. Before archiving a prior Diamond, scripts must read active-offer and active-loan counts and refuse if either is non-zero unless the operator passes an explicit orphan-state confirmation flag. Mainnet bypass requires the fresh flag, the mainnet purge confirmation, and the orphan-state confirmation because off-chain artifact replacement cannot erase prior on-chain state. Fresh testnet deploy flows should purge the active chain's D1 rows even if the previous `addresses.json` was already archived, so stale rows from a prior Diamond cannot pollute the new rehearsal.

From ProjectDetailsREADME.md:

- **BNB Testnet Gas Policy:** BNB Smart Chain Testnet forge deployments should pass an explicit gas price (currently at least `5gwei`) and keep a nonce-replacement recovery path ready, because forge auto-detection has returned 1 wei gas in prior deploys and the network silently dropped those transactions.

From ProjectDetailsREADME.md:

- the preferred implementation is to add lightweight public view helpers to existing facets where possible

From ProjectDetailsREADME.md:

- if a later phase needs a dedicated analytics-oriented facet, that surface should remain minimal, read-only, and composable

From ProjectDetailsREADME.md:

- the indexer event decoder should be generated from the compiler-emitted Diamond ABI bundle, deduped by canonical event signature, rather than maintained as hand-written `parseAbi` event strings. This prevents topic drift when contract events add fields or move between facets.

From ProjectDetailsREADME.md:

- the indexer should fetch raw address-filtered logs and decode them locally against the generated event ABI when provider topic-OR limits make large event allow-lists unreliable.

From ProjectDetailsREADME.md:

- CI should include an event-coverage guardrail that fails when a contract event tagged as a loan or offer state mutation has neither an indexer handler nor an explicit allow-list reason. The indexer is a projection of on-chain state, so new state-changing events must be wired or consciously excluded.

From ProjectDetailsREADME.md:

- **Generated Contract Documentation:** Public NatSpec documentation must describe the current Chainlink CCIP cross-chain architecture and avoid stale LayerZero / OApp wording. If generated public docs are known to be materially stale during a migration, the published site should visibly warn readers until the wording is corrected, and that warning should be retired once the docs are current.

From ProjectDetailsREADME.md:

- **Phase-Based Deploy Ceremony:** `deploy-testnet.sh` should mirror `deploy-mainnet.sh` phase-for-phase so rehearsals exercise the same operator flow: preflight, contracts, mocks where applicable, CCIP lane / pool configuration, Diamond configure spell, handover, ABI sync, verification, and per-surface Cloudflare deploys. Testnet may additionally expose a `pause-rehearsal` phase; mainnet pause flows must remain standalone incident-response scripts, not ordinary deploy side effects.

From ProjectDetailsREADME.md:

- **Pause Runbooks:** Production incident response should use a standalone `pause-all-chains.sh` or equivalent that prints Diamond and cross-chain-surface pause calldata for every deployed chain, records a timestamp for the five-minute response budget, supports state verification, and can print unpause calldata for cleanup. Mainnet unpause still routes through the Timelock-controlled unpauser path.

From ProjectDetailsREADME.md:

- **ABI Export Phase:** Deploy scripts should export frontend, keeper-bot, and watcher ABIs after contract builds and before frontend / worker deployment so all consumer bundles decode the currently deployed contract surface.

From ProjectDetailsREADME.md:

- **Operations Export Phase:** Deploy scripts should export the alert presets and CCIP watcher secret snippets from the same deployment artifacts used by the apps. These exports prevent monitoring and cross-chain watcher configuration from drifting away from the deployed Diamond, messenger, token-pool, and adapter addresses. (The reference subgraph's export was removed with the subgraph in #2337; the indexer reads the same deployment bundle as the apps.)

From ProjectDetailsREADME.md:

- **Tenderly Operations Setup:** Tenderly project configuration should live under `ops/tenderly/` with the account / project identifiers its alert presets need (`tenderly alerts apply`; the repository carries no Tenderly Web3 Actions since #2869). Contract tracking should not depend on unsupported bulk REST imports by address; contracts may auto-import from live traffic or be added individually through Tenderly's UI when first-traffic visibility is needed.

From ProjectDetailsREADME.md:

- **Chain-Agnostic Flow Sweeps:** Testnet validation should prefer chain-agnostic flow wrappers for positive, partial-midpoint, and negative sweeps once selectors are stable. Legacy chain-specific scripts may remain as building blocks, but the runbook should direct ordinary post-deploy sweeps through the wrappers.

From ProjectDetailsREADME.md:

- **Smart Contract Interaction:** The tool will directly query the `VaipakamNFT.sol` contract's public view functions (like `tokenURI` and other specific getters for loan/offer data linked to an NFT) to fetch and display the on-chain data.

From WebsiteReadme.md:

- bot ABI files should be generated from the monorepo contract surface rather than maintained as hand-written selector strings

From WebsiteReadme.md:

- the React i18n binding should re-render when a lazy-loaded locale bundle is added, so the first language-picker click visibly changes language after the dynamic import resolves

## Subsequent collateral-sale decision

The direct-recipient marketplace model quoted below is superseded by the
owner's one-proceeds-leg decision in #2916, merged while #2958 was under review.
The current functional spec records the platform-received proceeds and
repayment-equivalent settlement. The following text from the earlier spec is
retained only as history, not as a current settlement requirement:

- A marketplace sale of the collateral is paid by the buyer straight to its recipients, so the listing checks the arrival itself. The share the platform records as paid (the lender's share in a sale of a loan's collateral, on which the loan closes as repaid, and the platform's proceeds in a sale of an offer's collateral, which it credits onward) must reach its recipient in full, or the whole sale is refused and the buyer's payment never leaves the buyer. The other shares record nobody as paid: the treasury's share is a fee its recipient bears a token's charge on, the borrower's share is the seller's own remainder, and the marketplace and royalty fees the seller agreed to go to third parties. A lender who buys the collateral of their own loan by filling that listing on its own pays their own share to themselves, which is complete as it stands. In a purchase that combines several orders (a listing matched against a bid, or a batch of listings) the account that submits the purchase need not be the one paying, so the share is measured there whoever submitted it; a lender who pays their own listing inside such a purchase is refused, and buys the collateral by filling the listing on its own instead. When one purchase covers several listings, each listing is measured against its own share of what arrived, and what one listing's settlement pays onward is never counted as another listing's arrival.

## Dashboard coding and build guidance

From WebsiteReadme.md, separated from its functional quality requirements:

Coding and quality requirements:

- new dashboard code should follow TypeScript strict mode
- frontend verification should use `tsc -b --force` for production-build parity because Cloudflare Pages runs the project build graph rather than only isolated no-emit checks
- new hooks and components should include clear JSDoc comments
- errors should use the existing contract-error decoding approach where relevant
- production code should not leave debug browser console output statements behind
- interactive controls and charts should remain accessible, including sensible ARIA labeling where needed
- the page should include appropriate SEO-friendly metadata because it is a public transparency surface

## Reward compatibility material retired in the October 22–27 consolidation

These paragraphs preserve the historical containers of superseded wire
descriptions. Their shared epoch-accounting requirements remain active in
[the functional spec](../FunctionalSpecs/TokenomicsTechSpec.md), including
arrival ordering, release authority, parked-balance conservation, classified-out
totals, and rejection of unknown delivery IDs. Only the retired compatibility
paths are superseded; this archive does not withdraw the shared requirements.
The October 23, 26, and 27 release decisions require fresh deployments,
current rooted deliveries, exact delivery splits, and no compensation
migration arming. Their historical text remains here so the evidence is
retained without leaving contradictory instructions in the functional spec.

- **legacy migration (activation precondition)**: a pre-P2 manual remit carried no per-side split, so an upgraded mirror could hold its value without a priced compensation. An operator-evidenced stamp allocates such a receipt pro-rata over the day's completed quote (one receipt, one day; the operator verifies the receipt↔day binding against the canonical chain's reservation record), and a paginated canonical-side inventory lists legacy-shaped reservations — the terminals' arming checklist requires it to read empty
- a delivery is counted only when **it states its own new-versus-recycled composition**, and is otherwise recorded as *uncounted* rather than discarded. Older delivery formats never carried that split, and on those a zero recycled portion means "not stated", not "none". Only the receiving component knows which format arrived, so it — not the accounting — decides, and for a format that cannot say, the answer is **none is new**. (#1566 closure 2 retired the second condition this clause used to carry — that every day the delivery covers be at or after the chain's switch into the coordinated mode — together with the rule that refused a straddling day range whole. Which days a delivery funds no longer decides whether its new portion is counted, because the paid side charges every payout the same way; the uncounted total is still published beside the counted one, so an unstated composition stays visible rather than silent.)
- **a mirror's untyped packet can be told its source's recorded split, and every arrival commits to the days it names** (#1566 transport epochs, first change) *(Superseded for deliveries by the pre-d6 retirement bullet below, owner decision 2026-10-22: no old-wire delivery can land, so this describes no reachable state.)*: the canonical chain can send, for any remittance it issued, the split it recorded when it sent — the fresh and the recycled figure — toward the chain that remittance went to; anyone may ask it to and pays the transport fee, quoted beforehand, and the content is the chain's own record. The mirror that received that remittance without a split on its wire keeps both figures once and unchanged, each scaled to what actually landed in the same proportion, so a short delivery shrinks both and never leaves one larger than the whole; it refuses a packet whose wire carried its split, a receipt whose delivery came from another chain, a receipt that predates packet stamping, an empty split, and a second attestation that DISAGREES with the first — while a second attestation saying the same thing is accepted and changes nothing, since asking again is how a sender handles a delivery it cannot confirm and the transport fee is paid either way; every refusal is re-executable. Only a remittance that carried its identity on the wire can be attested: the oldest wire shape has no receipt and no reservation behind it, so its fresh component stays unauthenticated for good and it classifies recycled or leaves untyped. **What a classification may treat as evidence is worked out from the kept figures when it is asked, never frozen in advance**: attesting a packet's split and PARKING what its obligations left are both open to anyone and can happen in either order, and a figure frozen before the attestation arrived would read as no evidence for ever. (The release is not one act: parking is the open half, and the acknowledgment that completes it is the administrator's — see the next bullet. What this rule needs is only that neither open step has to wait for the other.) **Until a packet's epoch is released, nothing of that packet classifies at all** — not recycled, not fresh. The gate refuses a packet that holds an unreleased epoch *before* it ever reaches the fresh-versus-recycled question, so "classifies recycled only" would overstate what is available to it. And in this change the release step is **offered to nobody** (see the next bullet: neither of its two steps ships until per-day obligation tracking lands, owner decision #2258). So for as long as that holds, a packet holding an epoch is **wholly unclassifiable**, and its value stays in the membership-bound holding — visible in the ledger, spendable by no one, lost by no one. This is a step the platform deliberately lacks, not a condition a packet passes. A packet that holds **no** epoch is untouched by any of it and classifies exactly as it did before, its fresh side still bounded by the evidence rule just stated. Every arrival on a wire before the next wire version also commits, with the packet and in the same transaction, to a fingerprint of the days it names and their count — what the release step will check a re-supplied list against, so no packet is ever admitted on the strength of an event. The mirror-side delivery entries live on their own facet, reached by the same identifiers and refreshed together with the remittance facet.
- **an old-wire delivery is spendable only by the days it named, and only after its epoch is closed out** (#1566 transport epochs, second change) *(Superseded for deliveries by the pre-d6 retirement bullet below, owner decision 2026-10-22: no old-wire delivery can land, so this describes no reachable state.)*: a reward budget arriving on a wire that carried no split is one figure over many days, so the platform gives it its own balance — bounded by what actually landed, never by what was declared — and treats the days it listed as a filter over that balance. Only an obligation falling on one of those days may ever draw from it. A delivery whose wire DID carry the split takes no such balance: its components were credited to the shared ledgers on arrival, and a second home for the same value would let one delivery be spent twice. Which of the two a delivery is is stated by the receiving contract, the only party that sees the wire it came off — by the time the figures reach the chain's own books, a wholly-recycled delivery on the current wire and a legacy delivery that stated nothing are indistinguishable. **A delivery that takes such a balance is never also one a quarantined compensation can be returned out of**: the return home is the one other way a delivery's protected value leaves without being classified, and it does not consult the balance, so the two touching one delivery would leave that balance promising days more than the delivery still holds. They cannot, because only a compensation arrival is ever returnable and a compensation always states its whole amount as one component — which is exactly the shape that takes no balance. The guarantee rests on that choice of component at arrival rather than on anything the balance itself checks, so it is stated here as a property the arrival rules must keep.
  Each day keeps the deliveries that list it, with a record of how far through them its funding has been consumed, because the older lane can produce arbitrarily many small deliveries naming one day and anything obliged to walk all of them would eventually exceed a block. **The list is kept in the order the deliveries ARRIVED, whoever writes it and whenever**: writing the list is open to anyone and happens after the fact — a delivery admitted retrospectively (below) landed long before it was written down — so a delivery takes its place by its OWN RECORDED ARRIVAL, fixed when it landed and never rewritten, which the list reports alongside it; two deliveries that landed in the same block report the same arrival and take a fixed order by delivery identity. A delivery written down only after the day's consumption has passed the place its arrival would give it takes the first unconsumed place instead, so it is never behind the day's record of consumption (the third change, below, states the draws and the order they spend in). For the same reason the sending side refuses to build a remittance naming more days than the destination can retire at once; a message already sent is accepted regardless, since refusing it would refuse the same message on every retry, and such a delivery is instead admitted on its total and its day-list fingerprint alone, its membership written in bounded instalments each checked against that fingerprint.
  What remains of an old-wire delivery becomes available for reconciliation only after TWO recorded steps — **and neither step is offered until the change that tracks obligations per day lands**, because the platform must refuse to close out a delivery while any obligation on a listed day is unsettled, and cannot test that before then (owner decision, #2258). Until that change an epoch's value stays in its membership-bound holding and cannot be reconciled early by anyone. The two steps: the remainder is parked under the delivery's own key, keeping the membership that binds it, and then acknowledged. Both are required, so draining an epoch is not by itself a way to make its delivery reconcilable, and a late obligation whose day is in the parked membership is funded from what was parked rather than from a general pool it has no claim on. **Each reconciliation draws the parked figure down by what it takes**, so that figure always states what is still parked rather than what was once set aside, and nothing can be reconciled beyond it. **The record also states, separately and cumulatively, how much has been reconciled OUT of the remainder** — a remainder parked at ten and reconciled for four holds six, and six alone cannot be told from a delivery that only ever parked six; stating both is what lets any reader check that a delivery's opening figure still equals what it holds plus what has left it, rather than infer the difference. **A reward remittance and every view that describes one derive their figures from ONE plan**: the fee quote refuses exactly the lists the send refuses, and the discovery views report per day exactly what the send would fund — a quote can never price a batch the send would reject. The discovery view stays tolerant (a day that cannot be remitted reads as zero) and does not itself claim the whole list is sendable; a remittance funds at most thirty-two days. **A reading about a delivery the ledger has no record of is REFUSED rather than answered with zeros.** What a delivery's transport legs have spent, and what it has parked, are half of the evidence a close-out's ceiling is read from, and a real delivery that has spent and parked nothing legitimately reports zeros — so returning those same zeros for an identifier the ledger never opened would present an unrecognised identifier as substantiated evidence that nothing had been drawn. Exactly one reading is exempt and must stay answerable on an unknown identifier: the one reporting a delivery's epoch as a whole, since that is how a reader ASKS whether the ledger knows an identifier at all. **The gate asks whether an epoch is OWED, not merely whether one exists.** A delivery that predates the day-list fingerprint holds no epoch and never can — there is no membership an epoch could bind to — so it stays reconcilable as it always was. That boundary is the fingerprint and not the ledger's own start date, which is a wider population and the mistake this rule exists to avoid; a delivery the retrospective admission below would still accept holds none only until somebody brings it in, and reconciling it first would spend — with no close-out and nothing drawn down — exactly the value its own listed days are entitled to reach. The two are decided by the same test the retrospective admission itself applies, so they can never answer differently: a delivery that admission would accept must be brought in and closed out before it may be reconciled, and the refusal names the step that is missing; a delivery it would refuse can never hold an epoch and is reconcilable as before.
  **The two steps are open to different parties, because they are different acts.** PARKING is mechanical and anyone may do it: it moves a delivery's own remainder into a holding of the same delivery, under the same membership, and nothing becomes spendable that was not spendable before. THE ACKNOWLEDGMENT IS AN OPERATOR DECISION, and it is restricted to the operator. It is the platform choosing to stop waiting on a lane that cannot prove its own closure, and it has a consequence borne by someone else: obligations arriving afterwards for any of that delivery's listed days are refused to the extent they looked to it. That is a claim being written off on a user's behalf, it cannot be undone, and it is not the kind of decision an arbitrary caller may take. Keeping the mechanical half open is deliberate — a valid delivery's close-out must never sit waiting on whoever holds the operator role — and the split is exactly where the authority changes.
  An epoch exists only where the delivery's value has somewhere to be attributed: on a deployment whose reward custody has not been switched on, an arriving delivery's tokens rest with the platform and the switch-on is what assigns them, so such a delivery takes no epoch. Giving it one would leave two records claiming the same money.
  **A delivery that landed after the day-list fingerprint was first recorded but before this ledger existed can be brought into it, by anyone, from its own delivery record.** The fingerprint is recorded for exactly this purpose, so leaving that population outside the ledger would mean value no day could draw and no close-out gated. Balance, day-list fingerprint and day count are all read from what was written when the delivery arrived, so the caller supplies nothing the platform has not already recorded. **The caller must, however, exhibit the delivery's own day list, which is checked against that fingerprint and not stored.** This is not a permission check: it is that this call is where the delivery's opening figure is fixed permanently, and a membership nobody can produce would leave that figure describing a set nobody can enumerate. It costs a caller nothing it does not already need, since writing the membership checks the same list against the same fingerprint and there is no route to a close-out without it. (An earlier statement of this rule gave a different reason — that bringing a delivery in CLOSED its reconciliation gate, so closing had to cost what reopening cost. That is no longer how the gate works: see the next sentence but one. The reason is restated rather than left standing.) A delivery whose list does not match is refused and left exactly as it was, having lost nothing by the attempt; afterwards the delivery behaves in every respect like one arriving today, with its membership written in the same instalments and its remainder reconcilable only through the same two recorded steps. Its balance is bounded by what the delivery still holds unreconciled, which may be less than what it brought if it was reconciled before the gate read the delivery's own shape. **Whether a delivery is OWED a place in the ledger is decided by what was recorded when it arrived, never by whether anyone has yet brought it in** — bringing it in is open to anyone and therefore optional, so a delivery owed a place and a delivery owed none both read as having none. The close-out gate accordingly asks the DELIVERY: did it carry a day list, did its wire state its composition, does it still hold anything unreconciled. One that is owed a place nobody has opened is refused, and the refusal names the remedy rather than waiving the gate. **What this costs is stated rather than implied: a delivery whose day list can no longer be exhibited can no longer be reconciled.** Nothing is lost — the value stays held aside and unreconciled, and becomes reconcilable the moment the list is produced — and the alternative is reconciling value while the days that delivery named can still draw on it. Refused, each by name: a delivery that already holds an epoch, one that recorded no day list, one whose record states a component (so its wire carried the split and that value already lives in a shared ledger), and one holding nothing left to bind. One case cannot be told apart and is resolved conservatively: a delivery on a split-carrying wire so short that BOTH stated components rounded away is indistinguishable, from the record alone, from a delivery that stated nothing, and is admitted — binding it to the days its own delivery named is a stricter gate on the same money, never a second claim on it.
  No value moves on this change; the draws against an epoch are the third change, below.
- **the rooted wire is the only budget wire: the receiving chain refuses every older shape, and the machinery that existed only for older deliveries is withdrawn** (#1566 transport epochs, pre-d6 retirement — owner decision 2026-10-22, pre-live, fresh deploys only): a reward-budget delivery on any wire older than the rooted one — the bare day list, the list with a receipt, or the list with a stated split — is refused by the receiving contract, by name, before it reaches the platform, and the transport keeps it for re-execution; no current sender produces one, and every chain running these changes is a fresh deploy, so none is in flight. Because no such delivery can land, everything that existed only to bring one in is withdrawn rather than kept dormant: the canonical chain's split-attestation message and its fee quote, and the mirror's acceptance of that message (an arriving one is refused as an unknown kind); the flat-list membership writer; the flat-list proof of a delivery that holds no epoch; and the retrospective admission of a delivery from its recorded fingerprint. A rooted delivery's split is attested by its own wire on arrival, as the bullet above states. Its days land in exactly two ways, both chunk by chunk against the root: indexed into its epoch when it holds one, proven when it holds none (it arrived before custody activation). The bullets above that describe old-wire deliveries — their attestation, their flat membership and their retrospective admission — record how that population was meant to be handled and no longer describe a reachable state; the epoch, draw, staging, closure, parking and release rules they state apply unchanged to every rooted delivery. A compensation still arrives on its own wire and is unaffected.
