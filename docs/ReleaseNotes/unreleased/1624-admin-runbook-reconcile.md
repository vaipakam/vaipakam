### The administrator's knob reference described a protocol we no longer run

The knob reference has two copies: an internal one for operators and auditors,
and the published page at `/protocol-console/docs`. One is meant to be generated
from the other. They had quietly swapped roles — corrections kept landing on the
published copy, because that is the file anyone editing site content opens, while
the internal one went untouched for months.

The result was a documented workflow that had become dangerous. Running the sync
exactly as instructed would have overwritten the published page with the older
copy, reinstating a description of a cross-chain purchase flow that was removed
deliberately, and rewriting the cross-chain section back to a messaging provider
the platform migrated off. Nobody had run it, so nobody had noticed.

Both copies are now reconciled and identical, and the internal one is again the
source. Content that only it had — the graduated partial-liquidation bounds, the
loan-admission health-factor floor, the quote-time rate model, the automatic
lifecycle kill switches and the feature kill switches — has been carried across
to the published page, which was missing all of it.

Two sections were deleted rather than carried across, because the knobs they
describe no longer exist: the cross-chain purchase watchdog, and a staking yield
that was removed some time ago. Each was checked against the contracts
individually rather than assumed, which is how they were caught — one of them had
been about to be published for the first time.

The cross-chain description was rewritten rather than renamed. The published copy
had already been half-corrected: the headings named the current provider while
the text beneath still described the old one's peer mesh and its verifier policy,
and the chain identifiers were still described using the old provider's numbering
scheme. It now describes what is actually configured — the three address maps on
each chain's messenger — and says plainly that transport security is operated by
the provider and uniform for every integrator, so there is no verifier selection
to get wrong.

### And a check so the two cannot drift apart again

A generated file that can be hand-edited without complaint is not generated, it
is forked — and the moment it forks, the generator becomes a weapon pointed at
whichever copy is newer. A new check compares the two on every change and fails
if they differ, naming the first line that disagrees and pointing the fix at the
source rather than the copy. The sync script now also warns, before it runs, that
it overwrites.
