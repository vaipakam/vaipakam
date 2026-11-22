## Local testing — refactor reports and the event-category lint (PR #TBD)

The refactor pass (RefactorRulesDesign) now has four of its five reports, built from the compiler's own syntax tree in the pre-deploy gate's existing one-job build. Nothing is recompiled for them. The four are:

- **Silent functions.** State-changing entry points whose reachable code emits no event.
- **Swallowed failures.** A failed call, caught or low-level, whose handling neither reverts nor emits.
- **Ambiguous errors.** An entry that can raise one parameterless error from more than one place, plus every text revert and every error missing from the coming catalogue.
- **Write-only storage.** Fields that contract code writes and that only views read, or nothing does.

The fifth report, the gas suite, is card #3915.

The old event-category lint never ran. It now reads tags from the syntax tree, not the source text, and is wired in as a sixth result.

"Reachable" follows internal and library calls, modifiers, and self-calls through the Diamond. A self-call counts when the code names its selector, whether as a function's selector, a selector constant (a hex value or a hashed signature) or an encoded signature string. Where the code names no selector, as in multicall, the report says it is unknown rather than guessing. The tests say what the reports cannot prove: they are bounded checks ("does reachable code contain an emit"), not proofs about every path.

Each report's current findings are committed under contracts/refactor-reports/, with a ledger for accepted findings that requires a reason of at least twenty characters. The gate compares the tree against them. Until the refactor pass ends, a new finding is a warning and only a malformed ledger fails; the config file holds that switch. The baseline is large: about 2,900 error entries, mostly because no error catalogue exists yet, and 467 event-category entries, most of them tags whose leaf the lint's stale allow-list does not know. These are the input to the refactor pass's interface document (#3925), not things to fix here.

Closes #3914.
