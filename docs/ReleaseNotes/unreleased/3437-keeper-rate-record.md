# Keeper records rate-priced tokens' rates every hour (#3437, #3683)

A rate-priced token, such as a wrapped or yield-bearing token valued as an
exchange rate against what it wraps, is priced from the rate the price guard
has accepted. That rate rises only by the binding's daily bound for the time
since it was last recorded, so a rate nobody records stops following honest
growth and the collateral is valued too low (never too high).

The keeper's price checkpoint duty gains a step that records every such
rate about once an hour. Because a loan keeps the binding it opened under,
the step records every binding a token has ever had, learned from the
guard's own registration records up to the finalized block. Each run names
what it recorded, any rate the guard distrusted or is observing after a
fall, any binding the guard holds no state for, and anything it deferred.

The step is permissionless, moves no value, pays only gas and ships switched
off behind `RATE_RECORD_ENABLED`, inside the price checkpoint duty.
