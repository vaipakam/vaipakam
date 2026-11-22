## Thread — Public rate curve: history and public read (indexer)

The indexer now publishes a rate curve for each lending asset at 7, 30, 90, 180 and 365 days, through two public reads: the current curve and one point's daily history. Each answer carries two halves side by side and labelled apart: the outside-source term average the rate reference reports, and a figure built from the platform's own loans. The two are never blended into one number, and every answer says the figures are observed averages, not advice, a forecast or an offer.

The platform's own figure follows the standing rule in TermAverageAndLinkGuardsDesign.md §8, with the settings the design thread gave: only loans closed by repayment, each weighted by the interest actually paid on it (read from the settlement and interest-booking events the indexer already records), unconfirmed terms and loans under three days old left out, one wallet capped at a fifth of the weight on each side, at least five distinct lenders and five distinct borrowers per point, and a quartile band rather than a mean. It also applies the counting rule every public figure follows: a loan whose opening named the same address as lender and borrower, or whose opening parties the index cannot establish, is left out and counted on its own line at each point, and a later sale or handover moves a loan neither in nor out. The rule cannot see two addresses that belong to one person, and each answer says so. Each point covers a stated range of loan durations and looks back over the larger of 90 days and twice its term. Every setting is stated in each answer, so the page's "how this is computed" note reads them rather than restating them.

An hourly pass writes one row per asset, point and day into a new history table, recomputing today and yesterday and filling up to seven missing earlier days each run, so the history rebuilds itself after a restore or a fresh deploy. The reads only read stored rows, are cached for five minutes, and sit behind a new per-caller request limit that refuses when it cannot count.

The outside-source half reports "not published" on every deployment for now: the rate reference's term-average view (#3713 with #3337 part 1) is not built yet. When it is, the pass reads it into the same columns and the answer's shape does not change.

> Caveat: interest paid through a refinance payoff, a swap-to-repay or a partial repayment is not yet counted toward a loan's weight, because those routes report no interest figure the indexer can read; such loans weigh less than they should or drop out. The answer names these routes.
> Caveat: all settings are provisional and await real readings.

Advances #3751.
