## Indexer — standing-offer candidates for the borrow preview

The platform checks one standing lender offer that a front end points it at, to show whether that offer beats the terms a borrower was quoted. It never says an offer is the best on the book. The indexer now answers `GET /offers/standing-candidates`, which lists the offers to point it at. These are the open lender offers on exactly the same pair and term, lowest rate first.

The list leaves out:

- the borrower's own offers;
- offers bound to a loan sale or offset;
- expired offers;
- offers the index has not yet read back from the chain;
- with an amount given, any offer whose open amount is not exactly that amount, because a direct accept lends an offer's whole open amount.

Every answer states that it is a candidate list and not a verdict. The platform's own check decides.

Part of #3720. Design: `docs/DesignsAndPlans/IntegratorFeeShareDesign.md` section 7.
