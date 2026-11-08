## Thread — Refinance requests post the request their review described (PR #PRNUM)

Posting a refinance request from the loan page always failed with "This offer's terms changed since you reviewed it". The review quoted the payoff ceiling at the request's last fillable moment, which it took from the chain time the page last read, plus the 30-day request window. The send then worked out the request's expiry again from the newest block, a few seconds later. While a loan accrues interest and the request's last fillable moment is still before the grace end, a later deadline means a slightly larger ceiling, so the guard against a grown ceiling refused essentially every send. A live drive on Base Sepolia loan 3 hit exactly this. The batch "Refinance all" late re-check had the same flaw.

The review now fixes the request it describes. The expiry it was quoted at travels with the figures shown, and the send checks, signs and posts that same request: the payoff ceiling, the permit's maximum and deadline, the guardrail window and the request's own expiry all come from it. A send therefore refuses only when something real changed: the loan, the fee configuration, the payoff route, or a ceiling that grew at the reviewed deadline. The time between review and send no longer counts as a change.

A fixed expiry only gets closer, so a review now has an age limit: 10 minutes of chain time, measured against the latest block's timestamp and never the device clock. Past that, the send refuses with a new message asking for a fresh review, and the page refreshes its figures. Ten minutes covers reading the receipt, giving consent and approving the wallet prompts. In a long batch, the last loans can reach the limit and are then left out, each with that message.

Because the request's window now counts from the review, the receipt says it expires "30 days after this review" instead of "after posting", so the disclosure matches what the chain records. Both new strings are translated in the nine translated locales.

The live refinance drive now anchors the borrower's time-stamped fields on the block it reads before the borrower page loads, which is the review's chain time, instead of a block read at submit. The permit deadline it expects is still derived from the expiry the posted request actually carried.

Closes #3311
