## Thread — Offers fill only once their terms have stood a few seconds (#3443, part of #3412)

An on-chain offer can now be accepted, matched or otherwise filled only once its terms have stood for a minimum age: 5 seconds by default, which an admin can change between 1 and 60 seconds. The age counts from when the offer was posted and starts again whenever its amount, rate or collateral is edited. The same applies to a lender intent, counted from when it was last set. This stops an offer from being posted, or re-priced, and taken in the same block. Doing that let one transaction fund both sides of a loan, farm rewards, or fake activity in the market-rate signal. The rule covers a direct accept, a match, an intent fill, a lender's direct sale into a standing offer to buy, and a borrower handing an obligation to a standing borrower offer. Previews report a fill refused for this reason as its own case, so an app can say the offer becomes available within seconds.

The age is measured in seconds, not blocks, because block times differ between chains. Its one-second floor still guarantees a later block on every chain. A signed offer has no on-chain posting time, so the rule does not apply to it. It stays bound by its own signature deadline and by the taker's signed acceptance terms.

The deadlines that already existed now share one rule and one refusal: the deadline on an acceptance, a signed offer's signature deadline, and a lender's bounded direct sale. A deadline that has passed reverts `DeadlinePassed`, and a missing required deadline reverts `DeadlineRequired`. This replaces four separate error names. Deadlines on the remaining price-exposed actions follow in the next part of #3412.

The keeper's fill of a signed offer against an on-chain offer (`matchSignedOffer`) moved to a facet of its own, `SignedOfferMatchFacet`, because the new checks took the matching facet over the contract size limit. The function, its event and its errors are unchanged for callers; only the code host moved.

> Caveat: this reaches the testnets at the next fresh deploy. The new fields are appended to the offer and the lender intent, and offers posted before it carry no age.
