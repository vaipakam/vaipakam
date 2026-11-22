# Refactor rules: gas, events and errors, measured first and changed once

Status: **design, direction decided by the owner** (2026-11-22). Not built.
The measuring parts need no contract change and can start now. The refactor
itself waits until the current batch is pushed and one or two rounds of
testing are done. Choices the decision left open are marked **Default**.

This design has a companion,
[`TroubleshootingPictureDesign.md`](TroubleshootingPictureDesign.md), which
covers the records that are not events: failed transactions, the keeper's
decisions, the state at a block and the case file.

## 1. The problem

The refactor has three aims: spend less gas and fewer operations, emit an
event wherever an outside reader needs one, and raise errors that say why.
Today none of the three is measured.

- **Gas.** A snapshot file exists, last refreshed in November, and nothing
  checks it. No figure is held per user action. The largest known cost is
  structural: a same-call fill writes two complete offers and uses them up in
  the same call (#3851).
- **Events.** The event audit of May 2026
  ([`EventSourcingAudit.md`](EventSourcingAudit.md)) set a sound model: an
  event is either a state change or informational, every event carries a
  category tag, and a lint enforces the tag. The lint script exists and
  nothing runs it. About 280 of roughly 950 event declarations carry no tag.
  Nothing checks that a function which changes state emits anything.
- **Errors.** There are about 1,800 error declarations. Sixteen text reverts
  remain. Hundreds of errors carry no values, and several are raised from
  many places: one parameterless zero-address error from 67 places, one
  loan-not-active error from 18. A reader who sees one of them knows almost
  nothing.
- **Change cost.** Every change to an event or an error breaks the indexer,
  both apps, the keeper and the public keeper bot. Changing them a few at a
  time, across many PRs, would break those consumers many times.

## 2. The decisions

Decided by the owner on 2026-11-22:

1. **Rules and checks first, then one pass.** The rules are written, each
   becomes a check that reads the compiler's output, and the code is changed
   to meet them in one pass, with every consumer, before the audit.
2. **No event per function.** A failed transaction discards every event it
   emitted, so such a trail is empty exactly when it is needed, and it would
   add a large cost to every multi-step call. The flow of a transaction
   comes from its trace (see the companion design).
3. **No location text in errors.** A unique reason plus a generated catalogue
   gives the place without the contract size, the gas, or the staleness.

## 3. The order of work

| Stage | When | What |
| --- | --- | --- |
| **A. Measure** | Now, beside the batch | Five reports run on the current tree and change no contract (section 4). Each is committed with its baseline. |
| **B. Design the interface** | When the reports exist | One document lists every event and error that will be renamed, added, split or removed, and every stored list that becomes an event (section 8). |
| **C. One pass** | After the batch is pushed and tested | Contracts and every consumer change together, in the order of section 5.2. |
| **D. Hold** | From the end of the pass | The reports are blocking checks, and the interface is frozen (section 8.2). |

Until stage C ends, a report that gets worse is a **warning** on a pull
request and never a failure. The batch was built before these rules existed,
and a check that fails work already reviewed would only be switched off.

### 3.1 How the pass is done: a new structure, the same rules

**Decided by the owner, 2026-11-22.** He asked whether to write all the
contract code from scratch or to change the existing code facet by facet,
and confirmed the answer below the same day.

Neither as stated. The structure is designed from scratch. The rules are
carried across, not typed again.

**What is designed from scratch**, because the platform is not live and
every network gets a fresh deploy:

- the storage layout, with no retired field, no dead slot and no fallback
  kept for loans that can never exist on a fresh deploy;
- the facet map, cut by call path and no longer by which facet ran out of
  room first;
- the layering of the libraries, with one writer for each stored fact;
- the events and errors (the interface document of section 8);
- the facet registration: one manifest that the deploy script, the refresh
  scripts, the test Diamond, the selector lists and the exported interface
  are all generated from, in place of the ten hand-kept lists a new facet
  must be added to today.

**What is carried, never retyped:** every rule of behaviour. The checks an
origination runs, the settlement order, the liquidation and fallback math,
the fee splits, the sanctions screens, the deadlines. Each is moved into its
place in the new structure with its tests, and its logic changes only where
a report or the interface document says so. A library that is already the
single host of a behaviour (the interest ledger, the loan clock, the
forced-sale plan, the outflow policy) is moved whole. The existing tests and
the functional specs stay the oracle, and only the test harness changes. The existing code holds the
result of many hundreds of review findings, most of them about cases no
document lists. A rewrite from a blank page would lose them silently, and
the tests can only catch the ones they happen to cover.

**How a move is kept honest:**

1. The tree is tagged before the pass. That build is the reference.
   Section 3.2 says what "tagged" means and what is published with the tag.
2. The work goes one user action at a time, end to end, grouped in areas
   along the call paths, in this order, **Default**: the core (storage,
   access, the vault and its outflow policy, the position token);
   origination; servicing; close-outs and claims; exits; rewards and
   cross-chain; settings and reads.
3. Each area passes three gates before the next starts: its existing tests
   pass; a **differential run** drives the same scripted and fuzzed
   scenarios on the reference build and on the new one and compares
   balances, positions and claims; and report 1 shows its gas beside the
   reference figure.
4. A difference the differential run finds is decided, never absorbed: it is
   a defect in the new code, or a defect in the old code that the new code
   fixes. Every intended change of behaviour is entered in one list with its
   reason and its test, and a difference that is not on the list fails the
   run.
5. Every finding fixed so far has a test, and that whole set runs against the
   new code. A fixed finding may not reopen.
6. Steps that keep behaviour and steps that change the interface are never
   mixed in one change. A move keeps the tests passing unchanged. An
   interface change alters tests only by the mapping the interface document
   gives.

**Where the new code lives: its own directory on the main branch, as its own
build project**, **Default**. Not a long-lived branch.

- The old tree stays the deployed code and keeps taking the work still being
  pushed. The new tree is reviewed and merged area by area in ordinary small
  changes, so nothing waits on one very large merge and no branch drifts
  away from the apps, the docs and the tooling.
- It is a separate build project with its own output, so the two trees are
  never compiled as one unit. This code base already sits near the
  compiler's limits, and doubling one unit would cross them.
- The differential run lives in the new project. It deploys the reference
  Diamond from the tagged build's compiled output and the new Diamond from
  source, so the old source is not compiled a second time.
- A change that lands on the old tree after an area was moved goes on a
  **carry list** and is moved with its tests before the switch. A new
  reference tag is added after the last such change, with its own record
  (a tag is never moved, section 3.2), and the whole differential run
  passes against it before the switch.
- **The switch is one change:** the exported interface, the deploy scripts
  and every consumer (the indexer, both apps, the keeper, the public bot)
  move to the new tree together, so the interface changes for them once.
  The old tree is deleted in the change that follows, and the tag keeps it.

### 3.2 What "tagged" means: the baseline

Owner decision, 2026-11-22. "Tagged", in this design and in every card that
cites it, means all of the following, done together. Names marked
**Default** are this design's choice.

**The tag.** `v0.9-pre-refactor` names one commit on the main branch. It is
annotated and signed. A repository rule on the series' tag pattern refuses
every update and every deletion, for every role and with no bypass list, so
the name can never come to mean another commit. Setting that rule is the
owner's step, and so is the go-ahead for each tag in the series. The two
older tags in the repository are outside the series and stay as they are.

**No long-lived branch of the old code.** The tag keeps it. If the old code
ever needs a fix after the switch, a branch is cut from the tag at that
moment, for that fix.

**The baseline record.** One generated file, `contracts/baseline/<tag>.json`
(**Default**), committed in the commit the tag names. That commit changes
nothing else. The record holds:

- for every deployable contract, the hash of its runtime code, its size in
  bytes, and the hash of its interface (functions, events and errors). For
  a contract whose runtime code carries values fixed at construction, the
  hash is taken with those values blanked, and the record lists each such
  value by name, so that a deployed copy can be compared with it on any
  chain ([`CanonicalSpecDesign.md`](CanonicalSpecDesign.md), section 21.5);
- the storage layout, as the hash of the layout guard's recorded file;
- the gas figures of report 1 for every measured action;
- the full regression's manifest: its plan digest, its chunks, and the
  count of tests run and passed, in the form the shard verifier accepts;
- the exact versions: the compiler and its settings, the build tool, and
  the pinned commit of every vendored library;
- the digest of the source tree it was built from, taken with the baseline
  records themselves left out.

A file cannot name the commit that contains it, and it cannot carry a hash
of a tree that contains it either. So the record's digest covers every
tracked file of the tagged commit except those under `contracts/baseline/`,
by one written rule: the sorted list of each such file's path and content
hash, hashed once. The record names that digest, the tag's message carries
the record's hash, and the tag names the commit. Each binds the other two,
and the record is bound to the commit through the tag and never through
itself.

**The baseline check** rebuilds the tagged commit with the recorded versions
and refuses when a runtime code hash, a size or an interface hash differs
from the record, or when the tag's message does not match the record's
hash, or when the digest it computes from the tagged commit by the same
rule, baseline records left out, differs from the one the record names. Anyone with the repository can reproduce the reference, and no stored
copy of a build has to be trusted.

**Who reads the record.**

- The differential run of section 3.1 takes its reference from a build of
  the tag (that build's compiled output, never a second compile inside the
  new project) and runs the baseline check on it before it starts.
- Report 1 shows each area's gas beside the record's figure.
- A statement of what the pass saved or changed cites the record. Old code
  measured again on a later toolchain is not the baseline.

**The same point in every place.**

- The public keeper bot's repository gets a tag of the same name, on the
  commit whose interface files were synced from the tagged commit.
- The private review copy is refreshed to exactly the tagged commit, so the
  review coverage ledger's hashes and the record describe one tree.
- The testnet fresh deploy that precedes the pass is made from exactly the
  tagged commit, and each chain's deployment record names the tag.

**The series.** Every later reference point is a tag of the same kind, with
its own record, under the same rule. The names are **Default**.

| Tag | Cut when | Read by |
| --- | --- | --- |
| `v0.9-pre-refactor` | Before the pass, after the batch is pushed and tested | The differential run and report 1 |
| `v0.9-pre-refactor.N` | Only when a carried change lands on the old tree after the first tag | The differential run, in place of the tag before it |
| `v1.0-audit-freeze` | At the end of the pass, with the interface frozen | The auditors, and the review coverage report |
| `v1.0-audit-fix.N` | After each round of audit fixes | The auditors' re-check of that round |
| `v1.0-mainnet.N` | At each mainnet deploy and each later change of deployed code | The launch check |

The launch check's comparison of deployed code with reviewed code
([`CanonicalSpecDesign.md`](CanonicalSpecDesign.md), section 21.5) names a
tag of this series: the hashes it compares with each deployed address are
the ones in that tag's record.

## 4. The five reports

Each report is a script that reads the compiler's output, the same way the
permissionless-steps check and the storage-layout guard do. Each has a
committed result file, a short ledger of listed exceptions with a reason for
each, and a test with fixtures. None reads source text.

| # | Report | What it lists | Becomes |
| --- | --- | --- | --- |
| 1 | **Gas and operations per user action** | For each action of section 5.1: gas, storage slots written and read, calls between facets, events emitted | The gas budgets (rule 1) |
| 2 | **Silent functions** | Every external or public function that can change state and whose code, followed through the internal calls and the self-calls it makes, contains no emit | The emit check (rule 2) |
| 3 | **Swallowed failures** | Every `catch` clause, and every branch taken when a low-level call reports failure, that neither reverts nor emits | The fallback check (rule 2) |
| 4 | **Ambiguous errors** | Every pair of an entry function and a parameterless error where that function's code can raise the error from more than one place; every text revert; every error with no entry in the catalogue | The error check (rule 3) |
| 5 | **Write-only storage** | Every stored field that contract code writes and that only view functions read | A candidate list for rule 1, judged by hand |

Reports 2, 3 and 4 use a bounded test on purpose: "does the code reachable
from this function contain an emit", never "does every path emit". The
second question has no end, and a check that tries to answer it ends up
approving things it cannot see. What the bounded test cannot prove is
covered by the rule itself, by review and by tests.

The existing event-category lint is wired in with these, as a sixth check
that already has its rules: every event carries a valid category tag.

## 5. Rule 1. Gas and operations: roots before details

On this chain family gas is the count of operations, so one measure serves
both aims. Report 1 still counts storage writes, storage reads and facet
calls beside the gas, because those are the three things a change can
actually remove.

### 5.1 What is measured

A gas suite drives each user action end to end on the full Diamond, as a
user's transaction would: cold, one action per transaction. The suite runs
with each top-level call isolated as its own transaction, so cold storage
access and refunds are counted the way a network counts them. A test that
calls an action inside a longer test body measures warm storage and reads
low.

The first set of actions, **Default**, extended by the builder where a user
action is missing:

- post an offer, change it, cancel it;
- accept an offer and open a loan, for an ERC-20 loan and for a rental;
- match two offers;
- an instant-market borrow with one, two, four and eight sources;
- a keeper's match of an Auto-lend slot;
- set, fund and cancel an Auto-lend slot;
- repay in full, repay in part, pay a rental day;
- add collateral, withdraw surplus collateral;
- the lender's claim and the borrower's claim;
- a Health-Factor liquidation, a time-based default, the fallback entry;
- an early close, a refinance, a loan sale by each route;
- a deposit into a vault and a withdrawal from it;
- one run of each standing instruction.

Each action has a **budget** in a committed file. The check fails when the
measured figure is above the budget. A budget is raised only by a commit
that states the reason in the same file, so a rise is always a reviewed
decision and never drift. When the measured figure falls well below the
budget, the check asks for the budget to be lowered, so headroom does not
quietly become the new allowance.

For an action that grows with a count (the sources of an instant borrow),
the budget also states the largest count that fits inside 80% of the
smallest per-transaction limit among the supported networks. This is the
figure #3851 asks to be restated.

A budget is a ceiling, not an exact match. The old snapshot failed on any
change in either direction, which is why it stopped being checked.

### 5.2 The order of the work

1. **Records written and used up in the same call** (#3851). It is first
   because the rest of the gas work is measured against its shape.
2. **Storage kept only for readers outside the contracts.** Report 5 gives
   the candidates. Each one is kept on chain only if contract code reads it,
   or if a party needs it to act without any index: a keeper finding work,
   or the position token's own metadata. Every other candidate becomes an
   event, which costs roughly a tenth of a stored word. A list the public
   keeper bot reads today is moved only together with the bot's own way to
   rebuild it from events, and the interface document states that for each
   such list.
3. **Calls between facets.** Each call through the Diamond costs a lookup and
   a fresh call frame. The facet layout is cut by call path, so what runs
   together lives together.
4. **Packing** of what is stored together.
5. **Small gas work**, last, and only where report 1 points.

### 5.3 Room in every facet

A facet with a few dozen bytes left cannot take a better error or one more
event, so the rules of this design cannot be met inside it. After the pass
every facet keeps at least 1,024 bytes of room below the size limit
(**Default**), checked by the deploy-sanity suite, with any exception listed
and explained. Where a facet cannot meet it, it is split along a seam, as
before.

## 6. Rule 2. Events: one fact, one event, at its one writer

The model, the two categories, the tag and the closed list of categories of
the May 2026 audit all stand. So does its rule against repeating what the
log already carries: no block time, no sender, no value that can be computed
from the others. This rule adds five things.

**1. Every change an outside reader needs to rebuild state emits exactly
once, from the place that writes it.** Where one library is the only writer
of a field, the emit sits in that library beside the write, so no route can
change the field without the event. Two emit sites for the same change are a
defect.

**2. Every skip and every fallback emits its reason.** Nothing fails on
those paths, so nobody opens a trace, and the event is the only record. This
covers:

- a permissionless step that decides not to act;
- a route that fails and is replaced by the next one;
- a payment that cannot be delivered and is held or parked for its owner;
- any failure the code catches and continues past.

**The reason is the error itself.** A skip or fallback event carries the
custom error that explains it, encoded exactly as it would have been raised.
The verdict reads already return refusals this way. One vocabulary then
covers a refusal whether it reverted, was previewed, or was skipped past,
and the one catalogue (section 7.4) explains all three. A separate list of
reason codes would be a second vocabulary to keep in step.

Two categories are added to the closed list for these, **Default** names:
`informational/skipped` and `informational/fallback`.

**3. Storage that only outside readers need becomes an event** (rule 1,
step 2).

**4. A change of a setting carries its new value in full.** The event of a
settings change holds every value the change wrote, so the settings in force
before any transaction can be rebuilt from the events in order. Reading the
settings back at the block of the change gives only the block's last values,
which is wrong for a transaction between two changes in one block. The
interface document (section 8.1) lists each settings event with the values
it carries, and the pass adds what is missing.

**5. The checks.** Report 2 refuses a state-changing function whose
reachable code contains no emit, unless the function is listed with its
reason. Report 3 refuses a caught failure that neither reverts nor emits,
unless listed. The category lint refuses an untagged event.

What a consumer may rely on after the pass: for every row an indexer keeps,
the events that made it are enough to rebuild it, and every row records the
event that last changed it (the companion design, question 3).

## 7. Rule 3. Errors: why, with the values

### 7.1 What an error carries

An error names the reason and carries the values that explain it: which
loan, which asset, what was needed and what was found. A value is something
the caller or an operator can act on. A code that only identifies a line of
code is location text under another name and is not added.

### 7.2 The same error from many places

The function that failed is always known, from the call or from the trace.
What is not known is which check inside it failed. So the rule is stated per
entry function:

**Within the code one entry function can reach, a parameterless error is
raised from one place only.** Where report 4 finds more, the error gains
values that tell the cases apart, or it is split into errors named for what
is wrong. A status error carries the loan and the status found. A
zero-address error says which argument.

### 7.3 Passing an error on

An error passes through a call between facets unchanged. The remaining
wrapper that replaces a missing reason with a text label is retired: where a
call returns no reason at all, the caller raises one typed error carrying
the selector that was called. The sixteen text reverts become custom errors.

### 7.4 The catalogue

One generated file lists every error of every contract the platform ships:

- its name, its selector and its values, from the compiled interface;
- every entry function whose code can raise it, from the compiler's output;
- its plain meaning, who can act on it (the user, an operator, nobody) and
  what they can do. This part is written by hand in one source file.

The apps, the keeper, the indexer, the transaction explainer and support all
read this one catalogue. The hand-kept table of friendly messages in the
shared library moves into it, and the apps keep only their translations. The
check refuses an error with no entry. Until the pass ends, the number of
errors without an entry may not rise.

An error that means "this should be impossible" is marked as internal. Its
catalogue entry says so and asks for a report, and the apps show it as a
fault of the platform, never as something the user did.

## 8. Rule 4. Events and errors change once

### 8.1 The interface document

Stage B produces one document from the reports: every event and every error
that changes, with its old and new shape, and every stored list that becomes
an event. Each line names the consumers it touches. The pass implements that
document and nothing else. A change found necessary during the pass is added
to the document first.

The pass changes the contracts, the indexer, both apps, the keeper and the
public keeper bot together. The platform is not live and every network gets
a fresh deploy, so no old shape is kept beside a new one.

### 8.2 The freeze

When the pass ends, the list of event and error signatures is recorded in a
committed file, the same way the storage layout is. From then on a change
that removes or alters a signature is refused unless it is acknowledged in
the same commit with its reason and its consumers. Adding a new event or
error stays free. Auditors read the frozen interface, and what they read is
what ships.

## 9. Tests (acceptance)

1. Each report has fixtures: a contract that must be listed and one that
   must not, for every rule the report applies. A report that lists nothing
   on a fixture built to be listed fails its own test.
2. The gas suite measures every action of section 5.1 in isolation and
   writes storage writes, storage reads, facet calls and events beside the
   gas. Running an action twice in one test body is shown to read lower than
   the isolated figure, which is why isolation is required.
3. A budget raised without a reason in the budget file is refused. A
   measured figure above its budget fails.
4. A new state-changing function with no emit fails report 2 until it emits
   or is listed. A new `catch` that neither reverts nor emits fails report 3.
5. After the pass: no text revert in the contracts, no parameterless error
   raised from two places inside one entry function, no error without a
   catalogue entry, no untagged event, and no facet under the room floor
   without a listed reason.
6. A skip or fallback event's reason decodes through the catalogue to the
   same meaning the raised error has.
7. For each refusal the catalogue lists under an entry function, a test
   raises it from that function, or the entry is marked as reachable only
   through a named inner step.
8. After the freeze, removing an error or changing an event's values is
   refused without an acknowledgement, and adding one is not.
9. The indexer, both apps, the keeper and the public bot build and pass
   their suites against the changed interface in the same pass.
10. For each area moved, the differential run against the tagged reference
    build shows the same balances, positions and claims for every scripted
    and fuzzed scenario. A difference that is not on the list of intended
    changes fails the run.
11. Every test that guards a fixed finding passes against the new code.
12. Adding a facet needs one line in the manifest, and the deploy script, the
    refresh scripts, the test Diamond and the exported interface all carry
    it with no second edit.
13. The baseline check passes on a clean build of the tagged commit. It
    refuses a record with one altered hash, a build made with another
    compiler version (naming the version), a record whose source-tree digest
    is not the tagged commit's by the written rule (baseline records left
    out), and a tag whose message does not carry the record's hash. A
    record committed in the tagged commit itself passes.
14. The differential run refuses to start when its reference build fails
    the baseline check.
15. The launch check reads the repository's rules and refuses when the
    series' tag pattern is not protected against update and deletion, or
    when a role may bypass the rule.
16. A deploy is refused when the commit it runs from is not the one a tag
    of the series names, and the chain's deployment record states the tag.

## 10. Residuals

- **The bounded checks prove presence, not completeness.** A function that
  emits on one path and stays silent on another passes report 2. The rule
  still applies to it, and review and tests hold that part.
- **Budgets measure the suite's scenarios.** A user action with unusual
  inputs can cost more. The scenarios state their inputs, and a growing
  action states its largest safe count.
- **More values in errors cost contract size.** Rule 1's room floor is what
  pays for it. Where a facet has no room, the split comes first.
- **Moving a stored list to events moves work to readers.** A reader with no
  index must scan events. Each such move is decided in the interface
  document with its gas figure beside it.

## 11. Alternatives considered

1. **An event per function or per operation.** Rejected by the owner's
   decision, for the two reasons in section 2.
2. **A location code in every error.** Rejected: it costs size and gas on
   every raise and goes stale with the next edit. A unique reason per entry
   function plus the catalogue gives the same answer for nothing.
3. **Gas work only.** Rejected: this pass is the one cheap moment to change
   the interface, before the audit and before any live network.
4. **Change events and errors as each area is touched.** Rejected: every
   consumer breaks once per change, and auditors would read a moving target.
5. **Exact-match gas snapshots.** Rejected: they fail on every change in
   either direction and were switched off for that reason. A ceiling with a
   reviewed raise is held.
6. **Checks that prove every path emits.** Rejected: an unbounded question.
   A check that guesses is worse than a bounded one that says what it does
   not cover.
7. **A separate list of reason codes for skips and fallbacks.** Rejected: a
   second vocabulary beside the errors, with its own drift.
8. **Blocking checks from the first day.** Rejected: they would fail the
   batch already built. They warn until the pass ends and block after.
9. **Write all the contract code again from a blank page.** Not
   recommended: the code holds the outcome of many hundreds of review
   findings that no document lists, a rewrite loses them without a sign, and
   every line would need its review and its soak again before the audit.
10. **Change the existing code in place, facet by facet.** Not recommended:
    it keeps the structure the size limit forced, cannot remove the calls
    between facets or the dead storage, breaks the consumers once per facet,
    and has no point at which it is finished.
11. **Build the new tree on one long-lived branch.** Not recommended: work
    is still landing on the old tree, a branch drifts from the apps, the
    docs and the tooling for as long as it lives, and it ends in one merge
    too large to review. A directory beside the old tree is reviewed in
    small changes and switched in one.

12. **A long-lived branch of the old code beside the tag.** Rejected: a
    branch moves, invites work that nothing reviews, and makes two places
    where the old code might be. A tag cannot move, and a branch can be cut
    from it on the day one is needed.
13. **A tag with no record.** Rejected: a tag names source, and the
    differential run and the gas claim compare builds. A later toolchain
    builds different code from the same source, and nobody could then say
    whether a difference came from the toolchain or from the pass.
14. **Keep the compiled output itself as the baseline.** Not recommended as
    the source of truth: it is a large binary whose origin has to be taken
    on trust. The record's hashes and a rebuild verify any copy. A cached
    build may be kept for speed if it passes the baseline check before use.
15. **A plain tag held by convention.** Rejected: a tag that can be moved
    or deleted is a name, and the day it matters is the day someone needs
    it to have stayed where it was.

## 12. Recommendation

Build the five reports and the catalogue's generator now, beside the batch.
Write the interface document from their output. Run the pass once, as
section 3.1 describes: a structure designed from scratch, the rules carried
across area by area under the differential run, with every consumer. Freeze
the interface at its end.

## 13. Build split

| Part | Needs a contract change | When |
| --- | --- | --- |
| Reports 2, 3, 4 and 5, the category lint wired in, their ledgers and tests | No | Now |
| Report 1: the gas suite, the budgets file and its check | No | Now |
| The catalogue generator, its hand-written source and its consumers' read | No | Now |
| The interface document | No | When the reports exist |
| The baseline record's generator and check, the tag-series rule, and the launch check's read of both (section 3.2) | No | Before the tag |
| The tag `v0.9-pre-refactor` with its record, in both repositories | No | After the batch is pushed and tested, on the owner's go-ahead |
| The pass: #3851, stored lists to events, facet layout, packing, events, errors | Yes | After the batch and its testing |
| The freeze | No | At the end of the pass |
