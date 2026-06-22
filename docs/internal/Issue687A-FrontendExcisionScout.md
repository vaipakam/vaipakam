# #687-A frontend/agent/copy excision — execution checklist (scout)

Scope: the TypeScript/React/agent/copy surface of removing the VPFI
fixed-rate SALE. The on-chain contracts + deploy scripts are done in the
contracts PR (#687-A); this is the **follow-up sub-card** because the
surface (BuyVPFI.tsx ~2885 lines, 20 i18n bundles, user-guide ×20,
whitepaper, marketing) is too large to fold into the contracts PR while
keeping it reviewable.

**KEEP (do not remove):** the consumptive VPFI fee-discount utility —
`depositVPFIToVault`/`withdrawVPFIFromVault`, discount tiers, consent,
`getVPFIDiscountConfig`/`setVPFIDiscountRate`/`setVPFIDiscountETHPriceAsset`.
Staking-rewards claim UI + interaction-rewards claim UI stay until #687-B.

**CLAUDE.md rule:** marketing/whitepaper/user-guide must NOT describe the
sale at all (removed end-state, not "paused").

## Whole-file deletes
- `apps/agent/src/buyWatchdog.ts` (280 lines, 100% buy)
- `apps/defi/src/hooks/useVPFIBuyBridge.ts` (435 lines, 100% buy)
- `apps/defi/src/lib/buyAssetInfo.ts` (verify with grep it's buy-only first)
- `packages/contracts/src/abis/VpfiBuyAdapter.json` + `VpfiBuyReceiver.json`
  (regenerated-away by exportFrontendAbis.sh once FACETS list is pruned —
  already pruned in contracts PR)

## Prune (imports/handlers/fields)
- `packages/contracts/src/abis/index.ts` — drop the 2 `VpfiBuy*ABI` imports
  + the 2 named exports (they are NOT in DIAMOND_ABI, standalone only).
- `apps/agent/src/index.ts` — drop `import { runBuyWatchdog }` + its
  `ctx.waitUntil(runBuyWatchdog(...))` block in `scheduled()` + docstring bullet.
- `apps/agent/src/env.ts` — update RPC_* comment (no longer buy-watchdog);
  `getChainConfigs()` needs no code change (filters by getDeployment). Decide
  whether RPC_POLYGON/RPC_POLYGON_AMOY stay (keep iff those chains have a
  Diamond used by periodicPreNotify).
- `apps/agent/src/intentFusionPost.ts` — NO CHANGE (swap-to-repay, unrelated).
- `apps/defi/src/contracts/config.ts` — drop `vpfiBuyAdapter` field; keep
  diamondAddress/isCanonicalVPFI/getCanonicalVPFIChain.
- `apps/defi/src/lib/protocolConsoleKnobs.ts` — remove the
  `reconciliationWatchdogEnabled` knob entry (~L477-504).
- `apps/defi/src/hooks/useAdminKnobValues.ts` — remove the `vpfiBuyReceiver`
  resolution useMemo + the `knob.getter.facet === 'VpfiBuyReceiver'` branch +
  the `VpfiBuyReceiverABI` import.
- `apps/defi/src/i18n/glossary.ts` + `apps/www/src/i18n/glossary.ts` — remove
  the 4 contract-name entries (VPFIBuyAdapter/Receiver + VpfiBuyAdapter/Receiver).

## Heavy refactor — apps/defi/src/pages/BuyVPFI.tsx (~2885 lines → ~40%)
Rename component `BuyVPFI` → `VPFIVaultAndDiscounts`; route `/buy-vpfi` →
`/vpfi-vault` (keep a redirect for deep-links). REMOVE: the Step-1 buy card
(BuyCard/BridgedBuyCard), FlowBanner/BridgeLandedBanner, `handleBuy`/
`handleBridgedBuy`, buy-config/quote reads, `ethInput`, `ETH_GAS_RESERVE_WEI`,
`useVPFIBuyBridge`, `VpfiBuyAdapterABI` import, bridged-buy balance detection.
KEEP+renumber: deposit (handleDeposit), unstake (handleUnstake),
DiscountStatusCard, staking/interaction claim cards, VPFIPanel. Step type
`Step` → `VaultStep` (deposit/unstake states only). Entanglement: the
`useVPFIDiscount` hook stays (discount-tier reads need it) — just stop reading
its buy-config fields.

## Routing/nav
- `apps/defi`: Navbar.tsx + Footer.tsx + AppLayout.tsx — drop buy menu entry /
  repoint to the vault page. App.tsx route rename + redirect.
- `apps/www`: App.tsx route, Navbar/Footer/Hero CTA, `pages/BuyVPFIMarketing.tsx`
  (refactor to a discount/benefits page — remove all sale framing — or delete).

## Copy / i18n (mechanical, 10 languages each)
- `apps/defi/src/i18n/locales/*.json` — remove `buyVpfi.*` sale keys, migrate
  deposit/unstake/discount keys to a `vpfiVault.*` namespace.
- `apps/www/src/i18n/locales/*.json` — same, migrate to `vpfiDiscounts.*`.
- `apps/www/src/content/userguide/{Basic,Advanced}.<lang>.md` (×10 each) +
  `whitepaper/Whitepaper.en.md` — remove all "buy VPFI at fixed rate" /
  cross-chain-buy / caps sections; keep discount + tokenomics.

## Verify
`pnpm --filter @vaipakam/contracts build` then per-app `tsc`:
`@vaipakam/{defi,www,agent}`. Final grep must be zero for `buyVpfi`,
`VpfiBuyAdapter`, `VpfiBuyReceiver`, `useVPFIBuyBridge`, `buyWatchdog`,
`reconciliationWatchdog` (except deliberate historical refs).
Then `exportFrontendAbis.sh` re-export + `_source.json` stamp.
