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

A second gap is recorded the same way, and it is about trust in the
labels rather than in the numbers. The console reads governance values
by name, but the naming is applied when the page is served rather than
when the values were captured — so a future contract change that
reorders those values without changing how many there are could show a
real figure under the wrong parameter name until the next capture. That
is a change to how the indexer stores its snapshot, tracked separately;
it predates these pages, which only make the surface public.
