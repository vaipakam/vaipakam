## Thread — One page's network outage no longer disappears into another page's success (PR #TBD)

The drive that reviews the deployed build on a testnet watches every
network call the page makes, so that when a card fails to appear it can
say whether the app was at fault or the network was. A failed call is not
by itself a fault: the app retries a failed read and falls back to a
second provider, so a failure followed by its own retry succeeding is one
healthy read. The rule that recognises that was matching calls by name
and arguments alone, which is the same for the same read on every page
the drive visits. So a genuine outage that spoiled one page was wiped
from the record the moment a later page made the same read successfully,
which it always eventually does.

The consequence runs in the worse of the two directions. The run could
pass while hiding that one page had been observed through a broken
connection; and worse, that page's missing card would then be reported as
the product's fault, because the evidence explaining it had been erased.
The whole point of this drive's two failure verdicts is that "the app did
something wrong" and "we could not look properly" stay distinct, and this
could turn the second into the first.

The rule now reconciles a failure only against successes from the same
page. Three earlier refinements had each narrowed when a success may
clear a failure — how soon after, whether both came back in the same
response, whether the success was even requested after the failure was
known — and none of them could express which page the calls belonged to,
which is why the same gap kept reappearing at a new edge. Scope is stated
once, at the source, rather than by narrowing time a fourth time. A
page's own retries and provider fallbacks all happen within that page, so
the rule keeps doing exactly what it was written for. Where the browser
cannot tell the drive which page a request came from, the current page
stands in, which errs toward reporting a recovered failure rather than
hiding a real one — the direction this drive takes everywhere. Records
written before pages were tracked are judged exactly as they were.

The situation has not been reproduced against a real partial outage,
since arranging one across pages is beyond the test environment; this is
a correction to the scope of an identity, argued from what that identity
can and cannot distinguish.

Closes #2100. No product surface changes.
