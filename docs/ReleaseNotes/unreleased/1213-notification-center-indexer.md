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
derives inbox rows for the loan-lifecycle events that concern a wallet —
loan matched, partial repayment, repaid (including the swap-to-repay
path), defaulted (including backstop absorption), and liquidated — with
the recipient resolved to the loan's original parties, a deterministic
choice that does not depend on how the indexer batched blocks (resolving
the current position-NFT holder for a secondary-market buyer's claim
relevance is the follow-up cron rows' job). Materialization is idempotent:
each row carries a deterministic dedup key, so a re-scan or catch-up
never duplicates an inbox row; the per-loan party lookup is chunked so a
large catch-up scan can't exceed the database's bind-parameter limit; and
a hiccup here never fails a scan (the rows are derived convenience data
on top of the authoritative event ledger).

A single route serves the inbox: a newest-first feed with a keyset
cursor, served no-store as a per-wallet surface. Read/unread state is
tracked CLIENT-side (a per-wallet last-seen cursor in the frontend)
rather than as a server column — an unauthenticated server mark-read
mutation would be griefable (anyone could clear a victim's badge) and a
per-action signature is poor UX, so the launch keeps read-state local
(a deliberate refinement of the design doc's "read-state in D1" line; a
future SIWE-session server-side version can revisit). The chain stays
authoritative for any action — rows carry a loan id and deep-link to
Loan Details / the Claim Center, which re-verify there.

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
