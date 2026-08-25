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

Review then found two ways the first version of this fix still failed, and both
are worth recording because they are the same mistake in different clothes.

The protection was itself stored in ordinary settings, so a settings file could
switch it off — naming a shorter list of things to protect left everything else
exactly as that file wanted it. The mechanism was inside the blast radius of the
thing it defended against. It is now fixed in place, so a settings file trying to
touch it stops the deployment outright rather than quietly disarming it.

The other was the chain itself. Which network to deploy to is typed on the
command line like everything else, but it was not on the list — and a settings
file overriding it produced the worst possible outcome: the parts resolved before
the file was read stayed on the network the operator chose, while the parts
resolved afterwards moved to the other one. A deployment could then check one
network's records while preparing to act on another, which is precisely the check
that stands between a redeploy and wiping a live deployment. The check that keeps
the list honest now knows about the chain argument too, so this omission cannot
be recorded as compliant again.

Nothing changes for an operator who was not relying on the settings file to
supply these switches, which is everyone following the documented process.
