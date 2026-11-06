# The next app lets a lender choose an interest schedule and the Full fee tariff

In Advanced mode, a lender posting their own offer on the next app's Lend page can now choose an interest schedule and opt into the Full fee tariff, the two options a borrower posting a request already had. Both use the same form fields and the same protocol reads on both sides, worded for each.

A lender's schedule is admitted at the smallest part one match may lend (or the whole amount, without parts), because that is the amount the protocol checks when the offer is posted. So a schedule the whole amount would clear stays closed, with both figures stated, while the smallest part is under the protocol's threshold. Each loan's own amount is checked again when it opens. The review states each period's interest on the whole amount and on the smallest part, the whole term's interest as a total that the instalments count toward, and that a period left unpaid past its grace lets anyone sell part of the borrower's collateral to pay the lender, with the loan staying open.

The tariff is quoted in the form at the whole amount, the largest loan the offer can open (a direct take), and in the review at both ends. The review states what it costs, what it gives a lender (10 more points of discount on the protocol's share of the loan's interest, up to the 50% cap, for the loan's term; lost for a new term after an extension; belonging to whoever holds the lender position), the gap before it is set, during which a loan can open without it, and each refusal the protocol's reads predict under the rule the lender chose. A choice that would refuse every loan blocks the review, as it does for a request.

As for a request, the tariff is set by its own transaction once the offer has posted. The Lend page shows that step, measured like the post, and holds back a new offer until it ends. Its text names the offer and says the protocol refuses the step once the offer is taken in full or closed.

The user guide's Basic and Advanced editions describe the lender's schedule and tariff in every language. The form no longer says these options come later.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-LEND-POST. Epic #3180.
