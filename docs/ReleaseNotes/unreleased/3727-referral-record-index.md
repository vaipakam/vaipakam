## Referral record in the indexer (#3727)

The indexer now records the two referral events the contracts publish: a
wallet binding its inviter, with the end time the contract fixed for it, and
each loan whose initiation fee carried a referral cut or share, with where
the share went.

A new read, `/referrals/by-inviter/<address>`, gives an inviter's page its
data for one network: the wallets that bound it, the shares paid to it loan
by loan with a total for each asset, and the shares that went to the reserve
with the reason the event gave. It states the block its figures are current
to, says when a list is cut short, and withholds a total it could not sum in
full rather than show a partial one. Amounts in different assets are never
added together.

The page shows only what the events state. It never works out a wallet's
end time from today's period setting and never gives a redirect a reason the
event did not give. An outcome the indexer does not know is skipped and
logged rather than recorded under a guessed reason.

Part of #3727; the app page follows.
