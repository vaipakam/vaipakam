## The wallet-analytics fix is now checked against the deployed apps, and the check can prove itself

Switching off the wallet kits' built-in reporting was verified, when it shipped,
only by the compiler accepting the settings. That confirms the settings exist;
it says nothing about whether the reporting actually stopped. A committed check
now answers the second question against the deployed sites.

It loads each connected app with no wallet installed, never touches the connect
dialog, and watches for any request to the vendors' reporting addresses. That is
the right moment to look: the reporting does not wait for someone to open the
wallet dialog. The apps try to restore a previous wallet session as soon as they
load, and doing so builds a connector before asking whether it has a session to
restore — which is where that kit's reporting begins. In practice one of the two
kits is built this way and the other is not, which is why the check speaks about
them separately rather than as a pair.

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

### It refuses to report a pass it cannot justify

Review pointed out that the check could still have passed without testing
anything: asking a browser to open a page succeeds even when the server returns
an error page, and waiting a fixed time proves nothing about whether the app
ever started. A broken deployment would have looked identical to a clean one.

It now requires evidence that the thing under test actually ran before it will
report anything: the page must load successfully, the app must have rendered,
and the wallet kit must have left its own fingerprint in browser storage —
which only happens if the kit was constructed, which is the moment the
reporting would begin. Anything less is reported as "not verifiably exercised"
rather than as a pass. Confirmed by pointing it at a page with no wallet
support, which it correctly refuses to bless.

That refusal is also counted separately from a real failure. An earlier version
lumped the two together and announced that a page had sent tracking data when it
had done nothing of the sort — a false accusation inside a check about honest
reporting.

### One thing it deliberately does not claim

The second kit is not tested at all. It turns out not even to be started when
the page loads, and it would stay quiet on a first visit in any case, since it
only forwards activity an earlier session left behind. So the check now reports
each kit separately and says plainly that this one was not exercised, instead of
printing one line that would let a reader assume both were covered. Closing that
gap properly needs a real returning-visitor session, and is recorded as its own
piece of work rather than approximated with invented data.

Still outstanding, and not claimed anywhere: nobody has yet completed a real
wallet connection on these apps since the change. The settings could be correct
and the connect flow still broken, and only a person with a wallet can tell.
