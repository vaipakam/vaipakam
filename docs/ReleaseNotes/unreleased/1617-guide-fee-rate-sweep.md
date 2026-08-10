### The user guides were still quoting the old fee on lender interest

The fee taken from lender interest was raised from 1% to 2% some time ago. The
overview pages were corrected recently; the two user guides were not, so a
reader who moved from one page to the other met two different numbers for the
same fee — in all ten languages. Seventy sentences across the basic and advanced
guides said 1%.

They no longer hold a number of their own. Each now refers to the same shipped
figure the rest of the documentation refers to, so the next time the fee is
retuned there is one place to change rather than seventy. The published
machine-readable copies of the guides resolve that reference too, so a reader
and a crawler see the same figure.

### And they were missing something more important than the number

A loan's fee is fixed at the moment the loan is created. That is deliberate: a
later change to the protocol's fee is not allowed to alter the economics of a
loan already running. None of the guides said so — they simply named a rate,
which reads as a promise about the reader's own position.

Quoting a live figure made that gap matter more, not less: after the next
retune the guides would have shown the new rate to everyone, including people
whose loans were opened under the old one. Both guides now say, where they first
introduce the fee, that the rate is fixed when the loan is created and a later
change leaves an open loan on the rate it started with.

### The administrator's knob reference

Still prints plain numbers, now 2% and 0.2% — deliberately. That page documents
where each knob *starts* before anyone tunes it, which is a different claim from
what the protocol charges today, and an operator reading it is trying to learn
precisely what a retune would be departing from. A live reference would have
quietly rewritten the documented default every time the figure moved.

### Figures that look identical and were left alone

Four were checked one at a time and are correct, because they belong to other
knobs entirely: the matcher's share of the loan initiation fee, the tolerated
divergence band between price oracles, the late fee charged on the first day
past due, and the pool fee tier the liquidity check deliberately excludes. The
Japanese and Korean guides additionally explain what a basis point is by calling
it one hundredth of 1% — a definition of the unit, not a statement of the fee,
and also untouched.
