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
`LibClaims.creditHeldForLender(loanId, lender, asset, amount, bool alreadyTracked)`. It ALWAYS owns
the register + the encumbrance reservation (`encumberLenderProceeds` / the dedicated active-held
ledger). The protocol-tracked deposit tick is CONDITIONAL, because the funding move varies by caller
(Codex #1136-r2 R2-3): callers whose move already ticked tracking — `vaultDepositERC20From` in
`PrecloseFacet.transferObligationViaOffer`, `_settleLeg`'s `recordVaultDepositERC20` before the
partial-match `+=` — pass `alreadyTracked=true`; a Diamond-resident raw transfer passes `false` so
the setter ticks after the move. (Split `deposit+credit` entry points are the equivalent alternative;
the mode flag keeps one funnel.) A single unconditional tick would double-count the pre-ticked paths
or drop it on raw-transfer paths — both break vault accounting at claim/recovery.

### Invariant B — registry-aware decision on every inline holder payout

Two payout channels:

1. **Diamond-mediated** — every "pay `ownerOf(positionTokenId)` now" via `safeTransfer` /
   `safeTransferFrom` / `vaultWithdrawERC20` routes through the existing
   `LibCloseoutFreeze.freezeOrPayActiveLender{Resident,FromPayer,FromVault}` helpers (park-or-pay);
   discretionary holder-initiated actions use the hard-block variant (`mustFreezeParty` → revert),
   as Refinance/backstop do.
2. **Seaport prepay-sale — a permissionless NON-REVERTING sync over EVERY holder recipient.** The
   prepay-collateral-sale settles inside Seaport, which pays consideration **directly to the current
   position-NFT holders — BOTH the borrower/seller AND the current lender-position holder** (Codex
   #1136-r3 R3-3) — BEFORE the diamond callback flips the loan to `Settled`. Relying on the #1123
   movement gate at listing/fill does NOT commit a registration (Codex #1136-r3 R3-1): that gate
   *reverts* on an authoritative `Flagged` read and deliberately does not write `sanctionsConfirmedFlagged`
   (the write would roll back), so a flagged-at-listing seller yields no live order AND no marker, and a
   flagged-at-fill recipient rolls the marker back too. The fill is atomic — nothing can commit a
   registration inside a reverting fill.

   So the design adds an EXPLICIT **committed, non-reverting sync**: `syncPrepaySaleListing(loanId)`
   (permissionless, like `refreshSanctionsFlag`) reads the live consideration recipients — every
   current position-NFT holder the order pays — and, on an authoritative oracle-up read, REGISTERS any
   flagged recipient in `sanctionsConfirmedFlagged` (committed) AND CANCELS the listing so it cannot
   fill. It never reverts on a flag (it *acts* on it), so the registration persists. Anyone (a keeper,
   the counterparty) can call it; the fill path additionally consults the registry fail-closed as a
   backstop. The residual — a recipient flagged AND never synced/observed within one uninterrupted
   outage — is the FR-1 accepted residual (§4), seeded operationally by the sync + `refreshSanctionsFlag`.

### Keystone — a CI guardrail (deploy-sanity test)

In the repo's existing idiom (`SelectorCoverageTest`, `FacetSizeLimitTest`,
`check-event-coverage.mjs`), a test that scans **all production Solidity — `src/**/*.sol`, libraries
included, NOT just `src/facets/` (Codex #1136-r1 D1)** (claim/held mutations already live in
`LibCloseoutFreeze`, `LibFacet`, `LibSwapToRepayIntentSettlement`). It FAILS CI on:

- **Deferred-payout writes without a CO-LOCATED register (resolves the option-(c) tension — Codex
  #1136-r2 R2-4).** We do NOT funnel every claim write through a setter (option (c) rejected — callers
  compute + store their own claim rows around the status change). So the rule is co-location, not a
  setter mandate: a `{lender,borrower,borrowerSurplus}Claims[…]` full-struct assignment OR field-write
  (`.amount = …` / `.asset = …`, incl. fold/rewrite — Codex #1136-r1 D4), or a `heldForLender[…] +=`,
  must sit in a function that ALSO performs a register **in any of its committed forms** (Codex
  #1136-r3 R3-2): the `terminalize`/`terminalizeFromAny` host (registers both holders),
  `LibClaims.creditHeldForLender` (registers the lender), OR a DIRECT
  `recordFrozenClaimant`/`recordFrozenClaimantForLoan`/`recordSanctionsFrozenClaimant[Both]` call. This
  makes the rule compositional with the existing claim-writing HELPERS that self-register — e.g.
  `LibCloseoutFreeze.freezeLenderProceeds` assigns `s.lenderClaims[loanId]` AND calls
  `recordFrozenClaimantForLoan` in the same body, so it passes without an allowlist while its callers
  do the transition. A claim/held mutation in a function that performs NONE of these register forms
  FAILS CI, unless allowlisted with a reason. (`LibClaims` + the host bodies are exempt.) The
  allowlist is thus reserved for genuine exceptions, not for punching a hole around every helper.
- **Inline holder payouts, ALIAS-AWARE (Codex #1136-r2 R2-2).** A literal `safeTransfer(…, ownerOf(…))`
  scan misses the common pattern of resolving `ownerOf` into a local and transferring it later
  (`SwapToRepayFacet:735-744`, the `LibCloseoutFreeze` helpers). So the rule is FUNCTION-SCOPE: any
  function that resolves `ownerOf(*TokenId)` AND performs a raw `safeTransfer*` / `vaultWithdrawERC20`
  (to any local) outside the `freezeOrPayActiveLender*` helpers FAILS — plus the Seaport consideration
  channel, covered via #1123 above. This is a coarse dataflow backstop (a full taint analysis is the
  ideal); the function-scope ban is the practical, false-positive-tolerant check + a reasoned allowlist.

This is what durably ends the whack-a-mole: a future path that forgets the treatment fails CI.

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
