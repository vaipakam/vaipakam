# Vaipakam ossification roadmap + guardian-pause commitment (#404)

> Status: **published commitment, pre-audit draft.** Decision artifact for
> #404 (research verdict: ADOPT a *staged* ossification roadmap, not immediate
> immutability). The research itself is in
> [`Research-404-OssificationRoadmap.md`](Research-404-OssificationRoadmap.md);
> this doc is the honest, dated *commitment* derived from it. Authored
> 2026-06-19.

## 0. TL;DR

Vaipakam is a fully-upgradeable EIP-2535 Diamond today, on purpose — pre-audit
we need to be able to patch and evolve. We do **not** ship an immutable core
yet. Instead we commit to:

1. A **guardian fast-pause** on the core lending Diamond — *which already
   exists* (the asymmetric `PAUSER`/`UNPAUSER` split) and is wired to survive
   handover. §1. (The slow-unpause half of that split is a *process*
   guarantee, not an absolute one: the root `DEFAULT_ADMIN_ROLE` lands on the
   governance Safe at handover and can re-grant `UNPAUSER_ROLE` outside the
   timelock — so the guarantee rests on that multisig honouring process. The
   §1 caveat states this in full; timelocking `DEFAULT_ADMIN_ROLE` itself is
   tracked freeze-stage hardening.)
2. A **staged ossification** of the trusted surface over time, with the rules
   that move custody freezing first and curation staying bounded-upgradeable.
   §2.
3. **Separated guardian / upgrade authorities behind a 48–72h timelock**
   throughout. §3.

We deliberately do **not** over-promise immutability we don't have. Anything
that can move user funds — directly or via price/risk inputs — stays behind a
**timelock** until it is frozen on the published schedule. Two honesty notes on
that delay and the cancel lever:

- The **48–72h** figure is the *operational deploy commitment*, not a
  code-enforced floor. `DeployTimelock.s.sol` reads `TIMELOCK_MIN_DELAY` from
  env (default `172800` = 48h); the OpenZeppelin `TimelockController` enforces
  whatever value was set at deploy, and changing the delay itself goes through
  the timelock. The commitment is therefore "deploy with ≥ 48h and never lower
  it below that without the delay" — verified at the deploy ceremony, not by a
  hard-coded minimum.
- The guardian-pause **halts user flows** during the delay window but does
  **not** cancel a queued upgrade — the diamond-cut path is intentionally left
  callable while paused (it's the incident recovery lever). Cancelling a
  scheduled timelock op is the **timelock canceller's** lever, and today the
  canceller **is the proposer** (the governance multisig) — so cancellation
  assumes the proposer key is not itself the compromised one. An **independent
  canceller** role (a separate guardian that can cancel but not propose) is a
  hardening item, not wired today.

## 1. Guardian fast-pause — already in place

The research recommended adding a Diamond-level guardian-pause mirroring the
cross-chain `GuardianPausable` pattern (guardian can pause, only owner-via-
timelock can unpause, guardian can never alter custody). **The core Diamond
already implements this guarantee** — it just isn't named "guardian":

- **Fast-pause (the guardian lever).** `PAUSER_ROLE` can halt the whole
  protocol immediately, with **no timelock delay**
  (`AdminFacet.pause` → `LibPausable`). At handover `PAUSER_ROLE` is held by the
  **Guardian / ops Safe** (granted via `GrantOpsRoles`), and the deploying
  EOA's hold on it is **renounced** — `TransferAdminToTimelock.s.sol` lists
  `PAUSER` among the ops roles that "do NOT migrate to the timelock … the
  deployer's hold on them must still be renounced here, otherwise the deploy EOA
  retains PAUSER … which is a hot-wallet hole the `GovernanceHandover.t.sol`
  invariant catches." `Handover.s.sol:_timelockRoles` deliberately omits
  `PAUSER_ROLE` so it never routes through the timelock. This is the
  detect-to-freeze fast path, on the guardian Safe.
- **Unpause is the deliberate-reset key.** `UNPAUSER_ROLE` is rotated to the
  **Timelock** at handover (`Handover.s.sol:_timelockRoles[1]`), so lifting a
  pause takes the full review-window delay. A compromised or impatient Pauser
  key **cannot un-do its own pause** to race the incident team — exactly the
  cross-chain `GuardianPausable` rationale.
  - **Caveat (honest):** this full-delay guarantee holds only because the
    **root** `DEFAULT_ADMIN_ROLE` does not sit on a hot key. That role is a
    *general* timelock-bypass, not just an unpause one: a holder can `grantRole`
    `UNPAUSER_ROLE` to any address **and** can call
    `AccessControlFacet.transferAdmin`, which `setContractOwner`s ERC-173
    ownership to a new address (re-granting every role to it) before revoking
    the caller's — i.e. it can move the Diamond's whole privileged surface off
    the timelock in one call. At handover `DEFAULT_ADMIN_ROLE` moves to the
    **governance Safe** (a multisig, not the timelock itself), and the deployer
    renounces it; the unpause-delay (and timelock control generally) therefore
    rests on that multisig's honesty/threshold, not on code. Hardening it
    further — timelocking `DEFAULT_ADMIN_ROLE` itself so even a role-grant or
    `transferAdmin` respects the delay — is a freeze-stage item, not done today.
- **The guardian can only halt — never move custody.** `PAUSER_ROLE` gates only
  the pause flag; it has no fund-custody authority. Pausing freezes new state
  transitions; it cannot redirect, seize, or mint.

Net: the asymmetric `PAUSER` (pause, fast, guardian-held) / `UNPAUSER`
(unpause, slow, timelock-held) split **is** the guardian-pause the research
asked for. No new role is added — adding a separate `GUARDIAN_ROLE` would be a
rename of `PAUSER` with no new function (the "check existing primitives before
reinventing" call). The only operational requirement is that `PAUSER_ROLE` is
granted to a credible, fast-reacting guardian Safe at deploy, and that
`UNPAUSER_ROLE` is rotated to the Timelock — which the **canonical**
`Handover.s.sol` arranges (its `_timelockRoles` includes `UNPAUSER_ROLE`
deliberately, and it renounces the deployer's `PAUSER`/`UNPAUSER` holds).

> **Honest gap (tracked as #650):** the *legacy* `TransferAdminToTimelock.s.sol`
> — which `docs/ops/GovernanceRunbook.md` step 3 still points operators at —
> migrates only DEFAULT_ADMIN / ADMIN / ORACLE / RISK / VAULT to the timelock
> and omits `UNPAUSER_ROLE` from both its migration **and** its deployer-renounce
> set, so a deploy following that path leaves the deployer EOA holding
> `UNPAUSER_ROLE` (a hot key that can lift any guardian pause). The slow-unpause
> guarantee above holds for `Handover.s.sol` specifically; reconciling /
> deprecating the legacy script (and asserting "deployer holds no `UNPAUSER`
> post-handover" in `GovernanceHandover.t.sol`) is outstanding hardening, not in
> place today.

## 2. Staged ossification — what freezes, and when

We start fully upgradeable and renounce on a schedule, narrowing the trusted
surface in stages. Targets by surface:

> **What "the schedule" is, honestly (no calendar dates yet).** This document
> commits to the *order and the gating conditions*, not to dates — and
> deliberately so: the protocol is pre-audit and pre-mainnet, and naming block
> heights or calendar dates now would be a guess. The freeze schedule is
> **milestone-gated**: (1) external audit sign-off on the surface being frozen,
> then (2) a published mainnet **bake period** (a stated minimum number of weeks
> of live operation with no critical findings), after which (3) the renounce
> transaction for that surface is executed and announced. The concrete dates /
> bake-length / audit-firm milestones are **published at audit time** in this
> doc's revision and the release notes — until then, every "on the published
> schedule" below means "on that milestone-gated schedule, to be dated at audit
> time," not a commitment already in force.

| Surface | Today | Commitment |
| --- | --- | --- |
| Fund custody + core accounting (loan lifecycle, repayment, claim, vault transfers) | upgradeable | **Freeze first** — the highest-trust surface; freeze its cut path on the published schedule once the audit + bake confirm stability. |
| Per-user vault implementation (`VaipakamVaultImplementation`, UUPS, `_authorizeUpgrade` is `onlyOwner` = the Diamond) | upgradeable | **Part of the custody-freeze commitment.** A vault-impl upgrade is custody-moving (it runs in the proxy that holds user assets). The actual gate is **`VAULT_ADMIN_ROLE`**, *not* the Diamond's ERC-173 owner: `upgradeVaultImplementation` / `setMandatoryVaultUpgrade` (both `VAULT_ADMIN_ROLE`-only) set *which* template the proxies point at, and `upgradeUserVault(user)` is permissionless **but safe** — it can only migrate a proxy to that admin-set template, never to a caller-chosen impl. `VAULT_ADMIN_ROLE` rotates to the **timelock** at handover, so the template choice is timelock-delayed; this row is a freeze candidate on the same schedule as the cut path — explicitly, not just the Diamond facets. |
| Other Diamond-owned UUPS custody surfaces — the ERC-4626 aggregator adapter proxies (hold aggregator principal), the protocol backstop vault (`BackstopFacet.upgradeBackstopVault`, holds backstop lending capital), and the Seaport collateral-sale executor (`CollateralListingExecutor`, UUPS `_authorizeUpgrade` is `onlyOwner`, validates/finalizes prepay collateral sales against the Diamond) | upgradeable | **Also part of the custody-freeze commitment.** These are *separate* UUPS upgrade hooks from the per-user vault, each on its own admin surface. As with the vault, the governance-controlled hook is the **template / implementation setter** — for the aggregator that is `upgradeAdapterImplementation(newImplementation)` (`VAULT_ADMIN_ROLE`), while `upgradeAggregatorAdapter(adapter)` is only the permissionless-but-safe migrate trigger (it can move a proxy to the published template or a mandated version, never to a caller-chosen impl). A malicious template cut in here moves aggregator / backstop / collateral-sale custody without ever touching the per-user vault path, so the **implementation setters** carry the **same timelock + freeze-candidate** treatment as the vault impl. **The executor is the exception to watch:** unlike the Diamond-template surfaces, `CollateralListingExecutor` is upgraded via its **own Ownable owner** (`__Ownable_init(_owner)` = the admin multisig at deploy), *not* a Diamond role / template setter — the Diamond only stores the current executor address via `setCollateralListingExecutor`. So a freeze scoped to Diamond template setters / `VAULT_ADMIN_ROLE` would miss it; its **own owner** must be rotated to the timelock and frozen separately. **And that alone is still insufficient** — the Diamond's *pointer* to the trusted executor is independently swappable: `PrepayListingFacet.setCollateralListingExecutor(address)` is `ADMIN_ROLE`-gated and writes `s.collateralListingExecutor` directly, so ADMIN could repoint the Diamond at a fresh malicious executor even with the old impl frozen. Freezing the collateral-sale surface therefore needs **both** levers behind the timelock — the executor's own Ownable owner **and** the `setCollateralListingExecutor` pointer. (The aggregator and backstop products themselves are later-phase; until they ship those rows are forward-looking, but the freeze guarantee names them explicitly so they can't slip the net when they do.) |
| Price/risk inputs that *indirectly* move custody (oracle adapters #392, risk params + admission floor #394, rate model #400) | upgradeable | **Bounded-upgradeable, never freely replaceable.** A freely-swappable oracle/risk facet can drain custody indirectly, so these stay behind a **timelock**, and — for the *numeric* knobs (risk params, admission floor, rate-model premiums) — **range-checked setters** that evolve only within hard bounds, never via a free facet replace. **Honest caveat (gate + bound).** *Gate:* the `OracleAdminFacet` address setters are **owner-gated**, not role-gated — they route to `LibVaipakam` functions guarded by `LibDiamond.enforceIsContractOwner()` (the Diamond's ERC-173 owner). `ORACLE_ADMIN_ROLE` is *defined / exported but never used as an `onlyRole` gate* — so oracle hardening must target the **owner** path (post-handover the owner is the Timelock, so these *are* timelock-delayed; the role is a red herring here, not the lever). *Bound:* the address swaps are **not** range-bounded — they forward an arbitrary address into storage, so the timelock delay is their only bound (a queued, arbitrary feed replacement is still custody-moving). The surface is the **whole** address-setter set, not a short list — the price feeds + denominators (`setChainlinkRegistry`, `setEthUsdFeed`, `setStableTokenFeed`, `setFeedOverride`, `setSequencerUptimeFeed`, `setUsdChainlinkDenominator`, `setEthChainlinkDenominator`), the secondary-quorum oracles (`setTellorOracle`, `setApi3ServerV1`, `setDIAOracleV2`, `setPythOracle`), the liquidity-classification inputs (`setWethContract`, `setUniswapV3Factory`), and the risk/peer inputs (`setPeerProtocolAddresses`, `setTierReferenceAssets`) all take a free address. An on-chain **allowlist** constraining *which* addresses are settable is outstanding hardening, not in place today; **#651** tracks a code-derived census so the allowlist/freeze scope covers every such setter (the lists here are representative, not exhaustive). **Same class for the rate model:** the #400 *output* is range-bounded (deviation-clamped to the market band), but the *active model implementation* is a **free address swap** — `AdminFacet.setRateModel(address)` accepts any nonzero contract under `ADMIN_ROLE` (only a `code.length > 0` check). So a misconfigured/malicious model can't push an automated quote off-market (the clamp holds), but swapping the model pointer is itself an unbounded-address lever and is in the #651 census / freeze scope alongside the oracle setters. During the timelock delay the guardian can halt user flows; cancelling a queued change is the timelock proposer's lever. |
| Curation / parameters (fees, tiers, kill-switches) | upgradeable | Stays upgradeable (bounded) — curation must keep evolving. |
| Diamond-cut governance itself | timelock | **Freeze the whole cut path** — Add **and** Replace/Remove (freezing only existing selectors would still let a new facet add custody-moving code) — on the published schedule (post-audit), behind separated guardian/upgrade multisigs + timelock until then. |

Guiding rule (the load-bearing line): **anything that *governs* custody —
i.e. can change the rules by which funds move, directly or through a price/risk
input — can only change behind the 48–72h timelock** (delay sized to
detect-and-exit, and a freeze *candidate*, never a free replace).

**Honest carve-out (a custody-moving path that is *not* behind the timelock).**
The rule above governs the *upgrade/parameter* surface. One operational debit
sits outside it: `LoanFacet.markNotifBilled` (`NOTIF_BILLER_ROLE`) calls
`LibNotificationFee.bill`, which pulls a fixed VPFI notification fee directly
from a loan party's vault to the treasury — no timelock. Two honest sharp edges,
not glossed:
- **There is no on-chain paid-tier / subscription check.** `markNotifBilled`
  debits whichever side it's told (`loan.lender` / `loan.borrower`); the only
  on-chain guard is *idempotency* (the per-side `…NotifBilled` flag stops a
  second debit), **not authorization**. "Opted-in" is enforced off-chain by the
  biller, not by the contract. There is also **no loan-status check** —
  `markNotifBilled` only rejects an out-of-range `loanId` (`0` or `> nextLoanId`),
  so the billable set is **every loan ever opened** whose per-side flag is still
  unset, not just *active* ones: a compromised biller can debit closed / settled
  / defaulted loans' parties too.
- **The role is a hot key until rotation.** `Handover.s.sol` leaves
  `NOTIF_BILLER_ROLE` on the **ADMIN EOA** (not even an ops bot, and outside the
  timelock) until a separate per-bot rotation. So the realistic blast radius of
  a compromised biller key today is: one fixed VPFI fee skimmed from every
  billable loan side, once each (bounded by the idempotency flag and the fixed
  fee, but real).
The fee is fixed and capped-per-loan-side, and the role can't re-point custody
rules — so it's a fast-path *by necessity*, not a governance lever — but it is a
role-gated path that moves user funds without the delay **and** without an
on-chain authorization check, named here rather than hidden. Adding an on-chain
subscription gate, and constraining / timelocking + promptly rotating the biller
role off the ADMIN EOA, is in the #651 census scope.

**What "detect-and-exit" does and does not mean (honest):** the delay buys
users a window to *observe* a queued custody-moving change and exit (repay,
withdraw, claim) **while the protocol is unpaused**. It is **not** a guarantee
that exit stays open in every scenario — the user-exit paths (`RepayFacet.repayLoan`,
`ClaimFacet.claimAsLender`, withdrawals) are themselves `whenNotPaused`, so if the
guardian *pauses* during a queued hostile op those exits revert too. Pause and
detect-and-exit are therefore alternative mitigations, not simultaneous ones:
while **unpaused**, the delay is the user's exit window; once **paused**, the
lever is the incident team's **cancellation / remediation** (the timelock
proposer cancels the queued op), not user exit. The guardian's pause buys the
team time to cancel — it does not preserve the exit window it freezes.

## 3. Authority + timelock shape

- **Separated authorities:** a fast-key **guardian/Pauser Safe** (pause only),
  an **upgrade/admin Safe** → **48–72h Timelock** for everything that can move
  custody. The two are distinct keys, so a guardian-key compromise can only
  *halt* user flows (it has no upgrade authority), and an upgrade-key
  compromise still has to wait out the timelock delay — during which the
  guardian halts user activity and the timelock proposer (governance) can
  cancel the queued operation. The guardian does **not** itself block the
  upgrade (the cut path is intentionally not pause-gated, for recovery).
- **Remaining gap — the root `DEFAULT_ADMIN_ROLE` is not itself timelocked.**
  At handover `DEFAULT_ADMIN_ROLE` moves to the **governance Safe** (a multisig,
  not the timelock). Because that role is the `roleAdmin` of **`ADMIN_ROLE`**,
  `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`, and
  `UNPAUSER_ROLE`, a holder of `DEFAULT_ADMIN_ROLE` can **grant itself any of
  those immediately** and then call any `ADMIN_ROLE`-gated setter (e.g.
  `setRateModel`, treasury / fee config), change oracle/risk/vault settings, or
  unpause — all **without** the 48–72h delay. (And via `transferAdmin` it can
  move ERC-173 ownership wholesale, per the §1 caveat.)
  So the "custody-moving changes sit behind the timelock" guarantee is, today,
  only as strong as the governance Safe's threshold/honesty — it is **not**
  code-enforced for the role-grant path. Closing this (timelocking
  `DEFAULT_ADMIN_ROLE` so even a role grant respects the delay, or splitting
  these admin roles' `roleAdmin` onto the timelock) is a **freeze-stage
  commitment**, called out here rather than glossed over.
- **No on-chain quorum yet** (acknowledged gap, shared with #394's governance
  gap). The bounded-steward + timelock-asymmetry + guardian-pause fabric is the
  same one the risk knobs ride on; an on-chain quorum is a later addition, not
  a pre-audit blocker.
- The handover ceremony (role + ownership rotation to the timelock/guardian
  topology) is run by `Handover.s.sol`, exposed as a dedicated phase on **both**
  testnet and mainnet (`deploy-testnet.sh … --phase handover`,
  `deploy-mainnet.sh`). Testnet is where the split is **rehearsed**; mainnet
  cutover is where it takes effect for real value. Operationally, flow-test
  deploys are often left deployer/admin-owned for convenience (EOA keys keep the
  flow tests simple), but that is a per-deploy choice, **not** a claim that
  handover can't run on testnet — it can and should be rehearsed there.

## 4. Sequencing (what is pre- vs post-audit)

- **Pre-audit / now:** the guardian fast-pause (already present, §1) + *this*
  published commitment. Pure safety + trust upside, no new attack surface.
- **Post-audit:** the per-selector diamond-cut **freeze** mechanism (staged
  renounce of the cut path), the formal on-chain renounce timeline, and the
  on-chain quorum. These are deliberately deferred — freezing the cut path is
  irreversible and must follow the audit + a stability bake. Two things this
  freeze must explicitly cover, beyond replacing/removing existing selectors:
  - **Add (new selectors / facets), not just Replace/Remove.** Freezing only
    the existing selectors would still let a new facet introduce custody-moving
    code. The freeze scope is the *whole* cut path — Add included.
  - **Every UUPS custody upgrade path — not just the per-user vault.** The §2
    table lists them all and each has its *own* control gate, so the freeze
    checklist must cover the full set, not the vault alone: the per-user vault
    (`VaipakamVaultImplementation`, `_authorizeUpgrade onlyOwner` = the Diamond,
    template set by `VAULT_ADMIN_ROLE`), the aggregator-adapter **template**
    (`upgradeAdapterImplementation`, `VAULT_ADMIN_ROLE`), the backstop vault
    (`BackstopFacet.upgradeBackstopVault`), and the Seaport collateral-sale
    **executor** (`CollateralListingExecutor`, upgraded via its **own Ownable
    owner**, *not* a Diamond role — so freezing only Diamond template setters /
    `VAULT_ADMIN_ROLE` would miss it; its owner must be rotated to the timelock
    and frozen on the same schedule, **and** the Diamond's `ADMIN_ROLE`-gated
    `setCollateralListingExecutor` pointer frozen with it, else ADMIN can
    repoint to a fresh executor). Plus the **cross-chain UUPS / Ownable /
    registry-admin family** that also moves value and is rotated *separately* by
    `Handover.s.sol` — the `CcipMessenger`, the VPFI `TokenPool`,
    `VpfiPoolRateGovernor`, `VaipakamRewardMessenger`, the `VPFIMirrorToken`, the
    `VpfiBuyAdapter` / `VpfiBuyReceiver`, the canonical-only
    `BuybackRemittanceReceiver`, the canonical **`VPFIToken`** itself
    (Ownable2Step + UUPS — its owner controls `_authorizeUpgrade`, `setMinter`,
    and pause, and the token pool + `TreasuryFacet.mintVPFI` rely on it, so
    freezing the pool but not the token owner/minter leaves a mint/upgrade lever
    open), and the **CCIP `TokenAdminRegistry` CCT admin** for VPFI (rotated via
    `transferAdminRole`; it drives `setPool(localToken, pool)`, so an unfrozen
    registry admin can repoint the token's pool). Each is owner- or
    registry-admin-gated on its own surface, none reachable through the Diamond
    cut path. **This list names the known members; the authoritative scope is
    *every* Ownable / UUPS / registry-admin surface `Handover.s.sol` rotates —
    #651 enumerates it from code, so any cross-chain surface is in freeze scope
    whether or not named here.** All are custody-moving and ride the same
    post-audit freeze as the Diamond cut path — not just the facets.
  - **Independent canceller** for queued timelock ops (a guardian that can
    cancel but not propose), so a compromised proposer key can be stopped
    without itself holding the only cancel lever (see §0).

## 5. Honesty clause

This is **not** an "immutable protocol" claim. Vaipakam is upgradeable today
and will remain so until the staged freezes above are executed on a published,
dated schedule. We publish this roadmap so users can see exactly which rules
*can* still change, who can change them, and behind what delay — rather than
implying guarantees we do not yet have. The marketing / user-facing copy must
mirror this framing and never overstate immutability (see the retail-deploy
copy policy).

## 6. Related

- Research + verdict: [`Research-404-OssificationRoadmap.md`](Research-404-OssificationRoadmap.md)
- Governance config + bounded setters: [`GovernanceConfigDesign.md`](GovernanceConfigDesign.md)
- Risk-appetite knob (bounded-upgradeable example): #394 / `RiskFacet.setMinHealthFactor`
- Handover wiring: `contracts/script/Handover.s.sol`,
  `contracts/script/TransferAdminToTimelock.s.sol`
- Cross-chain guardian pattern this mirrors: `contracts/src/crosschain/GuardianPausable.sol`
