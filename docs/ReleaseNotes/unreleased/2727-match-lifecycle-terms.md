## Thread — a match admits only offers that chose the same loan terms (PR #TBD)

A permissionless match pairs a lender offer with a borrower offer and opens
one loan binding both of them. Until now the match compared assets, duration,
amount, rate and collateral, but not the lifecycle terms each party chose: the
interest mode (full-term or pro-rata), whether partial repayment is allowed,
whether a prepay listing is allowed and the periodic-interest cadence. The
loan took those terms from the lender offer, so a borrower who had asked for
pro-rata interest, or a lender who had refused partial repayment, could find
themselves in a loan on the other side's terms without having agreed to them.

A match now admits only a pair that agrees on every one of those terms, and,
for an NFT rental, on the asset the rental fee is paid in. A pair that differs
is refused with a new lifecycle-terms reason, by the match and by the bot-facing
match preview alike, so matching bots skip the pair instead of spending gas on
it. Whether the borrower allows a parallel sale of their open offer is not a
loan term and is not compared. A standing lender intent stands for full-term
interest with no partial repay, no prepay listing and no periodic cadence, and
the intent fill now records full-term interest on its slice, so the same rule
holds on that path. Direct acceptance is unchanged: the accepting party takes
the offer's terms as written.

The new refusal reason is appended after every existing one, so prior reason
codes keep their meaning. Closes #2727.
