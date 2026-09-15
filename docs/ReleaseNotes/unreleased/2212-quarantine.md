## Thread — A reminder could still be sent about a loan nobody had confirmed (issue #2212)

The platform checks its own loan records against the chain a few at a time,
and derives due-date and grace-period reminders from those records. A record
the check could not settle — one the chain has never heard of, one whose state
could not be read, one whose correction failed to write, one in a state this
build does not recognise — is still stored as open, which is exactly what a
permanently missed ending leaves behind. Reminders fire once and are never
taken back, so "prepare to repay" must not be derived from a record nobody has
confirmed.

A previous change held such records back, but only on the turn that noticed
them. Since each turn looks at a handful of records, the very next turn had
nothing to hold back — the record was simply not in that turn's findings — and
the reminder went out anyway. The mistake was treating *what this turn looked
at* as if it were *what is currently unconfirmed*. Those are different
questions, and any answer read from a single turn confuses them.

That is worth stating plainly because the obvious cheaper fix fails the same
way. Holding back **every** record on a turn whose findings were dirty looks
stricter and is not: the next turn's findings are clean for having looked
elsewhere, so the reminder still goes out — and meanwhile every healthy loan
on that chain loses its reminders too.

### What changed

The platform now remembers an unconfirmed record until a later turn confirms
it. The reminder surface consults that memory rather than the current turn's
findings, so a record stays held back across every turn that does not examine
it.

What is remembered is *which* way the record could not be confirmed — an
unreadable record, a failed write, a state the build does not recognise, and a
record the chain denies all need different responses — and *when it was first
noticed*, which is preserved rather than refreshed each time. That distinction
is the whole operator signal: minutes means a source having a bad moment, days
means a position nobody has resolved. A record held back that long is now
named out loud, because no amount of retrying will settle it.

Releasing is the half that had to be right. A record held back forever on the
strength of one bad read would be the mirror image of the defect, so release
is derived by subtraction — everything the turn examined, minus everything it
could not settle — rather than from a list of releasable cases. A list would
mean that a newly added kind of failure is released by default: marked by one
half and cleared by the other on the same turn, with nothing appearing wrong.

### Three things review caught, all of them quiet failures

**A record ended the ordinary way would have stayed held back forever.** A
record held after one unreadable moment, whose ending then arrives normally
before the check comes round to it again, leaves the set the check draws from
— so nothing could ever release it. It would have been held, and reported as
stuck, for good. Releasing now also happens wherever a loan is closed out,
which is the list every close-out already shares.

**The platform would have stopped reminding anyone at all during a deploy.**
The reminder query names the new memory, and the deploy sequence publishes the
new code before the database change that creates it. In that window the query
fails, and the surrounding safety net turns one failed query into *no reminders
on any chain* — a far bigger outage than the one this closes, and open
indefinitely if the database change then fails. The query now asks whether the
memory exists and, when it does not, reminds exactly as it did before and says
so. It starts holding records back the moment the change lands, with no
redeploy.

**The operator report claimed more than it knew.** It named at most twenty
records, so on a chain with more than that the same twenty appeared every time
and everything behind them stayed silent — while the note said anything held
that long is reported. It now counts the total and says how many it left out.
It also no longer asserts that a source "has not recovered", nor that
retrying cannot settle the record: on a chain whose check takes longer than
the threshold to come round, a record can pass it without having been looked
at again, and may settle the moment it is. The report gives its age and when
it was last examined, and leaves the conclusion to the evidence.

### And two the same review caught in the fix itself

**A second reminder lane was still speaking.** Due-date and grace reminders
are not the only unretractable message the platform sends about a loan: a
separate lane sends "your interest payment is due" and marks that checkpoint
as told. It reads the same stored records, in a different part of the system,
and had no idea about any of this — so a user could still be told a payment
was due on the very loan every other reminder was being withheld for. Both
lanes now apply one shared rule rather than two copies of it.

**Closing a loan could have stopped a chain being read at all.** The release
added above goes into the same all-or-nothing group of writes as the rest of
a close-out, so during the deploy window it would have failed that group,
which in turn would have stopped the reader advancing — leaving that chain
frozen on one block until the database change landed. Everything that touches
the new memory, read or write, now asks first whether it is there.

A third lane that messages users — the health alerts about a loan's safety
margin — needed no change, and the reason is worth stating: it works from the
chain's own list of open loans rather than from the platform's records, and
asks the records only who to tell. A loan the chain considers ended is not in
its list at all. That is the test for any lane added later: where does its
list of loans come from?

### What this does not change

Reminders for every record the platform *has* confirmed, which is nearly all
of them and includes every other loan on a chain where one record is stuck.
Holding one back never holds back the rest.

The memory is written after each turn rather than as part of it, so a turn
interrupted between the two loses that turn's entry — the record is still
unconfirmed, so the next turn that examines it records it again. That is a
turn's worth of exposure rather than a guarantee, and it is stated here rather
than left for someone to discover.

Closes #2212.
