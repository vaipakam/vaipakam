## Pre-deploy gate tells keeper-bot call drift from error-list drift (PR #2940)

The pre-deploy gate's ABI step compares the public keeper bot's committed ABIs with the compiled contracts. It used to compare each file as a whole. Every facet carries the whole shared custom-error list, so adding or removing a single error marked most of the bot's ABIs stale, even though none of the bot's calls had changed. The warning was on after nearly every contract change, so nobody read it, and it would have hidden the drift that does break the bot.

The gate now sorts the difference into two kinds. If a function's selector, arguments, result or mutability differs, the gate prints the same warning as before, because the bot's calls may no longer match the Diamond. If only the error or event list differs, it prints a lower-level note instead: every call still works, and only some reverts and events decode as raw bytes until the next bot ABI sync. An ABI that does not parse, or that holds an entry of an unrecognised type, is treated as function drift, never as the milder kind. The frontend ABIs are unchanged: any drift there still fails the gate. The classifier has its own test cases, which run in CI on every pull request.

Run against the bot's current ABIs, the new gate reports error-list drift only, in seven of its twelve files. Function drift in any of the bot's files still produces the warning.

Closes #1564.
