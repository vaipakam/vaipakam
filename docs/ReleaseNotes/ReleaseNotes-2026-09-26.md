# Release Notes — 2026-09-26

Three changes, listed in the order they merged.

The first changes how these notes are produced, and nothing the platform does:
it closes the last known way the assembler could publish a fragment twice.

The other two change how the contracts are deployed and tested, not what they
do. The second makes every artifact-writing deploy script run again under
`forge script`, which an earlier change had silently broken while the test
suite stayed green. The third makes the connected app's automatic end-to-end
suite deploy the repository's current contracts to a local chain, instead of
testing against whatever the live testnet happened to hold.

## Thread — release-note assembler recognises an earlier copy by its text, not only its heading (PR #2346)

The assembler has a safety check for older dated release-note files that carry no assembly markers. Before adding a pending fragment, it looks for an earlier copy of that fragment in the file. If the file already seems to hold the fragment, it stops and asks the operator. Until now the only evidence was the fragment's heading line. That was the weak point. Every fix the assembler suggests when it refuses a badly formed fragment changes the start of that fragment: the heading level, the heading text, a byte-order mark, a front-matter block, or a heading added above opening prose. So an author who followed the advice after an interrupted run of an older version also moved the one thing the check compared. The next run found no match, added a second copy, and deleted the pending source. That is the only way this script loses work instead of refusing. Two cases had already been fixed one remedy at a time; this change fixes the whole class.

The check now also compares the fragment's body: everything after its first heading, or the whole text if there is no heading. The body counts only if it appears in the dated file as one unbroken run of lines. None of the remedies touch the body, so a published copy is still found after its heading has been reworded, re-levelled or re-saved. The run stops and names the fragment, and the message says whether the heading, the text or both were found.

Two limits are stated, not hidden:

- **Very short bodies don't count.** A body under 40 bytes as it appears in the published notes, not counting spaces, tabs, line breaks or a byte-order mark at the start of a line, is too short to tell a copy from a coincidence, so only the heading is compared for it.
- **Some edits can't be detected.** If a fragment's heading and body have both been rewritten since it was published, no comparison of text can tell it from a new one. Only the assembly marker can.

Before adopting the body match, it was measured against every dated file. Of 1,158 section bodies, 6 appear more than once. All six are hand-written footers from before fragments existed, so the new evidence should not stop real runs. `--force-append` remains the override.

Closes #2298.
<!-- assembled-fragment: 2298-assembler-body-match.md sha256=a0963cac2444f00718933906e2a5e5010d743aba3d353f3b91a032915e8a4e86 -->

## Thread — deploy scripts run under `forge script` again (PR #2348)

Every deploy script that reads or writes a deployment artifact had been failing before its first transaction since #2253 (merged 2026-09-20). That includes the Diamond deploy that `deploy-chain.sh`, the testnet deploy and the mainnet deploy all run. The deployment-artifact library had started reading each script's own settings (where to write its artifact, and a snapshot of the previous artifact) by calling back into the script contract. Foundry refuses any call to the running script contract, so the scripts stopped with "Usage of `address(this)` detected in script contract". The deploy-sanity tests run the same code under `forge test`, where Foundry does not apply that rule, so they all stayed green. No deploy had run since, so nothing had noticed.

The library now reads and writes those settings directly in the script's own storage, in a dedicated, collision-proof location, so no call back into the script is made. The completeness check that runs at the end of a Diamond deploy now reports a failure instead of reverting. The deploy then restores the previous artifact and stops with the same message. The guarantee #2253 added is unchanged: whatever goes wrong in the check, the operator's previous artifact is put back. The slippage census script had the same kind of self-call when reading a token's symbol; it now decodes the symbol without one.

To stop this recurring unseen, CI now runs the Diamond deploy the way an operator does: `forge script` against a throwaway local chain on every contracts change. This is a check that tests cannot replace.

Closes #2347.
<!-- assembled-fragment: 2347-forge-script-deploys-run-again.md sha256=d3e859cc76ab67fbcea8f0353bde8eb5e7df8b8f63858ea09f3ab384e77cc3f8 -->

## Thread — the app's e2e suite now tests the contracts in the change, not the live testnet (PR #2351)

The connected app's automatic end-to-end suite used to run against a local fork of the live Base Sepolia testnet. So each run tested the bytecode and state the testnet happened to hold when the job started, not the contracts in the change under review, and not a fixed state. That had two costs:
- **Flaky results.** The same commit could pass and fail on consecutive runs because live state had moved underneath it; the sale-listing spec did this three times in one day.
- **Contract changes were invisible.** A contract change could not be seen by the suite at all until someone redeployed the testnet, and the testnet's deployed contracts had fallen behind the source.

Every run now builds its own chain. Setup starts a blank local chain and deploys the repository's current contracts from source, together with the faucet and price-feed mocks the specs trade against. It then installs the three standard contracts the app expects at fixed addresses (wrapped ether, the batched-read contract and the signature-approval contract), presents the chain to the app as Base Sepolia, and runs the suite. Nothing is read from the live testnet. A contract change now reaches the app's tests in the same pull request, and the job's triggers now include contract source changes for that reason.

The suite passes in full this way (83 of 83). Getting there surfaced four things, each stated rather than papered over:
- **Wrapped ether's decimals.** Its token decimals live in storage its constructor writes, so it is now deployed normally and then copied into place, and setup refuses to continue unless it reads as an 18-decimal token.
- **The batched-read contract.** It must be the real one, not the test stand-in, because the app reads the block number through it.
- **The chain needs history below its first block.** The local chain starts at a high block number so the app's batched reads work, which leaves no blocks beneath it. Newer versions of the tooling refuse fee-history questions that reach below the start, which stopped the contract deploy on CI's toolchain while it passed on an older local one. Setup now adds enough history for any fee question a client can ask.
- **A contract issue, filed as #2349.** A borrower's own posted refinance request cannot be completed while the auto-refinance switch is off. The switch is documented as covering only keeper-driven refinances. The test chain turns the switch on, matching the live testnet, until that is decided.

Two checks got stricter because the old excuse for leniency is gone:
- The sale-listing spec used to skip itself while the testnet lacked a newer contract route; it now requires the route.
- The test indexer's check that the committed contract interfaces match the chain used to warn, because a mismatch meant the testnet was behind. It now stops the run and names the fix.

The CI check keeps its historical name so branch protection is unaffected. The nightly run is removed, since it existed only to catch the live testnet drifting under an unchanged app.

Closes #2334.
<!-- assembled-fragment: 2334-e2e-deploys-current-contracts.md sha256=381b411fe02edd24bbb982da29e31616565840906edf5c9055b2cac3dbf8e787 -->
