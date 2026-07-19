## Indexer — Durable Object write diet + relaxed cron backstop (PR #<n>)

The hosting free plan caps how many Durable Object storage rows the
indexer may write per day, and the cap was being exceeded — almost
entirely by bookkeeping that wrote the same values over and over. Two
changes bring usage well under the cap:

- **Write guards**: the per-chain ingest object's trigger and loop
  bookkeeping now read-compare-skip before every storage write. An idle
  "anything new?" ping — the overwhelmingly common case — previously
  spent several storage rows re-writing an unchanged chain id, an
  unchanged scan target, and a reset of a counter that didn't exist;
  it now writes nothing beyond the single unavoidable alarm arm.
  Genuinely changed values still persist exactly as before, batched
  into one write.
- **Cron backstop relaxed to every 5 minutes**: on-chain events reach
  the indexer through webhooks, which trigger an immediate scan — event
  freshness (offers, loans, the notification bell's event rows, the
  push rail) does not ride the cron. The cron is the time-driven
  backstop (due-date reminder sweep, market-expiry sweep, config
  refresh backstop), and those duties tolerate minutes. Connected apps
  learn the new cadence automatically — the rail reports its expected
  scan cadence and clients size their "is the live rail healthy?"
  window from the reported value — and the keeper's loan-health pass
  had its freshness tolerance widened to match, so health warnings keep
  minting.

Two review-round refinements keep every latency property that the old
schedule provided: the every-minute schedule still exists and drives the
LEGACY fallback path (so an incident rollback away from the new ingest
plumbing keeps its old per-chain freshness — each tick routes to exactly
one path), and a webhook whose block hasn't reached the safe
confirmation depth yet keeps being retried by the ingest object itself
(a slower self-driven retry lane) instead of waiting for the next cron.

What users may notice: nothing on event-driven updates (webhook-fast as
before). The purely time-driven inbox reminders (due-date, grace,
health-band) and market-expiry cleanup can now land up to ~5 minutes
later than before — well inside their hours-to-days windows. The
autonomous keeper and agent keep their every-minute schedules; they do
not touch the capped storage, and the keeper's liquidation latency is
unchanged.
