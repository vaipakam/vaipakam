## Reward remittance: each day says why it does or does not close (#2760, PR #2826)

The keeper's reward-remittance pass warned, every run, about each finalized day that was neither remitted nor closed. It could not tell a day still owed but gated (waiting on its commitment report, or short of recycled backing) from a day that owed the mirror nothing, so on a quiet mirror the warning repeated for every zero-budget day in the scan window, and the operator had to check each one by hand.

Base now states, for each day it is asked about, the send's own verdict: already remitted, already closed, nothing owed to that mirror, remit-ineligible (funded through the manual budget path), awaiting its commitment report, short of recycled backing, or closeable now. It is a read-only view over the same plan the send applies, so it cannot disagree with a send. Nothing about funding changes.

The keeper now names only the days still owed and not closeable, each with its reason, and counts that mirror as not yet settled until they close. A day that owed the mirror nothing is no longer reported. Against a Diamond without the new view, the keeper keeps its earlier warning. The incident runbook's stand-down rule is updated to match. (Owner decision 2026-10-25.)
