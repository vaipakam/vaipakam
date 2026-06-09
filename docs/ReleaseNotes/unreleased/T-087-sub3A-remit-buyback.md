## Thread — T-087 Sub 3.A: per-chain remitBuyback + Base BuybackRemittanceReceiver (PR #<n>)

First slice of Sub 3 (treasury buyback umbrella #452). Wires the cross-chain token delivery that moves accumulated `buybackBudget` from mirror chains to Base, where Sub 3.B/C will later commit Fusion intents from it. Intent dispatch + Fusion submission ship in Sub 3.B/C.

### What changes

**On every chain (Base + mirrors)** — `TreasuryFacet` gains the buyback remittance surface:

- `remitBuyback(srcToken, destToken, amount, refundAddress) payable` — ADMIN-gated; debits `s.buybackBudget[srcToken]`, approves the messenger for `srcToken`, calls `CcipMessenger.sendMessage` with a 1-element TokenAmount list and a 32-byte payload carrying `destToken` (the Base-side address) for cross-validation on the receiver. Surplus `msg.value` refunds. The src/dest split (round-1 P1 #2) handles CCIP's pool mapping where the source-chain and Base-side ERC20 addresses differ.
- `absorbRemittance(token, amount, sourceChainId)` — restricted to the registered `buybackRemittanceReceiver`; credits the Base-side **`baseBuybackBudget`** (round-1 P1 #1 — the slot Sub 3.B's `commitBuybackIntent` will spend from) and emits.
- `creditBuybackBudget(token, amount)` — ADMIN-gated allocator; moves `amount` from `s.treasuryBalances[token]` into the appropriate buyback budget slot. **On Base (`s.isCanonicalRewardChain == true`)** → `baseBuybackBudget` directly; **on mirrors** → `buybackBudget` (gated by `buybackAllowedToken[chainid][token]` to prevent stranding funds in a non-bridgeable token, round-5 P2 #2). The fully-automated split-at-accrual-time hook is a Sub 3 add-on follow-up (#472).
- Admin setters: `setBuybackAllowedToken(chainId, token, allowed)`, `setBuybackNoConvert(token, on)`, `setBuybackRemittanceReceiver(receiver)`, `setCrossChainMessenger(messenger)`. The receiver + messenger setters require contract addresses (round-3 P2 #2 — EOA in either slot opens an `absorbRemittance` inflation attack OR strands tokens).
- Public reads: `getBuybackBudget`, `getBaseBuybackBudget`, `isBuybackAllowedToken`, `isBuybackNoConvert`, `getCrossChainMessenger`, `getBuybackRemittanceReceiver`.

**On Base only** — new `BuybackRemittanceReceiver` UUPS contract:

- Implements `ICrossChainMessageRecipient`. Registered as the buyback channel handler on the CcipMessenger.
- Strict-1-token-per-delivery validation; 32-byte payload pin; declared-token cross-validation; tokens forwarded to Diamond BEFORE `absorbRemittance` (round-7 P2 #8).
- **Fee-on-transfer safe** (round-3 P2 #3 + round-4 P2 #1): reads `spendable = balanceOf(this)` to handle pre-callback CCIP fees + reads `actualReceived = postBal - preBal` on the Diamond to handle post-callback transfer fees; absorbs with the actual amount, never the pre-fee `deliveredAmount`. Common tokens without fees see identical behaviour.
- EOA guards on init + `setMessenger` + `setDiamond` (round-2 P2 #2).
- Guardian + owner pause (`GuardianPausable`); UUPS upgradeable; `Ownable2Step` two-step transfer; CCIP guardian wired by `ConfigureCcip._setGuardians` (round-4 P2 #2).

### Per design discussion 2026-06-09

The `buybackNoConvert` flag is the key product decision. ETH from `buyVPFIWithETH` callers must NEVER be remitted cross-chain or treasury-converted — it goes to operational reserve + VPFI/ETH LP seeding (per #455). The flag now blocks BOTH paths uniformly (round-1 P2): `remitBuyback` AND `convertTreasuryAsset` reject the token. Admin marks the relevant WETH / native-mirror addresses with `setBuybackNoConvert(token, true)` after this PR lands.

### Storage additions (append-only)

- `address crossChainMessenger` — the CcipMessenger address. The Diamond is itself the registered channel handler for the buyback channel and calls `sendMessage` directly. This same messenger serves any future cross-chain flow the Diamond originates.
- `mapping(address => bool) buybackNoConvert` — the per-token exemption list.

(`buybackBudget`, `baseBuybackBudget`, `buybackAllowedToken`, `buybackRemittanceReceiver`, `baseChainId`, `isCanonicalRewardChain` already existed from Sub 2 / pre-design landings.)

### Producer artifacts

- `_getTreasurySelectors()` in `DeployDiamond.s.sol` grows from 4 → **17** (13 new selectors: 3 buyback methods including `creditBuybackBudget` + 4 admin setters + 6 reads).
- `HelperTest.sol` mirror grows from 4 → 17.
- `TreasuryFacet.json` regenerated; frontend `tsc -b --noEmit` clean.

### Deploy script wiring (round-2 P1 #1 + round-3 P1 + round-4 P1 + round-5 P2 #1)

- `Deployments.sol` lib: new `writeBuybackRemittanceReceiver` / `writeBuybackRemittanceReceiverImpl` writers.
- `DeployCrosschain.s.sol`: on canonical Base, deploy `BuybackRemittanceReceiver` behind ERC1967 proxy + record both impl + proxy addresses.
- `ConfigureCcip.s.sol`:
  - New `VPFI_BUYBACK_CHANNEL` constant.
  - Ctx gains `localBuybackHandler` (BuybackRemittanceReceiver on Base; the Diamond on mirrors — it's the source-sender).
  - `_registerChannels` registers the buyback channel.
  - `_wireChannelPeers` peers Base ↔ each mirror.
  - `_setGuardians` wires the guardian on the buyback receiver too.
  - New `_wireDiamondBuybackConfig` step calls `setCrossChainMessenger` on every chain + `setBuybackRemittanceReceiver` on Base — without this, `remitBuyback` would revert `CrossChainMessengerNotSet` on mirrors and `absorbRemittance` would reject every inbound on Base.
- `Handover.s.sol`: reads `.buybackRemittanceReceiver` from the deployment JSON and includes it in the cross-chain ownership transfer batch; NEXT STEP printout lists it as a Timelock-accept target.

### Test coverage

22 new tests in `TreasuryBuybackRemittanceTest.t.sol` + 14 new tests in `BuybackRemittanceReceiverTest.t.sol`:

- Admin: every setter happy-path + reject zero + reject non-admin + reject EOA on receiver + messenger setters.
- `remitBuyback` invariants: no-convert / not-allowed / messenger-not-set / zero-amount / zero-refund reverts.
- `absorbRemittance`: sender-only, credits **baseBuybackBudget** (not the per-chain accumulator), additive, event emit.
- `convertTreasuryAsset`: no-convert flag rejection.
- `creditBuybackBudget`: not-admin, no-convert, insufficient-treasury reverts.
- `BuybackRemittanceReceiver` inbound: happy-path forwarding, init guards, EOA guards on init + setters, sender check, token-count validation (0 / 2+ rejection), payload-size pin, token cross-validation, zero-amount rejection, admin rotation.

### Out of scope (Sub 3.B/C/D)

- 1inch Fusion intent commit + dispatch (Sub 3.B).
- Fusion TWAP order shape (Sub 3.C).
- End-to-end CCIP round-trip integration test + FunctionalSpec + Advanced UG (Sub 3.D).

### Out of scope (Sub 3 add-ons, post-design discussion)

- Fee-converted VPFI priority routing (rewards → keepers → staking pool) — #472.
- Productive treasury reserve (Aave WBTC + Lido ETH) — #473.
- Keeper VPFI rewards (2x gas, LP-TWAP-priced, cash-out option) — #474.

### Verification

- 36 new tests green (22 + 14).
- Existing TreasuryFacet 7/7 + TreasuryConvertAndPayroll 24/24 still green.
- Deploy-sanity 12/12.
- Frontend `pnpm exec tsc -b --noEmit` clean.
