## Thread — Recycling governor PR-3a: recycle-bucket ledger + forfeit re-route (PR #TBD)

First on-chain stage of the ratified VPFI recycling balance governor
(#1217/#1222, design ratified 2026-07-15). The Diamond now carries a
protocol-owned **recycle bucket** — a ledger slice of its own VPFI
balance, never a separate pocket — with one credit chokepoint that keeps
three things in lockstep: the bucket balance, the per-day credited series
the governor's trailing absorption average will read, and a public
per-credit event carrying the receipt class, reference, amount, and
schedule day.

The first live receipt class is **forfeited interaction rewards**: both
the claim-path forfeit and the permissionless per-loan sweep now keep the
forfeited VPFI in Diamond custody and credit the bucket instead of
transferring to the treasury (owner directive: recycle absorbed VPFI into
the reward stream — never burn, and the platform's take is the governor's
retained margin, not forfeit capture). Pool-cap accounting is unchanged —
forfeits still consume the 69M interaction pool exactly as before; only
the destination ledger moved. The former forfeit-to-treasury event is
retired (no off-chain consumer read it); the recycle event replaces it
and is the designated feed for the #1218 self-funding ratio and the RL-2
loop-closure ratio's absorption term.

Two transparency reads expose the bucket balance and the per-day credited
series. Consumption of the bucket (the absorption-coupled reward budget)
arrives with the governor's later stages (PR-3b/3c) and is zero until
then — absorption without distribution coupling is the accepted launch
posture. Functional spec §9 gains the "Recycle bucket" rules and §4's
forfeit-routing bullets now state the recycle destination. Part of the
#1217 Phase A′ stack; RL-3's expired-reward sweep (#1305) will credit
through the same chokepoint.
