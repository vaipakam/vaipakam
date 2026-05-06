# Release Notes — 2026-05-07

Continuation of the post-rehearsal frontend polish + diagnostics
work that began on the 6th, plus closure of the lone outstanding
testnet smoke-test loose end (OP PositiveFlows). Today is purely
frontend / docs / ops; no contract changes. The day ended with a
strategy pivot — the user confirmed mainnet timing is flexible
enough to do the architectural optimisation work properly rather
than defer it to a post-mainnet stable window.

## Diagnostics-drawer UX revisions

Three small but operator-meaningful changes after a walkthrough
with the IndexerStatusBadge live:

- **Restored inline popover on the badge info icon.** The previous
  iteration had wired the badge's ⓘ click to open the full
  diagnostics drawer scrolled to the chain panel. The drawer felt
  too heavy for "what does this colour mean?" — now the icon
  toggles a concise popover anchored under the pill itself. The
  popover shows only the glance-meaningful fields: state pill,
  chain, last safe block, blocks-to-catch-up, plus the safe-block
  footnote. The full breakdown (browser storage, build hash,
  cursor-advance time, the dev-only purge affordance) stays in the
  diagnostics drawer where it was. Click-outside / Escape close.
- **Chain & Indexer panel is now collapsible inside the drawer.**
  Default state is collapsed: operators opening the drawer via the
  FAB are usually triaging a failure event, so the events list
  should sit at the top. The chain panel becomes a click-to-peek
  affordance. The state pill stays visible in the collapsed header
  so the at-a-glance signal isn't hidden; expanding reveals the
  full row table. Toggle uses ARIA `expanded` / `controls` for
  screen readers.
- **Drawer toolbar trim.** The `Copy JSON` button was dropped — the
  `Download` button covers the same need with a clean filename and
  no clipboard-permission edge cases. The trash-can button was
  relabelled from "Delete" to "Clear" (it just empties the
  in-memory journey buffer; "Delete" read more destructive than
  the action warrants). Toolbar reordered to **Download → Report
  on GitHub → Clear**: the artefact-producing button leads, the
  reporting affordance follows, the destructive action sits at the
  end. The new label landed in all ten locales; the orphan
  `copyJson` / `copied` / `delete` keys were dropped from each.

## "Report on GitHub" — symmetric event window

The GitHub-issue body that the diagnostics drawer's Report link
populates centres on the most-recent failure event in the journey
buffer. Earlier defaults captured **10 events before + 2 events
after** the failure. The asymmetric window biased the issue toward
lead-up context at the cost of the post-failure trail (retries,
recovery attempts, follow-on errors).

New defaults are **5 events before + 5 events after**, plus the
failure event itself — a symmetric window that reads more cleanly
in the rendered issue body. Total event budget is roughly the same
at ~11 events; the URL-too-long trim-fallback continues to halve
to 2+2 if the assembled body overshoots `MAX_URL_LEN`. Operator
can still override via `VITE_DIAG_EVENTS_BEFORE_FAILURE` and
`VITE_DIAG_EVENTS_AFTER_FAILURE` env vars.

## Refresh cadence — uniform 30-second heartbeat

Today's shape: every "warm-tier" subscriber refreshes on the same
30-second beat, so the badge popover and the drawer panel show
numbers that move in lockstep instead of the prior sawtooth where
the chain head ticked every 20 s but the indexer cursor only every
60 s.

Concretely:

- The `warm` watermark policy (`useLiveWatermark`) shifted from
  20 s → 30 s active cadence. Nine call sites inherit this — the
  badge, the drawer panel, `useMyOffers`, `useIndexedLoans`,
  `useIndexedActivity`, `useLogIndex`, `useOfferStats`,
  `EscrowAssets`, and the `useRecentOffers` legacy probe.
- `useOfferStats` periodic refetch shifted from 60 s → 30 s and
  the cadence constant `OFFER_STATS_REFETCH_MS` is now exported
  from the hook so the diagnostics-drawer countdown reads it
  directly (single source of truth — no duplicated magic number
  drifting between the hook and the panel).

The `Blocks to catch up` value no longer drifts upward between
indexer-side fetches; both numerator (chain safe head) and
denominator (indexer cursor) move on the same heartbeat.

## "Next index fetch in" countdown

A new row in the Chain & Indexer drawer panel ticks down from 30 s
→ 0 s and resets every time `stats.indexer.updatedAt` advances
(i.e. every successful `/offers/stats` response). Resets on the
real heartbeat, not a guessed schedule, so the countdown stays
honest when probes run early or get retried. Stops ticking when
the panel is collapsed so we don't burn re-renders the user can't
see.

The label deliberately reads **Next index fetch in** rather than
"next refresh" or "next block update": the timer tracks the
indexer-cursor refetch specifically (the `/offers/stats` D1 read),
not the chain-head RPC probe. Naming the action that's about to
happen (rather than the side effect) keeps the operator's mental
model accurate when both probes run on the same cadence but with
different consumers.

## Honest labels — "Last safe block (available)" replaces "Chain safe head"

Before today's edits, the panel and popover showed two block-space
rows labelled "Last safe block (indexed)" and "Chain safe head".
Conceptually those represented the same family of value (chain
heads), differing only in whether the indexer or the chain itself
was the source. After thinking through what the page actually
shows the user — the page renders rows up to the chain `safe`
head via the RPC live-tail, NOT just up to the indexer cursor —
the second row was relabelled to **Last safe block (available)**
to mirror the "(indexed)" qualifier. Now both rows share a single
naming pattern that operators can read at a glance:

- `Last safe block (indexed)` — where the watcher cron has crawled
  to in D1.
- `Last safe block (available)` — where the page can render data
  up to via the RPC live-tail (this IS the chain `safe` head; the
  "available" framing is honest about what the page actually has).

The third row, `Blocks to catch up`, becomes the gap between the
two — meaningful at a glance because both are now in the same
naming family.

## Live-tail status indicator

A new row in the drawer panel — **Live-tail status** — answers the
"is the page actually catching up?" question without an operator
having to do the gap math themselves. Three states:

- **In sync** — gap is below ~100 blocks; the live-tail finishes
  within one cron tick.
- **Catching up · ~N blocks remaining** — gap is non-trivial but
  bounded; operator can watch the gap shrink across cron ticks.
- **Deep backlog · ~N blocks remaining (catch-up will take many
  cron ticks)** — gap is large enough that the catch-up window
  spans multiple ticks; honest signal that the watcher fell far
  behind, time to investigate.

The threshold between catching-up and deep-backlog is documented
in code as `LIVE_TAIL_BACKLOG_BLOCKS = 50_000` — diagnostic-only
today because the live-tail does NOT actually skip past it (it
just keeps chunking). When the post-mainnet `LiveTailProvider`
lift lands, this threshold becomes the actual hard cap for the
catch-up window; the indicator's labels stay valid through that
future change.

## Memory hygiene — project context + coding standards as top-priority entries

Per the user-declared protocol "for every session, read this
first", two memory files were promoted to the top of the project's
`MEMORY.md` index:

- `user_project_context.md` — Vaipakam project context: Tamil
  "Bank", P2P lending + borrowing + NFT rental platform, expected
  collaboration as expert software dev / solution architect /
  domain functional specialist, and the phase-aware-tradeoff
  guidance for proposing changes.
- `feedback_coding_standards.md` — every code change must satisfy
  four bars: coding standards (Solidity 0.8.29 + viaIR + custom
  errors + viem on FE), style conventions (BPS + 1e18 scaling +
  LibVaipakam slot pattern), best-practice patterns (phased
  rollouts + fallback layers + chainId-keyed state), and proper
  doc comments (natspec for Solidity, JSDoc for TS) explaining the
  WHY of any non-obvious choice.

Both entries carry a `**READ FIRST**` prefix in `MEMORY.md` and
sit above all other entries — the auto-memory loader processes
the index top-down with a 200-line truncation cap, so promoting
these guarantees they survive even if the index grows further.
The previous plain-bullet duplicates of the same content at the
bottom of the index were removed so there's a single canonical
source for each rule.

## Branch — `research/webhook-vs-polling-defi-survey`

A new branch was checked out off `main` for the upcoming
architectural survey of how major DeFi / DEX platforms — Uniswap,
Aave, Sky/MakerDAO, Lido, Compound, Balancer, dYdX, Hyperliquid
— push events to clients (WebSocket, SSE, subgraph subscriptions,
webhook). The intended outcome is a reference doc that informs
whether to layer a WebSocket / SSE pipe over the existing polling
architecture (with polling staying as the canonical fallback for
disconnects). No code work yet on this branch — research first,
implementation decision after.

## OP PositiveFlows — v7 closed the smoke-test matrix

The lone remaining smoke-test loose end from the 2026-05-06
rehearsal: OP Sepolia PositiveFlows landed only 98 of 191 txs in
its earlier v6 broadcast (dRPC `eth_estimateGas` stale-view on a
`claimAsLender` after the prior `repayLoan`). Today's v7 attempt
ran with the same flag set that cleared OP PartialFlows v2 and
Base PartialFlows v4: `--no-skip-simulation` + default 130 % gas
multiplier + `--legacy --slow --delay 5`. Forge runs its own
on-chain simulation locally against live state for each tx,
bypassing dRPC's stale snapshot during gas estimation.

**Result: 191 / 191 — full pass.** Combined with today's other
broadcasts and yesterday's, the complete testnet smoke matrix is
now green:

| Chain        | PartialFlows | PositiveFlows |
| ------------ | ------------ | ------------- |
| Base Sepolia | 143 / 143    | 195 / 195     |
| Arb Sepolia  | 143 / 143    | 199 / 199     |
| OP Sepolia   | 143 / 143    | 191 / 191     |

Every chain has a clean pass on both flow scripts using the same
contract bytecode that landed in the 2026-05-06 redeploy. The
dRPC stale-view was the sole tooling obstacle and the
`--no-skip-simulation` mitigation cleared it conclusively. The
runbook's `Smoke tests` section now has empirical confirmation
that the recommended flag set is the right default for testnet
broadcasts going forward.

## Architecture-optimisation pivot

The user's call mid-day: "we have enough time for mainnet, so
let's concentrate on optimising the architecture." Earlier today
the recommendation was to ship small UX wins now and defer the
larger event-sourcing + LiveTailProvider lift to a post-mainnet
stable window. The new direction is to do the architectural work
in the window we have BEFORE mainnet — and to broaden the scope
beyond what was originally on the table:

- IPFS-hostable frontend with full no-server fallback — the page
  must work even when no centralised indexer / API / Cloudflare
  Worker is reachable, reading directly from chain RPC.
- Optimised RPC calls so the no-server fallback is not just
  technically possible but actually pleasant to use — Multicall3
  batching, IndexedDB caching, event-sourced state, RPC failover.
- Industry-standard, battle-tested patterns matching what
  Uniswap / Aave / Sky / Lido / Hyperliquid do on hosted
  decentralised frontends.

Plan-of-record (sequenced by dependency, not by calendar):

1. **Phase 0 — audit + design docs.** Three documents in
   `docs/internal/` and `docs/DesignsAndPlans/`:
   `EventSourcingAudit.md` (every Solidity event mapped to
   currently-emitted fields, storage-field gaps, gas cost of
   extending, per-event extend / skip recommendation);
   `LiveTailProviderDesign.md` (AppLayout-level provider's public
   API, route → cadence map, dispatcher contract, cache-
   invalidation semantics); `CacheStoreDesign.md` (IndexedDB
   schema, eviction rules, version-bump triggers, what's cached
   for which user, and the merge logic for events arriving from
   both Worker and frontend live-tail). Plus a comprehensive
   platform-decentralisation design covering IPFS hosting + RPC
   failover + serverless fallback strategy.
2. **Phase 1 — contract event extensions.** Hard mainnet gate.
   Land before final mainnet code-freeze. Pairs with an audit
   re-pass.
3. **Phase 2 — watcher decoder updates.** Server-side consume the
   extended events; drop the redundant `getOfferDetails` /
   `getLoanDetails` fetches the new event payloads obviate.
4. **Phase 3 — `LiveTailProvider` lift.** Single AppLayout-level
   scanner + topic-routed dispatch + page-aware cadence. Replaces
   the per-hook scanners in `useMyOffers`,
   `useIndexedActiveOffers`, `useIndexedLoans`,
   `useIndexedActivity`, `useIndexedClaimables`, `useLogIndex`.
   Frontend-only; no contract dependency.
5. **Phase 4 — IndexedDB cache layer.** Cached tables for the
   user's own offers / loans plus top-N global offers; lazy
   `getOfferDetails` / `getLoanDetails` only on cache miss.
6. **Phase 5 — IPFS hosting + serverless fallback.** Pin the
   frontend bundle to IPFS (Pinata / Web3.Storage / Spheron /
   Fleek), wire the ENS contenthash record to the latest CID,
   ensure every server-dependent code path has a chain-RPC
   fallback, multi-RPC failover with health checks, optional
   user-supplied RPC URL.
7. **Phase 6 — WebSocket / SSE layer.** Worker durable-object
   endpoint that pushes the watcher's already-decoded events to
   subscribed clients; polling stays as the fallback path on
   disconnect. The `research/webhook-vs-polling-defi-survey`
   branch's reference doc informs this design.

Risk-de-risking principles for the whole plan: current
architecture stays as the fallback at every phase (every consumer
migration is flag-gated, every WebSocket pipe falls back to
polling on disconnect, every server-dependent read path has a
direct-chain fallback); Phase 1 is the hard gate (contracts are
the only non-reversible step — the design doc decides what
extensions are worth the gas tax); audit re-pass scope is
budgeted for ~1 week of calendar between Phase 1 and the next
mainnet rehearsal.

## Documentation discipline

Per the user-declared "Document every completed task functionally
under /docs/" rule, this file maintains the daily-cadence release
notes thread. The content is written in plain language without
code blocks or implementation-side jargon, so a reader on the
project's product / ops side can follow what changed and why
without having to grep the codebase.
