## Thread — a second axis for the app's live review: role journeys, not just features

The connected app's verification matrix is organised by feature — one row
per PR or issue, each asserting that a mechanism works. That answers "did
this ship?" It does not answer "can someone who has never seen this
product get from the landing page to a lending offer without hitting a
dead end?", and a surface can pass every feature row while failing that.

A new live driver covers the second question. Each scenario is written as
a user goal with its desired outcome recorded BEFORE the run, and the
actual outcome captured from the live page, so a run can be diffed
against the previous one rather than merely going green. Roles are wallet
postures rather than personas: a first-time visitor is reproduced with no
wallet installed at all, so the app's no-provider paths are the ones
exercised. Two weaker versions were tried first and are worth naming — a
wallet that connects itself tests a returning user, and a wallet that is
installed but reports no accounts tests someone who has an extension and
has not connected it. Neither reaches the code a visitor without a wallet
actually runs.

Fifteen scenarios ran against the deployed app and all fifteen passed.
The one worth naming is the recovery flow: disconnected, it explains what
the flow is, warns that recovering unrecognised tokens can get a wallet
blocked, and asks for a connection while rendering no form at all;
connected, it states plainly that recovery is unavailable because the
screening service is not configured on this network, and that tokens stay
where they are. That is the arm the fork suite cannot check honestly,
because its spec installs a mock oracle.

Two limitations are recorded in the matrix rather than left implied.
Several assertions began as body-length thresholds, and observed lengths
swung between runs as asynchronous reads landed, so a threshold loose
enough to accept both ends caught a blank or missing page and little else.
Review closed that gap before this shipped: each of those scenarios now
identifies its page by the heading the app itself publishes, and the ones
promising controls or claimable items require those specifically — a
faucet with nothing to mint, or a page still loading, no longer counts.
What a green run still cannot tell you is whether the surface is right,
only that it is the right page, populated, finished loading, and — for
the connected roles — genuinely connected.

That last clause was itself a late correction, and the more useful of the
two. The check that proved a connected run really was connected worked by
noticing that the "connect your wallet" button had gone. Anything that
stopped it recognising that button, a reworded label being the obvious
case, would have read as success, and the whole connected walkthrough
would then have run against a signed-out app while reporting green: the
pages it visits still render their headings and their controls to a
visitor. It now looks for the address the header shows only once a wallet
is actually connected, and checks it is the right one.

One scenario also learned to say it did not find out. Asked to confirm
that recovery presents itself as unavailable on a deployment with no
screening service configured, it used to accept a working-looking
recovery form as evidence that a service must be configured — which is
the same page it was sent to judge. Where it cannot tell a configured
deployment from the regression it watches for, it now reports the
scenario as unverified rather than passed. A review that overstates what
it checked is worse than one that admits a gap, because only the second
gets fixed.
And both false failures during the driver's own first runs were the check
being wrong rather than the product: an assertion written from
imagination missed the shipped copy's curly apostrophe, and a settle
period too short for an asynchronous configuration read renders
identically to a disconnected page. Both lessons are written beside the
rows they came from.
