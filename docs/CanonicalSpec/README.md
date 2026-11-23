# The canonical specification

This folder states what the platform is meant to do, one statement at a time.
The code is checked against it, statement by statement, and the test catalogue is made from it.
The design is [`CanonicalSpecDesign.md`](../DesignsAndPlans/CanonicalSpecDesign.md).

## The rules of the folder

- **A statement is drafted from the owner's decisions and the approved designs, and never from
  the code.** The code is what the statements test. A statement with no document source enters
  only with the owner's approval, by date.
- **A statement has a permanent id,** a kind, who it binds, when it applies, one outcome, and
  the tests it owes. The kinds are: rule, refusal, fund movement, authority, setting, never and
  always possible.
- **A statement holds no figure, no date, no name of code and no history.** A figure is in
  [`parameters.md`](parameters.md) and is named by id. Where a statement came from is in the
  record.
- **A rule has one home.** Another domain cites it by id. A rule of a domain that is not
  entered yet is cited in the owed form, "(CODE owed: a short phrase)", and listed in the
  record until that domain is entered.
- **A section is the unit of approval, and a domain is the unit of completeness.** A section
  is canonical when the owner has approved it. A domain is complete only when its closing
  checks pass.
- **The folder changes only with the owner's approval, and only by the thread that keeps it.**
  A design that changes behaviour brings its statement changes to the owner with the design.
  Builders do not edit this folder.
- **Some statements are held outside this folder** while publishing them would itself do harm.
  They are part of the specification in every other way, and their ids are in the range 900 to
  999 of their domain.
- **No line is longer than 100 characters.** A table row is exempt.

## What is here

| Path | Holds |
| --- | --- |
| [`principles.md`](principles.md) | What the platform is for, and the statements that enforce each principle |
| [`platform.md`](platform.md) | The rules that bind every domain |
| [`vault.md`](vault.md) | Vaults |
| [`price.md`](price.md) | Prices, the price guard, the unit of account, liquidity and the risk figures |
| [`parameters.md`](parameters.md) | Every figure, once |
| [`mistakes/`](mistakes/) | The mistakes an honest party can make, each with the statement that answers it |
| [`record/`](record/) | For each statement: its sources, its mark and its approval |
| [`wording.json`](wording.json) | The product's own words, and the refused words as salted hashes |

Still to come, as the design lists them: the glossary, the worked examples, and the generated
test catalogue.

## The domains

| Code | Domain | Status | Held |
| --- | --- | --- | --- |
| PLT | The platform's rules | Canonical. Open until the domains it owes rules to are entered | 2 |
| VLT | Vaults | Sections 1 to 5 of 7 are canonical. Sections 6 and 7 are not entered | 4 |
| PRC | Prices | Sections 1 to 7 are canonical. Open until the domains it owes rules to are entered | 9 |

"Held" is the count of statements held outside this folder.

The other codes a statement may cite in the owed form are listed in the design, section 3.5.

## Where the earlier specification stands

`docs/FunctionalSpecs/` stays in force for everything no canonical section covers.
Where a section here is canonical, this folder is the statement of intent for what that
section covers.
The standing documents that name the earlier folder, and its own list of the sections replaced,
change in one separate pull request, as section 15 of the design says.

## The check

The folder check reads every file here and refuses, among other things, a statement that lacks
a part its kind needs, a figure outside the parameters table, a reference to an id that does
not exist, a statement with no record entry, and a statement whose text differs from the text
the owner approved. Its rules are section 4 of the design.
