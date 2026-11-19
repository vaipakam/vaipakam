## Thread — Observed rates page in the new app (#3751)

The new app has an Observed rates page, reached from Analytics and open with no wallet. For one asset on one network it shows the two halves of the index's rate curve side by side and labelled apart: the term average from the outside rate source, and the figures built from the platform's own repaid loans. They are never blended into one number.

The outside half says it is not available yet, because the protocol's term-average view does not exist on any deployment; no figure is shown in its place. The own-loans half labels each point by the loan lengths it covers ("up to 14 days", "15–60 days", "over 270 days"), never as one term, and shows the median and middle half with how many loans, lenders and borrowers it rests on. A withheld point says "not enough loans yet", or names the other reason (the index could not read the whole look-back); a point the index has not computed says that.

"How this is computed" lists the rule from the index's own answer, every setting, exclusion, interest source and point look-back, so the page cannot drift from what the index did. A daily history for one loan length lists only the days the index filled and says a missing day is not a zero. The page states when the index computed the figures, and a refusal (the request limit, an unavailable chain) or a build with no index shows no figure.

Every figure is described as an average of what was observed, never advice, a forecast or an offer. Advances #3751; the index side is on its own branch.

> Caveat: the page goes live only once the index publishes the rate curve routes; until then it states the read failure.
