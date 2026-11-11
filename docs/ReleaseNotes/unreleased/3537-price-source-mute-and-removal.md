## Price guard — the guardian's instant price-source lever is stop-only (PR #<n>)

The guardian (the Pauser Safe) could switch off a secondary price source at
once. The price guard accepts the primary price alone once no secondary
source is available, so switching off the sources that disagreed with the
primary turned a refused price into an accepted one, instantly. Every price
the platform uses goes through the guard, so that was a fast way to loosen
loan creation, health factors and liquidations, not only to stop them.

The lever is now split in two. The guardian or the owner may **mute** a
source at once: a muted source no longer approves a price, but it still
refuses a price it contradicts. A mute can therefore only refuse more prices;
it is the right tool against a source that is approving a wrong price.
**Removing** a source also drops its refusals, so it waits a fixed 48 hours
after it is proposed, on every chain. The source is muted from the moment the
removal is proposed, anyone may execute the removal once the wait ends, and
the owner or the guardian may cancel it before then. That is the tool for a
source that is broken and refusing good prices: an asset it contradicts stays
refused for at most 48 hours, the same window as a Timelock unpause.

Turning a muted or removed source back on still waits the guard's own delay
(7 to 14 days on a production chain). A mute or a removal proposal cancels a
pending re-enable, and a re-enable that lands first drops a removal still
waiting. The count of agreeing and disagreeing sources the guard reports now
follows the same rule: a muted source's agreement is not counted.

We chose this over the issue's first plan (an instant disable allowed only
while another source stays enabled) because that floor counts sources, not
answers: a remaining source with no price for a given asset would still have
left that asset on the primary alone, at once.

The price guard cannot be upgraded, so this reaches each chain with its next
fresh deploy.

Closes #3537
