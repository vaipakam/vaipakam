## Indexer — project HF-liquidation terminal status (#1293)

Fixes a latent indexing bug: a loan closed by an HF-based liquidation was
left showing as **active** in the off-chain index forever, even though the
chain had defaulted it.

The two HF-liquidation close-outs (`HFLiquidationTriggered` — full and
split terminal — and the governance-gated `LiquidationDiscounted`) close a
loan to Defaulted on-chain but emit only their own event, with no generic
"defaulted" companion the indexer was watching for. The indexer had no
handler for them, so the indexed loan status never advanced — the
"every loan stuck active" class of bug. Any surface reading the indexed
status (active-loan counts, position lists) over-counted until a client
re-checked the chain.

The indexer now flips such a loan to defaulted the moment it sees the
liquidation event (idempotent on a re-scan, and it clears any stale
collateral-sale listing the same way the other terminal paths do). The
event-coverage guardrail is updated to treat these as handled rather than
relying on the incorrect "a companion event covers it" note.

This also switches on the in-app notification center's HF-liquidation
alerts: those rows were deliberately held back until the index reflected
the terminal state (so a "your loan was liquidated" notice could never
deep-link to a loan the app still showed as live) — with the projection in
place they now fire on a real HF liquidation, no notification-side change
needed.

Closes #1293.
