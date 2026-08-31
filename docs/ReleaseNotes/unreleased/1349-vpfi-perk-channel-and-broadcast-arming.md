## Thread — VPFI recycling: the perk absorption channel, and a broadcast that could strand a mirror (PR #1349)

The recycling loop's absorption side has been thin: until now only forfeited
interaction rewards, the notification tariff and the Full tariff put value back
into the recycle bucket. This adds the fourth channel the programme has been
carrying as a design since the tokenomics redesign — spend-gated perks.

A user may now buy a consumable perk entitlement by spending VPFI from their own
vault. The spend moves into protocol custody and credits the recycle bucket as
genuine absorption, because it is fresh value from a user that has never been
counted anywhere else. It is a purchase, deliberately: not refundable, earning
nothing, conferring only a convenience — never a change to risk parameters, to
the terms of offers already posted, or to any settlement outcome. That shape is
what keeps a perk a price on a service rather than an instrument.

What deliberately did NOT ship is any individual perk's behaviour. Which perks
exist, what they cost, and whether the listing-visibility boost ships at all are
open product decisions, so the platform sells entitlements and each perk's
effect arrives with its own decision. A perk with no published price is not for
sale, and that is the state every perk is in on a fresh deployment — the channel
is dormant until an operator prices something. Those decisions are therefore
configuration rather than code, and nothing shipped here presumes them. Buying a
timed perk while one is still running extends it instead of replacing it, so
buying early never costs the buyer the remainder; withdrawing a perk from sale
stops further purchases and leaves what people already bought untouched.

Separately, a cross-chain defect that could not be closed operationally. The
reward broadcast that opens a day on a mirror chain is permissionless by design,
so anyone may apply a finalized day. If that happened before the governor was
armed, a later rebroadcast of the same day was treated as a duplicate and
returned early — and because the arming day can only ever be chosen once, that
mirror could no longer be armed through that route at all. The operator runbook
could only avoid it by hoping an unused day still existed when it was needed,
which a third party gets to decide. A duplicate broadcast now installs the
arming day when the chain has none, while still refusing to re-choose one that
is already set, so the hole can be filled but never moved.

Also in this pass: the indexer now tells an out-of-date contract apart from an
unreliable network when it reads the recycling backing figures, because those
two need opposite operator responses and previously produced the same log line.

Refs #1349, #1204, #1944, #1930.
