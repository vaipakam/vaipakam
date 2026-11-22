# Prices (PRC)

A price is what the price guard answers for an asset, in the unit of account.
These statements say what a price is, where it comes from, how its settings and the guard
itself change, what the unit is, when an asset is liquid, and which risk figures follow.
Figures are named by parameter id and are in the parameters table (`parameters.md`).

## Section 1: a price and its three answers

The platform's rules (PLT) apply throughout and are cited by id.
No statement of this section moves a balance. It says what a price is, who may read it, and
what a read can answer. What each step does with an answer is in that step's own statement.

## 1.1 One unit and one guard

### PRC-001 · rule

**Who:** the platform.
**When:** a value is measured, compared or shown.

Every value the platform measures is in one unit of account.
The unit is a measure and nothing else: it is the unit of every price, and of every threshold a
value is compared with.
A threshold and the value compared with it are always in the unit in force at that moment
(PRC-400, PRC-410).

- **Tests owed:** the defaults for a rule.

### PRC-002 · rule

**Who:** the platform, and a vault.
**When:** a step needs the price of an asset.

Every price comes from one price guard: the guard in force for the platform.
The platform keeps no price source of its own. It proposes nothing on the guard and chooses
none of its settings (PRC-201).
The one change it carries out there is the raise of the guard's floor that its own retirement
names (PRC-271).
A vault reads the guard its own code names (VLT-240), which is the guard in force (VLT-228).
The guard in force changes only by one step (PRC-300).

- **Tests owed:** the defaults for a rule, and a build check that no step holds a price
  source of its own.

### PRC-003 · never

**Who:** any step.
**When:** at any time.

No figure of the platform is valued by a price from anywhere but the guard in force.
A guard that is not in force is read only as PRC-022 allows, and that read sets no figure.

- **Against:** PRC-T16.
- **Watch:** every value a record of the platform states can be worked out again from the
  guard in force at that record's moment, at the price version the loan is read at on that
  guard (PRC-253).
- **Tests owed:** the defaults for a never.

## 1.2 The three answers

### PRC-010 · rule

**Who:** the price guard.
**When:** it is asked the price of an asset, at a price version it answers.

The guard gives exactly one of three answers.
**A price:** the guard has a primary source for the asset and vouches for its answer.
**No price:** the guard has no primary source for the asset at that price version.
**A distrusted price:** the guard has a primary source for the asset and does not vouch for
its answer at that moment.
When the guard vouches is stated source by source
(PRC-110, PRC-121, PRC-135).

- **Tests owed:** the defaults for a rule, with each of the three answers made on one asset.

### PRC-011 · rule

**Who:** any step that needs a price.
**When:** it has the guard's answers.

An answer is given for one asset, and a step acts on each answer as PLT-080 states.
A step reads only the prices it will use.
A distrusted price refuses exactly the steps that would have acted on it.
A step that only reports or records a figure built on a price goes ahead, and states the
figure as unknown. A top-up of collateral is such a step (PLT-041).
A step whose route is decided by an asset having no price does not read another asset's price
for that route.

- **Tests owed:** the defaults for a rule, with the nine pairs of answers for a loan's two
  assets on each close-out, a step that uses the value of the priced asset, and each step
  that only reports a figure.

### PRC-012 · never

**Who:** the price guard.
**When:** it has a primary source for an asset at the price version read.

The answer is never "no price" while the guard has a primary source for the asset at that
version.
Each of these gives a distrusted price: a read of that source that fails, an answer of nil
or less, and an answer that is too old.
So does an outage of the sequencer and its recovery window, on a network that reports its
sequencer's state (PLT-090, PLT-091).
The one exception is a source that has ended, by its own statement
(FCL owed: an asset whose primary source has ended).

- **Against:** PRC-T01, PRC-T02, PRC-T04.
- **Watch:** not watchable from chain data alone. A refused step leaves no record.
- **Tests owed:** the defaults for a never, with each way a primary source's read can fail.

### PRC-014 · rule

**Who:** anyone.
**When:** at any time.

Anyone can read which of the three answers the guard gives for an asset, and the price where
there is one.
That read changes nothing, and fails for none of the three answers: it reports a distrusted
price as that. It is refused only as PRC-021 states.
A preview of a step shows the answer the step itself would act on, read by the same rule.

- **Tests owed:** the defaults for a rule, and a preview compared with its step on each answer.

### PRC-015 · rule

**Who:** the price guard.
**When:** it decides whether it has a primary source for an asset, at a price version.

That is read from the guard's own settings at that version, and from nothing any source
replies.
A lookup that fails is never "no source".
A route with one part bound and another missing is never "no source": both give a distrusted
price.
"No price" is a fact about one price version. A loan read at an older version keeps its source
when a newer version has none.

- **Tests owed:** the defaults for a rule, with a failed lookup, a route with a part missing,
  and an asset that has a source at one version and none at the next.

### PRC-016 · never

**Who:** any open loan.
**When:** at any time.

An open loan takes the route for an asset with no price in two cases only.
The first: the loan was recorded as unpriced when it opened, since one of its assets was not
liquid then (PRC-533), and both parties had named that asset (PLT-123).
The second: the guarded last resort for a source that has ended
(FCL owed: an asset whose primary source has ended).
No other step puts an open loan on that route. A retirement of a price version that exempts
an asset never does (PRC-270).

- **Against:** PRC-T02.
- **Watch:** every close-out that took the route for an asset with no price was of a loan
  recorded as unpriced at its opening, or carries the record of the last resort.
- **Tests owed:** the defaults for a never, with a retirement that exempts an asset of an
  open loan, and a move to the current settings that would drop a source.

### PRC-018 · rule

**Who:** a loan, and a record agreed ahead of one.
**When:** a loan opens, and at every step of its life.

A loan has one standing, priced or unpriced, fixed when it opens. It is priced only where both of
its assets were recorded liquid then, and its lien holds the collateral as priced only then
(PRC-533). No price version, retirement, replacement of the guard, move by consent or extension
changes it, in either direction.
The one exception is the last resort for a source that has ended
(FCL owed: an asset whose primary source has ended).
An offer, a signed offer, a refinance request and an Auto-lend slot carry each asset's standing as
it was when made. A fill is refused where it then differs, and the maker posts again.

- **Tests owed:** the defaults for a rule, with a source added and a source dropped after a
  loan opens, across each step named, and between the posting and the fill of each record.

## 1.3 Who reads, and which guard

### PRC-020 · rule

**Who:** any step that needs a price.
**When:** it reads the guard in force.

A read made for a loan reads the guard at the price version the loan is read at on that guard
(PRC-253).
A read made for no loan reads the guard at its newest price version. That is the read of a new
offer, of a new loan before it has a record, and of a preview of an asset.

- **Tests owed:** the defaults for a rule, with a loan on an older live version and a read
  with no loan made in one transaction.

### PRC-021 · refusal

**Who:** any step that needs a price, and anyone's read.
**When:** no price guard is in force, the guard in force answers in another unit than the
platform's, or the price version asked for is below the guard's floor or unknown to it.

The read is refused, and a step that needs the price with it.
The refusal is none of the three answers. It is never taken as "no price", and never as a
distrusted price that a later rule may wait out.
A step that needs no price is untouched (PLT-041).

- **Refused as:** the price guard is missing, its unit is not the platform's, or the price
  version is not one it answers.
- **Tests owed:** the defaults for a refusal, on a close-out that would otherwise take the
  route for an asset with no price, and on a read at a version below the floor.

### PRC-022 · rule

**Who:** the platform.
**When:** it reads a guard that is not the guard in force.

Two kinds of guard are read on purpose although they are not in force: a proposed guard before
it is applied, and a replaced guard after it. There may be several replaced guards.
Each is read by one separate way that nothing else can reach.
That read answers only whether the guard vouches for an asset, and at what price.
It can only refuse or delay a step. It never sets an amount, a threshold or a record.
What a step does when such a read cannot vouch is stated with each rule that uses it
(PRC-316, PRC-340, PRC-351).

- **Tests owed:** the defaults for a rule, and a build check that no other step reaches a
  guard that is not in force.

## 1.4 One price in one transaction

### PRC-030 · rule

**Who:** any step that changes state.
**When:** it uses the answer for an asset more than once in one transaction.

Every use of an asset's answer at one guard and one price version, inside one transaction, is
the first answer read there.
An answer is kept for one guard, one price version and one asset, and for the transaction it
was read in.
A read that changes nothing (PRC-014) keeps no answer.

- **Tests owed:** the defaults for a rule, with a step of several fills that reads each
  asset once, and a source that changes its reading between two uses.

### PRC-031 · never

**Who:** any step that needs a price.
**When:** it uses an answer kept inside a transaction.

No step acts in one transaction on two different answers for one guard, price version and
asset.
An answer kept inside a transaction is never used for another guard, another price version or
another asset, and it never outlives its transaction.

- **Against:** PRC-T15.
- **Watch:** not watchable from chain data alone. The tests owed carry it.
- **Tests owed:** the defaults for a never, with two guards, two versions and two assets read
  in one transaction, and a second transaction in the same block.

## 1.5 The read budget

### PRC-040 · rule

**Who:** the platform, and the price guard.
**When:** a guard is read, and when the guard reads a source.

Every read of a guard is handed a fixed budget, and each source's read inside it is handed its
own by the one safe read.
Each read of a guard that is not in force is handed the fixed read budget [PRM-020], one for
each guard read.
The most guards one step may read is stated (PRC-355).
The least a caller must supply for a step is stated with every budget in it.

- **Tests owed:** the defaults for a rule, and each step that reads more than one guard run on
  exactly its stated least.

### PRC-041 · never

**Who:** any caller.
**When:** a read could not be handed its budget, or ran out of what the caller supplied.

Such a read is no answer.
It is never one of the three answers, never "no information" from a source, and never a guard
that cannot vouch.
It is never a reason a step skips. It fails the whole step, by name.

- **Against:** PRC-T14.
- **Watch:** not watchable from chain data alone. A failed step leaves no record.
- **Tests owed:** the defaults for a never, with a read starved at each guard and at each
  source, on every rule that turns "cannot vouch" or "no information" into a decision, and on
  a step that reports a skip.

## Outcome under each condition of the platform (section 1)

A cell names the statement that decides it. "Open" means the condition does not refuse the read.

| Read | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| Anyone's read of an answer, and a preview (PRC-014) | Open | Open | Open | Open | Open |
| A step's read of the guard in force (PRC-020) | As the step itself (PLT-040) | As the step itself (PLT-050) | As the step itself (PLT-060) | As the step itself (PLT-065) | As the step itself (PLT-070) |
| The platform's read of a guard not in force (PRC-022) | Open: the step that replaces the guard and a retirement's execute stay open in a pause (PRC-274, PRC-329) | Open | Not a party's step | Not a party's step | Not a party's step |

In an outage of a network's sequencer and its recovery window (PLT-090) the answer for every
asset the guard has a primary source for is a distrusted price (PRC-012).
A close-out in kind of an asset with no price reads no price and sells nothing, so it still
runs then (PRC-011). Its reach is small: by PLT-090 no loan becomes defaultable inside an
outage or its recovery window, so only a loan already past its grace before the outage can be
closed out in one.

## Section 2: sources and how they agree

The platform's rules (PLT) and section 1 apply throughout and are cited by id.
No source is named: the statements say "the primary source", "the cross-check" and "a secondary
source". Who sets each setting, and after what wait, is in section 3.

## 2.1 The primary source

### PRC-100 · rule

**Who:** the price guard.
**When:** it is asked the price of an asset, at a price version.

An asset has a primary source where the guard's register of feeds binds a route for it at that
version. The first route is a feed of the asset quoted in the unit of the guard's feeds.
The second is a feed of the asset quoted in the network's coin, with the coin's own feed.
On it each of the two feeds is held to the freshness rule and to PRC-103.
The third is an exchange rate on an underlying asset (PRC-150).
Of the first two, the first is used where it is bound. A route that does not vouch never falls
through to another. An asset with no route bound has no price (PRC-010).
A route bound in part, and a register that cannot answer, give a distrusted price (PRC-015).

- **Tests owed:** the defaults for a rule, with an asset on each route, on the first two
  together, on none, on the second with no coin feed, and a first route that does not vouch.

### PRC-101 · rule

**Who:** the price guard.
**When:** it is asked the price of the network's wrapped coin.

The wrapped coin is priced from the coin's own feed, and from no feed of its own.

- **Tests owed:** the defaults for a rule.

### PRC-103 · rule

**Who:** the price guard.
**When:** it reads a primary answer.

An answer of nil or less is never used.
Where a feed has a least answer set [PRM-023], an answer below it is not used either.
Either gives a distrusted price (PRC-012).

- **Tests owed:** the defaults for a rule, with an answer of nil, a negative answer and an
  answer one step below the least.

## 2.2 A stable asset

### PRC-104 · rule

**Who:** the price guard.
**When:** it reads the answer of a stable feed.

A stable feed is one the register marks as such: the feed of an asset that tracks a currency
or a commodity, or the reference feed of that currency or commodity.
Its update window is recorded in its entry, as every feed's is [PRM-024].
The peg of a stable asset is one unit of what it tracks, stated in the unit the guard's feeds
are quoted in: one where it tracks that unit, and its reference feed's answer otherwise.
Where the reference feed's answer cannot be used, the asset is read as off its peg, never as
an asset with no price.

- **Tests owed:** the defaults for a rule, with an asset that tracks the feeds' unit, one
  that tracks a currency with a reference feed, and a reference feed that is too old.

## 2.3 The cross-check of the network coin's price

### PRC-110 · rule

**Who:** the price guard.
**When:** a cross-check source is set for the network coin's price.

The coin's price is compared with the cross-check's reading on every read that rests on it.
The reading counts only while it is fresh [PRM-028], positive, and sure of itself within
[PRM-030].
If it counts and differs from the coin's price by more than the cross-check tolerance
[PRM-029], every price that rests on the coin's price is a distrusted price.
A reading that does not count is no information, and the read goes on without it.
The reading is new only when somebody sends an update, so a keeper pass keeps it fresh
(KOP owed: the keeper pass that keeps the cross-check's reading fresh).

- **Tests owed:** the defaults for a rule, with a reading that agrees, one that differs, and
  one that fails each of the three conditions.

### PRC-111 · rule

**Who:** the price guard, and anyone.
**When:** the cross-check source is set for an asset.

The cross-check source may be set for any asset it covers, and not only the network's coin.
Anyone can bring its newest signed reading for an asset, in the transaction of the step that
needs it. The reading counts only while it is fresh [PRM-038], positive and sure of itself
within [PRM-030]. A reading older than the newest one the guard has seen is refused.
One that counts and differs from the primary answer by more than the secondary tolerance
[PRM-031] refuses the answer at any age. It supplies no price (PRC-124).
The daily launch check reports each asset it is set for whose source published nothing in the
last day (DPL owed: the daily launch check and what it reports).

- **Tests owed:** the defaults for a rule, with a reading that agrees, one that refuses, one
  too old, one too unsure, and an older signed reading brought after a newer one.

### PRC-112 · refusal

**Who:** any step that needs a price.
**When:** the cross-check is set for the asset, the primary answer is older than the general
limit, and no reading that counts confirms it.

The answer is a distrusted price, of the unconfirmed kind, and the step is refused.
It can be tried again with a reading. A preview says so before a party signs (PRC-014).
A mute of the cross-check does not lift it. A muted cross-check's reading still confirms here:
it shows the answer is not stale, and casts no vote.
Only a removal under its announced wait lifts it (PRC-213).

- **Refused as:** a fresh reading from the cross-check is needed for this asset.
- **Tests owed:** the defaults for a refusal, with no reading, a reading that confirms, a
  muted cross-check whose reading confirms, and a removed one.

## 2.4 Secondary sources

### PRC-120 · rule

**Who:** the price guard.
**When:** an asset has a primary answer that is fresh and above its least.

Each secondary source that is set is asked about the asset (PRC-140).
Each gives one of three results.
**It agrees:** its reading is fresh [PRM-032] and within the secondary tolerance [PRM-031] of
the primary answer.
**It disagrees:** its reading is fresh and outside that tolerance.
**No information:** it has no reading for the asset, its reading is too old or not positive,
or its read failed.

- **Tests owed:** the defaults for a rule, with each result from each source.

### PRC-121 · rule

**Who:** the price guard.
**When:** it has the result of every secondary source.

A muted source's agreement is read as no information.
If every source gives no information, the primary answer stands.
If at least one counted source agrees, the primary answer stands, whatever the others say.
If one or more sources disagree and no counted source agrees, the answer is a distrusted price.

- **Tests owed:** the defaults for a rule, with every combination of three sources' results,
  each source counted and muted.

### PRC-122 · rule

**Who:** the price guard.
**When:** a secondary source is muted or removed.

A source is counted, muted or removed, and that standing applies to every price version at once.
A muted source is still read: its agreement stops counting, and its disagreement still refuses.
It still counts as a source that has a reading, so an answer that needed a confirmation still
needs one.
A removed source is not asked, so its refusals and its confirmations go with it.
So a mute only refuses more. A removal loosens the rule.

- **Tests owed:** the defaults for a rule, with a muted source that agrees, a muted source
  that disagrees, and a removed source that would have disagreed.

### PRC-123 · rule

**Who:** the price guard.
**When:** it reads a secondary source that anyone may report to, and whose reports can be
disputed and removed afterwards.

Only a report made at least the dispute buffer [PRM-033] before the read is used.
Its age is still measured from the moment of the read.
So a report that nobody has had time to dispute is never the one that agrees.
On a network younger than the buffer the source gives no information.

- **Tests owed:** the defaults for a rule, with a report one second younger and one second
  older than the buffer.

### PRC-124 · never

**Who:** any secondary source, and the cross-check.
**When:** at any time.

No source outside an asset's own route (PRC-100) supplies its price.
A secondary source and the cross-check can only agree with a primary answer, disagree with it,
or say nothing.
A reference feed supplies a peg and never a price.
A muted source's agreement never counts, and a removed source is never asked.

- **Against:** PRC-T06.
- **Watch:** not watchable from chain data alone. The tests owed carry it.
- **Tests owed:** the defaults for a never, with each secondary source made to give any
  reading while the primary gives none.

## 2.5 One safe read

### PRC-132 · never

**Who:** any source set on the guard.
**When:** at any time.

No source that is set stays uncounted unseen.
Anyone can read, source by source, whether each source set for an asset answered and was
counted at that moment, and whether the sequencer's state could be read.
The daily launch check reports every set source that has not counted, and every asset in use
whose name could not be read (PRC-140).
On a network meant to report its sequencer's state, it reports a state that cannot be read
as a failure (DPL owed: the daily launch check and what it reports).

- **Against:** PRC-T05.
- **Watch:** each set source's standing is readable, and none stays uncounted unseen.
- **Tests owed:** the defaults for a never, with a set source that never answers and a
  sequencer's state that cannot be read.

## 2.6 An outage of the sequencer

### PRC-135 · rule

**Who:** the price guard.
**When:** the network reports its sequencer's state.

While the sequencer is down, and for the recovery window [PRM-034] after it is back (PLT-090),
the guard vouches for no price.
Every asset with a primary source then reads as a distrusted price (PRC-012).
A network that reports no such state is unaffected (PLT-091).
A failed read of the sequencer's state is no information, and the read goes on without it.
No outage is then known to a loan's deadlines either, so no end of grace moves (PLT-090).

- **Tests owed:** the defaults for a rule, with a read one second inside and one second after
  the recovery window, and a failed read of the state.

## 2.7 How an asset is named to a source

### PRC-140 · rule

**Who:** the price guard.
**When:** it asks a secondary source about an asset.

The asset is asked about under the name of the pair its primary feed is registered under.
A token's own name or symbol is never read for it.
The network's wrapped coin is asked about as the coin.
An asset with no registered pair gets no secondary check, and its price rests on the primary
alone.
For this name a register that cannot answer is read as no name, never as a failed price read.
For the lookup of the asset's own route it gives a distrusted price (PRC-015).

- **Tests owed:** the defaults for a rule, with a token that changes its own symbol to another
  asset's.

## 2.8 Collateral priced by an exchange rate

### PRC-150 · rule

**Who:** the price guard.
**When:** it is asked the price of a token that has a rate binding at that price version.

A token that is a claim on another token may be bound to an exchange rate.
Its price is the price of its underlying asset times its accepted rate (PRC-151).
The underlying is priced by a feed of its own, never by another rate, and keeps every check.
The rate is read from a rate feed in the register, or from the token's own conversion through
a small fixed reader.
Where the token also has a market feed bound, its price is the lower of the rate price and the
market price.
A change of a binding makes a new price version, so an open loan keeps the binding it has.

- **Tests owed:** the defaults for a rule, with each kind of rate source, a market feed above
  and below the rate price, and an underlying that is itself distrusted.

### PRC-151 · rule

**Who:** the price guard, and anyone.
**When:** a rate is read or recorded.

The guard keeps the last accepted rate of a binding and its time.
A read uses the lower of two rates: the rate reported, and the accepted rate grown at the
binding's largest daily rise [PRM-035] over the time since it was recorded, counted as at most
one day.
Anyone may record the accepted rate, under the same rule
(KOP owed: the keeper pass that records the accepted rates).
A lower reported rate is taken at once.
The accepted rate is measured and never set. It is shared by every version with the binding.

- **Tests owed:** the defaults for a rule, with a rate raised in one transaction, a stored
  point several days old, and a small fall.

### PRC-152 · rule

**Who:** the guard's owner, and its guardian.
**When:** a rate falls in one step by more than the binding's largest fall [PRM-036].

The token's price is a distrusted price at every price version until the fall is confirmed.
Meanwhile the guard keeps the lowest rate reported since the fall.
The owner or the guardian may confirm only after the observation time [PRM-037] has passed
with the source at or below the rate before the fall, and no further fall past the bound.
The confirmed rate is the lower of that lowest rate and the rate reported at that moment.
Whoever confirms chooses no number, and the confirmed rate is never above the rate before
the fall. From there the rate rises only as PRC-151 allows.

- **Tests owed:** the defaults for a rule, with a confirmation before the observation time, a
  second fall inside it, and a rate pushed up just before the confirmation.

### PRC-153 · rule

**Who:** the price guard.
**When:** it reads a rate source.

A rate feed's answer older than the feed's own update window gives a distrusted price.
So does a read of the token's own conversion that fails.
Both are of the silent kind.
Neither is ever "no price": the token has a route (PRC-012).

- **Tests owed:** the defaults for a rule, with a rate feed one second inside and one second
  outside its window, and a reader that fails.

### PRC-154 · rule

**Who:** the guard's guardian.
**When:** at any time.

The guardian may mute a token's rate source at once.
A muted source leaves the token's price a distrusted price at every price version.
It is never "no price": a stop never moves a loan onto another route.
Unmuting waits the guard's delay (PRC-210).

- **Tests owed:** the defaults for a rule, with a mute on a token of an open loan at an older
  price version.

### PRC-155 · rule

**Who:** the guard's owner.
**When:** a rate binding is proposed and carried out.

A binding is proposed only by its own step, which measures the rate the source reports then
as the binding's first accepted rate.
While the binding waits, nothing is priced from it, and its rate is recorded under PRC-151.
In that time a correction larger than the fall bound is taken as the new accepted rate, and
marks no price distrusted.
Carrying it out records the rate once more, under PRC-151.
The underlying must have a feed of its own at that moment.

- **Tests owed:** the defaults for a rule, with a rate pushed up at the proposal and at the
  carrying out, and a wait with no recording in it.

### PRC-156 · refusal

**Who:** a lender, and a borrower.
**When:** an offer, a loan or a standing instruction to lend would lend a token priced by an
exchange rate.

The step is refused. A token priced by an exchange rate may be collateral and never the asset
lent.
Every safeguard of the rate leans toward a lower value. That protects a lender where the token
is collateral, and would do the opposite where it is the debt.

- **Refused as:** a token priced by an exchange rate cannot be lent.
- **Tests owed:** the defaults for a refusal, on an offer, on a loan and on a standing
  instruction to lend.

### PRC-157 · never

**Who:** a rate source, and whoever controls it.
**When:** at any time.

A rate never raises a token's price by more than its daily bound in a day, however old the
stored rate is and whoever reports or records it.
Nobody sets an accepted rate. It is only measured, and a confirmation chooses no number.
A rate source that falls past its bound, fails, goes silent or is muted never gives "no
price". It gives a distrusted price.
A token priced by an exchange rate is never the asset lent.

- **Against:** PRC-T18, PRC-T19.
- **Watch:** each accepted rate recorded is no higher than the one before it grown at the
  daily bound for at most one day, and no loan lends a token priced by an exchange rate.
- **Tests owed:** the defaults for a never, with a rate raised in one transaction, a rate
  source changed by its controller, and a rate source made to fail on an open loan.

## Outcome under each condition of the platform (section 2)

No statement of this section is a step of a party. Each says what a read answers, and a read
is open or refused as the step that makes it (section 1, the same table).

## Section 3: settings, versions and a loan's own settings

The platform's rules (PLT) and sections 1 and 2 apply throughout and are cited by id.
Statements PRC-250 to PRC-282 are the one mechanism by which a loan's settings move, for
every part. The close-out and exit rules state what their own part is and cite it.

## 3.1 The guard and its settings

### PRC-200 · rule

**Who:** nobody.
**When:** at any time.

The price guard's code never changes.
A new guard is a new contract. It becomes the platform's only by the step that replaces the
guard (PRC-300).
A guard's first settings are given when it is made. They are checked once, before the guard
is applied.

- **Tests owed:** the defaults for a rule, and a build check that the guard has no way to
  change its own code.

### PRC-201 · rule

**Who:** the guard's owner, and anyone.
**When:** a setting of the guard is changed.

Every setting of the guard that affects a price is changed by one route.
The owner proposes it, it waits the guard's delay [PRM-039], and anyone carries it out once
it is due. A keeper pass does
(KOP owed: the keeper pass that carries out due changes of the guard and its register).
The owner or the guardian may cancel a change until it is carried out.
One change may wait for each setting, and each waits the delay in force when it was proposed.
Each proposal, cancel and change is published.
The platform has no way to propose or change a setting (PRC-002).

- **Tests owed:** the defaults for a rule, with a change carried out one second before and one
  second after it is due, a cancel by each of the two, and a delay changed while a change waits.

### PRC-202 · never

**Who:** the guard's owner, and its guardian.
**When:** at any time.

No change that names a new source, loosens a limit or accepts a price takes effect sooner than
the guard's delay.
The steps that act at once can only refuse more (PRC-210, PRC-214).
Two waits are shorter, and both are stated. The removal of a source is announced (PRC-213).
The confirmation of a rate's fall waits its observation time, accepts only a lower rate that
the source reported, and chooses no number (PRC-152).

- **Against:** PRC-T17.
- **Watch:** every change of a setting carried out lies at least the delay after its proposal,
  every removal of a source at least its own wait after its proposal, and every confirmed rate
  is at or below the rate before its fall.
- **Tests owed:** the defaults for a never.

## 3.2 The steps that act at once

### PRC-210 · rule

**Who:** the guard's guardian.
**When:** at any time.

The guardian may mute a secondary source, the cross-check, or a token's rate source (PRC-154),
at once.
A mute applies to every price version at once, and only refuses more (PRC-122).
Restoring a muted source waits the guard's delay [PRM-039], and restores only a source the
price version already named.
A mute cancels a restoring of that source that is waiting or due, so an approval given before
the mute cannot undo it.

- **Tests owed:** the defaults for a rule, with a mute while a restoring is due, and a loan at
  an older price version read after a mute.

### PRC-211 · never

**Who:** the guard's guardian.
**When:** it uses a step that acts at once.

A step that acts at once never names a new source, never loosens a limit, and never accepts a
price that was refused.
A mute never makes an answer that lacked a confirmation rest on its feed alone: a muted source
still counts as a source that has a reading (PRC-122).
It never moves a loan onto the route for an asset with no price: a muted source leaves a
distrusted price (PRC-012).
The confirmation of a rate's fall is not a step that acts at once (PRC-202).

- **Against:** PRC-T02, PRC-T17, PRC-T19.
- **Watch:** not watchable from chain data alone. The tests owed carry it.
- **Tests owed:** the defaults for a never, with each step that acts at once made on an asset
  of an open loan, the answer read before and after, and a mute of the only confirming source
  of an answer older than the general limit.

### PRC-213 · rule

**Who:** the guard's owner.
**When:** a secondary source or the cross-check is removed.

A removal is not a stop. It drops the source's refusals and its confirmations (PRC-122), and
lifts the need for a reading (PRC-112).
It waits its own time [PRM-040], and the owner or the guardian may cancel it until it is
carried out.
It reaches every price version and every open loan on the network at once.
Its proposal is told to both parties of every open loan, with what the loan's price rests on
after it, as a retirement is (PRC-262).
A removed source is restored only under the guard's delay [PRM-039].

- **Tests owed:** the defaults for a rule, with a removal carried out one second before its
  wait ends, a cancel, and the notice to the parties of an open loan.

### PRC-214 · rule

**Who:** the guard's guardian.
**When:** the price of one asset has gone wrong.

The guardian may stop one asset's price at once. While the stop holds, the guard gives a
distrusted price for that asset, of the kind "refused", at every price version.
The stop names no figure and changes no setting. It is published with its reason.
It lapses by itself after the stop time [PRM-067]. The guardian or governance can lift it
sooner, and only governance can make it hold longer (PRC-216).
No more than the most [PRM-068] assets are stopped at one time.
A step that needs the price is refused as for any distrusted price. What waits and what stays
open is stated in PRC-217.

- **Tests owed:** the defaults for a rule, with a stop one second before and after its time, a
  stop tried past the most, an extension by the guardian, and a repayment and a top-up while it
  holds.

### PRC-215 · never

**Who:** the guard's guardian.
**When:** it stops an asset's price.

A stop never gives a price, and never accepts one that was refused.
It never counts as silence: it ends no second key, and counts toward no last resort (PRC-354).
It never moves a loan onto the route for an asset with no price (PRC-012).
It never outlasts its time without a step of governance, and never holds more assets than the
most.
The guardian alone never holds one asset stopped for longer than one stop time in a row
(PRC-216).

- **Against:** PRC-T17, PRC-T19, PRC-T31.
- **Watch:** every stop ended at or before its time, or carries governance's extension; no
  asset was stopped by the guardian alone for longer than one stop time in a row; and no record
  of silence was confirmed for an asset while its price was stopped.
- **Tests owed:** the defaults for a never, with a record of silence tried during a stop, a
  liquidation and a default tried on a stopped asset, and a second stop by the guardian straight
  after a lapse.

### PRC-216 · rule

**Who:** governance, and the guard's guardian.
**When:** a stop is to hold longer, or to be made again.

Only governance extends a stop. Its extension acts at once, since it only refuses more
(PRC-210).
An extension lasts at most one stop time [PRM-067]. It may be renewed, each time by a step of
governance that is published with its reason.
The guardian alone does not stop the same asset again until one stop time has passed since its
stop lapsed.

- **Tests owed:** the defaults for a rule, with an extension one second inside and outside one
  stop time, a renewal, and a stop by the guardian one second before and after the time since
  the lapse.

### PRC-217 · never

**Who:** any step on a loan with an asset whose price is stopped.
**When:** a stop holds.

A step that needs the stopped price waits. It never falls to the route for an asset with no price:
a default never hands the collateral over whole for that reason, and no claim reads a stop as a
missing price (PRC-012, PRC-255).
Those that wait include a liquidation on every route, a default by time, a sale of collateral to
repay, a refinance, a cure that needs a health reading, and every claim or sharing of collateral
that prices the asset.
A repayment and a top-up of collateral stay open (PLT-041, PRC-011), with every close-out that
needs no price: a repayment in full, which cures, and an early close the borrower pays.

- **Against:** PRC-T31, PRC-T20, PRC-T02.
- **Watch:** no close-out took the route for an asset with no price while an asset of its loan was
  stopped, unless the loan was recorded as unpriced when it opened.
- **Tests owed:** the defaults for a never, with each step named here tried on a stopped asset, a
  default by time whose grace ends during a stop, a claim on collateral held after a failed sale,
  and a repayment in full, a top-up and an early close during it.

### Model: the standing of a secondary source

**States:**

- Counted (start): the source is asked. Its agreement and its disagreement both count.
- Counted, removal waiting: a removal waits its own time. The source still counts.
- Muted: the source is still read. Its agreement casts no vote, and its disagreement refuses.
- Muted, restoring: a restoring waits the guard's delay. The source is still muted.
- Muted, removal waiting: a removal waits its own time. The source is still muted.
- Removed, restoring: a restoring waits the guard's delay. The source is not asked.
- Removed (end): the source is not asked. It returns only by a restoring under the delay.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Counted | Mute | The guardian | PRC-210, PRC-211 | Muted |
| Counted, removal waiting | Mute | The guardian | PRC-210, PRC-213 | Muted, removal waiting |
| Muted | Propose a restoring | The guard's owner | PRC-210 | Muted, restoring |
| Removed | Propose a restoring | The guard's owner | PRC-213 | Removed, restoring |
| Muted, restoring | Carry out the restoring, after the guard's delay | Anyone | PRC-201, PRC-210 | Counted |
| Removed, restoring | Carry out the restoring, after the guard's delay | Anyone | PRC-201, PRC-213 | Counted |
| Muted, restoring | Mute again | The guardian | PRC-210 | Muted |
| Muted, restoring | Cancel the restoring | The guard's owner or the guardian | PRC-201, PRC-210 | Muted |
| Removed, restoring | Cancel the restoring | The guard's owner or the guardian | PRC-201, PRC-213 | Removed |
| Counted | Propose a removal | The guard's owner | PRC-213 | Counted, removal waiting |
| Muted | Propose a removal | The guard's owner | PRC-210, PRC-213 | Muted, removal waiting |
| Counted, removal waiting | Carry out the removal, after its wait | Anyone | PRC-213 | Removed |
| Muted, removal waiting | Carry out the removal, after its wait | Anyone | PRC-210, PRC-213 | Removed |
| Counted, removal waiting | Cancel the removal | The guard's owner or the guardian | PRC-213 | Counted |
| Muted, removal waiting | Cancel the removal | The guard's owner or the guardian | PRC-210, PRC-213 | Muted |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Mute | A source that is already muted or removed changes nothing, PRC-210 |
| Propose a restoring | A source the price version did not name is never restored for it, PRC-210, PRC-231 |
| Carry out the restoring, after the guard's delay | Before the delay has passed, PRC-201, PRC-202 |
| Mute again | With no restoring waiting it changes nothing, PRC-210 |
| Cancel the restoring | With nothing waiting, or by anyone but the owner or the guardian, PRC-201 |
| Propose a removal | A source that is removed, or has a removal waiting, PRC-213 |
| Carry out the removal, after its wait | Before its wait has passed, PRC-202, PRC-213 |
| Cancel the removal | With nothing waiting, or by anyone but the owner or the guardian, PRC-213 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The source | A secondary source; the cross-check | PRC-210, PRC-213 |
| The price version read | One that named the source; one that did not | PRC-231, PRC-232 |

## 3.3 The register of feeds

### PRC-220 · rule

**Who:** the register's owner, and its proposer.
**When:** an entry is added, replaced or removed.

The guard's register of feeds binds an asset to its feed.
Every add, replace and removal waits the register's delay [PRM-047]. The register's guardian
may refuse it until it is carried out. No entry is removed at once.
A proposal may carry several entries. They wait together and take effect together or not at all.
The owner may propose any entry.
A proposer may propose entries of the lower risk categories only. It may not replace or remove
an entry the owner placed above them.
Each proposal is published when it is made, and anyone can list the entries in force.

- **Tests owed:** the defaults for a rule, with a proposer's entry above its categories, a
  refusal by the guardian, a removal tried at once, and a proposal one of whose entries fails.

### PRC-223 · rule

**Who:** anyone.
**When:** a change of the register is due.

Anyone carries out a change that is due.
What is carried out is exactly what waited: whoever carries it out chooses nothing in it.
A proposer's entries are held to its categories again then (PRC-220).
The guardian may refuse it until it is carried out.
Each refusal and each change carried out is published.
A change makes a new price version (PRC-230). An open loan keeps its own (PRC-231), so a change
of the register reaches an open loan only through a retirement (PRC-260), a fresh agreement of
both parties (PRC-252, PRC-280), or a replacement of the guard (PRC-300).

- **Tests owed:** the defaults for a rule, with a change carried out by a stranger, one carried
  out with another content than waited, and a refusal one second before it is carried out.

### PRC-221 · rule

**Who:** the register.
**When:** an entry is proposed, and again when it takes effect.

An entry names the feed, the pair it is published under, the feed's and the token's decimal
counts, the feed's update window [PRM-024], the move on which it publishes, and its category.
The register checks what the chain can show.
The token answers with the stated decimal count. The feed answers with the stated count and
the stated pair. The feed's newest answer is positive and no older than its update window plus
the register's grace [PRM-048].
An entry that fails a check is refused. The check asks whether the feed is alive, not whether
its answer is fresh enough to use.

- **Tests owed:** the defaults for a rule, with an entry that fails each check, at the proposal
  and at the taking effect.

### PRC-222 · rule

**Who:** the price guard, and a vault.
**When:** a price is read.

The guard takes an asset's and its feed's decimal counts from the register's entry at the
price version read.
It never reads them from the token or the feed at a price read.
A vault's own read uses the same counts (VLT-240).
The daily launch check reads both again from the token and the feed, and reports a difference
(DPL owed: the daily launch check and what it reports).
The answer to a difference is the pause of that asset (PLT-050).

- **Tests owed:** the defaults for a rule, with a token that changes or stops answering its
  decimal count after its entry took effect.

### PRC-224 · refusal

**Who:** the register.
**When:** an entry is proposed, and again when it takes effect, and the price it implies lies
outside the entry band [PRM-057] of a reference price for the asset (PRC-225).

The entry is refused.
The implied price is an asset's price by its whole route with the entry in place, in the unit,
read with the entry's own decimal counts (PRC-221). It is checked for every asset whose route
uses the entry: a rate's underlying asset, a reference feed and a shared feed among them.
One reference outside the band refuses the entry, whatever another reference says.
An entry refused when it takes effect stays waiting, and can be carried out again (PRC-223).
The band is wide. It catches an entry wrong by a decimal place, not a feed that differs a little.

- **Refused as:** the entry's implied price is outside the band of a named reference.
- **Tests owed:** the defaults for a refusal, with an entry one decimal place out at the
  proposal and at the taking effect, against each reference alone and against two that differ,
  an entry that a second asset's route uses, and one refused at the taking effect and then
  carried out.

### PRC-225 · rule

**Who:** the register.
**When:** it checks the price an entry implies (PRC-224).

It uses three references, each where it exists: every secondary source's reading of the asset,
the guard's accepted price, and the price of the pool the liquidity test reads for it. That
pool is found from the chain alone and read so that one transaction cannot move it
(PRC-519).
The accepted price is left out where the entry replaces the entry that price rests on.
With no reference, an entry passes only where the owner's proposal names it unchecked with the
reason, shown for the whole wait. A proposer cannot name one so. Anyone can then read on the
asset that its entry is unchecked, for as long as that entry is in force.

- **Tests owed:** the defaults for a rule, with an asset that has each reference alone, a
  correcting entry whose only reference is the accepted price, an entry with no reference
  proposed with and without being named unchecked, and one a proposer names unchecked.

## 3.4 Price versions

### PRC-230 · rule

**Who:** the price guard.
**When:** a setting of the guard or an entry of its register changes.

A price version is a pair of counts. The guard's own goes up by one with each change of a
setting carried out. The register's goes up by one with each proposal carried out, however
many entries it carries (PRC-220).
A guard's first settings and a register's first entries are each the first count (PRC-200).
Every setting that affects a price is readable as of a price version.
A read at the newest version is the ordinary read: there is one way a price is worked out.
A change makes a new price version. New loans take it. An open loan keeps its own (PRC-250).

- **Tests owed:** the defaults for a rule, with a change of a setting, a proposal of several
  entries, and a read at each version before and after.

### PRC-231 · never

**Who:** the price guard.
**When:** it reads a price at a price version.

A price version's settings never change after it is made.
A source that a price version did not name is never asked for a loan read at that version,
whatever is set later.

- **Against:** PRC-T16.
- **Watch:** not watchable from chain data alone. The tests owed carry it.
- **Tests owed:** the defaults for a never, with a source added, replaced and restored after a
  loan opened, and the loan read again.

### PRC-232 · rule

**Who:** the price guard.
**When:** at any time.

Four things are no part of a price version and hold for every version at once.
The standing of a secondary source and of the cross-check: counted, muted or removed.
A mute of a rate source, and a fall of a rate that waits for its confirmation. A fall is
confirmed once, for every version, on the observation time of the current version (PRC-152).
The readings the guard keeps, which are measured and never set: the accepted rate of a binding
(PRC-151), the lowest rate since a fall (PRC-152), and the cross-check's newest reading
(PRC-111).
The check of the sequencer's state, and every figure fixed in the guard's code.

- **Tests owed:** the defaults for a rule, with each of the four changed and a loan at an
  older price version read again.

### PRC-233 · rule

**Who:** the price guard.
**When:** it is read at a price version.

The guard keeps a floor, and refuses every read at a version below it, whoever asks (PRC-021).
A version is below the floor when its guard count is below the floor's.
The floor also records the register it was set against. A version on that register is below
the floor when its register count is below the floor's.
A version on a later register is above the floor.
Versions of two guards are never compared.

- **Tests owed:** the defaults for a rule, with a read one version below, at and above the
  floor, and a guard pointed at a new register.

### PRC-234 · never

**Who:** any step.
**When:** at any time.

No floor is raised by any step but the retirement that names it (PRC-271).
No price version is retired past that retirement's checks.
The floor of a guard that has been replaced is never raised again.

- **Against:** PRC-T07, PRC-T08, PRC-T17.
- **Watch:** every raise of a floor lies inside the carrying out of the retirement it names.
- **Tests owed:** the defaults for a never, with a raise tried by the guard's owner alone, by
  the platform outside a retirement, and on a replaced guard.

### PRC-235 · refusal

**Who:** whoever carries out a change of a setting or of an entry.
**When:** the change would give the guard more unretired price versions than the most
[PRM-042], or would take the last place and is not carried out by the owner of what it changes.

The change is not carried out then.
The last place is the owner's alone, so that a correction always has room. Anyone carries out
the changes before it.
A version counts as retired from the carrying out of its retirement, and a retirement brings
the count down (PRC-260).
An alert fires when a guard is one below the most
(KOP owed: the alert on a guard's unretired price versions).

- **Refused as:** the guard has its most unretired price versions, or the last place is the
  owner's.
- **Tests owed:** the defaults for a refusal, with a change at two below the most, a stranger
  and the owner at one below, a change at the most, and one after a retirement.

### PRC-236 · rule

**Who:** governance, and anyone.
**When:** a change drops the source of an asset that some loan holds as priced.

That loan's price version is pinned. No retirement can name a version without a source for
the asset (PRC-270), no guard without one can replace the guard (PRC-323), and the floor is one
line, so no version above the pinned one is retired either.
The guard has the places left of the most [PRM-042], and then makes no further version until
those loans end or the last resort has run (PRC-016).
The way out is a later version that gives the asset a source again, by the place kept for the
owner (PRC-235). New use of an asset is stopped by its pause (PLT-050), never by dropping its
source.

- **Tests owed:** the defaults for a rule, with a retirement and a replacement tried while a
  version is pinned, the places run down to the last, and a source given again by the owner.

### PRC-237 · rule

**Who:** anyone.
**When:** a change of the guard or its register is proposed, and each day.

The preview of a change names every loan that holds as priced an asset whose source the change
drops (APP owed: the preview of a change of the guard or its register).
The daily check reports a pinned version and the places the guard has left (PRC-236)
(DPL owed: the daily launch check and what it reports).

- **Tests owed:** the defaults for a rule, with a change that drops a source one loan holds as
  priced and another holds as unpriced.

### Model: a price version of a guard

**States:**

- Not made (start): no change has made the version.
- Current: the newest version. New loans take it.
- Older: a newer version exists. Loans opened on it are read at it.
- Older, retirement waiting: a retirement that takes it waits its notice.
- Retired, still answered: the retirement was carried out and the floor's moment has not come.
- Refused (end): the floor has taken effect. The guard refuses every read at the version.
- On a replaced guard (end): the guard was replaced. The version is read for a second key only.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not made | Made with the first settings | The deployer | PRC-200, PRC-230 | Current |
| Not made | A change is carried out that makes it | Anyone, and the owner alone for the last place | PRC-201, PRC-223, PRC-230, PRC-235 | Current |
| Current | A newer version is made | Anyone, and the owner alone for the last place | PRC-230, PRC-235 | Older |
| Older | Propose a retirement that takes it | Governance | PRC-260, PRC-261 | Older, retirement waiting |
| Older, retirement waiting | Cancel the retirement | Governance or the guardian | PRC-260 | Older |
| Older, retirement waiting | Carry out the retirement, after its notice | Anyone | PRC-260, PRC-270, PRC-271, PRC-274 | Retired, still answered |
| Retired, still answered | The floor's moment comes | Nobody: the clock | PRC-233, PRC-271 | Refused |
| Current | The guard is replaced | Anyone, by the step | PRC-300, PRC-326 | On a replaced guard |
| Older | The guard is replaced | Anyone, by the step | PRC-234, PRC-300 | On a replaced guard |
| Older, retirement waiting | The guard is replaced | Anyone, by the step | PRC-261, PRC-300 | On a replaced guard |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Made with the first settings | A guard's first settings are given once, when it is made, PRC-200 |
| A change is carried out that makes it | At the most unretired versions, or at the last place by anyone but the owner, PRC-235 |
| A newer version is made | At the most unretired versions, or at the last place by anyone but the owner, PRC-235 |
| Propose a retirement that takes it | The current version, or a named replacement that is retired or not newer, PRC-261 |
| Cancel the retirement | With no retirement waiting, or by anyone but governance or the guardian, PRC-260 |
| Carry out the retirement, after its notice | Before the notice ends, PRC-260. Versions that do not agree, PRC-270. Inside a replacement's settling time, or before an earlier floor has taken effect, PRC-274 |
| The floor's moment comes | No step raises a floor but the retirement that names it, PRC-234 |
| The guard is replaced | While a retirement's floor has not taken effect, PRC-313 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| What made it | A setting of the guard; entries of the register | PRC-230 |
| Loans read at it | None; some | PRC-250, PRC-253 |

## 3.5 A loan's own settings

### PRC-250 · rule

**Who:** a loan.
**When:** it opens.

A loan records one set of settings when it opens. A set never changes once it is made, and
the set a loan is on changes only as PRC-251 lists.
A set has three parts. The price part is the guard and a price version on it, never split.
The route part is the list of sale routes
(FCL owed: the route part of a loan's settings).
The marketplace part is the binding a listing is made through
(EXT owed: the marketplace part of a loan's settings).
Every read made for a loan uses its own set. A change by governance makes a set for new loans.

- **Tests owed:** the defaults for a rule, with a change of each part after a loan opened, and
  every read made for the loan before and after.

### PRC-251 · never

**Who:** any step.
**When:** at any time.

The set an open loan is on changes in three ways and no other.
An announced retirement of a part (PRC-260).
A fresh agreement of both parties: their consent (PRC-280), or an extension or a renewal in
place (PRC-252).
A replacement of the price guard, worked out at each read and never written (PRC-300).
Beside these, only what holds for every version at once reaches an open loan's price
(PRC-232): a mute, a removal and a restoring of a source, a stop of an asset's price, and a
rate's fall and its confirmation, each under its own rule (PRC-210, PRC-213, PRC-214, PRC-152).

- **Against:** PRC-T16.
- **Watch:** every loan's set, read at any moment, is the set it opened with, or one that a
  retirement named for it, or one both parties approved, or the set current at an extension,
  read through every replacement of the guard since.
- **Tests owed:** the defaults for a never, with every step of governance tried on an open
  loan's settings.

### PRC-252 · rule

**Who:** a loan.
**When:** a step is taken on it.

A loan's set follows what its two parties agreed.
A refinance makes a new loan, which takes the current set.
An extension or a renewal in place is a fresh agreement of both parties, and moves the loan to
the current set. Each cap that allows one says so when it is set.
A step that both parties did not agree keeps the loan and so keeps its set, whatever else it
changes. A sale of a position, in whole or in part, is one. The incoming party's preview
states the set.
A read with no loan uses the current set (PRC-020).

- **Tests owed:** the defaults for a rule, with each step named, and the loan's set read before
  and after.

### PRC-253 · rule

**Who:** any step that reads a price for a loan.
**When:** it finds the loan's price version on a guard.

If the loan's record names that guard, the version is the record's own.
Otherwise it is the version that guard was applied at (PRC-326).
Once a floor of that guard has taken effect (PRC-271), the version is the higher of that and
the floor, by the order of PRC-233. So a retirement of a price version writes nothing to a
loan.
A version number is never carried from one guard to another.

- **Tests owed:** the defaults for a rule, with a loan opened before and after a replacement,
  and two retirements one after the other on each guard.

### PRC-254 · rule

**Who:** the platform, and a vault.
**When:** a vault checks an outcome for a loan.

A vault keeps no copy of a loan's settings. The platform names the guard and the price version
the loan is read at (PRC-253).
The vault accepts them only when the guard is the one its own code names (VLT-240) and the
guard answers the read, which it does only for a version at or above its floor (PRC-233).
So a vault's bound holds against the most lenient version still answered, of which there are
never more than the most [PRM-042].
A version with no source for an asset the lien holds as priced gives the vault a refusal
(PRC-018, VLT-246).

- **Tests owed:** the defaults for a rule, with the platform naming another guard, a version
  below the floor, each version still answered, and a version from before a priced asset's
  source was added.

### PRC-255 · never

**Who:** the platform, a vault, and the caller of any step on a loan.
**When:** a loan's lien holds an asset as priced.

No choice of price version turns that asset unpriced.
Where a version named for the loan has no source for the asset, its price is distrusted and
the step refuses (PRC-254). It never takes the route for an asset with no price (PRC-016).
A vault holds the same against the most lenient version still answered (VLT-246).
An asset the loan holds as unpriced keeps its terms when a later version adds a source for it.

- **Against:** PRC-T20.
- **Watch:** no step took the route for an asset with no price on an asset a loan's lien holds
  as priced, outside the record of the last resort (PRC-016).
- **Tests owed:** the defaults for a never, with each version still answered named for a loan
  whose asset gained its source at a later one, on the platform's read and on a vault's own.

## 3.6 An announced retirement

### PRC-260 · rule

**Who:** governance, and anyone.
**When:** a part of a set can no longer work, or a fault needs a source replaced.

Governance may propose to retire one part: a price version, a route part or a marketplace part.
The proposal waits at least the retirement's notice [PRM-041]. Governance or the guardian may
cancel it until it is carried out.
Anyone carries it out once it is due
(KOP owed: the keeper pass that carries out a retirement).
A retirement of a price version retires every older version on that guard with it.
A whole guard is not retired this way: it is replaced (PRC-300).

- **Tests owed:** the defaults for a rule, with a retirement carried out one second before and
  one second after its notice ends, and a cancel by each of the two.

### PRC-261 · refusal

**Who:** governance, and whoever carries out a retirement.
**When:** a retirement names the current value of a part as one to retire, or its named
replacement is retired, or is not newer than every value it retires.

The retirement is refused.
The current value of a part cannot be retired: the new value is first made current by its own
delayed change, and the old one is retired after.
A retirement names its replacement. The replacement is not retired and is newer than every
value retired, both when the retirement is proposed and when it is carried out.
It need not be the current value, and a newer value made during the notice changes nothing: a
loan lands on what its parties were told (PRC-263).
A retirement of a price version lapses when its guard is replaced (PRC-300).

- **Refused as:** the part is current, or the named replacement is retired or not newer.
- **Tests owed:** the defaults for a refusal, with a newer value made during the notice, a
  replacement that is not the current value, and the guard replaced during the notice.

### PRC-262 · rule

**Who:** both parties of a loan on a value that is retired.
**When:** a retirement is proposed.

The proposal is the announcement.
It reaches every loan on a value it retires, the older versions a retirement of a price
version takes with it among them (PRC-260).
Both parties of each are told the date, every difference between their loan's own value and
the named one, and the loan's reading at the named value
(APP owed: the notice of a change that reaches an open loan).
A party who does not accept it has the notice [PRM-041] to repay, sell or close.

- **Tests owed:** the defaults for a rule, with loans on two versions that one retirement
  retires, each told its own differences.

### PRC-263 · never

**Who:** governance.
**When:** at any time.

No loan is moved to settings its parties were not told of at least the retirement's notice
ahead.
A retirement is never silent. With a replacement of the guard (PRC-300), it is the only way a
new source can reach an open loan without a fresh agreement of both parties.
An extension under caps is an agreement made ahead for the set current when it runs. The cap
says so when it is set (PRC-252), and the loan's page shows the set an extension would land on.

- **Against:** PRC-T16, PRC-T17.
- **Watch:** every loan moved by a retirement had, at least the notice before the move, a
  published proposal naming the value it moved to.
- **Tests owed:** the defaults for a never.

### PRC-264 · rule

**Who:** anyone.
**When:** a loan holds a retired route part or marketplace part.

The loan is moved to the replacement its retirement named, not to whatever is current then.
Its other parts stay.
If the named replacement is itself retired later, the loan moves on to that one's replacement.
One step makes the move for a loan. Anyone may take it, a keeper pass does, and every step on
a loan takes it first, so no step reads a retired part
(KOP owed: the keeper pass that moves loans off a retired part).
A read of a loan not yet moved answers as if it had been.
A retired price version needs no move: it is worked out at each read (PRC-253).

- **Tests owed:** the defaults for a rule, with a loan read before the move, a chain of two
  retirements, and a step on a loan not yet moved.

### PRC-265 · never

**Who:** any step.
**When:** it writes a loan's settings.

No retirement and no replacement of the guard changes the guard or the price version a loan's
record names. Both are worked out at each read (PRC-253).
A move of a loan's route part or marketplace part keeps its price part as the record has it.
Nothing of a loan's settings is written to a vault.

- **Against:** PRC-T16.
- **Watch:** every change of the guard or the price version a loan's record names lies inside
  a move by both parties' consent (PRC-280) or an extension (PRC-252).
- **Tests owed:** the defaults for a never, with a move of each part, a retirement of a price
  version and a replacement of the guard, each made on a loan opened before it.

## 3.7 The guards on a retirement of a price version

### PRC-270 · rule

**Who:** whoever carries out a retirement of a price version.
**When:** the retirement is carried out.

The step checks that each retired version agrees with the named one, over the assets in use
(PRC-315), in pages, inside the check window [PRM-046].
For each asset the two versions' prices imply a rate. The highest and the lowest of those
rates differ by no more than twice the price tolerance [PRM-045], and their middle lies within
the tolerance of one.
The named version must vouch (PRC-320) for every asset in use a retired version has a source
for, and no exemption lifts that. A retired version that cannot vouch for such an asset fails
it, unless the proposal named the asset exempt with the reason. An exemption lifts only that.

- **Tests owed:** the defaults for a rule, with two assets that move apart by more than the
  bound, an asset the named version cannot vouch for, and an exempt asset both versions price.

### PRC-271 · rule

**Who:** the platform, and the price guard.
**When:** a retirement of a price version is carried out.

The raise of the guard's floor names its retirement and the exact floor, which is the named
version.
It is proposed no later than the retirement, and lapses or is cancelled with it.
The platform alone carries it out, inside the carrying out of the retirement (PRC-002).
The floor takes effect at a moment fixed then: the floor's wait [PRM-044] after it, on the
plain clock. Nobody chooses that moment, and there is no second step.
Until then the guard still answers the retired versions, and a loan is read at its own.
From then it refuses them for every caller.

- **Tests owed:** the defaults for a rule, with a read one second before and one second after
  the floor's moment, and a retirement cancelled with its raise waiting.

### PRC-272 · rule

**Who:** any step on a loan whose price version a retirement retires.
**When:** the settling time [PRM-043] has not run, and the floor's moment has not come.

The step needs both readings to allow it: the loan's at its own version and at the named one,
on every asset not exempt. Its caller brings the readings both need (PRC-112).
The settling time is counted as a loan's deadlines are: a pause, and an outage with its
recovery window, do not count (PLT-090).
The floor's wait is never shorter than the settling time. A pause or an outage longer than the
difference between the two spends what is left of the settling time.
After that the loan is read at the named version alone. A retirement carries no second key.

- **Tests owed:** the defaults for a rule, with a liquidation allowed by one reading only, a
  pause shorter and one longer than the difference, and a step one second after each time.

### PRC-273 · never

**Who:** whoever carries out a retirement of a price version.
**When:** in that transaction, and for the settling time after it.

Nobody liquidates, borrows or settles on the difference between a retired version and the named
one.
No step on a moved loan goes ahead on one reading alone while the settling time runs.

- **Against:** PRC-T07.
- **Watch:** every step on a moved loan inside its settling time was allowed by both readings.
- **Tests owed:** the defaults for a never, with the carrying out and a liquidation in one
  transaction and in the next.

### PRC-274 · refusal

**Who:** whoever carries out a retirement of a price version.
**When:** a replacement of the guard is inside its settling time, or the floor of an earlier
retirement has not yet taken effect.

The retirement is not carried out then.
So no step reads the guard in force at more than two versions, beside the second keys a loan
holds.
A setting changed after the carrying out makes a newer version for new loans. It changes
neither the floor nor the version the loans moved to.
A pause of the platform does not refuse it: a source that has died is a likely reason for a
retirement.

- **Refused as:** another change of the guard is still settling.
- **Tests owed:** the defaults for a refusal, in each of the two cases, and in a pause.

## 3.8 The consent of both parties

### PRC-280 · rule

**Who:** the holders of a loan's two positions.
**When:** both want the loan on the current set.

A loan moves to the current set when the borrower-side holder and every lender-side holder
have each approved that exact set.
An approval names the set, so it cannot be used for a later one.
No step that one side can take alone moves a loan's price part.

- **Tests owed:** the defaults for a rule, with one approval missing, and an approval of an
  earlier set.

### PRC-281 · refusal

**Who:** the holders of a loan's two positions.
**When:** the approved set is no longer current, the loan is past its default or held after a
failed sale, or the move would leave an asset the loan holds as priced without a source.

The move is refused.
A move, and an extension under caps, that would land a loan on a price version with no source
for an asset the loan holds as priced is refused: the loan would turn unpriced with nobody
having agreed to that (PRC-016).
An asset the loan holds as unpriced stays on its route on any set (PRC-018).

- **Refused as:** the set is not current, the loan cannot be moved in its state, or an asset
  would lose its source.
- **Tests owed:** the defaults for a refusal, in each of the three cases, on a move by consent
  and on an extension, and a move onto a set that prices an asset the loan holds as unpriced.

### PRC-282 · rule

**Who:** both holders of a loan whose caps allow an extension.
**When:** a replacement of the price guard is proposed, or the current set comes to have no
source for an asset the loan holds as priced.

Both are told.
On a replacement the notice names the loan, the earliest date an extension can run, and that
an extension made after the proposal ends the loan's second key (PRC-350).
A holder who does not want that clears the caps.
Where the current set has no source for an asset the loan holds as priced, the notice says
that an extension will be refused (PRC-281) and that the loan falls due on its date.
An extension skipped so is published with its reason (PLT-120).

- **Tests owed:** the defaults for a rule, with caps set before the proposal, an extension
  that runs with nobody present, and an extension skipped for a dropped source.

## Outcome under each condition of the platform (section 3)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| A change of a setting, a mute, a removal, a change of an entry (PRC-201, PRC-210, PRC-213, PRC-223) | Open: steps of the guard and its register, which do not read the platform | Open | Not a party's step | Not a party's step | Not a party's step |
| Carrying out a retirement (PRC-260, PRC-274) | Open | Open | Not a party's step | Not a party's step | Not a party's step |
| The move of a loan off a retired route part or marketplace part (PRC-264) | Open: it runs before every step, among them a repayment (PLT-041) | Open | Open | Open | Open |
| A move by consent (PRC-280) | Refused (PLT-040) | Refused for a paused asset of the loan (PLT-050) | Refused (PLT-060) | Refused (PLT-065) | Refused (PLT-070) |

## Section 4: replacing the price guard

The platform's rules (PLT) and sections 1 to 3 apply throughout and are cited by id.
The vault code's side of a replacement is stated in the vault rules (VLT-220 to VLT-245)
and is cited here, not repeated.
What a change of unit does to each figure is section 5. This section states the step.

## 4.1 One step

### PRC-300 · rule

**Who:** governance, and anyone.
**When:** the price guard is replaced.

Every replacement of the price guard goes through one step of the platform, whether the unit
of account changes or not. A replacement that keeps the unit carries a rate of exactly one.
The step makes the proposed guard the guard in force, runs every check of this section, and
writes the unit record (PRC-400, PRC-410).
It is all or nothing. If any check fails, the old guard stays in force, the old unit stays,
and the replacement stays waiting.

- **Tests owed:** the defaults for a rule, with each check failed in turn, and every record
  of the platform compared before and after the failed step.

### PRC-301 · rule

**Who:** the platform.
**When:** at any time.

One record names the guard in force. It is kept apart from the platform, and the platform and
the version registry of the vault code both take the guard in force from it (VLT-220).
A change of that record is proposed there and waits there.
Only the platform may carry out a waiting change of it, and only inside the step (PRC-300).
The record reads nothing from a guard that is only proposed, and knows nothing of units.

- **Tests owed:** the defaults for a rule, with a waiting change carried out by its owner, by
  the guardian and by a stranger.

### PRC-302 · rule

**Who:** the deployer.
**When:** a deployment is wired.

Three acts are held to the platform alone: carrying out a change of the record that names the
guard in force (PRC-301), applying the change of the vault code that retires a guard
(VLT-229), and raising a guard's floor (PRC-271).
Each is set once, when the contract that holds it is built or wired. A second setting is
refused, and no step changes it. A new platform is a new deployment with its own records.
The launch check reads all three and refuses a deployment in which one names another address
(DPL owed: the launch check of the three fixed executors).

- **Tests owed:** the defaults for a rule, with a second setting of each, and a deployment
  in which each one names another address.

### PRC-303 · never

**Who:** any step.
**When:** at any time.

No guard becomes the guard in force by any route but the step.
No guard is applied but the one its proposal named, after that proposal's full wait.
A guard that has been in force before is never applied again.
No rate of a replacement takes effect unchecked, but on the stated path without the old
guard (PRC-360).
At no moment is a threshold in one unit set against a price in another, and at no moment is
there no guard in force.

- **Against:** PRC-T08, PRC-T17.
- **Watch:** every change of the record that names the guard in force lies inside the step,
  and names the guard of a proposal that waited its full time.
- **Tests owed:** the defaults for a never, with the waiting guard swapped during the wait, an
  earlier guard proposed again, and the record's change tried outside the step.

## 4.2 Proposing and waiting

### PRC-310 · rule

**Who:** governance.
**When:** it proposes a replacement.

A proposal has two halves: the new guard proposed on the record that names the guard in force,
and the platform's record of the replacement.
The platform's record names the new guard, the unit's symbol, the rate, the widest drift of
the rate it accepts, the earliest and the latest time, and each asset it names exempt from the
agreement check, with the reason.
It states its kind: checked, or without the old guard (PRC-360). It lists every figure fixed
in the proposed guard's code that differs from the guard in force.
One replacement waits at a time. All of it is published and shown for the whole wait.

- **Tests owed:** the defaults for a rule, with a second proposal while one waits, and a
  proposed guard whose fixed figures differ.

### PRC-311 · refusal

**Who:** governance, and whoever applies a replacement.
**When:** the proposed guard cannot be the platform's.

The proposal is refused, and the apply is refused again on the same grounds, when:
the guard has been in force before;
its floor can be raised by another than the platform (PRC-302);
its settings name no check of the sequencer's state where the guard in force has one (PRC-135);
its recovery window is shorter than that of the guard in force (PLT-090);
its floor's wait is shorter than the settling time (PRC-272);
its delay can be set below the least the guard's delay may be [PRM-039];
or it does not answer the read a vault already makes (VLT-245).

- **Refused as:** the proposed guard cannot be the platform's, with the ground.
- **Tests owed:** the defaults for a refusal, on each of the seven grounds, at the proposal and
  at the apply.

### PRC-312 · rule

**Who:** governance, and the guardian.
**When:** a replacement waits.

A replacement that keeps the unit waits the wait of a replacement [PRM-049]. A change of unit
waits at least the unit change wait [PRM-050].
Neither is shorter than the guard's delay [PRM-039] or the vault code wait [PRM-002].
Governance or the guardian may cancel either half until it is applied. Cancelling one cancels
the replacement and clears every check made for it.
After its latest time the replacement lapses. The step refuses it, and its half on the record
that names the guard in force is cancelled before a new proposal is made.

- **Tests owed:** the defaults for a rule, with an apply one second before the earliest and one
  second after the latest time, and a cancel of each half by each of the two.

### PRC-313 · refusal

**Who:** whoever applies a replacement.
**When:** the guard that waits is not the guard the platform's record names, or was proposed
later than that record, or has not reached its time, or the floor of a retirement on the guard
in force has not yet taken effect (PRC-271).

The step is refused.
A different guard put in the proposed one's place is never applied under this record. The
replacement is cancelled and proposed again, with its full wait.
A replacement waits for a retirement's floor, as a retirement waits for a replacement's
settling time (PRC-274). So no step reads one guard at more than two versions.

- **Refused as:** the waiting guard is not the one proposed, its time has not come, or a
  retirement's floor has not taken effect.
- **Tests owed:** the defaults for a refusal, with the waiting guard swapped one second before
  the earliest time, and an apply one second before a retirement's floor takes effect.

### PRC-314 · rule

**Who:** anyone, and the parties of an open loan.
**When:** a replacement waits.

From the proposal on, anyone can read what the replacement would do. For a loan: its
loan-to-value and health factor under the new guard. For an asset: both guards' prices and the
rate they imply. For each threshold: its figure in the new unit.
Both holders of an open loan are shown the date and the loan's reading after it
(APP owed: the notice of a change that reaches an open loan).
Where the old guard no longer vouches for an asset, the preview shows the new reading alone
and says it has nothing to compare it with.

- **Tests owed:** the defaults for a rule, and a preview compared with the reading after the
  apply.

### PRC-315 · rule

**Who:** the platform.
**When:** at any time.

The assets in use are every asset that some record holds as priced: a later step will value it
without a first use. The records are a live loan, a lien, an open offer, an amount set aside
to lend, an Auto-lend slot, a standing commitment, and any other record a later step values.
A refinance request is an open offer, and a reserve for a standing instruction is a lien.
An asset that every record holds as unpriced is not in use: no step values it (PRC-255).
The set is readable on the chain. An asset joins it when a record first holds it as priced.
An offer signed off the book is not in use until it is filled. Its fill is a first use
(PRC-316).

- **Tests owed:** the defaults for a rule, with a walk of every step that writes a record a
  later step values, an asset named only by each in turn, and the set read before and after.

### PRC-316 · refusal

**Who:** any step that would bring an asset into use.
**When:** a replacement waits, and the proposed guard does not vouch for the asset, or the rate
its two prices imply lies further than twice the price tolerance [PRM-045] from the rate the
network's wrapped coin's two prices imply at that moment.

The step is refused for the wait.
That first use is the one place a proposed guard is read for a step. An asset already in use
is never asked again, so a proposed guard that cannot be read refuses only a first use.
A first use of an asset as unpriced brings nothing into use, and no replacement refuses it.
With no loan to name a version, the old guard is read at its newest (PRC-020).

- **Refused as:** the asset cannot come into use while the replacement waits.
- **Tests owed:** the defaults for a refusal, with an asset only the old guard prices, an
  asset already in use when the proposed guard cannot be read, and a first loan on an asset
  with no source on either guard.

### PRC-317 · never

**Who:** any step.
**When:** a replacement is applied.

No asset in use escapes the checks of a replacement, whatever kind of record names it.
No asset is first valued for a step by a guard that was not checked for it.

- **Against:** PRC-T09.
- **Watch:** every asset in use at an apply has a check inside the window, or came into use
  during the wait under PRC-316.
- **Tests owed:** the defaults for a never, with an asset named at the apply only by each kind
  of record the walk of PRC-315 finds.

## 4.3 The check and the apply

### PRC-320 · rule

**Who:** the platform.
**When:** it sets one guard's reading beside another's.

A guard vouches for an asset at a price version when its read there answers with a price
(PRC-010), given every reading that read needs, which the step's caller brings (PRC-112).
An answer that is fresh by the freshness rule vouches, a daily feed's inside its window among them.
No price, and a distrusted price of any kind, are both "cannot vouch".
A read that ran out of its budget is neither. It fails the step by name (PRC-041).
Two guards' prices are never compared unconverted, nor with a rate fixed earlier. What is
compared is the rate the two prices imply, read in the same call. Two readings of one pair or
one loan are each a ratio inside one guard, and need no conversion.

- **Tests owed:** the defaults for a rule, with a read starved at each guard, a read whose
  caller brought no reading, and two guards in different units read after the units have moved
  against each other.

### PRC-321 · rule

**Who:** anyone.
**When:** a replacement's time has come.

Anyone runs the check over the assets in use, in pages.
A page reads both guards for its assets, records each asset's implied rate with the time and
the proposed guard's price version, and publishes the two prices.
The old guard is read at each of its unretired price versions that has a source for the asset.
An asset passes only if it passes at each.
A page does not stop at an asset that fails. It records the failure and names the asset.
A page's caller brings the readings its assets need (PRC-112). A keeper pass backs the check
and brings them (KOP owed: the keeper pass that checks and applies a replacement).

- **Tests owed:** the defaults for a rule, with an asset that fails at one version only, a page
  whose asset needs a reading and has none, and the same page run again with one.

### PRC-322 · rule

**Who:** whoever applies a replacement.
**When:** the two guards are compared.

For each asset in use, and for the network's wrapped coin, the two guards' prices give the
rate that asset implies.
The highest and the lowest implied rate differ by no more than twice the price tolerance
[PRM-045]. No single asset is the anchor.
So no pair's price, and no loan's loan-to-value or health factor, differs between the guards
by more than twice the tolerance.

- **Tests owed:** the defaults for a rule, with one asset mispriced, the wrapped coin
  mispriced, and a collateral and a debt asset that each move inside the tolerance and apart.

### PRC-323 · refusal

**Who:** whoever applies a replacement.
**When:** an asset in use is not vouched for.

The apply is refused in two cases.
The new guard cannot vouch for an asset in use that the old guard has a source for, whether or
not the old guard can vouch then. This holds on both kinds of proposal, and no exemption
lifts it.
On a checked proposal, the old guard has a source for an asset in use and cannot vouch for it
at that moment, and the proposal did not name the asset exempt.

- **Refused as:** an asset in use is not vouched for, with the asset and the guard.
- **Tests owed:** the defaults for a refusal, in each case, during an outage of the sequencer,
  and with an asset named exempt.

### PRC-324 · rule

**Who:** governance.
**When:** a proposal names an asset exempt.

An exemption is named asset by asset, with the reason. It is shown for the whole wait, and in
the preview of every loan that names the asset.
It lifts the agreement check and the old guard's vouching for that asset, and nothing else.
The new guard must still vouch for it, every other asset is checked in full, and the rate is
checked among the others.
The settling time and the second key do not ask the old guard about an exempt asset.
Nothing in it is faster than the wait.

- **Tests owed:** the defaults for a rule, with an exempt asset the new guard cannot vouch for,
  and a loan on an exempt asset inside the settling time.

### PRC-325 · rule

**Who:** whoever applies a replacement.
**When:** the rate is checked.

The rate governance named lies within the proposal's stated drift of the middle of the implied
rates, as read in the final call. The stated drift is at most the rate drift cap [PRM-051].
When the unit stays, the middle lies within the price tolerance [PRM-045] of one.
The ranges a rate and the scale must lie in are stated with the unit (PRC-411).

- **Tests owed:** the defaults for a rule, with a rate inverted, a rate gone stale during the
  wait, and a guard that reports the old unit and prices in another.

### PRC-326 · rule

**Who:** anyone.
**When:** the checks are made.

Anyone runs the final call. It accepts only checks made within the check window [PRM-046], and
at the price version the proposed guard has in that call.
It checks any asset that came into use since, and reads the wrapped coin and the assets with
the most pledged value again at that moment.
A check older than the window, or made at another price version, is no check: the asset's page
is run again first. A change carried out on the proposed guard makes every page stale, and the
proposal's latest time bounds how long that can hold an apply (PRC-312).
The step records the price version it applied the new guard at (PRC-253).

- **Tests owed:** the defaults for a rule, with a check one second inside and one second
  outside the window, and a setting of the proposed guard changed after a page was run.

### PRC-327 · never

**Who:** the step that replaces the price guard.
**When:** it is applied.

The step moves no asset, and writes no loan, lien, claim or balance.
It gives no threshold a new figure: a change converts and never sets.

- **Against:** PRC-T07, PRC-T17.
- **Watch:** across every apply, no balance and no record of a loan, a lien or a claim differs
  before and after.
- **Tests owed:** the defaults for a never, with every balance and every record compared
  across an apply that keeps the unit and one that changes it.

### PRC-328 · rule

**Who:** the parties of a loan, and anyone.
**When:** a replacement is applied.

A replacement writes no balance, and thresholds still decide outcomes: whether an asset counts
as liquid, the size of a part liquidation, and what may be opened.
A checked replacement holds the rate within its drift, so each of those lines moves by at most
that.
On a replacement without the old guard they move by whatever the rate is wrong by, until it is
corrected (PRC-362).
The preview states each line's figure before and after (PRC-314).

- **Tests owed:** the defaults for a rule, with an asset just above and just below the line of
  the liquidity test before the apply.

### PRC-329 · rule

**Who:** anyone.
**When:** a replacement is proposed, cancelled, checked or applied.

The proposal, a cancel, each page of the check and the applied replacement are published.
Together they name both units, both guards, the rate, the scale and each asset's two prices,
so a replacement can be worked out again from the published record alone.
A pause of the platform does not refuse the proposal, the check or the apply. The step moves
nothing, and a source that has died is a likely reason for both.

- **Tests owed:** the defaults for a rule, with a replacement rebuilt from what was published,
  and each step taken in a pause.

### Model: a replacement of the price guard

**States:**

- Not proposed (start): no replacement waits.
- Waiting: both halves are proposed, and the earliest time has not come.
- Open to check: the earliest time has come. Pages may be run and the final call made.
- Applied, settling: the new guard is in force, and the settling time runs.
- Applied (end): the settling time has run. Older loans may still hold a second key.
- Cancelled (end): one half was cancelled, and every check made for it is cleared.
- Lapsed (end): the latest time passed with no apply.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not proposed | Propose | Governance | PRC-310, PRC-311 | Waiting |
| Waiting | The earliest time comes | Nobody: the clock | PRC-312 | Open to check |
| Waiting | Cancel either half | Governance or the guardian | PRC-312 | Cancelled |
| Open to check | Cancel either half | Governance or the guardian | PRC-312, PRC-329 | Cancelled |
| Open to check | Run a page of the check | Anyone | PRC-321 | Open to check |
| Open to check | Apply, by the final call | Anyone | PRC-300, PRC-313, PRC-322, PRC-323, PRC-325, PRC-326, PRC-330 | Applied, settling |
| Open to check | The latest time passes | Nobody: the clock | PRC-312 | Lapsed |
| Applied, settling | The settling time runs out | Nobody: the clock, counted as a loan's deadlines are | PRC-340, PRC-342 | Applied |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Propose | While another replacement waits, PRC-310. A guard that cannot be the platform's, PRC-311 |
| The earliest time comes | Nothing shortens the wait, PRC-303, PRC-312 |
| Cancel either half | After the apply, or by anyone but governance or the guardian, PRC-312 |
| Run a page of the check | Before the earliest time, PRC-313 |
| Apply, by the final call | Outside its times, another guard than the one proposed, or before a retirement's floor has taken effect, PRC-313. An asset not vouched for, PRC-323. A rate outside its drift, PRC-325. A vault code that is not ready, PRC-330 |
| The latest time passes | A replacement that was applied does not lapse, PRC-312 |
| The settling time runs out | Time in a pause or an outage does not count, PRC-342 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| Kind | Checked; without the old guard | PRC-310, PRC-360 |
| The unit | Kept; changed | PRC-300, PRC-410 |
| The platform | Paused; not paused | PRC-329 |

## 4.4 The vault code

### PRC-330 · refusal

**Who:** whoever applies a replacement.
**When:** the vault code is not ready for the new guard.

The step applies the one waiting change of the vault code that retires the guard (VLT-229).
It is refused unless, after it, the current version names the new guard and no live version
names another (VLT-228).
The step chooses nothing: it applies only the change governance proposed and that has waited.
If that change was cancelled alone, the step is refused until a new one has waited, or the
replacement lapses.

- **Refused as:** the vault code is not ready for the new guard.
- **Tests owed:** the defaults for a refusal, with no change waiting, a change that has not
  waited, and a live version left that names another guard.

### PRC-331 · rule

**Who:** a vault, and its owner.
**When:** a replacement is applied.

Every vault changes guard in the transaction of the apply, a pinned vault among them: every
pin ends at the step (VLT-234).
The version made current differs from the one it replaces in the guard's address alone
(VLT-245).
The second key is the platform's own further condition and never a vault's. A vault reads only
the guard its code names (VLT-240).

- **Tests owed:** the defaults for a rule, with a pinned vault read in the transaction before
  and the transaction after the apply.

## 4.5 The settling time

### PRC-340 · rule

**Who:** any step that reads a loan-to-value or a health factor.
**When:** the settling time [PRM-043] after a replacement has not run.

The step asks both guards and goes ahead only if both readings allow it, on every asset not
exempt (PRC-324, PRC-360). Where the old guard cannot vouch for such an asset (PRC-320), the
step waits, refused as PRC-341 names it. Only that guard's confirmed silence for the asset
lets the new guard act alone (PRC-356).
A liquidation needs the loan to be liquidatable under both. A new loan, a collateral withdrawal
and a cure need both to permit. A repayment reads no price and is untouched.
The step's caller brings the readings every guard it reads needs, a keyed guard's among them.
A loan is read on the old guard at the version PRC-253 gives. Any other read uses its newest.

- **Tests owed:** the defaults for a rule, with a liquidation allowed by one reading only, a
  new loan allowed by one only, a repayment inside the settling time, and a step whose caller
  brings no reading for the old guard.

### PRC-341 · refusal

**Who:** any step that prices an amount.
**When:** the settling time has not run, and the two guards' readings of the step's pair lie
further apart than twice the price tolerance [PRM-045], or the old guard cannot vouch for an
asset of the pair that is not exempt and its silence for that asset is not confirmed (PRC-356).

The step waits.
It holds for the least output of a forced sale, the split at a close-out in kind, the
collateral handed over on the discounted route, a match between loans, and the backstop's
check at par.

- **Refused as:** the two guards' readings of the pair are too far apart, or the old guard
  cannot vouch, while the replacement settles.
- **Tests owed:** the defaults for a refusal, on each of the five steps, in each of the two
  cases.

### PRC-342 · never

**Who:** the platform.
**When:** it counts a settling time.

A settling time is never spent while nobody could act.
It is counted as a loan's deadlines are: time in a pause, and time while the network's
sequencer is down or inside its recovery window, does not count (PLT-090).
The outage and its window are read from the guard in force, as for every deadline (PRC-135).

- **Against:** PRC-T07.
- **Watch:** the counted length of every settling time, with pauses and outages left out,
  is at least the settling time.
- **Tests owed:** the defaults for a never, with a pause and an outage that each start inside
  the settling time and last longer than it.

### PRC-343 · never

**Who:** whoever applies a replacement.
**When:** in that transaction, and for the settling time after it.

Nobody liquidates, borrows or settles on the difference between the two guards.
Nothing can be done, and no amount can be sized, that only the replacement made possible.
Nobody leaves the old guard out of a step by bringing it no reading (PRC-340).

- **Against:** PRC-T07.
- **Watch:** every step on a loan inside a settling time was allowed by both guards on every
  asset of the loan that is not exempt, or the old guard's silence for the asset was confirmed.
- **Tests owed:** the defaults for a never, with the apply and a liquidation in one transaction
  and in the next, and a liquidation tried with no reading for the old guard.

### PRC-344 · rule

**Who:** any step that reads a stored price.
**When:** a replacement has been applied.

Hourly checkpoints count as none until the new guard has written the settling time's worth of
them. For that time the floor of a forced sale is the full configured figure, and an offer's
price-move guard refuses a fill (PRC-640, PRC-641).
An offer's recorded prices are kept. Their comparison is a ratio whose two ends are now read
from different guards, so it can trip or pass on the replacement alone, by up to twice the
price tolerance. The app says that this is the replacement and not the market
(APP owed: the notice of a change that reaches an open loan).

- **Tests owed:** the defaults for a rule, with a forced sale and a guarded offer's fill inside
  and just after that time.

## 4.6 The second key

### PRC-350 · rule

**Who:** a loan that took its settings before a replacement was proposed.
**When:** the older-loan period [PRM-052] after that replacement has not run.

The loan holds a second key on the replaced guard. This holds for every replacement, whether
or not the unit changes.
The test is by agreement: the loan's record names a guard from before the replacement, and the
loan took its set before the proposal (PRC-252).
A loan opened, refinanced or extended after the proposal holds none. Nor does a loan moved to
the current settings by both parties' consent after the apply (PRC-280).
A step that both parties did not agree (PRC-252) neither gives a key nor ends one.
The period is never shorter than the settling time [PRM-043].

- **Tests owed:** the defaults for a rule, with a loan opened one second before and one second
  after the proposal, an extension after it, each step PRC-252 says keeps the set after it,
  and a move by consent after the apply.

### PRC-351 · rule

**Who:** any step that would take or sell a loan's collateral on a reading.
**When:** the loan holds a second key.

The key stands on every line at which someone other than the borrower's side may take or sell
the collateral by a reading of its health factor or loan-to-value: the liquidation line on
every route, the line above it at which a match between loans is allowed, and the line at
which the collateral counts as collapsed.
While the guard in force reads the loan past such a line by no more than the band, the replaced
guard must read it past the line too. Where it cannot vouch (PRC-320), the key is not met.
The band is twice the price tolerance [PRM-045], as a share of the line's own figure.
Beyond the band the reading of the guard in force decides alone.

- **Tests owed:** the defaults for a rule, on each line and each route, with the loan read one
  step inside and one step beyond the band.

### PRC-352 · never

**Who:** a replaced guard.
**When:** a loan holds a key on it.

A replaced guard never holds a loan out of liquidation that the guard in force reads further
past the line than the band.
A key is never asked on a repayment, a default by time or a forced sale for interest.
A key never becomes a condition of a vault, and never moves a balance.

- **Against:** PRC-T11.
- **Watch:** every step a key refused was on a loan the guard in force read inside the band.
- **Tests owed:** the defaults for a never, with a replaced guard that vouches wrongly for the
  whole older-loan period.

### PRC-353 · rule

**Who:** anyone.
**When:** a guard is silent for an asset at one of its price versions.

Anyone may record that silence, keyed by guard, price version and asset.
One record serves both of its uses: the end of a second key (PRC-356), and the last resort
(FCL owed: an asset whose primary source has ended).
For each use it lapses unconfirmed by that use's own time, twice the silence time for a key.
Anyone may clear it before then by a read that shows the guard answering.
Silence counts only outside a pause, an outage and its recovery window (PLT-090).
A keeper pass backs the record, its clearing and its confirmation
(KOP owed: the keeper pass that ends a silent key).

- **Tests owed:** the defaults for a rule, with a record cleared, a record that lapses for one
  use and stands for the other, and a record made during an outage and during a pause.

### PRC-354 · never

**Who:** anyone.
**When:** a loan holds a key.

A key ends early for an asset only by silence.
A disagreement between sources, an answer that lacks a confirmation, an outage and a mute on
the replaced guard never end it.
One stale moment never ends it, and a starved read never counts as silence (PRC-041).
Nor does a read that fails for want of a reading its caller should bring (PRC-112): a record
of silence made without that reading is refused.

- **Against:** PRC-T11, PRC-T14.
- **Watch:** every key ended early has a record of silence that stood for the whole silence
  time, outside any outage or pause, with no answer of the silent source dated inside it.
- **Tests owed:** the defaults for a never, with each kind of distrusted price held on the
  replaced guard for longer than the silence time, and a record tried without a needed reading.

### PRC-355 · rule

**Who:** a loan that started before more than one replacement.
**When:** a later replacement is applied inside a key's period.

A key names its guard and runs for its own period. A later replacement neither ends it nor
takes its place.
The loan then holds one key for each replacement since it started whose period still runs.
While the guard in force reads the loan inside the band, every one of those keys must read it
past the line. Each key reads its guard at the version PRC-253 gives, and has its own end.
A loan holds no more keys than the most [PRM-054]. The least a liquidation must be supplied
is stated at that number (PRC-040).

- **Tests owed:** the defaults for a rule, with three guards one after the other, and a
  liquidation run on exactly its stated least at the most keys.

### PRC-356 · rule

**Who:** anyone.
**When:** a replaced guard has been silent for an asset, at a price version, for the key's
silence time [PRM-053].

Anyone may confirm the record of that silence (PRC-353, PRC-357).
The key on that guard is then over for every loan that names the asset and is read on that
guard at that version.
Silence at one version never ends the key of a loan whose own version still answers.
Inside a settling time the same confirmation, and nothing else, lets a step read the new guard
alone for that asset (PRC-340). A reading its caller did not bring is never silence (PRC-112).
A lender waits no longer than that time on a source that has died.

- **Tests owed:** the defaults for a rule, with a guard silent at one version and answering at
  another, a confirmation one second before and one second after the silence time, and a step
  inside a settling time that a pause stretched, before and after the confirmation.

### PRC-357 · refusal

**Who:** whoever confirms a record of silence.
**When:** the guard, given every reading it needs (PRC-112), gives an accepted price for the
asset then; or the silent source's own latest answer is dated after the record; or the record
was made in the same block; or a read ran out of its budget (PRC-041).

The confirmation is refused. Where the guard answers, the record is cleared.
The source's own answer time proves the silence was unbroken, and not only at moments a caller
chose. This holds for the last resort without exception.
A source that carries no answer time, a rate source among them, cannot give that proof. For it
a confirmation needs the source's own failure at the record and at the confirmation, and a
clearing pass of the keeper between the two that found it silent (PRC-353).
That is the weaker proof, and each asset's published route says which of its sources carry no
answer time.

- **Refused as:** the guard answers, the source has answered since the record, the record is
  of this block, or a read ran out of its budget.
- **Tests owed:** the defaults for a refusal, in each of the four cases, with an answer between
  the record and the confirmation that cleared nothing, and a source with no answer time with
  and without the keeper's pass between.

### Model: a second key

**States:**

- No key (start): the loan holds no key on any replaced guard.
- Held: inside the band, the replaced guard must read the loan past the line too.
- Ended (end): the key is over. The guard in force decides alone, as far as this key goes.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| No key | A replacement proposed after the loan took its set is applied | Anyone, by the step | PRC-350 | Held |
| Held | A later replacement is applied | Anyone, by the step | PRC-355 | Held |
| Held | The older-loan period runs out | Nobody: the clock | PRC-350 | Ended |
| Held | A record of the replaced guard's silence is confirmed | Anyone | PRC-353, PRC-356, PRC-357 | Ended |
| Held | The loan is extended, or moved by both parties' consent | Both parties | PRC-252, PRC-280, PRC-350 | Ended |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| A replacement proposed after the loan took its set is applied | A loan that took its set after the proposal holds no key, PRC-350 |
| A later replacement is applied | It neither ends a key nor takes its place, PRC-355 |
| The older-loan period runs out | Nothing shortens it but silence or a fresh agreement, PRC-354 |
| A record of the replaced guard's silence is confirmed | Before the silence time, in an outage, after an answer, or for any distrust but silence, PRC-354, PRC-357 |
| The loan is extended, or moved by both parties' consent | A move that is refused changes nothing, PRC-281 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The loan's reading on the guard in force | Short of the line; past it inside the band; past it beyond the band | PRC-351, PRC-352 |
| The replaced guard for the asset | Vouches; cannot vouch and is not silent; silent | PRC-320, PRC-351, PRC-354 |
| Keys held | One; several | PRC-355 |

## 4.7 A replacement without the old guard

### PRC-360 · rule

**Who:** governance.
**When:** the old unit's sources are gone, and the old guard vouches for little or nothing.

A replacement without the old guard is a kind of proposal. It is stated in the proposal, shown
for the whole wait, and waits twice the unit change wait [PRM-050].
On it, an asset the old guard cannot vouch for is no failure. Every asset it still vouches for
is checked in full, and the new guard must vouch for every asset in use as always (PRC-323).
Where the new guard can price the old unit itself, as one currency in another, the named rate
lies within the drift of that price.
Where nothing can check the rate, it is governance's named figure alone, and the published
record of the step says it was unchecked.

- **Tests owed:** the defaults for a rule, with the old guard silent for every asset, for some,
  and a new guard that can and one that cannot price the old unit.

### PRC-361 · never

**Who:** governance, and whoever controls a source of the old guard.
**When:** a replacement is proposed or applied.

A replacement is never moved onto the path without the old guard by anything but its own
proposal: a checked proposal fails whenever an asset cannot be vouched for, an outage of the
sequencer included (PRC-323).
An old guard at fault never blocks its own replacement. The route for a guard that vouches
wrongly is the exemption (PRC-324), and for one that is silent this path.

- **Against:** PRC-T12.
- **Watch:** every applied replacement that passed an asset the old guard could not vouch for
  was proposed as without the old guard, or named that asset exempt.
- **Tests owed:** the defaults for a never, with a source of the old guard made silent, and one
  made wrong, during the wait of a checked proposal.

### PRC-362 · rule

**Who:** governance.
**When:** a rate was applied unchecked.

Governance may correct it: the same unit, the same guard, a new rate, the full unit change
wait [PRM-050], published as a change is.
A rate that was checked is never corrected.
A rate may be corrected more than once, each time with the full wait. The rate as corrected
stays inside the range one change may have, so a run of corrections cannot rescale the
thresholds.
A correction is not a change of unit, and lies outside the cool-down (PRC-412). What it owes
the reward weights is stated with the unit (PRC-422, PRC-423).

- **Tests owed:** the defaults for a rule, with a correction of a checked rate tried, two
  corrections one after the other, and a corrected rate outside the range.

## Outcome under each condition of the platform (section 4)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| Proposing, cancelling, checking and applying a replacement (PRC-310, PRC-321, PRC-326) | Open (PRC-329) | Open | Not a party's step | Not a party's step | Not a party's step |
| A first use of an asset during the wait (PRC-316) | As the step that brings it into use | As that step | As that step | As that step | As that step |
| A step on a loan inside the settling time (PRC-340, PRC-341) | As the step itself. The settling time does not run (PRC-342) | As the step itself | As the step itself | As the step itself | As the step itself |
| A step a second key stands on (PRC-351) | As the step itself | As the step itself | As the step itself | As the step itself | As the step itself |
| Recording, clearing and confirming a guard's silence (PRC-353, PRC-356, PRC-357) | Open | Open | Open | Open | Open |
| A correction of an unchecked rate (PRC-362) | Open | Open | Not a party's step | Not a party's step | Not a party's step |

## Section 5: the unit of account

The platform's rules (PLT) and sections 1 to 4 apply throughout and are cited by id.
The step that changes the unit is the step of section 4. This section states the unit
itself: its record, how each kind of figure is read, and what a change does to each.

## 5.1 The unit record

### PRC-400 · rule

**Who:** the platform.
**When:** at any time.

The platform keeps one unit record: the unit's symbol, a scale, the number of changes of unit
so far, and the time of the last one.
The scale starts at one. Each change of unit multiplies it by the change's rate, which is the
number of new units for one old unit. The unit the deployment started in is the first unit.
The record also keeps the product of the rates as first applied, and for each change its rate
as first applied, its rate as last corrected, and whether it was checked.
Anyone can read the record, and every change of it is published.

- **Tests owed:** the defaults for a rule, with the record read before and after a change and
  a correction.

### PRC-401 · rule

**Who:** the platform.
**When:** it stores or reads a figure in the unit.

Every figure the platform keeps in the unit is stored in the first unit and has one of five
kinds. The kind follows from where the figure comes from, and each has one way to be read.
Set by governance: a value, read as stored times the scale, or a rate per unit, read as stored
divided by the scale. Every threshold, its default and its range is a value.
Measured and added up over time: a weight, kept at the rates as first applied and read through
its sum's factor (PRC-422), and then the scale where it is shown or set against a value.
The record of fees is kept so. Observed: a price, kept with the change number of its time
(PRC-406). A ratio has no unit and is read as stored.

- **Tests owed:** the defaults for a rule, with a figure of each kind read before and after a
  change and a correction, and a build check that no figure is read otherwise than its kind
  allows.

### PRC-402 · rule

**Who:** whoever sets a figure in the unit.
**When:** a threshold or a rate per unit is set.

A figure is given in the unit in force. It is converted to the first unit before it is checked
against its range and stored.
Where a change of a figure waits, it is converted when it is proposed, and the proposal
publishes both the figure given and the figure stored. A change of unit during the wait leaves
its worth as proposed.
So a change of unit converts every threshold, default, range and rate at once and exactly
alike, by changing one stored number. Nothing is gone through one by one.

- **Tests owed:** the defaults for a rule, with a threshold set after a change of unit and
  read back in the unit in force, and a change of a threshold that waits across a change.

### PRC-403 · rule

**Who:** the platform.
**When:** a figure is rounded as it is stored, or as it is read through the scale.

Rounding is stated figure by figure, for the storing and for every read through the scale.
A floor that a user must clear never reads below the figure governance gave: it rounds up.
A cap never reads above the figure governance gave: it rounds down.
A floor below which an amount is treated as dust rounds down.
A rate per unit rounds down, so a charge never reads above the rate governance gave.
A reward weight rounds down when it is stored.

- **Tests owed:** the defaults for a rule, with a floor, a cap, a dust floor, a rate and a
  weight each set at a scale that does not divide evenly, and each read again after a change.

### PRC-404 · never

**Who:** any step.
**When:** at any time.

A change of unit converts and never sets. No threshold is given a new figure by a change.
Changing a threshold stays its own governed step, with its own range.
A run of changes and corrections never rescales a threshold: each rate, and the scale after
it, lies inside its fixed range (PRC-411).

- **Against:** PRC-T17.
- **Watch:** across every change of unit and every correction, each threshold read in the new
  unit equals its figure in the old unit times the rate applied, within one step of the last
  place on the side its rounding states (PRC-403).
- **Tests owed:** the defaults for a never, with every threshold read before and after a
  change, a correction and two changes one after the other.

### PRC-405 · never

**Who:** any step.
**When:** at any time.

Nothing owed to a party is stored in the unit.
A loan's principal, interest and collateral, a lien, a claim, a vault's balance and a split at
a close-out in kind are amounts of tokens.
No vault of any kind holds a figure in the unit: a user's vault, the backstop's and the
treasury's alike. Their checks and limits are ratios, amounts of tokens or shares of a balance.
No loan, lien, claim or vault stores a figure in the unit, and no lien stores a guard or a
price version.

- **Against:** PRC-T17.
- **Watch:** not watchable from chain data alone. The map and its check carry it (PRC-441).
- **Tests owed:** the defaults for a never, with every balance and every amount owed compared
  across a change of unit, and the build check of PRC-441.

### PRC-406 · never

**Who:** any step.
**When:** it reads a stored price.

A stored price carries the change number of its time.
It is never compared with a price of another change number, and never read as a price of the
unit in force after a change.
A threshold in one unit is never set against a price in another.
A ratio of two prices of one change number is a ratio. It may be set beside a ratio of another
number (PRC-344).

- **Against:** PRC-T13.
- **Watch:** not watchable from chain data alone. The tests owed carry it.
- **Tests owed:** the defaults for a never, with a daily price, an hourly checkpoint and an
  offer's recorded prices each read across a change of unit.

## 5.2 A change of unit

### PRC-410 · rule

**Who:** governance, and anyone.
**When:** the unit of account is changed.

A change of unit is a replacement of the price guard whose proposal names a new unit and a
rate (PRC-300, PRC-310). There is no other way to change the unit.
It waits at least the unit change wait [PRM-050], and passes every check of section 4.
At the apply the step writes the unit record: the new symbol, the scale times the rate, one
more change, and the time.
A replacement that keeps the unit writes none of these.

- **Tests owed:** the defaults for a rule, with the record read across a change of unit and
  across a replacement that keeps the unit.

### PRC-411 · refusal

**Who:** governance, and whoever applies a change of unit.
**When:** the rate of a change, or the scale after it, lies outside its fixed range
[PRM-055].

The proposal is refused, and the apply is refused again on the same ground.
A correction of a rate is held to the same range (PRC-362).
The scale's range is wider than one rate's, so a few changes between units of very different
size do not end a deployment's ability to change.

- **Refused as:** the rate or the scale is outside its range.
- **Tests owed:** the defaults for a refusal, with a rate just inside and just outside each
  end of the range, and a scale carried past its range by a second change.

### PRC-412 · rule

**Who:** governance.
**When:** a further change of unit is proposed inside the cool-down [PRM-056] after one.

It is not refused. It waits twice the unit change wait [PRM-050].
So a pair of changes cannot walk a figure, and the way back stays open if the second unit
fails early.
A change that is also without the old guard waits twice, and not four times (PRC-360).
A correction is not a change of unit, and lies outside the cool-down (PRC-362).

- **Tests owed:** the defaults for a rule, with a second change proposed one second inside and
  one second after the cool-down, and one that is also without the old guard.

### PRC-413 · rule

**Who:** the parties of a loan, and anyone.
**When:** a change of unit is applied.

A threshold, its default and its range keep the same worth and are shown in the new unit.
A rate per unit makes the same charge for the same worth.
The record of fees and its total are kept as weights are, one sum for each change of unit
(PRC-421), and shown in the new unit through the factor and then the scale (PRC-401).
The daily price record is kept, with its change number.
The hourly checkpoints count as none for a time (PRC-344).
Reward weights are unchanged in the first unit (PRC-420).

- **Tests owed:** the defaults for a rule, with a charge of the rate per unit and a fee total
  compared before and after a change, and a fee total read after a correction.

### PRC-414 · rule

**Who:** the platform.
**When:** it measures an asset's liquidity.

The sizes of the liquidity test are values in the unit, and follow PRC-401 as every threshold
does.
The test converts a size to the unit its feeds are quoted in, through the guard's own rate,
when it runs. That conversion is one stated step.
The measure of concentration compares against the same figure in the unit
(PRC-510, PRC-630).

- **Tests owed:** the defaults for a rule, with a guard whose feeds are quoted in another unit
  than the unit of account.

### Model: a change of unit

**States:**

- Not proposed (start): the change has not been proposed.
- Waiting: a replacement that names the new unit and a rate waits.
- Applied, rate unchecked: the change was applied with a rate that nothing could check.
- Applied, a correction waiting: a correction of that rate waits the full unit change wait.
- Applied, rate checked (end): the change was applied with a checked rate. It is never corrected.
- Cancelled or lapsed (end): the replacement was cancelled, or its latest time passed.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not proposed | Propose | Governance | PRC-410, PRC-411, PRC-412 | Waiting |
| Waiting | Apply, with the rate checked | Anyone | PRC-325, PRC-410 | Applied, rate checked |
| Waiting | Apply, with a rate nothing can check | Anyone | PRC-360, PRC-410 | Applied, rate unchecked |
| Waiting | Cancel, or the latest time passes | Governance or the guardian, or the clock | PRC-312 | Cancelled or lapsed |
| Applied, rate unchecked | Propose a correction | Governance | PRC-362, PRC-411 | Applied, a correction waiting |
| Applied, a correction waiting | Carry out the correction, after the full wait | Governance | PRC-362, PRC-422, PRC-430 | Applied, rate unchecked |
| Applied, a correction waiting | Cancel the correction | Governance or the guardian | PRC-362 | Applied, rate unchecked |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Propose | A rate or a scale outside its range, PRC-411. While another replacement waits, PRC-310 |
| Apply, with the rate checked | A rate outside its drift, PRC-325 |
| Apply, with a rate nothing can check | A proposal that was not made as without the old guard, PRC-361 |
| Cancel, or the latest time passes | After the apply, PRC-312 |
| Propose a correction | A rate that was checked, PRC-362. A rate outside the range, PRC-411 |
| Carry out the correction, after the full wait | Before the full wait, PRC-362 |
| Cancel the correction | With no correction waiting, PRC-362 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The cool-down of the change before | Running, so the wait is doubled; run out | PRC-412 |
| The network | Changed; behind; changed, with a scale that differs | PRC-430, PRC-432 |

## 5.3 Reward weights

### PRC-420 · rule

**Who:** the platform.
**When:** a loan side's reward weight is registered.

A loan side's interest for a day is valued in the unit in force. It is divided, when it is
registered, by the product of the rates of every change of unit as each was first applied.
The value and the product are of one change number (PRC-406).
So a day's weights stay comparable across a change, and across networks, whichever network
changes first.
A weight is stored in the first unit and is converted only to be shown.
How a weight earns is stated by the reward rules (RWD owed: how a reward weight earns).

- **Tests owed:** the defaults for a rule, with a reward share compared for two loans of equal
  worth registered before and after a change, and a weight registered just after a change.

### PRC-421 · rule

**Who:** the platform.
**When:** weights are added up.

Weights are summed for each change of unit, always. A weight belongs to the latest change of
unit at or before its registration.
A replacement that keeps the unit has a rate of exactly one and starts no new sum.
The record of fees is summed the same way (PRC-413).
Each day's total, the totals the reward network keeps, and every message between networks
carry one sum for each change of unit.

- **Tests owed:** the defaults for a rule, with a day that spans a change of unit, and a
  replacement that keeps the unit inside a day.

### PRC-422 · rule

**Who:** the platform.
**When:** a sum of weights is read.

A sum is read through one factor. The factor is the product, over every unchecked change at or
before it, of that change's rate as first applied over its rate as last corrected.
It is one while nothing was corrected.
A correction changes the scale, which values and rates per unit are read through. It never
changes the product of the rates as first applied.
A later change built on an unchecked one carries that rate inside its own scale, so its sum
takes the earlier factor too.

- **Tests owed:** the defaults for a rule, with weights registered before a correction,
  between two corrections, and under a later change built on the uncorrected one.

### PRC-423 · rule

**Who:** the reward network, and every other network.
**When:** a reward day is closed after a correction.

A reward day closed after a correction is paid through the factors of its sums (PRC-422).
Each network sends its own product of rates and its own scale with its sums. How the reward
network brings the sums to one footing is stated by the reward rules
(RWD owed: the factor of a reward day).
A closed day stays as it was paid. The publication of a correction names the days it could
not reach.
A correction waits the full unit change wait, so at least that many days are paid on the
uncorrected rate. That is a stated cost of a replacement without the old guard (PRC-360).

- **Tests owed:** the defaults for a rule, with a reward day closed before a correction, two
  networks that correct on different days, and a reward network whose own rate was checked.

### PRC-424 · rule

**Who:** anyone.
**When:** a change of unit is proposed.

The rate governance names may differ from the true one by the proposal's stated drift
(PRC-325). So weights registered after a change can be off by up to that against those
registered before.
Two networks whose scales differ because only one of them applied the change checked differ by
no more than that drift (PRC-430). That holds only while a corrected rate stays within the
drift of the rate a network applied checked, and the check across networks reports one that
does not (PRC-432).
The preview of a change states that drift and what it can do to a day's shares (PRC-314).

- **Tests owed:** the defaults for a rule, with a rate at each end of its drift and a day's
  shares compared.

## 5.4 More than one network

### PRC-430 · rule

**Who:** governance.
**When:** the unit is changed on more than one network.

Each network replaces its guard by its own step of governance.
One change of unit uses one rate on every network, named in each proposal with the same
earliest and latest time.
A correction names one rate for every network that applied the change unchecked.
A network added after a change starts at the scale, the change number and the product of rates
the other networks have, and not at one.

- **Tests owed:** the defaults for a rule, with two networks changed on different days, a
  correction on two networks, and a network added after a change.

### PRC-431 · never

**Who:** any network.
**When:** a figure in the unit travels between networks.

No figure in the unit travels between networks without its unit. Each travels in the first
unit, with the sender's change number and the sender's scale, and the receiver converts by
those.
A network on the far side of a change never reads such a figure as one of its own unit.
How a message travels is stated by the cross-chain rules
(XCH owed: what a message between networks carries).

- **Against:** PRC-T13.
- **Watch:** every message between networks that carries a figure in the unit carries the
  first unit's figure, a change number and a scale.
- **Tests owed:** the defaults for a never, with a day's totals and a budget sent across a
  change that only one side has applied, and between two networks whose scales differ.

### PRC-432 · rule

**Who:** governance, and anyone.
**When:** the step has passed on some networks and not on another, or two networks' scales
differ.

A network the step has not passed on is behind. Its new weights are valued in the old unit, so
they drift against the others by however far the true rate has moved from the named one.
Nothing is refused there: its users are not held for a delay of governance.
The check across networks reports a network behind, a difference of scale and a corrected rate
outside the drift (PRC-424), and before the earliest time whether each check would pass
(DPL owed: the launch check across networks).
A keeper pass backs the apply on every network (PRC-321). Governance completes the change or
changes back everywhere, and the proposal's latest time bounds the wait for that decision.

- **Tests owed:** the defaults for a rule, with a change applied on one network and reward
  days added up across two.

## 5.5 The map of every figure in the unit

### PRC-440 · rule

**Who:** the platform's build.
**When:** a figure is stored.

One map lists every stored figure that is a value, a rate per unit, a weight, a price or a
ratio, with its kind.
It covers every contract of the platform, the backstop's vault, the treasury's vault and every
message between networks among them, so the check can show that no vault holds a figure in the
unit (PRC-405).
A figure with no kind in the map is not read against a value from the guard.
The map is built with the rule of PRC-401, and not after it.

- **Tests owed:** the defaults for a rule, and the build check of PRC-441.

### PRC-441 · rule

**Who:** the platform's build.
**When:** before every deployment.

A check reads what is stored and the code, and refuses a build with any of these.
A stored figure multiplied by, divided into or compared with a value read from the guard,
whose kind the map does not name.
A figure read otherwise than its kind allows, a measured figure kept as a value among them.
A figure in the unit on a loan, a lien, a claim or a vault. A guard or a price version stored
on a lien.
A price read for a loan on a guard that is not in force, outside the one separate way (PRC-022).
A threshold that reads as nothing or overflows at either end of the scale's range [PRM-055].

- **Tests owed:** the defaults for a rule, with a build that breaks each of these in turn.

## 5.6 What is shown

### PRC-450 · rule

**Who:** the app, the notices and the Terms.
**When:** a value is shown.

No text names a currency as the platform's unit. Each says "the unit of account" and shows
the symbol read from the chain, so a change of unit changes no text.
History is shown in the unit of its time, or converted at the published rate, and the screen
says which (APP owed: how a value and its unit are shown).
A change waiting is shown with its date and its kind.

- **Tests owed:** the defaults for a rule, with every screen and notice read after a change of
  unit on a test deployment.

### PRC-451 · rule

**Who:** the indexer, and the keeper.
**When:** a change of unit is applied.

Every value the indexer stores carries its change number. A change is one published event,
taken in without a reset (IDX owed: a stored value and its change number).
The keeper's thresholds and alert texts read the unit record.
A liquidation, a default and a periodic settlement act on ratios and on figures read on the
chain in the unit in force. Their passes never stand down for a change of unit.
Only a pass that compares against a figure of the keeper's own configuration stands down and
alerts, on a change number it does not know
(KOP owed: a keeper pass on an unknown change number).

- **Tests owed:** the defaults for a rule, with a change applied while the indexer and the
  keeper run, and a liquidation due on the day of a change.

## Outcome under each condition of the platform (section 5)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| A change of unit and its correction (PRC-410, PRC-362) | Open (PRC-329) | Open | Not a party's step | Not a party's step | Not a party's step |
| Setting a threshold in the unit (PRC-402) | As the authority rules state for that setting | Open | Not a party's step | Not a party's step | Not a party's step |
| Registering a reward weight (PRC-420) | As the step that opens or changes the loan | As that step | As that step | As that step | As that step |

## Section 6: liquidity

The platform's rules (PLT) and sections 1 to 5 apply throughout and are cited by id.
This section states when an asset counts as liquid, how its depth is tested, the tiers, and
what an asset that is not liquid is worth. What a tier gives a loan is section 7.

## 6.1 When an asset is liquid

### PRC-500 · rule

**Who:** the platform.
**When:** a step asks whether an asset is liquid on this network.

An asset is liquid when two things hold at that moment.
The guard gives a price for it (PRC-010).
It passes the depth test at the floor size (PRC-510).
Both are judged from this network's own sources and pools. No other network is asked, and a
failure here is never made good from one.
Nobody, in any role, names an asset liquid. The two readings are the only way (PLT-123).

- **Tests owed:** the defaults for a rule, with an asset that has a price and no depth, depth and
  no price, and both on another network only.

### PRC-501 · rule

**Who:** any step that asks whether an asset is liquid.
**When:** it has the answer.

The read gives one of three answers: liquid, with the asset's tier (PRC-522); not liquid; or no
answer.
"Not liquid" is a finding. The guard has no source for the asset, or no route passes the depth
test.
A distrusted price, of the asset or of the quote asset its last route needs, gives no answer, and
the step that asked is refused (PRC-011).
A pool that cannot be read counts as a pool with no depth, and the other pools still count.
Anyone can read the answer, and a preview shows the one its step would act on (PRC-014).

- **Tests owed:** the defaults for a rule, with each answer made on one asset, a pool whose read
  fails beside one that passes, a quote asset whose price is distrusted with and without another
  route, and a preview compared with its step.

### PRC-502 · never

**Who:** any caller.
**When:** a read of liquidity is starved, or a price it needs is distrusted.

A starved read (PRC-041) or a distrusted price is never the finding "not liquid". It gives no
answer, and an opening that asked is refused.
A pool whose own code fails is a pool with no depth (PRC-501). Where that leaves no route, the
finding stands, and it opens no loan that the parties did not agree as unpriced (PRC-531).
No caller turns an asset not liquid for a step by starving a read, by the moment it picks, or by
anything it sends.
No loan is recorded as unpriced unless both parties named the asset that is not liquid.

- **Against:** PRC-T24.
- **Watch:** every loan recorded as unpriced carries both parties' naming of the asset that was
  not liquid.
- **Tests owed:** the defaults for a never, with a read starved at the guard and at each pool, a
  price distrusted in each of its kinds, a pool whose own code fails, and a loan tried on each.

### PRC-503 · rule

**Who:** the platform.
**When:** it values a token that is one of a kind, or one of a numbered set.

Such a token is never liquid, whatever market it has.
It is worth nothing to every risk figure (PRC-530).

- **Tests owed:** the defaults for a rule, with a token of each kind that has a deep market.

### PRC-504 · rule

**Who:** the platform.
**When:** it asks whether a token priced by an exchange rate is liquid (PRC-150).

The depth test is made on the token itself, and never on its underlying asset.
Its tier is no higher than its underlying asset's tier at that moment.

- **Tests owed:** the defaults for a rule, with a token deeper than its underlying asset and one
  thinner.

## 6.2 The depth test

### PRC-510 · rule

**Who:** the platform.
**When:** it tests an asset at a size.

The test asks how far below the guard's price a sale of that size, valued in the unit, would fill
in one pool against one quote asset.
The asset passes at that size when its best route loses no more than the depth budget [PRM-059].
The sizes are the floor size [PRM-058] and the three tier sizes [PRM-060].
The loss counts the pool's fee as the pool charges it. Where a small sale's fee rounding shows,
the test may overstate the loss and never understates it.
The test is a model and not a quote. A sale is governed by its own least output
(FCL owed: the least output of a forced sale).

- **Tests owed:** the defaults for a rule, with a route one step inside and one step outside the
  budget at each size, and a sale so small that its fee leaves nothing.

### PRC-511 · rule

**Who:** the platform.
**When:** it looks for a route.

A route is one pool that pairs the asset with a quote asset of the list (PRC-512).
A pool counts only on a venue the settings name, at a fee no higher than the fee cap [PRM-061],
and only where it keeps its own record of price and depth over time (PRC-513).
A pool at a higher fee never makes an asset liquid by itself.
A route through two pools is not searched. An asset that is deep only by way of a third asset so
reads thinner than it is, which errs to the safe side.

- **Tests owed:** the defaults for a rule, with an asset whose only pool is above the fee cap, one
  on a venue not named, and one deep only through a third asset.

### PRC-512 · rule

**Who:** the platform, and governance.
**When:** the list of quote assets is read or set.

An asset is never quoted against itself. The network's wrapped coin earns a tier only through
another quote asset.
Once set, the list names at least one quote asset besides the wrapped coin. A change that would
leave none is refused.
A quote asset with no source is skipped before any of its pools is read (PRC-501).
Being on the list gives an asset no tier and no standing. It is read like any other asset.
The launch check refuses a network whose list has no priced quote besides the wrapped coin
(DPL owed: the launch check of the quote list).

- **Tests owed:** the defaults for a rule, with a list set to the wrapped coin alone, a quote
  asset with no source, and a quote asset tiered through another.

### PRC-513 · rule

**Who:** the platform.
**When:** it credits a pool with depth.

A pool is credited only with depth it held on average over the averaging window [PRM-062], read
from the pool's own record.
A pool whose record does not answer for the whole window counts for nothing.
A pool that keeps no such record never counts.
Depth that stays away for the whole window lowers the average, and the asset then reads as it is.

- **Tests owed:** the defaults for a rule, with a pool younger than the window, a pool with no
  record, and depth withdrawn for one second less and one second more than the window.

### PRC-514 · rule

**Who:** any step that reads depth.
**When:** it opens or sizes a position, or closes one out.

Where a position is opened, a tier is read or an offer's bounds are sized, the depth credited is
the lower of the pool's present depth and its average over the window.
Where a liquidation or a default asks whether collateral can still be sold, it is the average
alone, valued at the guard's price.
So depth withdrawn in a close-out's own block cannot make the close-out refuse, and what it can
sell is governed by the sale itself
(FCL owed: the check that collateral can still be sold).

- **Tests owed:** the defaults for a rule, with depth added and depth withdrawn in the block of an
  opening and of a close-out.

### PRC-515 · rule

**Who:** any step that opens a position, reads a tier or sizes an offer.
**When:** a pool's present price lies further than the consistency band [PRM-063] from the guard's
price, or from the pool's own average price over the window.

That pool counts for nothing in the read. A pool that is priced apart cannot admit a position.
A liquidation and a default do not apply the two checks. A real fast move and a price pushed in
one block both fail them, and either would stop a close-out at the moment it must run.
At a close-out a bad fill is refused by the sale's own least output instead.

- **Tests owed:** the defaults for a rule, with a pool one step inside and outside the band on
  each check, at an opening and at a close-out.

### PRC-516 · never

**Who:** anyone.
**When:** at any time.

Depth that is present only around one transaction never makes an asset liquid, never raises its
tier and never sizes a position.
Depth withdrawn in one transaction never makes a liquidation or a default refuse.

- **Against:** PRC-T21.
- **Watch:** every opening's credited depth was at or below the pool's average over the window
  ending at that block.
- **Tests owed:** the defaults for a never, with depth added and removed inside one transaction
  and inside one block, around an opening, a tier read and a close-out.

### PRC-517 · never

**Who:** any caller.
**When:** a read of liquidity looks for a route.

The read uses only pools found from the settings and the chain by PRC-511.
It never uses a pool, a venue, a quote asset or a path that its caller names.
Where several pools count, the read takes the best route by its own rule, and no caller chooses
among them.

- **Against:** PRC-T26.
- **Watch:** every route a read used is one the settings and the chain give at that block.
- **Tests owed:** the defaults for a never, with a caller that names a pool, and two pools that
  count with the worse one offered.

### PRC-518 · never

**Who:** anyone.
**When:** a test sale's loss is measured.

The loss is never measured against a pool's own price. It is measured against the guard's price.
A pool priced apart from the guard by more than the band never passes an asset at an opening
(PRC-515).
At a close-out a pool's price values nothing: depth is valued at the guard's price (PRC-514).

- **Against:** PRC-T30.
- **Watch:** no opening used a pool whose price at that block lay outside the band of the guard's
  price.
- **Tests owed:** the defaults for a never, with a pool whose price is pushed up and one pushed
  down before a test, at an opening and at a close-out.

### PRC-519 · rule

**Who:** the register of feeds.
**When:** it needs a pool price for an asset (PRC-225).

The pool is the one with the most average depth over the window among the pools that count for the
asset (PRC-511, PRC-513). The chain and the settings give it, and nobody names it.
Its price is the pool's own average price over the averaging window [PRM-062], turned into the
unit by the guard's price of the quote asset.
One transaction cannot move that average.
An asset with no pool that counts, or whose quote asset has no price then, has no pool reference.

- **Tests owed:** the defaults for a rule, with two pools of differing depth, a price pushed
  inside one block, and an asset with no pool that counts.

## 6.3 The tiers

### PRC-520 · rule

**Who:** the platform.
**When:** it measures an asset's tier.

An asset's measured tier is none, or one of three.
An asset that is not liquid has none.
A liquid asset earns the first tier by passing the depth test at the first tier size, the second
by passing at the second as well, and the third by passing at all three [PRM-060].
Passing at a larger size never makes up for failing at a smaller one.
A liquid asset that passes only at the floor size has no tier. What it is given is stated with the
risk figures
(PRC-615).

- **Tests owed:** the defaults for a rule, with an asset that passes each size in turn, and one
  that passes the largest and fails a smaller one.

### PRC-521 · rule

**Who:** the keeper, and governance.
**When:** an asset's confidence tier is kept.

Each asset has a confidence tier, kept on the chain by the keeper from checks of real sale routes.
It starts at none for every asset: a new asset has no credit.
A step up is first recorded as waiting. It is held only after renewals have confirmed that step's
depth, with no gap, for the time at depth [PRM-064]. Steps come one at a time.
The keeper lowers a tier at once, by any number of steps, and the way back is earned again.
Governance may lower a tier at once too, and its lowering stands until it is lifted (PRC-543).
Governance may change the keeper
(KOP owed: the keeper pass that keeps the confidence tier).

- **Tests owed:** the defaults for a rule, with a step held one second before and after the time
  at depth, two steps tried at once, a step down by the keeper and by governance, and a step up
  tried straight after each lowering.

### PRC-522 · rule

**Who:** any step that uses a tier.
**When:** it reads an asset's tier.

The effective tier is the lower of the measured tier and the confidence tier as it reads then
(PRC-527).
These read the effective tier: the cap on a new loan, the line and the discount of a liquidation,
the floor of a forced sale, the graded response to concentration, and the class of assets an
account admits.
The exposure limit reads the measured and the proven tier instead (PRC-540, PRC-542).
With the keeper down for longer than the confidence age, every asset reads with no tier. An asset
stays liquid by PRC-500, which asks nothing of the keeper.

- **Tests owed:** the defaults for a rule, with each tier lower than the other in turn, and the
  keeper stopped for longer than the confidence age and for longer than the time at depth.

### PRC-523 · never

**Who:** governance, the keeper, an interface and any caller.
**When:** at any time.

Nothing raises an asset's effective tier above its measured tier: no list of assets, no step of
governance, no keeper and no figure that a caller sends.
A step on a named asset either takes away, as its pause (PLT-050) and a lower confidence tier do,
or records what the asset earned by the one rule every asset is held to (PRC-528).

- **Against:** PRC-T23.
- **Watch:** every tier a loan recorded at its opening was at or below the asset's measured tier
  at that block.
- **Tests owed:** the defaults for a never, with a confidence tier set above the measured tier,
  and every setting of this section moved to each end of its range.

### PRC-524 · never

**Who:** the keeper, and anyone.
**When:** an asset's confidence tier would rise, or is read.

No asset has credit it did not earn.
A new asset never starts with a tier.
No step up is held before renewals have confirmed that step's depth for the whole time at depth.
Depth that left in between, or a renewal missed for longer than the confidence age, starts the
time again.
No confidence tier reads above none once its last renewal is older than the confidence age, and
none reads above the measured tier at any moment (PRC-527).

- **Against:** PRC-T22, PRC-T28, PRC-T29.
- **Watch:** every step up follows renewals with no gap across the whole time at depth, and no
  loan recorded a tier above the measured tier or one whose last renewal was older than the
  confidence age.
- **Tests owed:** the defaults for a never, with depth held for one second less than the time,
  depth that left and came back, a renewal missed while a step waits, a new asset's first loan,
  and a tier read one second after its age.

### PRC-525 · rule

**Who:** a loan.
**When:** an asset's tier changes after the loan opened.

A loan records its collateral's effective tier when it opens, or that it had none (PRC-535).
A lower tier reaches new loans at once. It never changes an open loan's route, and never turns a
priced loan into an unpriced one (PRC-255, PRC-533).
Which figures of an open loan stay as recorded, and which a close-out reads afresh, is stated with
the risk figures
(PRC-620, PRC-621).

- **Tests owed:** the defaults for a rule, with a tier that falls to none one block after a loan
  opens, and a new loan in the same block.

### PRC-526 · never

**Who:** any step that reads a tier.
**When:** an asset has no confidence tier, or its confidence tier reads as none.

An asset with no tier is given figures no better than the most conservative tier's, in every
figure.
That is judged figure by figure, whatever the order of the tiers: the lowest cap on a new loan,
the widest floor of a forced sale, the smallest size for the graded response to concentration.
They are terms a loan can open on, and they are stated with the risk figures
(PRC-615).
Such an asset is liquid only by the floor test, which is measured live and asks nothing of the
keeper (PRC-500). A keeper's silence takes credit away, and never adds any.

- **Against:** PRC-T28, PRC-T29.
- **Watch:** no loan on an asset with no tier recorded a figure better than the most conservative
  tier's.
- **Tests owed:** the defaults for a never, with a new asset and an asset whose tier reads as
  none, each set against every figure a tier gives with the tiers listed in each order, a loan
  opened on each, and the keeper stopped while the floor test passes and while it fails.

### PRC-527 · rule

**Who:** any step that reads a confidence tier.
**When:** the tier's last renewal is older than the confidence age.

A held tier whose last renewal is older than the confidence age [PRM-065] is lapsed, and reads as
none.
The confidence tier may carry what the depth on the chain cannot show, so a tier nobody has
renewed is not relied on.
A lapse is not a step down. A renewal restores the step at once, with no new wait, while the last
renewal is no older than the time at depth [PRM-064].
After that the step is lost, and the asset starts again from none (PRC-521).
No step up is recorded as waiting while a tier is lapsed.

- **Tests owed:** the defaults for a rule, with a tier read one second before and after the
  confidence age, a renewal one second before and after the time at depth, and a step up tried
  while lapsed.

### PRC-528 · rule

**Who:** the keeper.
**When:** its pass for confidence tiers runs.

The pass covers every asset that a live record names and every asset that anyone has asked it to
check, by one published rule.
It publishes each step with the check behind it, and each asset it did not renew with the reason.
It withholds a tier from no asset by choice. A tier not given is a check that did not pass, and
anyone can see which (PLT-123).
Anyone may ask for an asset to be checked, and the asking gives the asset nothing.

- **Tests owed:** the defaults for a rule, with an asset no record names that is asked for, an
  asset whose check fails, and two assets of the same depth compared.

### PRC-529 · rule

**Who:** the keeper.
**When:** the platform is paused, is not yet launched, or the pass falls silent.

The pass runs while the platform is paused and before a launch, so tiers are earned by the time
lending opens.
The launch check reports each asset's measured tier and confidence tier
(DPL owed: the launch check's report of each asset's two tiers).
A pass that is silent for longer than the confidence age raises an alert
(KOP owed: the alert for confidence tiers not renewed).
Its silence puts new loans on the most careful figures (PRC-526) until the next renewal, and never
lowers the exposure limit (PRC-540).

- **Tests owed:** the defaults for a rule, with the pass run under a pause, a launch check on an
  asset with each pair of tiers, and a silence one second past the confidence age.

### Model: one step of an asset's confidence tier

**States:**

- Not recorded (start): the asset does not hold this step, and it is not waiting.
- Waiting: the step is recorded, and its time at depth runs. A step held below it still reads.
- Held: the step reads, and its last renewal is within the confidence age.
- Lapsed: the last renewal is older than the confidence age. The step reads as none.
- Lost (end): the step was lowered, or its hold ran out. Earning it again is a new life.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not recorded | Record the step as waiting | The keeper | PRC-521, PRC-528 | Waiting |
| Waiting | Renew | The keeper | PRC-521 | Waiting |
| Waiting | A renewal is missed for longer than the confidence age | Nobody: the clock | PRC-524 | Waiting |
| Waiting | Hold the step | The keeper | PRC-521, PRC-524 | Held |
| Held | Renew | The keeper | PRC-521 | Held |
| Held | The confidence age passes with no renewal | Nobody: the clock | PRC-527 | Lapsed |
| Lapsed | Renew, which restores the step | The keeper | PRC-527 | Held |
| Lapsed | The time at depth passes with no renewal | Nobody: the clock | PRC-527 | Lost |
| Waiting | Lower | The keeper or governance | PRC-521, PRC-523 | Lost |
| Held | Lower | The keeper or governance | PRC-521, PRC-523 | Lost |
| Lapsed | Lower | The keeper or governance | PRC-521, PRC-523 | Lost |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Record the step as waiting | While the step below it is not held, or is lapsed, PRC-521, PRC-527 |
| Renew | By anyone but the keeper, PRC-521 |
| Renew, which restores the step | After the time at depth: the step is lost, PRC-527 |
| A renewal is missed for longer than the confidence age | The waiting time starts again, and nothing carries it over, PRC-524 |
| Hold the step | Before the whole time at depth, or after a gap, PRC-524 |
| The confidence age passes with no renewal | Nothing keeps a tier from lapsing but a renewal, PRC-527 |
| The time at depth passes with no renewal | Nothing keeps a lapsed tier past it, PRC-524, PRC-527 |
| Lower | By anyone but the keeper or governance, PRC-521 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The step | First, second, third | PRC-520 |
| The measured tier beside it | Above, equal, below | PRC-522 |
| Who lowers | The keeper, governance | PRC-521 |
| How far a lowering goes | This step alone; every step down to none | PRC-521 |
| The platform | Running, paused, not yet launched | PRC-529 |

## 6.4 Worth and consent

### PRC-530 · rule

**Who:** the platform.
**When:** it values an asset that is not liquid.

An asset that is not liquid is worth nothing to every risk figure: a token with no price, a token
short of the depth test, and every token of PRC-503.
A loan with such an asset on either side is unpriced (PRC-533). It has no loan-to-value and no
health factor, and no step liquidates it by a price.
If its borrower defaults, the whole collateral goes to the lender, whatever its worth in a market,
and whether or not the collateral is itself liquid
(FCL owed: the default of a loan with an asset held as unpriced).
The lender may so recover much less than was lent. Both parties agree to exactly that (PRC-531).

- **Tests owed:** the defaults for a rule, with a loan whose collateral is not liquid, one whose
  lending asset is not liquid and whose collateral is, and a default of each.

### PRC-531 · rule

**Who:** a lender and a borrower.
**When:** an asset of their loan is not liquid when the loan opens.

The loan opens only where each of them named that asset as not liquid in what they agreed to. A
general consent does not count.
A loan with one liquid asset and one that is not is unpriced, and needs the same naming.
The platform's reading at the opening decides, whatever an interface showed before.
Where and how each party names the asset is stated by the offer and opening domains
(OFR owed: the consent that names an asset as not liquid)
(OPN owed: the check of that consent when a loan opens).

- **Tests owed:** the defaults for a rule, with a general consent only, one party's naming only, a
  loan with one liquid asset, and an interface that showed the asset as liquid.

### PRC-532 · refusal

**Who:** any step that opens a loan.
**When:** an asset reads not liquid and a party did not name it so; or it reads liquid where the
record being filled was posted with it as not liquid; or the read gives no answer.

The step is refused, and nothing moves.
The maker of an offer, a signed offer, a refinance request or an Auto-lend slot agreed ahead. Its
record carries the standing each asset had when it was posted, and a fill under the other standing
is refused in both directions (PRC-018).
The maker posts again.

- **Refused as:** an asset's liquidity is not what was agreed, with the asset; or its price is
  distrusted.
- **Tests owed:** the defaults for a refusal, in each of the three cases, with an asset that gains
  and one that loses its depth between a posting and its fill.

### PRC-533 · rule

**Who:** a loan.
**When:** it opens.

The loan records each of its assets as liquid or not, as read then.
The loan is priced where both are recorded liquid, and unpriced otherwise.
Its lien holds the collateral as the loan stands: as priced in a priced loan, and only there.
The standing holds for the loan's whole life, in both directions (PRC-018, PRC-255).
An asset the guard prices that fell short of the depth test is recorded not liquid, as one with no
source is.
The assets in use (PRC-315) follow the lien. The collateral of an unpriced loan is not in use on
that loan's account, since no step values it (PRC-011).

- **Tests owed:** the defaults for a rule, with each asset in each of the three states at the
  opening, a default of a loan with liquid collateral and a lending asset that is not, and the
  record read after each state has changed.

### PRC-534 · never

**Who:** any open loan that is priced (PRC-533).
**When:** depth later leaves a pool, or an asset later fails the depth test.

The loan never takes the route for an asset with no price for that reason.
Its loan-to-value and its health factor still read by the guard's price.
Where its collateral cannot be sold, the close-out's rules for a failed sale apply, and they share
the collateral by its worth
(FCL owed: a sale that cannot be made).

- **Against:** PRC-T25, PRC-T20.
- **Watch:** every close-out that gave the lender the whole collateral was of a loan recorded as
  unpriced when it opened, or carries the record of the last resort.
- **Tests owed:** the defaults for a never, with a loan whose collateral loses all depth before a
  liquidation and before a default.

### PRC-535 · never

**Who:** any open loan whose collateral had no effective tier when the loan opened.
**When:** the asset later earns a tier, or its lapsed tier is restored.

The loan is recorded as opened with no tier, and the record holds for its whole life.
It never takes the discounted route of a liquidation, at any later tier of the asset
(FCL owed: the discounted route refuses a loan with no tier at its opening).
Its figures fixed at opening stay those of an asset with no tier (PRC-526).
The record follows the pattern of a loan's standing: fixed at opening, in both directions
(PRC-255). A loan that opened with a tier keeps the tier it recorded (PRC-525).

- **Against:** PRC-T28, PRC-T22.
- **Watch:** no liquidation on the discounted route was of a loan recorded with no tier at its
  opening.
- **Tests owed:** the defaults for a never, with a loan opened one block before the asset's first
  tier is held, one opened while a held tier was lapsed and one opened after it was restored, each
  put to the discounted route at every later tier.

## 6.5 Exposure against measured depth

### PRC-540 · never

**Who:** any step that takes on new exposure.
**When:** the loan is priced.

No new exposure takes the value pledged in one asset past the exposure limit [PRM-066] of that
asset's depth: the size of the lower of its measured tier (PRC-520) and its proven tier (PRC-542),
or the floor size [PRM-058], the lowest, where either is none. The first is read live and the
second does not lapse, so a silent keeper refuses no loan here and adds no room.
A step past the limit is refused, by name, with the asset and the room left. An open loan is never
changed by a later rise in what is pledged or a later fall in depth.
Below the limit the graded response to concentration applies
(PRC-631, PRC-632).

- **Against:** PRC-T27, PRC-T28.
- **Watch:** at every step that took on new exposure the asset's pledged value, with that step,
  was at or below the limit of the lower of its measured tier and its proven tier at that block.
- **Tests owed:** the defaults for a never, with a loan one unit inside and one unit outside the
  room left, an asset with no measured tier, one whose measured tier is above its proven tier, the
  keeper stopped, and a fall of the tier that puts open loans past the limit.

### PRC-541 · rule

**Who:** the platform.
**When:** it decides whether a step takes on new exposure.

New exposure is every step that pledges collateral for a loan that was not open before, or on
terms that were not agreed before.
Among them are a new loan, a refinance, an extension on new terms, and every fill or slice: of an
Auto-lend slot, of the instant market, of a signed offer and of a collection offer.
A loan that replaces a loan in one transaction counts only the increase in what is pledged. An
extension pledges nothing new, and counts only collateral added with it.
A top-up of collateral, a cure and a repayment are never refused by the limit, at any level of
what is pledged.

- **Tests owed:** the defaults for a rule, with each kind of step at the limit, a refinance past
  the limit that pledges no more and one that pledges more, an extension past the limit with and
  without added collateral, and a top-up, a cure and a repayment far past it.

### PRC-542 · never

**Who:** the keeper, governance and anyone.
**When:** an asset's proven tier is written.

Each asset has a proven tier: the highest confidence tier it has held (PRC-521). It starts at
none.
Nothing raises it but a step up becoming held, after renewals across the whole time at depth
(PRC-524). No list of assets, no step of governance and no figure that a caller sends raises it.
A lapse, a lost step and a lowering by the keeper leave it as it is. So do a mute, and a change of
the primary source that leaves the asset with one.
A lowering by governance lowers it to the tier governance set. It returns to none only when the
asset's primary source leaves the register of feeds.

- **Against:** PRC-T22, PRC-T23, PRC-T28.
- **Watch:** every rise of a proven tier was in the block a step up of that asset became held, and
  to that step.
- **Tests owed:** the defaults for a never, with depth staged on an asset that never held a tier,
  a proven tier across a lapse, a lost step and a keeper's lowering, a lowering by governance, a
  mute, a change of the primary source, a source that leaves and returns, and a rise tried by
  governance and by a caller.

### PRC-543 · never

**Who:** the keeper, and anyone.
**When:** governance has lowered an asset's confidence tier.

A lowering of an asset's confidence tier by governance stands until governance lifts it. While it
stands, no renewal, no step of the keeper and no passing of time raises the tier above the one
governance set.
Governance publishes each lowering with its grounds, as each pause of an asset is published
(PLT-051), and each lifting
(AUT owed: how a lowering of a confidence tier is published, with its grounds).
Lifting gives nothing back: the tier is then earned again from the tier governance set, a step at
a time (PRC-521, PRC-523).

- **Against:** PRC-T40.
- **Watch:** no confidence tier rose above a tier governance set while that lowering stood.
- **Tests owed:** the defaults for a never, with renewals across the time at depth while a
  lowering stands, a step up tried by the keeper, a lowering lifted and the first step after it,
  and a lowering published with no grounds.

## 6.6 The settings

### PRC-550 · rule

**Who:** governance.
**When:** a figure of this section is changed.

Every figure of the liquidity test is a setting with a fixed range, changed only under its delay.
The platform keeps the ones stated in the unit or as a time: the sizes, the depth budget, the
consistency band, the time at depth, the confidence age and the exposure limit
(AUT owed: the settings of the liquidity test and their ranges).
A change reaches the reads made after it. It never changes what an open loan recorded (PRC-533).
No setting names an asset as liquid or gives one a tier (PRC-523).

- **Tests owed:** the defaults for a rule, with each figure at both ends of its range, and an open
  loan read before and after a change.

### PRC-551 · rule

**Who:** governance, the platform and the register of feeds.
**When:** the venues, the fee cap, the list of quote assets or the averaging window is kept, read
or changed.

These four say where market data is read, as a feed does. They are kept on the guard's side, in a
record of their own.
Governance changes them under the guard's wait (PRC-201), and a change that waits can be cancelled
as any setting of the guard can.
The platform and the register read that one record. The register so finds a pool without reading
the platform (PRC-519).
They are no part of a price version (PRC-230). Every read uses the ones in force at that moment.

- **Tests owed:** the defaults for a rule, with a change of each of the four read by the platform
  and by the register in the same block, and a change cancelled while it waits.

## Outcome under each condition of the platform (section 6)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| Reading whether an asset is liquid, and its tier (PRC-501) | Open | Open | Open | Open | Open |
| Opening a loan on the reading (PRC-531, PRC-532, PRC-540, PRC-541) | As the step that opens the loan | As that step (PLT-050) | As that step | As that step | As that step |
| The keeper's step up or down of a confidence tier, and its renewal (PRC-521, PRC-528) | Open (PRC-529) | Open | Not a party's step | Not a party's step | Not a party's step |
| A change of the venues, the fee cap, the quote list or the window (PRC-551) | Open: a step on the guard's side, which does not read the platform | Open | Not a party's step | Not a party's step | Not a party's step |

## Section 7: risk figures

The platform's rules (PLT) and sections 1 to 6 apply throughout and are cited by id.
This section states how an amount is valued, what a tier gives a loan, which figures a loan
fixes at its opening, the measure of concentration, the checkpoints and the calm test, and the
floor of a forced sale. The sale and the liquidation themselves are owed by the close-out rules.

## 7.1 Value, loan-to-value and health

### PRC-600 · rule

**Who:** the platform.
**When:** it values an amount of an asset.

The value of an amount is the amount times the guard's accepted price, in the unit, by one rule
for every step (PRC-401).
A value on the debt side rounds up, and one on the collateral side rounds down. A value set
against a least it must reach rounds down, and one set against a cap rounds up (PRC-403). So
rounding never favours the step.
A distrusted price gives no value: the step refuses, or states the figure as unknown (PRC-011).
An asset that a loan holds as unpriced has no value in any figure of this section (PRC-530).

- **Tests owed:** the defaults for a rule, with an amount of one smallest part on each side, and a
  value one smallest part either side of a least and of a cap.

### PRC-601 · rule

**Who:** any step that reads a loan's loan-to-value or its health.
**When:** the loan is priced (PRC-533).

Loan-to-value is the value of what the loan owes over the value of its collateral.
Health is the value of the collateral, times the loan's liquidation line, over the value of what
it owes. The line is the one the loan recorded at its opening (PRC-620). What it owes counts
principal and interest to that moment
(LON owed: what a loan owes at a moment).
Both are read at the loan's price version (PRC-253), by both guards inside the settling time of a
replacement (PRC-340), and by both versions inside that of a retirement (PRC-272).

- **Tests owed:** the defaults for a rule, with a loan whose health is one smallest part above and
  below one, a loan read at its own version beside a newer one, and a loan inside each settling
  time.

### PRC-602 · rule

**Who:** an interface and any preview.
**When:** it states a bound derived from these figures.

A bound that a preview states, among them the most that can be borrowed, the least collateral and
the most that can be withdrawn, is one the binding check accepts in the same block.
It is derived by the rule and the rounding of the check itself, so a caller who uses a stated
bound is never refused for it.

- **Tests owed:** the defaults for a rule, with each stated bound used exactly, and one smallest
  part past it.

### PRC-603 · never

**Who:** any step that sets a value against a bound.
**When:** at any time.

No rounding favours the side that gains by the step. A value set against a least it must reach is
never rounded up to reach it, and a value set against a cap is never rounded down to pass under it
(PRC-600).
No bound that a preview states is looser than the binding check (PRC-602).
So no loan opens and no collateral leaves one smallest part past a bound, and nothing is gained by
repeating a step at the smallest amount.

- **Against:** PRC-T33.
- **Watch:** no step passed a bound that the exact figures, unrounded, would have refused.
- **Tests owed:** the defaults for a never, with a value one smallest part either side of each
  bound of this section, and a step repeated many times at the smallest amount.

## 7.2 What a tier gives

### PRC-610 · rule

**Who:** the platform.
**When:** a step asks what an asset's tier gives.

A tier gives a loan five figures: the cap on its loan-to-value at opening (PRC-612), its
liquidation line (PRC-614), the tight floor of a forced sale (PRC-650), the size its concentration
is measured against (PRC-630), and the discount of the discounted route
(FCL owed: the discount of each tier).
A deeper tier is never held to a more careful figure than a shallower one. Governance sets one
kind of figure for all tiers in one step, and a step that breaks that order is refused.
Each is read from the effective tier (PRC-522).

- **Tests owed:** the defaults for a rule, with each kind of figure set out of order, and each
  figure read for an asset whose measured tier and confidence tier differ.

### PRC-611 · rule

**Who:** any step that opens a priced loan.
**When:** it checks the loan's loan-to-value.

One switch of governance says whether the tier caps are on. On: a loan opens only at or below its
collateral tier's cap (PRC-612) and with health at or above the lower floor [PRM-070].
Off: the same cap holds and health must reach the higher floor [PRM-069], so off admits no loan
that on refuses.
In both, concentration may lower the cap (PRC-632), and collateral with no tier has the terms of
PRC-615.
Turning the caps off acts at once. Turning them on waits as a setting does, and is refused while
the list of quote assets is not set (PRC-512).

- **Tests owed:** the defaults for a rule, with a loan one smallest part inside and outside each
  bound in each state of the switch, the switch turned in the block before a loan opens, and a
  loan that on refuses tried with the caps off.

### PRC-612 · rule

**Who:** the platform.
**When:** it reads a tier's cap for a new loan.

Each tier has a default cap [PRM-071] and a ceiling [PRM-072]. A usable peer reading (PRC-613)
stands in place of the default, lower or higher. It is usable while no older than the usable age
[PRM-074] and peer reads are not paused.
One that stops being usable leaves the lower of it and the default, until a new usable reading or
a change of the default that has waited.
Whichever applies is cut to the ceiling and to every deeper tier's cap (PRC-617, PRC-619).
A reading past half the usable age raises a notice while it still applies
(KOP owed: the alert for an ageing peer reading).

- **Tests owed:** the defaults for a rule, with a reading below and above the default and above
  the ceiling, a reading one second before and after the usable age, peer reads paused with a
  reading below and above the default, a low reading grown old, and a ceiling lowered between a
  refresh and a loan.

### PRC-613 · rule

**Who:** anyone.
**When:** they refresh a tier's peer reading.

Anyone may refresh a peer reading. It is made from what other lending platforms that governance
names lend against the reference assets it names for the tier.
A reference asset counts only where at least two platforms agree within the agreement band
[PRM-075]. Its value is the lowest of those that agree, so one platform that loosens its own
figure lifts nothing past a second.
A tier gets a reading only where at least two reference assets count. The reading is their median
less the tier's haircut [PRM-073], stored as found, however low.
A read that fails, or finds the asset not lent against or frozen there, counts as no reading.

- **Tests owed:** the defaults for a rule, with one platform alone, two that disagree past the
  band, one reference asset, a failed read, a frozen asset, one platform raised far above the
  other, and the lowest platform raised alone.

### PRC-614 · rule

**Who:** the platform, and a loan.
**When:** a priced loan opens.

Each tier has a liquidation line [PRM-076]: the loan-to-value past which a loan of that tier can
be liquidated. A shallower tier has the lower line, so it is liquidated earlier and keeps the
wider cushion.
The loan records the line of its collateral's effective tier at its opening, and its health is
read against that line for its whole life (PRC-601).
The line applies whether the tier caps are on or off.

- **Tests owed:** the defaults for a rule, with a loan of each tier at its line, and a tier and a
  setting changed after a loan opened.

### PRC-615 · rule

**Who:** any step that opens a priced loan on collateral with no effective tier.
**When:** it reads the loan's figures.

Its figures are these, each no better than any tier's (PRC-526).
The cap is the lowest cap that applies to any tier then (PRC-612) less the step [PRM-077], never
below the least cap [PRM-083] and never above that lowest cap. The health floor is the higher one
[PRM-069], also with the caps on. The line is the lowest any tier has.
While the asset has no tier a forced sale has the full floor (PRC-650). The discounted route is
closed for the loan's life (PRC-535).
Its concentration is measured against the floor size [PRM-058]. The loan records that it had no
tier, with its cap, its health floor and its line.

- **Tests owed:** the defaults for a rule, with the tiers' figures set so that each tier in turn
  is the most conservative, a peer reading below the default, a cap at the least, a lowest tier
  cap at and below the least cap, a loan opened at each bound in each state of the switch, and
  each close-out of such a loan before and after the asset earns a tier.

### PRC-616 · rule

**Who:** anyone, and governance.
**When:** a peer reading is refreshed in a pause, or governance names a reference.

A refresh of a peer reading stays open in a pause (PLT-040). It writes a record and moves nothing,
and no cap should change at the end of a pause because nobody could refresh a reading.
Governance names the platforms and the reference assets as it changes any setting of this section
(PRC-660).
Being named as a reference gives an asset no tier and no standing, and no figure of its own
(PRC-512). It is read like any other asset.

- **Tests owed:** the defaults for a rule, with a refresh in a pause, a reading that would pass
  its usable age inside a pause, and a reference asset's own tier and cap.

### PRC-617 · never

**Who:** governance, the keeper and anyone who refreshes a reading.
**When:** a tier's cap is read, or would change.

No cap that a loan reads is above its tier's ceiling, and none is above the hard ceiling
[PRM-072].
One platform alone never raises a cap past what a second platform lends at. A reading needs two
platforms that agree and two reference assets, and takes the lowest of those that agree (PRC-613).
No quick step raises a cap. Turning the caps off, a pause of peer reads and a reading that grows
old each leave every cap at or below what it was (PRC-611, PRC-612).
A cap rises only by a new usable reading or a setting that has waited, and past the higher of the
default and the figure before it only as PRC-619 allows.

- **Against:** PRC-T32, PRC-T39.
- **Watch:** no loan opened above the ceiling of its tier, and no cap rose in a block without a
  new usable reading or a setting that had waited.
- **Tests owed:** the defaults for a never, with a reading above the ceiling, one platform raised
  alone, the lowest platform raised up to and past the second, a raised reading before its refresh
  in a later hour, the caps turned off, peer reads paused and a low reading grown old, each read
  by a loan in the next block.

### PRC-618 · rule

**Who:** governance, and any step that opens a loan on collateral with no tier.
**When:** a cap for such collateral is set or read.

Every cap for collateral with no tier, the least cap [PRM-083] included, lies below the lowest
liquidation line of any tier by at least the margin [PRM-084].
This is checked at every change of a line or of a cap, and a change that would break it is
refused. Where a read still finds a cap above it, the cap is cut to that line less the margin.
So no loan on such collateral opens at its line or near it.

- **Tests owed:** the defaults for a rule, with every setting of a line and of a cap changed in
  turn so the margin would be broken, and a loan opened one smallest part inside and outside the
  cut cap.

### PRC-619 · rule

**Who:** the platform, and anyone who refreshes a reading.
**When:** a tier's cap is read after a peer reading changed.

The order of PRC-610 holds for the caps a loan reads. Where a peer reading puts a deeper tier's
cap below a shallower tier's, the shallower tier's cap is cut to it. So the response at high
concentration never raises a cap (PRC-632).
A refresh lifts the cap that applies past the higher of the default and the cap that applied
before it only as far as the lower of its reading and the tier's reading before it, and only where
that one was found in an earlier hour, as the checkpoints count hours (PRC-640). Otherwise the cap
stays at that bound, and a first reading applies no higher than the default.
A refresh that lowers the cap applies at once, and one timed to a spike lifts nothing past it.

- **Tests owed:** the defaults for a rule, with a reading that puts each deeper tier below each
  shallower one, read by a loan of each tier and of none, below and at high, a raised reading read
  before and after a refresh in the same hour and in a later one, with the cap before it below and
  above the default, a waiting reading that falls and stays above the cap that applies, a first
  reading above the default, a reading that lowers the cap, and readings that rise at every
  refresh.

## 7.3 What a loan fixes, and what is read live

### PRC-620 · rule

**Who:** a loan.
**When:** it opens.

A priced loan records these at its opening, for its whole life: its standing (PRC-533), its
collateral's effective tier or that it had none (PRC-525, PRC-535), its liquidation line
(PRC-614), the cap and the health floor it opened under (PRC-611), the discount of its tier, and
the level of concentration its collateral was at (PRC-631).
No later change of a tier, a setting, a peer reading or what is pledged moves any of them, and no
extension does. A new loan is the way to new figures.
A later withdrawal of collateral, and a cure, are held to the cap and the health floor the loan
recorded.

- **Tests owed:** the defaults for a rule, with each recorded figure read after its setting, the
  tier and the peer reading changed, across an extension, and a withdrawal at the recorded bound
  after the setting moved each way.

### PRC-621 · rule

**Who:** any step on an open loan.
**When:** it reads a figure the loan did not record.

These are read at that moment, for every loan: the prices, at the loan's price version (PRC-253);
whether collateral can be sold, and the depth a sale meets (PRC-514, PRC-534); the tier and the
calm test that a tight floor reads (PRC-641, PRC-650); and every figure of the liquidity test
(PRC-550).
They describe the market of that moment, so a sale respects the depth there is.
Three settings are read at the sale as well, for every loan: the calm bound [PRM-080], the
coverage [PRM-081] and the tight floor of each tier [PRM-082].
A change of any of these reaches an open loan only inside the bound of PRC-622.

- **Tests owed:** the defaults for a rule, with each figure and each of the three settings changed
  between a loan's opening and its close-out, and the floor of a sale for a loan that opened with
  no tier on an asset that later earned each tier.

### PRC-622 · never

**Who:** governance, the keeper and anyone.
**When:** a figure that is read live changes while a loan is open.

No change of a figure read live moves an open loan's outcome outside what the loan recorded and
its settings fixed.
Such a change can choose between a sale and the rules for a failed sale (PRC-534), and can set the
floor of a sale between a tight figure and the full one (PRC-650).
It never turns a priced loan unpriced, never moves the loan's line, cap, discount or standing, and
never lets a sale lose more than the widest figure a vault accepts (VLT-040).

- **Against:** PRC-T25, PRC-T34.
- **Watch:** every close-out of a priced loan used the line, the discount and the standing the
  loan recorded, and no forced sale lost more than the widest figure a vault accepts.
- **Tests owed:** the defaults for a never, with every figure of the liquidity test and of this
  section moved to each end of its range between a loan's opening and each close-out.

### PRC-623 · rule

**Who:** the platform, and every domain that adds a figure of risk.
**When:** a figure is classed as recorded or as read live.

One rule classes every figure. A figure that decides who is owed what, or at which reading the
other side may act, is recorded at the loan's opening (PRC-620). A figure that describes the
market is read live (PRC-621).
A setting that says how the market is read at a sale is live too, inside the bound of PRC-622.
The close-out domain classes its own figures by this rule: the line at which collateral counts as
collapsed, the most a forced sale may lose, the reward of a liquidator and the sizing of a part
liquidation
(FCL owed: the classing of the close-out's figures).

- **Tests owed:** the defaults for a rule, with every figure of this section and of the close-out
  set against the rule, and none left unclassed.

### PRC-624 · never

**Who:** governance, the keeper and anyone.
**When:** a setting, a tier, a peer reading or what is pledged changes while a loan is open.

No later change moves a figure an open loan recorded: its standing, its tier or that it had none,
its line, its cap, its health floor, its discount and its level of concentration (PRC-620).
No figure that decides who is owed what, or at which reading the other side may act, is read live
for an open loan (PRC-623). A domain that adds such a figure records it at the opening.
So no change of a setting liquidates, traps or re-prices a loan that is sound by the figures it
opened on.

- **Against:** PRC-T34, PRC-T25.
- **Watch:** every check of an open loan used the line, the cap, the health floor and the discount
  that the loan recorded.
- **Tests owed:** the defaults for a never, with every setting of this section moved to each end
  of its range while a loan is open, and each check of that loan read before and after.

## 7.4 Concentration

### PRC-630 · rule

**Who:** the platform.
**When:** it measures how much of one asset is pledged.

For each asset the platform keeps the amount pledged under the live collateral liens of priced
loans. Collateral held after a failed sale counts until it is claimed or sold.
Every step that makes, changes or ends such a lien moves the amount in that step, so it always
equals the sum of those liens.
Concentration is the value of that amount (PRC-600) over the size the asset's effective tier is
tested at [PRM-060], or the floor size [PRM-058] with no tier (PRC-414).
Anyone can read the amount, the size, the ratio and the thresholds, for every asset and at all
times.

- **Tests owed:** the defaults for a rule, with the amount set against the sum of liens after
  every step that touches a lien, collateral held after a failed sale, and an asset with no tier.

### PRC-631 · rule

**Who:** any step that opens a priced loan.
**When:** its collateral is at or above the caution threshold.

At or above caution [PRM-078] the interface warns, with the ratio, and the loan records the level
its collateral was at.
The level a loan records is measured against the size the exposure limit uses (PRC-540), which
does not lapse. So no loan is marked for its life because the keeper was silent (PRC-529).
A loan that opened at caution or above is not eligible for the reserve
(FEE owed: the reserve for a lender's shortfall).
Nothing is asked of the user, and no loan is refused.

- **Tests owed:** the defaults for a rule, with a loan one smallest part below and at the
  threshold, the record read by the reserve, and a loan opened while every tier had lapsed.

### PRC-632 · rule

**Who:** any step that opens a priced loan.
**When:** its collateral is at or above the high threshold.

At or above high [PRM-079] the cap is the next shallower tier's cap. For the shallowest tier, and
for collateral with no tier, it is the cap already given less the step [PRM-077], never below the
least cap [PRM-083] and never above the cap already given.
This holds whether the tier caps are on or off, and no health floor changes.
Where the lowered cap is not below what the loan is held to already, nothing is lowered, and the
reading and the interface say so.

- **Tests owed:** the defaults for a rule, with a loan one smallest part below and at the
  threshold, a tier of each depth and none, each state of the switch, a lowered cap that does not
  bind, one that would fall below the least cap, and a cap already below the least cap.

### PRC-633 · rule

**Who:** the platform.
**When:** it applies the response to concentration.

The response judges a loan when it opens, and refuses none. A refinance and a roll open loans and
are judged. An extension in place opens none and is not.
An open loan is never changed by a later rise in what is pledged.
The thresholds are read live for new loans and are no part of what a loan records, since they
never reach a loan after it opens. The limit that refuses is PRC-540.

- **Tests owed:** the defaults for a rule, with a refinance, a roll and an extension at high, and
  an open loan after the ratio rose past each threshold.

### PRC-634 · never

**Who:** every step that makes, changes or ends a collateral lien.
**When:** at any time.

The amount pledged in an asset never differs from the sum of the live collateral liens of priced
loans in it, with the collateral held after a failed sale (PRC-630).
No such lien is made, changed or ended without the amount moving in the same step, through the one
writer of liens.
So concentration and the exposure limit never read low for a lien that the amount missed, and no
release finds less than it takes.

- **Against:** PRC-T35.
- **Watch:** at every block, the amount pledged in each asset equalled the sum of its live liens.
- **Tests owed:** the defaults for a never, with the amount set against the sum of liens after
  every step that touches a lien, on every route that opens, changes and closes a loan.

### PRC-635 · never

**Who:** every step that releases collateral, and every close-out.
**When:** the amount pledged in an asset is less than a release takes.

No release of collateral, and no close-out that makes one, is refused for the amount pledged.
Where the amount is less than the release takes, it stops at zero, and an event names the asset
and what was short
(KOP owed: the alert for a short pledged amount).
From then the amount is short, and it stays so until it is set right (PRC-636, PRC-637).
So a fault in this record costs new loans room, and never holds a party's collateral.

- **Against:** PRC-T35.
- **Watch:** no release and no close-out was refused for the amount pledged, and every short
  release raised its event.
- **Tests owed:** the defaults for a never, with a release larger than the amount on every route
  that releases collateral, a second short release while the amount is short, and the alert.

### PRC-636 · refusal

**Who:** any step that opens a priced loan or takes on new exposure.
**When:** the amount pledged in its collateral asset is short (PRC-635).

While an asset's amount is short, the exposure limit reads the asset as at its limit (PRC-540).
Every step that would take on new exposure in it is refused, by name, with the asset.
A new loan that takes on none has the response of the high threshold (PRC-631, PRC-632).
A release, a top-up, a cure and a repayment are never refused for it, and no open loan is changed.
The stop is stated. An event marks its start and another its end, and every reading and preview
for the asset says that new loans on it are stopped until the record is corrected
(APP owed: the notice that new loans on an asset are stopped).

- **Refused as:** new exposure in an asset whose pledged amount is short, with the asset.
- **Tests owed:** the defaults for a refusal, with a new loan, a top-up, a cure, a repayment, a
  release, a refinance and a roll on that asset while its amount is short and after it is set
  right, the two events, and the preview.

### PRC-637 · rule

**Who:** anyone, and governance.
**When:** an asset's pledged amount is counted again.

The amount is set right by a count of the live liens that PRC-630 names, made on the chain. Only a
finished count sets the amount.
A lien change while a count runs moves the running total for the part counted, in that step.
Anyone may make the count, at any time, where it can be made in steps. One made while the amount
is not short sets it to the total, and starts no stop. Governance's own step is the fallback
(AUT owed: the step that sets a pledged amount right).
Every correction that changes the amount states the figure before and after in an event, stop or
none, and is held to PRC-638. Only a correction ends the stop of PRC-636.

- **Tests owed:** the defaults for a rule, with a count by anyone and by governance, a count left
  unfinished, a lien made, changed and ended behind and ahead of a running count, a count while
  the amount is not short that finds more, less and the same, and the event.

### PRC-638 · never

**Who:** anyone who makes a count, and governance.
**When:** a correction sets an asset's pledged amount.

No correction ever sets the pledged amount below the total of the live liens on that asset.
This holds for the count that anyone makes and for governance's own step alike, and for a count
during which liens changed (PRC-637).
With PRC-634, the amount after a correction is never short of the liens.

- **Against:** PRC-T42.
- **Watch:** after every correction, the pledged amount of the asset was at or above the sum of
  its live liens at that block.
- **Tests owed:** the defaults for a never, with a correction one smallest part below the total of
  the liens and at it, by each route, and after liens changed behind and ahead of a running count.

## 7.5 The checkpoints and the calm test

### PRC-640 · rule

**Who:** anyone.
**When:** an hour, or a day, has begun with no checkpoint for an asset.

The platform keeps one series of hourly checkpoints and one of daily checkpoints for each asset.
The first caller in an hour, or in a day, writes that slot, and anyone may be that caller
(KOP owed: the keeper pass that writes the price checkpoints).
A slot holds the guard's accepted price at the newest price version of that moment, and names that
version. A distrusted price writes no slot, and a slot is never written twice.
Writing a slot moves no funds and gives the caller nothing. It stays open in a pause (PLT-040):
with no slot written then, every sale would have the full floor and every guarded offer would
refuse once the pause ends.

- **Tests owed:** the defaults for a rule, with two callers in one hour, a distrusted price at the
  hour, a slot written in a pause, and a slot written just after a new price version.

### PRC-641 · rule

**Who:** any step that asks whether a pair is calm.
**When:** it reads the calm test.

A pair is calm when the rate of its two assets now is within the calm bound [PRM-080] of their
rate at the hourly checkpoint of each of the two hours before the current one.
The current hour's own slot is not read. So the older of the two was written at least an hour
ago, however late in its hour, and the look back reaches at least an hour.
Each comparison has both ends on the same settings: the rate now is read at the version the slot
names. So a change of settings alone never reads as a move of the market.
There is one test. The floor of a forced sale and an offer's price-move guard both read it
(OFR owed: the price-move guard of an offer).

- **Tests owed:** the defaults for a rule, with a rate one smallest part inside and outside the
  bound at each of the two slots, a new price version between the two slots, a slot written in
  the current hour (not read), and the two slots written in the last moment of one hour and the
  first moment of the next.

### PRC-642 · rule

**Who:** any step that asks whether a pair is calm.
**When:** the test cannot be shown to hold.

A pair that cannot be shown calm is not calm.
That is so where a slot is missing for either asset in either hour, a price cannot be read, a slot
names a version the guard has retired, or a replacement of the guard is inside the time of
PRC-344.
After any gap in the slots, a pair cannot read as calm until the slots of two whole hours lie
behind the current one.
A rate is a ratio inside one guard, so a change of unit needs no conversion and does not by itself
unsettle the test (PRC-401).

- **Tests owed:** the defaults for a rule, with each missing input in turn, a daily slot at a
  retired version, a replacement inside and outside its time, a change of unit between the
  slots, and the first hours after a pause in which no slot was written.

### PRC-643 · never

**Who:** anyone who writes a checkpoint, the keeper and governance.
**When:** a slot is written, or would be changed.

A slot is never written twice, and never at a distrusted price. The first write of an hour stands,
and nobody replaces or corrects it.
Whoever writes a slot chooses only the moment within the hour. The calm test sets the rate now
against the slots of the two hours before the current one and never the current hour's, so its
look back reaches at least an hour whoever wrote them and however late in the hour (PRC-641).
A slot that is missing never reads as calm (PRC-642).

- **Against:** PRC-T36.
- **Watch:** no slot changed after its first write, and none holds a price the guard distrusted in
  its block.
- **Tests owed:** the defaults for a never, with a second write in the same hour by each actor, a
  write at a distrusted price, the current hour's slot written in the block of a sale by its
  caller, and the slots of the two hours before written as late and as early as an hour allows.

### Model: a checkpoint slot

**States:**

- Not written (start): the hour has begun and no price is recorded for it.
- Written: the slot holds a price and names its version. The calm test reads it after its hour.
- Written, version retired: a daily slot whose version the guard no longer answers. Not calm.
- Missed: the hour ended with no slot. The calm test reads it as not calm.
- Past (end): the slot is older than its reader reaches, the calm test or an offer's guard.

**Steps:**

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Not written | Write the slot | Anyone | PRC-640 | Written |
| Not written | The hour ends | Nobody: the clock | PRC-640, PRC-642 | Missed |
| Written | The slot's version is retired, in the daily series | Governance | PRC-260, PRC-642 | Written, version retired |
| Written | The test's reach passes | Nobody: the clock | PRC-641 | Past |
| Written, version retired | The test's reach passes | Nobody: the clock | PRC-641 | Past |
| Missed | The test's reach passes | Nobody: the clock | PRC-642 | Past |

**Refusals out of state:**

| Step | Refused by |
| --- | --- |
| Write the slot | A slot already written, a distrusted price, or an hour that has ended, PRC-640 |
| The hour ends | Nothing writes a slot for an hour that has ended, PRC-640 |
| The slot's version is retired, in the daily series | Only by an announced retirement, whose notice is longer than an hourly slot is read, PRC-260 |
| The test's reach passes | Nothing keeps a slot in the test's reach past it, PRC-641 |

**Dimensions:**

| Dimension | Values | Named by |
| --- | --- | --- |
| The series | Hourly, daily | PRC-640 |
| The price at the hour | Accepted, distrusted | PRC-640 |
| The slot's version | The newest, an older one still answered, a retired one | PRC-641, PRC-642 |
| A replacement of the guard | None, inside the time of PRC-344, after it | PRC-344 |

## 7.6 The floor of a forced sale

### PRC-650 · rule

**Who:** any forced sale of collateral.
**When:** its least output is set.

A forced sale loses no more to the market than the full floor
(FCL owed: the most a forced sale may lose).
It is held to the tight floor of its collateral's tier [PRM-082] only where both of these hold:
the pair is calm (PRC-641), and the collateral is worth at least the coverage figure [PRM-081] of
all the loan owes.
The tier is the effective tier of that moment, with depth read as a close-out reads it (PRC-514,
PRC-522). Collateral with no tier has the full floor. No tight floor is set below its least
[PRM-082].

- **Tests owed:** the defaults for a rule, with each condition failing alone, the coverage one
  smallest part either side of its figure, a sale of each tier and of none, and a tight floor set
  below its least.

### PRC-651 · never

**Who:** any forced sale of collateral.
**When:** a condition of the tight floor cannot be shown.

Where a condition fails or cannot be shown, the sale has the full floor at once.
A missing input only widens the floor to the full figure, and never tightens it. So a sale that a
moving market needs room for always has the full room.
This holds for every forced sale: a liquidation on every route, a part liquidation, a default by
time and a sale for interest.

- **Against:** PRC-T37.
- **Watch:** no forced sale was held to a tight floor in a block where a condition of PRC-650
  could not be shown.
- **Tests owed:** the defaults for a never, with each input missing alone on each kind of forced
  sale.

## 7.7 The settings

### PRC-660 · rule

**Who:** governance.
**When:** a figure of this section is changed.

Each figure of this section is a setting with a fixed range, changed only under its delay and
published
(AUT owed: the settings of the risk figures and their ranges).
A change reaches loans that open after it, and no figure an open loan recorded moves (PRC-620).
The three settings a sale reads reach every sale after it (PRC-621).
A figure that is a value in the unit follows a change of unit as every threshold does (PRC-401).
No setting of this section gives a named asset a figure of its own. A named asset is made more
careful only by its pause (PLT-050), a lower confidence tier (PRC-543) and a short pledged amount.

- **Tests owed:** the defaults for a rule, with each figure at both ends of its range, an open
  loan read before and after a change, a sale after a change of each of the three settings, and a
  change of unit.

## Outcome under each condition of the platform (section 7)

A cell names the statement that decides it. "Open" means the condition does not refuse the step.

| Step | Paused | Asset paused | Caller flagged | Screen cannot be read | Terms not current |
| --- | --- | --- | --- | --- | --- |
| Reading a value, a loan-to-value, a health, a tier's figures or concentration (PRC-600 to PRC-630) | Open | Open | Open | Open | Open |
| Opening a loan under the cap and the response to concentration (PRC-611, PRC-615, PRC-618, PRC-619, PRC-631, PRC-632, PRC-635, PRC-636) | As the step that opens the loan | As that step (PLT-050) | As that step | As that step | As that step |
| Refreshing a peer reading (PRC-613) | Open (PRC-616) | Open | Not a party's step | Not a party's step | Not a party's step |
| Counting an asset's liens again (PRC-637, PRC-638) | Open | Open | Not a party's step | Not a party's step | Not a party's step |
| Writing a checkpoint (PRC-640) | Open (PRC-640) | Open | Not a party's step | Not a party's step | Not a party's step |
| Setting the floor of a forced sale (PRC-650, PRC-651) | As the close-out that sells | As that close-out | As that close-out | As that close-out | As that close-out |
| A change of a figure of this section (PRC-660) | Open: governance's own step under its delay | Open | Not a party's step | Not a party's step | Not a party's step |
