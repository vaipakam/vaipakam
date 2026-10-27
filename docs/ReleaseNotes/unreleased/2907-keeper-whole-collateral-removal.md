## Keeper — the whole-collateral forced-sale bridge is removed (#2907)

The keeper carried a second form of the grace default, the health-factor liquidation, the internal-match close and the periodic settlement for the live testnets, whose Diamonds were deployed before the sell-to-need change (#2796) and route only the older whole-collateral calls (PR #2908, PR #2912). At the all-waves fresh deploy every served Diamond carries the sized surface, so that branch is gone.

The keeper no longer reads each Diamond's routing before a close. It always sends the sized call: the sale amount the Diamond's own preview names, with a simulated preview of that exact call still required before anything is sent. The shared route builder previews the sized default directly. A Diamond that lacks the sized calls now fails the preview, and the keeper sends nothing, the same outcome as any other failed preview.

This merges with the all-waves fresh deploy. Merged earlier, the keeper would stop defaulting and liquidating loans on the testnets that still run pre-#2796 Diamonds.
