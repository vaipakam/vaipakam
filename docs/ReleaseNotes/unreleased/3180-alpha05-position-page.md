# The next app shows one loan on its own page

Each loan in the next app now has its own page, opened from Home or Positions. It leads with the loan's status in words, then your role in it: the side your wallet holds now, read from the position tokens, or that you hold neither and are viewing. A deadline that needs you is worded for your side, and once the grace period is over the page says anyone may now start the default, only when the protocol says so.

The page lists the loan's dates from the protocol's loan clock (the due date it opened with, any time credited while the protocol was paused, the due date and the end of the grace period), its terms as fixed when it opened, its health, and where its collateral is held. A figure that could not be read is shown as unknown, never guessed or computed. A loan whose collateral has no price carries a warning that a default hands the lender the collateral itself.

The page is read-only for now and says so; repaying, adding or taking back collateral and the other actions come in later updates.

One small fix rides along: when the Full fee tariff is chosen on a request or an offer, the suggested ceiling the form fills in is now shown in every digit, because the reader authorizes it exactly as written.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-VIEW. Epic #3180.
