### Keeper reads the swap-venue list in one request (#2488)

When the keeper builds a close-out route, it reads the Diamond's list of swap venues and, for each venue, its name and whether it is switched off. It used to read each name and each switch separately: two requests per venue on every route build, for both the liquidation and grace-default passes. With a long venue list, those reads alone could use up the request allowance a keeper run shares with its other duties.

The keeper now reads every venue's name and switch in one batched request. A route build's cost no longer grows with the number of venues. If that batched read fails, the keeper does not fall back to one request per venue. It treats the list as incomplete, which is what it is, and reports it that way. The app is unchanged.
