## Deploy-script pre-flight: reject native-gas mode on BNB Chain / Polygon PoS mainnet

CLAUDE.md's "VpfiBuyAdapter — payment-token mode by chain" section
called out a known operator-mistake surface: the buy adapter quotes a
single global ETH-equivalent rate for VPFI, but the deploy script lets
an operator initialize the adapter in native-gas mode on a chain where
1 unit of the native gas token isn't ≈ 1 ETH worth of value (BNB Chain
mainnet's BNB, Polygon PoS mainnet's MATIC/POL). The result would be
every buy on those chains mispricing — silently.

The contract-side guard (`_assertPaymentTokenSane`) already covers
*shape* validation (the address is a contract with 18 decimals), but
it doesn't and cannot know whether the operator on this specific chain
should be in native-gas mode or WETH-pull mode. That's the deploy
script's job.

This change adds a pre-flight check in `DeployCrosschain.s.sol`'s
mirror-chain branch: if `VPFI_BUY_PAYMENT_TOKEN` resolves to
`address(0)` (native-gas mode) AND `block.chainid` is BNB Chain
mainnet (56) or Polygon PoS mainnet (137), the script reverts with a
clear diagnostic naming the chain and pointing at the canonical
bridged-WETH address the operator should set.

Testnets (BNB Smart Chain Testnet `97`, Polygon Amoy `80002`) are
intentionally exempt — their gas tokens have no real value and the
testnet rate is symbolic, so native-gas mode is acceptable for
dev-loop convenience. Mainnet equivalents must use WETH-pull.

### Scope

- One pre-flight block added in `contracts/script/DeployCrosschain.s.sol`
  (33 lines including the policy comment and the two `require`s).
- Catches the misconfig BEFORE any state-changing deploy step runs —
  fails-loud, not fails-silent.
- Zero impact on chains outside the strict-WETH-pull list. Existing
  mainnet chains in the chain set (Ethereum, Base, Arbitrum, Optimism,
  Polygon zkEVM Cardona testnet) are unaffected because their native
  gas IS ETH-priced.

### Not yet wired

- No on-chain registry "this is the canonical bridged WETH9 on chain
  X" exists. Confirming the configured address really is the chain's
  published WETH9 (and not an attacker-deployed mock that returns the
  right decimals) remains an operational eyeball check — same as
  before this PR. The pre-flight covers the "operator forgot the env
  var" case, not the "operator pasted a malicious address" case.
- Adding programmatic confirmation that the WETH9 address matches a
  canonical chain registry would require either pulling Chainlink's
  Feed Registry (not deployed on every chain) or hard-coding the
  expected addresses per chain (becomes maintenance debt). Left as a
  follow-up if/when one of the strict-list chains gets a fresh deploy.

### Closes

A known follow-up tracked under the pre-audit-hardening note in
CLAUDE.md: *"Adding a deploy-script pre-flight that rejects the wrong
mode is a small follow-up — tracked under the pre-audit-hardening
card."*
