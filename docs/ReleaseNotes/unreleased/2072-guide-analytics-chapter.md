## Thread — the user guide describes the Analytics page that actually ships (PR #3045)

The user guide's Public Analytics chapter, in both the Basic and the Advanced guide and in all ten languages, described the retired dashboard: a cross-chain total, a per-chain table, total value locked and loan volumes, an export, and a claim that no database sat behind any number. None of that is true of the page the site links to. The chapter now describes the real page: one network at a time, no wallet needed, two public sources named wherever they are used (the public indexer for loan, offer, recycling and loop-closure figures, and the platform contract itself for the VPFI token and fee figures), and the rules the page follows, such as stating the block and age of every reading and never showing an unread figure as zero.

The two retired sections (all-chains total and per-chain breakdown) are gone, and three new ones cover loans and offers, the recycling account and loop closure, and fees and treasury. The anchors are the same in every edition. This follows the owner's decision to rewrite the guide and build the missing contract figures on the page (#2437). Closes #2072.

> Caveat: the guide's VPFI token and fees sections describe the page as #2437 (merged as PR #3038) builds it; they match the live app from its next deploy.
