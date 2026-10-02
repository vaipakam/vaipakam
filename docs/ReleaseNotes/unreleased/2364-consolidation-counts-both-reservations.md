## Thread — A fully reserved held VPFI amount no longer blocks a lender holder from consolidating (PR #2367)

Consolidation moves a transferred lender position onto its current holder, and the VPFI held for that position moves with it. The platform refuses to consolidate while part of that held VPFI is unreserved, because the unreserved part would become a balance the holder could withdraw before claiming.

A held amount can be reserved in one of two places. Preclose, offset and partial-match accruals use one. A lender share parked for a sanctioned holder while the loan is live uses a dedicated one. The consolidation check read only the first, so it treated a share reserved in the second place as unreserved. A holder who had been delisted could therefore never consolidate that position. Their funds stayed in the departed lender's vault, and so did the fee-tier credit on them.

The check now counts both places. It uses the same reader the closed-loan fee-tier rule uses, so the two rules cannot disagree about what is reserved. A partially reserved amount is still refused, exactly as before.

The investigation also answered #2365. On the current code, every path that adds VPFI to a held amount reserves it in full, so a departed lender cannot spend VPFI held for a holder. The only exposure would be a balance that accrued before held-for-lender reservation was introduced and that still sits on a live loan of an older deployment.

The functional spec's held-for-lender paragraph previously said the reservation was "handled separately". It now states the rule: accruals are reserved in full when they land, the reservation moves with the funds on every lender change, and only an unreserved remainder blocks consolidation.

Closes #2364. Closes #2365.
