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

### Invariant A — register the holder(s) at every LIVE-NFT deferred-claim creation

**The load-bearing rule is the guardrail (Keystone below), NOT a mechanical per-target-state hook.**
The register must be CO-LOCATED with each non-zero deferred-claim / `heldForLender` write,
side-matched to the lane written, whenever the credited side's position NFT is still live. The
`terminalize` host is simply the CONVENIENT both-holder register point for the COMMON close where both
NFTs are live and both deferred claims are created at the transition — routing *every* terminal edge
through it is wrong, because several edges burn a position NFT before the transition, pay inline, or
write only zero rows.

Register via the both-holder `terminalize[FromAny]` host at: `Active/* → Repaid`, `→ Defaulted`,
`→ InternalMatched`, and `Active → FallbackPending` (fallback-entry claim rows are written at this
NON-terminal state — Codex #1136-r1 D3; a terminal-only hook is too late because the eventual
`FallbackPending → Defaulted` may run during a later outage) — for the common case where BOTH position
NFTs are live and non-zero deferred claims are created.

**EXCLUDED / side-specific — the register-before-burn assumption is FALSE for these (Codex #1136 r4/r5):**
- Every `→ Settled` (r4 R4-1/R4-2): claim-time Settled runs AFTER the claiming NFT burn; the direct
  parallel-sale Settled pays inline (Invariant B). Plain transition.
- `EarlyWithdrawalFacet._completeLoanSaleImpl` temp-loan `→ Repaid` (r5 R5-2): burns BOTH temp-loan
  NFTs first, then writes zero/claimed rows only to avoid a stuck artifact — no live-NFT deferred
  payout. Plain transition.
- `ClaimFacet.claimAsLenderViaBackstop` `FallbackPending → Defaulted` (r5 R5-3): burns the lender NFT
  first and the lender payout is already CASH-ABSORBED (consumed, not deferred); only the BORROWER
  fold is deferred. Use a **borrower-side-only** register — the host exposes single-side variants
  (`terminalizeRegister{Lender,Borrower}` or a side param) — a both-holder register would revert on
  the burned lender token.

So the host exposes both-holder AND single-side register modes; each site selects by which sides are
live + deferred. Crucially, the **guardrail** enforces the side-match structurally and EXEMPTS
zero/claimed rows + burned-holder writes (no live holder to register), so a post-burn edge we did NOT
enumerate here still cannot silently ship a fail-open live-NFT claim: either it has a live holder +
non-zero claim (guardrail demands a side-matched register) or it does not (exempt). The enumeration
above is the *starting* allowlist; the guardrail is what makes the invariant structural.

**Host — preserving `expectedFrom` (Codex #1136-r1 D2).** `LibLifecycle.transition(loan,
expectedFrom, to)` and `transitionFromAny(loan, to)` each validate a *caller-specific* source edge
(the table permits multiple sources per target, e.g. `Active/FallbackPending → Defaulted`); a host
taking only `(loanId, to)` could validate only "some legal edge" — NOT behavior-preserving. So the
host mirrors BOTH signatures:

```
LifecycleFacet.terminalize(uint256 loanId, LoanStatus expectedFrom, LoanStatus to)  // onlyDiamondInternal
LifecycleFacet.terminalizeFromAny(uint256 loanId, LoanStatus to)
  → LibLifecycle.transition(loan, expectedFrom, to)  // SAME validated edge as today
  → recordFrozenClaimantForLoan(loan, lender=true) + (…, false)   // both current holders, once
```

Every register-triggering transition (the set above) swaps its inline `LibLifecycle.transition(...)`
for a `crossFacetCall(terminalize[FromAny], loanId, [expectedFrom,] to)`. All OTHER transitions
(including every `→ Settled`) keep the plain inlined `LibLifecycle.transition`. The register is
idempotent + registry-aware (no-op for clean/absent), and — because Settled is excluded — runs BEFORE
any position-NFT burn (burns happen at claim / at the excluded Settled edge), so `ownerOf` resolves.

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

The funding move for a held credit MUST go through the **sanctions-locking deposit variant**
(`LibSanctionedLock.depositLockedFrom` / `depositLocked`), NOT a plain `vaultDepositERC20From` (Codex
#1136-r4 R4-4): the plain deposit resolves the receiving lender vault through the Tier-1 sanctions
gate, so a stored/current lender flagged AFTER init (e.g. in `PrecloseFacet.transferObligationViaOffer`)
would REVERT the deposit before `creditHeldForLender` could register/encumber — bricking a must-complete
close-out. The locking variant pins the receive-side exemption (resolves the flagged lender's EXISTING
vault, never mints) and ticks tracking, so `alreadyTracked=true` callers use it and the setter then
only registers + encumbers; a Diamond-resident credit uses `depositLocked` inside the setter.

### Invariant B — registry-aware decision on every inline holder payout

Two payout channels:

1. **Diamond-mediated** — every "pay `ownerOf(positionTokenId)` now" via `safeTransfer` /
   `safeTransferFrom` / `vaultWithdrawERC20` routes through the existing
   `LibCloseoutFreeze.freezeOrPayActiveLender{Resident,FromPayer,FromVault}` helpers (park-or-pay).
   The **park** variant is valid ONLY where a later `claimAsLender`/`claimAsBorrower` can release the
   parked funds — i.e. on an Active/FallbackPending/Defaulted loan. A payout on a path that
   immediately transitions the loan to **`Settled`** has NO claim path, so parking there would strand
   a flagged holder's funds (Codex #1136-r4 R4-1). Discretionary holder-initiated actions
   (Refinance/backstop) use the **hard-block** variant (`mustFreezeParty` → revert), never the park.
   BUT a hard-block that only `mustFreezeParty`-reverts inside an atomic sale fill does NOT persist —
   the registry write rolls back with the revert (Codex #1136-r5 R5-1), so a first oracle-up fill
   blocks but leaves no marker and a later outage fill pays fail-open. The accepted-offer parallel-sale
   `PrepayListingFacet._settleLoanFromParallelSale` (`ownerOf(lenderTokenId)` paid, then `Active →
   Settled`) IS a prepay-sale vehicle → it is covered by the SAME committed non-reverting
   `syncPrepaySaleListing` + fail-closed-fill mechanism as the Seaport channel (2), NOT a bare
   `mustFreezeParty`-revert. (The revert-rollback lesson applies to any hard-block inside an atomic,
   listing-fillable path: it needs a committed pre-fill sync, not just a revert.)
2. **Seaport prepay-sale — a permissionless NON-REVERTING sync over EVERY holder recipient.** The
   prepay-collateral-sale settles inside Seaport, which pays consideration **directly to the current
   position-NFT holders — BOTH the borrower/seller AND the current lender-position holder** (Codex
   #1136-r3 R3-3) — BEFORE the diamond callback flips the loan to `Settled`. Relying on the #1123
   movement gate at listing/fill does NOT commit a registration (Codex #1136-r3 R3-1): that gate
   *reverts* on an authoritative `Flagged` read and deliberately does not write `sanctionsConfirmedFlagged`
   (the write would roll back), so a flagged-at-listing seller yields no live order AND no marker, and a
   flagged-at-fill recipient rolls the marker back too. The fill is atomic — nothing can commit a
   registration inside a reverting fill.

   So the design adds an EXPLICIT **committed, non-reverting sync**, keyed to MATCH the listing's own
   key (Codex #1136-r6): a LOAN-keyed `syncPrepaySaleListing(loanId)` AND an OFFER-keyed
   `syncPrepaySaleOffer(offerId)` — because the parallel-sale surface is offer-keyed
   (`offerPrepayListingOrderHash[offerId]`, and Scenario A has NO loan at all), so a loan-only sync
   couldn't reach those listings. (Permissionless, like `refreshSanctionsFlag`.) Each reads the live
   consideration recipients — every current position-NFT holder the order pays — and, on an
   authoritative oracle-up read, REGISTERS any flagged recipient in `sanctionsConfirmedFlagged`
   (committed) AND CANCELS the listing so it cannot fill. It never reverts on a flag (it *acts* on it),
   so the registration persists. Anyone (a keeper, the counterparty) can call it; the fill path
   additionally consults the registry fail-closed as a backstop. The residual — a recipient flagged AND
   never synced/observed within one uninterrupted outage — is the FR-1 accepted residual (§4), seeded
   operationally by the sync + `refreshSanctionsFlag`.

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
  must sit in a function that ALSO performs a **SIDE-MATCHED** register in a committed form (Codex
  #1136-r3 R3-2 / r4 R4-3): the registered side must cover EACH mutated claim lane. A `lenderClaims`
  write needs the LENDER side registered (`terminalize[FromAny]` — both, `creditHeldForLender` —
  lender, or `recordFrozenClaimant(…, lenderSide=true)`/`…ForLoan`); a `borrowerClaims` write needs the
  BORROWER side; a `heldForLender +=` needs the lender side. A function that writes BOTH lanes needs a
  BOTH-holder register (`terminalize[FromAny]` or `recordSanctionsFrozenClaimantBoth`) — an arbitrary
  single-side call is NOT sufficient, or the guardrail would miss the exact missing-recipient class it
  exists to catch. This is compositional with self-registering HELPERS — e.g.
  `LibCloseoutFreeze.freezeLenderProceeds` assigns `s.lenderClaims[loanId]` AND calls
  `recordFrozenClaimantForLoan(…, true)` in the same body (lender lane ↔ lender register), so it passes
  without an allowlist while its callers do the transition. A claim/held mutation whose side is NOT
  register-matched in its function FAILS CI, unless allowlisted with a reason. The allowlist is thus
  reserved for genuine exceptions, not for punching a hole around every helper. The `LibClaims`
  setters and the `terminalize` host bodies are NOT blanket-exempt (Codex #1136-r6 R6-4): they are the
  funnel callers TRUST, so the guardrail POSITIVELY asserts each contains its own side-matched
  `recordFrozenClaimant*` — a regression that drops the lender register inside `creditHeldForLender`
  would otherwise be invisible at both the caller (which relied on the setter) and the setter (if
  exempt). Verify the funnel, don't trust it. **EXEMPT (no live holder to register — Codex #1136-r5):** a write that stores a
  ZERO / `claimed:true` row (an artifact-avoidance row, not a real deferred payout — e.g. the temp-loan
  `→ Repaid` sale close, the zero-amount rental lender row) and a write on a side whose position NFT is
  already burned in the same flow (the payout was consumed inline / cash-absorbed). These carry no
  live-NFT payout, so the rule does not demand a register — but they must be *recognizably* zero/burned
  (the scan checks the row is zero-valued or the side burned), not blanket-allowlisted.
- **Inline holder payouts, ALIAS-AWARE (Codex #1136-r2 R2-2).** A literal `safeTransfer(…, ownerOf(…))`
  scan misses the common pattern of resolving `ownerOf` into a local and transferring it later
  (`SwapToRepayFacet:735-744`, the `LibCloseoutFreeze` helpers). So the rule is FUNCTION-SCOPE: any
  function that resolves `ownerOf(*TokenId)` AND performs a raw `safeTransfer*` / `vaultWithdrawERC20`
  (to any local) outside the `freezeOrPayActiveLender*` helpers FAILS — plus the Seaport consideration
  channel, covered via #1123 above. The resolve and the payout also SPLIT ACROSS FUNCTIONS (Codex
  #1136-r6 R6-2): `ClaimFacet._claimViaBackstopImpl` resolves `nftOwner` and passes it into
  `_absorbLenderSlice`, which does the `vaultWithdrawERC20`. So the rule is CALL-GRAPH-scoped, not
  single-function: a holder value resolved from `ownerOf(*TokenId)` and threaded into a private helper
  that pays it is treated the same as an in-function payout — the whole resolve→pay call chain must be
  inside the helpers (or carry the `assertNotFrozenParty`/sync). This is a coarse dataflow backstop (a
  full taint analysis is the ideal); the call-graph ban is the practical, false-positive-tolerant check
  + a reasoned allowlist.

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
ONCE, in the host's own bytecode. A register-triggering transition with BOTH holders live (`→ Repaid /
Defaulted / InternalMatched` + `Active → FallbackPending`; **NOT `→ Settled`**) replaces its inline
`LibLifecycle.transition(loan, expectedFrom, to)` with `crossFacetCall(terminalize[FromAny], loanId,
[expectedFrom,] to)`. The host ALSO exposes **single-side variants** (`terminalizeRegister{Lender,
Borrower}` / a side param) for the enumerated post-burn edges where only one side is live+deferred
(the backstop `FallbackPending → Defaulted` → borrower-only) and PLAIN `LibLifecycle.transition` for
the fully-excluded edges (claim-time `→ Settled`, temp-loan-sale `→ Repaid`) — see §2 Invariant A. The
register cost is borne once (in the host), not inlined into every caller → the EIP-170 spread is
permanently removed, and tight facets (Preclose/EarlyWithdrawal/Defaulted) get SMALLER (they drop the
inlined `transition` body for a ~50 B stub).

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
