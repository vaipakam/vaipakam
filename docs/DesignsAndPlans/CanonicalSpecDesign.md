# The canonical specification, the code check against it, and the tests it owes

Status: **design, direction approved by the owner** (2026-11-22). Not
built. The vault domain is the pilot. Choices the approval left open are
marked **Default**.

Companions: [`ReviewCoveragePassDesign.md`](ReviewCoveragePassDesign.md),
whose section 3.5 says what a review does with the specification, and
[`RefactorRulesDesign.md`](RefactorRulesDesign.md), whose differential run
uses the paths this design generates.

## 1. The problem

The platform has a specification, `docs/FunctionalSpecs/`, and it cannot do
the job the owner now asks of it.

- **It cannot be checked for conflicts.** It is eight files and about 2.1 MB
  of prose. The main file is 855 KB, with lines up to 12,500 characters. A
  rule is stated wherever the change that made it happened to be written
  up, so the same rule appears in several places, in different words, and
  nothing can tell whether two of them disagree.
- **It carries history.** Much of it reads as what changed and when. A
  reader must work out what is true now.
- **A test cannot name the rule it checks.** There are about 6,900 contract
  tests in 308 files. Three of those files mention the specification.
  Nothing says which rules have a test and which have none, and the nine
  hand-written test-scope documents under `docs/TestScopes/` describe a
  platform several months older than the code.
- **Nobody has asked, rule by rule, whether it is still the right rule.**
  The specification grew by addition. The owner asked that every point be
  reconsidered for what is better for users and the platform, and for what
  security still needs.

The owner asked for three things on 2026-11-22: one canonical functional
document with no code in it and no conflicts, usable for testing; a check
that the code holds what it says, made during the review of every line; and
test sets for every kind of test, on every path, with nothing left
uncovered, because the platform moves funds.

## 2. The shape of the answer

Four things, each generated from or checked against the one before it.

1. **The specification:** a folder of numbered statements, one file for
   each domain, written from the owner's decisions and never from the code.
2. **The models:** for each thing that has a life (a loan, an offer, a
   vault), a table of its states and steps, each row citing the statements
   that guard it.
3. **The catalogue:** generated from 1 and 2, the list of every test the
   platform owes, of every kind.
4. **The checks:** the tests carry statement ids, so a gap report says what
   is owed and not yet tested; the review's trace table says where the code
   holds each statement; and four numbers gate the audit tag and a mainnet.

## 3. The folder

`docs/CanonicalSpec/`, **Default** name.

| Path | Holds |
| --- | --- |
| `README.md` | The rules of the folder and the index of domains, with each section's status |
| `<domain>.md` | The statements of one domain, in sections, and its lifecycle models |
| `parameters.md` | Every figure of the platform, once |
| `glossary.md` | Every term of the specification, once, in plain words |
| `examples/<domain>/` | Worked examples: inputs, steps and every balance after each step |
| `catalogue/<domain>.md` | **Generated.** The tests the domain owes |
| `mistakes/<domain>.md` | The mistakes an honest party can make, each with the statement that answers it (section 8.2) |
| `record/<domain>.md` | For each statement: its sources, its mark, and the owner's approval. The retired ids |
| `wording.json` | The product's own words, in clear, and the refused words and names, as salted hashes only (section 15) |

**The Markdown file is the source, and it is also the page a person
reads.** A statement is a block of a fixed shape that a tool parses. The
high-level design proposed one structured record for each statement with
the readable pages generated from it. Scouted against how this repository
is read, the single file is better: the owner approves statements by
reading them, the review quotes them into pull requests, and a generated
page would be a second copy that could be stale on the day it is approved.
The fixed shape gives the tools everything a record would. Alternatives 1
and 2 of section 17.

**No line is longer than 100 characters, and a sentence starts on a new
line.** A change to one sentence then shows as one changed line.

### 3.1 A statement

```
### VLT-014 · refusal

**Who:** the vault's owner.
**When:** a withdrawal asks for more than the balance that no lien covers.

The withdrawal is refused, and nothing moves.

- **Refused as:** more than the free balance.
- **Tests owed:** the defaults for a refusal.
```

| Part | Rule |
| --- | --- |
| The id | A domain code and a number. Permanent. Never reused, never renumbered, and it survives a move to another section. A statement that is dropped has its id retired in the record |
| The kind | One of seven: **rule**, **refusal**, **fund movement**, **authority**, **setting**, **never**, **always possible** |
| Who | The party that acts, in the glossary's words. "Anyone" is a party |
| When | The state of the thing and the condition, in words the lifecycle model uses |
| The body | What happens, as an outside party could observe it. One outcome. Present tense. At most eight lines |
| A fund movement adds | **From**, **to**, **comes to rest in** (a kind of account from the glossary's list), **amount** (in terms of parameters and stated quantities) and **rounding** (which way, and in whose favour) |
| A refusal adds | **Refused as:** the reason in plain words. Not an error name |
| An authority adds | **Held by** and **changed by** |
| A setting adds | The parameter's id. Its bounds, its delay and who may change it are in the parameters table |
| A never adds | **Against:** the id of the threat it answers (section 8.1), and **Watch:** what in the chain's own data would show a breach, or the reason nothing would (section 21.6) |
| An always possible adds | **From:** the states it holds in, **by:** the step or steps that reach the outcome it promises, and **except under:** each condition that delays or stops it, with the statement that says for how long, or "nothing". It states what a party can always do (repay, withdraw a free balance, collect a claim), where a never states what can never happen. A promise with a limit it does not name fails its own tests |
| A statement that answers a mistake adds | **For the mistake:** its id and which of the four answers this is (section 8.2). A warn-only answer adds its reason |
| Tests owed | The defaults for the kind (section 10.1), or the defaults with a stated addition |

**No code.** No function, contract, error, event or file name appears in a
statement. A refusal is named by its reason. The link from that reason to
the error the code raises is made in the other direction: the error
catalogue of `packages/contracts/errors/` names the statement an error
serves, and the review's trace table records it. So the person who drafts a
statement needs to know nothing about the code, and a renamed error changes
no statement.

**No history.** No date, no issue number, no "previously", no "since", no
"now". Where a statement came from is kept in the record file (section
3.4), which the tools read and a reader of the specification never has to.

**No figure.** A statement names a parameter, as "the minimum health
factor [PRM-012]", and the figure is in the parameters table. One and zero
are allowed. So a figure changes in one place.

### 3.2 The parameters table

`parameters.md` is one table: the id, the name, the value, the unit, the
bounds a change must stay inside, who may change it, the delay on a change,
and the statements that use it. A parameter that no statement uses, and a
statement that names a parameter the table lacks, both fail the folder
check. A value that differs between a testnet and a mainnet is two columns,
never two rows.

### 3.3 A lifecycle model

Each thing with a life has a model in its domain's file: a list of its
states, each defined in a sentence, with the starting state and the end
states marked, and one table.

| From | Step | Who | Guarded by | To |
| --- | --- | --- | --- | --- |
| Open | Withdraw | The owner | VLT-010, VLT-014 | Open |

Three more tables complete it.

- **Refusals out of state.** For each step, the statement that refuses it
  from a state the table does not allow it in. A step with no such
  statement fails the check, because a path would have no expected outcome.
- **Dimensions.** Each way two instances of the thing can differ that a
  statement makes matter: the kind of asset, whether it has a price, which
  side made the offer, whether the holder is the first holder, and so on.
  Each dimension lists its values and the statements that name it.
- **Accounts.** The kinds of account a balance of this thing can rest in.
  A fund movement may come to rest only in a kind on this list.

**Conditions of the platform are dimensions of every step that moves
funds.** They are defined once, in the platform domain, and every model
inherits them: the platform is paused, the asset is paused, a party to
the step is flagged, the sanctions screen cannot be read, the caller has
not accepted the current Terms, a price is missing or not vouched for, the
network's sequencer was down. The platform domain's own list is the one
that counts, and this sentence follows it. For each condition a step
that moves funds has a stated outcome, by a statement of its own or by the
platform statement that covers it. A fund-moving step with no outcome
under a condition fails the check.

**Things nobody does are steps too.** Time passes. A price moves. A part
outside the platform fails: a token that takes a fee or refuses a
transfer, a swap route, a message between networks. Each is a row of the
step table with "nobody" as the party, so the generator walks a loan past
its due date, or through a price fall, as it walks it through a repayment.

The model is deterministic: for one state, one step and one party there is
one row, or several rows whose guarding statements state conditions that
cannot hold together. The check refuses two rows it cannot tell apart.

The models, **Default** list: an offer, a loan, a rental, the lender's
position, the borrower's position, a vault, an Auto-lend slot, a claim, a
fallback custody episode, a reward day, a cross-chain message, a change of
a setting.

### 3.4 The record

`record/<domain>.md` holds what the specification itself may not: for each
statement its **sources** (an owner decision by date, an approved design by
section, a line of the old specification, a release note), its **mark**
(section 6), and the date of the owner's approval. It also lists retired
ids with the approval that retired them.

**A source that is a file names the commit it was read at,** with the
file and the heading. The old specification and the designs keep changing
while the folder is drafted, so a bare file name would point at different
words a month later, and the conflict read could not check a kept
statement against what the drafter read.

**A statement with no document source does not enter the folder.** This is
the independence rule made mechanical. "The code does this" is not a
source, so nothing the code happens to do can be written in by any drafter,
whatever they have read. A statement with no source is a **new** statement
and reaches the owner as a question (section 6).

**A new statement is carried in a draft by what raised it.** A threat, a
mistake or a gap in a model can show a rule no document states, and that
rule has to pass the folder check before the owner sees it (section 7,
steps 2 and 5). So the record entry of a new statement carries the mark
**new** and, in place of a source, what raised it: the id of the threat or
the mistake, the model row that had no statement, or the conflict read's
finding. The check accepts that form in a draft and in no other place.
When the owner approves the statement, his approval, by date, becomes its
source, and only then may it enter the folder. "The code does this" is not
something that can raise a statement either: the forms above are the whole
list.

### 3.5 Domains and codes

**Default** list. A domain is a part of what the platform does, not a part
of the code, so a review unit may be governed by statements of several
domains, and the trace table says which.

| Code | Domain |
| --- | --- |
| PLT | The platform's rules: the few that bind every domain, and the conditions of the platform |
| VLT | Vaults: custody, liens, what may leave a vault, the Ready balance, protection, recovery |
| AUT | Authority, settings and pause: roles, delays, the guardian, every pause, the bounds of every setting, who may upgrade what |
| SCR | Screening and Terms |
| PRC | Prices, liquidity and risk figures |
| OFR | Offers and the book |
| OPN | Opening a loan |
| LON | The life of a loan: time, interest, repayment, collateral changes, standing instructions |
| FCL | Close-outs by force: liquidation, default, forced sale, fallback custody |
| CLM | Claims |
| EXT | Exits by choice, by either side, and refinance |
| POS | Position tokens |
| RNT | Rentals |
| MKT | Auto-lend and the instant market |
| FEE | Fees and the treasury |
| VPF | The VPFI token, tiers and discounts |
| RWD | Rewards |
| XCH | Cross-chain |
| KPR | Keeper authority and the steps anyone may take |
| DPL | Deploy, upgrade and launch |
| IDX | The indexer and the public data feed |
| KOP | Keeper operations |
| APP | The connected app |
| WEB | The website |
| NTF | Notifications |

A domain file that passes 200 statements is split, and the ids keep their
codes.

**A rule that touches two domains has one home.**

1. A rule that binds every domain lives in PLT, and a rule that binds
   every entry of a kind, whatever it does (every step that opens a
   position screens its caller), lives in AUT or SCR. These are the
   **platform statements**, and each is also a row of the review's rules
   file once it is approved.
2. A rule about one thing's state lives with that thing's lifecycle model.
3. A fund movement between two things lives with the step that causes it.

Every other domain cites the statement by id and never states it again.
The check refuses a cross-domain reference made in any other way, with one
form for a domain that is not drafted yet.

**A reference to a domain not yet drafted is written as owed.** The early
domains depend on later ones: the vault's rules name the deploy domain
before it exists. Such a reference is written as the domain's code, the
word "owed" and a short phrase for the rule, as in "(DPL owed: where the
treasury is)". The record of the citing domain lists each one, and the
record of the named domain lists it as owed once that domain has a record.
The check accepts the form while the named domain is not complete (section
4). It refuses an owed reference that the citing domain's record does not
list, and one whose named domain is complete. When the owed statement is
approved, the reference is rewritten to its id in the same change.

**The platform domain is drafted and approved first,** because every
other draft is read against it. It restates the owner's standing product
rules as statements, each marked kept with its decision as the source:

- Everything owed to a party is paid to the vault of whoever holds the
  position. Only the owner's own withdrawal reaches a wallet. Those who
  are not parties are paid at their wallets.
- Funds are never mixed: an idle balance stays in its owner's vault, one
  loan has one lender, and no interest is shared.
- The platform states facts and does not steer a choice: no surface ranks,
  recommends or pre-fills a counterparty.
- The same fees apply to every kind of loan.
- The conditions of the platform listed in section 3.3, each with its
  default outcome.

The conflict read (section 7) checks every statement of every draft
against these. A statement that contradicts one is not a question of
wording: it is a proposed change to a standing rule, and reaches the owner
as that. **Default:** the list above is the starting set, and a rule joins
it only by the owner's decision.

### 3.6 Statements held outside the public folder

A few statements cannot be published while publishing them would itself
do harm, as a never whose threat is still open cannot. Such a statement is
**held**. It is part of the specification in every other way.

- It has a permanent id in the held range of its domain, 900 to 999, and
  the marker "held" beside its kind.
- It is written in the same block, with the same parts, and is kept with
  the private records (section 8.1) in one file for each domain.
- The owner decides that a statement is held, and decides when it stops
  being held. It then enters the folder under the same id.
- **The tools read both places.** The code check traces code to a held
  statement as to any other, so that code is never reported as "spec
  silent". The catalogue lists what a held statement owes, in the private
  records, and its tests carry its id. The four numbers of section 14
  count held statements. The folder check treats the held range as
  reserved and reports none of its ids as missing or unknown.
- Why a statement is held is written in the private records and nowhere
  in the repository.

**Default:** nothing is held unless the owner says so, and the count of
held statements for each domain is published with the four numbers, so a
reader knows the public folder is not the whole of it.

## 4. The folder check

One command, run by CI on every change to the folder. It refuses:

1. A duplicate id, a reused retired id, or an id that changed its number.
2. A statement that lacks a part its kind requires, including a fund
   movement with no rounding and a never with no threat id.
3. A word of history, an issue reference or a date in a statement.
4. A figure other than one or zero outside `parameters.md` and `examples/`.
5. A name of code: anything in code type, or a word shaped like an
   identifier.
6. A term that is not in the glossary where the glossary lists a term for
   it, and any word on the domain's list in `wording.json`.
7. A lifecycle row that cites no statement, a step with no refusal out of
   state, two rows it cannot tell apart, a state no row reaches, and an end
   state no route reaches.
8. A fund movement that comes to rest in a kind of account the model does
   not list.
9. A cross-domain reference made neither by id nor in the owed form of
   section 3.5, a reference to an id that does not exist or is retired,
   and an owed reference to a domain that is complete.
10. A statement with no entry in the record, and an entry with no source.
    In a draft, an entry marked new may name what raised it in place of a
    source (section 3.4). In the folder, no entry may: every statement
    there has a document source or the owner's approval by date. Also a
    statement in an approved section whose text differs from the text the
    owner approved without a new approval in the record.
11. A parameter no statement uses, and a parameter id the table lacks.
12. A line over 100 characters.
13. Anything under a statement heading that it cannot read as a statement
    block, and a heading shaped like a statement's that is not one. **The
    parser fails closed:** a block it cannot read stops the check with the
    file and the line. It is never skipped, because a skipped statement
    would owe no tests and nobody would see it missing.

**The check has two modes.** The **draft** mode runs on a section before
the owner has seen it, and the **folder** mode on everything under
`docs/CanonicalSpec/`. They differ in item 10 only. Every other item is
the same in both, so a draft that passes needs no rework to enter.

**Closing a domain** is a second set of checks, run when the last section
of a domain becomes canonical. A domain is **complete** when all of these
hold, and not before:

1. Every section of the approved outline (section 6) is canonical.
2. Every row of every model cites a statement of a canonical section, and
   every step has its refusal out of state.
3. Every fund-moving step has an outcome under every condition of the
   platform.
4. Every reference to another domain resolves, or names a domain not yet
   drafted and is listed as owed by that domain.
5. Every threat and every mistake on the domain's lists has its answer.
6. No statement of the domain is on a question list that is still open.
7. No item of the feature ledger (section 23) that is assigned to the
   domain is without an outcome.

**What a machine cannot find, people read for.** Two statements in
different words that contradict each other pass every check above. Three
things narrow that.

- The check prints a **neighbours report**: every set of statements that
  share a thing and a step, side by side, so the reader of conflicts reads
  what could conflict and not the whole folder.
- The **reference model** of section 9 is written from the statements. Two
  statements that move the same funds differently cannot both be
  implemented, and its balances stop adding up.
- A **cross-domain conflict read** of every draft by a thread that did not
  write it, before the draft reaches the owner.

## 5. Where a statement comes from

The owner's decisions. The approved designs under `docs/DesignsAndPlans/`.
The present `docs/FunctionalSpecs/`, with the corrections already listed
for the owner applied. The release notes, to settle which of two documents
is later. **Never the code.**

The thread that drafts a domain does not open that domain's code while it
drafts. Section 3.4 makes the rule hold even where that discipline fails.

## 6. Every point is reconsidered

The owner asked that the present specification be the guide and not the
answer. So each statement in a draft carries one of four marks in the
record.

| Mark | Means | Goes to the owner |
| --- | --- | --- |
| **Kept** | The present rule, restated | No |
| **Changed** | A different rule is proposed | Yes, with the present rule, the proposed one and the reason |
| **Dropped** | The present rule is proposed for removal | Yes |
| **New** | Nothing in the documents states it: a gap a model or a threat showed, or two documents that disagree | Yes |

**The test for "better".** A change is proposed only when it does at least
one of these and costs none of the others: a party's funds are safer, a
party is told something true that they were not told, a step a party must
take is removed, a rule that two documents state differently becomes one,
or a rule that cannot be tested becomes one that can.

**The scope guard.** A change that security or the handling of funds needs
is proposed for before the audit. Any other change is proposed as a card
for after it, and the statement is written as the present rule and marked
kept. The reconsideration is not a second feature programme.

**What reaches the owner** is one question list for each section, each
question with the alternatives considered and a recommendation, in the
order: changed, dropped, new. He answers by number. The list opens with
the count of statements marked kept, so he can see how much he is not
being asked about, and any of them is his to open. A section is
**canonical** when every question on its list is answered, and the record
holds the date.

**A kept mark is checked, not trusted.** A drafter who restates a rule
slightly differently and marks it kept has changed it without asking. So
the conflict read compares every kept statement with its source at the
pinned commit, and marks again as changed any that says more, less or
something else. Only a statement that survives that read is counted as
kept.

**The outline of a domain comes first.** Before any section is drafted,
the drafter writes the domain's outline: its lifecycle models as states
and steps, the kinds of account, and the list of sections with what each
covers and what it leaves to another. The owner approves the outline. It
is what makes a section's edges known before its neighbours exist, and it
is what a domain is later closed against (section 4).

**A section is the unit of approval, and a domain is the unit of
completeness.** The vault domain is seven review units. Each section is
approved before its own unit is reviewed, so the first review does not
wait for the seventh section. A section is canonical on approval. A
domain is complete only when its closing checks pass, and the four
numbers of section 14 count complete domains only.

**A later section may reopen an approved statement, and only by a new
approval.** Drafting the fourth section can show that a statement of the
first was wrong or too narrow. The change goes to the owner as a changed
statement on the later section's list, the record holds both approvals,
and the review unit that was judged against the old text loses its
specification mark for that statement.

## 7. The steps for one section

0. **Once for the domain:** its outline is drafted and approved.
1. **Draft**, from the documents: the statements, the models, the record
   and the question list. Kept outside the repository until approved.
2. **The folder check** passes on the draft.
3. **The conflict read**, by the thread that does not draft. It reads for
   three things: a statement that conflicts with another, in this domain
   or any canonical one; a statement that contradicts a platform
   statement; and a kept statement that is not faithful to its source.
4. **The threat list and the mistake list** (section 8). A threat or a
   mistake that no statement answers comes back as a proposed new
   statement.
5. **The owner** answers the question list.
6. **The section enters the folder** in one change, and is canonical.
7. **The catalogue** is generated, and the tests that already exist are
   mapped to it (section 10.4).
8. **The review unit opens** with the statements in its description
   ([`ReviewCoveragePassDesign.md`](ReviewCoveragePassDesign.md) section
   3.5), and its trace table is filled.
9. **The gaps are closed:** tests owed and not present are written, by a
   thread that did not write the code they test.

The drafting stays one section ahead of the review. The order of the
review sets the order of the drafting: the vault, the standalone contracts'
domains, the rule libraries' domains, the facets' domains, then the apps
and the keeper.

## 8. Threats, mistakes, and the paths that must be closed

Two lists are written beside each domain, from two seats. The threat list
asks what an attacker wants. The mistake list asks what an honest party
gets wrong. Every row of both is answered by a numbered statement.

### 8.1 Threats, and the "never" statements

For each domain the security thread writes a threat list: what is at
stake, who can call each step, what an attacker wants, what a misbehaving
outside part does (a token, a price, a swap route, a keeper, a cross-chain
message), what a stolen key can do, and what one person on both sides of a
position can do. Each threat has an id. The list is kept with the review's
private records while any gap in it is open, and it is never published
with a gap in it.

**Every threat is answered**: by a never statement, by a refusal, or by a
risk the owner accepts in his own words, recorded. A threat that nothing
answers is a gap in the specification and is closed before the section is
approved. A never statement that names no threat fails the folder check,
because a rule with no reason attracts exceptions. The folder check proves
the link from the statement's side, and a private check proves it from the
threat's side.

Only the threat's id appears in this repository. A never statement reads as
a plain rule (the balance a lien covers never leaves the vault by any step
but the one the lien was made for), and says nothing about how anyone might
try.

**A statement about something not yet public is kept with the private
records** and enters the folder when its subject does.

### 8.2 Mistakes: the contracts are the only gate

A party may call the chain directly and never see the app. So every rule
must hold for a direct caller, and a warning in the app protects nobody who
did not come through it. The owner asked for this and approved this form on
2026-11-22.

`mistakes/<domain>.md` lists what an honest party gets wrong: a rate a
hundred times too high, an amount in the wrong unit, the wrong asset, an
expiry already past or decades away, a zero where a least amount was
meant, a step taken out of order, tokens sent straight to a contract. It
is written by a thread in the party's seat. It is public, because it
describes mistakes and not attacks. A mistake that is also a way in for an
attacker goes on the threat list instead.

**Each mistake gets exactly one of four answers, written as a statement.**

| Answer | Means | Example |
| --- | --- | --- |
| **Refuse** | The call is rejected, with the reason and the values | An amount of zero. An expiry already past |
| **Bound** | The contract cannot know what was meant, so a limit caps the harm | A largest rate, a longest term, a least amount back from a sale |
| **Undo** | The step can be cancelled, or takes effect after a delay | An open offer cancelled. A protected setting that waits before it applies |
| **Warn only** | The app warns and the contract allows it | Needs a stated reason, because a direct caller never sees the warning |

The folder check refuses a mistake with no answering statement, with two,
or with a warn-only answer that states no reason.

**What cannot be prevented is stated.** Where no answer of the first three
kinds is possible, a statement says so plainly: what happens to tokens sent
directly to a contract, and whether and by whom they can be recovered. One
class is already removed by design and is stated as such: every payout
goes to the position holder's own vault, so no step can pay a mistyped
address.

### 8.3 The input table

Every function anyone can call has a table of its inputs: each input's
unit, its allowed range by parameter id, its relation to the other inputs,
and the statement that refuses a value outside the range.

- The table names functions and inputs, which are code, so it is kept
  beside the contracts and not in the folder. Each row cites its statement
  by id.
- **A check compares the table with the compiled interface.** An input
  with no row is a gap. A row for an input that no longer exists is
  refused. A range with no statement behind it is a question for the
  owner, like anything else the specification is silent on.
- **The unit tests of the catalogue are generated from the table:** each
  boundary, one step inside it and one step outside.

### 8.4 The closed model, and when a path is closed

**A step the lifecycle model does not allow from a state is refused.** The
path generator tries every step from every state, not only the refusals
someone thought to list (section 10.3). That covers the direct caller who
takes a path the app would never offer, and a call from outside to an
entry meant only for the platform itself.

**Random inputs end one of two ways.** Under random inputs and random
sequences, a call either succeeds with every never statement still true,
or is refused with a named reason. A raw arithmetic failure, a read out of
range, or a failure that gives no reason is a finding.

**A path is closed only for a reason:** it can reach a state the model
does not have, lose the caller's funds without their consent, or harm
another party. Any other unusual path stays open and is specified, because
integrators, keepers and the lending kit call the contracts directly too.
Refusing everything unusual would block honest callers, and many facets
have no room for checks chosen without a reason.

**Timing.** A check on an input that protects funds goes in before the
refactor, with the batch or the second wave. The rest are written in the
refactor, where each facet is cut with room.

## 9. Worked examples and the reference model

A fund movement that is only stated in words can be implemented two ways
and tested by the same person both times. So the amounts come from a third
place.

**The reference model** is a small program written from the statements
alone. It holds accounts and balances, takes a list of steps, applies the
fund-movement statements with exact whole-number and fraction arithmetic,
rounds only where a statement says to and the way it says, and prints
every balance of every account after every step.

- **Independent.** It is written by a thread that did not write the
  contracts' arithmetic. It imports nothing from the contracts, from the
  apps or from the shared library. It is in a different language from all
  three, **Default** Python, which the release-notes tooling already
  requires.
- **Honest about its limit.** It shares the statements with the code and
  nothing else. A wrong statement gives the same wrong figure in both.
  That is why a worked example is shown to the owner in plain numbers with
  the section it belongs to.
- **Conserving.** Every movement has a from and a to, so its totals cannot
  change. A step after which they do is a statement that is missing a part.
- **A statement it cannot run is a finding.** If a fund movement does not
  say enough to compute an amount, the model stops and names the statement.
- **A sample is worked by hand.** For each section, a second thread works
  a sample of its examples on paper from the statements and compares.

**A worked example** is a file under `examples/`: named accounts, starting
balances, a list of steps with their inputs, and the model's output. The
output is generated. A check runs the model again and refuses a file whose
figures differ, so an example cannot be edited by hand to match the code.

Each fund-movement statement owes at least one worked example, and one
more at each edge its amount or rounding names: the smallest amount, an
amount that does not divide evenly, a figure at its bound.

**One figure, everywhere.** The same example is run against the contracts,
is what the indexer and the app are tested to show for that step, and is
the example placed in the function's comment (section 13).

## 10. The catalogue

`catalogue/<domain>.md` is generated from the statements and the models,
and from nothing else. It changes only when the specification changes. It
is committed, so it can be read, and a check refuses a stale one.

### 10.1 What each kind of statement owes

| Kind | Owes, by default |
| --- | --- |
| Rule | A unit test of its limits, a functional test, and a place on at least one process path |
| Refusal | A functional test of the refusal, from every state and for every party the statement covers, each showing that nothing changed |
| Fund movement | A unit test of its limits and its rounding, a functional test, the worked examples of section 9, and a balance check on every process path that takes the step |
| Authority | A functional test for the holder, and one for each other kind of caller, refused |
| Setting | A test at each bound and one step past it, a test of the delay, and a deploy check that the deployed value is the table's |
| Never | An invariant held through random walks, and one abuse case for the threat it answers |
| Always possible | A path from every state it names to the outcome it promises, a functional test from each of those states under every condition of the platform it holds through, and a check after every step of the random walks that the promised step would still succeed |

**Each test owed is one obligation with an id of its own.** A refusal
that covers three states and two parties owes six tests, and a setting
owes one at each bound. The catalogue lists each as a row whose id is the
statement, the kind of test and a short key made from what tells it apart
from its neighbours: the state, the party, the condition, the bound, as in
`VLT-014 functional locked.owner`. A statement that owes one test of a
kind has an empty key. The key is made from the content of the row, so it
is stable while the statement and the model are, and a changed model shows
as obligations added and removed, by name.

**A statement that cites two models owes a joint path.** A loan that
closes while its lender's position is listed for sale, or a vault that is
locked while a loan it backs falls due, is governed by a statement that
names both lives. The catalogue gives each such statement a path that
runs both models together, with a name, because neither model's own paths
would reach it.

### 10.2 The kinds of test

| Kind | What it proves | Generated from | Where it runs |
| --- | --- | --- | --- |
| Unit | A rule's limits: zero, one, the largest value, each bound of a parameter, the rounding direction and whom it favours | Each rule and fund-movement statement, and the input table (section 8.3) | The rule alone |
| Functional | One success, and every refusal with its reason | Each statement and its refusals | The whole platform as deployed, locally |
| Process | A path through a lifecycle model, with every balance checked after every step | The lifecycle model | The path runner (section 10.3) |
| Worked example | The exact amounts the specification states | The examples of section 9 | The path runner, and the indexer's and the apps' own tests |
| Invariant | A never statement, held while steps are taken at random | Each never statement | The invariant suite |
| Abuse case | The attempt a threat describes, shown to fail | The threat lists | Kept with the private records until its gap is closed |
| Integration | Parts that meet: the contracts with the keeper, the indexer and an app, a second network, a token or a price source that misbehaves | Statements that name a part outside the contracts | The local-node suites that exist, and forks |
| Old against new | The refactored build behaves as the tagged build, apart from the listed intended changes | The generated paths | The differential run of the refactor |
| Deploy and upgrade | What a deploy and a refresh must leave true | The deploy and authority statements | The deploy-sanity suite and the rehearsal |
| Gas budget | A user action stays inside its stated cost | The budgets of the refactor rules | Report 1 of the refactor rules |
| Testnet scenario | The deployed system does what the paths say | A chosen subset of the generated paths | The testnets, after each fresh deploy |
| Drill | A fault of each kind can be diagnosed from the records alone | The troubleshooting design | The testnets, by hand, recorded |

Long runs (the generated paths, the random walks, the mutation run) follow
the project's standing decision on where long runs go. The full regression
stays a gate before a deploy and not a check on every change.

### 10.3 Every path, and the runner

"Every path" has a definition, so that it can be finished.

From each lifecycle model a **path generator** lists:

1. Every step, from every state the model allows it in.
2. Every step from every state the model does **not** allow it in, with
   the refusal the model names.
3. Every pair of steps that may follow one another.
4. Every end state, by every route that repeats no state.
5. Every value of every dimension, on every step that moves funds.
6. On the other steps, every pair of values of two dimensions at least
   once.
7. On every step, whether or not it moves funds, every combination of
   values that a statement names. A statement that says "a single NFT held
   by a later holder" puts that pair on every step it covers.

A condition of the platform is a dimension like any other, with one
difference: each is applied **alone**, to every step that moves funds, and
two together only where a statement names the pair. Each condition alone
on every fund-moving step is a list that can be finished. All of them
crossed is not.

A full cross of every dimension would be tens of thousands of paths that
differ in nothing a statement mentions, so it is not asked for. A
combination that should matter and is not reached by items 5 to 7 is a
missing statement, which is the right place to fix it: once the statement
names the combination, item 7 generates it. Whether this rule
gives a usable number is one of the things the pilot measures.

**Size.** Scouted for the loan, the largest model: on the order of forty
steps and eight states gives about three hundred single-step cases, a few
hundred pairs, some dozens of routes, and with the dimensions a list in the
low thousands. That figure is an estimate from the documents and is
measured on the pilot. Every path has an id made from its content, so a path keeps
its id when the model around it changes.

**Paths are data, and one runner takes them.** Nobody writes two thousand
tests by hand. The runner is built once. It has one **driver** for each
step, which knows how to take that step, and one **balance helper**, which
reads every balance of every account the model lists: wallets, vaults,
liens, claims, the treasury, the reserve, held amounts. For each path it
takes the steps, and after each step compares the state with the model's
and every balance with the reference model's. Adding a path adds no code.

- **Every balance, every step.** A path passes only if every account
  holds what the reference model says, including the accounts the step was
  not meant to touch.
- The drivers are written by a thread that did not write the code they
  drive.
- The same drivers serve the random walks, and the same paths serve the
  refactor's differential run on the old build and the new.
- **Default** it runs inside the contract test tool, where the invariant
  handlers already are, with the paths compiled in as generated data in
  small chunks so that no chunk nears the compiler's limits. The other
  way is for the runner to read the path files when it runs, which costs
  no compile and needs the test tool to be allowed to read one folder.
  The pilot measures both on the vault's paths, for compile time and peak
  memory against run time, before one is fixed.

### 10.4 How a test names its statement

| Tests | The mark |
| --- | --- |
| Contract tests and invariants | A documentation tag on the test function, one for each obligation it satisfies: `@custom:spec VLT-014 functional locked.owner` |
| Tests in the packages, the keeper, the indexer and the apps | The obligation first in the test's title: `[VLT-014 functional locked.owner]` |
| Browser tests | The same, in the title |
| A path the runner takes | Nothing by hand. The path's id carries its statements |

A tool reads the tags from the compiler's syntax tree and the titles from
the test runners' own listings. It refuses a tag that names a statement
that does not exist or is retired, and a tag whose key matches no
obligation the catalogue lists for that statement and kind. A test that
satisfies several obligations carries a tag for each. A tag with no key
counts only where the statement owes one test of that kind, so several
tests of one case can never stand in for a case nobody wrote.

**The gap report** is generated in CI from the catalogue and the tags, and
is not committed: for each statement, each obligation and the tests that
carry it, with every obligation that has none listed by its id.

**The tests that exist are kept and mapped.** For each section that
becomes canonical, a mapping pass goes through the existing tests of its
area. A test is tagged when it asserts the outcome a statement states. A
test that asserts something no statement states is listed, and each one is
either a rule the specification lacks (a question for the owner) or a
check of how the code is built, which is tagged as that with a reason. The
mapping is trusted only as far as section 11 proves it.

`docs/TestScopes/` is replaced section by section as catalogues are
generated, and its files move to `docs/OlderDocs/` when the last one is.

## 11. Whether the tests would notice

A test that carries a statement's id and passes proves little until it is
shown to fail when the rule is broken.

**The mutation run.** On the libraries that move funds, a tool makes one
small change at a time: an arithmetic sign, a comparison's boundary, a
rounding direction, a removed check, a swapped payer and payee, a figure
moved by one. For each change it runs the tests tagged with the statements
that govern the changed declaration, and the paths that pass through it.
A change that every test survives is a **survivor**.

- Each survivor is closed one of two ways: a test is added that catches
  it, or it is recorded as a change that alters no behaviour, with the
  reason.
- The list of survivors says where a change to a funds rule would go
  unnoticed, so it is kept with the private records. This repository shows
  the count.
- **The compiler setup shapes the tool.** Every change is a rebuild under
  the optimising pipeline, and a library that many facets inline rebuilds
  them all. So the run is confined to fund-moving declarations, runs only
  the tests that govern each, and is spread over many machines by the
  chunking the regression already uses. It runs before the audit tag and
  after any change to a library it covers, not on every pull request.
- **Line coverage is reported and gates nothing.** Under this pipeline the
  compiler's map from code back to lines is inexact, and a line run is not
  a rule checked. It is kept as a helper: a line no test reaches is dead
  code or behaviour no statement describes, and is listed for a look.
- What a mutation run costs here, and so what scope is affordable, is
  measured on the pilot before any wider scope is promised.

**Random walks.** Each never statement is an invariant. The invariant
suite takes the runner's drivers at random, with random parties, amounts
and times, and checks every invariant after every step. Every call must
end one of the two ways section 8.4 allows. The generated paths cover what
the model's authors thought of, and the walks cover the sequences nobody
wrote down.

**A walk runs several lives at once.** One loan walked alone never meets
what goes wrong between two: the same party lending on one loan and
borrowing on another, one vault backing several loans, a token that is
collateral here and principal there. So a walk opens several offers,
loans and slots among a small set of parties who share their vaults, and
takes steps on any of them in any order, with the steps nobody takes
(time, a price, a failing part) among them.

**Who writes a test.** A test owed for a statement is written by a thread
that did not write the code it tests.

## 12. The code check

Made by the reader of each review unit, and described in
[`ReviewCoveragePassDesign.md`](ReviewCoveragePassDesign.md) section 3.5:
a trace table with one row for each statement that governs the unit, read
in both directions, with a verdict of holds, differs or not found, and a
list of what the code does that the specification is silent on. The table
is private while it holds findings, and this repository shows counts.

The open entries of `docs/procedures/FunctionalSpecsCodeVsDocsAudit.md` are
carried into the first trace table that covers each, and that document is
closed to new entries when its last open entry has a row.

## 13. Function comments with examples, for direct callers

A party who calls the contracts without the app has the function's comment
and little else. The owner asked on 2026-11-22 that the comments carry
examples, and approved this form the same day.

**The standard.** Every function anyone can call carries a comment with
eight parts, each a tag the compiler's own documentation output carries.

| Part | Holds |
| --- | --- |
| Purpose | What the function does, in one sentence |
| Inputs | Each input with its unit (the token's smallest unit, basis points, seconds) and its allowed range, from the input table of section 8.3 |
| Before calling | What must already be true: an approval, the Terms accepted, a vault, a consent |
| Result | What it returns, and the event that confirms it |
| Refusals | Each refusal and what it means, by the error catalogue's names |
| Preview | The read-only function that says whether the call would succeed, and why not |
| Statement | The id of the statement it implements |
| Example | The call with real values, and each balance before and after |

A function only the platform itself may call keeps a lighter standard: its
purpose, and its statement where one applies.

**An example is placed, not typed.** A wrong figure in an example misleads
someone who is moving funds, and a comment goes stale without a sound. So
the example in a comment is the specification's worked example for the
statement the function implements (section 9), written in by a tool. The
same example is a passing test. One figure then stands in four places: the
specification, the test, the comment and the reference page.

**A check** reads the compiler's documentation output and refuses a
callable function that lacks a part, names an input that does not exist,
gives a unit or range that differs from the input table, cites a statement
that does not exist or is retired, or carries an example that differs from
the specification's.

**Comments cost nothing where it matters.** They are not in the deployed
code, so they take no room from a facet. The review ledger's hash leaves
comments out, so a changed comment reopens no review.

**A preview for every user action.** Many actions already have a read-only
preview or verdict that reports every refusal before anything is sent.
This makes it a rule: an action a party can take has one, and its comment
names it. An action without one is listed as a gap for the refactor.

**A generated reference, "Calling the contracts directly".** A block
explorer's write page shows input names and seldom the comments, and the
platform's functions sit across many facets behind one address. Comments
alone would reach few direct callers. A public reference is generated from
the comments, the combined interface, the input tables and the error
catalogue: one page for each function with its full example call, its
preview, each refusal and what to do about it. It is linked from the
developer documents, the project kit and the public feed's documentation.

**Descriptions for wallets (scouted).** Some wallets can show a plain
description of a call before the party signs, read from a published
description file for the contract: a label for the action, and each input
shown as a token amount, a rate, a date or a length of time. Three things
follow from how those files work.

- The file is keyed by network and address. The platform is one address
  with every function behind it, so one file for each network covers
  everything.
- The labels and formats it needs are exactly what the comment standard
  and the input table already hold. So the file is **generated from the
  same source**, as one more build output, and a check refuses a stale one.
- Publishing is the cost. Each wallet maker runs its own list and its own
  review, and a file must be published again when an address or a function
  changes. So the file is generated from the start and published once, per
  network, after the one fresh deploy to that network, as a launch card of
  its own. Which wallets read such files, and under what terms, is
  confirmed when that card is taken up.

**Timing.** The refactor's new facets are written to the standard.
Standalone contracts and rule libraries can be brought to it at any time,
since a comment reopens no review. The placing of examples waits for each
section's worked examples.

## 14. The four numbers, and the gate

| Number | Means | Must read |
| --- | --- | --- |
| Statements tested | Statements with every test they owe, passing | All |
| Paths covered | Generated paths the runner took and passed | All |
| Code holds the specification | Statements whose verdict is holds, with nothing on the silent list | All |
| Changes caught | Mutation changes caught, or recorded as altering nothing | All |

**Default:** all four are complete, or each exception is listed by id and
accepted by the owner in a recorded decision.

**They count complete domains only.** A domain whose sections are
canonical and whose closing checks have not passed (section 4) is
reported as open, and its statements are in none of the four. So a
mainnet and the audit tag also need every domain of the contracts
complete. Before that, each canonical section's figures are printed as a
running report.

- They join the review's numbers (coverage, off-chain coverage, and
  findings closed) in the **one launch check**, as a group of their own,
  and are not a second check. A mainnet is refused while any of them is
  short.
- The same numbers block the audit tag, as the register of section 22
  sets out row by row.
- Before that they are printed on every pull request as a report and fail
  nothing. Work that predates a section cannot be failed by it.
- The two numbers that rest on private records are read the way the
  review's are: by the read-only token, as counts only. No answer is a
  refusal.

## 15. The rules that change

- **Until a section is canonical,** the present rule stands for what it
  covers: builders do not edit `docs/FunctionalSpecs/`, and lines found out
  of date go on the owner's list.
- **Once a section is canonical,** a design that changes behaviour brings
  its statement changes to the owner with the design, as text: this
  statement changed to read so, this one dropped, this one new. The folder
  changes only after his approval, and only by the thread that keeps it.
  Builders do not edit the folder.
- **A pull request that changes behaviour names the statements it
  implements.** The drift check that today looks for a touched file under
  `docs/FunctionalSpecs/` looks instead for statement ids, or for a stated
  "no behaviour change", in the description.
- **One thread keeps the folder:** the design thread, which already keeps
  the owner's list of specification lines.
- `docs/FunctionalSpecs/` keeps its files until every domain is canonical.
  Its README lists the sections that have been replaced, and the canonical
  folder wins for those. The files then move to `docs/OlderDocs/`.
- The standing documents that state the present rule are changed in one
  pull request when the first section becomes canonical: the two agent
  instruction files, the README of the present specification, the
  procedures document, the pull request template and the drift workflow.
- **The wording rules bind the folder.** It is a public document. The
  rules for how rewards are described, the product's words (the instant
  market, the reserve, the lending balance) and the words the platform
  does not use are in `wording.json`, and the check enforces them. No
  third party is named. Nothing describes a finding that is not fixed.
- **The list of refused words does not itself print them.** A public file
  that spelled out every word the platform avoids, and every outside name
  it does not mention, would be the one place that says them all.
  `wording.json` therefore has two parts. The product's own words, with
  what to write, are in clear: they are already in this repository's
  instructions. The refused words and names are stored as salted hashes of
  the normalised word or phrase, of one to three words. The check hashes
  each word and each run of two and three words of a statement and
  compares. The clear list is kept with the private records, by the thread
  that keeps the folder. A hash of a short word can be found by trying
  words, so this keeps the list from being read at a glance and is not a
  secret: nothing in it would harm a party if found.

## 16. Tests (acceptance)

1. A draft with a duplicate id, a reused retired id, a date, an issue
   reference, a figure, a code name or a line over the limit is refused,
   each with the statement and the line.
2. A fund movement without a rounding rule, and a never without a threat
   id, are refused.
3. A statement with no source in the record is refused.
4. A statement in an approved section, edited without a new approval in
   the record, is refused.
5. A model with a step that has no refusal out of state, with two rows
   that cannot be told apart, or with an end state no route reaches, is
   refused.
6. The neighbours report lists two statements that share a thing and a
   step together.
7. The catalogue generated twice from one specification is identical, and
   a committed catalogue that differs from the generated one is refused.
8. Removing a statement's only unit test turns that row of the gap report
   from covered to owed, by name.
9. A tag that names a retired id is refused.
10. The reference model, given a path, prints balances whose total is
    unchanged after every step. Given a fund movement that does not state
    its rounding, it stops and names the statement.
11. A worked example whose figures were edited by hand is refused.
12. The path generator, run twice on one model, gives the same ids. After
    a row is added to the model, the ids of the paths that do not use it
    are unchanged.
13. The runner fails a path when one account that the step should not
    touch changes by the smallest unit.
14. A planted change to a rounding direction in a fund-moving library is
    caught by a tagged test, and one planted where no test reaches is
    reported as a survivor.
15. The launch check refuses when any of the four numbers is short and no
    recorded acceptance lists the exception, and prints counts only.
16. On the pilot: every statement of the first vault sections has a row in
    the trace table and every owed test in the gap report, before the
    second domain is drafted.
17. A mistake with no answering statement, with two, or with a warn-only
    answer that gives no reason, is refused.
18. An input of a callable function with no row in the input table is
    reported, and a row for an input that no longer exists is refused.
19. The unit tests generated from one input's row are its two bounds, one
    step inside each and one step outside each, and the outside ones
    expect the refusal the row names.
20. Under random inputs, a call that fails with a raw arithmetic failure
    or with no reason fails the run and is reported with its inputs.
21. A callable function whose comment lacks a part, names an input that
    does not exist, or carries an example that differs from the
    specification's, is refused.
22. The reference page for a function shows the same example figures as
    its comment and its test.
23. An action a party can take that names no preview is on the gap list.
24. The wallet description file generated twice from one source is
    identical, and a committed one that differs is refused.
25. A statement block with a part the parser cannot read stops the check
    with its file and line, and the count of statements does not silently
    fall by one.
26. A kept statement whose text says more than its source at the pinned
    commit is marked changed by the conflict read and appears on the
    question list. The list's count of kept statements falls by one.
27. A domain with every section canonical and one model row citing no
    statement is reported open, and its statements are in none of the
    four numbers.
28. A fund-moving step with no outcome while the platform is paused is
    refused by the folder check, and the generated paths include that
    step under each condition alone.
29. A walk that opens two loans sharing one vault takes steps on both. A
    statement that cites two models has a named joint path in the
    catalogue.
30. A refused word written in a statement fails the check, and the
    committed `wording.json` contains that word nowhere in clear.
31. An always possible statement whose step is refused from one of the
    states it names fails its path, by name.
32. A loop over items users create with no row in the bound table is
    refused, and the scale run fails a step whose cost passes its budget
    at the stated bound.
33. A path run with the fee-taking token as the lent asset ends in a pass
    or a named refusal, and a result that is neither fails the run with
    the path's id.
34. A transaction whose spender differs from the one on the confirm
    screen fails its journey, and so does a request with no comparison.
35. The launch check refuses the audit tag while a tag row of the
    register is open, refuses a mainnet while any row is, and treats a
    closed card with an unread proof as open.
36. A never statement with a Watch part and no watcher is on the gap
    list.
37. A draft whose new statement names the threat that raised it passes
    the check in draft mode and is refused in folder mode until the
    owner's approval is its source. An entry that names nothing is
    refused in both.
38. An owed reference to a domain with no canonical section passes. The
    same reference fails once that domain is complete, and one missing
    from the citing domain's record fails at once.
39. A refusal that covers three states and two parties shows six
    obligations in the catalogue. Six tests tagged for one of them leave
    five on the gap report, each by its id, and a tag whose key matches
    no obligation is refused.
40. A statement that names a pair of dimension values on a fund-moving
    step puts a path with that pair in the generated list.
41. An always possible statement with a limit it does not name fails
    under that condition, by name.
42. A statement in the held range is traced by the code check and owes
    its tests like any other, the public check reports no missing id for
    it, and the published numbers count it.
43. A function added to a contract with no row in the feature ledger
    fails the ledger check by name. So does a new design document, a new
    keeper pass and a new row of an app's coverage matrix.
44. A ledger row marked covered whose statement was removed fails. A row
    for an item that no list holds any more fails as stale.
45. A row marked covered by a statement that names the item and states
    nothing it does is refused: for a callable function the check reads
    the input table, and finds no statement that governs the function.
46. A statement that no item reaches, and that is not marked decided and
    not built, is listed by id. Marked so, it appears on the build list.
47. A domain with one open ledger item assigned to it cannot close, and
    the audit tag is refused while any item of any list is open.
48. A contract with values fixed at construction, deployed on two chains
    from one build, passes the deployed-code comparison on both. The same
    contract with one such value changed fails by that value's name, and
    with one changed byte of other code fails on the hash.

## 17. Alternatives considered

1. **One structured record for each statement, pages generated.**
   Rejected: two copies, and the one the owner reads is not the source.
   The fixed block gives the tools the same fields.
2. **Free prose with ids added.** Rejected: nothing could check that a
   fund movement states its rounding or that a never has a reason.
3. **Tidy the present specification in place.** Rejected: its history and
   repetition are the problem, and a rewrite of 2.1 MB in place could not
   be approved a part at a time.
4. **Write the specification from the code, since the code is reviewed.**
   Rejected by the owner's own rule and by what a specification is for: a
   test against it could only confirm the code.
5. **Error names in statements.** Rejected: the drafter would need the
   code, and a rename would change the specification.
6. **Figures in statements.** Rejected: one figure in forty places.
7. **Approve a whole domain at once.** Rejected: the first review would
   wait for the last section.
8. **Hand-written test documents.** Rejected: the nine that exist are
   months behind. A generated catalogue cannot fall behind.
9. **Commit the gap report.** Rejected: it changes with every test, so
   every pull request would conflict on it. The catalogue, which changes
   only with the specification, is committed, and the gap report is
   computed.
10. **Hand-written process tests.** Rejected: thousands of paths, each
    with every balance. Paths as data and one runner is the only form that
    finishes and stays true.
11. **The full cross of every dimension.** Rejected: tens of thousands of
    paths no statement distinguishes. The combinations asked for are the
    ones the specification names.
12. **Expected amounts from the contracts' own preview functions.**
    Rejected: the code would be checked against itself.
13. **The reference model in the apps' language, reusing the shared
    library.** Rejected: that library mirrors the contracts, so a shared
    mistake would pass.
14. **Line coverage as the gate.** Rejected: inexact under this compiler
    pipeline, and it measures lines run, not rules checked.
15. **Mutation on the whole tree, on every pull request.** Rejected: each
    change is a rebuild. It is confined to the code that moves funds and
    run at the gates.
16. **A second launch check for the four numbers.** Rejected: two checks
    are two places to forget. One check, one more group.
17. **Publish the threat lists with the specification.** Rejected while
    any gap is open. The statements that answer them are public.
18. **Let any builder edit the folder with their pull request.** Rejected:
    it is how the present specification came to state one rule five ways.
19. **Draft every domain before any review starts.** Rejected: the review
    would wait weeks. One section ahead is enough.
20. **A runner outside the contract test tool, against a local node.**
    Kept as the fallback. It tests the deployed shape and is free of the
    compiler's limits, and it is slower and would need a second set of
    drivers beside the invariant suite's.
21. **Leave the app to catch a party's mistakes.** Rejected: a direct
    caller never sees the app, and integrators, keepers and the lending kit
    are direct callers.
22. **Refuse everything unusual.** Rejected: it blocks honest callers, and
    the facets have no room for checks chosen without a reason. A path is
    closed for one of three stated reasons.
23. **Hand-written input checks, tested as someone thinks of them.**
    Rejected: the table is compared with the compiled interface, so an
    input nobody thought about shows as a gap.
24. **Examples typed into comments by whoever writes the function.**
    Rejected: a typed figure is wrong sooner or later, and nothing says
    when. A placed example is the tested one.
25. **Rely on comments alone to reach direct callers.** Rejected: most
    never see them. The generated reference is where they read.
26. **Write the wallet description files by hand, or publish them now.**
    Rejected: by hand they drift, and the addresses change at the fresh
    deploy. Generated now, published once after it.
27. **Approve whole domains only.** Rejected at alternative 19's cost: the
    first review would wait for the seventh section. **Approve sections
    with no outline and no closing check.** Rejected: nothing would say a
    domain is finished, and a section's edges would be guessed. Sections
    are approved, against an outline, and a domain is closed.
28. **Trust the drafter's kept mark.** Rejected: it is the one mark that
    keeps a statement away from the owner, so it is the one that must be
    checked.
29. **State each standing product rule in the domain it touches most.**
    Rejected: every draft must be read against all of them from the first
    day, and the fee and app domains are drafted last. One short domain,
    approved first.
30. **Keep the refused words in clear, or only in the private records.**
    In clear, the public file is the one place that prints them all. Only
    in private, the check cannot run without a secret, so a contributor
    could not run it. Hashes run anywhere and print nothing.
31. **Cross every condition of the platform with every other.** Rejected:
    it cannot be finished. Each alone on every fund-moving step, and the
    pairs a statement names.
32. **Fold "always possible" into rules.** Rejected: a rule is tested
    where it applies, and a promise that a party can always get out must
    be tested from every state, which is a different debt.
33. **Keep the register as cards only, or in each design.** Rejected: a
    card can be closed by hand, and nineteen rows across four documents
    is how one is missed. One table, read by the one launch check.
34. **Let a watcher pause the platform by itself.** Rejected here: it
    would hold a key, and a false alarm would stop every user.
35. **Cross-check the finished folder once, by hand, against a list of
    features.** Rejected: it comes late and finds only what the writer of
    the list remembered. The feature ledger of section 23 is built from
    lists that are generated, and is checked as each domain closes.
36. **Let the code check's silent list be the only check of coverage.**
    Rejected as the only one: it sees the contracts and only what is
    built. A feature that lives in an approved design, an app, the keeper
    or the indexer is outside it.
37. **Match features to statements by searching for words.** Rejected: a
    statement that mentions a thing does not state what it does.

## 18. Recommendation

Adopt the folder, the statement block and the record, with a threat list
and a mistake list beside each domain. Pilot on the vault, section by
section, one ahead of its review. Build the folder check first, then the
catalogue and the gap report, then the input tables, the reference model
and the runner. Bring comments to the standard as each facet is written in
the refactor. Put the four numbers in the one launch check and on the
audit tag.

## 19. Residuals

- **A wrong statement passes everything.** The specification is checked
  for form, for conflict and against threats, and approved by the owner.
  Nothing mechanical says a rule is the right rule.
- **Two statements can contradict in words no check reads.** The
  neighbours report and the conflict read narrow this and do not end it.
- **The reference model is one more program that can be wrong.** It is
  small, it conserves by construction, and a disagreement with the code is
  examined on both sides.
- **The mapping of existing tests is a judgement.** The mutation run
  measures it on the code that moves funds, and nowhere else.
- **The drafter's independence rests on the source rule,** not on what a
  thread has or has not read.
- **Off-chain domains have weaker models.** An app's behaviour is stated
  and tested, and its paths are journeys chosen by hand, not generated.

## 20. Build split

| Part | Owner area | When |
| --- | --- | --- |
| The folder's skeleton: README, statement block, parameters, glossary, record, wording list | Design | With the pilot |
| The platform domain: the standing product rules and the conditions of the platform, as statements | Design | First, before the vault's question lists |
| The outline of each domain, approved before its sections | Design | Before each domain |
| The vault pilot: seven sections, drafted one ahead of review | Design | Now |
| Later contract domains | Design. A second drafting thread if the pilot shows the load needs it | In review order |
| The app, indexer, keeper and notification domains | Their areas draft, design keeps the folder | After the contract domains |
| The conflict read: conflicts, platform statements, and every kept statement against its source | The discussion thread | Each draft |
| The threat list for each domain, and the abuse cases | Security, in the private records | Each draft |
| The mistake list for each domain | A thread in the party's seat: the app's area for the contract domains. Design keeps it in the folder | Each draft |
| The input tables, their check against the compiled interface, and the unit tests generated from them | Test tooling builds the check and the generator. The area that owns a contract fills its rows from the statements | With each section. Checks that protect funds before the refactor, the rest in it |
| The folder check, the neighbours report | Test tooling | First |
| The catalogue tool, the tag readers, the gap report | Test tooling | After the check |
| The reference model and the worked examples | Test tooling, from the statements alone. Design reads it against them | With the first fund-movement section |
| The path generator, the runner, the drivers and the balance helper | Test tooling, with drivers by threads that did not write the code | After the first lifecycle model |
| The mapping pass over existing tests | Test tooling leads. The area threads for their own packages | Each section |
| The specification lens in the review tool: statements in the description, the trace table, the third mark | Security with test tooling | With the first approved section |
| Random walks from the never statements. The mutation run | Security with test tooling | After the runner |
| The four numbers in the launch check and on the audit tag. The changed standing rule in the standing documents | Governance | With the first canonical section |
| The comment standard and its check, the tool that places examples, the generated reference "Calling the contracts directly", the preview gap list | Test tooling builds. The refactor's threads write to the standard | The check now. New facets in the refactor |
| The wallet description files: generated now, published after the fresh mainnet deploy | Test tooling generates. Governance owns the launch card | Generation with the reference. Publishing at launch |
| The feature ledger of section 23: the list generators, the ledger check, the build list | Test tooling builds. Design fills the ledger as each domain closes. The discussion thread makes the human pass | With the folder check. The human pass before the audit tag |
| The further tests and reviews of section 21, and the register's lines in the launch check | As the register of section 22 names, card by card | Per the register's gates |
| Approvals: each section's question list, each worked example, each accepted exception | The owner | Each section |

## 21. Further tests and reviews

On 2026-11-22 the owner asked whether any other kind of test or review
should be added, and approved nine. A tenth, the feature ledger, was
asked for by the owner the same day and is section 23. Everything above proves the contract
code against the specification. These nine cover where a lending platform
loses funds outside that proof. Seven are described here. The other two,
the review of off-chain code and the proof of the core arithmetic, are
reviews, and are sections 3.7 and 3.8 of
[`ReviewCoveragePassDesign.md`](ReviewCoveragePassDesign.md).

### 21.1 Always possible, from every state and at scale

The seventh kind of statement (section 3.1) says what a party can always
do without anyone's help: a lender can always collect a claim, a borrower
can always repay, a position can always be closed, a vault's owner can
always withdraw what no lien covers.

- **From every state.** For each such statement the catalogue generates a
  test from every state it names, in which the named party completes the
  action alone. No other party, no keeper and no admin acts.
- **In the random walks,** after every step, each always-possible step is
  tried in a snapshot and must still succeed.
- **The scale run.** The same tests are repeated with thousands of loans,
  offers, positions and slots held by one party, on one asset and in one
  vault, and the cost of each step is reported as the count grows. A loop
  that grows with usage can lock funds as surely as a wrong check, and no
  test of a small state shows it.
- **A bound on every loop.** A table beside the contracts lists every
  loop over items that users create: what it walks, its bound as a
  parameter id, and who pays for it. A check reads the loops from the
  compiler's syntax tree and refuses one with no row. It is kept beside
  the contracts for the reason the input table is (section 8.3): it names
  code.

### 21.2 The hostile asset set

The contracts accept any token, so the paths are run against badly
behaved ones. One fixed, named list in the test folder: a token that takes
a fee on transfer, one whose balances change by themselves, one that
blocks an address, one that calls back during a transfer, one that returns
nothing and one that returns false, tokens with unusual decimals, one its
issuer can pause and one its issuer can change, an NFT that refuses a
transfer and one that refuses a rental step, and the same for a
multi-unit NFT.

The runner takes the list as a dimension. Each generated path runs with
each hostile asset in each role an asset can have (lent, pledged, rented,
paid as a fee), one at a time, with every other asset well behaved, and
two together only where a statement names the pair. The expected result
is the one section 8.4 gives for random inputs: success with every never
statement true, or a refusal with a named reason. A behaviour for which
the specification states no outcome is a question for the owner.

### 21.3 Stress on the economics and on the settings

Two runs over the reference model, and one report.

- **Scenarios.** A sharp price fall in one step and in several, liquidity
  that vanishes, every sale route failing, a long sequencer outage, and
  these together. For each the report says who bears the loss, whether a
  liquidation still pays the party who runs it, and when the in-kind
  fallback is reached.
- **The worst value of every setting.** For every row of the parameters
  table, the worst value its bounds allow is run through the catalogue,
  alone and in the pairs that share a statement. A bound that lets one
  admin mistake harm users is a finding.

The report is kept with the private records while a gap is open. It asks
a different question from the tests: they show that the code holds the
rules, and this shows whether the rules hold when the market does not.

### 21.4 What you see is what you sign

For every transaction and every signature an app builds, a test decodes
what the wallet is asked to sign and compares it with the amounts, assets
and addresses on the screen. Approvals are included, for the exact amount
and the exact spender, and so are signed permits.

- One harness in the test wallet records every request to send or sign.
- The confirm step marks each fact it shows, and the test compares the
  two sets in both directions: nothing signed that was not shown, and
  nothing shown that was not signed.
- A request that reaches the test wallet with no comparison made fails
  the test.
- Each app's coverage matrix gets a column for it.

### 21.5 What is deployed is what was reviewed

At every deploy, on every chain, the launch check compares the code at
each deployed address with the build of the reviewed commit, and the live
settings and roles with the parameters table and the authority
statements. The reviewed commit is named by a protected tag, and the
hashes compared are the ones in that tag's baseline record
([`RefactorRulesDesign.md`](RefactorRulesDesign.md), section 3.2). The
per-chain record that already binds each address to a code hash is the
starting point. A difference is a refusal that names the
address or the setting.

**Code that carries values fixed at construction is compared in two
parts.** A contract such as the vault code holds addresses in its runtime
code that are set when it is deployed (the position token, the treasury,
the backstop), so one build has a different code hash on every chain and
a plain comparison with the build's hash would refuse every valid deploy.
For such a contract the launch check:

- blanks every such value in the deployed code, at the places the build's
  own output lists for it, and compares the hash of what is left with the
  record's hash, which is made the same way;
- then reads each value and compares it, by name, with what that chain's
  deployment record and the folder say it must be. A value with no
  expected figure is a refusal, the same as a wrong one.

The record lists, for each contract, the name of every such value. A
contract with none is compared whole. The price guard's deploy check
already compares code this way, and this is the same rule for every
contract.

**The settings and roles are compared again on a schedule after launch,**
by the watcher of section 21.6, and a difference is an operator alert. A
deploy is one moment, and a setting can be changed the day after it.

Two reviews go with it, written once before the audit and again when
their subject changes.

- **Each chain's differences:** how time and block numbers behave, what
  the chain supports, how its sequencer fails, and what the platform
  assumes about each.
- **Every outside part the platform depends on:** the price sources, the
  sequencer signal, the sale routes, the cross-chain layer, the permit
  contract and the sanctions list. For each, what the platform does when
  it fails and when it lies.

### 21.6 Never statements watched live, and drills

Each never statement carries a **Watch** part: what in the chain's own
data would show a breach (a balance, a total, an event), or the reason
nothing would. The list of watchers is generated from those parts, so a
never statement with no watcher shows as a gap. A watcher reads and
alerts the operators. It holds no key and pauses nothing by itself.

Three response drills are run on a testnet, timed, each with a written
record: pause and resume, replacing a compromised key, and a keeper that
stops. The record names the commit the drill ran against and the people
who ran it. **A drill is run again when what it exercises changes:** the
pause design, who holds a key, or the keeper's host. A drill whose record
names an older design, holder or host is open.

### 21.7 First-time users

A handful of people new to the platform run the fund-moving journeys on a
testnet, given a goal and not steps. What they misread about what they
were signing goes into the mistake list of its domain (section 8.2) and
is answered like any other mistake. No personal data is recorded.

### 21.8 Left to the owner

Two more were named and are not assumed, because each costs money: a
public contest or a standing bounty after the outside audit, and a launch
with value limits that are raised in steps.

## 22. The register

One list of every test and review owed before a mainnet. **Tag** means
the row is closed before the audit tag, and **mainnet** before the
mainnet deploy.

| Row | Test or review | Written down in | Card | Closed when | Gate |
| --- | --- | --- | --- | --- | --- |
| A1 | The review coverage pass: every line of contract code through a reader pass and a converged reviewer loop | The coverage design, the review ledger | #3938, #3939 | Coverage complete; no finding open | Tag for coverage, mainnet for findings |
| A2 | The canonical specification, every domain complete | This folder | #3947 | Every section approved, every domain closed (section 4) | Tag |
| A3 | The code checked against the specification, statement by statement | The trace table | #3939, #3948 | "Code holds the specification" complete, nothing on the silent list | Tag |
| A4 | The cross review in a second cut, with the closing whole-file read | The review ledger's cross-review mark | #3939 | The mark on every declaration | Tag |
| A5 | A threat list for each domain | The private records | #3939 | Every threat answered by a never statement, a refusal or the owner's recorded acceptance | Tag |
| A6 | Mistake lists, input tables, closed lifecycle models | The folder, and beside the contracts | #3950 | Every mistake answered, every step outside the model refused | Tag |
| A7 | The generated catalogue: unit, functional, every path, integration, every balance, random walks | The catalogue of each domain | #3948, #3949, #3952 | "Statements tested" and "paths covered" complete | Tag |
| A8 | The mutation run on the fund-moving libraries | The catalogue, the private records | #3952 | "Changes caught" complete | Tag |
| A9 | The comment standard with placed examples, and the reference for direct callers | The comment check, the generated reference | #3951 | The check green on every callable function | Mainnet |
| B1 | Always-possible statements, the scale run, a bound on every loop | Sections 3.1, 10.1 and 21.1 | #3954 | Counted in "statements tested"; the scale run passes at every bound; no loop without a row | Tag |
| B2 | The hostile asset set | Section 21.2 | #3955 | Every path run against every asset of the set in every role | Tag |
| B3 | Stress on the economics and the worst value of every setting | Section 21.3, the private report | #3956 | Every finding closed or accepted by the owner | Mainnet |
| B4 | Proof of the core arithmetic | The coverage design section 3.8, proof files beside the rule libraries | #3957 | The proofs pass on the tagged code, with the proved, bounded and not-finished lists recorded and every not-finished property sampled | Mainnet |
| B5 | Review of off-chain code that can move or misdirect funds | The coverage design section 3.7, the review ledger | #3958 | Off-chain coverage complete; no finding open | Tag |
| B6 | What you see is what you sign | Section 21.4, the apps' coverage matrices | #3959 | Every transaction and signature the apps build has a passing comparison | Tag |
| B7 | What is deployed is what was reviewed; chain differences; outside dependencies | Section 21.5, the launch check, two review notes | #3960 | The check green on each chain at its deploy; both notes written; the scheduled comparison armed | Mainnet, and every deploy after |
| B8 | Never statements watched live, and the response drills | Section 21.6, the watcher list, the drill records | #3961 | Watchers armed on every chain; each drill's record names the present design, holders and host | Mainnet |
| B9 | First-time user tests | Section 21.7, the mistake lists | #3962 | Every finding answered | Mainnet |
| B10 | The feature ledger: every function, design, screen, pass and decision ends in a statement, and the human pass | Section 23, the ledger file in the folder | #3965 | Every item of every list has an outcome; the check green on the tagged commit; every finding of the human pass answered | Tag |

**How a row cannot be missed.**

- Every card of the register carries the label `launch-register`, so the
  weekly sweep lists them together.
- Every row is a line of the **one launch check**. The check refuses the
  audit tag while a tag row is open, and a mainnet deploy while any row is
  open.
- **A row closes only by the proof named in its "closed when" column,**
  which the check reads for itself, or by the owner's recorded acceptance.
  Closing the card closes nothing. A row whose proof the check cannot read
  is open.
- **An acceptance is a record the check reads, not a remark.** It holds
  the row's id, what is accepted and for what reason, the date, and the
  owner's own message. It is stored beside the review's record of findings
  closed as accepted by the owner, and the check counts a row as accepted
  only when it finds that record. Without this, acceptance would be the
  one way to close a row with no proof at all.
- **One list, one place.** The register is this table until the launch
  check carries it as data. From then the launch check's own file is the
  register, this section points to it, and the table here is removed. A
  row is added only by the owner's decision.

**Order.** B1, B2 and B6 start now, with the vault pilot: they are cheap
and protect funds directly. B5 and the two reviews of B7 are done before
the audit, so the auditors read them. B3, B4, B8 and B9 are done before a
mainnet. B10 is filled domain by domain as each closes, and its human pass
is made once, before the audit tag.

## 23. The feature ledger: nothing the platform does is left out

Asked for by the owner on 2026-11-22: once the canonical documents are
ready, check that they cover every feature the platform has.

**What the other checks leave open.** The folder check proves the folder
agrees with itself. The record proves every line of the old
specifications was considered (section 6). The code check lists what the
contracts do that no statement covers (section 12). None of them sees a
feature that lives only in an approved design, in an app, the keeper or
the indexer, or in a decision that never reached a specification.

**The lists.** Each exists independently of the folder, so none can share
its blind spots. A tool regenerates all of them on every run.

| List | Read from | One item is |
| --- | --- | --- |
| What can be called | The compiled interface of every deployed contract | One function |
| What is announced and refused | The same interfaces, and the file of error meanings | One event, or one error |
| What can be set | Every value a governed step can change | One setting |
| What anyone may run | The ledger of open steps the pre-deploy gate reads | One step |
| The old specifications | `docs/FunctionalSpecs/` | One section |
| The approved designs | `docs/DesignsAndPlans/` | One document, and each of its sections that states behaviour |
| The keeper | Its list of passes and their switches | One pass |
| The apps | Each app's coverage matrix | One row |
| The indexer | What it handles and what it serves | One handled event, or one feed |
| Notifications | The kinds the agent can send | One kind |
| What shipped | `docs/ReleaseNotes/` | One section |
| What was decided | The owner decisions the documents record by date | One decision |

**The ledger.** One data file in the folder, `feature-ledger.json`
(**Default**). Each item of each list has exactly one outcome.

| Outcome | Carries |
| --- | --- |
| **Covered** | The ids of the statements that state what the item does |
| **Dropped** | The owner's decision that removed it, by date |
| **Not a behaviour** | The reason: a build note, a history section, a tool |
| **Held** | Nothing in public. The pointer is in the private records, and the published report counts it (section 3.6) |

Each item is also assigned to the domain that answers for it.

**Covered means stated, not mentioned.** A statement that names a thing
does not cover it. So for the four lists read from the contracts nobody
maps by hand: a function is covered through its input table (section
8.3), an event through the map of facts to events, a refusal through the
"Refused as" line that names its error, and a setting through its row of
the parameters table. For the other lists the drafter writes the outcome,
and the conflict read checks a sample of them against their sources.

**The check** refuses:

1. an item with no outcome;
2. an outcome that cites a statement that does not exist, or a decision
   that no document records;
3. a row for an item no list holds any more;
4. a "covered" for a contract item that its table, map or line does not
   bear out.

**The other direction.** Every statement must be reached by at least one
item that does it: a function, a step, a pass, a screen. A statement that
nothing reaches is listed by id, unless its record marks it **decided and
not built**. Those are printed as the **build list**: what the owner has
approved that the code does not yet do. This is where a builder learns
what an approval asked of them, and no second list of build items is
kept by hand.

**The human pass.** A tool cannot tell whether a statement says enough.
After the check passes for the whole folder, a thread that drafted none
of it walks each app screen by screen, each keeper pass and the private
survey of features, and writes down anything a user or an operator would
say the platform does that no statement says. Each finding ends as a
statement or as an outcome in the ledger, and the record of the pass is
what closes register row B10.

**When.** The ledger is filled as each domain is drafted. A domain cannot
close with an open item assigned to it (section 4). An item nobody has
assigned is open for the folder. The audit tag is refused while any item
of any list is open.

**What is published.** The counts: items, covered, dropped, not a
behaviour, held, open. An outcome that would describe a held matter is
never written in the public file.
