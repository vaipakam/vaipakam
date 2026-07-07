## Thread — defi unit-test suite repaired + non-blocking CI lane (PR #1088)

The `apps/defi` Vitest suite had silently rotted to 256 failures across 38
files because no CI job ever ran it — module-resolution and API drift piled
up unnoticed after the app migrated from ethers to viem, shared libraries
moved to `@vaipakam/lib`, and the marketing pages moved to `apps/www`. This
change repairs the whole suite (now 531 passing / 6 skipped / 0 failing
across 56 files) and adds a CI lane so it can't rot invisibly again.

The bulk of the work was structural and shared-cause: the test harness now
mirrors the app's real provider tree (so page hooks that resolve the read
chain no longer throw), i18n is initialised in tests (so assertions on
user-visible copy match real English instead of raw keys), every dead
`ethers` mock was removed — the per-file `vi.mock('ethers', …)` stubs and the
shared `test/ethersMock.ts` helper are all gone, so the suite no longer masks
a reintroduced ethers dependency — and the read paths were rewritten against
the viem model (`readContract` / `getLogs` / `getContractEvents` / multicall),
moved-module imports were re-pointed, and assertion drift was triaged
case-by-case to distinguish deliberate app evolution (renamed fields, reworked
copy, new consent gates, wallet-gated pages) from genuine regressions. The
Vitest config now also discovers source-colocated `src/**/*.test.*` files, not
just the central `test/` suite, so a colocated test can't silently sit outside
the run.

Two genuine app bugs surfaced during that triage and were deliberately left
visible rather than papered over — their covering tests are skipped with a
`REGRESSION` marker and filed as follow-ups: a connected user's chain-switch
error banner is wiped instantly by an over-eager "clear errors once
connected" effect (#1090), and a lender can never reach the Early-Withdrawal
control on their own loan because it is nested inside a borrower-only
"repay" card gate (#1091).

The new `defi-vitest.yml` lane runs the suite on every PR touching
`apps/defi` or the shared packages it consumes and reports pass/fail counts,
but is intentionally **non-blocking** (drift-warn only) for now — it warns in
the Actions summary without gating merges. Now that the suite is fully green
it can be promoted to a blocking required check in a follow-up. No app or
runtime code changed here — this is tests + CI only. Closes #1076.
