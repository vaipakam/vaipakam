## Thread — Shared two-chain Anvil harness (PR #<n>)

The two-chain Anvil setup the keeper's reward scenarios use (#2516) moved
out of the keeper app and into the shared Anvil harness package, together
with the scenario chain client, the loan helpers and the reward-day
helpers. Nothing about what the keeper scenarios build or check changed:
they now open the same two chains through the shared package, under their
own state directory, artifact folder and ports, so no other suite ever
reads the keeper's build.

This is the first step of the protocol positive-flow work in #848. The
reward claim on Base and on a mirror, VPFI moving out and back over the
real CCIP token pools, the tier push to a mirror and the guardian pause
all need two chains and moving time, which a forge script cannot give
them. The next change adds a protocol scenario suite on this harness
instead of building a second copy of the two-chain setup.

The forge fixture script that seeds the two chains was renamed from the
keeper-specific name to a shared one, because the reward remitter it
authorizes is now whatever address the calling suite names (the keeper
suite still names its own development key). Test tooling only; no
contract, deployment or user-facing behaviour changed. Refs #848.
