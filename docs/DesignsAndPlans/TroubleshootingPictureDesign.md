# The troubleshooting picture: six questions answered from records alone

Status: **design, direction decided by the owner** (2026-11-22). Not built.
No part of it needs a contract change, and four parts can be built beside
the current batch. Choices the decision left open are marked **Default**.

Its companion is [`RefactorRulesDesign.md`](RefactorRulesDesign.md), which
covers gas, events and errors inside the contracts.

## 1. The goal

When something goes wrong on a testnet or a mainnet, the cause is found from
records, with no guessing and no question to the person who was there.

More events do not reach this goal. A transaction that fails discards every
event it emitted. An attempt the app refuses before sending never reaches
the chain. A keeper that did not act leaves nothing anywhere. So the picture
is built from six questions, and each has its own record.

## 2. The six questions

| # | The question | Where the answer is | What exists today | What this design adds |
| --- | --- | --- | --- | --- |
| 1 | A user tried something and it was refused before it was sent. Why? | Only in the app | The app's error record: the screen, flow and step, the error's name and selector, the network, the loan or offer id and the app's build. One record per error, kept 90 days, the wallet stored reduced and as a keyed hash | A replay where the record allows one, and a plain "cannot be replayed" where it does not (section 4.7) |
| 2 | A transaction was sent and failed. Where and why? | On chain: the receipt and the trace. No event survives | Nothing collects these. The indexer follows events, and a failed transaction has none | The failed transaction record (4.3) and the transaction explainer (4.2) |
| 3 | A transaction succeeded and did something unexpected | The events, and the state before and after | The indexer rebuilds its tables from events, and keeps the events it handles, each with its transaction | Every skip and fallback emits its reason (the companion design), and every row says which event last changed it (4.6) |
| 4 | Something should have happened and did not | Only the service that should have acted knows | The keeper tells a refusal from an unread call, alerts the operator chat and writes to the machine's journal. The indexer reports its own health | The keeper decision record (4.4) |
| 5 | A service showed or sent something wrong | The service's logs and the build that was running | A commit stamp on every deployed service, a check for a service behind the main branch, health routes | A request reference shared by the app and the services, and a kept record of service errors (4.6) |
| 6 | What was true at that moment? | Deployment records and the history of settings | The code hashes recorded per network, the deployments file, the pause log, and one current copy of the settings | Settings, facets, builds and keeper switches as they were at a block or a time (4.5) |

## 3. The records and how long they are kept

Every record states what it holds, who can read it and how long it is kept.
"Operators" means the platform's operators through their own credentials.
None of these records is served by a public route.

| Record | Holds | Personal data | Kept, **Default** | Lives in |
| --- | --- | --- | --- | --- |
| Error catalogue | Every error, where it can be raised, its meaning and remedy | None | With the code | The contracts package |
| Failed transactions | Public chain data: the transaction, its sender, the function, the decoded error, the explanation taken at the time, the block and its hash | Public chain addresses only, as the event history already holds | 400 days | The shared database |
| Keeper decisions | Per pass and subject: acted, skipped, refused, unread or failed, with the reason | None. Loan and offer ids, no wallet. An address inside a reason is withheld (4.4) | 180 days | The keeper's private database |
| Keeper pass runs | Per run: the pass, its switch, what it read, how long it took, how it ended | None | 180 days | The keeper's private database |
| Settings history | The settings after each change, with the block and transaction of the change | None | For the life of the deployment | The shared database |
| Facet history | Which code served each function, from each change to the Diamond | None | For the life of the deployment | The shared database |
| Build history | Which build of each service was running, from when | None | For the life of the deployment | The shared database |
| Keeper switch history | Which passes were switched on, from when. Names and on or off, never a secret's value | None | For the life of the deployment | The keeper's private database |
| Service errors | A failed or refused request: the service, the route, the status, the request reference, the build, the time | None. No address, no wallet, no network address of the caller | 90 days | The shared database |
| The app's error record | Unchanged (section 4.7) | As assessed in 2026 | 90 days | The shared database |

## 4. The parts

### 4.1 The error catalogue

Defined in the companion design, section 7.4. Every other part reads it: a
selector goes in, and the name, the values, the meaning and the remedy come
out. A skip or fallback reason is an encoded error, so the same lookup
explains those too.

### 4.2 The transaction explainer

Given a transaction, or an attempt that was never sent (the caller, the
target, the call data, the value and a block), it prints what happened in
plain words:

- each facet function entered, in order and by depth, with its arguments;
- each event emitted, decoded;
- where it stopped: the error, its values, and the catalogue's meaning and
  remedy;
- the gas used at each step.

It also writes the same content as data, for the case file.

**Where the trace comes from.** The explainer asks the node for the call
trace. Where the node does not offer one, it rebuilds the moment itself: a
local copy of the chain starts from the state at the end of the **parent**
block, applies the block's earlier transactions in their order, and then
runs and traces this one. The state at the end of the transaction's own
block is never used, because it already holds this transaction's effects and
those of every later one in the block.

**The rebuild is checked against the receipt.** The explainer compares the
rebuilt run with the chain's receipt: whether it succeeded, the gas it used
and the events it emitted. When they agree, the output says "rebuilt and
matching the receipt". When they differ, or an earlier transaction of the
block could not be applied, the output is headed "approximate replay: what
happened on chain is not shown here" and lists what differed. It is never
presented as what happened.

The rebuild needs the parent block's state, which every node keeps for
recent blocks. For an old block it needs a node that keeps old state.
Section 4.3 stores the explanation of every failed transaction at the time,
so an old failure does not depend on that. A successful transaction is not
stored there, and explaining an old one needs a node that keeps old state.

**Which code ran.** The explainer names code from the trace itself. Each
call the Diamond forwards appears in the trace with the address of the code
it was forwarded to, and that address is what ran. The facet history of
section 4.5 turns the address into a name and a build. The explainer never
looks up a function's route "at that block": a refresh later in the same
block would give the code that replaced it. A rebuild forwards its calls at
the transaction's own place in the block, so its trace is read the same way.
Where there is no trace and no rebuild, the output says the code that ran is
not known, and gives the routes in force at the start and at the end of the
block when they differ.

It lives in the shared library as a pure function from a trace to the
explanation, with a thin operator command around it. It sends nothing and
holds no key.

### 4.3 The failed transaction record

A pass finds every failed transaction sent to the platform's contracts and
stores it, with its error decoded **at the time**, while the node still has
the state. This closes question 2, and it sees attempts from any front end,
not only the platform's own.

**The contracts watched** are every address in the network's deployment
record: the Diamond, the position token, the VPFI token and its pools, the
reward and remittance contracts, the liquidation helper and the rest.

**Finding them.** The mode is chosen per network from what its node offers
and from what each mode was measured to cost there.

| Mode | How | Sees | Cost |
| --- | --- | --- | --- |
| **Trace filter** | One request per block range for every call into the watched contracts that failed | Direct calls and calls made through another contract | A few thousand requests a day |
| **List and audit** | Three sources, below | Direct calls, with the miss rate measured | Measured at 8,000 to 11,000 requests and under 100 MB a day for a test network, most of it the audit |
| **Block scan** | Read every block's transactions, keep those sent to a watched contract, read the receipt of each | Direct calls only | Measured on the public test networks at 190,000 to 430,000 requests and 2 to 4 GB a day for one network |

A trace filter is used wherever the node has one. A continuous block scan is
used only where its measured cost is inside a stated bound (**Default**
20,000 requests and 200 MB a day for a network). Everywhere else the mode is
**list and audit**:

- **The keeper's own sends.** Section 4.4 records every one, so a failed one
  is known at once.
- **The network explorer's list** of transactions sent to each watched
  contract, kept where the transaction failed. The deployment record marks
  the contracts users call directly (the Diamond, the position token, the
  VPFI token). Those are read every few minutes (**Default** 5) and the
  rest hourly, which the capability check measured at about 1,800 requests
  a day against 11,000 for reading all of them every 5 minutes. It covers
  direct calls by anyone, which is what a block scan covers. It is an
  outside source of **where to look**. What is stored is read from the
  network's own node: the receipt and the explanation.
- **A sampled audit.** Each day one window of blocks chosen at random
  (**Default** 30 minutes) is scanned in full and compared with what the two
  sources above found in it. A failure they missed is recorded, raises an
  alert and becomes a card. The health route shows the miss rate measured so
  far. Completeness in this mode is a measured figure, never a claim.

**Where the list cannot be read** (the explorer refuses the network, or
offers it only on a tier the owner has not chosen to pay for), the mode is
**sends and audit**: the keeper's own sends, and an audit window as long as
the bound allows. The health route then states, as a plain figure, the
share of the day in which failures by others are watched, and says the rest
of the day is not watched. A network on a trace filter does not read the
list at all and needs no key for it.

Every record names the source that found it.

The first card of this design is a **node capability check** per network,
run against the nodes the services use and not only public ones. It
reports: whether the node answers a trace filter, a transaction trace and a
call at a past block. How far back each reaches. What each mode costs there
in requests and data a day. Whether the explorer's list needs a key, how
late it runs behind the chain, and whether it lists failed calls made
through another contract. Its result is committed per network and selects
the mode.

**Decoding, and what is kept of it.** The explanation is taken while the
node can still give it, and the **whole** of it is stored. A later reader
never has to ask a node for an old trace. For each failed transaction the
record holds the best of the sources below and says which:

| Source | What the record keeps | What it cannot hold |
| --- | --- | --- |
| The node's trace | The explainer's complete output as data: every function entered with its arguments, every event emitted before the failure, the error and its values, the gas at each step | Nothing |
| The rebuild of section 4.2, when it matches the receipt. The pass cannot run one, since it needs a local copy of the chain. An operator runs it with the explainer while the state is still reachable, and the result is added to the record through the same route | The same complete output, marked as rebuilt | Nothing. A rebuild that does not match is not stored as the explanation |
| A replay of the call at the parent block | The error and its values only, marked as a replay. It runs against the state just before the block, not at the transaction's place in it | The call path, the arguments of inner calls, the events before the failure and the gas by step. The record lists these as "not available for this transaction", and they cannot be recovered later |
| None: the node no longer holds that block's state when the failure is found | The receipt's facts: that it failed, the function called and the gas | The error and everything above. The record says "state no longer reachable" |

The last row matters in list and audit mode, where a failure is found some
minutes after it happened. The capability check sets each node's reach
beside each source's delay, so a network where this row would be common is
known before launch and gets a node that reaches further.

If the replay succeeds where the transaction failed, the record says "not
reproduced", and adds whether the transaction used all the gas it was given.

The explainer and the case file read a stored explanation first. They ask a
node only for a transaction the record does not hold, and they show a
partial record as partial, with the list of what it lacks.

**What it stores:** the network, the block, its hash and its time, the
transaction, the sender, the contract and function called, the arguments'
loan and offer ids where the function names them, the error's selector,
name and values, the source used, the stored explanation of that source,
the mode, and the gas facts. A stored explanation is kept whole up to a
stated size (**Default** 256 KB a record). Above it the call path, the
error and the events are kept and the longest argument values are cut, each
with a mark that says so.

**Where it runs.** As a unit of its own on the always-on machine, beside
the keeper and on the pattern of the sanctions services (`ops/sanctions/`):
its own user, its own env file, its own memory cap and its own schedule,
with **no signing key** and **no database binding**. It was first placed on
a small Worker of its own. Measured, the first decode of a stored
explanation takes several times the processor time one Worker run is given
on the present plan, the pass would take the last schedule slot, and one
run's limit on outside requests would bound the audit window. The pass is
written so that it does not depend on its host, and can move to a Worker
when the plan allows. It is kept out of the indexer and out of the keeper's
own unit, so that neither shares its limits or its failures. It writes
through a route on the indexer, under its own token, that
accepts three things and nothing else: a record, the pass's cursor and
checkpoints, and a statement that a block range was replaced. That statement
marks records and deletes none. So the pass can add to and mark the
failed-transaction record and can touch no other table. No user reaches this
unit. A network that is given a continuous block scan inside the bound
runs it the same way.

**Completeness is stated.** The pass keeps a cursor per network. The health
route shows the cursor, the mode and the age of the newest block scanned,
and an alert goes to the operator chat when it falls behind. A range the
pass could not scan is recorded as a gap, with its reason, and is never
silently skipped.

**A replaced block.** A height alone cannot tell that a scanned block was
later replaced. So:

- In every mode the pass takes only blocks at or below the network's
  settled head, the same one the indexer reads, never the newest block.
- Every record carries its block's hash. Each scanned range leaves a
  **checkpoint**: its top block and that block's hash.
- Each run reads the newest checkpoint's block again before it scans. It
  reads twice, as the indexer's own guard does, and calls a replacement only
  when both reads agree with each other and differ from the checkpoint. A
  failed or disagreeing read holds the pass for that run.
- On a replacement the pass walks back through its checkpoints to the newest
  one the chain still agrees with. Every record above it is marked
  **replaced**, with the time it was found, and the range is scanned again.
  These records are a list by block, so the repair is local and no rebuild
  is needed.
- A replaced record is kept and never shown as what happened. The case file
  lists it apart, under "recorded in a block the chain later replaced".
- The cursor, the checkpoints and the replaced marks are stored with the
  records, through the same route. The health route shows the last
  replacement found and the range it covered.

**A fresh Diamond** starts a new history for the network. The records of the
retired deployment are kept, marked with the Diamond they belong to.

### 4.4 The keeper decision record

The question is: why did the keeper not act on this loan at that time? Three
records answer it.

**Pass runs.** One row per run of a pass: the pass, the network, whether its
switch was on, when it started and ended, how it ended, what it read (which
feed, the block or the indexer position it was read at, how many subjects,
from where to where, and whether a cap cut the read short) and the build. A pass that was
switched off writes a row that says so, at most once an hour. The table of
passes already wraps every pass in one place, so the run row is written
there and no pass can forget it.

**Decisions, by change.** For each pass and each subject (a loan, an offer,
a slot, a day) the keeper keeps the **current** decision: the outcome, the
reason, since when, how many times it was seen, and when last. A new history
row is written only when the outcome or the reason changes. So "skipped:
health factor above the line, from 13:50 to 14:20, seen 30 times" is one
row, and a pass that looks at a thousand healthy loans every minute writes
nothing new.

The outcomes are fixed: **acted** (with the transaction), **skipped** (the
keeper's own rule said no, with the rule), **refused** (the contract
answered no, with the decoded error and its values), **unread** (the call
could not be read, which says nothing about the contract) and **failed**
(sent and failed, with the transaction, which then also appears in 4.3).

**No wallet in a reason.** A refusal can carry an address in its values: the
screening refusal names the wallet it refused. A refusal is often read
before anything is sent, so that address is not yet anything the chain has
published in that connection. The rule is by field and is mechanical: the
catalogue gives every value's type, and an address-typed value is stored
only when it is one of the network's own contracts in the deployment record
or an asset of the subject. Any other address is stored as the word
"withheld". The error's name, its selector and every other value are kept.
The same rule covers the reason of a skip, an unread call and a pass run.
The subject's loan or offer id stays, and the parties of a loan are read
from the chain when a case needs them.

**Sends.** Every transaction the keeper sends is recorded with the pass and
the subject that caused it, through the shared sender, so a send cannot go
unrecorded.

**In the read or not, by change.** A decision row counts the runs that saw
the subject. It cannot show a run that did not. So presence is recorded too,
the same way: the keeper compares each run's subjects with the run before
and writes a row only for a subject that **entered** the read or **left**
it, with the run. Leaving closes the subject's open decision row, and a
return opens a new one, so "seen 30 times, from 13:50 to 14:20" never spans
a gap. When a cap cut the run short, a subject past the cap is recorded as
"not reached", which is a different answer from "not in the feed". After a
restart the keeper loads the open rows before its first run, so the
comparison does not start empty.

For any subject and any time the case file then gives one of four answers:
in the read (with the decision), not in the feed, not reached, or **not
known** because no run covered that time. The run rows show which. A loan
missing from a read is a finding about the feed, not a silence.

The records live in the keeper's private database. Nothing outside the
keeper reads them except the operator's case file.

### 4.5 The state at a block

Four small histories, each written when the thing changes.

- **Settings.** Today the indexer keeps one current copy of the protocol's
  settings and reads it again when a governance event passes. It now also
  appends a row per change, with the event and the transaction that caused
  it. The row's values come from **the event's own values**, applied to the
  row before it, never from reading the settings back at the block: a read
  at the block gives the block's last values, which is wrong for a
  transaction between two changes in one block. Where an event does not
  carry a value it changed, the row takes that value from a read at the end
  of the block and marks it "as at the end of the block". If that setting
  changed more than once in the block, the earlier rows mark the value "not
  known" for the stretch between. The companion design (section 6, point 4)
  makes every settings event carry its values in full, so after the pass no
  row needs either mark.
- **Facets.** Every change to the Diamond's routing is recorded from its
  event: which code, at which address, serves which function. Together with
  the code hashes recorded at deploy, this names the code at any address.
- **Builds.** Each service notes its build commit when it first runs under
  it. The app's and the public site's builds are noted from their deploy
  stamps.
- **Keeper switches.** The keeper notes its set of switches at start and
  whenever the set changes: each switch's name and whether it is on.

**Order inside a block.** A settings row and a facet row carry the block,
the transaction's place in the block and the event's place in the
transaction. "What was true" is asked for a transaction, not only for a
block: the answer is the last row placed before that transaction. Asked for
a block alone, the answer is given for the start of the block, and the case
file lists any change made inside it.

The pause log already exists and is read as it is.

### 4.6 Tracing a figure back, and tracing a request

**Every event is kept.** Today the event history holds the events the
indexer has a handler for. It now holds every event the watched contracts
emit, the informational ones too, each decoded and with its transaction. A
skip or a fallback is informational by category, and it is exactly the
event an operator looks for.

**A row back to its events.** Every row the indexer derives records the
event that last changed it: the block and the position in it. So a wrong
figure is followed back to the transaction that produced it, and the
explainer shows what that transaction did.

As chosen for the build: every table the indexer derives by replay carries
three columns for that event, `last_event_block`, `last_event_tx_index` and
`last_event_log_index`. They are set at each place a row is written, and a
static check fails any write that leaves them unset. Triggers in the database
were not taken, because they would spend the query budget of each block.

**A request reference.** The app sends a short random reference with every
request to a service. The service returns it and writes it into its log line
and into the service error record when the request fails or is refused. When
the app shows a failure that came from a service, it shows the reference. It
is random for each request, is not derived from anything about the user, and
is not stored in the browser.

### 4.7 Replaying a refused attempt

The app's error record holds the flow, the step, the error and the loan or
offer id, with a time. It does not hold the block or the error's values.

It also does not hold the call: no arguments, no amount sent, and no caller,
because the wallet is kept only shortened and as a keyed hash. So a replay
is possible for some attempts and not for others, and the case file says
which.

| The attempt | What the record gives | What the case file says |
| --- | --- | --- |
| The call follows from the loan or offer and the flow, with no free input, **and** the record's shortened wallet matches a party the chain names for that position at that time: a claim, a cancellation, switching an instruction off, a full repayment by the borrower | The call, and a caller consistent with the record | A replay at the block nearest the record's time, with the error and its values. Marked as a replay near that time by a caller consistent with the record's shortened wallet, not the attempt itself |
| The call follows as above, and the record's shortened wallet matches no party of the position: a repayment made by someone else, which anyone may make | The call without its caller | "Not replayed: the caller is not a party of this position and is not in the record." Beside it, and headed as such, "what the position's holder would have met": a call by the holder, which is not the attempt and may differ in balance, approval and screening |
| A party's action with a free input: a part repayment, added collateral, a changed amount | The call without its input | "Not replayed: the amount is not in the record." The error's name with its catalogue meaning and remedy |
| The caller is not named by the chain: creating an offer, accepting one, a first deposit | Neither the caller nor the inputs | "Cannot be replayed from the retained record." The error's name with its catalogue meaning and remedy |

**The caller is checked, never assumed.** The record keeps the wallet only
shortened and as a keyed hash. The case file shortens each party the chain
names in the same way and compares. A match says "consistent with the
record", because a shortened wallet is not unique. It does not say "the same
wallet". The keyed hash is not used here: its key stays with the service
that writes the record. A record from a session with no wallet connected
has nothing to compare, and falls in the second row.

The error's name and selector are in every record, so the catalogue's
meaning and remedy are always available. What is missing below the first
row is the error's values and the exact state the caller was in.

A user who writes to support and states their wallet gives a candidate
caller, which is checked the same way. The inputs stay unknown.

**Default: nothing is added to that record.** The first drill (section 5)
counts how many attempts of each row could be answered from records alone.

Two ways would close the gap, and both are the owner's decision, asked only
if the drill shows the default is not enough:

- **Add the block, the error's values and the call's inputs to the record.**
  It changes what the record collects, which is written in the privacy
  policy and was assessed.
- **A replay bundle the user exports.** By their own click in the support
  drawer, the user copies the attempt (the call, its sender, the block, the
  error's values) and sends it if they choose. Nothing is collected without
  that click. It carries the full address off the device, which the support
  report's present rule does not allow, so that rule would change with it.

### 4.8 The case file

One operator command. It takes a transaction, a loan, an offer or a time
window on a network, and writes one document:

1. **What was true:** the code, the settings, the pause state, the builds
   and the keeper's switches at that block or time.
2. **What happened on chain:** the subject's events in order, each with its
   transaction.
3. **What failed:** failed transactions that name the subject or fall in the
   window, each with the explainer's output. Records in a replaced block are
   listed apart.
4. **What the keeper decided:** the decisions and pass runs covering that
   time.
5. **What the services saw:** service errors in the window.

Each section says where its content came from and how far back that record
reaches. A section with nothing to show says so, and says whether that means
"nothing happened" or "this record does not reach that far". A case file
never leaves a section out.

The command reads; it writes nothing but the document. The document is for
operators. Before any part of it is shared outside, the public data feed's
rules on addresses apply to it.

## 5. Proving it: drills

"No stone unturned" needs a test. In the test rounds before a mainnet, one
person causes an issue of each kind on a testnet, and another person, who
was not told what was done, finds the cause from the case file.

| Drill | What is caused | Question |
| --- | --- | --- |
| 1 | An attempt the app refuses before sending | 1 |
| 2 | A transaction sent directly that fails, and one sent through another contract that fails | 2 |
| 3 | A liquidation that takes its fallback route, and a standing instruction that skips | 3 |
| 4 | A keeper pass switched off while it has work | 4 |
| 5 | The indexer held behind, so the app shows an old figure | 5 |
| 6 | A setting changed, then a refusal that the old setting would not have given | 6 |

**Pass:** the cause is found within 15 minutes (**Default**), from records
alone, with no question to the person who caused it.

Drill 1 is run once for each row of the table in section 4.7. For the rows
that are not replayed, the pass is that the error's meaning and remedy
were enough to name the cause. The drill reports the count per row, and that
count is what the owner's decision in 4.7 rests on.

Every miss becomes a card. The drill list joins the launch checks and is run
again after each fresh deploy.

## 6. The incident runbook

The runbook gains one section per question. Each names the record, the
command that reads it, what a normal answer looks like and what to do when
the record does not reach far enough.

## 7. What is not built

- An event per function, or location text in errors (the companion design).
- Any new record of a user's personal data. The failed transaction record
  holds what the chain already publishes. The service error record holds no
  address of any kind. The keeper's records withhold any address that is not
  the platform's own contract or the subject's asset.
- A public page of failed transactions by wallet. These records are for
  operators.
- A dependence on an outside service for what any record holds. The alert
  presets the repository already carries stay as a second view. One outside
  source does tell the pass where to look on a network with no trace filter
  (4.3). What it misses is measured by the audit, and what is stored comes
  from the network's own node.

## 8. Tests (acceptance)

1. The explainer, given a recorded trace of a transaction that reverts three
   facets deep, prints the three functions in order and the error with its
   values and its catalogue meaning. Given a trace from before a facet
   refresh, it names the code that ran then. Given a transaction that
   follows another in its block which changed the same loan, the rebuild
   applies the earlier one first and matches the receipt. A rebuild that
   does not match the receipt is headed as an approximate replay.
2. The failed transaction pass, run over a block range holding a failed
   direct call, a failed call through another contract, a successful call
   and a failed call to an unrelated contract, records the first, records
   the second in trace-filter mode and states it as unseen in the other
   modes, and records neither of the others. Each record names the source
   that found it.
3. A replay at the parent block is marked as a replay and stores the error
   only. A replay that succeeds is recorded as not reproduced.
4. A range the pass cannot scan is recorded as a gap and reported by the
   health route.
5. The record route accepts a well-formed record, a cursor with its
   checkpoints and a replaced-range statement under the pass's token,
   and refuses every other write. A replaced-range statement deletes
   nothing.
6. A keeper pass that sees the same subject with the same outcome sixty
   times writes one history row and a count of sixty. A change of reason
   writes a second row.
7. A pass that is switched off leaves a run row that says so.
8. Every send through the shared sender has a decision row naming its pass
   and subject.
9. Settings changed twice give three answers for three blocks: before, between
   and after. Two changes of one setting in one block, with a transaction
   between them, give that transaction the first change's values, taken
   from the event. A change whose event lacks a value is marked "as at the
   end of the block", and "not known" between two such changes in a block.
10. A derived row names the event that last changed it, and that event
    exists in the event history. An informational event with no handler is
    in the event history too.
11. A request the agent refuses returns its reference, and the service error
    record holds the same reference and no address.
12. A case file for a loan with no failed transaction says that none was
    found and how far back the record reaches.
13. Each drill of section 5 passes on a testnet.
14. A scanned range is replaced on a local chain: the pass finds it at its
    next run, marks the records of the replaced blocks, scans the range
    again and records the failures of the new blocks. A single odd read of
    the checkpoint block holds the pass and marks nothing.
15. A keeper refusal whose values include a wallet is stored with its name,
    its selector and the word "withheld" in place of the wallet. A refusal
    naming the platform's own contract keeps that address.
16. A case file for a refused offer creation says that the attempt cannot
    be replayed from the retained record, and gives the error's meaning and
    remedy. One for a full repayment refused to the borrower holds a replay
    marked as near that time by a caller consistent with the record. One
    for a full repayment refused to a third wallet holds no replay of the
    attempt, and heads the holder's call as not the attempt.
17. A failed transaction recorded from a trace is explained in full from
    the record alone, with the node unreachable: the inner calls with their
    arguments and the events before the failure. One recorded from a
    parent-block replay shows the error and the list of what is not
    available.
18. In list and audit mode with a stubbed list that leaves out one failed
    direct call, the audit window that holds it finds it, records it, raises
    the alert and moves the miss rate. A failure found after the node's
    reach has passed is recorded with the receipt's facts and "state no
    longer reachable".
19. A transaction that ran before a refresh made later in the same block is
    explained with the code at the address its trace shows, not the code
    that replaced it. Settings asked for that transaction are the ones
    placed before it in the block.
20. A subject that leaves a pass's read for five runs and returns with the
    same decision has two decision rows and one "left" and one "entered"
    row, and the case file answers "not in the feed" for a time inside the
    gap, "not reached" for a subject past a cap, and "not known" for a time
    no run covered.
21. A network whose list cannot be read runs in sends and audit mode, and
    its health line states the share of the day that is watched and says
    the rest is not.

## 9. Residuals

- **A call made through another contract** is seen only where the node
  offers a trace filter. Where it does not, the record says which mode the
  network is in, and a failed call through a contract wallet or a batching
  contract is not recorded there unless the capability check found that the
  explorer's list holds such calls.
- **Sends and audit watches part of the day.** Where the list cannot be
  read, a failure by someone else outside the audit window is not recorded.
  The share watched is stated on the health route, and a paid key or a node
  with a trace filter for that network is the owner's choice.
- **List and audit depends on an outside list for where to look.** A
  failure the list leaves out is found only if the audit window holds it.
  The miss rate is published on the health route, and a rate above zero is
  the case for giving that network a node with a trace filter, which is a
  cost for the owner to decide.
- **A replay is not the trace.** It can differ from what happened inside the
  block. The record never hides which one it holds.
- **An old attempt replays only while old state is reachable.** Section 4.7
  depends on it. The capability check states how far back each network
  reaches.
- **Many refused attempts cannot be replayed at all.** The app's record
  holds no caller and no inputs (4.7). For those the answer is the error's
  name with its meaning and remedy, and the case file says so.
- **A replacement is found at the next run, not at once.** Until then a
  record in a replaced block reads as current.
- **Service logs themselves** are kept only for the short window the hosting
  plan gives. The service error record is what lasts.

## 10. Alternatives considered

1. **More events alone.** Rejected: it answers one question of six.
2. **An outside monitoring service as the record.** Rejected as the only
   record: the picture would depend on a third party's retention, and it
   sees nothing of questions 4 to 6. It stays as a second view.
3. **Trace old transactions when someone asks.** Rejected: an old trace
   needs a node that keeps old state. Decoding at the time needs none.
4. **A continuous block scan on every network without a trace filter.**
   Rejected on measurement: 190,000 to 430,000 requests and 2 to 4 GB a day
   for one test network. It stays only where it fits the bound.
5. **The explorer's list as the only source.** Rejected: nothing would say
   what it misses. It is used with the audit, which measures that.
6. **A paid node with a trace filter on every network.** The best coverage,
   and the answer where the audit shows misses. Not the default, because it
   is a running cost the measured need should justify.
7. **The app hands over the hash of a failed transaction it sent.** Not
   now: it adds to what leaves the user's device, so it would need a line
   in the privacy policy. Asked of the owner only if the audit shows need.
8. **Run the pass inside the indexer, or on the always-on machine.** The
   indexer's request limit per run is already used by its own work. The
   machine was the plan while a block scan was the fallback, and is not
   needed at these volumes.
9. **Give the pass the database token.** Rejected: that token
   reaches every database on the account. A route that accepts one kind of
   record keeps the pass to its job.
10. **A keeper log line per subject per run.** Rejected: thousands of
   identical rows a minute, and the journal is not kept for a stated time.
   Recording by change holds the same answer in one row.
11. **Add the block, the error's values and the call's inputs to the app's
   error record now, or offer a replay bundle the user exports.** Not
   recommended now: each changes what leaves the user's device before a
   drill has shown the need (4.7).
12. **Log everything from every service for good.** Rejected for cost and for
   the privacy assessment. Each record states what it holds and for how
   long.

## 11. Recommendation

Build the capability check, the catalogue, the explainer and the failed
transaction record now. Build the decision record, the four histories, the
request reference and the case file next. Run the drills in the test rounds
before a mainnet, and treat each miss as a defect of this design.

## 12. Build split

| Part | Owner area | Needs a contract change | When |
| --- | --- | --- | --- |
| Node capability check per network | Operations | No | Now |
| Error catalogue (companion design) | Shared library | No | Now |
| Transaction explainer | Shared library, operator command | No | Now |
| Failed transaction record: the pass as its own unit on the always-on machine, the route, the table, health | Operations and indexer | No | Now, after the capability check |
| Keeper decision record, pass runs, switch history | Keeper | No | Beside the batch |
| Settings, facet and build histories; every event kept; a row's last event | Indexer | No | Beside the batch |
| Request reference and service error record | App, agent, indexer | No | Beside the batch |
| Case file command | Operator tooling | No | When the records exist |
| Drills, the runbook's sections, the launch check entry | Operations | No | The test rounds before a mainnet |
