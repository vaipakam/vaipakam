## Keeper — mirror day closes resume on chains still sending the B4 report (PR #2867)

The day-report change in PR #2790 (#2620, #2621) moved fresh deploys to one report shape, and the keeper's day-close pass started quoting only that shape. The live testnets still run messengers and Diamonds deployed before that change, which send the older B4 report. From the release that shipped it, every mirror close on BNB Testnet and Arbitrum Sepolia was refused with "the messenger has no quote for the report closeDay sends", starting with reward day 4. Day 4 was closed by hand from the keeper wallet at 03:52 UTC on 2026-10-26, paying the B4 quote.

The keeper now reads which report shape a mirror's messenger carries from the messenger's own code, either the one report shape or B4, and quotes that shape. The report channel checks that sit in front of every close gain three links:
- Base's reward messenger, also read from its code, must take the same shape. Base refuses a report of the wrong size on delivery, after the fee has been paid and the day stamped sent.
- The messenger must carry one of the two shapes.
- On a B4 chain, the Diamond's reporter must send B4: `closeDay` and `getInterestFrontiers` routed to one facet. B4 is the one older shape Base applies after it has finalized a day.

Any of these that fails or cannot be read holds every close on that chain, and the channel alert says which. On a B4 chain the route to Base is the messenger's own configuration, not a rule the contract enforces, and the rotated-messenger alert now says so.

This is keeper-only compatibility for chains deployed before #2790. The contracts still carry one report shape. The path is removed at the all-waves fresh deploy, when no served chain runs a pre-#2790 messenger (#2866).
