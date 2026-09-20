## Thread — four deploy scripts were writing and reading outside the redirect they were supposed to follow (PR #<n>)

Deployment tooling records what it did in a per-chain folder of the repository — the address inventory other tooling reads, plus a few ceremony receipts alongside it. A recent change made that folder redirectable, so a test can run a real script end to end without overwriting the committed record. The redirect is consulted in one place, and every path helper was supposed to reach it.

Four scripts did not. Two wrote ceremony receipts and two read the address inventory, and all four built the folder path themselves from a fixed string. Under a redirect they ignored it: the two writers would have dropped their receipts into the committed folder while everything else from the same run went to the scratch one, and the two readers would have configured a redirected rehearsal against addresses belonging to a different deployment altogether. Nothing drives those scripts under a redirect today, so this was a latent inconsistency rather than an observed failure — but it is the kind that surfaces the first time someone writes the test that would have caught it.

All four now go through the shared helpers, and the helpers themselves were re-layered so exactly one function decides where artifacts live; everything else, including a new form for "a named record beside the address inventory", is built on top of it. One of the four resolves its chain from an operator-set name rather than from the chain it is connected to, which is why there is a second entry point taking that name — rebuilding the root by hand to serve that case is precisely how these four drifted out.

The accompanying test covers the helpers directly and the ceremony receipt's own call site through a probe; restoring the fixed string in that one place fails it. The two inventory readers are not covered, and the test says so in its own header rather than implying otherwise: both are internal to scripts that cannot carry a redirect at all, so a probe would have to grant them a capability they do not have and would end up asserting its own wiring. They are correct by construction — the hand-built root is gone — and that is the claim being made for them.

Worth recording because the comment was load-bearing and wrong: the note on the existing path helper stated that every artifact path in the library was built there. It was not, in two separate ways, and it had been read as assurance. It now says where the single place actually is and names what had been sitting outside it.

Closes #2261.
