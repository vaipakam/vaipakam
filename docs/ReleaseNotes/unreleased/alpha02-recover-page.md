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
of the flow. If the wallet replaces the transaction (a speed-up or a
cancel), the page follows the replacement, so every result and every
block-explorer link names the transaction that actually went through;
and if that replacement performed no recovery, the page says exactly
that — nothing was recovered — rather than leaving the outcome
ambiguous. If the transaction was sent but its confirmation could not
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
possible results it had, since it cannot read that. If none was, and the
transaction is genuinely no longer waiting to be processed, the page says
nothing was recovered and offers a fresh start; anything it cannot read
leaves the transaction pending rather than guessing.

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
to clear.

An automated end-to-end test drives the real contract on a forked
network: dust is minted straight into a vault, the Help explainer's
link is followed, and the recovery round-trips with the tokens
verified back in the wallet.
