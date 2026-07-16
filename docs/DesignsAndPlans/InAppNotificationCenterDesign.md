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
