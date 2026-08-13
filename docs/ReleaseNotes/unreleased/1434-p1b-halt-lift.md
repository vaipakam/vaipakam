### Receiving chains can now pay out their own coordinated-mode days (#1434 P1-b)

Until now, a receiving chain never priced the days that run under the
platform's coordinated reward mode. Those days were stopped outright — not
because anything was wrong with them, but because the platform had no way to
tell how much funding a receiving chain had actually been sent, and paying
without that knowledge could have drawn on tokens held for other obligations.
The stop was a placeholder for the missing measurement.

That measurement now exists, so the stop is gone. A receiving chain prices its
coordinated-mode days exactly as the coordinating chain does, and what keeps it
honest is a simple rule: **it may pay out no more of that funding than it has
actually been sent.**

**A shortfall makes a day wait; it never shrinks it.** This is the part that
matters most for anyone whose rewards are affected. Two different limits can
hold a payout back, and they settle in opposite ways:

- The platform's lifetime emission ceiling only ever shrinks. What it cannot
  cover can never be covered later, so a day held back by that ceiling is paid
  down to what fits and then closed for good.
- Delivered funding is the opposite — it grows with every delivery. A day short
  of it is simply not funded *yet*, so it waits, and the next delivery pays it
  in full.

Trimming a day for the second reason would permanently underpay someone whose
funding was merely still in transit. The two limits are therefore tracked
separately, so the platform can always say which one actually applied. Where
both apply equally the day closes, because no future delivery could complete it
and waiting would mean waiting for something that cannot arrive.

**The wait can always end.** A day that is waiting on funding is not stuck: it
becomes payable the moment that funding lands. The rule is keyed on the amount
present rather than on the arrival of any particular message — which matters,
because some days are deliberately never funded from the coordinating chain
(the receiving chain covers them locally, or the amount rounds to nothing). A
rule keyed on messages would leave those days waiting forever and block every
later day behind them.

**What is unchanged.** The coordinating chain is unaffected — it funds its own
days directly and receives no deliveries, so the new limit does not apply to
it. Rewards earned before coordinated mode was switched on are also unaffected:
no delivery ever funded them, so they are not measured against delivered
funding and continue to pay as they always have.

**What you will see.** A reward estimate on a receiving chain now matches what
a claim will actually pay. Previously an estimate could quote the full amount
for a day that a claim would decline to pay; estimate and claim now agree.
