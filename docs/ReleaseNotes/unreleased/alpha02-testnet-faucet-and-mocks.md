## Thread — Testnet faucet + oracle/swap mock deploy script

The alpha02 website gains a testnet **faucet**: a dedicated `/faucet`
route where a connected user on a test network can self-mint the mock
assets the review and demo flows need — a liquid test token (`tLIQ`),
an illiquid test token (`tILQ`), and a rentable ERC-4907 test NFT
(`vRENT`) — plus a small "Get test assets" nudge on Home and a
testnet-only sidebar link. The whole surface is **double-gated**: it
does anything only when the read chain's `testnet` flag is set AND the
consolidated deployments bundle carries a `testnetMocks` block for that
chain. On any mainnet slug the route explains itself and points home
instead of exposing an unrestricted `mint`. Writes go straight to the
mock token contracts (not the Diamond); the NFT mint uses a
client-random 256-bit token id so concurrent reviewers never collide.

Alongside it, a new reproducible Foundry script,
`contracts/script/DeployTestnetMocks.s.sol`, deploys the faucet assets
and wires the *faucet's own* liquid tokens into the Diamond's oracle so
"mint tLIQ → it classifies liquid" holds end-to-end: a mock Chainlink
feed + registry and a mock Uniswap-V3 `asset/WETH` pool above the $1M
depth floor per liquid token (Tier 1), plus a **registered
`MockSwapAdapter`** — the venue the Phase-7a HF-liquidation failover
(`LibSwap.swapWithFailover`) actually routes through (Tier 2). The
script seeds that adapter with a float of every liquid faucet token;
for loans in other principals, fund the **`mockSwapAdapter`** address
from `.testnetMocks` (NOT the `ZeroExProxyMock` — that is the legacy
0x-proxy shape, wired for completeness but ignored by the Phase-7a
path). The illiquid token is left unwired on purpose so the in-kind
default flows stay exercisable. The script reuses already-deployed
assets via the `FAUCET_*` overrides (idempotent re-runs) and persists
every address to the per-chain `addresses.json` under a single
`.testnetMocks` object — the exact shape the `TestnetMocks` interface
in `packages/contracts/src/deployments.ts` consumes. Run
`exportFrontendDeployments.sh` afterwards to fold it into the bundle.

Wallet visibility: after a successful ERC-20 faucet mint the banner
offers "Add \<symbol\> to MetaMask" (the standard watch-asset prompt;
declining is not an error), so the minted balance shows up in the
user's wallet immediately. The VPFI page gets the same affordance —
an "Add VPFI to MetaMask" button in the discount-status card, shown
only once the connected user actually holds VPFI in their wallet or
their vault, so nobody is nudged to track a token they don't have.

Base Sepolia already carries the deployed faucet trio (`tLIQ`, `tILQ`,
`vRENT`); the oracle/swap wiring is applied when an operator with the
admin + risk-admin roles runs the script (deployer + admin broadcasts).
Until then the faucet mints work but `tLIQ` reads illiquid — expected,
not a regression. Follow-ups: fund the `ZeroExProxyMock` with output
tokens and set its rate before exercising HF liquidation, and run the
same script on Arbitrum Sepolia.
