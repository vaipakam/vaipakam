# The keeper stops doing all ten jobs every single minute

The `vaipakam-keeper` Worker had been running every one of its ten
periodic passes on every tick of an every-minute schedule, and was
exceeding the CPU time its plan allows. Nothing about that was
deliberate — a pass fires every minute because firing every minute is
what you get when nobody writes down how often it actually needs to run.

The passes are now declared in one table, each naming how often it runs
and why. Three stay on every tick: the health-factor watcher and the
liquidator are protocol-safety functions, and the matcher is the one
users feel when a match is slow. The rest run on their own cadence,
taken from timing each pass already documents — the liquidity-confidence
pass caches its advisory answers for an hour, so a finer cadence re-read
the same answer; the pre-grace warning fires inside a 24-hour window with
a repeat throttle; the acknowledgement scan retries on a 15-minute
backoff, so scanning every minute could never make one land sooner. The
daily oracle snapshot now runs only inside the ten-minute window it acts
in, instead of reaching its own guard 1,430 times a day to decide it has
nothing to do.

## Spacing them out is the part that matters

The first version of this change gave each pass a cadence and stopped
there, and it would not have fixed the problem. A Worker's CPU time is
charged **per invocation**, so the number that has to come down is the
busiest minute — and cadences of every-5, every-15 and every-30 minutes
all coincide on the hour. Nine of the ten passes still landed on the same
tick, while the day's total dispatch count fell by 63% and every summary
figure said the problem was solved.

Each staggered pass now has its own minute within its cadence, so no two
land together. The busiest tick went from ten passes to at most five, and
a test asserts that ceiling directly rather than asserting the daily
total, because the daily total was exactly the misleading number.

## Nothing goes quiet

A pass that is idle because it is not due now says so, naming its cadence
and the reason for it. That follows a rule the keeper already had for a
different kind of idleness: a pass held back by a misconfigured arming
flag says which flag and what was wrong with it. The two failures — not
due, and not armed — are equally visible in one log cycle, because a
pass that has quietly wedged must never look the same as one that is
simply waiting its turn.

Every pass also reports how long it took, including when it fails. That
is what the follow-up work needs: the remaining question is whether the
three every-tick passes fit the budget on their own, and answering it
should be a read of the logs rather than another investigation.

Part of #1896 — the measurement it enables is still outstanding.
