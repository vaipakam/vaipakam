## Thread — In-place risk-tier re-affirmation in the dapp (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The Risk Access settings page can
now **re-affirm a held tier in place** when a governance risk-terms change has made
it stale, instead of forcing the user to lower then re-raise it.

A vault's opted-up tier becomes effective only while its anchor matches the live
risk-terms version; a terms change re-locks it. Previously the page could not
reliably tell a tier that was merely *cooling down* from a recent raise from one
made *stale by a terms change*, so it left both cases informational. A small new
read-only view exposes the vault's tier-anchor version, so the page now
distinguishes the two: a cooling tier stays informational (re-clicking would
restart the cooldown), while a stale tier shows a clear "the risk terms changed —
re-affirm to restore it" note and a one-click **Re-affirm current tier** button.
The button re-submits the same tier, which re-anchors it to the latest terms; on
deployments configured with an opt-up cooldown it becomes effective again once
that cooldown elapses (re-affirm re-arms the cooldown, exactly like any raise).
Older deployments without the new tier-anchor view can't tell stale from cooling,
so they simply don't surface the button.
