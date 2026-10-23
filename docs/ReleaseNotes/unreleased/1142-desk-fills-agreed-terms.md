## Thread — Rate Desk fills show the terms they were agreed at (PR #<n>)

The Rate Desk's recent-loans tape, its "last agreed rate" header and the chart's per-fill markers read each loan's live terms. A loan's rate and term can be extended, and its outstanding amount falls as it is repaid or matched. So a past fill could appear at a rate it never traded at, with an amount smaller than was lent. An extended 30-day loan also left the 30-day tape and showed up in the 60-day one. The rate-history candles had already been fixed this way. The tape and header had not.

The indexer now files each loan in the tenor market it was agreed in, the same rule the candles use, and serves that market key on every loan row beside the agreed and live terms. A new index keeps the tape's newest-first paging cheap. The app turns a loan into a desk fill in one place, which keeps only the agreed rate and amount. When the indexer cannot confirm those from the loan's opening record, the tape and header say "not recorded" instead of showing the live terms. The chart then draws its per-bucket markers rather than per-fill ones.

The existing fields on the loan routes keep their meaning; the market key is additive. Closes #1142.
