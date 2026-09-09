## Thread — the last two unported surfaces, and the cutover that was waiting on them

The connected-app rename left two public-read tools behind on the retired
deployment: the analytics dashboard and the protocol console. That was
the whole reason the legacy host could not be retired — the marketing
site linked to both, and pointing those links at the new app would have
landed visitors on its in-shell not-found page. Both are now built on the
new app, and the marketing site's links follow it.

Neither is a transcription of the retired page. The old analytics screen
read through a stack of hooks that no longer exists; the new one reads
the indexer's public, keyless endpoints — the same ones any third party
can call — because a transparency page whose numbers cannot be
independently reproduced is asking to be trusted rather than checked. It
states the age of the data beside the data, since every figure is only as
current as the last ingest, and it distinguishes a counter the indexer
did not report from a counter that is genuinely zero. On a page whose
purpose is accuracy, an invented zero is worse than an admitted gap.

The protocol console shows the current values of the governance
parameters the public indexer publishes — a subset rather than the whole
catalogue, and the page says so rather than letting a reader assume
otherwise. Those it does show are read by NAME rather than by position in the config bundle — the
release record already carries an incident where hand-typed positional
tuples silently shifted, and a governance parameter displayed against the
wrong label looks authoritative while being wrong. It holds no controls
and never will: governance changes go through the timelock. The prose
reference stays on the marketing site, where it indexes beside the other
public explainers and is already pinned byte-for-byte against its source;
a third copy would only add something new to drift.

With both ported, the marketing links move to the new app and the helper
that pinned them to the old deployment is deleted — it always said it
existed to be removed rather than become a second permanent surface. The
VPFI call-to-action regained the landing position it promises, and that
anchor is present in BOTH the connected and disconnected states: almost
everyone arriving from that link has no wallet yet, so anchoring only the
connected view would have quietly dropped the majority at the top of the
page — the exact regression the switch was built to prevent.

Two things are deliberately unchanged. The recovery links in the user
guide still point at the old host, because that flow keeps safety state
per origin and moving the links early can let someone broadcast a second
recovery against the first; that turns on state, not on a missing page,
and a redirect does not satisfy it. And the notification-link host stays
where it is, being one decision with the frame paths beside it.

Found while verifying live, and worth recording: both new pages first
rendered empty for the visitors they exist for. They asked the wallet
library which chain to use, and with no wallet connected the honest
answer is Ethereum mainnet — a chain this deployment does not index. They
now use the app's own "where reads land when disconnected" resolution.

Review then found three more of the same shape — things that look right
in a live check and are not. Neither page had any styles at all: every
layout class it named was undefined, so both rendered as a plain
vertical stream. A browser makes unstyled text perfectly readable, which
is exactly why a glance at the deployed page did not catch it, and on
these two the cost is more than tidiness — a counter loses its label
when the pairing is only visual, and a value read against the wrong
label is the failure the console exists to prevent.

The analytics page also treated an indexer that had read nothing as an
indexer reporting nothing. A database still filling up answers every
question successfully with zero, so the page showed a full board of
authoritative-looking zeros for a deployment that may have years of
history behind it. "No defaults" from an empty database is the most
reassuring figure on that page and the least earned; it now says the
indexer has not started rather than showing the numbers.

And the "Smart Contracts" link in the marketing footer, which points at
the transparency section, arrived somewhere with no contract on it. It
now leads with the contract's address and a link to open it on a block
explorer, above the indexer's own provenance — the chain is the source,
and the indexer only a second-hand reading of it.

Both pages were also missing from the site's page-title and sitemap
tables, so each announced itself as "Page not found" in the browser tab
and asked search engines not to index it; and from the list of pages the
Terms prompt never withholds, so connecting a wallet could take away a
page anyone could read without one. The parameter reference the console
links to when an operator has hidden the live values turned out to be
hidden by that same setting, so that link is gone rather than promising
something the setting had already taken away.

A later look found the analytics totals could not be checked by the
reader they are for. Both the loan and offer counters totalled every
state the records hold while naming only some of them on the page, so a
position that closed as fully filled, or a loan waiting on a fallback
read, was counted in the total and shown nowhere — the total would
simply exceed the buckets beneath it, with nothing to say where the
difference went. On a page whose entire claim is that its figures can be
checked rather than trusted, a total that does not add up is the one
number that must not appear. The counters now name those states and
carry an explicit "other" for anything added later, and the total is
computed from the buckets themselves, so it adds up by construction
rather than by two separate counts happening to agree.

Worth recording honestly: on the deployment's current data every figure
already reconciled, because none of the unnamed states happens to exist
there right now. The defect was latent rather than visible, and the fix
is what stops it becoming visible the first time an ordinary lifecycle
produces one.

One gap is recorded rather than closed: the console shows every
parameter the indexer publishes, and the operator reference names some
it does not publish yet. Widening that is an indexer change, tracked
separately; the full reference remains public and the values remain
readable directly from the contracts in the meantime.

One bug found late is worth recording because of how it was found. Both
pages tell a reader how old the figures are, and both treated a
timestamp from the FUTURE as the freshest possible reading — showing
"0s ago" for a stamp that cannot be right, while the freshness guard
behind the parameter page actively confirmed it as current and kept its
own out-of-date warning hidden. A source whose clock is wrong, or whose
timestamp is corrupt, was therefore presented as maximally up to date.

The written specification for these pages already said the opposite —
that an unknown age must never be presented as a fresh one. It did not
need changing; the code did. That is the specification doing the job it
is kept for: it describes what the product is meant to do rather than
what the code happens to do, so it can disagree with the code and be
right. Both pages now share one tolerance for ordinary clock
differences and report anything beyond it as unknown.

A second gap is recorded the same way, and it is about trust in the
labels rather than in the numbers. The console reads governance values
by name, but the naming is applied when the page is served rather than
when the values were captured — so a future contract change that
reorders those values without changing how many there are could show a
real figure under the wrong parameter name until the next capture. That
is a change to how the indexer stores its snapshot, tracked separately;
it predates these pages, which only make the surface public.

Sharing that tolerance turned out not to be the whole fix, and the rest
of it is worth recording because the page ended up contradicting itself
in the one way it must not. The console warns when its published values
are more than a day old. It worked that warning out by asking whether
the snapshot was fresh and treating every "no" as age — but a capture
time from the future is also not fresh, for an entirely different
reason. So a producer with a wrong clock, or a corrupted stamp, made the
console announce that its values were more than a day old directly
beside a line reporting their age as unknown. Two confident and
incompatible claims about governance parameters, on the page that exists
to tell a reader how far to trust them.

A capture time in the future is not an age at all; it is a broken
reading, and the only honest thing to say about it is that the age
cannot be determined. That is already exactly what the page says about a
snapshot bearing no capture time, and the advice a reader needs is the
same in both cases — treat the values as unverified rather than as the
protocol's present configuration. So the two now resolve to one message,
and its wording moved from "no timestamp" to "no usable timestamp"
because it now speaks for both. The day-old warning is reserved for a
snapshot that is genuinely that old.

Two more corrections to the analytics page, both about claiming more
certainty than the data supports.

The page shows how many loans are active, and beneath that how many are
ordinary loans and how many are NFT rentals. Those two do not have to
add up to the first, and the page was presenting them as though they
did. When a loan is indexed before the details of what asset it is in
have been read, it is counted in the total and deliberately left out of
both types — the indexer's own note calls undercounting a type an
admitted gap and misfiling it a false statement, which is the right call.
What the page was doing was dropping the admission: a reader could
subtract, find a difference, and have nothing on the page to explain it.
The difference is now shown, whenever there is one, as active loans
whose type has not been read yet.

The freshness line had a subtler version of the same problem. The page
draws its counters from two separate requests and states a single "as
of" figure for all of them, and it was taking whichever of the two
answers happened to arrive with one. If those two reads are at different
points in the indexer's progress, the page was quoting the more advanced
of them over numbers that came from the other. It now quotes the one
that is further behind, which is the only figure true of everything
shown.

That is a floor rather than a guarantee, and the note it is written
against says so. Each request reads its counters and its position marker
separately, so a write landing between them can still return older
counters with a newer marker. Closing that needs the two bound together
inside the indexer, which is a change to a different service and is
tracked on its own.

The public analytics page shows how many loans are active and, beneath
that, how many of them are of each type. Subtracting one from the other
gives the loans whose type has not been read yet, and the page was
quietly treating a negative answer as zero. A negative answer means the
smaller numbers add up to more than the larger one — the counts
contradict each other — and rounding that away left three figures on
screen that do not reconcile, with nothing saying so. Anyone can do the
subtraction themselves.

The page now says it. When the counts disagree it says they disagree,
says the fault is in the counting rather than in anyone's loan, says
plainly that nothing is at risk, and leaves both the total and the
breakdown exactly as reported so the discrepancy can be seen rather than
taken on trust. It also stops short of claiming to know the right split,
because it does not.
