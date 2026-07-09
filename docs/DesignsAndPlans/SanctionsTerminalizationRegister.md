# Sanctions: register position holders at loan terminalization (#1006 follow-through)

Status: DRAFT for review · Owner: S10 (#1006) · Relates to: #1122, #1123

## 0. Basis — this design builds ON #1122 (pending merge), not `main`

This doc is reviewed on a branch off `main`, but it **assumes the S10 mechanisms
already landed on the #1122 branch** and folds into it. When a citation below
names a helper, it is the **#1122** version, which differs from `main`:

- `LibSanctionedLock.mustFreezeParty(s, who)` — the **registry-aware, fail-CLOSED**
  freeze decision (tri-state: Flagged→register+freeze, Clean→self-heal+pass,
  Unavailable→freeze IFF in `sanctionsConfirmedFlagged`). Class B is modelled on
  THIS, **not** `main`'s fail-open `isSanctionedAddress` surplus check.
- `LibCloseoutFreeze.freezeOrPayBorrowerSurplus` — on #1122 already switched to
  `mustFreezeParty` (r1), so it is a valid registry-aware template.
- `EncumbranceMutateFacet.recordSanctionsFrozenClaimant` /
  `recordSanctionsFrozenClaimantBoth` / `assertNotFrozenParty` — the hosts added
  in #1122 (they do not exist on `main`).
- The backstop lender block (`ClaimFacet` absorb) — on #1122 already routed through
  the registry-aware `assertNotFrozenParty` (r4), i.e. it IS fail-closed on the
  registry during an outage; §4 keeps that.

So Codex findings that cite `main`'s fail-open surplus / backstop / missing hosts
are already resolved on #1122; this design consumes those mechanisms.

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

Known Class B sites (audit, #1127 r1–r3 — the implementation must grep every
`ownerOf(lenderTokenId|borrowerTokenId)` → direct `safeTransfer` and confirm each
is registry-aware; this list is the seed, not a closed set):
- `RepayPeriodicFacet.autoDeductDaily` — the per-day lender share.
- `RepayPeriodicFacet._autoLiquidatePeriodShortfall` — resolves
  `ownerOf(lenderTokenId)`, fail-open `_assertNotSanctioned`, transfers
  `lenderProceeds` directly (#1127 r2).
- `RepayFacet.repayPartial` — resolves `ownerOf(lenderTokenId)` and pays the
  lender inline (#1127 r3).
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
with the registry-aware `LibSanctionedLock.mustFreezeParty` (§0), not the fail-open
`_assertNotSanctioned` — and when it returns true, park the payout into the
**stored `loan.lender` / `loan.borrower`'s always-existing vault** (never the
current holder's, which a flagged secondary-market holder cannot have minted) AND
into an existing claimable lane (`heldForLender` / a claim row) so it is
withdrawable once de-listed.

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
  The register MUST run **before** any position-NFT burn in the same terminal path
  (a post-burn `_ownerOfRaw` reads `address(0)` and no-ops) — #1127 r4.

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

**Register BOTH sides at every terminal — no "already parked" exemption**
(#1127 r3): a park registers only ITS side's recipient, but the S10 failure
applies to the OTHER current holder too when the same terminal writes an unparked
claim/held row for them. So every deferred-payout terminal calls
`recordSanctionsFrozenClaimantBoth(loanId)` (both sides) — even where one side
already parked; the redundant re-register on the parked side is an idempotent
no-op. This explicitly includes the **backstop absorb** (`_absorbLenderSlice`):
the lender is hard-blocked (§4), but its folded **borrower** collateral residual
still needs the borrower register before the loan burns/terminalizes (#1127 r1).

**Class B SCOPE (#1127 r5).** Class B is only the **Tier-2 servicing / close-out**
inline payouts to a position holder (daily interest, shortfall auto-liquidation,
partial-repay lender pay, rental fee). **Discretionary, value-creating** actions a
holder initiates (e.g. early-withdrawal options) stay **Tier-1 hard-block**
(revert on flagged) — they are NOT parked, so the grep sweep classifies each hit,
it does not blanket-convert them. The sweep must also catch payouts that route
through `VaultFactory` withdraw helpers, not only a raw `safeTransfer`.

**Class B** — swap every Tier-2 inline holder payout's fail-open
`_assertNotSanctioned` decision for `mustFreezeParty` + a park into the stored
party's vault + a claimable lane. The set is defined by the grep sweep (every
`ownerOf(*TokenId)` → direct transfer / vault-withdraw), NOT by the §1 seed list — the §1 sites (`autoDeductDaily`,
`_autoLiquidatePeriodShortfall`, `repayPartial`, NFT-rental daily fee) are the
known members, but any not-yet-listed direct payout the sweep finds is in scope
(#1127 r4). Two active-loan cautions (#1127 r4):
- **Reserve before exposing** — `repayPartial` / `autoDeductDaily` /
  `_autoLiquidatePeriodShortfall` run while the loan is still **Active**, so a
  parked amount added to `heldForLender` / a claim row against `loan.lender`'s
  vault must be **encumbered** (`LibEncumbrance.encumberLenderProceeds`) so it is
  not double-counted against, or drained ahead of, the live loan — exactly as the
  terminal `heldForLender` sites already reserve.
- **Active-loan lane** — use `heldForLender[loanId]` (the mid-loan accumulator the
  eventual `claimAsLender` already folds), not a terminal-only `lenderClaims` row.

### 3.3 Guardrail

Add a test-level guardrail so a **future** path cannot silently reopen the hole,
covering BOTH classes (#1127 r3):

- **Class A** — for each terminal close-out entry AND each **non-terminal**
  deferred-payout path (an Active `heldForLender` increment, e.g. a partial
  internal match — #1127 r4), drive a flagged current holder (oracle up) and assert
  the holder is left **registered** (`isSanctionsConfirmedFlagged`).
- **Class B** — for each inline-payout path, assert BOTH (#1127 r4): (a)
  **first-observation** — a flagged holder, oracle UP, first time → registered +
  parked (proves the fresh-flag branch registers); and (b) **outage** — a
  previously-**registered** holder during an outage → parked, holder EOA unchanged,
  claimable lane credited (proves the fail-open `_assertNotSanctioned` became
  `mustFreezeParty`).

This mirrors the indexer event-coverage guardrail in spirit (fail CI when a new
terminal / inline-payout path skips the treatment).

## 4. Non-goals / accepted residual

- The **fully-fail-open** window — a wallet flagged **and** first observed only
  within one uninterrupted oracle outage — is unchanged and accepted (an oracle
  blip must never freeze a never-confirmed honest wallet). It is seeded away
  operationally by `refreshSanctionsFlag`.
- No change to the movement gate (#1123) or the release-gate semantics.
- The **backstop absorb**'s LENDER side stays a hard **block** (revert), not a
  park — it is terminal-in-one-tx and burns the lender NFT (see #1122 r2 P1 #3).
  That block is **registry-aware / fail-closed**: on #1122 it routes through
  `assertNotFrozenParty` → `mustFreezeParty` (r4), so a previously-confirmed lender
  is blocked during an outage, not waved through (#1127 r3; the fail-open
  `_assertNotSanctioned` at the absorb entry is a defence-in-depth layer on top,
  not the load-bearing check). Its **borrower** collateral residual is Class A and
  IS registered (§3.2).

## 5. Per-site mechanics settled in the code phase

This doc fixes the **architecture** (the two invariants, the register-at-
terminalization + inline-park mechanisms, the enumeration cautions, the
guardrails). A handful of per-site mechanical specifics are deliberately settled
during implementation, under #1122's own compiler + test + Codex review — not
pre-solved here (they do not change the architecture, and the code is the precise
source of truth):

- The exact claimable lane + **reservation** for an Active-loan Class B park —
  `heldForLender` is per-loan in the loan's payment asset and is folded by the
  eventual `claimAsLender`; a park in a different asset, or one that must be
  withdrawable while the loan is still Active, is resolved against the live
  `heldForLender` / encumbrance code with a test (#1127 r5), and the transferred-
  lender VPFI tier-exclusion is preserved the same way `freezeLenderProceeds` does.
- Whether each grep hit is Tier-2 (park) or a Tier-1 discretionary action
  (hard-block) — decided per site against the §1348 two-tier classification.

## 6. Rollout

Folded into #1122 (the S10 PR): the gap-site registers + the Class B freezes + the
guardrail supersede the scattered per-creation-site stamps. Pre-live, in-place —
no storage change (the registry + markers already exist). Standard EIP-170
re-check + deploy-sanity.
