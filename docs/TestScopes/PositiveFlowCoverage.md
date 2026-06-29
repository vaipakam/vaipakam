# Positive Flow Coverage Catalog

This document is the test-planning source for Vaipakam positive flows. It is
intended to drive three follow-on artifacts:

- focused Foundry positive tests for every intended happy path
- user-facing E2E scenarios for Basic and Advanced mode
- chain-agnostic `contracts/script/*PositiveFlows.s.sol` scripts for deploy
  rehearsals and testnet smoke sweeps

`contracts/script/PositiveFlows.s.sol` is useful, but it is not a complete
platform-flow inventory. It currently composes the older lifecycle script with
`AnvilNewPositiveFlows.s.sol`; several current product flows are only covered by
unit tests, partial-flow scripts, frontend/indexer tests, or not yet represented
in a broadcast script. This catalog names those flows explicitly so gaps can be
closed deliberately.

## Scope And Rules

Sources of intended behavior:

- `docs/FunctionalSpecs/ProjectDetailsREADME.md`
- `docs/FunctionalSpecs/WebsiteReadme.md`
- `docs/FunctionalSpecs/TokenomicsTechSpec.md`
- `docs/FunctionalSpecs/SanctionsAndTermsGateMatrix.md`
- `docs/FunctionalSpecs/KeeperAuthorityMatrix.md`
- current user-guide copy under `apps/www/src/content/userguide/`
- existing test-scope documents under `docs/TestScopes/`

Coverage labels:

| Label | Meaning |
| --- | --- |
| `scripted` | Covered by a broadcast-style positive-flow script. |
| `unit/integration` | Covered by Foundry tests but not by an operator-positive script. |
| `partial` | Covered only as a midpoint / UI fixture. |
| `frontend/indexer` | Needs app, worker, indexer, or browser-level coverage. |
| `gap` | No clear positive coverage found; add test first, then script if scriptable. |
| `not scriptable` | Positive behavior depends on time travel, fork infra, external venue state, or off-chain services; keep in tests or purpose-built harnesses. |

Audience labels:

| Label | Meaning |
| --- | --- |
| `Basic` | Ordinary lender / borrower / renter flow that should be visible in Basic mode. |
| `Advanced` | Expert feature, risk tool, recovery tool, keeper/automation flow, or dense UX. |
| `Operator` | Admin, deploy, governance, watcher, or treasury operation. |
| `Read` | Read-only surface that must be populated by positive state but is not itself a state-changing flow. |

## Script Baseline Snapshot

Existing positive script coverage:

| Script | Current useful coverage | Known mismatch / caveat |
| --- | --- | --- |
| `contracts/script/SepoliaPositiveFlows.s.sol` | ERC-20 lender/borrower offers, third-party repay, add collateral, offer cancel, direct preclose, lender sale, illiquid collateral, ERC-721/1155 collateral, ERC-721/1155 rentals, illiquid lending combinations. | Name is legacy; still used by wrapper. Some paths skip when cancel cooldown is active. |
| `contracts/script/AnvilNewPositiveFlows.s.sol` | Partial repay, refinance, range match/partial fill, preclose options 2/3, stuck-token recovery, disown, sanctions wind-down, keeper authorization, VPFI discount deposit/withdraw, pause/unpause, treasury accrual, master-flag dormancy, lender sale. | Comments and function names still use retired `staking` / `unstake` language. It does not cover all current VPFI, auto-lifecycle, intent, periodic, swap, indexer, or cross-chain flows. |
| `contracts/script/PositiveFlows.s.sol` | Wrapper: Phase A + Phase B. | Wrapper comments overstate “every protocol surface”. Treat as smoke suite, not full catalog. |
| `contracts/script/PartialFlows.s.sol` | UI-testable midpoint states. | Important for app QA, but not terminal positive coverage. |

## Core Positive Flow Matrix

### Onboarding, Profile, Compliance, And Terms

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-001 | Basic | Connect wallet, create/get user vault on first needed action. | One per-user vault exists for the wallet on the active chain. | unit/integration | Add to bootstrap smoke if absent. |
| PF-002 | Basic | User sets country and passes allowed country-pair policy. | Country stored; normal create/accept paths proceed. | scripted via setup + gap fillers | Keep in setup assertions. |
| PF-003 | Basic | Clean user accepts current Terms before a gated action. | Terms acceptance recorded; gated action proceeds. | unit/integration | Add one scripted happy path before first create/accept. |
| PF-004 | Basic | Clean, unsanctioned wallet performs Tier-1 actions. | Offer/create/accept/deposit/claim proceed. | scripted setup + unit/integration | Keep as precondition assertions. |
| PF-005 | Basic | Sanctions fail-open behavior when oracle is unavailable for ordinary retail actions. | Ordinary action uses documented fail-open posture. | unit/integration | not scriptable unless harness toggles oracle. |
| PF-006 | Basic | KYC enforcement disabled on retail deploy; normal users can create, accept, repay, preclose, refinance, and claim. | No retail KYC blocker appears when enforcement is off. | unit/integration | Add one smoke script assertion. |
| PF-007 | Advanced | KYC enforcement enabled in test harness; Tier 0/1/2 allowed bands pass. | Values inside each tier’s limit proceed. | unit/integration | not ordinary deploy script. |

### Public, Dashboard, And Read-Only Product Surfaces

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-020 | Read | Public home, terms, privacy, docs, analytics, VPFI education, NFT verifier load without wallet. | Pages render with localized metadata and no wallet requirement. | frontend/indexer | Add app E2E, not Foundry script. |
| PF-021 | Basic | Dashboard shows wallet vault balances, VPFI wallet/vault balances, active loans, active offers, claimables, rewards summary. | All cards populate from indexed or direct reads. | partial + frontend/indexer | Needs seeded state fixture. |
| PF-022 | Advanced | Advanced mode exposes denser risk, diagnostics, NFT verifier, keepers, and recovery links while preserving context. | Mode switch does not drop user state or route context. | frontend/indexer | Add app E2E. |
| PF-023 | Read | Offer Book lists global lender offers, borrower offers, own active offers, and filters them. | Pagination/filtering works without hiding own offers incorrectly. | partial + unit/integration | Add indexer/app E2E. |
| PF-024 | Read | Loan Details shows timeline, parties, collateral/proceeds proof, interest, periodic checkpoints, caps, and claim/action bars. | Connected current holder sees correct role-gated actions. | partial + frontend/indexer | Needs scenario fixture coverage. |
| PF-025 | Read | Claim Center lists loan claims plus interaction rewards. | Claimable rows deep-link to loan details and rewards claim card. | partial + unit/integration | Add app E2E. |
| PF-026 | Read | Activity feed shows create, accept, repay, partial repay, refinance, default/liquidation, claim, sale, and reward events. | Rows link to loan/offer details and survive indexer fallback. | frontend/indexer | Add worker/app E2E. |

### Offer Creation And Management

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-040 | Basic | Lender creates single-value ERC-20 lending offer. | Principal is locked; offer NFT/row exists; offer is active. | scripted | Keep. |
| PF-041 | Basic | Borrower creates single-value ERC-20 borrower offer. | Collateral is locked; offer NFT/row exists; offer is active. | scripted | Keep. |
| PF-042 | Basic | Lender creates ERC-721 rental offer. | NFT is vault-custodied / delegated; rental offer is active. | scripted | Keep. |
| PF-043 | Basic | Lender creates ERC-1155 rental offer. | Quantity is vault-custodied / delegated; rental offer is active. | scripted | Keep. |
| PF-044 | Basic | Borrower creates NFT rental demand offer. | Prepay + buffer are locked; offer is active. | unit/integration | Add to positive script. |
| PF-045 | Basic | Creator cancels an unaccepted lender offer. | Locked principal is released; offer closes cancelled. | scripted, sometimes skipped | Add cooldown-aware deterministic script branch. |
| PF-046 | Basic | Creator cancels an unaccepted borrower offer. | Locked collateral is released; offer closes cancelled. | scripted, sometimes skipped | Add cooldown-aware deterministic script branch. |
| PF-047 | Basic | Expired offer is cancelled/cleaned up permissionlessly. | Refund routes to creator; offer closes expired/cancelled. | unit/integration | not scriptable without time control; keep unit. |
| PF-048 | Advanced | Offer is modified in place before acceptance. | Terms update without cancel/repost and locked accounting remains correct. | unit/integration | Add script if deployed surface is script-safe. |
| PF-049 | Advanced | Good-til-time offer expires naturally. | Offer no longer fillable; UI/indexer labels expiry. | unit/integration + frontend/indexer | not broadcast-script friendly. |
| PF-050 | Advanced | Signed off-chain offer is created, accepted, and nonce remains usable only as intended. | Gasless/signed offer settles into normal loan. | unit/integration | Add script once signer env exists. |
| PF-051 | Advanced | Signed offer nonce invalidation. | Future acceptance of that nonce is blocked; other nonces unaffected. | unit/integration | Not a positive loan script; keep focused test. |
| PF-052 | Advanced | Permit2 create/accept path succeeds with supported token. | Approval and action complete in one review flow. | unit/integration + fork | Add local script with mock Permit2 if valuable. |
| PF-053 | Advanced | Range lender offer with amount/rate bounds. | Offer can match within bounds and remain open after partial fill. | scripted | Keep. |
| PF-054 | Advanced | Range borrower offer with collateral/rate bounds. | Offer can match within bounds and account for remaining demand. | scripted partial | Add terminal script coverage. |
| PF-055 | Advanced | Partial fill leaves above-dust remainder. | Child loan created; parent offer remains fillable. | scripted | Keep; add child-loan assertions. |
| PF-056 | Advanced | Partial fill leaves sub-dust remainder. | Parent offer closes fully filled/dust. | scripted | Keep. |
| PF-057 | Advanced | Permissionless matcher matches compatible lender and borrower offers. | Loan opens; matcher receives configured LIF share. | scripted | Add explicit matcher-share assertion. |
| PF-058 | Advanced | Self-trade-prevention-compatible own-book behavior. | Legitimate non-self trades proceed. | unit/integration | Keep focused tests. |

### Lender Intent And Auto-Lend

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-070 | Advanced | Lender registers a standing intent with bounds and funds working capital. | Intent appears in global active feed and per-owner management view. | unit/integration | Add script. |
| PF-071 | Advanced | Lender pauses intent but leaves reserved capital. | Per-owner view still lists paused intent with reserved capital. | unit/integration | Add script. |
| PF-072 | Advanced | Lender withdraws and stops an intent. | Intent inactive and zero reserved capital; drops from per-owner view. | unit/integration | Add script. |
| PF-073 | Advanced | Solver fills borrower demand against lender intent. | One-time offer/loan opens within intent bounds. | unit/integration | Add script. |
| PF-074 | Advanced | Intent loan rolls after repayment when auto-roll/delegation is configured. | Repaid capital becomes available according to roll policy. | unit/integration | not scriptable if keeper/time heavy; add harness. |

### Loan Initiation

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-090 | Basic | Borrower accepts lender ERC-20 offer with liquid collateral and HF >= admission floor. | Principal delivered; collateral locked; loan active; both position NFTs minted. | scripted | Keep. |
| PF-091 | Basic | Lender accepts borrower ERC-20 offer. | Principal funded; borrower receives funds; loan active. | scripted | Keep. |
| PF-092 | Basic | ERC-721 collateral loan starts with illiquid collateral consent. | NFT collateral locked; loan active. | scripted | Keep. |
| PF-093 | Basic | ERC-1155 collateral loan starts with illiquid collateral consent. | Quantity locked; loan active. | scripted | Keep. |
| PF-094 | Basic | Illiquid ERC-20 collateral loan starts with both-party consent. | Illiquid collateral locked; loan active. | scripted | Keep. |
| PF-095 | Basic | Illiquid lending asset + liquid collateral loan starts with fallback disclosures. | Loan active and normal repayment path remains available. | scripted | Keep. |
| PF-096 | Basic | Illiquid lending asset + illiquid collateral loan starts with dual fallback consent. | Loan active with full-collateral default semantics. | scripted | Keep. |
| PF-097 | Advanced | Direct accept preview returns the same economics that acceptance later executes. | Review math matches accepted loan. | unit/integration | Add app/contract integration. |
| PF-098 | Advanced | Atomic accept-and-refinance tagged borrower offer. | Replacement loan opens and old loan closes in same transaction. | unit/integration | Add script; current script covers standalone refinance. |
| PF-099 | Advanced | Refinance carry-over accept path. | Old lien retags only when atomic path succeeds. | unit/integration | Add dedicated test/script if supported. |

### Repayment, Interest, And Claims

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-110 | Basic | Borrower fully repays active ERC-20 loan before grace ends. | Loan moves to repaid/claimable; lender and borrower claims recorded. | scripted | Keep. |
| PF-111 | Basic | Third party repays borrower loan. | Debt closes; claims still belong to lender/borrower position holders. | scripted | Keep. |
| PF-112 | Basic | Lender claims principal + interest after repayment. | Lender payout transfers; lender claim closes/burns as appropriate. | scripted | Keep. |
| PF-113 | Basic | Borrower claims collateral / surplus after proper close. | Borrower payout transfers; borrower claim closes/burns as appropriate. | scripted | Keep. |
| PF-114 | Advanced | Partial repay on opted-in loan. | Principal decreases; loan remains active; interest accounting remains coherent. | scripted | Keep. |
| PF-115 | Advanced | Partial repay then full close with no dust. | Loan terminal and claims exact remaining amounts. | unit/integration | Add script assertion. |
| PF-116 | Advanced | Periodic interest checkpoint settles when due. | Period interest paid, treasury/lender shares recorded, loan remains active. | unit/integration | not broadcast-script friendly without time; keep test harness. |
| PF-117 | Advanced | Periodic interest settle-first protection before refinance/default. | Overdue checkpoint is settled or blocks unsafe path according to spec. | unit/integration | not ordinary script. |
| PF-118 | Advanced | Borrower full swap-to-repay. | Collateral swaps to principal and loan closes atomically. | unit/integration | Add script with deterministic mock adapters. |
| PF-119 | Advanced | Borrower partial swap-to-repay. | Principal reduces, collateral/settlement waterfall reconciles. | unit/integration | Add script with deterministic mock adapters. |
| PF-120 | Basic | Interaction reward accrues from lending/borrowing and is claimed. | Pending reward decreases; claimed VPFI transfers locally. | unit/integration | Add positive script; current wrapper does not terminally cover current reward flow. |
| PF-121 | Basic | Claim Center handles zero-reward state. | No revert path exposed; action disabled/empty state. | frontend/indexer | app E2E. |

### NFT Rental

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-140 | Basic | ERC-721 rental offer accepted. | NFT remains vault-custodied; renter user rights set; prepay+buffer locked. | scripted | Keep. |
| PF-141 | Basic | ERC-1155 rental offer accepted. | Quantity remains vault-custodied; renter rights set; prepay+buffer locked. | scripted | Keep. |
| PF-142 | Basic | Daily rental deduction succeeds. | Lender/treasury allocation recorded; rental remains active or closes at end. | unit/integration | Add harness/script coverage for `autoDeductDaily`; current scripts only accept and close rentals. |
| PF-143 | Basic | Renter closes rental normally. | Rights reset; unused prepay/buffer returned as specified; lender can reclaim NFT. | scripted | Keep. |
| PF-144 | Basic | Rental reaches default/expiry and lender reclaims. | Rights reset; lender receives rental entitlement and NFT return path. | unit/integration | Add default-capable harness/script; current scripts do not call `triggerDefault`. |
| PF-145 | Advanced | NFT rental marketplace / prepay listing positive sale path. | Listing fill settles loan/rental and routes proceeds correctly. | unit/integration + fork | Add fork/script fixture if stable. |
| PF-146 | Advanced | Cancel active prepay listing. | Listing state cleared; loan/rental remains coherent. | unit/integration | not core positive script. |
| PF-147 | Advanced | Cancel expired prepay listing cleanup. | Stale listing marked cleanup-eligible/closed. | unit/integration | not broadcast-script friendly. |

### Collateral Management And Position NFTs

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-160 | Basic | Borrower adds collateral to active liquid loan. | HF improves; lien/accounting increases. | scripted | Keep. |
| PF-161 | Advanced | Borrower withdraws excess collateral while HF remains safe. | Free collateral leaves vault; loan remains healthy. | unit/integration | Add script. |
| PF-162 | Advanced | Collateral lien proof remains readable for live loan. | Loan Details can show liened asset/amount/owner/status. | frontend/indexer | app/indexer E2E. |
| PF-163 | Advanced | Position NFT transfer moves role authority to current holder. | Current holder sees and can execute role-gated claim/actions. | unit/integration | Add script covering transfer + claim/action. |
| PF-164 | Advanced | Current-holder consolidation before terminal close. | Claims/effects follow current holder, not original opener. | unit/integration | Add high-value scenario script. |
| PF-165 | Advanced | Locked borrower NFT cannot transfer during offset/listing, then unlocks after completion/cancel. | Transfer availability matches lock lifecycle. | unit/integration | Keep focused tests; optional script. |
| PF-166 | Read | NFT metadata/status updates through offer, active loan, claimable, closed/defaulted. | NFT verifier and wallets show coherent state. | unit/integration + frontend | Add metadata snapshot tests if absent. |

### Default, Liquidation, Rescue, And Backstop

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-180 | Basic | Time-based default on liquid collateral after grace. | Collateral liquidated/swapped or fallback snapshot created; claims recorded. | unit/integration | not scriptable without time; keep tests. |
| PF-181 | Basic | Time-based default on illiquid collateral. | Full collateral claim/transfer to lender path available. | unit/integration | Add default-capable harness/script; current scripts repay illiquid loans rather than defaulting them. |
| PF-182 | Advanced | HF-based liquidation on liquid collateral. | Liquidator triggers swap; lender/borrower/liquidator/treasury allocations recorded. | unit/integration | not broadcast-script friendly unless mock price can change without time. |
| PF-183 | Advanced | Liquidation fallback pending when swap fails. | Snapshot recorded; borrower cure and lender claim paths available. | unit/integration | Add script with mock failing adapter if safe. |
| PF-184 | Advanced | Borrower cures fallback by full repay before lender claim. | Loan closes repaid; snapshot deleted; collateral returned. | unit/integration | Add script if possible. |
| PF-185 | Advanced | Borrower cures fallback by adding collateral before lender claim. | Loan returns active; snapshot deleted. | unit/integration | Add script if possible. |
| PF-186 | Advanced | Lender claims fallback after retry fails/succeeds. | Fallback becomes terminal; claim paid once. | unit/integration | Add script with deterministic mock. |
| PF-187 | Advanced | Internal-match liquidation positive rescue. | Compatible internal liquidity closes/reduces distressed loan. | unit/integration | Add script after stable setup. |
| PF-188 | Advanced | Internal-match top-up unwind. | Top-up accounting unwinds without double pay. | unit/integration | Keep focused tests. |
| PF-189 | Advanced | Treasury backstop Role A absorbs eligible collateral. | Backstop capacity decreases; borrower/lender settlement coherent. | unit/integration | Add script when runbook needs it. |
| PF-190 | Advanced | Treasury backstop Role B buyout is offered and accepted. | Lender exits through cash buyout within constraints. | unit/integration | Add script if user-facing. |
| PF-191 | Operator | Flash-loan liquidator happy path. | Receiver borrows, swaps, repays provider, returns profit. | unit/integration + fork | Keep fork tests; not general positive script. |

### Borrower Preclose, Refinance, And Auto Lifecycle

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-210 | Basic | Borrower direct preclose / early repay. | Original loan closes with full-term/pro-rata semantics per flag; claims recorded. | scripted | Keep. |
| PF-211 | Advanced | Preclose option 2: transfer obligation through compatible borrower offer. | New borrower assumes obligation; original borrower exits under rules. | scripted | Keep; add current-holder assertions. |
| PF-212 | Advanced | Preclose option 3: offset with new lender offer. | Original borrower becomes lender or exits through offset as specified. | scripted | Keep; add NFT lock assertions. |
| PF-213 | Basic | Refinance via compatible borrower offer. | Old lender receives entitlement; new loan opens; borrower continuity preserved. | scripted | Keep; add full-term interest disclosure assertions in app. |
| PF-214 | Advanced | Standalone `refinanceLoan` flow. | Existing loan closes and replacement loan becomes active. | scripted | Keep. |
| PF-215 | Advanced | Auto-refinance caps configured and keeper executes within caps. | Replacement loan posted/accepted only within borrower caps and keeper gates. | unit/integration | Add script; high gap. |
| PF-216 | Advanced | Auto-extend caps configured and keeper executes within caps. | Loan extension respects borrower/lender caps and kill switches. | unit/integration | Add script; high gap. |
| PF-217 | Advanced | Pre-grace warning state appears for borrower with caps enabled. | UI warns best-effort and offers repay/widen actions. | frontend/indexer | app E2E. |

### Lender Early Withdrawal And Secondary Position Flows

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-230 | Basic | Lender sells loan via buy offer. | New lender becomes holder; old lender exits with agreed proceeds. | scripted | Keep. |
| PF-231 | Advanced | Lender creates loan sale offer and another lender completes sale. | Sale link maps to loan; position authority moves. | unit/integration + older scenario | Add current wrapper coverage if missing. |
| PF-232 | Advanced | Lender sale offer cancelled before fill. | Sale link cleared; original lender remains holder. | unit/integration | Optional script. |
| PF-233 | Basic | Lender waits to maturity and claims after borrower repayment/default. | No early-withdraw action; normal lifecycle closes. | scripted indirectly | Keep. |
| PF-234 | Advanced | Secondary-market position NFT holder claims terminal proceeds. | Current holder receives claim, not original wallet. | unit/integration | Add script; high-value gap. |

### VPFI Utility, Rewards, And Cross-Chain Token Flows

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-250 | Basic | User deposits externally acquired VPFI into Vaipakam Vault. | Protocol-tracked vaulted VPFI balance increases. | scripted but stale naming | Rename/update script and assertions. |
| PF-251 | Basic | User withdraws free VPFI from vault. | Free tracked balance exits; encumbered/reserved balance stays. | scripted but stale naming | Rename/update script and add reserved-balance case. |
| PF-252 | Basic | User enables fee-discount consent. | Platform-level flag active for future settlements. | scripted | Keep. |
| PF-253 | Basic | Lender receives yield-fee discount at settlement. | Discounted fee calculation uses current effective tier. | unit/integration | Add script assertion. |
| PF-254 | Basic | Borrower pays full VPFI LIF upfront and receives rebate on proper close. | Rebate claim line appears; treasury share accrues. | scripted | Keep; update terminology. |
| PF-255 | Basic | Borrower defaults / is liquidated and loses VPFI LIF rebate. | Full held VPFI goes to treasury. | unit/integration | Add script if not time-dependent. |
| PF-256 | Advanced | Min-history gate: deposit qualifies raw tier, effective tier activates later. | Tier remains 0 until gate; poke can refresh after aging. | unit/integration | not broadcast-script friendly. |
| PF-257 | Advanced | `pokeMyTier` broadcasts/pushes tier when eligible. | Mirror cache receives fresh tier or budget-handled result. | unit/integration | Add harness script if CCIP/messenger mocks deployed. |
| PF-258 | Advanced | Mirror-chain fee discount uses authenticated Base-resolved cache. | Mirror settlement reads cache, not local balance. | unit/integration | Add cross-chain script/harness. |
| PF-259 | Basic | Interaction rewards claim on active chain. | User receives VPFI; pending reward clears. | unit/integration | Add script; replace old staking-reward assumptions. |
| PF-260 | Operator | Reward reporter sends per-chain denominator/funding messages. | Canonical denominator finalized and mirrored. | unit/integration | Add cross-chain rehearsal script. |
| PF-261 | Advanced | CCIP VPFI transfer from canonical to mirror and back. | Lock/release or mint/burn accounting preserves total supply. | unit/integration | Add dedicated cross-chain positive script. |
| PF-262 | Operator | Protocol broadcast budget top-up and tier-push budget consumption. | Budget increases and decreases only through documented paths. | unit/integration | Optional operator script. |
| PF-263 | Operator | VPFI token rotation runbook drains old exposure then rotates. | Old-token exposure is zero before new token becomes active. | ops docs only | Runbook rehearsal, not normal positive script. |

### Vault Recovery And Data Rights

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-280 | Advanced | Recover unsolicited ERC-20 from vault with valid EIP-712 acknowledgement. | Untracked token returns to user; nonce consumed. | scripted | Keep. |
| PF-281 | Advanced | Recovery with sanctioned declared source records banned source and does not transfer. | Ban state recorded; ordinary wind-down remains possible. | scripted | Keep. |
| PF-282 | Advanced | User disowns unsolicited token. | Event emitted; accounting unchanged. | scripted | Keep. |
| PF-283 | Advanced | Mandatory vault upgrade by user. | User vault implementation moves to required version. | unit/integration | Add script for deployment rehearsals. |
| PF-284 | Advanced | Stuck-token recovery route hidden from basic nav but accessible by advanced deep link. | App route renders only in advanced/support context. | frontend/indexer | app E2E. |
| PF-285 | Basic | User downloads/deletes browser-local diagnostic data. | Local app data export/erasure completes without on-chain claims. | frontend/indexer | app E2E. |

### Keeper And Automation Authority

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-300 | Advanced | User enables master keeper access and approves keeper with action bits. | Keeper listed with correct permissions. | scripted | Keep. |
| PF-301 | Advanced | User edits keeper actions. | Permission mask updates without changing unrelated keepers. | unit/integration | Add script assertion. |
| PF-302 | Advanced | User revokes keeper. | Keeper can no longer perform delegated actions. | unit/integration | Optional positive/negative split. |
| PF-303 | Advanced | Keeper executes allowed lifecycle action for current position holder. | Action succeeds only within explicit authority. | scripted | Keep; add current-holder transfer case. |
| PF-304 | Advanced | Global delegated-keeper pause toggles off and back on. | Keeper calls inert while paused; direct owner actions remain available. | unit/integration | Add combined script for delegated-keeper pause; current positive scripts cover general pause smoke only. |
| PF-305 | Basic | Permissionless liquidation/default trigger succeeds even without keeper delegation. | Caller can move loan to terminal state but cannot redirect funds. | unit/integration | Keep focused tests. |

### Admin, Governance, Treasury, Oracle, And Deployment

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-320 | Operator | Fresh Diamond deploys born paused, configures facets, then unpauses. | No public mutation before explicit unpause. | unit/integration + deploy scripts | Keep deploy rehearsal. |
| PF-321 | Operator | Role handover to multisig/timelock removes deployer powers. | Deployer zero-role invariant holds. | unit/integration + scripts | Keep. |
| PF-322 | Operator | Global pause and unpause. | State-changing entrypoints are blocked while paused, then resume after unpause. | scripted smoke + unit/integration enforcement | Add enforcement harness/script if broadcast-safe; current script toggles and resumes but does not submit expected-revert calls while paused. |
| PF-323 | Operator | Per-asset pause and unpause. | New flows for the paused asset are blocked while paused, then resume after unpause. | scripted smoke + unit/integration enforcement | Add enforcement harness/script if broadcast-safe; current script toggles and resumes but does not submit expected-revert calls while paused. |
| PF-324 | Operator | Admin config knob update inside bounds. | New config visible through getters and affects future flow. | unit/integration | Add targeted scripts for release gates only. |
| PF-325 | Operator | Oracle config with Chainlink + V3 liquidity classifies asset liquid. | Price/HF paths work for supported asset. | scripted setup + unit | Keep setup assertions. |
| PF-326 | Operator | Secondary oracle quorum accepts healthy Chainlink deviation. | Operations continue when quorum agrees. | unit/integration | not ordinary script. |
| PF-327 | Operator | Sequencer uptime healthy path on L2. | Reads/actions proceed when sequencer is healthy. | unit/integration | not ordinary script. |
| PF-328 | Operator | Swap adapter allowlist and failover with first viable route. | Liquidation/swap path uses allowed adapter and records outcome. | unit/integration | Add mock-route script if useful. |
| PF-329 | Operator | Treasury accrues yield fee/LIF/late fee and authorized withdrawal succeeds. | Accrued balances decrease after treasury withdrawal. | scripted surface + unit | Add full withdrawal assertion. |
| PF-330 | Operator | Treasury recycling routes active reward/keeper budgets; dormant buyback has no staking overflow. | Budgets update; no removed staking sink is credited. | unit/integration | Add treasury positive tests before script. |
| PF-331 | Operator | Buyback intent validation / remittance positive path where enabled. | Validated buyback remittance handled under dormant policy. | unit/integration | keep out of user script. |
| PF-332 | Operator | Founder/team vesting deployment and release. | Vesting wallets release only according to schedule. | script/unit unknown | Add test if absent. |
| PF-333 | Operator | Cross-chain deploy/configure CCIP lane, token pool, messenger, guardian pause. | Lane sends/receives only approved peers and can be paused. | unit/integration + scripts | Add rehearsal script coverage. |
| PF-334 | Operator | Active-chain allow-list export excludes stale deployments. | Frontend/indexer only see active chains. | ops/frontend | Add deploy-script test. |
| PF-335 | Operator | ABI exports for frontend, keeper, worker, subgraph, Tenderly. | Consumer bundles carry current ABI provenance. | scripts | Add CI/deploy assertion. |

### Indexer, Worker, Notifications, And Realtime Freshness

| ID | Audience | Positive flow | Expected end state | Current coverage | Script need |
| --- | --- | --- | --- | --- | --- |
| PF-350 | Read | Worker indexes offers, loans, claims, activity from deploy block. | API rows match on-chain events. | frontend/indexer | Add worker integration test. |
| PF-351 | Read | Wallet endpoints answer current-owner loan/offer rows from D1 indexes. | NFT transfer changes visible owner without unbounded RPC fanout. | frontend/indexer + unit | Add worker integration test. |
| PF-352 | Read | Paginated user positions and global lists return bounded pages. | Dusted wallets load without timeout. | unit/integration | Add worker/app E2E. |
| PF-353 | Read | Provider webhook accelerates freshness. | Safe-block events appear before scheduled poll when webhook works. | frontend/indexer | Add worker test. |
| PF-354 | Read | WebSocket realtime channel sends invalidation only. | App re-reads trusted slices and falls back to polling on disconnect. | frontend/indexer | Add app/worker E2E. |
| PF-355 | Basic | Alerts preferences save and pre-grace/threshold notifications are scheduled. | User gets configured delivery state; app shows warning state. | frontend/indexer | Add worker test. |
| PF-356 | Operator | HF watcher / keeper bot sees eligible liquidation and submits transaction. | Bot action matches on-chain permissionless semantics. | external repo + integration | Keep outside core script. |

## Basic User Positive Journey Set

These are the minimum end-to-end journeys for Basic mode. Each should have a
human-readable app E2E and, where on-chain state-changing, a Foundry positive
counterpart.

| Journey | Flow IDs |
| --- | --- |
| First-time lender posts, borrower accepts, borrower repays, both claim. | PF-001, PF-002, PF-003, PF-004, PF-040, PF-090, PF-110, PF-112, PF-113 |
| Borrower posts request, lender accepts, third party repays, borrower claims. | PF-041, PF-091, PF-111, PF-113 |
| Illiquid collateral loan with explicit consent and default claim. | PF-094, PF-181, PF-112 |
| ERC-721 collateral loan starts and closes. | PF-092, PF-110, PF-112, PF-113 |
| ERC-1155 collateral loan starts and closes. | PF-093, PF-110, PF-112, PF-113 |
| ERC-721 rental completes normally. | PF-042, PF-140, PF-142, PF-143 |
| ERC-1155 rental completes normally. | PF-043, PF-141, PF-142, PF-143 |
| Basic VPFI utility: deposit, enable consent, receive fee discount/rebate, withdraw free balance. | PF-250, PF-252, PF-253, PF-254, PF-251 |
| Rewards: earn interaction reward and claim from Claim Center. | PF-120, PF-025 |
| Dashboard and activity reflect a complete lifecycle. | PF-021, PF-024, PF-026 |

## Advanced User Positive Journey Set

| Journey | Flow IDs |
| --- | --- |
| Range-order match with partial fill, child loan visibility, and matcher share. | PF-053, PF-054, PF-055, PF-057, PF-023, PF-024 |
| Partial repay then full repay with no dust. | PF-114, PF-115 |
| Periodic-interest long loan settles a due checkpoint. | PF-116, PF-117 |
| Borrower swap-to-repay full and partial modes. | PF-118, PF-119 |
| Borrower preclose option 2 and option 3. | PF-211, PF-212 |
| Refinance tagged accept-and-refinance and standalone refinance. | PF-098, PF-213, PF-214 |
| Lender early withdrawal through buy offer and sale offer. | PF-230, PF-231, PF-232 |
| Position NFT transfer followed by current-holder claim/action. | PF-163, PF-164, PF-234 |
| Fallback pending rescue: swap fails, borrower cures by repay/add-collateral, lender claim remains one-shot. | PF-183, PF-184, PF-185, PF-186 |
| Keeper setup and delegated action execution with pause visibility. | PF-300, PF-301, PF-303, PF-304 |
| Lender intent lifecycle and solver fill. | PF-070, PF-071, PF-072, PF-073 |
| Vault recovery / disown support flow. | PF-280, PF-281, PF-282 |
| Mirror-chain VPFI tier propagation and fee settlement. | PF-257, PF-258, PF-261 |

## High-Priority Gaps To Close Before Rewriting `PositiveFlows.s.sol`

1. Rename/update VPFI script scenarios: `staking` / `unstake` should become
   `deposit VPFI` / `withdraw VPFI`, and removed staking-yield claims should not
   appear in positive-flow logs or docs.
2. Add scripted assertions for current-holder semantics: transfer position NFT,
   then close/claim/keeper-action from the new holder.
3. Add a dedicated lender-intent positive script: register, pause, resume/fund,
   solver fill, per-owner view expectations.
4. Add auto-lifecycle positives: configure caps, show inert/active gate state,
   keeper executes within caps.
5. Add periodic-interest and swap-to-repay positive tests/scripts using a harness
   that can control time and deterministic swap outcomes.
6. Add interaction-reward claim script coverage that replaces the old staking
   reward mental model.
7. Add worker/indexer positive tests for current-owner rows, paginated positions,
   child-loan offer details, webhook acceleration, and WebSocket invalidation.
8. Add cross-chain positive rehearsal for CCIP VPFI transfer, tier propagation,
   reward denominator/funding messages, and guardian pause.
9. Make `PositiveFlows.s.sol` a thin runner over versioned modules, not a single
   claim of complete coverage. Suggested modules:
   - `PositiveFlowsBasicLifecycle`
   - `PositiveFlowsAdvancedCredit`
   - `PositiveFlowsVaultAndVpfi`
   - `PositiveFlowsKeeperAutomation`
   - `PositiveFlowsOperatorAdmin`
   - `PositiveFlowsCrossChain`
10. Update `docs/TestScopes/AdvancedUserGuideTestMatrix.md` or mark it legacy;
    it still references retired Buy VPFI / staking-reward surfaces.

## Suggested Test IDs And Naming

Use the `PF-###` IDs above in test names and script logs so coverage is easy to
search.

Examples:

- `test_PF090_BorrowerAcceptsLenderOffer_LiquidCollateral_HappyPath`
- `test_PF164_CurrentHolderReceivesClaimAfterPositionTransfer`
- `script PF250 DepositVpfiToVault`
- `script PF073 LenderIntentSolverFill`

For script logs, print both the flow ID and a short user-facing name:

```text
[PF-090] Borrower accepts lender ERC-20 offer with liquid collateral
[PF-090] PASS loanId=...
```

## Maintenance Rule

When a behavior-changing PR adds or removes a positive path:

1. Update the relevant FunctionalSpecs document with intended behavior.
2. Add or revise a row in this catalog.
3. Add a Foundry positive test using the `PF-###` ID.
4. If the flow is deploy-rehearsal-safe, add it to the appropriate positive-flow
   script module.
5. If it is UI/indexer-only, add it to the app/worker E2E plan instead of the
   Foundry broadcast script.
