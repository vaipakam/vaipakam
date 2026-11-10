## Thread — alpha05: repaying in grace counts down to the end and says to send early (PR #TBD)

When a borrower repays a loan that is past its due date and in its grace period, the repayment review in the new app (`apps/alpha05`) now counts down to the end of grace. It says that after the end the protocol refuses a repayment and anyone can file a default, and that whichever transaction is mined first wins, so the repayment should be sent well before then. Paying part of a loan shows the same clock.

The countdown runs on the chain's clock, not the reader's: the block time the review read plus the time since. With an hour or less left it says to send now, because a repayment still waiting to be mined when grace ends is refused with nothing moved. If the clock passes the end while the review is open, it says grace has ended and that a protocol pause would move the end later, which the re-read before sending checks. The clock only states; the protocol's own check, read again before sending, is what refuses a late repayment.

The threat model now records block-stuffing near a grace end, to hold a repayment back until a default lands, as an accepted low risk: grace periods are days long, and the app tells the borrower to send early.

Part of #3412. The contract half of #3412, a deadline on every price-exposed action, is separate work.
