## Launch readiness checks the reward role (PR #TBD)

Launch readiness now has a reward role requirement. Before this change, nothing in the launch checks looked at which reward role a Diamond held. The reward configure step decides the role from the chain id (Base and Base Sepolia are canonical, every other chain is a mirror). If that step did not run, or stopped partway, the Diamond was left unconfigured, and it still launched. The lapse-schedule check from #2909 then reported "does not apply: the reward role is Unconfigured". That was true of the stored role, but it hid that the role itself was wrong for the chain.

The launch now declares the role it intends, the same way it declares the WETH, the VPFI pool, the lanes and the feed registry. The intended role is Canonical on the reward base chain and Mirror everywhere else. The launch derives it from the same chain-id rule the configure step sets the role from, which now lives in one place in the deploy library. The on-chain launch gate compares the stored role with that declaration, so the gate itself holds no chain-id table and a local Anvil mesh can declare whatever its chains need. Each check reports which role it found and which one the launch intended. Unconfigured, Detached, or the other chain's role is NOT MET. A launch that declares no role leaves the requirement not checkable, which a production launch and the Timelock gate both refuse. The Timelock proposal prints the declared role for the Governance Safe to review.

The declaration is a new field in the gate's input, so the gate's bytecode, and with it its predicted address, changes. That only matters at the next fresh deploy, which deploys the gate anyway.

Closes #2920. Refs #2909.
