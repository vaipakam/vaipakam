## Thread — T-087 Sub 3.A: per-chain remitBuyback + Base BuybackRemittanceReceiver (PR #<n>)

First slice of Sub 3 (treasury buyback umbrella #452). Wires the cross-chain token delivery that moves accumulated `buybackBudget` from mirror chains to Base, where Sub 3.B/C will later commit Fusion intents from it. This slice is intent-free.

### What changes

**On every chain (Base + mirrors)** — `TreasuryFacet` gains the buyback remittance surface:

- `remitBuyback(token, amount, refundAddress) payable` — ADMIN-gated; debits `s.buybackBudget[token]`, approves the messenger, calls `CcipMessenger.sendMessage` with a 1-element TokenAmount list and a 32-byte payload carrying the declared token address for cross-validation on the Base receiver. Surplus `msg.value` refunds.
- `absorbRemittance(token, amount, sourceChainId)` — restricted to the registered `buybackRemittanceReceiver`; credits the Base-side `buybackBudget` and emits.
- Admin setters: `setBuybackAllowedToken(chainId, token, allowed)`, `setBuybackNoConvert(token, on)`, `setBuybackRemittanceReceiver(receiver)`, `setCrossChainMessenger(messenger)`. All ADMIN-gated; eventually transferred to governance timelock.
- Public reads: `getBuybackBudget`, `isBuybackAllowedToken`, `isBuybackNoConvert`, `getCrossChainMessenger`, `getBuybackRemittanceReceiver`.

**On Base only** — new `BuybackRemittanceReceiver` UUPS contract:

- Implements `ICrossChainMessageRecipient`. Registered as the buyback channel handler on the CcipMessenger.
- Strict-1-token-per-delivery (`WrongTokenCount` rejection for `0` or `2+` tokens — round-8 P2 #6).
- 32-byte payload pin (`PayloadSizeMismatch` rejection for any other length).
- Token cross-validation (`TokenMismatch` rejection when `payload.declaredToken != tokens[0].token` — round-7 P1 #6).
- Forwards the delivered token to the Diamond BEFORE calling `absorbRemittance` (round-7 P2 #8).
- Guardian + owner pause; UUPS upgradeable; Ownable2Step.

### Per design discussion 2026-06-09

The `buybackNoConvert` flag is the key product decision. ETH from `buyVPFIWithETH` callers must NEVER be remitted cross-chain or treasury-converted — it goes to operational reserve + VPFI/ETH LP seeding (per [#455](https://github.com/vaipakam/vaipakam/issues/455)). Admin marks the relevant WETH / native-mirror addresses with `setBuybackNoConvert(token, true)` after this PR lands.

### Storage additions (append-only)

- `address crossChainMessenger` — the CcipMessenger address. The Diamond is itself the registered channel handler for the buyback channel and calls `sendMessage` directly. This same messenger serves any future cross-chain flow the Diamond originates.
- `mapping(address => bool) buybackNoConvert` — the per-token exemption list.

(`buybackBudget`, `buybackAllowedToken`, `buybackRemittanceReceiver`, `baseChainId` already existed from Sub 2 / pre-design landings.)

### Producer artifacts

- `_getTreasurySelectors()` in `DeployDiamond.s.sol` grows from 4 → 15 (11 new selectors: 2 buyback methods + 4 admin setters + 5 reads).
- `HelperTest.sol` mirror grows from 4 → 15.
- `TreasuryFacet.json` regenerated; frontend `tsc -b --noEmit` clean.

### Channel constant

`VPFI_BUYBACK_CHANNEL = keccak256("vaipakam.ccip.channel.vpfi-buyback")` — to be registered on each chain's CcipMessenger as the operator step ([CCIP Migration runbook](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md)):

- On every mirror: `messenger.registerChannel(VPFI_BUYBACK_CHANNEL, address(diamond))` — the Diamond is the source-sender.
- On Base: `messenger.registerChannel(VPFI_BUYBACK_CHANNEL, address(buybackRemittanceReceiver))`.
- On Base: `messenger.setChannelPeer(VPFI_BUYBACK_CHANNEL, mirrorChainId, mirrorDiamond)` per supported mirror.

### Test coverage

15 new tests in `TreasuryBuybackRemittanceTest.t.sol` + 11 new tests in `BuybackRemittanceReceiverTest.t.sol`:

- Admin: all setters happy-path + reject zero + reject non-admin.
- `remitBuyback` invariants: no-convert / not-allowed / messenger-not-set / zero-amount reverts.
- `absorbRemittance`: sender-only, additive budget credit, event emit.
- `BuybackRemittanceReceiver` inbound: happy-path forwarding, init guards, sender check, token-count validation (0 / 2+ rejection), payload-size pin, token cross-validation, zero-amount rejection, admin rotation.

### Out of scope (Sub 3.B/C/D)

- 1inch Fusion intent commit + dispatch (Sub 3.B).
- Fusion TWAP order shape (Sub 3.C).
- End-to-end CCIP round-trip integration test + FunctionalSpec + Advanced UG (Sub 3.D).

### Out of scope (Sub 3 add-ons, post-design discussion)

- Fee-converted VPFI priority routing (rewards → keepers → staking pool) — [#472](https://github.com/vaipakam/vaipakam/issues/472).
- Productive treasury reserve (Aave WBTC + Lido ETH) — [#473](https://github.com/vaipakam/vaipakam/issues/473).
- Keeper VPFI rewards (2x gas, LP-TWAP-priced, cash-out option) — [#474](https://github.com/vaipakam/vaipakam/issues/474).

### Verification

- 26 new tests green (15 + 11).
- Existing TreasuryFacet 7/7 + TreasuryConvertAndPayroll 24/24 still green.
- Deploy-sanity 12/12.
- Frontend `pnpm exec tsc -b --noEmit` clean.
