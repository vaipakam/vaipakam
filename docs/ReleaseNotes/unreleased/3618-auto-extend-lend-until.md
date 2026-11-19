## Thread — Auto-extend stays inside an Auto-lend end date

An Auto-lend intent's lend-until time now also bounds an automatic extension of
a loan the intent made. Before, the lender's own auto-extend caps could carry
such a loan past the date the money was lent until, because the extension read
only those caps.

While the intent's owner still holds the lender position, an in-place extension
whose new end would fall after the intent's current lend-until time is refused
with a named reason that states both times. An extension ending exactly at the
time is taken. The intent is read as it stands now, so moving or clearing the
date moves or lifts the bound. Once the position is sold the buyer agreed to no
date, so the bound no longer applies. A new view reports each loan's bound, so
the keeper can size an extension inside it or skip the loan when none fits.

No funds move differently: the rule only refuses an extension. In-place
extension is the only route that lengthens a loan. This reaches a chain with the
next fresh deploy. Design: `docs/DesignsAndPlans/AutoLendLendUntilDesign.md`,
section 3, item 5.
