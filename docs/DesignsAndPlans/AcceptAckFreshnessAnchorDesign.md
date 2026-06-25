# Accept-Ack Freshness Anchor — Design (#730)

**Status:** Draft for Codex design review (pre-code). Pre-live platform; the
progressive-risk gate this protects is default-OFF and not enabled on any live
deployment.

## 1. Problem

#671's progressive-risk gate (#728) unified the #662 anti-phishing acceptance
acknowledgement with the #671 illiquid-pair consent: on an illiquid accept, the
acceptor's signed `AcceptTerms` acknowledgement **substitutes** for a separately
recorded standing illiquid-pair consent, so the acceptor never double-signs
(`LibRiskAccess.assertAcceptorMayTransact`).

A governance **risk-terms change** must *re-lock* that substitution — exactly as
it re-locks a standing consent — so a user re-acknowledges the new terms. The
re-lock needs a **freshness anchor** the acceptance signature binds, with one
hard property:

> **The anchor must be UNFORGEABLE by a pre-signing interface.** A malicious UI
> must not be able to induce a victim to sign an `AcceptTerms` that becomes
> "fresh" for a *future* terms version, then submit it after the change activates
> (once the victim re-affirms only their tier).

#730 iterated several anchors, each defeated (see PR #736 history):

| Anchor | Why it fails |
| --- | --- |
| Numeric `currentRiskTermsVersion`, `>=` | A future version (`max`) stays fresh across every bump. |
| Numeric version, exact `==` | The counter is **predictable** — a UI pre-stamps `N+1`; it activates on the next bump. |
| Block-entropy hash (`prevrandao` + prior blockhash) at bump | **Predictable on sequencer-controlled L2s** / when the prior block hash is already known to the bump's includer. |
| Governance-supplied hash in `bumpRiskTermsVersion(bytes32)` calldata | When `ADMIN_ROLE` is the **governance timelock** (post-handover path), the hash sits in the **public queued calldata** for the whole delay window — a UI reads it and pre-stamps. |

**Root cause:** any anchor that is *(a) predictable*, *(b) derived from
sequencer-influenceable block data*, or *(c) present in scheduled (timelock)
calldata before activation* is knowable to a pre-signer. The anchor must be a
secret that becomes public **only at the instant of activation**.

A secondary defect (PR #736 r5 P1 #2): changing `bumpRiskTermsVersion()`'s
signature mints a new selector but does not, by itself, remove the **legacy
no-arg selector** on an upgraded diamond. If the old selector stays routed,
governance could call it and advance the version **without** updating the hash,
re-opening the gap.

## 2. Threat model (precise)

Preconditions for the attack this design must close:
1. Progressive-risk gate **ENABLED** (`riskAccessGateEnabled`) — default OFF.
2. `ADMIN_ROLE` (terms-bump authority) is a **transparent timelock** — the
   post-mainnet-handover posture. (Testnets stay deployer-owned with no
   timelock; the platform is pre-live, so this posture exists *nowhere* today.)
3. A malicious accept UI the victim uses.
4. The victim signs an illiquid `AcceptTerms` and later re-affirms their tier.

The attack: UI learns the next anchor before activation (from timelock calldata),
gets the victim to pre-stamp it, and submits the stale ack after activation.

**The anchor must hold even under (2).** That is the bar.

## 3. Requirements

- **R1 — Unforgeable-before-activation:** the anchor value must be unknowable to
  anyone but the terms publisher until the bump activates, even when the bump is
  scheduled through a transparent timelock.
- **R2 — On-chain verifiable:** the gate compares the signed anchor to a single
  stored word, cheaply.
- **R3 — No double-sign in the common case:** a normal illiquid accept (no terms
  change pending) still works with the single acceptance signature — preserve the
  #662⇄#671 unification.
- **R4 — Re-lock on change:** after a terms change a pre-change ack is rejected;
  the user re-signs against the new terms to proceed (recoverable).
- **R5 — EIP-170:** OfferAcceptFacet is at the ceiling (62 B headroom). The ack
  carries at most one anchor field (the `bytes32` already added in #736).
- **R6 — Upgrade-safe:** no path can advance the version without the anchor, on a
  fresh deploy *or* an upgrade (close r5 P1 #2).

## 4. Options

### A. Governance-supplied hash (current #736) — REJECTED
Fails R1 under a timelock (calldata exposure).

### B. Drop ack-substitution; always require a standing illiquid-pair consent
Robust (standing consent is contract-written, version-anchored, unforgeable) and
simple, but **reverts the #662⇄#671 unification** — every illiquid accept needs a
separate one-time consent tx. Fails R3. Rejected (the unification was the
deliberate #728 product decision).

### C. Commit–reveal terms publishing (asymmetric) — RECOMMENDED
Mirror the codebase's existing **PAUSER (fast/guardian) / UNPAUSER
(slow/timelock)** asymmetry:

- **Commit (slow / timelocked):** `commitRiskTermsBump(bytes32 commitment)` where
  `commitment = keccak256(abi.encode(newTermsHash, salt))`. The commitment is a
  **hiding** commitment — in the timelock's public queue it reveals *nothing*
  about `newTermsHash` (the `salt` is the governance secret). Stored as
  `pendingRiskTermsCommitment`.
- **Reveal (fast / operational):** `revealRiskTermsBump(bytes32 newTermsHash,
  bytes32 salt)` — requires `keccak256(abi.encode(newTermsHash, salt)) ==
  pendingRiskTermsCommitment`, then atomically: `++currentRiskTermsVersion`,
  `currentRiskTermsHash = newTermsHash`, clear the commitment. Held by an
  operational publisher role (see §5), NOT the slow timelock — so the secret is
  exposed only in the reveal tx's brief mempool window (~seconds), and the reveal
  **is** the activation (atomic), not a multi-day pre-exposed queue.

This satisfies R1: the future hash is never in scheduled calldata; it surfaces
only at activation. The residual exposure shrinks from the **timelock delay
(days)** to the **reveal tx's mempool time (seconds)**, during which a pre-signer
would have to both observe the reveal *and* get the victim to sign — bounded
further by the ack's deadline + single-use nonce + the anti-phishing typed prompt.
Optionally the reveal can be sent through a private mempool to remove even that.

Keeps the ack binding the single `bytes32 riskTermsHash` already in #736 (R2,
R5). Preserves the unification (R3). Re-locks on reveal (R4).

### D. Tier-anchor only + documented residual — REJECTED
The pre-#730 behaviour; finding D considered it insufficient. Doesn't meet R1/R4.

## 5. Recommended design (Option C) — detail

**Roles (mirrors PAUSER/UNPAUSER):**
- `commitRiskTermsBump` → `ADMIN_ROLE` (timelock-held post-handover): the
  governance *decision* to change terms is slow and reviewable.
- `revealRiskTermsBump` → a fast operational role. Reuse `RISK_ADMIN_ROLE` if its
  trust model is operational, else a new `RISK_TERMS_PUBLISHER_ROLE`. **Open
  question for review (Q1).**

**Storage (append-only tail):**
- `bytes32 pendingRiskTermsCommitment` (new).
- keep `currentRiskTermsVersion` (uint64), `currentRiskTermsHash` (bytes32),
  `acceptAckTermsHash` (bytes32) from #736.

**Guards:**
- `commit`: `commitment != 0`; overwrites any prior un-revealed commitment
  (a re-commit supersedes — supports cancelling a queued change).
- `reveal`: commitment must be set and match; `newTermsHash != 0` and
  `!= currentRiskTermsHash` (every change actually re-locks); clears the
  commitment so it can't be replayed.

**Gate:** unchanged from #736 — `acceptAckTermsHash == currentRiskTermsHash` (plus
the existing tier-anchor `>=`).

**Frontend:** unchanged from #736 — read `getCurrentRiskTermsHash()`, stamp it,
fail closed on a present-but-missing-getter skew. (Until the first commit/reveal
the hash is 0 and a zero-stamped ack is correct.)

**Upgrade safety (R6 / r5 P1 #2):**
- Fresh deploy routes only the new selectors (no legacy `bumpRiskTermsVersion()`).
- `ReplaceStaleFacets.s.sol` (the upgrade path) must **Remove** the legacy
  `bumpRiskTermsVersion()` selector when adding the commit/reveal selectors.
  Document in the facet-upgrade checklist. Since the bump is now two-step, the
  single-call `bumpRiskTermsVersion(bytes32)` from #736 is also removed (replaced
  by commit+reveal). **Open question (Q2):** keep a one-shot
  `bumpRiskTermsVersion(bytes32)` for non-timelock (EOA/multisig, pre-handover)
  admins as a convenience, gated so it's only usable when the caller is not the
  timelock? Leaning **no** (one mechanism is simpler and the commit/reveal works
  for EOAs too — they just call both in sequence).

**Tests:** the existing #730 gate tests (stale-ack, guessed-hash) carry over,
driving the bump via commit→reveal. Add: commit hides the hash (a stale ack
stamping the *committed* hash guess still fails — the commitment reveals nothing);
reveal mismatch reverts; double-reveal reverts; version can't advance without
reveal.

## 6. Open questions for review

- **Q1:** reveal role — reuse `RISK_ADMIN_ROLE` or add `RISK_TERMS_PUBLISHER_ROLE`?
  What is `RISK_ADMIN_ROLE`'s intended trust tier (operational vs timelock)?
- **Q2:** keep a one-shot `bumpRiskTermsVersion(bytes32)` for non-timelock admins,
  or commit/reveal only?
- **Q3:** is the reveal-mempool-window residual acceptable, or should the design
  mandate private-mempool reveal / a one-block commit-age minimum on reveal?
- **Q4:** should `commit` carry an explicit `expiry` so a never-revealed
  commitment can't linger indefinitely?

## 7. Rollout

Design review (Codex) → implement on PR #736 (supersede its single-call
governance hash) → contract + tests + ABI + frontend (mostly already in #736) →
Codex code review → merge. The selector-removal (R6) lands with the
implementation. None of this blocks any live deployment (gate is OFF, pre-live).

## 8. Resolution (as implemented — Codex #736 r5–r7)

- **Q1 (reveal role):** `revealRiskTermsBump` is gated on **`PAUSER_ROLE`** — the
  existing off-timelock guardian role that `TransferAdminToTimelock` deliberately
  does NOT migrate to the 48h timelock (unlike `ADMIN/ORACLE/RISK/VAULT_ADMIN`).
  `RISK_ADMIN_ROLE` could not be used: it IS migrated to the timelock, so a reveal
  queued through it would expose the secret for the delay (r7). The publisher's
  power is bounded — it can only reveal what `ADMIN` already committed, never
  choose the anchor — so reusing the guardian role is low-blast-radius and needs
  no new ops-role wiring.
- **Anchor is a SECRET, not the doc hash (r7):** `currentRiskTermsHash` is a fresh
  RANDOM secret (`termsAnchor`), committed as `keccak256(abi.encode(termsAnchor))`
  and revealed at activation. The terms *document* and its hash are published
  separately — a doc hash is public during governance review, so binding to it
  would be pre-stampable. (The salt-and-doc-hash two-value scheme from §5 is
  superseded: a single high-entropy secret is its own hiding preimage.)
- **Single-use anchors (r6):** a `riskTermsHashUsed` ledger makes every anchor
  single-use for the protocol's lifetime, so rolling terms A→B→A can't revive a
  stale A-period ack. The reveal also seeds the OUTGOING live anchor into the
  ledger (r7), covering an upgrade whose live anchor predates the ledger.
- **Q2 (legacy bump):** no one-shot `bumpRiskTermsVersion` is kept — commit/reveal
  is the only path. The legacy selectors are provably unrouted on every built
  diamond, enforced by `DeployDiamondIntegrationTest.
  test_DeployedDiamond_LegacyTermsBumpSelectorsUnrouted` (the concrete equivalent
  of a Remove migration; pre-live, no deployed diamond carries the selector).
- **Q3 (mempool residual):** accepted — the reveal exposes the secret only in its
  brief mempool window (vs. a multi-day timelock queue), and the reveal IS the
  activation. Private-mempool reveal is an optional operational hardening, not a
  contract requirement.
- **Q4 (commit expiry):** not added — a new commit supersedes an un-revealed one,
  and a lingering commitment is inert (it publishes nothing until revealed).
