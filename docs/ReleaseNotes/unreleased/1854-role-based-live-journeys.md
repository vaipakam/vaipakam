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
postures rather than personas: a first-time visitor is reproduced by
announcing no account AND refusing the account request, because a driver
that lets the injected wallet connect itself is testing a returning user
and calling it a first arrival.

Fifteen scenarios ran against the deployed app and all fifteen passed.
The one worth naming is the recovery flow: disconnected, it explains what
the flow is, warns that recovering unrecognised tokens can get a wallet
blocked, and asks for a connection while rendering no form at all;
connected, it states plainly that recovery is unavailable because the
screening service is not configured on this network, and that tokens stay
where they are. That is the arm the fork suite cannot check honestly,
because its spec installs a mock oracle.

Two limitations are recorded in the matrix rather than left implied.
Several assertions are body-length thresholds, and observed lengths swing
between runs as asynchronous reads land, so a threshold loose enough to
accept both ends is weak — it catches a blank or missing page and little
else, and tightening it needs per-route semantic anchors instead of size.
And both false failures during the driver's own first runs were the check
being wrong rather than the product: an assertion written from
imagination missed the shipped copy's curly apostrophe, and a settle
period too short for an asynchronous configuration read renders
identically to a disconnected page. Both lessons are written beside the
rows they came from.
