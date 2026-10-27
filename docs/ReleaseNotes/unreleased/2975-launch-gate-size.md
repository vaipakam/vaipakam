## Thread — The launch gate fits the contract size limit again (PR #2978)

The launch gate, the contract a production Diamond's first unpause runs
through to re-check every launch requirement, had grown past the 24,576-byte
contract size limit when the reward-role check was added, so it could not be
deployed. Its two cross-chain checks (the VPFI pool and that pool's CCIP
lanes) now live in a companion contract, LaunchCrossChainChecks, which the
gate creates in its own constructor. The gate is now about 14.8 KB and the
companion about 12.4 KB.

Nothing about what the gate checks has changed: the same ten requirements,
in the same order, put together by the same shared list the launch script
prints. The gate is still deployed at one deterministic address from its
code alone, and because the companion's code is part of the gate's creation
code, that address commits to both. A reviewer finds the companion's address
from the gate's `crossChainChecks()`.

The deploy-sanity suite now size-checks the gate and its companion, so a
future check that grows them past the limit fails a normal test run instead
of a deploy.

Closes #2975.
