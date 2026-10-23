## Thread — BNB Testnet's priority-routing perk: the fork check, and a correction to the record (PR #<n>)

The fork check that proves the priority-routing perk works against a deployed Diamond now has a BNB Testnet cell, alongside Base Sepolia and Arbitrum Sepolia. It uses the WETH stand-in and the mock liquid token that the 2026-10-22 testnet mocks priced. On 2026-10-23 it passed against a fork of BNB's live Diamond: a fill the solver's capacity covers is charged to the solver, fills it refuses are refused by name, and a fill that capacity would refuse goes through on exactly one of the intent owner's credits.

Running it turned up a correction. Every record said perk 1 was still unpriced on BNB: the deployment ledger, the perk's design document and the BNB mocks note. It was not. An admin write priced it at 2 VPFI per credit on 2026-10-19 at 13:29 UTC, the same price as the other two testnets, and nothing recorded it. Unlike Base and Arbitrum, no fork check preceded it, and until the mocks arrived no lender intent could be filled on BNB, so a credit bought there in that window could not have been used. None was bought: no purchase event appears on BNB's Diamond. The ledger now records the arming transaction, and the design document and the mocks note say what happened. Nothing on-chain changed in this PR.

Closes #2641.
