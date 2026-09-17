### A held record no longer suppresses reminders for a different loan that reuses its number

When the platform cannot confirm what happened to a loan, it remembers that
and holds that loan's reminders back rather than sending ones it cannot stand
behind. The memory is released when the loan is settled, or when it is found
to have ended.

One case released neither: a loan the network denies exists, which may have no
stored record either. That is deliberate — nothing proves such a position
ended, and keeping it held and visible in the report a person reads is the most
useful thing this memory does. But the documented way for an operator to
resolve one of those is to delete the fabricated record, and once they do, the
held entry matches nothing and stays forever.

Left alone, that has a harmless consequence and a harmful one. The harmless
one is clutter: an entry sitting in a report, burying the ones that need
attention. The harmful one is that loan numbers can come round again — a
network redeployment, a partial reset — and a stale entry would then withhold
reminders from a **different, legitimate** loan, without saying so.

The second is now closed. A held entry is released as soon as a loan bearing
the same number appears whose own start is later than the moment the entry was
recorded. That can only be a different loan: a loan cannot start after it was
held. A loan replayed from history keeps its original start and so is still
recognised as the same position, and stays held.

The clutter is deliberately left. Removing it would mean either releasing
entries merely because their record is absent — which drops exactly the cases
this memory exists to surface — or ageing them out on a timer, which trades a
real signal for tidiness. An entry a person has resolved can be cleared by that
person; an entry nobody has resolved should still be in front of them.
