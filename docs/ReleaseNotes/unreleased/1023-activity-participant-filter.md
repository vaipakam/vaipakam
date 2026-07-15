## Thread — Activity now sees your whole loan history, not just held positions (PR #TBD)

The Activity feed keeps an event when the connected wallet is a
participant — the recorded actor, a wallet mentioned in the event, or
an event belonging to one of the wallet's own loans. That last check
used to build its loan list from sources that only know about
positions the wallet currently holds: once a claim burned a position
NFT or the position was transferred away, the loan vanished from the
list, and system events tied to it by loan id alone (a settlement, a
keeper-triggered default) silently disappeared from the feed while it
rendered as complete.

The feed now also consults the wallet's permanent participation
history — every loan the wallet ever entered or held a position in,
kept by the indexer since the Rate Desk's History tab shipped — so
those events stay in the feed after the position is long gone. The
history read covers all loan shapes (a new "all" scope on the
history route includes NFT-collateral loans and internal sale
vehicles that the desk-focused view deliberately filters out), and it
is bounded like every other walk in the app: the five hundred most
recent participations, with anything deeper folded into the page's
existing "recent activity only" disclosure.

If the participation history can't be read, the feed shows its
unavailable state rather than quietly reverting to the old, narrower
filter — a feed that silently dropped events again would be worse
than one that says it can't load.

Closes #1023.
