# Release Notes — 2026-05-05

Testnet deploy hardening + protocol-console fixes. The contract surface
shipped on 2026-05-04 (Base Sepolia + Sepolia) revealed a chain of
operator-side and frontend-side gaps that this day's work closes. No
mainnet deploys.

## Testnet flow-test sweep on Base Sepolia — 49/49 scenarios PASSED

The diamond deployed at `0x94F551549898d23a5645F8628dE57d2E0C56c776` on
Base Sepolia was exercised end-to-end against four flow-test scripts
(after the master-flag flip described below):

- **SepoliaPositiveFlows** — 15/15 (NFT ERC721/1155 + rental, illiquid
  lending, classic ERC-20 lifecycle, third-party repay, cancel offers).
- **AnvilNewPositiveFlows** — 18/18 (range orders, partial repay,
  refinance, preclose 2/3, recovery happy path + sanctioned-source ban,
  disown, sanctions Tier-1/Tier-2, keeper per-action authorization,
  VPFI staking + discount + claim rebate, unstake, per-asset pause,
  global pause, treasury accrual, master-flag dormancy,
  sellLoanViaBuyOffer).
- **AnvilNewPartialFlows** — 7/7 (offer states, partial-repay midpoint,
  collateral doubled, keeper enabled, refinance offer posted, stray
  token in escrow, dual claimable side-by-side).
- **AnvilNegativeFlows** — 9/9 (range bounds, fallback consent,
  self-collateralized offer, zero duration, collateral floor, claim
  before terminal, partial repay opt-out).

Same total holds on Sepolia by parity (mirror chain).

## Pre-existing bugs surfaced + fixed

### Diamond selector gap — 38 functions missing on-chain

A comprehensive audit of every external/public function on three
configuration facets versus what `DeployDiamond.s.sol` registers
revealed:

- **ConfigFacet** — 27 of 55 functions missing (master-flag
  single-getters, periodic-interest knobs, predominantly-available-
  denominator knobs, grace-bucket admin, numeraire knobs).
- **OracleAdminFacet** — 10 of 30 functions missing (Pyth
  cross-check oracle setters + 5 individual getters).
- **RewardReporterFacet** — 1 of 12 missing (`getRewardGraceSeconds`).

The functions existed in source but were never wired into the
diamond's selector arrays, so the diamond's fallback returned
`FunctionDoesNotExist()` for every protocol-console knob read.

**Resolution:**

1. Source additions — added 4 single-field getters to ConfigFacet
   (`getRangeAmountEnabled` / `getRangeRateEnabled` /
   `getPartialFillEnabled`, plus `getRewardGraceSeconds` to
   RewardReporterFacet). The other 34 functions already existed in
   source; only the diamond registration was missing.
2. `script/DeployDiamond.s.sol` — `_getConfigSelectors` grew 28 → 55,
   `_getOracleAdminSelectors` 20 → 30, `_getRewardReporterSelectors`
   11 → 12. Fresh deploys now ship with the complete protocol-console
   surface.
3. `test/HelperTest.sol` — mirrored the same growth (45 → 55 for
   ConfigFacet, 11 → 12 for RewardReporter). OracleAdminFacet stays
   un-cut in HelperTest by design — tests bypass owner-gated setters
   via `TestMutatorFacet.setWethContractRaw` and friends.
4. `script/ReplaceStaleFacets.s.sol` — extended to a 9-cut diamondCut
   that deploys fresh ConfigFacet + OracleAdminFacet + RewardReporterFacet
   bytecode and does Replace+Add for every selector across the three
   facets (plus the original Offer/Oracle/EscrowFactory replaces).
   Run on both testnets with `ADMIN_PRIVATE_KEY` (admin owns the
   diamond pre-rotation).
5. `forge test --no-match-path test/invariants/*` — 1613/1613 PASS
   after every change.

### Frontend Diamond ABI — `OracleAdminFacetABI` never spread

`frontend/src/contracts/abis/index.ts` exports per-facet ABIs and
composes a unified `DIAMOND_ABI` by spreading 27 of them. The
`OracleAdminFacet` per-file export was imported but **never spread
into `DIAMOND_ABI`**, so every viem `readContract({ abi:
DIAMOND_ABI_VIEM, functionName: 'getPyth*' })` returned "Function not
found on ABI" before it even hit the chain — even though the
contract had the selector and returned values via direct `cast call`.

**Resolution:** added `import OracleAdminFacetABI from
'./OracleAdminFacet.json'`, the named export, and the
`...OracleAdminFacetABI` spread into `DIAMOND_ABI`. Frontend
typecheck + Vite build clean.

### Frontend protocol-console knob references — 2 stale setter names

`frontend/src/lib/protocolConsoleKnobs.ts` referenced
`OracleAdminFacet.setPythNumeraireFeedId` and
`OracleAdminFacet.setPythNumeraireMaxDeviationBps`. The actual contract
setter names are `setPythCrossCheckFeedId` and
`setPythCrossCheckMaxDeviationBps` (the getter names diverged from the
setter names during a rename pass). Knob registry updated to use the
canonical setter names.

### Frontend VPFIBuyReceiver knob — `no-target` on non-canonical chains

The "Reconciliation watchdog" knob targets `VPFIBuyReceiver`, which by
design lives only on canonical-VPFI chains (Base / Base Sepolia). On
mirror chains (Sepolia, Arb Sepolia, Polygon Amoy, etc.) the
deployments JSON has `vpfiBuyReceiver: null` because the cross-chain
buy mesh has many adapters → one canonical receiver. The protocol
console correctly resolved the target to null but surfaced "read
failed: no-target", which is confusing for users who can't act on
that chain anyway.

**Resolution:** `pages/AdminDashboard.tsx` now filters out every knob
whose `getter.facet === 'VPFIBuyReceiver'` when
`readChain.isCanonicalVPFI !== true`. The card is hidden cleanly on
mirror chains; appears as before on Base / Base Sepolia.

### Watcher chain-indexer `kind` literal mismatch

`hf-watcher/src/chainIndexer.ts` writes `indexer_cursor` rows with
`kind = 'diamond'` (one indexer scans the diamond's full event
surface — offers + loans together). `hf-watcher/src/offerRoutes.ts`
was reading with `kind = 'offers'` — a stale literal from before the
indexers were unified. The cursor lookup always returned null →
`/offers/stats` exposed `"indexer": null` to the frontend → the
"connected/disconnected" badge stayed permanently amber even though
the indexer was working perfectly (44 offers + 12 loans observed live
during this work).

**Resolution:** `offerRoutes.ts` now reads `kind = 'diamond'` to match
the writer. Watcher redeployed; `/offers/stats` now returns
`indexer: { lastBlock, updatedAt }` and the frontend badge turns
green on next read.

## Operational ergonomics — automated post-deploy steps

Three steps that previously required manual operator action were
folded into `deploy-chain.sh` (testnet only — mainnet preserves
its tiered confirm-each-phase discipline):

### `[5b]` Master-flag auto-flip on testnet

Range Orders Phase 1's three governance-gated kill switches
(`rangeAmountEnabled`, `rangeRateEnabled`, `partialFillEnabled`)
default `false` per `docs/RangeOffersDesign.md §15` staged-enablement
rationale. The Anvil bootstrap script flipped them; `deploy-chain.sh`
did not. So Base Sepolia's first deploy came up with the flags OFF
and `AnvilNewPositiveFlows.N22` + every range-offer scenario in
`AnvilNewPartialFlows` failed with `FunctionDisabled(1)`. After the
manual cast send to flip them, the same scripts passed.

`deploy-chain.sh` now runs `cast send <diamond> 'set*Enabled(true)'`
for each of the three flags after the contract deploy completes,
gated on `ADMIN_PRIVATE_KEY` being present. Idempotent — re-flipping
an already-true flag is a successful no-op tx. `deploy-mainnet.sh`
intentionally does NOT call this — production rollout remains gated
on governance.

### `[8b]` D1 migrations on watcher deploy

The watcher returned 500 `byParticipant-failed` (D1_ERROR no such
table) for every loan / offer query because the operator workflow
required a separate `npm run db:migrate` step that was easy to miss.
`deploy-chain.sh §8b` and `deploy-mainnet.sh phase_cf_watcher` now
run `npm run db:migrate` on every deploy. Wrangler's migration
applier is idempotent — already-applied entries are skipped.

### `[8c]` RPC-secret presence check

The watcher returned 503 `chain-not-configured` for any chain whose
`RPC_<CHAIN>` Cloudflare secret wasn't set. The script now runs
`wrangler secret list` and warns (does not fail) when the expected
per-chain RPC secret is missing, with the exact `wrangler secret put`
command to set it. Per `CLAUDE.md`, RPC secrets carry API keys and
stay operator-curated — the script never auto-populates them.

## Verification (live state at 2026-05-05)

- **Base Sepolia diamond** (`0x94F5…c776`)
  - `getMasterFlags()` → `(true, true, true)` ✓
  - `getTreasuryFeeBps()` → 100 ✓
  - `getLifMatcherFeeBps()` → 100 ✓
  - `getRewardGraceSeconds()` → 14400 ✓
  - `getPythMaxStalenessSeconds()` → 300 ✓
  - `getSecondaryOracleMaxStaleness()` → 3600 ✓
  - VPFIBuyReceiver `reconciliationWatchdogEnabled()` → true ✓
- **Sepolia diamond** (`0x3458…8eb7`) — same flag state (`true,
  true, true`) post-flip
- **Watcher** (`vaipakam-hf-watcher` Version
  `e78af698-63ab-4daf-9e29-6507ed0f4ba8`)
  - `/offers/stats?chainId=84532` returns `indexer: { lastBlock:
    41070911, updatedAt: 1777910112 }` ✓
  - `/loans/by-lender/...?chainId=84532` returns 12 indexed loans ✓
- **Frontend** (`vaipakam` Version
  `53095de8-9861-4444-b154-223e9823332e`)
  - `tsc -b --noEmit` clean ✓
  - DIAMOND_ABI now spreads 28 facets (was 27) — OracleAdminFacet
    fully surfaced ✓
  - VPFIBuyReceiver knob hidden on non-canonical chains ✓
- **Forge test regression** — 1613/1613 PASS, 0 failed (after every
  contract change in this session)

## What this PR does NOT do

- Push to remote — local merges and deploys only. The 122 commits
  ahead of `origin/main` (from yesterday's session) plus today's
  changes are still local.
- Flip master flags on mainnet — staged rollout discipline preserved
  for production. Governance flips them via `setRange*Enabled(true)`
  through the Timelock when ready.
- Set RPC secrets via wrangler from the script — operator-curated
  values per `CLAUDE.md` "Cross-Chain Security" section. The deploy
  scripts now warn when missing, with the exact `wrangler secret
  put` command to run.
- Bump `currentTosVersion` / `currentTosHash` on-chain. The retail
  deploy continues to run with `currentTosVersion == 0` (gate
  dormant); when governance flips it on, the canonical text in
  `docs/Terms/TermsOfService.md` is what should be pinned.
