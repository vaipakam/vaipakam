## Thread — deploy scripts run under `forge script` again (PR #2348)

Every deploy script that reads or writes a deployment artifact had been failing before its first transaction since #2253 (merged 2026-09-20). That includes the Diamond deploy that `deploy-chain.sh`, the testnet deploy and the mainnet deploy all run. The deployment-artifact library had started reading each script's own settings (where to write its artifact, and a snapshot of the previous artifact) by calling back into the script contract. Foundry refuses any call to the running script contract, so the scripts stopped with "Usage of `address(this)` detected in script contract". The deploy-sanity tests run the same code under `forge test`, where Foundry does not apply that rule, so they all stayed green. No deploy had run since, so nothing had noticed.

The library now reads and writes those settings directly in the script's own storage, in a dedicated, collision-proof location, so no call back into the script is made. The completeness check that runs at the end of a Diamond deploy now reports a failure instead of reverting. The deploy then restores the previous artifact and stops with the same message. The guarantee #2253 added is unchanged: whatever goes wrong in the check, the operator's previous artifact is put back. The slippage census script had the same kind of self-call when reading a token's symbol; it now decodes the symbol without one.

To stop this recurring unseen, CI now runs the Diamond deploy the way an operator does: `forge script` against a throwaway local chain on every contracts change. This is a check that tests cannot replace.

Closes #2347.
