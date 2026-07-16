# In-app notification center (E-11)

**Status:** design (frontend + indexer; no contracts). Card: #1213.
Umbrella: #1221.

## Problem

Alerts are off-chain channels (SMS/Email/Telegram/Push), partly fee-gated,
requiring PII or bot linking; there is no in-app inbox. HF alerts cover
only liquid loans; illiquid-loan holders get nothing.

## Design

### Data

A derived `notifications` materialization in the indexer's D1 (schema
change ⇒ new migration under `apps/indexer/migrations/` per the D1
discipline), populated from events already ingested by `chainIndexer.ts`:

| Event class | Notification |
| --- | --- |
| offer matched / partially filled | "Your offer #N matched (X of Y)" |
| loan initiated | lender + borrower rows |
| maturity approaching | derived time-based rows (T-7d, T-1d) computed by a cron pass over active loans — covers **illiquid loans too** (calendar events need no oracle). Recipients resolved to the **current position-NFT holders at materialization time** (`ownerOf`), never the original loan parties — positions are transferable, and original-party rows would miss secondary buyers and ping sellers who exited (Codex round-10; same ownership discipline as claim rows) |
| grace entered / grace ending | both parties |
| partial repay / periodic-interest settled | lender |
| claim available (settlement; rewards — on mirror chains only once the day's VPFI budget remittance has actually landed, not at finalization: §4a decouples them and an unfunded mirror claim reverts, matching E-3's `awaiting funding` state) | claimant |
| loan settled / defaulted / liquidated | both parties |
| HF band change (liquid only) | borrower (reuses keeper band machinery's thresholds) |

Read/unread state: per-wallet in D1 (wallet-keyed, no PII). The chain
remains authoritative for any action; rows deep-link to Loan Details /
Claim Center and re-verify there (indexed-hints-only discipline).

> **Implementation refinement (PR 1, Codex #1292 r1):** the launch tracks
> read/unread state CLIENT-side (a per-wallet last-seen cursor in the
> frontend), not as a D1 column. An unauthenticated server mark-read
> mutation is griefable (anyone could clear a victim's badge) and a
> per-action wallet signature is poor UX, so there is no server mutation
> route; the feed is served `no-store`. A future SIWE-session-gated
> server-side read-state (for cross-device sync) can add the column back.

> **Implementation status (PR 2):** the calendar rows shipped as a pure-D1
> sweep on the ingest tick (`calendarNotifications.ts`): `maturity_7d` /
> `maturity_1d` to the borrower, `grace_entered` to both parties while the
> grace window runs (suppressed once grace has closed — stale advice is
> never shown). Recipients resolve via the same current-owner columns the
> event rows use (the indexer's projection of `ownerOf`, kept authoritative
> by the Transfer handlers) rather than a per-row live `ownerOf` read.
> Dedup keys embed the maturity timestamp, so `LoanExtended` (which rewrites
> `start_time` + `duration_days`) re-arms the milestones for the new date.
> Grace follows `LibVaipakam.gracePeriod` exactly: the effective
> governance buckets ride the `protocol_config` snapshot
> (`grace_buckets_json`, migration 0039, refreshed on
> `GraceBucketsUpdated` + the 6h backstop); an empty/absent array means
> the compile-time default (Codex #1298 r1). The sweep runs only when the
> indexer is CONSISTENT — every caught-up quiet tick, and scanned ticks
> within 60 blocks of head — never mid-catch-up, where wall-clock windows
> against stale rows would mint never-retracted reminders (Codex #1298
> r1). Under a saturated window the sweep serves soonest-due first, so
> only the far-out T-7d tail can defer. Rows are stamped at the sweep's head block
> so the chain-ordered feed sorts them as current.

> **Implementation status (PR 2b):** the liquid-only HF-band rows shipped
> as a piggyback on the KEEPER's liquidator pass
> (`apps/keeper/src/hfBandNotifications.ts`) — that pass already
> multicalls `calculateHealthFactor` for every active loan each tick, so
> band classification adds zero RPC. Fixed protocol thresholds (`hf_warn`
> < 1.5, `hf_alert` < 1.2, `hf_critical` < 1.05, milli-HF), borrower-only
> (HF is the borrower's actionable number; the lender's risk lane is
> grace/terminal rows), DOWNGRADE-only with absence-of-state = healthy
> (first observation inside a band notifies once; recoveries update state
> silently; state rows live in `hf_band_state`, migration 0041, pruned
> when a loan leaves the active set). Day-bucketed dedup keys bound a
> flapping HF to one row per band per UTC day. Rows stamp the INDEXER's
> cursor block + the cron log-index sentinel so the chain-ordered feed
> sorts them as current; a crossing whose loan the indexer hasn't landed
> yet defers to the next tick rather than silently swallowing. Illiquid
> loans revert `IlliquidLoanNoRiskMath` inside the same multicall and are
> inherently excluded — the calendar rows are their risk lane. Two
> documented trade-offs: the rows only mint while the autonomous keeper
> is enabled (no keeper → no per-tick HF scan to reuse), and they reach
> the bell on its polling cadence (the keeper cannot push the indexer
> DO's `notification.created` invalidation) — the subscriber
> Telegram/Push rail remains the immediate channel.

> **Implementation refinement (PR 1, Codex #1292 r7):** a notification
> whose *kind* asserts a loan has CLOSED (`loan_repaid` / `loan_defaulted`
> / `internal_matched` — the rows that deep-link to the Claim Center) is
> gated on the indexer's own **projected** loan state, so the inbox can
> never disagree with the loan detail page. The materializer reads
> `loans.status` (+ `is_sale_vehicle`) at the scan's end and:
> - suppresses a **partial** `InternalMatchExecuted` leg — a partial match
>   reduces principal/collateral but leaves the loan `active`; only a fully
>   closed leg (`status = 'internal_matched'`) gets a row;
> - suppresses a lender-sale **vehicle**'s temporary bookkeeping loan
>   (`is_sale_vehicle = 1`) from a `loan_matched` row — the real
>   secondary-market sale surfaces via the sale-terminal rows (PR2);
> - **HF-liquidation rows** (`HFLiquidationTriggered` /
>   `LiquidationDiscounted`) were initially deferred because the indexer
>   did not project their terminal status onto `loans.status` (issue
>   #1293) — the gate held the row while the loan still read `active`.
>   #1293 added the indexer projection (the loan now flips to `defaulted`
>   on the liquidation event), so the gate passes and these rows fire on a
>   real HF liquidation, with no notification-code change.

### Surface

- Bell + unread count in the connected-app header; panel with filter by
  loan; "mark all read".
- Free for all users. Paid channels (Push/SMS/Telegram) remain the
  off-chain *delivery* layer for the same rows — the fee model funds
  delivery infrastructure, not information access.
- Wallet-scoped privacy: rows served only for the connected, signed-in
  wallet (same auth the per-user indexer reads already use).

### Coverage guardrail

New loan/offer state-change events must produce either a notification
mapping or a `DELIBERATELY_NOT_HANDLED`-style allowlist entry — extend the
existing `check-event-coverage.mjs` pattern so notification drift fails CI
the same way indexer drift does.

## Non-goals

No third-party developer webhooks (separate idea, not this card); no
in-app messaging between counterparties.

## Acceptance

E2E: drive a loan lifecycle on Anvil; assert the inbox sequence matches
the event sequence; illiquid rental shows maturity/grace rows despite
having no HF. COVERAGE.md row per the verification directive.
