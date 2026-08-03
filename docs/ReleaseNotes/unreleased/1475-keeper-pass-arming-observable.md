## The keeper now says which switch stopped it

Three of the keeper's periodic jobs — reward remittance, its acknowledgement pass, and commitment reporting — each sat behind an on/off switch, and when a switch was off they simply did nothing, quietly. That is the problem: a job that was switched off and a job that ran and found no work to do produced exactly the same output, which is none at all.

That would be a small annoyance if the switches could be read back. They cannot. They are stored as secrets, and the hosting provider will confirm only that a secret of that name exists — never its value. So between a switch that could not be read and a job that said nothing, there was no way to establish whether the thing was on. A misspelling, a stray capital letter, or an invisible trailing newline pasted along with the value would leave the job switched off permanently while everything looked healthy.

For these particular jobs that is the worst case, because they move funds between chains and report what has been committed. A job that has silently stopped looks exactly like a quiet week.

**Every switchable job now announces itself once per run**, whichever way its switch reads. If it is running, it says so. If it is not, it names the specific switch that stopped it, and what is wrong with the value. One pass of the log settles the state of every switch the keeper has.

Some details worth calling out:

**No value is ever printed — only what is wrong with it.** "Unset", "empty", "deliberately switched off", "wrong capitalisation", "has spaces around it", or "unrecognised, 4 characters long". This is deliberate and was a correction during review: the situation this diagnostic exists for is the value being *wrong*, and one of the ways a value gets wrong is somebody pasting a password or key into the wrong box. Printing it would copy that secret into the logs at exactly the moment the system is meant to be protecting it. The character count still tells an operator whether they are looking at a four-letter typo or something long that does not belong there.

**Everything wrong is reported at once.** If three settings are wrong, one line names all three. An earlier version stopped at the first, which would have meant fixing one, waiting for the next run, and discovering the next — turning a single check into a sequence of them.

**One message became several.** The master switch previously reported a single "keeper disabled", covering two genuinely different situations — the switch being off, and the signing key being missing. Both are unreadable, so an operator seeing that message could not tell which to go and fix.

**A key that is present but unusable is now a blocker, not a green light.** The signing key was only checked for being non-empty, so a malformed one — wrong length, or not a valid key at all — let every job announce it had started and then quietly do nothing. Reporting the healthy state for a broken key is the worst direction to be wrong in, and it would have let the restore procedure sign off while nothing could actually sign. The key itself is still never printed; the line says only that it is malformed and in what way. Getting this right took two passes: the first check looked at the shape of the value — length and characters — which still admitted values that look exactly like a key but are not one. The check now simply tries to build the signing identity and reports whatever refuses, so the thing that decides whether a key works and the thing that reports on it are the same thing, and cannot drift apart.

**The promise that key material never reaches the log needed enforcing, not just stating.** One of the jobs built the signing identity itself rather than going through the shared check, and did so outside its error handling — so an invalid key threw, the surrounding handler logged the failure, and the underlying library's message for that case *contains the rejected key value*. Every construction now goes through one place, and a test fails if a second appears. The guarantee is only true while that holds, so it is now checked rather than trusted.

**A deliberate "off" reads as off, not as a mistake.** Setting a switch to `false` is the documented way to turn a job off, and an earlier version of this reported that as "unrecognised, 5 characters" — telling an operator their intentional shutdown looked like a typo, at the moment a spurious warning is least welcome. It now says the job is explicitly disabled. It still refuses to run, of course; the message describes the state, it does not decide it.

### Which jobs this covers

Six of the keeper's ten periodic jobs have a switch of their own and now report it. The other four have no switch to report, so they stay quiet — and the operator documentation says so explicitly, because "no line" would otherwise read as "the job failed".

### A quirk this exposes rather than fixes

The master switch accepts `True` and `TRUE`; the two reward switches accept only lowercase `true`. So `KEEPER_ENABLED=True` works while `REWARD_REMIT_ENABLED=True` does not, which is a genuinely surprising trap.

We deliberately did not make them agree here. Doing so would switch **on** a fund-moving job on any deployment that currently has it set that way and believes it is off — a behaviour change smuggled in under a logging improvement. Instead the log now reports `wrong case — these flags require lowercase \`true\``, which turns an invisible trap into a legible one without repeating the value back. Using lowercase everywhere avoids it entirely.

### Operator-facing

The restore runbook previously instructed operators to treat the two reward switches as write-only — re-enter the value rather than verify it, and wait for a successful remittance as the only confirmation. That instruction is now obsolete and has been replaced: one log cycle verifies all of them.

It also gained a correction that has nothing to do with logging but everything to do with acting on what the log says. The signing key is not stored the same way the switches are — it lives in a shared account-level store rather than on the individual job runner — and the command for one does not work for the other. Using the wrong one appears to succeed while leaving the job disarmed, so the runbook now spells out which command belongs to which setting.
