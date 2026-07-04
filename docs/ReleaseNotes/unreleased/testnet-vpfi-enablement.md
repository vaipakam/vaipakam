## Thread — Testnet VPFI enablement script

Adds `contracts/script/DeployTestnetVPFI.s.sol`, an operator-run one-shot
that activates the otherwise-dormant VPFI fee-discount surface on a
testnet Diamond so it can be reviewed end-to-end. On a fresh testnet
deploy the VPFI token exists but is not registered in the Diamond
(`getVPFIToken()` returns the zero address), so every discount/tier read
is zero and the `/vpfi` page correctly shows "not available on this
chain".

The script registers VPFI (`setVPFIToken`), points the discount quote at
the (oracle-priced) WETH reference and sets a symbolic testnet
wei-per-VPFI rate, and — from the treasury that holds the full initial
supply on testnet — transfers VPFI to up to four configurable recipient
wallets so they can deposit VPFI and climb the tier ladder (100 / 1,000 /
5,000 / 20,000 VPFI → 10 / 15 / 20 / 24 % fee discount, all on-chain
defaults). It deploys no new contracts and needs no `deployments.json`
change — `vpfiToken` is already recorded, and the token's minter is the
Diamond, so VPFI can only be distributed from the existing treasury
holdings, not freshly minted from an EOA.

Testnet-only (guards the supported testnet chain ids); never a mainnet
slug. Companion to `DeployTestnetMocks.s.sol` (oracle + faucet mocks).
