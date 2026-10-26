# @vaipakam/lib

**Framework-agnostic shared utilities consumed by every Worker + frontend in the monorepo.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **lowest layer of shared off-chain code** — utilities that have no React / Vite / Worker-specific dependency, so every consumer can import them. Consumers today: `apps/app`, `apps/www`, `apps/agent`, `apps/indexer`, `apps/keeper`.

Current scope:

- `redactAddresses` — the wallet-address redaction contract: shortens a full
  EVM address to `0x1234…abcd`, including one that arrives percent-encoded, at
  any nesting depth, under a work budget and a size ceiling. It lives here
  rather than in a consumer because it binds **two independent surfaces** —
  `apps/app`'s support-report builder and `apps/agent`'s `POST /support/ticket`,
  which re-scrubs precisely because it trusts no client — and a second copy
  would drift (#2024). Change it here, never in a consumer.
- `address`, `cronCadence`, `coingecko`, `prepayOrderShape`, `erasureMessage`,
  `alertsMessage` — see each module's header; they post-date the Stage 2a list
  below and were missing from it.
- `errorDescription` — how a thrown value may be written to a log. Every RPC
  URL carries an API key and viem puts the whole request URL inside its error
  messages, so `String(err)` in a Worker's `catch` prints a credential. It is
  here rather than beside a caller for the reason `redactAddresses` is: the
  rule was first written as a private helper in `apps/indexer`, with the
  hazard documented in full, and the next change wrote `String(err)` around a
  viem read in `apps/agent` anyway (#2213). One rule, every Worker holding an
  RPC client. Since #2759 it holds the one redaction rule (`redactSecrets`)
  every formatter applies, and `redactedError`, which keeps the message, the
  cause chain and the first stack frames with every URL and credential
  removed. `logRedaction.test.ts` reads the syntax tree of every server-side
  package and refuses any place a caught value is turned into text other
  than through these formatters, whether the text goes to a log, a
  response, an alert or a stored row (`logRedaction.ts` is that check, used
  by the test only).
- `activityRefs`, `activityActor` — how an activity row is filed: the loan
  and offer an event concerns (read from the Diamond ABI by one rule, #1794)
  and the wallet it is filed under. They live here, not in `apps/indexer`,
  because they bind **two surfaces** (#2658). The indexer files every row by
  them, and `apps/app`'s Activity page receives a wallet's rows through them,
  so the app's label catalog must name every kind they file. The app's test
  reads the filed kinds from these modules instead of keeping a copy of the
  rule. The policy data is `activityRefsPolicy.json`, beside them; the
  indexer's guardrail (`apps/indexer/scripts/lib/activity-refs-surface.mjs`)
  validates it against the compiled ABI. Change them here, never in a
  consumer.
- `activityParticipants` — which wallets an activity row concerns: its actor
  and the further parties each event names (#2703). The app's Activity page
  admits a wallet's rows by it (beside the loan match), never by the address
  appearing somewhere in the args. Its test classifies every address in every
  Diamond event (a party, not a party, or an exempt event with its reason), so
  a new event naming a wallet fails until someone decides.
- `multicall` — viem-based batched RPC helpers.
- `decodeContractError` — error normaliser for revert reasons across facets.
- `chainPlatforms` — `chainId → CoinGecko platform slug` mapping.
- `canonicalAssets` — per-chain ERC-20 allow-lists.
- `crossDomainPref` — parent-domain cookie helper for preference sync across the two surfaces. **Currently LANGUAGE-ONLY in practice:** the retired `apps/defi` also synced the theme through it, but `apps/app` does not — its `ThemeContext` and its boot script read and write only the app origin's `localStorage` and ignore the shared cookie, so a theme chosen on the marketing site does not follow the user into the connected app. That is an unported behaviour from #1854, not a design choice; the helper itself still supports both.

**Non-goals:** anything that needs React (there is no shared React package — `packages/ui` was retired in #1963 — so it belongs in the consuming app), anything that needs Vite env vars (stays in the consumer), anything contract-specific (use `packages/contracts`). Two candidate modules (`format` with i18n, `journeyLog` with contracts/config) are deferred until their Vite-coupled deps are extracted.

## How to run

No dev loop — pure library code, imported by consumers.

## How to test

```bash
pnpm --filter @vaipakam/lib test
```

That is the vitest suite, and it is what CI runs — the `vitest` job in
`.github/workflows/app-vitest.yml` invokes it as its own step.

**Do not use `pnpm --filter @vaipakam/lib exec tsc --noEmit`**, which this
section used to recommend: the package has no `tsconfig.json`, so that command
receives no files, prints the compiler's help text and exits 0. It passes
unconditionally, including on code that does not compile. Types are checked
transitively instead, when a consumer that imports the module typechecks
(`pnpm --filter @vaipakam/app exec tsc -b --noEmit`, and the same for
`@vaipakam/agent`).

Per-function unit tests live alongside the source where they exist; the bar is
"framework-agnostic, deterministic".

## Architecture

- Stage 2a source-tree refactor: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Extraction discipline: only move a module here once every consumer can import it without dragging in a framework-coupled transitive dep.

## Configuration

None — package is framework-agnostic by design.

## Related

- `packages/contracts` — for ABI / deployment data.
- Every consumer under `apps/*`.

(There is no longer a sister React package: `packages/ui` was retired in #1963. This package stays React-free regardless — that was never a consequence of the sister package existing.)
