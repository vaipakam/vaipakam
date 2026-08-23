# The keeper can now be measured, and most of its work turns out to be unskippable

The `vaipakam-keeper` Worker runs ten periodic jobs on an every-minute
schedule and had been exceeding the CPU time its plan allows. The obvious
remedy is to stop running everything every minute. This change went
looking for that saving, found far less of it than expected, and the
finding is the more useful half of the work.

## What changed

The ten passes are now declared in one table, each naming how often it
runs and why, which the scheduler walks. They were previously ten
hand-written blocks repeating the same four concerns — trap the errors,
name the pass, decide the cadence, time the run — and four things
remembered ten times is how a job ends up running every minute for no
reason anyone recorded.

Every pass now reports how long it took, including when it fails, and a
pass held back by its cadence says so and why. That follows a rule the
keeper already had for a different kind of idleness: a pass blocked by a
misconfigured arming flag names the flag and what was wrong with it. A
job that has quietly wedged must never look the same as one that is
simply waiting its turn.

## Only two of the ten can safely run less often

Each cadence was supposed to come from a timing assumption the pass
already documented. Three of the first five did not survive review, and
all three failed the same way — a real constant was read from the file,
and it turned out to govern something adjacent to the thing that
actually matters.

- **Liquidity confidence** was slowed on the strength of an hour-long
  cache. That cache backs *promotions*; the path that **demotes** a
  degrading asset re-checks the market every run and lowers its
  borrowing power immediately, because that is the fail-safe direction.
  Slowing it meant a degraded asset could keep generous terms for half
  an hour while new loans were written against it.
- **Commitment reporting** was slowed because its reports are keyed by
  day — true, and beside the point. It deliberately stops part-way
  through a large backlog and resumes where it left off on the next run,
  so the tick rate *is* the drain rate, and another chain's remittance
  waits on it finishing.
- **Acknowledgements** were slowed on the strength of a retry backoff
  that governs *re-sends*. Noticing a delivery for the first time has no
  earlier attempt to be backed off from, so nothing bounded that latency
  except the cadence itself.

A fourth, **auto-extension**, was pulled back for the same reason before
review reached it: it stops after a fixed number of extensions per run
and does not deal with the most urgent first, so running it less often
drains a backlog proportionally slower against deadlines that are
enforced to the second.

What is left is genuinely idle most of the time: the pre-grace warning,
which fires inside a 24-hour window and re-scans from scratch each run,
and the reward-budget top-up, whose own notes say re-scanning each run is
harmless and keeps no state. The daily oracle snapshot now runs only
inside the ten-minute window it acts in, rather than waking 1,430 times a
day to decide it has nothing to do.

## The honest arithmetic

Spacing the remaining jobs apart still matters, because the limit is
charged per run rather than per day: jobs on every-5, every-15 and
every-30-minute cadences all land together on the hour unless they are
given different minutes. An early version of this change missed that and
reported a 63% saving while the busiest minute was unchanged — the
average moved and the number that matters did not.

With the unsafe cadences reverted, the real figures are a busiest minute
of nine jobs rather than ten, and about a quarter fewer runs per day.
That is not a fix, and this note should not be read as one.

**The conclusion is that this approach cannot solve the problem.** Seven
of the ten jobs have to run every minute for reasons that are about
correctness and safety rather than convenience. The CPU has to come down
by making a run cheaper — reading candidates from the existing database
instead of re-deriving them from the chain, and bounding the work each
run does — not by running less often. The timing added here is what makes
that next step a measurement rather than another guess.

Part of #1896, which stays open.
