### Operators can now be told when a chain is sitting on more recycled VPFI than it uses

Each chain accumulates recycled VPFI from fees that land on it, and spends it
funding that chain's own reward claims. A quiet chain can therefore build up a
balance it has no near-term use for, while a busy one runs lean — and until now
nothing surfaced that difference. An operator had to go looking.

There is now a per-chain **surplus flag**. A mirror chain is flagged when the
recycled VPFI available to it exceeds a configured multiple of what it has
actually been budgeting per day, averaged over the trailing thirty days.
Alongside the flag, the same read reports the availability, the trailing
average, the threshold it was compared against, and the configured multiple — so
an operator can see *why* something is or is not flagged rather than only that
it is.

**It covers the mirror chains, and asking it about the canonical chain fails
rather than answering.** That is deliberate on two counts: the figure it would
produce for the canonical chain is a lifetime total rather than what is
currently available, so the flag would stay raised for funds already spent and
nothing could clear it; and the flag exists to surface candidates for moving
surplus *back* to the canonical chain, which the canonical chain can never be.
Its own recycled position is reported by the existing composition and backing
reads. An operator scanning for surplus should scan the mirrors.

**The flag moves nothing.** It is a signal, and only a signal. Deciding what to
do about a flagged surplus — including whether to move any of it — is separate
work, kept deliberate on purpose.

**It is off by default.** The multiple ships unset, and while unset nothing is
ever flagged. That is a deliberate choice rather than an oversight: there is no
threshold that is right for every deployment, and a warning that starts firing
before anyone has decided what it means is a warning people learn to ignore. An
administrator turns it on by choosing a multiple, and can turn it off again by
clearing it.

Two judgements inside the flag are worth stating, because they change which
chains it catches:

- It measures against what a chain **budgeted**, not what it managed to spend
  from its own balance. Those are the same number for a chain with plenty
  available, and they diverge exactly when a chain is running short — where a
  spend-based measure would make the warning *harder* to clear the worse the
  situation got.
- Days on which a chain budgeted nothing count as zero rather than being skipped.
  A single busy day in an otherwise idle month therefore reads as an idle month
  with one busy day, which is what it is — not as a month of steady demand.

A chain holding funds while budgeting nothing at all for the whole window is
flagged. That is the clearest case of the thing the flag exists to find, so it
is reported rather than treated as a figure that cannot be computed.
