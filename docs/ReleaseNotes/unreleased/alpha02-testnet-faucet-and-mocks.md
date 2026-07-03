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
`contracts/script/DeployTestnetMocks.s.sol`, deploys the faucet trio and
wires the *faucet's own* liquid token into the Diamond's oracle so
"mint tLIQ → it classifies liquid" holds end-to-end: a mock Chainlink
feed + registry, a mock Uniswap-V3 `tLIQ/WETH` pool above the $1M depth
floor (Tier 1), and a `ZeroExProxyMock` wired via `setZeroExProxy` /
`setallowanceTarget` for the HF-liquidation swap path (Tier 2). The
illiquid token is left unwired on purpose so the in-kind default flows
stay exercisable. The script reuses already-deployed tokens via
`FAUCET_LIQUID_TOKEN` / `FAUCET_ILLIQUID_TOKEN` / `FAUCET_RENTAL_NFT`
overrides (idempotent re-runs) and persists every address to the
per-chain `addresses.json` under a single `.testnetMocks` object — the
exact shape the new `TestnetMocks` interface in
`packages/contracts/src/deployments.ts` consumes. Run
`exportFrontendDeployments.sh` afterwards to fold it into the bundle.

Base Sepolia already carries the deployed faucet trio (`tLIQ`, `tILQ`,
`vRENT`); the oracle/swap wiring is applied when an operator with the
admin + risk-admin roles runs the script (deployer + admin broadcasts).
Until then the faucet mints work but `tLIQ` reads illiquid — expected,
not a regression. Follow-ups: fund the `ZeroExProxyMock` with output
tokens and set its rate before exercising HF liquidation, and run the
same script on Arbitrum Sepolia.
