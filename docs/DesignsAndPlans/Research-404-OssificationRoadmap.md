# Research findings — #404: Minimal-immutable-core vs upgradeable-facet (ossification roadmap)

**Card:** #404 (master sweep #401, cross-cutting). **Status:** findings + verdict.
**Verdict:** **ADOPT — a staged ossification roadmap, not immediate immutability.** Keep the
diamond fully upgradeable **pre-audit** (the bug-patch safety valve a pre-live protocol needs);
**post-audit, freeze the custody + core-accounting surface** (per-selector cut-freeze) and
publish the commitment. Also: add a **Diamond-level guardian-pause** (today guardian-pause exists
only on the cross-chain contracts). A credible "your collateral custody cannot be changed by an
upgrade" guarantee is a real, honest user value-add — but only once the core is audited.

> External comparison systems referenced generically per the sweep rule.

---

## 1. Current trust surface (verified 2026-06-16)

- **Fully upgradeable diamond.** `DiamondCutFacet.diamondCut` (owner-only) can add / replace /
  remove **any** facet selector — including `OracleFacet`, `RiskFacet`, `LoanFacet`, custody. No
  per-selector cut-freeze, no storage-layout freeze.
- **Shared mutable `Storage`** struct; **per-user vaults are UUPS-upgradeable**.
- **Governance** = OZ `VaipakamTimelock` (single min-delay, **no on-chain quorum**); a
  timelocked owner role can ultimately cut anything.
- **Guardian-pause exists — but only cross-chain.** `GuardianPausable` (guardian pause / owner
  unpause) wraps the CCIP messenger, VPFI mirror, pool governor, buy adapter/receiver, reward
  messenger. **The Diamond itself has only a simple on/off `LibPausable` pause** (no guardian
  fast-path) + a per-asset `AdminFacet.pauseAsset`. So the *cross-chain* surface has a guardian
  fast-pause the *core lending* surface lacks.
- **Ossification today: none.** No freeze, no layout lock, no quorum, no staged renounce.

So the upgrade key is both our patch lever **and** the single largest trust assumption: users
must trust the timelocked owner won't rewrite custody/accounting.

## 2. External patterns (generic) — steal / avoid

- **Minimal immutable core + replaceable periphery.** A leading isolated-lending design ships its
  market/accounting/custody/liquidation math as a **non-upgradeable singleton** ("runs the same
  way forever") and pushes all mutable curation (risk params, caps, allocation) to outer layers
  that are themselves immutable bytecode but **re-selectable**. Governance powers are narrowly
  enumerated (whitelist parameter *choices*, a fee switch capped at 25% of interest) and
  explicitly **cannot** touch existing markets, funds, or the core. **STEAL the split** — frozen
  custody/accounting core, replaceable/curated periphery.
- **Fully-immutable, no-admin-key** designs exist (trust shifts entirely to "accounting cannot be
  changed"). **AVOID adopting this pre-audit** — it removes our ability to fix a bug, which for a
  pre-live protocol is the wrong trade.
- **Per-vault immutability choice** (governed vs finalized/ungoverned) + **dual timelock + an
  emergency guardian** with a 48–72h upgrade delay "sufficient to exit a malicious upgrade." The
  recognized industry middle ground = **separated multisigs + long timelock + emergency guardian,
  sized to TVL**, plus a **staged ossification** commitment (start upgradeable, renounce on a
  published timeline). **STEAL — this is exactly our situation.**
- **Diamond-specific caution:** EIP-2535's shared-storage + no-revocation means a malicious or
  compromised upgrade is **permanent**. This is the surface users now price against, and the
  reason a freeze commitment has real value.

## 3. Recommended ossification roadmap

**Per-area freeze/keep decision:**

| Surface | Pre-audit | Post-audit target |
| --- | --- | --- |
| Vault custody (deposit/withdraw, the only fund-moving paths) | upgradeable | **FREEZE** — per-selector cut-freeze **AND freeze the vault PROXY upgrade path**, not just renounce the shared impl (see ⚠️ below) |
| Core loan accounting invariants (principal/interest/collateral math) | upgradeable | **FREEZE** the invariant-bearing facets; keep a thin upgradeable wrapper if needed |
| Fee ceilings | upgradeable | **bounded-immutable** (hard-cap the max fee in frozen code, like the 25%-of-interest precedent) |
| Risk params / curation (#394), rate model (#400), oracle adapters (#392) | upgradeable | **bounded-upgradeable, NOT freely upgradeable** — curation must evolve, but a freely-swappable oracle/risk facet can drain custody indirectly (see ⚠️⚠️ below), so these stay behind timelock-asymmetry + bounded setters + guardian veto, never a free replace |
| Diamond-cut governance itself | timelock | **freeze the cut path too** (see ⚠️⚠️⚠️) + separated guardian/upgrade multisigs + 48–72h timelock; publish renounce timeline |

**⚠️ Vault proxy, not just impl — freeze the upgrade hook, don't renounce ownership.** Each user
vault is a UUPS **proxy**; its `_authorizeUpgrade` is gated to the Diamond (`onlyDiamond`).
Renouncing/freezing the shared impl is **not enough** — while the upgrade hook is live the Diamond
could repoint a proxy at a new impl and bypass the freeze. But the fix is **not** to *renounce the
Diamond's ownership* of the vault: the Diamond needs that authority for **normal custody
operations** (deposits/withdrawals are Diamond-mediated), so renouncing it would brick the vault.
The freeze must instead **permanently disable the `_authorizeUpgrade` path specifically** — a
one-way `upgradesFrozen` flag that makes `_authorizeUpgrade` revert forever, leaving all other
Diamond-mediated custody functions intact. Freeze the *upgrade hook*, keep the *operational
owner*.

**⚠️⚠️ Oracle/risk freeze coupling (the load-bearing correction).** "Custody can't be changed" is
**not honest if oracle adapters and risk curation stay *freely* upgradeable** — a malicious or
compromised oracle swap can report a false price, drive a position to liquidatable, and **drain
collateral without ever touching a custody selector**. So the freeze claim must bound the *price/
risk* surface too: oracle adapters and risk params stay *bounded-upgradeable* (timelock + guardian
veto + range-checked setters), never a free facet replace. The honest claim is "custody **and the
price/risk inputs that move custody** can only change behind a guardian-vetoable timelock," not
"custody is frozen while the oracle is a free hot-swap."

**Mechanisms to add:**
1. **Per-selector cut-freeze — including the cut path itself.** Extend the diamond-cut path so
   chosen selectors (custody, core accounting) can be **permanently** removed from future cuts,
   one-way and timelocked. **⚠️⚠️⚠️ Critical:** a freeze enforced *only inside `DiamondCutFacet`*
   is **bypassable** — the timelock could cut in a *new* `DiamondCutFacet` that ignores the freeze
   registry. So the freeze must also cover the **cut machinery's own selectors** (the freeze must
   make `diamondCut`/the freeze-enforcing selector un-replaceable for the frozen set), or it isn't
   a freeze. This is what makes "custody can't be changed" a *provable* claim, not a promise.
2. **Diamond-level guardian-pause** — give the core lending surface the same guardian fast-pause
   the cross-chain contracts already have (`GuardianPausable` pattern): guardian can pause, only
   owner (via timelock) can unpause, and **the guardian can never alter custody** — only halt.
   Closes the asymmetry where cross-chain has a guardian but core lending doesn't.
3. **Published staged-ossification commitment** — an honest, dated roadmap: "upgradeable now
   (pre-audit safety valve) → freeze custody + core accounting after audit N → separated
   guardian/upgrade multisigs with a 48–72h timelock throughout." Framed truthfully so the
   upgradeability is presented as a temporary, time-bounded patch lever.

## 4. Is the immutability guarantee a worthwhile user value-add?

**Yes — but only honestly, and only post-audit.** Pre-audit, claiming immutability would be
either false (we can still cut) or reckless (no bug fix). Post-audit, a **provable per-selector
freeze on custody** is a genuine differentiator: "no upgrade can ever move your collateral" is
exactly the guarantee users now price for after several permanent-malicious-upgrade incidents.
The minimum we'd freeze to claim it honestly = the vault custody paths + the core accounting
invariants **+ the cut path that protects them + the vault proxy upgrade authority**. Curation
(caps, allocation) can stay freely replaceable, but the **price/risk inputs that can move custody
indirectly** (oracle adapters, risk params) must be **bounded-upgradeable** (timelock + guardian
veto + range-checked setters), not free hot-swaps — otherwise the "custody can't change" claim is
defeated by a malicious oracle. That's the corrected frozen-core / *bounded*-periphery split.

## 5. Relationship + sequencing

Cross-cutting — frames every other card (each adds a facet to the upgradeable core). Connects to
the **#394 governance gap** (no quorum today): the bounded-steward + timelock-asymmetry + guardian
answer there is the same governance fabric the ossification roadmap rides on. **Sequence:** the
guardian-pause add is independently shippable now (pure safety upside); the per-selector freeze
+ published roadmap land **post-audit** (freezing pre-audit code is premature).

## 6. Spin-off implementation issues

1. **Diamond-level guardian-pause** — extend the `GuardianPausable` pattern to the core Diamond
   (guardian pause / owner-timelock unpause; never alters custody). Shippable pre-audit.
2. **Per-selector cut-freeze mechanism** — one-way, timelocked permanent selector removal from
   future cuts. Built pre-audit, *exercised* post-audit on custody/accounting selectors.
3. **Published ossification roadmap** (docs + governance commitment) — post-audit.

## 7. Sources

Our `VaipakamDiamond`/`DiamondCutFacet`/`GuardianPausable`/`VaipakamTimelock` anchors + the
minimal-immutable-core, fully-immutable, and staged-ossification governance precedents (generic;
URLs in working notes).
