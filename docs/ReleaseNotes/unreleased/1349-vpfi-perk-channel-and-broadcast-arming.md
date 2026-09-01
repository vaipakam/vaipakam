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
exist and what they cost remain open product decisions, so the platform sells
entitlements and each perk's effect arrives with its own decision.

One of those decisions is settled, and in the negative: the listing-visibility
boost does NOT ship. A perk may change what its buyer gets, never what other
participants see — an ordering that can be bought is not a neutral book, and
saying so on the listing would document that rather than undo it. That rules
out visibility-for-sale as a whole class, not merely one proposed perk. A perk with no published price is not for
sale, and that is the state every perk is in on a fresh deployment — the channel
is dormant until an operator prices something. Those decisions are therefore
configuration rather than code, and nothing shipped here presumes them. Buying a
timed perk while one is still running extends it instead of replacing it, so
buying early never costs the buyer the remainder; withdrawing a perk from sale
stops further purchases and leaves what people already bought untouched.

Because the price and the shape of a perk are governance's to change, a purchase
now settles on the terms the buyer stated rather than whatever the chain happens
to hold when the transaction lands. The buyer names the most they are willing to
pay in total and the entitlement they are buying, and a perk that has been
re-priced or re-shaped in the meantime makes their purchase fail instead of
quietly charging more or handing them something else. That binding runs both
ways — a longer entitlement than the one agreed is still a substitution, and
refusing it costs a buyer nothing but a retry.

Once a perk has sold its first unit, its kind is settled: a timed perk stays
timed and a counted one stays counted. Entitlements live as per-holder records
that no setting can revisit, so changing a perk's kind after it has sold would
leave its holders with a basis the perk no longer reads — and changing it back
would revive entitlements that were meant to be gone. Price stays adjustable and
the perk stays withdrawable; only the meaning is frozen, and a new meaning takes
a new perk. Withdrawing a perk from sale also works while the protocol is
paused, which is when an operator is most likely to want it: purchases are
closed by that same pause, so nothing can be BOUGHT while it holds.

That is not the same as saying the lever can only shut a channel — an earlier
draft of this note said so and it is wrong. A price set during a pause is kept,
and the perk is on sale the moment the pause lifts, with no further action
needed. So a price written during containment is a scheduled opening, and worth
re-checking before the pause is lifted.

Separately, a cross-chain defect that could not be closed operationally. The
reward broadcast that opens a day on a mirror chain is permissionless by design,
so anyone may apply a finalized day. If that happened before the governor was
armed, a later rebroadcast of the same day was treated as a duplicate and
returned early — and because the arming day can only ever be chosen once, that
mirror could no longer be armed through that route at all. The operator runbook
could only avoid it by hoping an unused day still existed when it was needed,
which a third party gets to decide. A duplicate broadcast now installs the
arming day when the chain has none, while still refusing to re-choose one that
is already set, so the hole can be filled but never moved. A duplicate arriving
on the retired message format after the reward era has rotated is excluded from
this: replays on that format stay accepted so settled days keep replaying
harmlessly, but installing an arming day is not a harmless replay, and a retired
era must not get to choose one.

The same gap existed on a second route and is closed with it. A day first
opened by the older message format carries no lapse timetable, so its
rebroadcast on the current format is handled as a repair of that missing
timetable — and that repair finished without ever installing the arming day,
leaving the chain waiting on a further broadcast nobody had a reason to send.
Both routes now install it, on the same one-shot terms.

A third change gives one chain the ability to earmark part of its own recycling
budget for the keepers that serve it — but only when the home chain says so.
That instruction has ridden the cross-chain message since the mesh was built and
did nothing: the receiving chain stored it and no code ever read it. It is now
applied, and the amount is set per destination by an administrator on the home
chain only, defaulting to nothing. A receiving chain cannot grant itself a
budget, which is the whole point of the arrangement; and because the figure is
frozen into each day when that day closes, changing it affects later days rather
than rewriting settled ones.

That earmark is counted as its own kind of draw rather than folded in with the
budget a chain has been committed to spend. The two behave differently: a
commitment is something the receiving chain later reports back as settled,
which releases it, whereas an earmark is simply set aside and never reported
that way. Counting them together would have left every earmark looking like a
commitment that could never be settled, quietly and permanently understating
how much that chain had available. It is still subtracted from what the chain
can be asked to fund, so the home chain can never promise the same tokens
twice — that was always the point of counting it, and it is unchanged.

The earmark is also bounded by what is actually left. It is a second call on
one pot rather than a slice taken out of the first, so a chain whose own
demand has already used up everything it holds now earmarks nothing instead
of promising more than it has. An instruction that does not fit is honoured
as far as the pot allows rather than refused outright — refusing would let a
keeper-budget setting fail a whole day's funding, which is a far worse
outcome than a smaller keeper budget.

Upgrades do not land everywhere at once, and that gap is handled explicitly. A
chain still running the previous version records the instruction but cannot act
on it, because the code that acts did not exist yet — and once a day is marked
handled, an ordinary re-delivery would skip straight past the step that was
missed. The home chain would have set the amount aside while the receiving
chain still counted it as spendable. A re-delivery now completes that one
missing step, tracked separately so it can run exactly once no matter how many
times a day is re-sent, on both of the routes a re-delivery can take.

The monitoring that watches this accounting from outside was taught about the
new figure in the same change. It re-derives what each chain should have
available and raises a critical alert when its answer disagrees with the
chain's; without being told about the earmark it would have disagreed by
exactly that amount and reported every healthy chain as broken. It can now
also check the earmark against the room actually left, which nothing else
could see.

Arming it required making room first. The contract that owns the reward day had
32 bytes of deployable space left — less than a single call — so nothing could
be added to it at all. The part that ships a finished day to other chains has
been moved into its own contract, along the boundary the code already described:
that step was documented as deliberately separate so a finalization stays cheap
and a failed delivery to one chain can be retried on its own. Nothing about the
behaviour changes, the same operations are reached the same way, and the move
freed roughly five kilobytes — enough for this work and for the queue of changes
that were previously undeployable.

Also in this pass: the indexer now tells an out-of-date contract apart from an
unreliable network when it reads the recycling backing figures, because those
two need opposite operator responses and previously produced the same log line.

Refs #1349, #1204, #1944, #1930, #1569.
