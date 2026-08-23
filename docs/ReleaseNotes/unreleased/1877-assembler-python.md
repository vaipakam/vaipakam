# Release-note assembly moved to Python, behind the same command

The script that folds pending release-note fragments into a dated file is
invoked exactly as before. What changed is what sits behind that command:
the work now lives in a Python program, and the shell file is a thin entry
point that finds an interpreter and hands the arguments straight through.

The reason is the shape of the failures the old version kept producing. It
had reached roughly 2,600 lines and forty-six review rounds, and the
findings had stopped being about the design — they were about its
application. A guard placed one step too late. A check that answered for
the moment the run started rather than the moment that mattered. Two lists
describing one fact and disagreeing with each other. That is what a program
too large to hold in one head produces, and no amount of care about the
next line fixes it.

The transactional core is also the part a shell is worst at. Rename, stat,
hash, temporary file, signal window: every one is a separate command whose
failure has to be noticed and routed by hand at each place it is used, and
the missed routing was the recurring finding. In the new implementation
those failures raise on their own, and every fallible step reports through
a single place, so a failure reads the same way wherever it happened.

## What operators need to know

**Python 3.10 or newer is now required, and Bash 4 is not.** The entry
point interrogates each candidate interpreter rather than trusting its
name, so a `python` that is still Python 2 is refused with a clear message
instead of running into a syntax error. Stock macOS Bash 3.2 is now fine
and there is no `brew install bash` step; the test suite still uses Bash 4
features, but that is a requirement for contributors changing the
assembler, not for anyone folding fragments. Both operator documents have
been corrected — they previously stated the opposite in both directions.

Behaviour is otherwise unchanged, and that is the claim the test suite
exists to support: it drives the command line rather than any internal, so
it moved across intact and its assertions are what shows the behaviour did
not move with it.

## The suite now checks its own retirements

Some cases in that suite injected a fault by breaking the specific command
the old shell version happened to run. Those faults cannot be produced any
more, and such cases were marked retired with a stated reason. Marking is a
claim, and reading the code to decide was wrong nineteen times — three
cases were retired as covered elsewhere when they were not covered at all
and still worked perfectly, and sixteen more simply passed. All nineteen
were restored, and the suite now proves each remaining retirement by
lifting it and requiring the case to fail. A retirement that cannot be
demonstrated is no longer allowed to stand.

Closes #1877. Closes #1886.
