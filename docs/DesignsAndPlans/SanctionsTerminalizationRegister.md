# Sanctions: register position holders at loan terminalization (#1006 follow-through)

Status: DRAFT for review · Owner: S10 (#1006) · Relates to: #1122, #1123

## 1. Problem

The S10 fail-closed release of sanctioned-locked proceeds (#1006) keys on a
per-loan **frozen-claimant marker** and a global **`sanctionsConfirmedFlagged`
registry** (#1123). A claim is blocked fail-closed when either the recorded
marker's party or the current claimant is **registered** and the oracle is
unavailable, so the freeze survives an outage.

Six Codex review rounds on #1122 converged the fund-leak (P1) class down to a
single recurring residual:

> A position holder who is **flagged at close-out while the oracle is UP** but is
> **never registered** in `sanctionsConfirmedFlagged`, then **claims during an
> oracle outage**, is released **fail-open**: the central claim gate reads
> `Unavailable + unregistered` and (correctly, to protect honest claimants) does
> not freeze.

The fix for any one occurrence is to **register the flagged holder at an
oracle-up observation before the claim**. Most close-outs already do this: their
**park** sites call `LibSanctionedLock.recordFrozenClaimantForLoan`, which
registers the holder when flagged. The residual is confined to the few
close-outs that write a `lenderClaims` / `borrowerClaims` row **without a park**:

- `ClaimFacet._distributeFallbackCollateral` — the no-retry / failed-retry
  fallback finalization (borrower collateral split).
- `ClaimFacet._distributeRetryProceeds` — the retry-swap distribution (a per-site
  stamp existed in r2 but was removed in r3 under the mistaken assumption the
  central claim gate fully covered it).
- `RepayPeriodicFacet.autoDeductDaily` — the final daily deduction
  (`durationDays == 0`) writes the buffer refund as a borrower claim.

Chasing these one Codex round at a time is **incomplete by construction**: any
future terminal path that writes a claim without a park re-opens the hole.

## 2. Invariant

> **Every code path that transitions a loan to a terminal state
> (`Repaid` / `Defaulted` / `Settled` / `InternalMatched`) MUST register both
> current position holders in `sanctionsConfirmedFlagged` when they are
> affirmatively flagged — an oracle-up observation — before any deferred
> `claimAsLender` / `claimAsBorrower` can run.**

With this invariant, the existing **central claim gate** (stamp the claimant +
fail-closed release check, added #1122 r3) becomes sufficient: a holder flagged
at any terminalization is registered there, so a later outage claim reads
`Unavailable + registered` and freezes. No per-claim-creation-site stamping is
required, and the residual shrinks to the platform-wide, accepted
"flagged **and** never observed within one uninterrupted outage" window (seeded
operationally by the permissionless `refreshSanctionsFlag`).

## 3. Mechanism

### 3.1 Shared host

Add one host method (EIP-170: the registry-aware `sanctionsStatus` machinery is
too heavy to inline into the tight close-out facets):

```
EncumbranceMutateFacet.registerTerminalHolders(uint256 loanId)   // onlyDiamondInternal
  → LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, true)   // lender side
  → LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, false)  // borrower side
```

This is exactly the existing `recordSanctionsFrozenClaimantBoth(loanId)` host —
so **no new selector is required**; the work is to guarantee it (or an equivalent
park) runs on every terminal path. `recordFrozenClaimantForLoan` is:

- **registry-aware** — registers only on an authoritative Flagged read, self-heals
  the registry + a matching per-loan marker on a Clean read, freezes a
  previously-confirmed holder during an outage;
- **non-reverting** — a Tier-2 close-out must never brick;
- **`ownerOf`-keyed** — reads the current holder via `_ownerOfRaw` (a plain SLOAD).

### 3.2 Where it is applied

Terminal-transition call sites fall in two buckets:

- **Already-satisfied** (a park registers both/one relevant holder before the
  transition): `DefaultedFacet`, `RiskFacet`, `RiskSplitLiquidationFacet`,
  `RiskMatchLiquidationFacet`, `PrecloseFacet` (direct + offset),
  `SwapToRepay*Facet`, `RepayFacet` (ERC-20 + NFT-rental, the latter fixed r5),
  `RefinanceFacet`. These call `recordFrozenClaimantForLoan` /
  `recordSanctionsFrozenClaimantBoth` already; **no change**.
- **Gap sites** (terminalize while writing claims without a park) — add
  `recordSanctionsFrozenClaimantBoth(loanId)` (or the borrower-only variant where
  only a borrower row is written): the three sites in §1.

### 3.3 Guardrail

Add a test-level guardrail so a **future** terminal path cannot silently reopen
the hole: a scenario test that, for each terminal close-out entry, drives a
flagged current holder (oracle up) through the close-out and asserts the holder
is left **registered** (`isSanctionsConfirmedFlagged`) — the observable proxy for
"the invariant held". This mirrors the indexer event-coverage guardrail in
spirit (fail CI when a new terminal path skips registration).

## 4. Non-goals / accepted residual

- The **fully-fail-open** window — a wallet flagged **and** first observed only
  within one uninterrupted oracle outage — is unchanged and accepted (an oracle
  blip must never freeze a never-confirmed honest wallet). It is seeded away
  operationally by `refreshSanctionsFlag`.
- No change to the movement gate (#1123) or the release-gate semantics.
- The **backstop absorb** stays a hard **block** (revert), not a park — it is
  terminal-in-one-tx and burns the lender NFT (see #1122 r2 P1 #3).

## 5. Rollout

Folded into #1122 (the S10 PR): the gap-site registers + the guardrail supersede
the scattered per-creation-site stamps. Pre-live, in-place — no storage change
(the registry + markers already exist). Standard EIP-170 re-check + deploy-sanity.
