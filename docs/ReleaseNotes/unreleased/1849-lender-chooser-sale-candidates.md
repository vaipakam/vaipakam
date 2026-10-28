## Thread — The lender's exit chooser reads the sale tool's offer list (PR #<n>)

A lender holding an open position sees an exit chooser that names each way out, and in Advanced mode a sale tool below it that lists the standing lending offers the position can be sold into right away. The tool already worked out which offers qualify, but the chooser was never told: it kept its "sell now" option open and offered a jump to the tool even when the tool had just found nothing. The lender scrolled down to read that there was no match.

The page now works out the list once and gives the same list to both. With no matching offer, the chooser says so on the "sell now" option and offers no jump. It suggests listing the position instead only while the listing option is itself open; when the contract or this app refuses a listing too, it says only to check back later. While the search is still running the chooser waits, as it already did for its other readings. When the search could not be completed, the chooser makes no claim and leaves it to the tool, which says it could not load offers. An unreadable loan figure the payout depends on is treated the same way, never as an empty market.

The rules that decide whether an offer can buy the position now live in one place. The chooser carries no copy of them, so the two surfaces cannot drift apart.

Basic mode is unchanged on purpose. Finding the list means walking every open offer, which is not worth doing for every lender who opens a position page, so the Basic chooser still makes no claim either way and runs no offer search.

One small fix came with it: an offer search that failed outright used to leave the sale tool saying it was still looking. It now says the offers could not be loaded.

Closes #1849.
