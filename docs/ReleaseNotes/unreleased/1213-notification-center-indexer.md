## Notification center — indexer materialization backbone (PR #<n>)

The first slice of the in-app notification center (#1213 / E-11): the
indexer now materializes a per-wallet inbox from the loan lifecycle it
already ingests, so the connected app can eventually render a free,
wallet-native notification feed (bell + unread count + panel) instead of
relying only on the off-chain paid channels (Telegram / Push / SMS /
Email). This PR is the backend backbone — the user-facing surface is a
follow-up frontend PR.

A new `notifications` table (migration 0038) holds one row per
(recipient wallet, notification). On every ingest scan the indexer
derives inbox rows for the five core loan-lifecycle events — loan
matched, partial repayment, repaid, defaulted, and liquidated — with the
recipient resolved to the CURRENT position-NFT holder (so a
secondary-market buyer is notified and an exited seller is not, the same
ownership discipline the claim rows use). Materialization is idempotent:
each row carries a deterministic dedup key, so a re-scan or catch-up
never duplicates an inbox row, and a hiccup here never fails a scan (the
rows are derived convenience data on top of the authoritative event
ledger).

Two routes serve the inbox: a newest-first feed with an unread count and
a keyset cursor, and a recipient-scoped mark-read endpoint (mark specific
rows or all). The chain stays authoritative for any action — rows carry
a loan id and deep-link to Loan Details / the Claim Center, which
re-verify there.

A coverage guardrail (`check-notification-coverage.mjs`, wired into the
indexer typecheck) mirrors the existing event-coverage guard: every
loan/offer state-change event must either map to a notification or be
consciously allowlisted with a reason, so a new lifecycle event can't
silently go un-notified. The richer lifecycle rows (offer matched,
periodic interest, sale/refinance/offset terminals), the time-based
calendar rows (maturity approaching, grace entered — which cover
illiquid loans too), and the liquid-only HF-band rows are queued
follow-ups, each already accounted for in that allowlist.

Part of #1213.
