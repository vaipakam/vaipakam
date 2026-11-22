## Local testing — refactor reports and the event-category lint (PR #TBD)

The refactor pass (RefactorRulesDesign) now has four of its five reports, built from the compiler's own syntax tree in the pre-deploy gate's existing one-job build. Nothing is recompiled for them. The four are:

- **Silent functions.** State-changing entry points whose reachable code emits no event.
- **Swallowed failures.** A failed call, caught or low-level, whose handling neither reverts nor emits, including a failure tested inside a compound condition such as "failed or returned too little".
- **Ambiguous errors.** An entry that can raise one parameterless error from more than one place, plus every text revert and every error missing from the coming catalogue.
- **Write-only storage.** Fields that contract code writes and that only views read, or nothing does.

The fifth report, the gas suite, is card #3915.

The old event-category lint never ran. It now reads tags from the syntax tree, not the source text, and is wired in as a sixth result.

"Reachable" follows internal and library calls, modifiers (including calls in their arguments), and self-calls through the Diamond. A shared helper reached from two facets is read once for each, so each facet's own override of a hook it calls is seen. A call a standalone contract makes on itself is followed into its own code; only a facet's goes through the Diamond. A self-call counts when the code names its selector, whether as a function's selector, a selector constant (a hex value or a hashed signature) or an encoded signature string. Where the code names no selector, as in multicall, the report says it is unknown rather than guessing. The tests say what the reports cannot prove: they are bounded checks ("does reachable code contain an emit"), not proofs about every path.

Every tool that reads the compiler's syntax trees (these reports, the entry-gate check, the review coverage tool, the permissionless-step ledger, the error map and the delivery check) now reads its build through one loader, which refuses artifacts from more than one compilation job: syntax-tree ids are numbered per job, so a mixed build would resolve calls against unrelated declarations.

Each report's current findings are committed under contracts/refactor-reports/, with a ledger for accepted findings that requires a reason of at least twenty characters. The gate compares the tree against them. Until the refactor pass ends, a new finding is a warning and only a malformed ledger fails; the config file holds that switch. The baseline is large: 1,758 ambiguous-error entries (raise sites grouped by what the caller receives, so two declarations of one parameterless error count together, and each call to the typed revert wrapper naming an error counts as a raise of it) and 19 text reverts (every shipped error is in the error catalogue, compared by its ABI signature), and 467 event-category entries, most of them tags whose leaf the lint's stale allow-list does not know. Every report reads receive() and fallback() as entry points too. These are the input to the refactor pass's interface document (#3925), not things to fix here.

Closes #3914.
