## Thread — T-087 Sub 5 — Functional spec + Advanced UG additions (PR #<n>)

Closes out the T-087 umbrella (#438). Subs 1–4 shipped the contracts + dapp surface; this Sub 5 ships the documentation that captures the user-facing intent + operator runbook.

### What changes

**New `docs/FunctionalSpecs/VPFIDiscountSystem.md`**

Code-free spec covering the full user-facing intent of the VPFI discount system:

- The discount-rights value proposition.
- Tier table (defers literal numbers to live dapp; the on-chain table is governance-configurable).
- Canonical-side lifecycle: stake → TWA → min-history → effective-tier activation → optional pokeMyTier.
- Mirror-side lifecycle: tier propagation via Chainlink CCIP → mirror cache → cached-tier discount at settlement.
- Governance levers + bump semantics (`tierTableVersion`).
- Anti-gaming + anti-drain measures (TWA, min-history, consent-toggle not broadcasting, budget-gated broadcasts, de-dup gate).
- What stakers see across the dapp's surfaces.

The new spec complements the existing `CrossChainTierPropagation.md` (which covers the transport mechanics): this one is "what's the user-facing intent end-to-end", the existing one is "how does the cross-chain push work".

**Advanced UG — new "How VPFI Discounts Work" section**

Inserted before the existing "Treasury Buyback Flywheel" section in `apps/www/src/content/userguide/Advanced.en.md`. Covers:

- "Stake once, discount everywhere" mental model.
- Min-history gate (3 days default; what the user sees during the window).
- Time-weighted (30-day TWA; last 7d × 3, previous 23d × 1).
- Cross-chain propagation invisible to most users; surfaces `pokeMyTier()` for edge cases.
- Consent toggle + the recommended chain-after-disable pattern.
- Tier upgrades + unstakes + mirror staleness.

Plus an "Operator runbook — discount system maintenance" sub-section enumerating the post-deploy actions required for the cross-chain surface to actually work in production:

- Canonical: `VPFITokenFacet.setCanonicalVPFIChain(true)` (the Sub 1.C round-3 P2 #2 deferral that many fork operators trip on), broadcast budget top-up via `ProtocolBroadcastFacet.topUpBroadcastBudget()`.
- Mirrors: `RewardReporterFacet.setRewardMessenger`, `RewardReporterFacet.setBaseChainId`, `ConfigFacet.setMirrorTierMaxAgeSec`.
- Governance: expected broadcast burst on tier-table changes; pre-emptive budget top-up.

### Producer artifacts

Doc-only PR. No contract / ABI / selector changes.

### Indexer

The indexer's `check-event-coverage` script enforces only `state-change/loan-mutation` + `state-change/offer-mutation` categories. T-087's events (`TierPoked`, `ProtocolTierBroadcastSent`, `MirrorTierCacheWritten`, etc.) fall under different categories (`informational/*` or `state-change/mirror-tier-cache`) which aren't enforced. So no indexer changes are required by Sub 5; if state-side surfacing of mirror-tier propagation becomes a product need later, it lands as a separate task.

### Release notes

The final-day assembled release-notes file (`assemble.sh` over the unreleased fragments) is the operational step the operator runs at the next deploy cadence — not in scope for this code PR.

### Verification

- Doc renders correctly in the markdown preview.
- www tsc clean.

### Sub 5 + umbrella close-out

With this PR merged, the T-087 umbrella (#438) is fully shipped:

- **Sub 1** — Base contracts: TWA accumulator + tier resolution + mirror facet removal.
- **Sub 2** — CCIP wiring: TierUpdated + VersionBumped + protocol broadcast budget.
- **Sub 3** — Treasury buyback umbrella (#452): Sub 3.A/B/C/D + add-ons #472/#473/#474.
- **Sub 4 phase 1** — Tier-poke selector + EFFECTIVE_TIER hook + LenderDiscountCard polish (PR #482).
- **Sub 4 phase 2** — StakeVPFICTA dashboard component (PR #483).
- **Sub 5** — Functional spec + Advanced UG (this PR).
