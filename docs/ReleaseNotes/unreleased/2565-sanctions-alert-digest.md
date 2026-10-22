## Thread — Sanctions-hold alerts arrive as one digest per chain (PR #<n>)

The keeper's sanctions-hold pass used to send each wallet's alert as a post of its own: one per wallet per condition (observation deadline at risk, held overdue, held with no observation chain, a reverted settlement, stuck staging), plus the chain-wide capacity and backlog alerts. A chain with hundreds of held wallets could fill the operators' chat with hundreds of messages a run. Each post could take up to ten seconds, so the pass had to reserve ten minutes at the end of every run for its alerts.

Each run now sends one message per chain. The chain-wide conditions come first, then the wallets grouped by condition. What one Telegram message cannot hold is counted per condition, and every line is written to the keeper's journal. Each condition still repeats every six hours while it holds, and stops once a fresh read shows it gone. A message that fails to deliver records nothing, so the next run sends it again. Conditions that cleared are removed in one batched write. The same shared digest helper now writes every due line to the journal for every pass that uses it, so "each named in the keeper journal" is always true.

The ten-minute reserve is replaced by a tail sized from what actually follows the sends: re-checking unconfirmed transactions, re-reading the wallets the run touched, and one alert message and one notice message per chain. The re-read now gives up on a request still in flight when its time runs out, so the tail cannot overrun. No funds move; this only changes what reaches the ops chat and when. The pass is already armed on the testnets and its wording changes with this release.

Closes #2565.
