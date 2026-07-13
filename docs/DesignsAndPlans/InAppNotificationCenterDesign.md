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
| maturity approaching | derived time-based rows (T-7d, T-1d) computed by a cron pass over active loans — covers **illiquid loans too** (calendar events need no oracle) |
| grace entered / grace ending | both parties |
| partial repay / periodic-interest settled | lender |
| claim available (settlement, rewards day finalized) | claimant |
| loan settled / defaulted / liquidated | both parties |
| HF band change (liquid only) | borrower (reuses keeper band machinery's thresholds) |

Read/unread state: per-wallet in D1 (wallet-keyed, no PII). The chain
remains authoritative for any action; rows deep-link to Loan Details /
Claim Center and re-verify there (indexed-hints-only discipline).

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
