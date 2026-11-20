## Indexer, agent and app fixes — offers for a named loan stay off the book

A borrower can now post an offer for one named loan, which only that loan's obligation handover can consume. Accept and match refuse such an offer, so it is never borrow demand that a lender can fill.

The indexer records which loan such an offer names, from the event announcing it, in a new column (migration 0117). The book page, the market list, the nearest-opposite read and the offer counts leave these offers out, as they already leave out sale and offset vehicles. The offer record carries the loan as `takeoverLoanId`.

The app's order book leaves them out too. When it reads the book from the chain it asks each borrower offer whether it names a loan. If that read fails, the offer stays in, and the accept preview then gives the refusal by name: "This request is reserved for taking over a named loan, so it can't be accepted or matched." The creator's Open orders still list the offer, so it can be cancelled there. The activity feed labels the event "Takeover offer posted".

Advances #3845. The screens for posting such an offer and for picking one at handover are still to come.
