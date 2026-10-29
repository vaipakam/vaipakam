## Thread — Contracts build for one EVM target, whatever forge builds them (PR #2985)

The contracts' build settings named a compiler version but no EVM target, so
forge chose the target itself, and different forge releases choose different
ones: the version some contributors run built for Prague, the version CI pins
built for Osaka, and the release-gate and end-to-end jobs built for whatever
forge was current that day. The deployed bytecode, its metadata hash and the
deterministic address of the launch gate therefore depended on who built the
code rather than on the commit, which an audited code freeze cannot allow.

Every build profile now targets Prague, the newest EVM fork that every chain
Vaipakam deploys to has activated: Ethereum, Base, Optimism, Arbitrum, Polygon,
BNB Chain and their testnets. The compiler version in use emits nothing that
needs Osaka, so the contracts lose no feature by the pin. The target is raised
only once every chain in the deploy set runs the newer fork.

Closes #2973.

> Caveat: the committed gas snapshot is recorded by hand and is not re-recorded
> here, because recording it runs the whole suite; it refreshes with the
> pre-deploy regression.
