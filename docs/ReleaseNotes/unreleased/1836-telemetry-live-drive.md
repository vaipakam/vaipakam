## The wallet-analytics fix is now checked against the deployed apps, and the check can prove itself

Switching off the wallet kits' built-in reporting was verified, when it shipped,
only by the compiler accepting the settings. That confirms the settings exist;
it says nothing about whether the reporting actually stopped. A committed check
now answers the second question against the deployed sites.

It loads each connected app with no wallet installed, never touches the connect
dialog, and watches for any request to the two vendors' reporting addresses.
That is the right moment to look: the reporting does not wait for someone to
open the wallet dialog. The apps try to restore a previous wallet session as
soon as they load, and doing so builds every configured connector before asking
whether any of them has a session to restore — which is where each kit's
reporting begins.

All three connected apps come back silent.

### Why the silence is believable

A check that watches for something and finds nothing is worthless if it could
not have seen that thing in the first place — a failure this project has been
bitten by before, and the reason the checks here are built to be calibrated
rather than trusted.

So this one was calibrated against the broken configuration. With the setting
removed, on a local copy, a single page load produced two reports to the wallet
vendor before any wallet was involved. Restoring the setting on the same copy
produced none. That before-and-after is recorded in the check itself, along with
instructions to repeat it if the check ever goes quiet for a reason that seems
too convenient.

It also confirmed, rather than assumed, the claim that prompted the change: the
reporting really did cover every visitor, not only those who reached for a
wallet.

### One thing it deliberately does not claim

For one of the two kits, a first-time visitor sends nothing even when the
reporting is switched on — it forwards only what an earlier session left stored.
So a clean result is strong evidence for one kit and weak evidence for the
other, and the check says so rather than implying it covers both equally. The
second kit's setting is confirmed by reading the configuration that actually
resolves, which is a different kind of evidence and is described where it
belongs.

Still outstanding, and not claimed anywhere: nobody has yet completed a real
wallet connection on these apps since the change. The settings could be correct
and the connect flow still broken, and only a person with a wallet can tell.
