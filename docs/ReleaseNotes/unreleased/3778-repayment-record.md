## Indexer — the repayment record

The indexer now answers `GET /repayment-record/{address}`. It gives a count of what one address did on this platform as a borrower or renter, taken from the platform's own events. The count covers:

- loans held to the end, and how each closed: repaid on time, repaid after the due date, repaid by a sale of collateral on the holder's own route, refinanced, liquidated or defaulted;
- loans the rules cannot place, counted as unclassified rather than guessed;
- loans open now;
- interest periods closed without a sale, and those collected by a sale;
- interest paid, per token;
- rentals;
- the first loan;
- how many of the closed loans the address opened, and how many it took over.

It is not a score. No figure is combined with another, ranked or coloured. Every answer carries the block it is true as of, the version of its rules, where its history begins, the four statements every view must show, and what it leaves out.

Timing comes from time, not from the late fee alone. A full repayment counts as on time when it is not after the late-fee start that the repayment event states. Until that event carries the late-fee start, a repayment with a late fee counts as late. One made no later than the due date stated at the loan's start counts as on time. Any other repayment is unclassified.

A loan counts for the address that held the borrower position when the loan closed. A payment by someone else counts for the holder. The vehicle loan a lender's sale creates is left out.

The fees paid to the platform are not stated yet, because the events do not state each loan's fees. The answer says so instead of showing a partial sum.

The record is also the public data feed's eleventh route, `/public/v1/repayment-record/{address}`, in the feed's envelope. It is the only feed route that takes an address, and it answers for one address at a time: no feed route lists, ranks, searches or filters addresses by their record. The feed's table test now asks a sharper question than before. Every table a feed route reads must be one the indexer rebuilds from the chain alone, never one born off chain or mixed.

The rules are in `docs/RepaymentRecordDerivation.md`. The app's views are separate work.

Part of #3778. Design: `docs/DesignsAndPlans/RepaymentRecordDesign.md`.
