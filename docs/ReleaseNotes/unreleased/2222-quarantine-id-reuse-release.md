### A held record now says what its loan number points at, instead of silently withholding

When the platform cannot confirm what happened to a loan, it remembers that and
holds that loan's reminders back rather than sending ones it cannot stand
behind. The memory is released when the loan is settled, or found to have
ended.

One case releases neither: a loan the network denies exists, which may have no
stored record either. That is deliberate — nothing proves such a position
ended, and keeping it held and visible in the report a person reads is the most
useful thing this memory does. But the documented way for an operator to
resolve one is to delete the fabricated record, and once they do, the held
entry matches nothing and stays.

That is worse than untidy, and the reason is the part worth stating. A held
entry withholds reminders from **whatever loan currently bears that number** —
so if the number ever comes round again, after a network redeployment or a
reset, a real loan goes without reminders and nothing says so.

The obvious remedy is for the platform to notice that the loan bearing the
number now is a different one and release the entry by itself. That was built,
and then removed, because every way of establishing "this is a different loan"
from what the platform has stored turned out to be unsound:

- the recorded start time can be the platform's own clock, substituted when the
  network could not be read at the moment the loan was recorded;
- a recorded place in the network's sequence goes stale as soon as an entry is
  rewritten by a path that cannot rewrite it too;
- that sequence restarts on a test-network reset, so a newer loan can appear
  older;
- and the sequence value itself can be left behind by a reorganisation the
  platform is documented as never revisiting.

Each of those was found by review after the previous one was fixed. Acting on
any of them would have released a hold — and resumed reminders — on the
strength of a read that failed, which is precisely what the memory exists to
prevent.

So the platform does not guess. The report a person reads now names, for every
long-held entry IT DESCRIBES, what its number points at today: no stored loan at all, or a
stored loan in a given state that began at a given point. That description is
explicitly labelled as **stored and unverified** — the same record that proved
unsound to act on is not then presented as settled fact — and held numbers are
listed even when there are more than the report describes in full, up to a
stated limit, because an entry left out entirely would be withholding reminders
with nothing anywhere naming it. Those listed-but-undescribed numbers get no
such lookup, and the report says so in terms: being named is not being
examined, and nothing above one of them says what it points at now.

Someone reading it can see whether the entry is still about the loan it was
made for, and clear it if not. That is a deliberate act, spelled out in the
report, and it names the exact entry that was read: a check that ran between
the reading and the clearing can have recorded a fresh finding under the same
number, and an unguarded removal would discard it.

Where more entries are held than the report describes in full, it also says
what it is not doing: those numbers are named but not described, the
descriptions are of the longest-held entries and do not take turns, and
resolving one of those is what brings the next into view. It would be easy to
write "described next time" there, and it would be untrue — nothing would ever
supply that detail.

Each described entry carries its removal command already written out, to be
run exactly as printed. That is deliberate and it replaced three earlier
attempts to print the *pieces* and let a person assemble them — each of which
turned out not to run, in a different way each time. The command is checked by
being executed: the tests take the text the report emits and run it.

The value it quotes is two values, not one: a token and the time of the
sighting, and they cover different things rather than doubling up. An ordinary
write rotates the token; a write made while the store is still on the older
shape cannot, and those are caught by the time moving instead. A time recorded to the second cannot
tell two sightings within the same second apart, and a token cannot be
refreshed by the older write shape, so either on its own would let a removal
delete a finding recorded *after* the person read the report — resuming
reminders for a loan nothing has settled, which is exactly the harm this
memory exists to prevent. One narrow gap remains and is written down further
below. The window is narrow, and that is no defence: the whole value of a
safety check is that it can be trusted without being checked, so one that can
fail silently is worse than none. Naming an entry while withholding what it takes to act on it
sounds harmless and is not: because the described page does not take turns,
the entry would stay unactionable indefinitely, and a person who needed it
gone would be pushed toward exactly the unguarded removal this report spends a
paragraph warning against.

One release does still happen on its own — when a stored loan bearing the
number is no longer running — and that carries the same identity assumption in
smaller form: where a number has been reused, it establishes that the
replacement ended rather than that the original position did. It is recorded as
a known limit rather than presented as settled, **and it is the release itself
that says so**, giving a count where the store reports one — and saying so
plainly where it does not — alongside a bounded roster of the CANDIDATES it
read immediately before removing. Not of what it removed: the removal re-checks
its condition, so fewer can go than were listed, and where that happens it says
how many and that it does not know which, or why.
Leaving that to the held-entry report would have disclosed nothing in the one
case that matters: a release can clear the last held entry, and the report says
nothing when nothing is held.

That roster took two goes as well, and the first was worse than it looked. It
named at most a set number of entries — but only after asking the database for
every single one and holding them all in memory, so the *appearance* of a limit
sat on top of work that still grew without one. A limit that only shortens the
message is not a limit; it hides the cost rather than removing it. The entries
are now read back under a limit the database itself applies; the count is
exact where the store reports one, and where it does not the report says so
rather than supplying a number. The roster is described for what it is: what the sweep was
about to release, read immediately beforehand, rather than a claim about the
removal itself.

There is a second way a held entry clears by itself, and it is the sound one:
a run examines the number, the network answers, and the entry goes. That is
deliberately left alone — the network's own answer about a number is the only
solid evidence in any of this, and every basis the platform declines to act on
is a stored value standing in for exactly that answer. Blocking it would leave
a live, settled loan without reminders indefinitely on the strength of a
finding about a loan that no longer exists. But where the entry had been held
long enough to be appearing in the report a person reads, its release is now
announced, together with what that release cannot establish: if the number had
come round, the answer concerns the loan bearing it now, and the earlier
unresolved finding has gone with it. An entry cleared before it was ever
reported stays unannounced — that is the everyday case of a reading that failed
once and succeeded next time, and a line for each would bury the ones that
need a person.

Reporting takes the same small number of database enquiries however many
entries are held, and the first attempt at that left the amount READ and
PRINTED still growing with the number of entries — so the report would have
failed on exactly the network that most needed it, inside the run that must
also record how far the chain has been read. It now names at most a set number
of entries, says **exactly** how many more are held, and hands over the
enquiry that lists them. A listing that simply stopped would be the silent
truncation this whole change exists to avoid.

What matters there is that the work does not vary with the size of the fault
more than it must — not that it is as small as it could be. A shorter version
was written and set aside: it would have saved one database enquiry by using a query feature the
database's own documentation neither promises nor rules out, and which nothing
else in this codebase has ever asked it for. This is the one report that makes
a withheld position visible at all, so a query the database declined would not
degrade it — it would hide every withheld position on every run, which is the
fault the whole change exists to prevent. One saved enquiry is not worth that.

A held entry can be cleared from more than one place — a periodic sweep, a run
that settles the loan, and the close-out that ends it — and announcing each was
done one at a time, as each was noticed. That is how the third one stayed
silent: in the very case worth disclosing, a reused number's replacement
closing normally, the entry vanished without a word while the other two paths
announced themselves. The missing piece was never a case, it was a rule. There
is now a single shared way for the platform to release ONE entry by itself — a
removal a PERSON runs is a different thing and outside this rule, written out
for them one per entry and guarded as described above — and it reports
what it removed, and a new route cannot be added without deciding what it
announces.

The periodic sweep is the exception, and saying so matters more than a tidy
rule would. It removes a batch in one instruction, so it cannot use a
per-entry form — a check demanding one would force it back into removing rows
one at a time, which is what several rounds of this change were spent getting
away from. It carries its own announcement instead, and it is the only such
place.

That is a strong default, not a guarantee, and the difference is worth stating
because the first version of this paragraph claimed the stronger thing. A route
that took the shared form and threw away what it returned would still be
silent, and nothing can prevent that: these releases have to be committed
together with unrelated work, so they cannot control their own execution. What
changed is that staying silent is now a deliberate act rather than an
oversight, and a check refuses any release written by hand. A guarantee a
reader trusts without checking is worse than one they check.

What a release says also depends on what licensed it, and there turned out to
be four different licences rather than two. A run that read the network for a
number and got an answer holds the soundest evidence in any of this, and says
so. A repair is a network read too, but of a loan whose ending was never
announced — so it says the ending was FOUND, rather than claiming one arrived,
which on the one path defined by a missing announcement would have described
the opposite of what happened. It only says that where its own write is the
one that recorded the ending; where another writer got there first it says
less, because that writer may have been the announcement arriving, and
claiming none came would deny the likeliest explanation. A close-out did see the ending announced, and
establishes that the loan CURRENTLY bearing the number ended, never that the
entry being released was about that loan. Each names its own basis and none
borrows another's. Sharing a mechanism does not license sharing a claim, and
one announcement wired to every route briefly said the strongest of the three
on all of them.

Two things about the upgrade itself. A deployment publishes the new code
before the store is updated to match, so for a while — minutes in an ordinary
rollout — the code runs against the older shape — and a run that cannot record a withheld loan lets
the next run remind on it, which is the failure this memory exists to prevent,
arriving during its own upgrade. Recording is therefore written to succeed
against both shapes, and the platform asks the store which shape it has rather
than assuming. While the older shape is in use the report still names
withheld loans on the same terms as ever — up to its stated limit, with an
exact count of any beyond it, because a deployment is exactly when a
suppression most needs to be visible — but offers no removal command at all,
and says why: every such command names something the older shape does not
have, so printing one would hand a person an instruction that cannot run. The
enquiry that would hand back instructions for entries past the limit is
withheld there too, for the same reason.

It also does not promise how long that lasts. Asking the store establishes
only that the newer shape is ABSENT, never when it will arrive, and an update
that failed or was skipped leaves this indefinitely — so the report says what
to do with a second sighting: if the same message turns up on a later run, the
update did not land and wants looking at, because these entries cannot be
cleared safely until it does.

The safety value also had to become two values rather than one. The older
write shape cannot refresh the token, so a token on its own would go on
matching after a fresh sighting; the time of the sighting moves instead. One
narrow gap is left and is written down rather than implied — an older-shape
sighting in the same second as the one a person is holding moves neither
half — because closing it would mean pushing the recorded time forward on a
collision, which corrupts the one thing telling a person how long ago a record
was really made. And an entry written before the new safety value existed
carries an empty one; the report prints that in a form that can be pasted as
it stands, because an entry nothing ever re-examines — exactly the kind this
report is for — would otherwise be named and permanently unremovable by the
safe route.

The sweep that releases entries clears a limited number on each run and leaves
the rest for later ones, and that limit is not a matter of taste: the store
refuses a single instruction carrying more than a fixed count of supplied
values, and one that exceeds it fails the same way every run — releasing
nothing while appearing to work. The removal also re-checks, as it removes,
the fact that licensed it, because between finding an entry and removing it
the loan under that number can have been replaced by a live one. That is
exactly the reuse this whole change is about.

The count of how many entries are held and the list of them are also now read
in the same instant. Taken separately, a removal happening in between left the
report claiming entries that no longer existed — an "exact" figure that
described no moment that ever was.

Finally, the report's promises and its behaviour are now the same size. Three
separate rounds each bounded a different cost of the same report — the length
of the message, the volume handed back to the platform, and the work the
database does to produce it — and each was found only because the previous one
was fixed. The common cause was not the implementation but the claim: the
specification promised fixed work outright, so every review went looking for
the next place that was not fixed. It now says precisely what is bounded and
names the one thing that is not — establishing HOW MANY entries are held grows
with how many there are, and that is kept deliberately, because telling someone
"more than 200" when the true figure is three thousand hides the only number
that tells them how bad it is. A supporting index makes the page a bounded walk
rather than a sort of everything held.

A suppression a person can see and undo is worth more than an automatic release
built on evidence that has been wrong four different ways.
