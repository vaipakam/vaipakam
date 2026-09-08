## Thread — a census of grandfathered custody, and what it refuses to conclude (#1566)

Part of #1566 exists only to move four kinds of legacy custody out of a shared
balance. Whether that work is large, small, or unnecessary is an empirical
question — it depends entirely on whether any such holdings exist on the chains
already deployed — so this adds a read-only census that answers it, and commits
its output as an artifact rather than a claim. "The set was empty" is something
a later reader must be able to re-run, not take on trust.

The result: across all nineteen retained deployments on the five chains —
current contracts and the earlier ones a redeploy left behind — the census read
202 loans and found no holding in any category anywhere it could actually read
the records. Ten deployments are settled on that basis. Nine are not, and the
census says so rather than rounding them to empty: five because the one
function that would read the intent records is not installed on those
contracts, three because they are bare shells with no reading function at all,
and one because the address on record turns out to hold something that is not
the platform's contract. An earlier run had counted eighteen as settled on two
shortcuts since withdrawn; the contracts did not change, the standard of proof
did. The interesting part of this change is that it reports undetermined
instead of zero.

Most of the design here is about the ways a census can produce a comfortable
answer it has not earned. An all-zero result is indistinguishable by inspection
from a scan that read nothing, so each read path was first made to produce a
non-empty answer, and each proof of absence was checked for what it actually
proves. Three of those checks changed the outcome rather than merely
documenting it.

The first: the census reads live state where it can, and where the relevant
view is not present on a chain it falls back to proving the *producer* was
never reachable, using the chain's own record of every routing change it has
ever made. An earlier version treated "the view is missing" as proof by itself,
which is wrong — a component can be added, write state, and later be removed,
leaving records nothing can read. The second: that history scan came back
reporting *no routing changes at all* on two chains, which cannot be true of a
contract that exists, since every one records at least one when it is deployed.
That is now a hard refusal, and it is what turned one chain's result from
"empty" into "undetermined": its recorded deployment block yields no records at
that address, and the public endpoint used discards the history needed to find
the real one. The third: the scan is now pinned to a finalized block and
records that block's identity, not merely its height, and re-checks it
afterwards — a height alone does not identify what was read, and this artifact
is used to certify work away.

Two shortcuts the census briefly took were withdrawn after review, and the
reason is worth stating plainly. A contract holding no VPFI at all was at first
treated as proof that no holdings were recorded — but the design's own opening
reconciliation says the opposite can happen: a reward payout can spend the
tokens that back a recorded holding while the record itself survives, and a
zero balance alongside surviving records is the worst case, not an empty one.
The balance is now reported as *backing*, set against what the records claim,
so any shortfall is visible. Likewise, finding every relevant function absent
from a contract today says nothing about records written before those
functions were removed. Where the census cannot read the records directly, it
now says so.

What remains open is therefore not a history question at all — no amount of
history can prove a record absent, only refute a claim that it is — but a state
one: reading the record's storage directly, with the read first proven correct
against a contract where the ordinary view still works. That, and correcting
the one deployment record that names a contract which is not the platform's,
are the follow-ups.

Two further refinements changed what the census counts and what it will
believe. It now censuses every retained deployment on a chain, not one address
per chain: a fresh redeploy archives the off-chain record but cannot erase
on-chain holdings, so the previous contracts and anything they still hold are
part of the population. And every holding is filtered to the deployment's own
VPFI, since the four categories are specifically about VPFI sharing a balance
with rewards — a snapshot in some other collateral is outside scope and is
recorded as excluded rather than quietly dropped.

Because those archived records are deliberately kept out of version control,
the inventory the census works from is a committed manifest rather than the
local directories; a fresh checkout censuses the same nineteen deployments as
this one. The command that regenerates that manifest may add entries but will
refuse to silently drop any it already lists — on a fresh checkout, where the
local directories are absent, an unguarded rewrite would have emptied it and
made a five-deployment census look complete. Dropping an entry requires an
explicit override and is reported by name. One further guard: an address that
holds no code at the block being read is only treated as empty when that block
is known to be at or after the deployment; a read taken before the contract
existed proves nothing, and is refused or reported as undetermined instead.

Including the archived contracts also surfaced what an "archived deployment"
can actually be. Some are complete earlier versions of the platform; some are
bare shells where deployment was abandoned before any logic was installed; and
one recorded address turned out to hold an unrelated contract altogether. The
census now distinguishes these by what the contract itself says when asked: a
shell that has never had logic installed provably holds nothing and is settled
on that basis, while an address that answers like something other than the
platform is reported as undetermined with a note to correct the record. Before
counting anything it also checks the simplest facts first — whether code exists
at the address, and how much VPFI it holds — since either can settle a
deployment outright without reading a single loan.

The last point concerns what a chain's routing history can and cannot prove.
No amount of checking that a history looks complete can rule out a gap whose
net effect was nothing — an addition and removal both omitted — and such a gap
can hide exactly the holding being looked for. So where the relevant view is
absent, the census no longer treats a clean-looking history as proof. It reads
the one fact an endpoint cannot misreport by leaving something out: how much
VPFI the contract actually holds. Zero settles the question; anything else is
reported as undetermined.

Two claims were also corrected in the surrounding design. An empty population
retires the *migration* — there is nothing to move, and the shortfall question
that would have gone to the owner does not arise — but it does not retire the
protective changes that keep future holdings out of the shared balance in the
first place. Those producers are still live and can create a qualifying record
the moment after the census reads zero, so that work ships regardless.

Refs #1566, #1349, #1956
