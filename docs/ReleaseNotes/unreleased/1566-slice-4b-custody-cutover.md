## #1566 slice 4 PR B — reward custody moves onto the dedicated address (PR #TBD)

The first slice-4 change bound a dedicated custody address per deployment
and left it dark. This change switches reward custody onto it: once a
chain's operator runs the activation ceremony — under the manual pause,
bound to the pause count the figures were established at, and only when
every position the address must back is backed exactly (the recycled
runway, the recovery position, the overage quarantine and, on a mirror, the
imported delivered headroom; a zero position takes no answer, a non-zero
one refuses without one) — every reward read and debit goes through the
address's attribution rows instead of the platform's own token balance. A
single-chain deployment with no reward role never activates and behaves
exactly as before, and a detached deployment waits for the era registry
that gives its inbound packets a rule. Backing a position ahead of the
activation waits for the paid-side migration whose result the figures
depend on, and a position that a moved figure leaves over-backed before the
activation can be released back to the platform's own balance, by at most
the excess, so nothing is stranded at the address. The canonical chain now bounds reward payouts by what
has actually been funded minus what has been paid, where funding is one
explicit administrator transfer into the address that credits the received
side in the same act (refused above the pool's lifetime cap), so a
canonical chain that has not been funded refuses claims and remittances
rather than paying them from other value; a funding that lands against a
paid-over-received deficit closes that deficit into a separate restitution
position and only the excess becomes headroom — a position with two
recorded exits, a correction of an evidenced accounting error or a release
to the treasury for a genuine deficit, and one that a demoted compensation
gives back in full. The reward token cannot be rotated while custody or any
of the old token remains at the address. The public backing snapshot gains
a versioned form that names the address's balance and attributions; the
mesh watcher reads only that form — a chain without it is reported as
unverified rather than judged by the older relation — and alarms exactly,
with no tolerance, when the address's balance stops covering its
attributions where custody has moved. Payouts leave the address by
their fresh and recycled components in one step, into a vault or a wallet,
and a failure after the tokens moved rolls the whole leg back before the
wallet is paid instead; absorptions re-attribute inside the address; user
fees and relocated custody move into it as they are credited; a
repatriation surplus leaves it; each outbound remittance names the custody
it draws on and is refused beyond the headroom before anything is approved.
Overage — value above any entitlement — gains a disposition to the treasury.
Reward-role changes are frozen from the first custody attribution until the
era registry lands, and a mirror's source is never rebound directly. The
activation is its own operator script with direct and staged forms; the
multi-chain refresh wrapper reports an unactivated chain as not ordinary
completion and runs the ceremony only when opted in. Stated as not in this
change: a delivery's unattributed remainder, a quarantined compensation and
a pre-attribution return still rest in the platform's balance, for the
cutover change that follows. Refs #1566, #1349, #1956.
