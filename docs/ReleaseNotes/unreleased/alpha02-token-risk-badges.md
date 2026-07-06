### Risk badges on the offer book and matcher; flagged offers leave the shortlist (alpha02)

The independent token-security screen already guards the accept
review (a deal with a flagged token cannot be signed). It now also
warns EARLIER, while the user is still browsing (#1036):

- Offer Book rows and guided-match cards wear a compact badge when a
  non-curated token in the offer carries a concrete finding: **Risk
  flagged** (dangerous — the review will refuse it), **Caution**
  (owner powers or taxes — the review shows details), or **Not
  screened** (the check could not run — extra care).
- The guided matcher no longer recommends offers whose token is
  flagged as dangerous: they are withheld from the shortlist, and the
  list says how many were hidden — never a silently thinner set of
  matches. Caution-tier and unscreened offers stay listed, wearing
  their badge.
- The Offer Book itself never hides rows — a browse surface must not
  misrepresent what the market holds; enforcement stays at the accept
  review.
- One batched security lookup now screens a whole page of offers at
  once, and every verdict is shared with the review gates — each
  token is screened once per session, whichever surface asked first.

On test networks the security screen has no data, so badges stay off
there (every faucet token would otherwise be marked); the accept-
review posture on test networks is unchanged.
