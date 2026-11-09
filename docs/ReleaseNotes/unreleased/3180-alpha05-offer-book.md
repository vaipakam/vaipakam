## Thread — The next app shows the offer book and lets you take an offer from it (PR #3390)

The Offers page in the next app now carries the offer book under your own offers, readable with or without a wallet. It lists every open offer the protocol's index has recorded on the network, newest first. Older offers load a page at a time. Tabs split loans of a token from NFT rentals, a filter picks lenders' offers or borrowers' requests, and a connected wallet can hide its own offers. The count line says how many offers have been read so far and whether older ones remain, so a filter is never mistaken for the whole book.

The index can lag the chain and only suggests what to look at. Rows carry no buttons. An offer the index still lists although its expiry has passed is tagged as expired, which anyone may clean up. Refinance requests, sales of a running loan, early-close offers and offers whose bound position moved are tagged by kind. A row the app cannot read is counted, never silently dropped. If the index cannot be read, the book says so instead of showing an empty list.

Each offer opens its own page, which reads the offer from the chain at one block, wallet or not. It shows the side, who posted it, the amount, what is already filled, the collateral, the term and when the offer lapses, and what a refinance request, loan sale or early close would do. From that read:

- An open loan offer of a token against token collateral can be taken whole, through the same review, consent and Terms step as Borrow and Lend.
- The creator can cancel their own open offer, and anyone can clean up an expired one, through the existing cancel flow.
- Rentals, offers with NFT collateral, loan sales and early-close offers say they are taken in the current app for now, and link to it.

An offer whose terms the protocol no longer holds is described as exactly that: either it was cancelled before anything filled it, or no offer with that number was ever posted. The protocol does not say which. An ended offer says how it ended. Your own offers on the page now link to their offer pages too.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-OFFER-BOOK and RB-OFFER-PAGE. Epic #3180.
