## The keeper now says which switch stopped it

Three of the keeper's periodic jobs — reward remittance, its acknowledgement pass, and commitment reporting — each sat behind an on/off switch, and when a switch was off they simply did nothing, quietly. That is the problem: a job that was switched off and a job that ran and found no work to do produced exactly the same output, which is none at all.

That would be a small annoyance if the switches could be read back. They cannot. They are stored as secrets, and the hosting provider will confirm only that a secret of that name exists — never its value. So between a switch that could not be read and a job that said nothing, there was no way to establish whether the thing was on. A misspelling, a stray capital letter, or an invisible trailing newline pasted along with the value would leave the job switched off permanently while everything looked healthy.

For these particular jobs that is the worst case, because they move funds between chains and report what has been committed. A job that has silently stopped looks exactly like a quiet week.

**Every job now announces itself once per run**, whichever way its switch reads. If it is running, it says so. If it is not, it names the specific switch that stopped it and shows the value it actually found, in quotes — so a trailing space or a capital letter is visible rather than merely suspected. One pass of the log now settles the state of every switch the keeper has.

Two details worth calling out:

**The signing key is never printed.** It is reported only as present or absent. That is the one setting where showing the value to prove it is set would defeat the purpose of it being a secret.

**One message became three.** The master switch previously reported a single "keeper disabled", which covered two genuinely different situations — the switch being off, and the signing key being missing — and both are unreadable, so an operator seeing that message could not tell which one to go and fix. Those are now separate messages.

### A quirk this exposes rather than fixes

The master switch accepts `True` and `TRUE`; the two reward switches accept only lowercase `true`. So `KEEPER_ENABLED=True` works while `REWARD_REMIT_ENABLED=True` does not, which is a genuinely surprising trap.

We deliberately did not make them agree here. Doing so would switch **on** a fund-moving job on any deployment that currently has it set that way and believes it is off — a behaviour change smuggled in under a logging improvement. Instead the log now reports `not true (got "True")`, which turns an invisible trap into a legible one. Using lowercase everywhere avoids it entirely.

### Operator-facing

The restore runbook previously instructed operators to treat the two reward switches as write-only — re-enter the value rather than verify it, and wait for a successful remittance as the only confirmation. That instruction is now obsolete and has been replaced: one log cycle verifies all of them.
