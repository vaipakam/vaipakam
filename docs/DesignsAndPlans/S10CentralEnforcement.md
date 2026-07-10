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

### Invariant A — register both holders when a loan terminalizes (the primary fix)

Add `LibSanctionsHooks.onLoanTerminalized(loan)` and call it from `transition`/`transitionFromAny`
when `to` is terminal (Repaid / Defaulted / Settled / InternalMatched). It registers BOTH current
position holders (registry-aware `recordFrozenClaimantForLoan`, idempotent, no-op for clean/absent).
Because every close-out ends in a terminal transition, **every deferred claim's holder is now
registered by construction** — the ~27 terminal claim writes need no per-site register.

- Timing: transition fires at close-out (oracle-up observation), BEFORE the position NFTs burn
  (they burn at claim), so `ownerOf` resolves. Where a path burns at close-out, order the hook
  before the burn (audited in the guardrail).
- Non-terminal deferred payouts (partial internal-match / preclose top-up `heldForLender +=`,
  loan stays Active) are NOT covered by the terminal hook → funnel those 2–3 sites through a
  `LibClaims.creditHeldForLender(loanId, amount)` setter that registers the lender holder.

### Invariant B — registry-aware decision on every inline holder payout

Every "pay `ownerOf(positionTokenId)` now" site routes through the existing
`LibCloseoutFreeze.freezeOrPayActiveLender{Resident,FromPayer,FromVault}` helpers (park-or-pay);
discretionary, holder-initiated actions use the hard-block variant (`mustFreezeParty` → revert),
as Refinance/backstop now do.

### Keystone — a CI guardrail (deploy-sanity test)

In the repo's existing idiom (`SelectorCoverageTest`, `FacetSizeLimitTest`,
`check-event-coverage.mjs`): a test that scans `src/facets/*.sol` and FAILS CI if it finds
- a `{lender,borrower,borrowerSurplus}Claims[…] =` or `heldForLender[…] +=` in a facet whose
  enclosing function does not also terminalize via `transition` (hook-covered) and is not on an
  explicit allowlist, or
- a `safeTransfer`/`safeTransferFrom`/`vaultWithdrawERC20` whose recipient is `ownerOf(…)` outside
  the payout helper, unless allowlisted with a one-line reason.

This is what durably ends the whack-a-mole: a future path that forgets the treatment fails CI.

## 3. The EIP-170 tension (the load-bearing design decision)

`transition` is `internal`, inlined into ~16 facets. The hook's register is HEAVY (`sanctionsStatus`
Chainlink staticcall + registry/marker writes) so it MUST be host-routed; the host-call stub (~50 B)
then inlines into every `transition` caller. Facets already at the wall (Preclose ~262 B,
EarlyWithdrawal ~81 B, Defaulted ~59 B headroom) would overflow.

**DECISION (owner, 2026-07-10): option (b) — host the terminal transition.**

A new `LifecycleFacet.terminalize(loanId, to)` host (onlyDiamondInternal) performs the terminal
transition AND the both-holder register ONCE, in the host's own bytecode. Every close-out replaces
its inline `LibLifecycle.transition(loan, from, Repaid/Defaulted/…)` at a TERMINAL edge with a
`crossFacetCall(terminalize.selector, loanId, to)`. The register cost is borne once (in the host),
not inlined into every caller → the EIP-170 spread is permanently removed, and tight facets
(Preclose/EarlyWithdrawal/Defaulted) get SMALLER (they drop the inlined `transition` body for a
~50 B stub). Non-terminal transitions keep the plain inlined `LibLifecycle.transition`.

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
