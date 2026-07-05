## Thread — wallet-prompt roadmap reaches the rental flows

The signing-transparency treatment shipped for the offer flows now
covers both sides of NFT rentals. Listing an NFT pre-discloses its
one or two confirmations (the one-time collection permission — named
as such, and dropped from the list when it already stands — then the
listing transaction). Renting pre-discloses its two to four
confirmations: the free terms signature, the prepayment approval
(with the two-confirmation reset case and the "still checking"
uncertainty state named honestly), and the rental transaction. Both
buttons report live position — "Signing terms… (1 of 3)",
"Approving… (2 of 3)" — while the sequence runs, and both submissions
carry the same double-click guard the offer flows gained.

Remaining under the same card: the repayment and VPFI deposit
surfaces (two-prompt flows) get the staged labels next.
