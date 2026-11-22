## Thread — reward broadcasts and tier pushes accepted only from Base

A mirror chain now checks which chain a reward message came from before
acting on it. A day's finalized broadcast, a user's tier push and a
tier-table version bump are each accepted only when the source chain the
messenger reports is the canonical chain the mirror is configured
against. Before this change the tier receivers checked the source but
the broadcast receiver did not: any peer the messenger authenticated,
another mirror included, could have delivered a day's global figures.

The rule now lives in one place and both paths use it, with the kind of
traffic as part of the rule. A mirror accepts both kinds from its
configured canonical chain. A chain that has detached accepts a day's
broadcast only from the canonical chain it detached from, so a day
already in flight when it detached still lands; it accepts no tier push
or tier-table bump at all, and such a message stays a failed message
that can be re-executed. A canonical chain and a chain with no reward
role accept none of these messages.

The broadcast receiver's interface now carries the source chain, which
the reward messenger already knew and now passes on. A new public read
reports, for tier traffic and for the day broadcast separately, the
chain a Diamond accepts it from, or zero when it accepts none.

Because the messenger now calls its Diamond through a different entry,
the reward messenger's published wire generation goes up by one. The
all-facets refresh upgrades a messenger whose generation is below the
build's, so a refresh installs the new messenger alongside the new
receiver; otherwise every day broadcast on a refreshed mirror would be
refused as an unknown function.

The next deploy is fresh, so no running chain has to cross this change
in place.

Closes #903
