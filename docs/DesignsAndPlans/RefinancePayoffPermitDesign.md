# Refinance payoff by single-use Permit2 permit (#1558)

## Decision

Owner decision (2026-10-28), verbatim: "pay the refinance payoff with an
exact-amount, single-use Permit2 signature, in the contract and the app. No
standing allowance remains after a refinance. Anyone, the keeper included, can
still submit a signed permit until it expires, and an unused permit simply
lapses."

Follow-up decision (2026-10-29, "Merge now"): the change merges once review
converges rather than waiting for the all-waves fresh deploy. Until that deploy
the app keeps the earlier approval route wherever the Diamond does not route the
new call. That fallback is a temporary bridge, disclosed in the code and the
spec, and #3074 removes it after the deploy.

## The problem it removes

A refinance completes in a transaction the borrower does not send: a lender
accepts the request, a matcher fills it, or a keeper submits it. The old loan's
payoff is drawn from the borrower's wallet at that moment. Before #1558 the only
way to let someone else's transaction draw it was a standing ERC-20 allowance to
the Diamond, granted when the request was posted.

That allowance had three faults, each a fund-transparency problem:

1. It had to cover the worst case, the payoff at the end of the grace window, so
   a refinance that completed earlier left the difference approved.
2. A request that never filled left the whole allowance standing. The app could
   not safely revoke it on the borrower's behalf, because a counterparty's
   acceptance might be in flight.
3. One allowance per token was shared by every request the wallet had on that
   token, so the app had to keep a mirror of which request needed how much, and
   that mirror could disagree with the chain.

## The design

**Who signs what.** For each refinance request the borrower signs a Permit2
`PermitWitnessTransferFrom` with the Diamond as spender, the loan's principal
asset as token, a maximum amount, a deadline and a random unordered nonce. The
witness is `RefinancePayoff(uint256 loanId, uint256 offerId)`, so the signature
pays off exactly this loan through exactly this request. A submitter who can
hand the Diamond any permit still cannot spend it on another loan or request.

**Where it lives.** `RefinancePayoffFacet.setRefinancePayoffPermit` stores the
permit with the request, keyed by the request's offer id. Only the request's
creator may set it, and only on a borrower offer. `clearRefinancePayoffPermit`
removes it (keyed on the stored signer, so it works after the offer itself is
cancelled). The signature is checked by Permit2 when it is used, not when it is
stored.

**The pull.** `RefinanceFacet`'s settlement calls `LibRefinancePayoff.pull` once
for the whole payoff: the exiting lender's due plus the treasury fee. It refuses
by name when the permit is missing, signed by someone other than the current
borrower-position holder, smaller than the payoff, or expired. It deletes the
stored permit before the external call, then Permit2 verifies the signature,
burns the nonce and moves the exact payoff (not the maximum) into the Diamond in
one measured pull. The treasury share and the lender share are sent on from
there. On the atomic accept-and-refinance routes a refusal unwinds the whole
acceptance, so nothing is stranded. Every route (direct accept, matcher fill,
the borrower's standalone `refinanceLoan`) pays the same way, because the pull
sits in the one settlement they share.

**Sizing.** `getRefinancePayoff(loanId, offerId, by)` reports the payoff now,
the payoff at the moment `by` (capped at the loan's grace end; a past `by` reads
as now), and the stored permit with whether Permit2 has spent its nonce. The
payoff rule is one function, `LibRefinancePayoff.amountAt`, which the settlement
also prices with, so the view and the pull cannot disagree. The app sizes the
maximum to the payoff at the request's last fillable moment (the earlier of one
second before the request expires and the grace end) and sets the deadline to
that same moment, so the permit pays every acceptance the request allows and no
more. The maximum is a ceiling; the pull takes the exact payoff at acceptance.

**The token approval.** The wallet approves Permit2, not the Diamond, for the
signed amount. Permit2 moves nothing without a matching signature, so that
approval cannot be spent by anyone on its own. The Diamond holds no allowance
over the borrower's wallet at any point.

**Lapse.** An unused permit expires at its deadline, which is never later than
the request's own end. Cancelling a request leaves nothing to revoke; the
borrower may also clear the permit or spend the nonce in Permit2 directly.

## Facet placement

`RefinanceFacet` sits close to EIP-170, so the permit's setters and view live on
a new `RefinancePayoffFacet`, and only the pull stays in the settlement. The two
carry one behaviour: a `RefinanceFacet` refreshed without the host cannot be
paid (its settlement refuses every refinance for a missing permit), and a host
without the new settlement stores permits nothing reads. They are refreshed
together, and `RedeployFacets` refuses a Diamond that does not already route
`setRefinancePayoffPermit` (`PredatesRefinancePayoffPermit`).

## The app

- **Single request.** After the request is posted the app approves Permit2 if
  needed, asks the borrower to sign, and attaches the permit. Posting replaces
  the form with the request's card, so the signing progress and its outcome
  (attached, sent but unconfirmed, or failed with the reason) are held by the
  page and stated on that card. A signing refusal leaves a posted request with
  no permit; the card says so and offers to sign again.
- **Permit2 approval.** Raising an existing approval resets it to zero first
  (some tokens refuse a non-zero to non-zero approve). If the raise then stops
  while the reset stands, the app puts the prior approval back, since another
  live request's permit may draw on it.
- **Batch.** "Refinance all" posts the requests, then signs one permit per
  posted request and attaches them in one multicall. The outcome per loan says
  whether its permit is attached.
- **Pending card.** It reads the stored permit and names what is wrong with it:
  missing, spent, expired, lapsing before the request does, smaller than the
  payoff the request can reach, or the wallet's Permit2 approval too small.
  Cancelling a request revokes nothing, because nothing standing was granted.
- **Bridge (#3074).** `readPayoffRoute` checks whether the Diamond routes
  `setRefinancePayoffPermit`. Where it does not (a deployment that predates
  #1558), the app keeps the earlier approval route and its mirror of the
  allowance each request needs. The bridge exists only until the all-waves
  fresh deploy, and #3074 removes it.

## Test coverage

- `RefinanceFacetTest`: the pull on each route, refusals by name, the
  `payoffBy` view, and a real Permit2 runtime with a signed witness permit.
- App unit tests: the typed data hashes to the digest Permit2 builds from the
  contract's own witness type string; the last-fillable moment; every permit
  problem.
- E2E spec 29: the permit is attached after posting, sized at or above the
  payoff at its deadline, leaves the Diamond allowance unchanged, and is spent
  by the accept.
- Fork scenario 06 and the positive-flow scripts attach the permit before the
  refinance runs. `anvil-bootstrap.sh` now installs Permit2 at its canonical
  address so local Anvil can refinance at all.
