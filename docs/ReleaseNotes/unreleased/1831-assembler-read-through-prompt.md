## Release notes — the assembler names fragments to read together (PR #2946)

Release-note fragments are written one at a time, against the code as it stood
when each change merged. Two can each be true and still contradict each other
once they sit in the same dated file, and the assembler deletes the sources as
it folds them in, so nobody reads them side by side afterwards.

When a run folds two or more fragments into one file, the assembler now lists
them by name and asks for one read-through of their limits against each other
before the commit. A fragment can mark a limit or known gap with a line starting
"> Caveat:", and the list shows those lines under the fragment's name. This is a
prompt, not a checker: the assembler does not judge whether the fragments agree.

Closes #1831.
