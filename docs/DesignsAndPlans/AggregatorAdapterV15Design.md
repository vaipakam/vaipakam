# ERC-4626 Aggregator Lender-Adapter — v1.5 implementation design (#398 / #401 phase v1.5)

**Scope:** ERC20-on-ERC20 only. The outward adapter that lets a yield aggregator
(Yearn-style) deposit capital into Vaipakam through a standard ERC-4626 face and
have it lent continuously via the intent layer. Builds on the now-complete
LenderIntentVault (#393). Inward yield-collateral wrapper = SKIP (per the #398
verdict).

**Precondition:** #621 verdict (offer-principal and intent-capital liens stay
ISOLATED) — so the adapter's accounting is intent-side only, no cross-pool
reconciliation.

## 1. What it is

A standards-compliant **ERC-4626** contract, **one instance per aggregator**, that
*is itself a Vaipakam lender*: it owns a per-user vault (via the existing factory)
and registers a `LenderIntent`. The aggregator `deposit`/`withdraw`/`redeem`s; the
adapter routes capital into its intent (`fundLenderIntent`) and back out
(`withdrawLenderIntentCapital`); a keeper matches (`matchIntent`) and auto-rolls
(`rollIntentLoan`) it. The aggregator's retail depositors commingle *inside the
aggregator*, off-Vaipakam — we adopt the ERC-4626 *interface*, never the pooled
custody.

One adapter = one `asset()` (the lending asset) + one fixed collateral asset (the
intent's pair). An aggregator lending multiple pairs gets multiple adapters.

## 2. Topology (mirrors the per-user vault pattern)

| Layer | Cardinality | Upgradeable | Holds |
| --- | --- | --- | --- |
| `AggregatorAdapterFactoryFacet` | one (Diamond facet) | Diamond-governed | provisions adapters + the shared-impl version registry |
| `AggregatorAdapterImplementation` | one shared logic | **UUPS, owner = Diamond** | the code |
| Adapter `ERC1967Proxy` | **one per (aggregator, asset-pair)** | shares the impl | ERC-4626 shares + transient deposit funds |
| per-user vault | one per adapter | already UUPS | the adapter's idle/proceeds custody |
| `LenderIntent` | one per adapter | Diamond storage | the standing-supply terms |

E1: a single shared ERC-4626 serving many aggregators would pool them into one
share token (commingling) — forbidden. Hence per-aggregator instances; the factory
is the single provisioning funnel, the impl is shared + upgradeable.

## 3. Single-principal enforcement (E1, two layers)

- **`deposit`/`mint` caller-restricted** to the one authorized aggregator
  (`authorizedPrincipal`). Both `caller` and `receiver` must equal it.
- **Shares non-transferable.** Override OZ ERC20 `_update` to permit only
  mint (`from == 0`) and burn (`to == 0`); revert any holder→holder transfer.
  (Gating only deposits is insufficient — ERC-20 shares are transferable, so the
  principal could move shares and re-create multi-principal exposure.)

## 4. Capital flow

**Provisioning (`AggregatorAdapterFactoryFacet.createAggregatorAdapter`)** — deploys
the proxy + `initialize(...)` (gated to the Diamond deploy path). On init the
adapter, acting as itself (`msg.sender == adapter`), calls the Diamond:
`setLenderIntent(bounds)` with `requiresKeeperAuth = true` and records the
designated `keeper`. It grants **no Diamond-level keeper authority** — matching +
auto-roll run only through the adapter's own screened forwarders (below), and the
keeper-gated intent means no external solver can fill it on the Diamond directly.

**Deposit** (`deposit(assets, receiver)`):
1. gate `caller == receiver == authorizedPrincipal`;
2. OZ `_deposit` pulls `assets` from the aggregator into the adapter + mints shares
   at the pre-deposit share price (`convertToShares` over the §5 `totalAssets`);
3. override `_deposit`'s post-step: `IERC20(asset).forceApprove(diamond, assets)` +
   `LenderIntentFacet.fundLenderIntent(lend, coll, assets)` → moves the assets
   adapter→adapter's vault + liens them as idle intent capital.

**Withdraw/redeem** (`withdraw`/`redeem`, capped to idle — see §6): override
`_withdraw` to first `LenderIntentFacet.withdrawLenderIntentCapital(lend, coll,
assets)` (vault→adapter), then OZ `_withdraw` burns shares + transfers assets
adapter→aggregator.

**Matching + compounding + recovery** — keeper/principal-driven through the
adapter's SCREENED forwarders (so every value-moving path screens the real
principal — the Diamond only ever sees the clean adapter):
- `matchLoan(cp, fill)` → calls `matchIntent` as the intent owner (keeper-gate
  self-branch); deploys idle capital to a borrower.
- `rollLoan(loanId)` → calls `rollIntentLoan`; re-liens repaid principal+interest
  into idle (compounding).
- `claimAndCompound(loanId, retryCalls)` → for a resolved-but-non-rollable loan
  (default/fallback), `claimAsLenderWithRetry` recovers the proceeds to the
  adapter and best-effort re-funds them into idle.

Each forwarder is keeper/principal-gated, `_screenPrincipal()`-gated (Tier-1
sanctions on the REAL aggregator), and halted below a mandatory upgrade floor.
The adapter reads the resulting intent state for NAV.

## 5. NAV — `totalAssets()` (conservative-haircut, ratified 2026-06-17)

```
totalAssets = idle + riskAdjustedLive
  idle             = LenderIntentFacet.getLenderIntentCapital(adapter, lend, coll)
  live             = LenderIntentFacet.getLenderIntentLivePrincipal(adapter, lend, coll)
  riskAdjustedLive = live * (BPS - haircutBps) / BPS
```

- **`idle`** is un-lent liened capital — and because `rollIntentLoan` compounds the
  FULL repaid amount (principal + interest) back into capital, idle already
  reflects **realized/collected** yield.
- **`live`** counts only the ORIGINAL fill *principal* (not interest), marked down
  by a per-asset governance `haircutBps`. So **accrued-but-unpaid interest is
  excluded** until a roll realizes it into idle — the mark only moves up on
  *collected* gains, never on unrealized ones.
- No double-count: `rollIntentLoan` atomically moves a loan's principal from `live`
  to `idle`, so each loan's principal is in exactly one term.
- Defaults are realized as a write-down: on default-claim, `releaseIntentExposure`
  drops `live`; recovered collateral the keeper claims + re-funds (`fundLenderIntent`)
  re-enters `idle`. Pre-re-fund the mark conservatively understates (safe).
- `haircutBps` is a per-asset governance param in Diamond config
  (`AdminFacet.setAggregatorHaircutBps(asset, bps)`, range-bounded ≤ some max),
  read by the adapter via a view. Default a conservative non-zero value.

**`convertToShares`/`convertToAssets`** use this `totalAssets` — so the aggregator's
share price reflects conservative, realized NAV (protecting *its* downstream
depositors' fairness).

## 6. Withdrawable ≠ marked

`maxWithdraw` / `maxRedeem` are capped to **idle only** (`getLenderIntentCapital`),
NOT `totalAssets` — capital out on live loans is illiquid until it repays + rolls.
This is the ERC-4626 "vault with illiquid underlying" pattern. A redeem for more
than idle reverts; the aggregator withdraws as loans mature (or cancels the intent
to wind down, then withdraws as capital returns).

## 7. Upgradeability — aggregator-pull, governance-mandate backstop (mirrors the vault)

Same three-part model the per-user vault uses (verified in `VaultFactoryFacet`):
1. **Governance publishes** a new impl — `AggregatorAdapterFactoryFacet
   .upgradeAdapterImplementation(newImpl)` (`VAULT_ADMIN_ROLE` → timelock); bumps
   `currentAdapterVersion`; existing proxies keep the old impl.
2. **Aggregator pulls** the migration — `upgradeAggregatorAdapter(adapter)`
   (permissionless trigger; the Diamond owns the proxy so it mediates the UUPS
   `upgradeToAndCall`). The aggregator audits the new impl + opts in — no silent
   behavior change under a live integration. Address-stable (integration keeps
   working).
3. **Governance mandate backstop** — `setMandatoryAdapterUpgrade(version)`; below it,
   adapter ops revert until migrated (upgrade-or-halt for a critical fix).

`_authorizeUpgrade` is `onlyOwner` (= Diamond). The mandate path is reserved for
security fixes and routed through the timelock so the aggregator (and its
depositors) get notice.

## 8. Build checklist

- `contracts/src/crosschain`-style new dir? No — `contracts/src/AggregatorAdapterImplementation.sol`
  (alongside `VaipakamVaultImplementation.sol`) + `contracts/src/facets/AggregatorAdapterFactoryFacet.sol`.
- Storage: factory state in `LibVaipakam` (currentAdapterVersion, adapterVersion[adapter],
  mandatoryAdapterVersion, per-asset haircutBps, aggregatorAdapters registry).
- Diamond wiring: add the facet to `DiamondFacetNames.cutFacetNames()`,
  `_getAggregatorAdapterFactorySelectors()` in `DeployDiamond.s.sol` + `HelperTest.sol`,
  and `SelectorCoverageTest`.
- `AdminFacet.setAggregatorHaircutBps` (range-bounded).
- Tests: `AggregatorAdapterTest.t.sol` — provision; deposit→fundIntent→matchIntent
  (NAV reflects idle→live haircut); roll compounds (NAV up by realized interest);
  withdraw capped to idle; redeem-over-idle reverts; share non-transfer reverts;
  unauthorized deposit reverts; default write-down; pull-migrate + mandatory-floor.
- ABI/frontend export (new facet + adapter), deploy-sanity, regression deferred to
  pre-testnet.
- PR + `@codex full security-critical` (fund-holding, moderate audit).

## 9. Audit scope (HybridIntentLayer §6 — moderate)

Share-accounting correctness; `totalAssets` mark integrity (no overstatement →
no early-redeemer value extraction for the aggregator's depositors); single-
principal + non-transfer enforcement; the deposit→fundIntent / withdraw←capital
orchestration; upgrade authority = timelock. The backstop (#399) remains the
high-surface piece, sequenced later.
