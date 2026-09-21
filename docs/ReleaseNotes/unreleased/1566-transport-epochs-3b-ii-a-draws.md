### Reward transport epochs — the draws (#1566 PR 3b-ii-A)

The previous transport-epochs release gave every old-wire reward delivery
its own **epoch**: one untyped balance, bound to the days the delivery
named, that nothing could yet spend. This release lets the obligations on
those days spend it.

When a claim, a forfeit or an expiry settles an armed day that an epoch
lists, the day is now paid from that epoch **first** — ahead of the live
delivered ledger and ahead of the recycle bucket — and only the residual
reaches the shared sources. This is the order the design requires: a
claim whose matching transport sits parked must not draw down the funding
every other claim shares. The rule is applied in exactly one place, the
day pricing every one of those settlements already goes through, so the
claim, the forfeit sweep, the expiry sweep and the preview the claimant
sees cannot disagree about what an epoch pays. The preview says what the
claim will do; the executable-now predicate that drives the expiry clock
reads the same figure.

An epoch's balance is untyped, so when it cannot cover both of a day's
legs it is split in two steps. First the day's own shortfalls — each leg's
need net of the source that already covers it (the delivered ledger for
fresh, the bucket for recycled) — because a day cannot settle otherwise.
Then whatever coverage remains goes to whichever leg carries the greater
deficit against the shared sources over the **allocation domain**, fresh
first on ties. The domain is the days one settlement call prices for one
claimant — a single day for a forfeit or expiry sweep — and its needs are
totalled once per call and worked down as days settle; nothing is carried
across calls. Two of the design's own cases are the reason. Five fresh and
five recycled, with five of live fresh, an empty bucket and a five-token
epoch, is fully payable only if live pays the fresh and the epoch pays the
recycled — a blind fresh-first rule would refuse a claim the funding fully
covers. And one claimant over two days, each needing fresh and recycled,
with live covering both days' fresh, the bucket only one day's recycled,
and an epoch worth one day's recycled listing the first day, settles both
days only if the epoch pays that day's recycled: a rule that looked at
the first day alone would spend the epoch on fresh, drain the bucket, and
leave the second day waiting. What crosses a call — a long obligation's
later days, or other claimants' demand on the same shared sources — is
the overlapping-membership matching the contested-allocation machinery is
for, and this release states that rather than pretending to a scan it
cannot afford.

What each ledger sees afterwards follows from the source. The 69M emission
cap and the delivery's commitment retire by the full figure — an
epoch-funded payout is still emission, and the obligation ended. The
delivered ledger and the bucket are charged only for what they actually
paid. The epoch-paid share leaves the custody row where an epoch's value
rests and goes to the claimant directly, or, for a forfeit or an expiry,
recycles in place, because there is no claimant to transfer to. An
epoch-funded forfeit or expiry therefore settles even while the live
backing row is empty, which on a mirror funded only by the older wire is
the ordinary case; a live-funded one is bounded by that backing exactly as
before, and a shortfall of it still defers.

Every draw is recorded on the epoch as a fresh leg and a recycled leg, so
the ledger's conservation identity — what was admitted equals what is
held, plus what was parked, plus what left by classification, plus what
the legs paid — holds after every draw, and a delivery's attested fresh
cap is netted by the fresh leg its epoch has already paid.

A day's epochs are read through a **bounded window**. When more epochs
list a day than one window scans, and the visible coverage cannot cover
the day while a residual would otherwise fall through to the shared
sources, the day is deferred rather than paid short: nothing is drawn and
nothing is staged, so there is nothing to unwind, and the day's cursor is
moved past any epochs already exhausted by other days so the next attempt
sees a fresh window. Anyone may run that cursor maintenance for a day at
any time. The follow-up release adds the staging that lets a day wider
than one window make progress; until then such a day waits, with its
value protected in its epochs. A chain that has never admitted an epoch
pays one storage read per settled day for all of this and makes no call.

What this release deliberately does not decide: an allocation the design
calls **contested** — one where another obligation is known to be
competing for the same epoch — is refused until the contested-allocation
machinery lands, and "known" is read as the design defines it, through a
staging reference, which this release has none of. The close-out of an
epoch (parking its remainder, acknowledging it, the operator dispositions)
stays unavailable to everyone, as the previous release left it, until the
per-day obligation check that gates it lands.
