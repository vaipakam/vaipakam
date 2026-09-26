## Thread — the app's e2e suite now tests the contracts in the change, not the live testnet (PR #TBD)

The connected app's automatic end-to-end suite used to run against a local fork of the live Base Sepolia testnet. So each run tested the bytecode and state the testnet happened to hold when the job started, not the contracts in the change under review, and not a fixed state. That had two costs:
- **Flaky results.** The same commit could pass and fail on consecutive runs because live state had moved underneath it; the sale-listing spec did this three times in one day.
- **Contract changes were invisible.** A contract change could not be seen by the suite at all until someone redeployed the testnet, and the testnet's deployed contracts had fallen behind the source.

Every run now builds its own chain. Setup starts a blank local chain and deploys the repository's current contracts from source, together with the faucet and price-feed mocks the specs trade against. It then installs the three standard contracts the app expects at fixed addresses (wrapped ether, the batched-read contract and the signature-approval contract), presents the chain to the app as Base Sepolia, and runs the suite. Nothing is read from the live testnet. A contract change now reaches the app's tests in the same pull request, and the job's triggers now include contract source changes for that reason.

The suite passes in full this way (83 of 83). Getting there surfaced three things, each stated rather than papered over:
- **Wrapped ether's decimals.** Its token decimals live in storage its constructor writes, so it is now deployed normally and then copied into place, and setup refuses to continue unless it reads as an 18-decimal token.
- **The batched-read contract.** It must be the real one, not the test stand-in, because the app reads the block number through it.
- **A contract issue, filed as #2349.** A borrower's own posted refinance request cannot be completed while the auto-refinance switch is off. The switch is documented as covering only keeper-driven refinances. The test chain turns the switch on, matching the live testnet, until that is decided.

Two checks got stricter because the old excuse for leniency is gone:
- The sale-listing spec used to skip itself while the testnet lacked a newer contract route; it now requires the route.
- The test indexer's check that the committed contract interfaces match the chain used to warn, because a mismatch meant the testnet was behind. It now stops the run and names the fix.

The CI check keeps its historical name so branch protection is unaffected. The nightly run is removed, since it existed only to catch the live testnet drifting under an unchanged app.

Closes #2334.
