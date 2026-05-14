# WETH-vs-native-token chain-safety audit — 2026-05-14

Item **B.1** from
[`PendingTasks-2026-05-14.md`](PendingTasks-2026-05-14.md):
walk every code path that computes "what's WETH on this chain"
to ensure the protocol doesn't accidentally treat native gas
value as WETH value on BNB Chain mainnet (chainId 56) or
Polygon PoS mainnet (chainId 137), where the native gas token
isn't ETH and the canonical bridged WETH9 is at a chain-specific
ERC-20 address.

**Result: CLEAN. Zero gaps identified.** The protocol's
architecture explicitly avoids the "WETH == native gas value"
anti-pattern. All critical surfaces (oracle, liquidity tier
classification, swap routing, fees, interest accrual) are
chain-aware and admin-configurable per deployment.

This doc is the audit-package addendum the auditor reads
alongside the bounds audit
([`ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md))
and CLAUDE.md's
"[VPFIBuyAdapter — payment-token mode by chain](../../CLAUDE.md)"
section.

---

## Background

On Ethereum / Base / Arbitrum / Optimism / Polygon zkEVM, the
native gas token IS ETH, so any code path that reads a global
`wethContract` storage slot (holding the bridged-WETH9 ERC-20
address) implicitly does the right thing when it converts pool
depth or asset value to "ETH equivalent": the native gas of these
chains IS the asset that backs WETH at 1:1.

On **BNB Chain mainnet** (chainId 56) the native gas is BNB and
the canonical bridged WETH9 sits at
`0x2170Ed0880ac9A755fd29B2688956BD959F933F8` — a separate ERC-20
that holds Ethereum-bridged ETH value. 1 BNB ≠ 1 ETH (and the
rate floats).

On **Polygon PoS mainnet** (chainId 137) the native gas is POL
(formerly MATIC) and the canonical bridged WETH9 sits at
`0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`. 1 POL ≠ 1 ETH.

The audit's question: does any code path treat the value of N
native-gas units on these chains as equivalent to N WETH units?
If so, prices misprice and liquidations under-collateralize.

---

## Already-handled (background only — not the subject of this audit)

`VPFIBuyAdapter`'s payment-token policy already enforces
bridged-WETH-pull mode on BNB mainnet + Polygon PoS mainnet:

1. **Deploy-time gate** (`DeployVPFIBuyAdapter.s.sol`): pre-flight
   `_chainRequiresWethPaymentToken(chainId) && paymentToken_ == address(0)`
   reverts. Catches operator error.
2. **Runtime gate** (`_assertPaymentTokenSane(token)`): asserts
   `token.code.length > 0` + `IERC20Metadata(token).decimals() == 18`.
   Catches honest misconfigs (USDC's 6-dec pasted where bridged-WETH
   belongs).
3. **Test coverage**:
   `contracts/test/token/VPFIBuyAdapterPaymentTokenTest.t.sol`
   (10 cases — every revert path on init + on `setPaymentToken`
   rotation + 2 acceptance paths).

See CLAUDE.md "VPFIBuyAdapter — payment-token mode by chain" for
the full design. The audit BELOW covers every OTHER code path.

---

## Part 1 — Solidity findings

| File | Surface | Pattern | Chain-safety |
|---|---|---|---|
| `OracleFacet.sol` | `_checkLiquidity` reads `s.wethContract` | Special-cases WETH by address equality (`if (asset == weth)`); other assets route through `asset/WETH` pool depth check | ✅ Safe — `wethContract` is admin-set per chain; pool depth converts to PAD via ETH/PAD oracle feed, not native gas |
| `OracleFacet.sol` | `getAssetPrice` for WETH | Reads `s.ethNumeraireFeed` (ETH/PAD feed, per-chain) | ✅ Safe — WETH price never assumes native gas value |
| `OracleFacet.sol` | Depth-tier route search | Iterates `s.paaAssets[]` × V3/V2 factories | ✅ Safe — PAA list is admin-set per chain (fallback `[wethContract]` if empty); no hardcode |
| `OracleAdminFacet.setWethContract` | Admin setter for the global slot | Owner-only; zero accepted (fail-closes everything to Illiquid) | ✅ Safe — operator MUST set chain-specific bridged WETH per deploy |
| `LibVaipakam.sol` | `s.wethContract` definition | Documented as "canonical WETH on active network" | ✅ Safe — storage, not hardcode |
| `LibVaipakam.sol` | `effectivePaaAssets()` fallback | Returns `[wethContract]` when `paaAssets[]` is empty | ✅ Safe — uses the per-chain storage slot |
| `LibNotificationFee.sol` | ETH/numeraire price anchor | `getAssetPrice(s.wethContract)` × fixed VPFI-per-ETH peg | ✅ Safe — uses oracle, not native gas balance |
| `RiskFacet.sol` | LTV / HF computation | Uses `getAssetPrice(principal)` + `getAssetPrice(collateral)` | ✅ Safe — no WETH hardcode; both legs go through the per-asset oracle |
| `DefaultedFacet.sol` | Liquidation valuation | Uses `getAssetPrice(valueAsset)` parametrically | ✅ Safe — asset-parametric |
| `LibSwap.sol` | DEX swap adapter routing | Keeper-supplied `AdapterCall[]`; asset-agnostic | ✅ Safe — no WETH assumption in routing |
| `VPFIBuyAdapter.sol` | Payment-token enforcement | See "Already-handled" above | ✅ Safe — explicit chain-gating |

**No hardcoded Ethereum WETH address** (`0xC02aaA39…`) found in
any critical contract path. All WETH references resolve through
`s.wethContract` storage (admin-set per chain).

---

## Part 2 — TypeScript / JS findings

| File | Surface | Pattern | Chain-safety |
|---|---|---|---|
| `apps/defi/src/contracts/canonicalAssets.ts` | Per-chain canonical ERC-20 lists | Hardcoded addresses keyed by chainId | ✅ Safe — BNB (56) lists WBNB + stables, **deliberately no WETH entry**; Ethereum (1) lists WETH |
| `apps/defi/src/contracts/chain-config.ts` | `ChainConfig` interface | Separates `nativeGasSymbol`, `wrappedNativeAddress`, `bridgedWethCoinGeckoSlug` | ✅ Safe — BNB config: `nativeGasSymbol: "BNB"`, `wrappedNativeAddress: 0xbb4CdB9…` (WBNB), `bridgedWethCoinGeckoSlug: "weth"` (guides user to the bridged asset, not the native) |
| `packages/contracts/src/deployments.ts` | `Deployment.weth?` + `Deployment.vpfiBuyPaymentToken?` | Optional per-chain artifact | ✅ Safe — `0x0…0` mapped to `null` (native mode) at the consumer boundary |
| `apps/keeper/src/liquidityConfidence.ts` | PAA asset resolution | Reads `getPaaAssets()` on-chain; falls back to `[wethContract]` | ✅ Safe — both reads consult on-chain storage, no hardcode |
| `apps/keeper/src/serverQuotes.ts` | `CHAIN_SWAP` registry | Per-chain Uni V3 quoter + Balancer vault + adapter indices | ✅ Safe — BNB (56): quoter+Balancer disabled (`null`); per-chain availability captured |
| `apps/keeper/src/dexDirectQuotes.ts` | 0x v2 / 1inch v6 quotes | Aggregator URLs accept chainId parameter | ✅ Safe — aggregator does per-chain routing internally |
| `apps/keeper/src/flashLoanProviders.ts` | Per-chain flash-loan providers | Aave V3 Pool + Balancer V2 Vault per chainId | ✅ Safe — BNB (56) explicitly omits Balancer V2 entry (correctly: not deployed on BNB) |

**No hardcoded Ethereum WETH address found in apps**. All WETH
references resolve through per-chain config tables that the audit
inspected entry-by-entry.

---

## Part 3 — Confirmed gaps

**None.**

The audit looked for the specific anti-pattern — code that reads
`wethContract.priceUsd()` (or equivalent) then USES that as "the
value of 1 native-gas unit on this chain". No such code path exists.

---

## Part 4 — Defended-by-architecture observations

The protocol's design explicitly avoids the WETH-as-native-gas
anti-pattern via five layers:

1. **Admin-settable `wethContract` storage slot** —
   `OracleAdminFacet.setWethContract(address)` is owner-only; no
   hardcoded address. Operator MUST set the chain-specific
   bridged WETH per deploy.
2. **VPFIBuyAdapter payment-token policy** — two layers of
   enforcement (deploy-time + runtime) on BNB and Polygon PoS.
3. **Chainlink feed per-chain routing** — `ethNumeraireFeed` is
   admin-set per chain; WETH pricing reads this feed, not native
   gas balance.
4. **Pool-depth quote asset is WETH** — liquidity classification
   uses asset/WETH pool depth, converted to PAD via ETH/PAD feed
   (oracle). Never reads native gas balance.
5. **Per-chain canonical asset lists** — `canonicalAssets.ts`
   explicitly separates tokens by chainId. BNB lists WBNB (not WETH).

---

## Part 5 — Optional hardening (not gaps; defense in depth)

The audit found two low-priority improvements that aren't fixing
bugs but make the chain-specific intent more explicit for future
operators:

1. **Strengthen `OracleAdminFacet.setWethContract` natspec** —
   add an explicit reminder that on BNB / Polygon PoS the value
   MUST be the chain's canonical bridged WETH9, NOT a wrapped-
   native (WBNB / WMATIC). Status: **APPLIED 2026-05-14** in
   the same commit landing this audit.

2. **Document the chain-specific WETH addresses in the deploy
   runbook** — already covered in CLAUDE.md "VPFIBuyAdapter —
   payment-token mode by chain"; nothing to add.

---

## Conclusion

The protocol design explicitly avoids the "WETH == native gas
value" assumption. The user's pending-task entry — "we need to
make WETH address admin-configurable per chain" — turns out to
**already be the design**: `wethContract` IS admin-configurable
per chain via `OracleAdminFacet.setWethContract`, and the chain-
specific bridged WETH addresses for BNB / Polygon PoS are
documented in CLAUDE.md.

No code changes required. The one cheap natspec improvement
landed in the same commit as this audit. Item B.1 is closed.
