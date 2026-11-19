## Thread — Refusal checks move onto the staged runner (branch, no PR yet)

The on-chain checks that the Diamond refuses what its rules forbid are now one staged module, PositiveFlowsRefusals, on the same fixture and runner as the positive flows. It replaces the old negative-flow script and its wrapper, which opened a loan and probed it in one broadcast and so stopped before sending anything once the offer-age rule arrived.

The module also checks more strictly. The old script counted any revert as a pass, so a call refused for an unrelated reason, such as a missing allowance or a range checked earlier, passed the check it was meant to prove. Each refusal is now required by its own error: an amount range or rate range out of order, a rate above 100%, a missing risk and terms consent, a loan lending and collateralising the same asset, a zero-day duration, collateral below the floor, a lender claim on an active loan, and a partial repayment the loan did not allow.

Every refusal is asked in the simulation only, so it is never sent. The two that need a live loan post the offer in one stage and open the loan and probe it in the next. Nothing here changes a protocol setting.

All nine refusals passed a staged run on a local Anvil chain. The coverage list also stopped pointing at a sanctions check the old script never had; the sanctions unit tests are what cover the other entry points. Advances #3574.
