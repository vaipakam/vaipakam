## Thread — a loan's rewards never exceed the initiation fee the platform kept

Once the reward cutover is armed, a loan's interaction rewards are
bounded by the initiation fee the platform actually kept from that loan. Each side's lifetime reward cap is
half of the lower of two figures, after the reward haircut recorded when
the loan opened: the notional tariff the cap already used, and the kept
fee. So on the days the cap binds, both sides together can never earn
more than the kept fee less the haircut, whatever hold discount the
borrower had and whoever collected a share of the fee.

The kept fee is the fee actually charged after the borrower's hold
discount, less every share actually paid to someone else (the matcher, an
integrator, an inviter). The parts that go to the treasury and to the
reserve both count as kept. It is not recalculated: the loan records what
the fee host measured as received for this loan's initiation fee, in the
same acceptance (never more than the amount handed to it), and prices it to the numeraire with the same conversion
the notional tariff uses. The record is stamped once and never re-read
from live settings; early-close proration of the cap is unchanged.

A loan whose kept fee is zero has a reward cap of zero. There is no floor.
The same stamp runs on the canonical chain and on mirrors.

Where the bound applies, stated plainly: the cap binds only on reward
days after the reward cutover is armed, and only for a loan whose fee
record was stamped when it opened. The cutover is not armed on any
deploy, so today the cap is recorded but binds on no day. Reward days
before the cutover keep the old rules, and a loan with no stamp (a rental
or a sale vehicle, for example) carries no loan-side cap at all. Arming
the cutover requires every reward-eligible open loan to be stamped first.

The loan's fee record now carries the kept fee in the lending asset and in
the numeraire, the stamping event carries the numeraire figure, and a new
read reports the notional tariff, the kept fee, each side's cap and which
of the two figures binds. A fallback that rebuilt a missing cap from the
notional tariff alone was removed, since it would lift the new bound; the
platform is deployed fresh, so no record needs it.

Closes #3360
