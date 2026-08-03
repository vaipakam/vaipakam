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
what kind of replacement it was. Only a cancellation — the wallet
deliberately voiding the transaction — is reported as the definite
"nothing was recovered". Every other replacement is reported as an
outcome to be checked rather than as a recovery that never happened: a
plain fee bump re-sends the very same instructions at a higher price, so
it is still the recovery, and a replacement carrying different
instructions could equally be a second recovery for another token. If the
transaction was sent but its confirmation could not
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
typed confirmation and a transaction that could only fail. Everyday
wallets that have opted into the newer smart-account upgrade — the one
that adds features to an ordinary wallet without changing its address —
are explicitly not caught by that block: they still sign with the same
key, so recovery works for them and the page now recognises them as the
ordinary wallets they are instead of turning them away.

The page no longer waits for a transaction hash before it starts
protecting the user. From the moment the declaration is signed and the
send is handed to the wallet, the attempt is treated as possibly on its
way. A wallet that takes the send and never answers used to drop the
user back on an armed confirmation card, inviting a second signature
over a recovery that may already have gone out; now it lands on the
unresolved-submission card in its honest form — "we don't know whether
this was sent", no transaction link to offer, and a pointer to the
wallet's own activity list. Re-checking from there reads the network
directly: if a recovery was processed for the account it becomes the
same lasting lock as any other processed attempt, and if none was and
the signed approval has since expired, it can safely start over.

Two tabs open on the same wallet no longer work against each other. The
page re-reads its record of an outstanding submission immediately before
asking for a signature and refuses to sign while one exists, showing
that submission instead; a tab sitting on the form also picks up a
submission the other tab records, so both show the same state. And when
a submission is resolved and forgotten, only that submission is
forgotten — a newer one recorded in the meantime survives, instead of
being quietly wiped along with it. The same rule now covers updates, not
just forgetting: a wallet that takes a long time to answer can come back
after the other tab has already settled that attempt and started a new
one, and its late answer no longer overwrites the newer record — which
would have left the newer recovery unprotected the moment the older one
finished.

Turning a wallet's transaction prompt down is now treated as what it is.
Declining the transaction itself proves nothing was sent, so the page
returns to the review card with the usual "you rejected it" message and
forgets the attempt, instead of holding the flow on the unresolved-
submission card until the signed approval expires half an hour later.
Failures that only *look* like a refusal — a wallet that goes quiet, a
lost connection — still get the cautious pending treatment, because those
genuinely can hide a transaction already on its way.

The form also refuses the all-zero address. It reads as a valid address
to a simple format check, but it belongs to no one, so declaring it as
the sender you control was never a meaningful statement to sign; both
address fields now say so and stop the flow there.

If the browser refuses to store that record at all — private browsing,
storage switched off, storage full — the page now says so on the card
instead of carrying on as though the record exists. It doesn't block the
recovery; it warns that closing or reloading the tab will lose the
page's ability to pick the attempt back up, and that the right next move
is to check the wallet's activity before trying anything again.

Two smaller corrections. A wallet replacement is no longer reported as
"nothing was recovered" unless the wallet actually cancelled: a
replacement only means the transaction that mined carried different
instructions, and "different instructions" equally describes a second
recovery for another token — so anything short of a cancellation is now
reported as an outcome that couldn't be read. And when a re-check finds
the transaction was rejected but the page no longer holds the details
that were originally reviewed (the usual case after a reload), it now
returns a fresh, usable form carrying the reason instead of an empty
confirmation card.

The last-moment screening check on the connected wallet itself now fails
closed. Recovery's result is decided by that screening service, so a
wallet check the page cannot read is not permission to sign; an
unreadable check now leaves the same retryable blocked state an
unreachable availability check produces, rather than being waved through
as "clean".

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

The page now reserves its place before it asks the wallet for anything.
The record of an outstanding recovery is written the moment the page has
finished its checks and is about to open the signature prompt, not after
the signature comes back. Two tabs on the same wallet could previously
both look, both find nothing, and both go ahead — and because the two
attempts share the same approval counter, whichever finished second
could wipe the record protecting the other one's live transaction. Each
attempt now carries its own identity, so a tab can only ever clear or
update the record it created itself; a second tab that arrives while one
is outstanding is shown that attempt instead of being allowed to sign.
If the signature is declined or never happens, the reservation is
released immediately — nothing was authorised, so nothing needs
protecting — and the same release happens if the connected account or
network changes while the prompt is open, so an abandoned prompt can no
longer leave a wallet locked out of recovery over a transaction that was
never sent.

Results are now read from what the network actually recorded rather than
from what the user submitted. When a wallet replaces a transaction, the
one that mines can carry a different amount or a different declared
sender, and the page used to describe the original submission next to a
link showing something else. The amount, the token and the declared
sender on every result card now come from the event the transaction
emitted, falling back to the submitted details only for what the event
does not carry. If the result names a token the page has no details for
— possible only after a wholesale replacement — it says so plainly and
states the amount in that token's smallest units beside its address,
instead of dressing it up in another token's decimals.

The "confirmed, but we couldn't read what it did" card no longer
contradicts itself. It used to tell the user not to sign again and to
refresh the page, while offering a "start over" button directly beneath
and having already released the record. It now sends the user to the
transaction to see what happened and describes the button honestly: it
starts a completely separate recovery, limited to whatever is still in
the vault. The genuinely locked card — the one for a submission that has
not confirmed — keeps its "don't sign again" wording, because there the
warning is true.

Reading a token's details is now honest about failure. The page treats a
token that simply does not publish its decimal format as usable, taking
amounts in raw units, but it used to reach that conclusion from any
failed read at all — so a momentary network problem could make an
ordinary token look like it had no decimal format, and a user who typed
"1" would have signed for the smallest possible fraction of a token.
Only the token itself declining to answer counts now; a network failure
reports that the token's details couldn't be read and asks the user to
try again, which is the one outcome that cannot mislead them about what
they are signing.

Finally, the "an attempt was processed" verdict is written back only
while the page still holds the same attempt it started with, matching
the care already taken over every other write to that record, so it can
never convert another tab's outstanding recovery into a lock belonging
to an older one.

An automated end-to-end test drives the real contract on a forked
network: dust is minted straight into a vault, the Help explainer's
link is followed, and the recovery round-trips with the tokens
verified back in the wallet — after which a reload has to show a clean
form, proving a completed recovery leaves nothing behind to come back
(which now also proves the reservation taken before the signature is
released again by a successful recovery). A second test seeds a
remembered "an attempt was processed" verdict and confirms it survives a
reload, refuses to offer a plain start-over, and only releases after
both steps of the acknowledgement.
