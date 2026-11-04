## Thread — Auto-extend card: honest cover line and one reserve result (PR #<n>)

The live run of the auto-extend card on Base Sepolia turned up two places where the loan page said more than it knew. Both are fixed here. This advances #2814.

Before the extension window opened, the reserve panel said the reserve "does not cover an extension now", although no extension can run before the window. The panel now speaks of an extension "now", in its charge figure and in its cover line, only while the window is open. Before the window opens, or while the window has not been read, it states only the charge and the cover at the end of the window. That end-of-window charge is the most an extension of the current term can charge, so covering it covers the whole window. Once the window has closed, or the loan has none, the panel makes no cover claim at all.

After a withdrawal on the loan page, the deposit's "Added to your reserve." stayed next to "Your unused reserve was withdrawn.", so the page showed two results that contradicted each other. Now only the latest reserve action's result is shown. A withdrawal hides an earlier deposit's result, and a later deposit clears the withdrawal's result.

> Caveat: the position page's owed interest still shows every digit the token carries ("~0.000000821917808219 WETH"). That follows the exact-amount rule #2662 set for the page's figures, and it is left for a separate decision.
