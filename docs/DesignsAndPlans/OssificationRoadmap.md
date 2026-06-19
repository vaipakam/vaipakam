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
    **root** `DEFAULT_ADMIN_ROLE` — which can grant `UNPAUSER_ROLE` to anyone
    and so bypass the timelock — does not sit on a hot key. At handover
    `DEFAULT_ADMIN_ROLE` moves to the **governance Safe** (a multisig, not the
    timelock itself), and the deployer renounces it; the unpause-delay
    guarantee therefore rests on that multisig's honesty/threshold, not on
    code. Hardening it further — timelocking `DEFAULT_ADMIN_ROLE` itself so even
    a role-grant respects the delay — is a freeze-stage item, not done today.
- **The guardian can only halt — never move custody.** `PAUSER_ROLE` gates only
  the pause flag; it has no fund-custody authority. Pausing freezes new state
  transitions; it cannot redirect, seize, or mint.

Net: the asymmetric `PAUSER` (pause, fast, guardian-held) / `UNPAUSER`
(unpause, slow, timelock-held) split **is** the guardian-pause the research
asked for. No new role is added — adding a separate `GUARDIAN_ROLE` would be a
rename of `PAUSER` with no new function (the "check existing primitives before
reinventing" call). The only operational requirement is that `PAUSER_ROLE` is
granted to a credible, fast-reacting guardian Safe at deploy — which the
handover scripts already arrange.

## 2. Staged ossification — what freezes, and when

We start fully upgradeable and renounce on a schedule, narrowing the trusted
surface in stages. Targets by surface:

| Surface | Today | Commitment |
| --- | --- | --- |
| Fund custody + core accounting (loan lifecycle, repayment, claim, vault transfers) | upgradeable | **Freeze first** — the highest-trust surface; freeze its cut path on the published schedule once the audit + bake confirm stability. |
| Per-user vault implementation (`VaipakamVaultImplementation`, UUPS, `_authorizeUpgrade` is `onlyOwner` = the Diamond) | upgradeable | **Part of the custody-freeze commitment.** A vault-impl upgrade is custody-moving (it runs in the proxy that holds user assets), so it stays behind the Diamond owner = **timelock** and is a freeze candidate on the same schedule as the cut path — explicitly, not just the Diamond facets. |
| Other Diamond-owned UUPS custody surfaces — the ERC-4626 aggregator adapter proxies (`AggregatorAdapterFactoryFacet.upgradeAggregatorAdapter`, which hold aggregator principal) and the protocol backstop vault (`BackstopFacet.upgradeBackstopVault`, which holds backstop lending capital) | upgradeable | **Also part of the custody-freeze commitment.** These are *separate* UUPS upgrade hooks from the per-user vault: a malicious implementation cut in here moves aggregator or backstop custody without ever touching the per-user vault path, so they carry the **same timelock + freeze-candidate** treatment as the vault impl. (The aggregator and backstop products themselves are later-phase; until they ship the rows are forward-looking, but the freeze guarantee names them explicitly so they can't slip the net when they do.) |
| Price/risk inputs that *indirectly* move custody (oracle adapters #392, risk params + admission floor #394, rate model #400) | upgradeable | **Bounded-upgradeable, never freely replaceable.** A freely-swappable oracle/risk facet can drain custody indirectly, so these stay behind a **timelock**, and — for the *numeric* knobs (risk params, admission floor, rate-model premiums) — **range-checked setters** that evolve only within hard bounds, never via a free facet replace. **Honest caveat:** the *oracle address* swaps (`setChainlinkRegistry`, `setEthUsdFeed`, `setTellorOracle`, `setApi3ServerV1`, `setDIAOracleV2`) are **not** range-bounded — they forward an arbitrary address into storage after only the owner check, so today their sole bound is the timelock delay (a queued, arbitrary feed replacement is still a custody-moving change). An on-chain feed **allowlist** that constrains *which* oracle addresses are settable is outstanding hardening, not in place today. During the timelock delay the guardian can halt user flows; cancelling a queued change is the timelock proposer's lever. |
| Curation / parameters (fees, tiers, kill-switches) | upgradeable | Stays upgradeable (bounded) — curation must keep evolving. |
| Diamond-cut governance itself | timelock | **Freeze the whole cut path** — Add **and** Replace/Remove (freezing only existing selectors would still let a new facet add custody-moving code) — on the published schedule (post-audit), behind separated guardian/upgrade multisigs + timelock until then. |

Guiding rule (the load-bearing line): **anything that can move custody —
directly or through a price/risk input — can only change behind the 48–72h
timelock** (delay sized to detect-and-exit, and a freeze *candidate*, never a
free replace).

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
  not the timelock). Because that role is the `roleAdmin` of `ORACLE_ADMIN_ROLE`,
  `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`, and `UNPAUSER_ROLE`, a holder of
  `DEFAULT_ADMIN_ROLE` can **grant itself any of those immediately** and then
  change oracle/risk/vault settings (or unpause) **without** the 48–72h delay.
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
  - **The per-user vault UUPS upgrade path** (`VaipakamVaultImplementation`,
    `_authorizeUpgrade onlyOwner` = the Diamond). It is custody-moving (it runs
    inside the proxy that holds user assets) and is part of the same post-audit
    freeze, on the same schedule as the Diamond cut path — not just the facets.
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
