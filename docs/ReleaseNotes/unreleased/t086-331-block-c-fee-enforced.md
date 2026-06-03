## Thread — T-086 Block C v1.1 — fee-enforced collection support (#331) (PR #<n>)

Closes #331.

Extends the OpenSea-offers Match flow to NFT collections that
enforce OpenSea protocol fees and/or creator royalties. Block C
v1 (PR #328) shipped Match against fee-free collections only;
fee-enforced collections rendered an informational banner in the
panel slot instead of the offers list.

**What changed structurally.** The section's fee gate flipped from
a tri-state enforcement verdict (`'unknown' | 'fee-free' | 'fee-enforced'`)
to a typed fee-schedule cache. The same polled
`/opensea/collection/{slug}` response now drives two things instead
of one banner: (a) threshold scaling inside `useOpenSeaOffers` so
offers are classified acceptable against the post-fee borrower
remainder, not the gross; (b) at Match-click, a confirm-time
re-fetch of the schedule and `computeFeeLegs(schedule, offer.value)`
to build the on-chain `FeeLegInput[]` for `updatePrepayListing`'s
`feeLegs` calldata.

**The acceptability threshold is now closed-form**, derived from
the borrower-remainder-non-negative + protocol-leg-buffer
constraint:

> `offer.value × (10000 - feeBpsTotal) ≥ (lenderLeg + treasuryLeg) × (10000 + bufferBps)`

For fee-free (`feeBpsTotal === 0`) the form collapses back to the
v1 baseline; for fee-enforced (`feeBpsTotal > 0`) the threshold
auto-scales so the panel only greenlights offers whose gross-minus-
required-fees still covers lender + treasury + buffer. Threshold
math uses ceiling integer division so the compare rounds toward
the conservative direction (rejects borderline-unacceptable rather
than admits them).

**Match-time re-fetch keeps fee math fresh.** §15.3 step 5
explicitly forbids using a session-cached schedule at confirm
time — a fee row's `basis_points` or `recipient` can rotate
between panel-mount and click, and a stale snapshot could
under-compute the now-required amount (causing OpenSea-side
rejection at re-publish) or route to a recipient OpenSea has since
deprecated (draining the borrower's remainder to a dead address).
The new flow re-fetches on every Match click, recomputes feeLegs
against the offer's actual gross, and only commits to
`updatePrepayListing` when the fresh schedule still places the
offer above the scaled threshold. Failures (network error, non-2xx
upstream, parse errors) fail closed: the cache is invalidated, the
gate closes on next paint, and the borrower retries.

**Shared parser** lives at
`apps/defi/src/lib/openseaFeeSchedule.ts` and is consumed by the
section's mount poll and its confirm-time re-fetch. Same shape
will plug into the post-listing flow's fee-leg picker as a
follow-up (today's `PrepayListingActions` ships empty `feeLegs[]`
on `postPrepayListing`, which means fee-enforced collections still
fail at the initial OpenSea publish step — the first Match rotation
through #331's path is what produces a correctly-shaped
multi-leg order). That post-side gap is tracked as the natural
continuation of the original #313 follow-up.

**Fee-free regression-tested via type collapse.** The threshold
math, the schedule parsing, and `computeFeeLegs` all reduce to
their v1 behaviour when the parsed schedule has no required fees
— same wire shape, same acceptance gate, same empty `feeLegs[]`
into `updatePrepayListing`. No code path was deleted; the fee-free
case just becomes an instance of the more general flow.

**Operator action post-merge:** none. The change is dapp-only; no
contract surface, no new selectors, no migration. The existing
`OPENSEA_API_KEY` + `OPENSEA_OFFERS_RATELIMIT` bindings on the
agent are unchanged.
