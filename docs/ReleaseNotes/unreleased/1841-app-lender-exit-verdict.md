## Thread — The lender exit chooser asks the contract (PR #3024)

The lender's "your options" card in the app now takes its answer from the
contract's own sale verdict (PR #3008) instead of working it out. Each sale row
asks the contract whether this wallet may start that sale on this loan, and if
not, states the reason the contract gives. Before this the card rebuilt that
answer from the loan's status, its due date, any standing listing, the final-hour
listing window and the collateral type, each a copy of a rule the contract owns.
Those copies had drifted, and two refusals (a VPFI balance still held on the
position, a borrower's pending offset) were never shown at all. Both are now
reported.

Three states that are not an answer stay distinct and close both sale rows: the
check is still running, the check failed, or this network's contracts are older
than the verdict and cannot say. A reason the app has no wording for is still
shown as a refusal, by name, never as an open exit. Where the contract names the
earliest moment a refusal can lift, the row says so as an earliest moment, not a
promise. When the loan is past its due date the row says so ahead of any
narrower reason, as the spec asks, because nothing else can reopen a sale then.

What the card still decides for itself is only what the contract does not know:
the wait row, whether this deployment publishes the listing tool or has it
switched off, and whether the tools on this page have finished loading. The
canonical spec now states that availability is the protocol's answer, not the
app's.

Completes #1841, whose contract half was PR #3008. The verdict facet
reaches the testnets only with the all-waves fresh deploy, so until then those
networks show the "contracts can't yet say" line, and the live drive is owed
after that deploy.

> Caveat: the verdict is re-read every 30 seconds, so right at the due date the card can trail the Advanced sale tools (which use anchored chain time) by up to one poll. The tools' own checks still refuse.
> Caveat: a clear verdict does not cover the buy offer a direct sale would spend, the listing's own inputs, or a keeper's capacity charge; the tools check those.
