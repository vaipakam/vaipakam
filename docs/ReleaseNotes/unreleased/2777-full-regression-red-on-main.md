## Thread — the full regression is green again (PR #<n>)

The first full pre-deploy regression run since several reward changes landed found two failures that the per-PR lane cannot see.

**The reward remittance's destination gas is re-derived.** Each reward budget Base sends to a mirror asks the mirror to run its receiver with a fixed amount of gas. That figure is derived from the mirror's measured cost of taking in a delivery, plus a reserve for the receiver's own work, plus a quarter's margin. The intake has grown since the figure was last measured (from 685,689 gas to 710,205), so 1,000,000 no longer left the full quarter's margin. A test exists to catch exactly that, and it failed. Deliveries on the testnets were not failing: the gas still fit, only with less margin than the rule requires. The figure is now 1,050,000, derived by the same rule. The only effect on funds is a slightly higher cross-chain fee on each remittance, for the extra destination gas. Base quotes that fee on-chain from the same figure, so the sender is never short. No amount delivered changes.

**A reward test suite no longer crashes the compiler.** One test suite for the closed-day proof could not be compiled: the pinned Solidity compiler stopped with an internal error, and every other suite compiled alongside it went unrun. The suite is now two test contracts over one shared setup, one for days that prove closed and one for walks that refuse or keep a day open. The tests themselves are unchanged. The compiler defect is noted on the issue; a compiler upgrade would be a separate decision.

Closes #2777.
