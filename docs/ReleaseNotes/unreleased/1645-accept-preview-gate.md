## The app now asks before it makes you sign (#1645)

Before this, the connected app could walk someone into a transaction the
protocol had already decided to refuse. The platform has carried a preview for
some time that answers, without charging anything, whether an offer can be
taken right now and — if not — which reason applies. No screen read that
answer. The one place that called the preview took the fee estimate out of it
and discarded the verdict, so the only way a buyer learned about a blocker was
a rejected transaction they had signed and paid for.

The accept flow now consults that verdict and stops there, before the wallet
prompt rather than after it. The reason it shows is the protocol's own, in
plain words: the offer expired, the listing is out of date and the seller needs
to relist, one of the assets is paused, the vault on one side needs upgrading,
the protocol itself is paused. All twenty reasons the platform can give are
covered, not only the out-of-date-listing one whose arrival made this visible.

Three details are worth stating because they are the difference between a check
that helps and one that misleads:

**It reports the first refusal, not a refusal.** The preview applies its checks
in the same order the transaction does, so whatever it names is what the buyer
would actually have hit first. That ordering is the point of the whole
mechanism, and the app deliberately does not re-rank, filter, or improve on it.

**A reason it does not recognise stops the transaction.** The app can be older
than the platform it is talking to, and this vocabulary grows over time. An
unrecognised answer is a refusal nobody has written words for yet — never an
all-clear — so it blocks with a general message rather than waving the buyer
through into the revert this exists to prevent.

**It does not quote a number it never measured.** One refusal concerns a
position that has fallen below the safety margin its sale required. The obvious
thing to show is the shortfall, and the preview does not carry one — so the
message states the condition without a figure. An earlier round of this work on
the platform side established that showing a health figure for a position that
was never measured is worse than showing none.

Two limits are deliberate and worth knowing. The signed-order fill path is
untouched: a signed order has no offer to preview until it materialises, so
this check cannot apply there and the separate protections that path already
has remain what covers it. And on the current testnet deployment the four
newest reasons will not appear until the preview component is refreshed —
before that refresh, a review can honestly confirm only the older reasons and
the clear path.

Closes #1645.
