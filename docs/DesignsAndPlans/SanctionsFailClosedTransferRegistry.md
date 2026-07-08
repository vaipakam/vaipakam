# Fail-closed position-NFT movement via a confirmed-flagged-wallet registry (#1123)

**Status:** design (design-doc-first per the standing directive) — revised after Codex round 1
**Depends on / unblocks:** prerequisite for the simplified S10 marker (#1006 / PR #1122)
**Related:** #821, #832 (frozen-not-seized), #1006 (S10 fail-closed release)

---

## 1. Problem

The position-NFT transfer restriction (`VaipakamNFTFacet.transferFrom` /
`safeTransferFrom` → `_assertTransferNotSanctioned(from, to)`) screens both
parties through the **fail-open** `LibVaipakam._assertNotSanctioned`. Fail-open
means: while the sanctions oracle is **unreachable** (outage), the screen lets
the movement through.

That single fail-open window is the root cause of the two unresolved S10
laundering classes Codex surfaced on PR #1122:

- **Multi-flagged-holder chain (r3 F1).** Flagged A holds a position with frozen
  proceeds → moves it to flagged B *during an outage* → after A de-lists, B moves
  it to a clean wallet C *during a second outage* → C claims. A single
  frozen-claimant address per side can track only one of {A, B}; whichever it
  drops re-opens the laundering path.
- **Cure provenance (r3 F3).** A flagged holder's fallback-entry marker cannot be
  safely cleared on cure without knowing whether the position moved to an
  unrelated holder — again only possible because a flagged holder can move a
  position during an outage.

Both dissolve if a **confirmed-flagged wallet cannot move its position during an
outage**. Then the holder recorded at a close-out park is still the holder at
claim time, so S10's marker collapses to a single first-write address with no
cure-clear.

The restriction can't self-heal from the movement itself: the very move it would
block reverts, so it can't persist the flag for a future outage (a revert rolls
back any write, Codex r1 P2). The flag must be **persisted out-of-band, on
non-reverting oracle-up paths**, and consulted **fail-closed** during an outage.

## 2. Non-goals

- Not seizing or redirecting funds (the #821/#832 frozen-not-seized policy
  stands). This only restricts **movement of the position NFT**.
- Not gating mint / burn / status updates *in general*, nor protocol-internal
  settlement/consolidation moves — those must still complete for a flagged party
  at a Tier-2 close-out. The scope is exactly the **user-initiated
  position-MOVEMENT surface** (see §3.4), which includes sale-vehicle migrations
  that happen to be implemented via burn+mint.

## 3. Design

### 3.1 Storage

Append to `LibVaipakam.Storage`:

```solidity
// #1123 — wallets CONFIRMED sanctions-flagged from an AUTHORITATIVE (oracle-up)
// read. Consulted FAIL-CLOSED by the position-movement restriction so a flagged
// wallet cannot move a position during an oracle outage. Mutated ONLY from strict
// (fail-closed) reads (§3.2); cleared on a confirmed de-list.
mapping(address => bool) sanctionsConfirmedFlagged;
```

A plain bool set suffices: the movement screen needs only "is this a
confirmed-flagged wallet?" (append-only pre-live; no migration).

### 3.2 A strict (fail-closed) read for every registry MUTATION (Codex r1 P1 #140)

`isSanctionedAddress` is fail-open (oracle unset/reverting ⇒ `false`), so it must
**never** drive a registry write — a fail-open read during an outage would let a
mutation *clear* a still-flagged wallet. Introduce a tri-state authoritative read:

```solidity
enum SanctionsRead { Clean, Flagged, Unavailable }

// Strict read used ONLY for registry mutation. Folds in the recovery-ban leg
// (vaultBannedSource) exactly as isSanctionedAddress, but returns Unavailable
// (never a silent false) whenever the oracle is unset or any required call
// reverts. Registry writes act ONLY on a definitive Clean/Flagged.
function sanctionsStatus(address who) internal view returns (SanctionsRead);
```

- **Register** a wallet ⟺ `sanctionsStatus(who) == Flagged`.
- **Clear** a wallet ⟺ `sanctionsStatus(who) == Clean`.
- `Unavailable` ⇒ **no mutation** (leave the registry untouched — never clear on
  an unconfirmed read).

### 3.3 Population — record on every non-reverting oracle-UP flag observation

The registry is populated where the protocol **already observes a wallet flagged
with the oracle reachable, on a path that does NOT revert**. There is **no
population from the movement-screen itself** — its flagged branch reverts and
would roll the write back (Codex r1 P2 #115).

1. **`recordFrozenClaimant`, keyed to the CURRENT HOLDER (primary, load-bearing —
   Codex r2 P1 #99, superseding r1 P2 #80).** The registry must record the party
   that must not move the position — the **sanctioned current position-NFT
   holder** — which is exactly the `intendedClaimant` argument
   `LibSanctionedLock.recordFrozenClaimant(s, loanId, side, intendedClaimant)`
   already keys on. Register there (`sanctionsConfirmedFlagged[intendedClaimant] =
   true` in its affirmative-flag branch).

   Do **NOT** register inside the vault-owner-keyed park helpers
   (`depositLocked` / `getOrCreateVaultLocked` / `end`): for a
   transferred-and-flagged position those helpers receive the STORED party (e.g.
   `loan.borrower`), not the flagged current holder — registering their argument
   would record the wrong (often clean) wallet and miss the flagged one
   (`LibCloseoutFreeze.freezeOrPayBorrowerSurplus` is the concrete case: it
   branches on `isSanctionedAddress(currentHolder)` but calls
   `depositLocked(s, loan.borrower, …)`). After the S10 threading, **every**
   close-out freeze site already calls `recordFrozenClaimant` with the current
   holder (default, HF/split/internal-match liquidation, fallback distribution,
   swap-to-repay, preclose, early-withdrawal), so this single hook covers them
   all with the correct party. No extra oracle call — the flag was already read to
   decide the park.

2. **`LibConsolidation.consolidateToHolder` skip-not-block branch (Codex r2 P2
   #93).** In Tier-2 close-out mode this observes a flagged current holder
   (`isSanctionedAddress(current)`) and returns `Skipped` **without reverting** —
   another non-reverting oracle-up observation. Register `current` there before
   the skip return, so a holder whose consolidation is skipped (funds route via
   the claim path) is still barred from moving the position during an outage.

3. **Permissionless `refreshSanctionsFlag(address who)` (operational + de-list).**
   A new `ProfileFacet` entry, callable by anyone:
   - Uses the **strict** `sanctionsStatus` (§3.2). `Unavailable` ⇒ revert
     `SanctionsOracleUnavailable` (never mutate on a non-authoritative read).
   - `Flagged` ⇒ `sanctionsConfirmedFlagged[who] = true`.
   - `Clean` ⇒ `delete sanctionsConfirmedFlagged[who]` (**de-list**).
   - Emits `SanctionsFlagRefreshed(who, flagged)`.

   The canonical way to (a) proactively register a listed wallet before any
   outage and (b) lift the restriction once a wallet is de-listed.

4. **Opportunistic clear on an authoritative-clean movement (self-heal).** When
   the movement screen (§3.4) runs with `sanctionsStatus(party) == Clean` (strict
   `Clean`, not fail-open), it may `delete sanctionsConfirmedFlagged[party]`. This
   is a non-reverting branch (a clean party's move is allowed), so the write
   persists. Only a strict `Clean` clears — never `Unavailable`.

### 3.4 Consumption — one fail-closed helper on the whole movement surface (Codex r1 P1 #162)

Centralize the check in `LibVaipakam.assertPositionMoveNotSanctioned(from, to)`
(mutating — it may self-heal-clear per §3.3.4), and call it from **every
user-initiated position-movement path**, not just the ERC-721 entrypoints:

- `VaipakamNFTFacet.transferFrom` / `safeTransferFrom` (both overloads);
- the **lender-position sale-vehicle migrations** (`LibLoan.migrateLenderPosition`)
  — BOTH distinct entry paths: `EarlyWithdrawalFacet.sellLoanViaBuyOffer` (direct
  swap-in) AND the accepted-sale completion path
  (`_completeLoanSaleImpl` / `completeLoanSaleInternal`), each today gated only by
  the fail-open `_assertNotSanctioned` (Codex r2 P2 #212);
- the **borrower-position obligation transfer** (Codex r2 P1 #143):
  `PrecloseFacet.transferObligationViaOffer` → `LibLoan.migrateBorrowerPosition`
  is a burn/mint live-position move (into AND out of the borrower slot) and MUST
  also call `assertPositionMoveNotSanctioned(from, to)`;
- audited at implementation via grep for `migrateLenderPosition` /
  `migrateBorrowerPosition` / `_assertNotSanctioned` across movement sites, to
  confirm the set is complete. Mint-at-origination and burn-at-terminal are NOT
  movements between users and stay exempt.

Per party, `assertPositionMoveNotSanctioned` behaves by oracle state
(resolving the P2 #129 three-way):

```
oracle UNSET:                      // no sanctions regime at all
    ignore the registry → allow    // matches "oracle unset = screening disabled"
oracle SET + reachable:            // authoritative
    Flagged  → sanctionsConfirmedFlagged[party]=true; revert Sanctioned
    Clean    → delete sanctionsConfirmedFlagged[party] (self-heal); allow
oracle SET + unreachable (outage):
    sanctionsConfirmedFlagged[party] → revert Sanctioned   // FAIL-CLOSED
    else                             → allow                // can't confirm; not previously flagged
```

Note the write in the `reachable + Flagged` branch is inside the reverting path
and therefore does NOT persist — that is fine, because population is done by the
non-reverting parks/refresh (§3.3); the line is shown only to describe intent and
will be **omitted** in code (Codex r1 P2 #115). "Oracle unset ⇒ ignore registry"
is the deliberate resolution of P2 #129: disabling the oracle disables the whole
sanctions regime (existing semantics), so stale registry entries must not keep
blocking; re-enabling an oracle re-activates them, and `refreshSanctionsFlag`
can clear any that are since de-listed.

### 3.5 Recovery-ban interaction

`sanctionsStatus` folds in the `vaultBannedSource` recovery-ban leg (same as
`isSanctionedAddress`), so a recovery-banned wallet registers/clears correctly and
the strict read reverts `Unavailable` if the banned-source oracle call fails
(never silently clears — Codex r1 P1 #140).

### 3.6 Knock-on: S10 marker simplification (in the reworked #1122)

With movement fail-closed for confirmed-flagged wallets:
- A wallet recorded as the frozen claimant at a park **cannot move its position
  during an outage**, so it is still the holder at claim time → the single
  first-write address is correct; no chain forms (**r3 F1 dissolved**).
- An abandoned fallback episode's flagged holder cannot have become an unrelated
  later holder → the cure-clear (and its unsound `heldForLender>0` proxy) is
  **removed entirely** (**r3 F3 + round-1 P2 dissolved**).
- Reworked #1122: first-write `recordFrozenClaimant` (now also registering via
  §3.3.1), three fail-closed release gates kept, **cure-clear removed**, **F2
  fixed** (marker wired into `RefinanceFacet`'s old-lender payoff).

## 4. Residual limitation (stated explicitly)

The registry blocks a flagged wallet's outage move only if the wallet was
recorded **before** the outage. A wallet flagged *and* moved within a single
uninterrupted outage — never observed flagged with the oracle up (never hit a
park and no `refreshSanctionsFlag`) — is not in the registry, so its outage move
still succeeds. Strictly smaller than today's window; S10-relevant wallets (those
with frozen proceeds) are always registered at their park. Fully closing it would
require fail-closed movement for *all* wallets during any outage (bricks the
secondary market on every oracle blip) — rejected as disproportionate.

## 5. ABI / deploy

- New `ProfileFacet.refreshSanctionsFlag(address)` + `SanctionsFlagRefreshed`
  event → facet-addition checklist (DeployDiamond, HelperTest, SelectorCoverage,
  frontend/keeper ABI export as applicable, indexer if it consumes the event).
- `_assertTransferNotSanctioned` → replaced by the shared mutating
  `assertPositionMoveNotSanctioned` (no longer `view`). Confirm the migration
  call sites are non-view (they are — they mutate loan/NFT state).
- Storage append only (pre-live, no migration).

## 6. Test plan

- Oracle up + flagged party → move reverts (`transferFrom` AND `sellLoanViaBuyOffer`).
- Oracle up + clean party → move succeeds AND any stale registry entry cleared
  (strict-clean self-heal).
- **Register (via a park or `refreshSanctionsFlag`) while up, then outage → move
  of the registered wallet reverts via EACH movement path** — the load-bearing
  assertions (P1 #162/#143 + the core guarantee): `transferFrom`,
  `sellLoanViaBuyOffer`, the accepted-sale **completion** path
  (`completeLoanSaleInternal`, r2 P2 #212), AND borrower-side
  `transferObligationViaOffer` → `migrateBorrowerPosition` (r2 P1 #143).
- Outage + never-registered wallet → move succeeds (no over-block).
- Oracle **unset** with a pre-existing registry entry → move succeeds (registry
  ignored; P2 #129).
- `refreshSanctionsFlag`: sets on `Flagged`; clears on `Clean`; reverts
  `SanctionsOracleUnavailable` on `Unavailable` (unset/reverting). A refresh
  during an outage does NOT clear a still-flagged wallet (P1 #140).
- `recordFrozenClaimant` registers the flagged CURRENT HOLDER (r2 P1 #99): a
  transferred-position freeze where the current holder is flagged but the stored
  vault owner is clean registers the *holder*, not the owner — assert the holder
  is in the registry after a default / liquidation / fallback / swap-to-repay /
  preclose close-out.
- `LibConsolidation.consolidateToHolder` skip-not-block on a flagged holder
  registers that holder (r2 P2 #93).
- Mint-at-origination / burn-at-terminal / internal settlement unaffected while a
  party is registered.

## 7. Open decisions for Codex round 2

1. Confirm the movement surface enumeration in §3.4 is complete — is
   `migrateLenderPosition` the only burn/mint position-move, or does obligation
   transfer / any borrower-position re-anchor also need the gate? (Grep-audit to
   be done at implementation; called out here for review.)
2. `sanctionsStatus` tri-state helper vs. a narrower
   `assertNotSanctionedFailClosed`-style pair — the tri-state is needed because
   registry *clears* require a definitive `Clean` (not just "did not revert").
   Confirm the enum approach.
3. Registry as `bool` vs epoch/timestamp — leaning `bool` (de-list is explicit via
   the oracle; an auto-expire would re-open the outage window on a timer).
