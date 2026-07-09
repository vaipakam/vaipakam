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
oracle-up observation before value leaves**. Chasing these one Codex round at a
time is **incomplete by construction**. The #1127 design review established that
**two distinct payout classes** each need coverage, and that the "a park already
registered the holder" assumption is UNSOUND — several terminal paths write a
claim (or pay inline) without a `LibSanctionedLock` park:

### Class A — DEFERRED claims (`lenderClaims` / `borrowerClaims`, released later
by `claimAsLender` / `claimAsBorrower`)

Covered by: **register both current holders at terminalization** + the existing
central claim gate. The register must run on EVERY terminal path — not only the
ones that park — because some leave the asset in the existing vault:

- `RepayFacet.repayLoan` (ERC-20) writes the collateral `borrowerClaims` row
  after a Tier-2 consolidation that SKIPS a flagged current borrower — no park,
  no register (#1127 r1).
- The Active full-internal-match over-collateralized residual writes
  `borrowerClaims` the same way (#1127 r1).
- `ClaimFacet._distributeFallbackCollateral` (no-retry / failed-retry
  finalization), `ClaimFacet._distributeRetryProceeds` (retry distribution; a
  stamp existed r2, removed r3), and `RepayPeriodicFacet.autoDeductDaily`'s final
  buffer refund (`durationDays == 0`) — the sites #1122 r6 flagged.
- The **backstop absorb** (`_absorbLenderSlice`) hard-blocks the LENDER (terminal
  in-one-tx + NFT burn), but still folds a **borrower** collateral residual into
  `borrowerClaims`; the borrower holder must be registered there (#1127 r1).

### Class B — INLINE / IMMEDIATE payouts to a position holder (paid now, not via a
claim), today gated only by the fail-open `_assertNotSanctioned`

- `RepayPeriodicFacet.autoDeductDaily` transfers the **day's lender share inline**
  before writing the final claims (#1127 r1). A registered-flagged lender is paid
  the daily share during an outage — the terminalization register does not help,
  because the value already left.
- Any sibling recurring/immediate lender payout (audit the NFT-rental daily fee
  path) has the same shape.

Known Class B sites (audit, #1127 r1–r2):
- `RepayPeriodicFacet.autoDeductDaily` — the per-day lender share.
- `RepayPeriodicFacet._autoLiquidatePeriodShortfall` — resolves
  `ownerOf(lenderTokenId)`, fail-open `_assertNotSanctioned`, then transfers
  `lenderProceeds` directly (#1127 r2).
- The NFT-rental daily fee path.

Class B is NOT fixed by registration — the value leaves immediately. It needs the
same **registry-aware freeze** the surplus path uses: replace the fail-open
`_assertNotSanctioned` decision with `LibSanctionedLock.mustFreezeParty`, and when
it returns true, PARK the payout **into `loan.lender`'s (or `loan.borrower`'s)
always-existing vault** — NOT the current holder's, which may be an un-minted
secondary-market vault the receive-side exemption refuses to create for a flagged
wallet (`VaultFactoryFacet:239-245`, #1127 r2) — AND record it into an
**existing claimable lane** so the de-listed holder can actually withdraw it. A
bare vault deposit is not claimable (`withdrawERC20` is `onlyDiamond`); the parked
amount must land in `heldForLender[loanId]` (folded into the eventual
`claimAsLender`) or a claim row, exactly as `depositLocked` + the lender-claim /
`heldForLender` sites already do (#1127 r2).

## 2. Invariants

**A (deferred claims).** Every code path that transitions a loan to a terminal
state (`Repaid` / `Defaulted` / `Settled` / `InternalMatched`) — OR otherwise
creates a deferred position-holder payout via a `lenderClaims` / `borrowerClaims`
row (full-struct OR field write) or a `heldForLender` increment — MUST register
**both** current position holders in `sanctionsConfirmedFlagged`
when affirmatively flagged (an oracle-up observation), **regardless of whether it
parked**. The register is idempotent + registry-aware
(`recordFrozenClaimantForLoan`: registers on Flagged, self-heals on Clean, no-ops
otherwise), so calling it universally at terminalization is safe even where a
park already ran. With this, the existing **central claim gate** (#1122 r3) is
sufficient for Class A: a holder flagged at any terminalization is registered, so
a later outage claim reads `Unavailable + registered` and freezes.

**B (inline payouts).** Every path that pays value to a current position holder
**immediately** (not via a deferred claim) MUST make the pay-or-freeze decision
with the registry-aware `LibSanctionedLock.mustFreezeParty`, not the fail-open
`_assertNotSanctioned` — parking the payout into the holder's vault behind the
claim gate when it returns true.

The residual under both invariants shrinks to the platform-wide, accepted
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

**Class A** — apply `recordSanctionsFrozenClaimantBoth(loanId)` at EVERY terminal
path, WITHOUT assuming a prior park registered the holder (#1127 r1 disproved that
for `repayLoan` ERC-20, the internal-match residual, and others). The enumeration
is broader than the full-struct assignment (#1127 r2):
- `lenderClaims[…] = ClaimInfo({…})` / `borrowerClaims[…] = ClaimInfo({…})`, AND
- **storage-pointer FIELD writes** — `bClaim.amount = …` / `.asset = …` etc. (e.g.
  `_absorbLenderSlice`, the claim-time borrower-lien fold), AND
- **`heldForLender[loanId]` increments** — some terminals create a later lender
  payout ONLY via `heldForLender` (e.g. `_settleOldLenderAtCompletion`,
  partial-internal-match residual), not a `lenderClaims` row.

Sites already calling the register (via a park's `recordFrozenClaimantForLoan`)
are left as-is; every other deferred-payout terminal site gets the host call. This
explicitly includes the **backstop absorb** (`_absorbLenderSlice`): the lender is
hard-blocked (§4), but its folded **borrower** collateral residual still needs the
borrower register before the loan burns/terminalizes (#1127 r1).

**Class B** — audit every inline holder payout and swap its fail-open
`_assertNotSanctioned` decision for `mustFreezeParty` + a park:
- `RepayPeriodicFacet.autoDeductDaily` — the per-day lender share (#1127 r1).
- The NFT-rental daily fee path (confirm during implementation).

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
- The **backstop absorb**'s LENDER side stays a hard **block** (revert), not a
  park — it is terminal-in-one-tx and burns the lender NFT (see #1122 r2 P1 #3).
  Its **borrower** collateral residual is Class A and IS registered (§3.2).

## 5. Rollout

Folded into #1122 (the S10 PR): the gap-site registers + the guardrail supersede
the scattered per-creation-site stamps. Pre-live, in-place — no storage change
(the registry + markers already exist). Standard EIP-170 re-check + deploy-sanity.
