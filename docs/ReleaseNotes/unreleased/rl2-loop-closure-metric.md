## Thread — RL-2: loop-closure metric — retention ledger + VaultVpfiDebited observability (PR #TBD)

Second delta of the recycling loop-closure design (RL-2, ratified
2026-07-16). With RL-1's claim-to-vault delivery live, this makes the
loop's health measurable: how much of the distributed interaction-reward
VPFI actually stays inside the sink system.

One small contract change: the Diamond now emits a dedicated debit event
whenever protocol-tracked VPFI leaves a user's vault through the single
tracked-balance decrement chokepoint — wallet withdrawals, notification
tariff pulls, fee pulls, and future perk spends all route through it.
Without this signal, vault outflows were invisible off-chain and any
retention accounting would overstate loop closure.

The indexer gains a per-user reward-retention ledger driven by the RL-1
delivery event and the new debit event: deliveries credit it, debits
decrement it rewards-spent-first (clamped at zero — later personal
deposits never re-inflate it), and every effect applies exactly once even
when scan ranges overlap. A new read endpoint serves the two ratios the
design pins: the daily flow ratio (per-user same-day netting, so one
user's spending never cancels another's retained delivery, and a
claim-and-spend-same-day counts once — the metric is a conservative lower
bound that can never overstate closure) and the cumulative stock ratio.
Zero-distribution days report "not applicable" rather than a misleading
zero. The absorption term is defined but reads zero until the governor
stack's recycle-bucket accounting lands (PR-3a), so no re-baselining
happens later. The endpoint is the metric's canonical surface until the
transparency-dashboard card (#1218) gives it a display home. Functional
spec §9 gains the metric's intended-behaviour rules in the same diff.
Closes #1303.
