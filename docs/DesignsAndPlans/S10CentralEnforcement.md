# S10 central enforcement — arrest sanctioned-holder fail-open at the source

Status: DRAFT for review · Tracking: #1132 · Owner: S10 (#1006 follow-through) · Relates to: #998, #1006, #1122, #1123, #1127

## 0. Problem

S10 requires: *value returning to a sanctioned position holder must be fail-closed.*
Today this is enforced **by convention** — each close-out must remember to (A) register
the holder when it writes a deferred claim, or (B) use the registry-aware `mustFreezeParty`
when it pays inline. Convention-enforced cross-cutting invariants are whack-a-mole: the
#1122 review found the *same* class of bug on a *different* path in nearly every round
(RepayPeriodic, ClaimFacet fallback/retry, Preclose-offset, Refinance, backstop, internal
match). #1122 patched each site; this design makes the invariant **structural** so a future
path cannot reintroduce it.

Surface: ~27 terminal `{lender,borrower}Claims[…] = ClaimInfo` writes, ~15 claim field-writes,
2–3 non-terminal `heldForLender[…] +=` increments, and the inline holder-payout sites.

## 1. Key observation

`LibLifecycle.transition` / `transitionFromAny` is the **single funnel** for every loan
state change, it is terminal-aware (`to`), and it **already carries a hook**
(`LibMetricsHooks.onLoanStatusChanged`). Auditing the recurring findings: **almost all deferred-claim
registers happen at a TERMINAL transition** (Active→Repaid/Defaulted/InternalMatched,
FallbackPending→Defaulted). So one hook on terminalization preempts the whole Class-A whack-a-mole,
in the pattern the codebase already uses.

## 2. Design — two invariants, one hook + one setter + one guardrail

### Invariant A — register both holders at every DEFERRED-CLAIM-CREATING transition

The trigger is **not** "terminal" but "**this transition creates a deferred position-holder
payout**." Two transition classes create claims (Codex #1136-r1 D3):

1. The terminal edges (`* → Repaid / Defaulted / Settled / InternalMatched`).
2. **`Active → FallbackPending`** — `RiskFacet`/`DefaultedFacet` write the fallback-entry
   lender/borrower claim rows HERE, at a NON-terminal state. The next *terminal* transition
   (`FallbackPending → Defaulted`) may not run until a much later claim, so a terminal-only hook is
   too late: a holder flagged (oracle up) at fallback entry, whose Defaulted transition later runs
   during an outage, would never be registered → fail-open. Fallback entry MUST register too.

**Host — preserving `expectedFrom` (Codex #1136-r1 D2).** `LibLifecycle.transition(loan,
expectedFrom, to)` and `transitionFromAny(loan, to)` each validate a *caller-specific* source edge;
the lifecycle table permits multiple sources per target (`FallbackPending → Repaid/Defaulted`,
`Active/… → Settled`). A host taking only `(loanId, to)` could validate only "some legal edge" —
NOT behavior-preserving. So the host mirrors BOTH signatures:

```
LifecycleFacet.terminalize(uint256 loanId, LoanStatus expectedFrom, LoanStatus to)  // onlyDiamondInternal
LifecycleFacet.terminalizeFromAny(uint256 loanId, LoanStatus to)
  → LibLifecycle.transition(loan, expectedFrom, to)  // SAME validated edge as today
  → recordFrozenClaimantForLoan(loan, lender=true) + (…, false)   // both current holders, once
```

Every claim-creating transition (the terminal edges + `Active → FallbackPending`) swaps its inline
`LibLifecycle.transition(...)` for a `crossFacetCall(terminalize[FromAny], loanId, [expectedFrom,] to)`.
Non-claim-creating transitions keep the plain inlined `LibLifecycle.transition`. The register is
idempotent + registry-aware (no-op for clean/absent), and runs BEFORE any position-NFT burn (burns
happen at claim, not at these transitions), so `ownerOf` resolves.

**Non-terminal held credits — an ASSET-AWARE setter (Codex #1136-r1 D6).** The partial-internal-match
/ preclose-top-up `heldForLender +=` sites (loan stays Active, no transition) funnel through
`LibClaims.creditHeldForLender(loanId, lender, asset, amount)` — NOT `(loanId, amount)`. The setter
owns the FULL accounting those sites do today: the register, the protocol-tracked deposit tick, AND
the encumbrance reservation (`encumberLenderProceeds` / the dedicated active-held ledger), so the
funnel cannot silently drop the reservation that stops the stored lender spending value owed to the
current holder before claim.

### Invariant B — registry-aware decision on every inline holder payout

Two payout channels:

1. **Diamond-mediated** — every "pay `ownerOf(positionTokenId)` now" via `safeTransfer` /
   `safeTransferFrom` / `vaultWithdrawERC20` routes through the existing
   `LibCloseoutFreeze.freezeOrPayActiveLender{Resident,FromPayer,FromVault}` helpers (park-or-pay);
   discretionary holder-initiated actions use the hard-block variant (`mustFreezeParty` → revert),
   as Refinance/backstop do.
2. **Seaport prepay-sale (Codex #1136-r1 D5).** The prepay-collateral-sale path settles inside
   Seaport, which pays *consideration directly to the current lender/borrower NFT holders* BEFORE
   the diamond callback flips the loan to `Settled`. A terminal hook runs only AFTER the holder was
   paid, and a `safeTransfer`/`vaultWithdraw` scan never sees a Seaport consideration recipient. So
   this channel must be made registry-aware **before the order fills** — the diamond validates/builds
   the order, so gate the consideration recipients (`mustFreezeParty` → block-or-redirect a frozen
   holder's consideration) at order construction/validation, not at the post-fill callback.

### Keystone — a CI guardrail (deploy-sanity test)

In the repo's existing idiom (`SelectorCoverageTest`, `FacetSizeLimitTest`,
`check-event-coverage.mjs`), a test that scans **all production Solidity — `src/**/*.sol`, libraries
included, NOT just `src/facets/` (Codex #1136-r1 D1)** — because claim/held mutations already live in
libraries (`LibCloseoutFreeze` writes claim rows + `heldForLender`, `LibFacet` increments
`heldForLender`, `LibSwapToRepayIntentSettlement` writes `borrowerClaims`). It FAILS CI on:

- a `{lender,borrower,borrowerSurplus}Claims[…] =` **full-struct assignment**, a claim **field-write
  via a storage pointer** (`…Claims[…].amount = …` / `.asset = …`, incl. the fold/rewrite paths —
  Codex #1136-r1 D4), or a `heldForLender[…] +=`, anywhere outside `LibClaims` / the `terminalize`
  host path, and not on an explicit allowlist; or
- a `safeTransfer`/`safeTransferFrom`/`vaultWithdrawERC20` whose recipient is `ownerOf(…)`, or a
  Seaport consideration item constructed to a position-holder, outside the payout helper — unless
  allowlisted with a one-line reason.

Enforcing the mutations through checked setters (so a raw write cannot compile) is stronger than a
regex scan; the design prefers setters where practical and uses the scan as the backstop. This is
what durably ends the whack-a-mole: a future path that forgets the treatment fails CI.

## 3. The EIP-170 tension (the load-bearing design decision)

`transition` is `internal`, inlined into ~16 facets. The hook's register is HEAVY (`sanctionsStatus`
Chainlink staticcall + registry/marker writes) so it MUST be host-routed; the host-call stub (~50 B)
then inlines into every `transition` caller. Facets already at the wall (Preclose ~262 B,
EarlyWithdrawal ~81 B, Defaulted ~59 B headroom) would overflow.

**DECISION (owner, 2026-07-10): option (b) — host the transition (register once in the host).**

A new `LifecycleFacet.terminalize(loanId, expectedFrom, to)` + `terminalizeFromAny(loanId, to)` host
pair (onlyDiamondInternal) performs the *validated* transition (SAME `expectedFrom` edge-check as
`LibLifecycle.transition`/`transitionFromAny` today — Codex #1136-r1 D2) AND the both-holder register
ONCE, in the host's own bytecode. Every CLAIM-CREATING transition (the terminal edges + `Active →
FallbackPending`) replaces its inline `LibLifecycle.transition(loan, expectedFrom, to)` with a
`crossFacetCall(terminalize[FromAny], loanId, [expectedFrom,] to)`. The register cost is borne once
(in the host), not inlined into every caller → the EIP-170 spread is permanently removed, and tight
facets (Preclose/EarlyWithdrawal/Defaulted) get SMALLER (they drop the inlined `transition` body for
a ~50 B stub). Non-claim-creating transitions keep the plain inlined `LibLifecycle.transition`.

Considered and rejected: (a) gate+host-route the hook inside inlined `transition` (absorbs the
spread, ongoing headroom pressure); (c) setter-funnel of the 27 claim writes (largest diff, no
`transition` coupling, still needs the held-setter — more churn, less elegant).

## 4. What this does NOT close (accepted, orthogonal)

FR-1 — the design-§4 residual (holder flagged AFTER terminalization, never observed, claims during
an outage). Centralization fixes "*path forgot* the treatment," not "*wallet listed after the last
oracle-up observation*." That window stays accepted (seeded by `refreshSanctionsFlag`); closing it
needs the register-and-soft-block claim-gate semantics change already declined for #1122.

## 5. Sequencing

**DECISION (owner, 2026-07-10): merge #1122 baseline first.** #1122's per-site fixes are correct,
tested, and close #1006 functionally → merge as the green baseline. This central refactor then lands
as a **behavior-preserving** follow-up PR: register/freeze moves from scattered call sites into the
`terminalize` host / `heldForLender` setter / payout helper, per-site `recordSanctionsFrozenClaimant*`
calls are deleted, and the guardrail proves no site is left untreated. "Same behavior, now structural"
is verified against the green merged baseline; the per-site work is the reference the guardrail locks in.

## 6. Rollout / acceptance

- Terminal-transition register hook (option b or a) + `heldForLender` setter + payout-helper adoption.
- Deploy-sanity guardrail test failing on any un-funneled claim-write / inline holder-payout.
- All S10 tests still green; scattered `recordSanctionsFrozenClaimant*` deleted where the hook covers them.
- EIP-170 re-check; no facet over 24,576 B.
