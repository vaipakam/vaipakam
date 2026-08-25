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

Nothing changes for an operator who was not relying on the settings file to
supply these switches, which is everyone following the documented process.
