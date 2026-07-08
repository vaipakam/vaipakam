# Fail-closed position-NFT transfers via a confirmed-flagged-wallet registry (#1123)

**Status:** design (design-doc-first per the standing directive)
**Depends on / unblocks:** prerequisite for the simplified S10 marker (#1006 / PR #1122)
**Related:** #821, #832 (frozen-not-seized), #1006 (S10 fail-closed release)

---

## 1. Problem

The position-NFT transfer restriction (`VaipakamNFTFacet.transferFrom` /
`safeTransferFrom` → `_assertTransferNotSanctioned(from, to)`) screens both
parties through the **fail-open** `LibVaipakam._assertNotSanctioned`. Fail-open
means: while the sanctions oracle is **unreachable** (outage), the screen lets
the transfer through.

That single fail-open window is the root cause of the two unresolved S10
laundering classes Codex surfaced on PR #1122:

- **Multi-flagged-holder chain (r3 F1).** Flagged A holds a position with frozen
  proceeds → transfers to flagged B *during an outage* → after A de-lists, B
  transfers to a clean wallet C *during a second outage* → C claims. A single
  frozen-claimant address per side can track only one of {A, B}; whichever it
  drops re-opens the laundering path.
- **Cure provenance (r3 F3).** A flagged holder's fallback-entry marker cannot be
  safely cleared on cure without knowing whether the position moved to an
  unrelated holder — which again is only possible because a flagged holder can
  transfer during an outage.

Both dissolve if a **confirmed-flagged wallet cannot transfer its position during
an outage**. Then the holder recorded at a close-out park is still the holder at
claim time, so S10's marker collapses to a single first-write address with no
cure-clear.

The current transfer restriction can't self-heal here: the very transfer it would
block reverts, so it can't persist the flag for a future outage (a revert rolls
back any write). The flag must be **persisted out-of-band, while the oracle is
up**, and consulted **fail-closed** during an outage.

## 2. Non-goals

- Not seizing or redirecting funds (the #821/#832 frozen-not-seized policy
  stands). This only restricts **movement of the position NFT**.
- Not gating mint / burn / protocol-internal position moves (settlement,
  consolidation) — those already bypass the transfer screen so Tier-2 close-outs
  complete. Registry consultation is scoped to the same external transfer
  entrypoints the current screen covers.
- Not changing claim-side behaviour beyond enabling the S10 simplification (that
  lands in the reworked #1122).

## 3. Design

### 3.1 Storage

Append to `LibVaipakam.Storage`:

```solidity
// #1123 — wallets CONFIRMED sanctions-flagged while the oracle was reachable.
// Consulted FAIL-CLOSED by the position-NFT transfer restriction so a flagged
// wallet cannot move a position during an oracle outage. Cleared on a
// confirmed de-list.
mapping(address => bool) sanctionsConfirmedFlagged;
```

A plain bool set is sufficient: the transfer screen needs only "is this wallet a
confirmed-flagged wallet?" (append-only pre-live; no migration).

### 3.2 Population — record on every oracle-UP flag observation (non-reverting)

The registry is populated wherever the protocol **already observes a wallet
flagged with the oracle reachable, on a path that does NOT revert**:

1. **S10 close-out parks (primary, load-bearing).**
   `LibSanctionedLock.recordFrozenClaimant(...)` already computes
   `isSanctionedAddress(intendedClaimant)` and records the frozen claimant when
   true. Extend it to also set `sanctionsConfirmedFlagged[intendedClaimant] =
   true` in that same branch. This is exactly the set of wallets whose proceeds
   are frozen — i.e. the wallets that must not transfer their position during an
   outage. Non-reverting (the park continues), oracle-up (the flag was
   affirmative), so it is a sound write point.

2. **Permissionless `refreshSanctionsFlag(address who)` (operational + de-list).**
   A new `ProfileFacet` entry, callable by anyone (keeper/operator/user):
   - Requires the oracle to be **set and reachable** (fail-closed: revert
     `SanctionsOracleUnavailable` if unset or the read reverts) — the registry
     must only be mutated from an authoritative read.
   - `isSanctioned(who)` true → `sanctionsConfirmedFlagged[who] = true`.
   - `isSanctioned(who)` false → `delete sanctionsConfirmedFlagged[who]`
     (**de-list**: the wallet is proven clean, so the restriction lifts).
   - Emits `SanctionsFlagRefreshed(who, flagged)` for indexers/operators.

   This gives operators a way to proactively register a wallet the moment it is
   listed (before any outage) and the canonical way to lift the restriction once
   a wallet is de-listed. It also lets a wrongly-registered wallet clear itself
   once the oracle reports it clean.

3. **Opportunistic clear on any oracle-up clean transfer (optional, cheap).**
   When `_assertTransferNotSanctioned` runs with the oracle **up** and finds a
   party clean, it may `delete sanctionsConfirmedFlagged[party]`. Keeps the
   registry from pinning a de-listed wallet that transacts before anyone calls
   `refreshSanctionsFlag`. (Decision for Codex: include, or keep clears explicit
   via `refreshSanctionsFlag` only? Leaning include — it is a cheap
   self-heal and avoids a stuck restriction.)

### 3.3 Consumption — fail-closed transfer restriction

`_assertTransferNotSanctioned(from, to)` becomes (no longer `view` — it may
write per §3.2.3):

```
for party in {from, to}:
    if oracle is set AND reachable:
        flagged = isSanctioned(party)            // authoritative
        if flagged: sanctionsConfirmedFlagged[party] = true; revert Sanctioned
        else:       delete sanctionsConfirmedFlagged[party]   // §3.2.3 self-heal
    else:                                        // oracle unset or outage
        if sanctionsConfirmedFlagged[party]: revert Sanctioned  // FAIL-CLOSED
        // unknown wallet during an outage → allow (can't confirm; not previously flagged)
```

Semantics:
- **Oracle up:** authoritative — identical outcome to today, plus it keeps the
  registry in sync (records a newly-flagged party, clears a de-listed one).
- **Oracle outage:** a wallet previously *confirmed* flagged is blocked
  (fail-closed); a wallet never recorded is allowed (we cannot confirm it, and
  blocking all transfers during any oracle blip would over-react — matching the
  fail-open rationale for ordinary interactions).
- **Oracle unset (retail pre-oracle window):** registry is empty → no-op, exactly
  as today.

This is strictly stronger than the current screen (never weaker): every wallet
blocked today is still blocked, plus confirmed-flagged wallets stay blocked
through an outage.

### 3.4 Recovery-ban interaction

`isSanctionedAddress` already treats a wallet whose `vaultBannedSource` is flagged
as sanctioned. The `refreshSanctionsFlag` / park population call
`isSanctionedAddress` (which folds in the recovery-ban leg), so a recovery-banned
wallet is registered too. No separate handling.

### 3.5 Knock-on: S10 marker simplification (in the reworked #1122)

With transfers fail-closed for confirmed-flagged wallets:
- A wallet recorded as the frozen claimant at a close-out park **cannot transfer
  its position during an outage**, so it is still the holder at claim time. The
  single first-write address is correct — no chain of distinct flagged holders
  can form (**r3 F1 dissolved**).
- An abandoned fallback episode's flagged holder cannot have become an unrelated
  later holder, so the cure-clear (and its unsound `heldForLender>0` provenance
  proxy) can be **removed entirely** (**r3 F3 + round-1 P2 dissolved**).
- The reworked #1122 therefore: keeps first-write `recordFrozenClaimant`
  (now also populating the registry), keeps the three fail-closed release gates,
  **removes** both cure-clear sites, and additionally **fixes F2** (wire the
  marker into `RefinanceFacet`'s old-lender payoff).

### 3.6 Scope of transfer entrypoints

Only the three external ERC-721 transfer entrypoints already screened:
`transferFrom`, `safeTransferFrom` (both overloads). Mint / burn / status /
protocol-internal `LibERC721` moves stay unscreened (Tier-2 completion). Approvals
are not transfers and are unaffected (a flagged wallet can approve, but the
eventual `transferFrom` is screened).

## 4. Residual limitation (state explicitly)

The registry only blocks a flagged wallet's outage transfer if the wallet was
recorded **before** the outage. A wallet flagged *and* transferred within a
single uninterrupted outage (never observed flagged with the oracle up, e.g. it
never hit a close-out park and no one called `refreshSanctionsFlag`) is not in
the registry, so its outage transfer still succeeds. This is a strictly smaller
window than today, and the S10-relevant wallets (those with frozen proceeds)
are always recorded at their park. Fully closing it would require a fail-closed
transfer for *all* wallets during any outage (bricks the secondary market on
every oracle blip) — rejected as disproportionate. Documented, not silently
accepted.

## 5. ABI / deploy

- New `ProfileFacet.refreshSanctionsFlag(address)` selector + `SanctionsFlagRefreshed`
  event → facet-addition checklist (DeployDiamond, HelperTest, SelectorCoverage,
  frontend/keeper ABI export as applicable, indexer if it consumes the event).
- `_assertTransferNotSanctioned` loses `view` (now mutating) — confirm no
  `view`/`staticcall` caller depends on it (it is `private`, called only from the
  non-view transfer entrypoints).
- Storage append only (pre-live, no migration).

## 6. Test plan

- Oracle up + flagged party → transfer reverts AND `sanctionsConfirmedFlagged`
  set.
- Oracle up + clean party → transfer succeeds AND registry entry cleared
  (self-heal).
- **Register while up, then outage → transfer of the registered wallet reverts
  (fail-closed)** — the load-bearing assertion.
- Outage + never-registered wallet → transfer succeeds (no over-block).
- `refreshSanctionsFlag`: sets on flagged; clears on de-list; reverts
  `SanctionsOracleUnavailable` when the oracle is unset/reverting.
- De-list flow: registered → `refreshSanctionsFlag` after de-list → transfer
  succeeds again.
- S10 park populates the registry (a close-out that freezes a flagged holder
  also registers them).
- Mint / burn / internal moves unaffected while a party is registered.

## 7. Open decisions for Codex review of this doc

1. §3.2.3 opportunistic clear on clean transfer — include (self-heal) or keep
   clears explicit via `refreshSanctionsFlag` only?
2. Registry as `bool` vs an epoch/timestamp (to support "auto-expire after N days
   without re-confirmation")? Leaning `bool` — de-list is explicit via the oracle,
   and an auto-expire would re-open the outage window on a timer.
3. Should `refreshSanctionsFlag` be permissionless (proposed) or keeper/operator
   gated? Leaning permissionless — it only ever mirrors the authoritative oracle,
   cannot set a flag the oracle doesn't confirm, and de-list is likewise
   oracle-gated, so there is no griefing surface.
