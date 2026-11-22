## Local testing — the mechanical entry gate check (PR #TBD)

Some rules belong to no one facet: every entry point of a certain kind must carry a certain check. Examples are refusing a flagged wallet, refusing under a pause, holding the re-entry guard, asking the Terms rule, or being callable only by the Diamond. Those rules are now written down once, in one rules file the Security thread keeps, and a new check compares every entry point with it.

The check reads the compiler's syntax tree. For each state-changing entry point of every shipped contract, it lists the modifiers on the entry and the checks the code reaches before it first changes state. It follows internal and library calls in place and reads a modifier up to its placeholder; a call out made inside a modifier before the placeholder counts like one in the body, and a modifier is read as Solidity runs it, for the entry and for every helper: its code before the placeholder, then what it wraps (conditional if the placeholder may be skipped), then its code after the placeholder before the caller resumes. A check under a condition does not count, nor one reached after a helper that may already have returned, and neither does one placed after a storage write, an external call that changes state, or a call back into the Diamond that changes state. An entry that a rule applies to, with none of its checks and no exemption, is reported with the rule and the reason. An exemption needs a reason, and one that names no entry, names an entry the rule does not cover, or covers an entry that already carries the check is refused.

The same file produces the checklist each review-only pull request carries in the review coverage pass, with the unit's entry points listed against each rule.

The check is bounded and says so. It does not see a check reached only through a function pointer, an assembly block or a call deeper than eight levels. A helper it cannot read (deeper than that, or called through a function pointer) counts as a possible state change, so no check after it is credited. It does not judge whether a check is correct. The review does that.

Until the check reports nothing, the rules file and its output stay in the private review repository, and the tool takes the file as an argument. After that the file moves into this repository and the pre-deploy gate blocks on it, so a new entry point is refused until it carries each check its kind requires. Until then the gate step says no rules file is present and passes.

Closes #3944.
