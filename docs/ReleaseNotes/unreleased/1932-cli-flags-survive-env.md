## What an operator types on the command line now beats what a config file says (#1932)

The deployment scripts read the operator's command-line options first and then
load a shared settings file. Anything that file mentioned quietly replaced what
had just been typed. That worked in both directions: an option nobody passed
could arrive switched on because the file said so, and an option that was
explicitly passed could be thrown away because the file said otherwise.

Most of the affected switches are the ones that exist precisely because somebody
has to make a deliberate decision — which stage of a deployment to run, whether
to wipe an existing deployment and start over, whether the operator has reviewed
the live state a destructive step is about to abandon, whether the signing device
is the hardware wallet the process requires. Several of those are written into
the deployment record afterwards as evidence that the confirmation was given. A
stored setting supplying one of them would produce a record of a confirmation
nobody made.

An earlier change fixed exactly one of these switches. This one covers the rest,
and does it in a single place rather than switch by switch, so there is one rule
instead of eight copies of it.

Because that fix is a list of names, the list can fall behind the options it
protects — which is how the first fix left seven of them exposed. A check now
compares the two and refuses a deployment if they have drifted apart, in both
directions: an option missing from the list is the original problem returning,
and a name in the list that no option sets is protection for something that no
longer exists, which makes the list look more complete than it is.

Review then took the whole approach apart, three times over, and the answer
turned out to be much simpler than any of the attempts.

The settings file was never being read — it was being run. Everything in it
executes as instructions inside the deployment itself. So each attempt to let the
operator's choices win after loading it failed for a new reason: the file could
switch off the safeguards, make a value permanently unwritable so restoring it
failed, replace the command used to restore, or — the one that ended the argument
— simply supply a different command line, replacing what the operator typed
before it was ever read. Ordering could not fix that, because the file gets to
speak first either way.

The settings file is now read as data. Each line is taken as a name and a value
and nothing else; nothing in it can run. A line that is not a plain setting stops
the deployment rather than being skipped, because a skipped line is a setting the
operator believes is in effect and is not. Every attack found during review is
now either refused outright or stored harmlessly as text — including one that
tried to create a file, which no longer happens. A side benefit: values containing
a dollar sign, which is common in URLs carrying access keys, now survive exactly
as written instead of being partially expanded.

All four operator scripts that read the file were switched over, including one
nobody had raised and the local development playground, which had briefly been
made to require production settings it does not need.

Reading it as data turned out to be half the answer, and review caught me
treating it as the whole one. Not running the file stops it from rewriting the
command line, but it does nothing about an ordinary setting quietly replacing a
choice the operator made — which is the problem this started as. Having removed
the ordering on the grounds that it no longer mattered, I put it back: settings
are read first, choices are read second, so what was typed is applied last.

Then a stricter idea — allow only settings the platform documents, refuse
everything else — was built and withdrawn, which is worth recording because it
was withdrawn on evidence rather than taste. Checking mechanically what the
deployment actually configures turned up sixty settings it would have refused:
the artwork for position tokens, the test-token faucet, vesting, governance
roles, liquidation routing, and the wrapped-ether address on every chain. Each
one stops a documented step. Review had found two of those sixty by reading, over
two rounds, so shipping the rest would have meant finding them one failed
deployment at a time.

What remains refused is the small set of settings that some other program treats
as an instruction to run something at start-up. That set is open-ended and the
change does not pretend otherwise; the wider work of closing it everywhere,
including in the written operator procedures that still execute the file, is
tracked separately. The reasoning for the split is the threat it defends against:
the file already holds the deployment's private key, so anyone able to edit it
has no need of a start-up trick. The problem this change was filed for is a stale
or shared file, and that is closed.

The check that keeps this honest asks one question — does any script execute the
file — and nothing else. Earlier versions of it tried to reason about where each
script reads its options, and every one of them certified something it was written
to prevent: one looked at a single style of option, one looked at only two of the
scripts, one could be walked around by writing the option parsing differently, and
one fired on nineteen ordinary lines because a full stop inside a printed sentence
looks exactly like the shell's own load command. A question with no moving parts
has nowhere to be wrong in either direction.

An earlier draft of this note, and of the specification, described a different
check — one that compared a list of protected options against the options each
script accepts. That check was removed when the approach changed, and both
documents kept describing it. They now describe what is actually there, which
matters more than usual here: this work exists because documentation that had
quietly stopped matching the code cost real time.

A last correction came from the repository's own guard rather than from review.
Two settings are documented as harmless to leave lying around — the deployment
forces them off itself — and the stricter reading would have turned that
documented harmlessness into a refused deployment. They are recognised, and the
forcing is what keeps them from deciding anything. A hardening change is not
allowed to break a behaviour the documentation guarantees.

Nothing changes for an operator who was not relying on the settings file to
supply these switches, which is everyone following the documented process.
