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
   handover. §1.
2. A **staged ossification** of the trusted surface over time, with the rules
   that move custody freezing first and curation staying bounded-upgradeable.
   §2.
3. **Separated guardian / upgrade authorities behind a 48–72h timelock**
   throughout. §3.

We deliberately do **not** over-promise immutability we don't have. Anything
that can move user funds — directly or via price/risk inputs — stays behind a
**48–72h timelock** (the delay is long enough to detect and exit a malicious
change) until it is frozen on the published schedule. To be precise about the
guardian's reach: the guardian-pause **halts user flows** during that delay
window, but it does **not** cancel a queued upgrade — the diamond-cut path is
intentionally left callable while paused (it is the incident recovery lever),
and cancelling a scheduled timelock operation is the **timelock proposer's**
(governance multisig's) lever, not the guardian's.

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
| Price/risk inputs that *indirectly* move custody (oracle adapters #392, risk params + admission floor #394, rate model #400) | upgradeable | **Bounded-upgradeable, never freely replaceable.** A freely-swappable oracle/risk facet can drain custody indirectly, so these stay behind **a timelock + range-checked setters** — they evolve, but only within hard bounds and never via a free facet replace. During the timelock delay the guardian can halt user flows; cancelling a queued change is the timelock proposer's lever. |
| Curation / parameters (fees, tiers, kill-switches) | upgradeable | Stays upgradeable (bounded) — curation must keep evolving. |
| Diamond-cut governance itself | timelock | **Freeze the cut path** on the published schedule (post-audit), behind separated guardian/upgrade multisigs + 48–72h timelock until then. |

Guiding rule (the load-bearing line): **anything that can move custody —
directly or through a price/risk input — can only change behind the 48–72h
timelock** (delay sized to detect-and-exit; the guardian can halt user flows in
that window, cancellation is the timelock proposer's), and is a freeze
*candidate*, never a free replace.

## 3. Authority + timelock shape

- **Separated authorities:** a fast-key **guardian/Pauser Safe** (pause only),
  an **upgrade/admin Safe** → **48–72h Timelock** for everything that can move
  custody. The two are distinct keys, so a guardian-key compromise can only
  *halt* user flows (it has no upgrade authority), and an upgrade-key
  compromise still has to wait out the timelock delay — during which the
  guardian halts user activity and the timelock proposer (governance) can
  cancel the queued operation. The guardian does **not** itself block the
  upgrade (the cut path is intentionally not pause-gated, for recovery).
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
  irreversible and must follow the audit + a stability bake.

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
