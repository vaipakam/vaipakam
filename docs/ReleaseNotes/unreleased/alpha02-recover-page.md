## alpha02 — stuck-token recovery page (PR #<n>)

The main app's stuck-token recovery utility now exists on the alpha02
site too, rebuilt in its plain-language style. It returns ERC-20
tokens that landed in a user's vault address outside the app (a
mistaken direct transfer, or "dust" a stranger sent) to the connected
wallet — such tokens are never part of any deal and never affect
balances or positions.

The page is deliberately unlisted, exactly like the original: it has
no navigation or Settings entry, search engines are told to ignore
it, and the only way in from inside the app is a new explainer card
on the Help page that first spells out the danger — if the sender a
user declares turns out to be sanctions-listed, their wallet is
flagged and blocked from every new-position action (creating or
accepting offers, deposits, recovery and the like), not just from
this page. Existing loans can still be repaid and closed, and the
block lifts automatically if that address is later removed from the
sanctions list. That is the "dust poisoning" trap the explainer
warns about, and reading it before finding the button is the safety
design, not an oversight.

The flow itself keeps every deliberate speed bump: declare the token,
the sender (a wallet you control), and the amount — capped at the
provable surplus sitting in the vault beyond what the protocol
tracks; review the declaration next to the standing warning; type
CONFIRM to arm signing; sign a typed acknowledgement; and the outcome
is read from what actually happened on-chain, distinguishing a
successful return-to-wallet from the flagged-wallet outcome (which
the page explains honestly, including that the block lifts
automatically if the flagged address later leaves the sanctions
oracle's list).

One honest gate the original relied on documentation for is now
explicit in the page itself: recovery depends on the protocol's
screening service, and on a network where that service isn't
configured yet the page says recovery isn't available — instead of
letting anyone sign a transaction that could only fail.

The declaration a user signs states they have read the Advanced User
Guide's section on stuck-token recovery, so the review card — and the
Help explainer — now link straight to that section rather than leaving
the reader to find it.

Three post-submission cases are handled with the same care as the rest
of the flow. If the wallet replaces the transaction, the page follows the
replacement, so every result and every block-explorer link names the
transaction that actually went through — and it now pays attention to
what kind of replacement it was. A cancellation, or a replacement
carrying different instructions, that goes through without recovering
anything is reported as exactly that: nothing was recovered. A plain fee
bump is not the same thing — it re-sends the very same instructions at a
higher price, so it is still the recovery, and a result the page can't
read off it is reported as an unknown outcome rather than as a recovery
that never happened. If the transaction was sent but its confirmation could not
be read, the page no longer offers a plain "start over" that would
throw the transaction away: it offers a "check the transaction again"
action instead, because a transaction that quietly went through would
let a second, unintended recovery be signed on a fresh form. Only once
the result can actually be read does the page move on to the matching
result and let a new recovery begin.

A submitted recovery is now remembered by the browser until it is
resolved. Reloading the page, switching accounts, or switching networks
used to wipe the record of a transaction that had already been sent and
put a blank form back in its place — the exact situation that could lead
to recovering the same tokens twice. The record is kept per wallet and
per network, so only the account that submitted it ever sees it, and it
is cleared the moment the result is known.

The "check the transaction again" action also copes with a wallet that
replaced the transaction. Looking for the original transaction can never
succeed in that case, so the page instead asks the network whether a
recovery was processed for the account at all. If one was, it says so
plainly and stops there — without claiming to know which of the two
possible results it had, since it cannot read that. If none was, the page
only says "nothing was recovered" once it can prove it, and never on a
failed reading: the network has to positively answer that it doesn't hold
the transaction, and the approval the user signed has to have expired, at
which point that transaction can never be accepted again. Until both are
true the page keeps the transaction pending and tells the user roughly
how long until it can give a definite answer — a momentary network
problem no longer reads as "it's gone", which would have handed back a
blank form over a recovery still waiting in the queue.

The "an attempt was processed" verdict is now a lasting lock rather than
a notice that vanishes on the next page view. That attempt may have moved
only part of the stuck balance, so the page remembers the verdict for the
same wallet and network and shows it again after a reload, instead of
letting a refresh hand back a fresh form. There is still an honest way
out, but it takes two deliberate steps: first confirm you've checked your
wallet, then confirm again on copy that spells out that the earlier
attempt already used up its approval and that what follows is a new,
separate recovery limited to whatever is still sitting in your vault.

Smart-contract wallets (a Safe and similar) are now told up front that
recovery can't be used from them. Recovery has to be authorised by a
signature from an ordinary wallet address, which those accounts cannot
provide, so the page says so instead of walking the user through the
typed confirmation and a transaction that could only fail.

Finally, the page now separates "this network has no screening service"
from "we couldn't reach it to find out". The first is permanent and is
still stated as such; the second says a check didn't answer, retries by
itself a few times, and offers a manual retry — so a passing network
problem no longer reads as a permanent verdict, or needs a page reload
to clear. That same distinction now holds for the last-moment re-check
the page makes just before asking for a signature: neither answer lets a
signature go ahead, but a check that simply didn't answer is reported as
a retryable problem with the retry route open, rather than as a verdict
that recovery will never work on this network.

An automated end-to-end test drives the real contract on a forked
network: dust is minted straight into a vault, the Help explainer's
link is followed, and the recovery round-trips with the tokens
verified back in the wallet — after which a reload has to show a clean
form, proving a completed recovery leaves nothing behind to come back.
A second test seeds a remembered "an attempt was processed" verdict and
confirms it survives a reload, refuses to offer a plain start-over, and
only releases after both steps of the acknowledgement.
