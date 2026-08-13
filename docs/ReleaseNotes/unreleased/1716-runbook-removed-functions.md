## Deploy runbooks no longer instruct operators to call functions that were deleted (#1716)

Two operator runbooks still told whoever was following them to configure and
operate a cross-chain purchase flow that was removed for legal reasons some
time ago. Seven of the functions they name no longer exist; calling any of them
fails outright.

The reason this is worth a release note rather than a quiet tidy-up is where
the instructions sat.

One of the two documents opens by declaring itself the gate between "the
contracts pass their tests" and "real users can route real value through the
protocol", and states that every step in it is a hard prerequisite. Its
pre-launch checklist contained boxes that could never be ticked, because the
contracts they refer to are not deployed and cannot be. A checklist with an
impossible item has only two outcomes, and both are bad: either a release
blocks on a phantom step, or people learn to tick boxes they have not actually
verified. On a pre-launch gate the second is the dangerous one.

The same document's incident-response section was worse in a quieter way. It
told a responder handling a funds-at-risk situation to check pending refunds
using a recovery function that does not exist, and listed a message type that
was removed with the flow. That is time taken from someone under pressure, at
the exact moment they can least afford it.

The other document is the current cross-chain cutover runbook, and it already
contradicted itself: an early section correctly records that these contracts
are not part of the deployed stack, while three later sections continue to
treat them as live, including a funding step and its own checklist box. Nobody
reading it end to end could tell which half was current.

Steps that cannot be performed are now removed rather than annotated. Where a
reader might otherwise wonder whether something was dropped by mistake, a short
note records what stood there and why it went. Explanations that were merely
wrong — a treasury setting described as belonging to the purchase flow, two
configuration values documented as required when nothing reads them any more —
are corrected in place.

Three sibling runbooks referenced the same removed surface and were left
untouched: each already carries a banner saying so, and those banners are the
model the corrections here follow.

No behaviour changes — these are operator instructions only.
