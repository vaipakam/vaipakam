## Thread — Three more protocol upkeep steps: tier exclusion, reward index, sanctions registry

The keeper's hourly protocol upkeep pass gains three steps, one for each of
three permissionless calls that nothing made on a schedule. Each ships
disarmed behind its own flag, needs the upkeep pass armed as well, and has no
cadence of its own. Each sends only when the chain's own reads show the call
would change something and a simulation shows it would succeed. None pays a
fee or moves value to the keeper. This advances #3097.

The tier-exclusion refresh pages through every loan the protocol has created,
of any status. It previews the refresh for a whole page and sends it only for
the loans whose fee-tier exclusion the preview shows would change. This is
what brings into line a loan that was already closed when the exclusion rule
was installed, since such a loan passes none of the events that re-derive it.

The reward-entry index compaction goes through the chain's loan parties a
slice at a time. For each party with reward entries it previews the
compaction and sends it only where the preview would retire a settled entry.
Entries settled by an expiry, a forfeit or a zero-value retirement otherwise
stay in a wallet's index until its own claim, which keeps that wallet's claim
and Claim Center countdown walking them.

For the sanctions-registry refresh, the issue had assumed the work was
already done by the reward sanctions observer and the prepay-sale sync. It
is only partly done. The observer writes the same registry entry, but only
for loan parties, only while its own flag arms it, and never while the
protocol is paused. The sale sync records a flagged recipient of a live
listing and never clears one. So the step re-screens every vault owner,
position recipient, protected-payout recipient, rewarded keeper and refreshed
wallet the chain's events name. It calls the refresh only where the oracle's
authoritative answer and the registry disagree. An address the oracle cannot
answer for is counted as not screened, never as clean.

The three ledger rows for these calls now name the upkeep pass and their
flags in place of the open gap.

> Caveat: a wallet the protocol has never dealt with, such as a first-time payee chosen by a vault owner, cannot be screened in advance; through an oracle outage it passes unless an earlier read recorded it, as the protocol's outage rule states.
> Caveat: a reward-entry index longer than one compaction examines, whose examined positions hold nothing settled, cannot be compacted by any bounded call; the run's line names such a wallet instead of reporting it clean.
> Caveat: the three steps share the pass's ten sends per chain per run and its one run window with the four steps before them.
