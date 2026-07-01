# CCIP & External Infra Addresses — Deploy Reference

Chainlink CCIP infrastructure (and other external/public) addresses the deploy
scripts read from `.env` per chain. These are **published by the provider**
(Chainlink / chain canonical lists), not deployed by us — copy them into
`contracts/.env` before deploying a chain so `deploy-testnet.sh` /
`deploy-chain.sh` can wire the cross-chain layer.

**How the scripts consume these** (see `deploy-testnet.sh` / `deploy-chain.sh`):
the per-slug form is **required** — a bare `CCIP_ROUTER` with no matching
`CCIP_ROUTER_<SLUG>` is a deliberate hard-error (it would silently wire the
wrong chain's router). The active chain's set is resolved from `<VAR>_<SLUG>`,
so one `.env` serves every chain without manual editing between runs.

- `--phase contracts` needs: `CCIP_ROUTER_<SLUG>`, `CCIP_RMN_PROXY_<SLUG>`
- `--phase ccip-wire` additionally needs: `CCIP_TOKEN_ADMIN_REGISTRY_<SLUG>`,
  `CCIP_REGISTRY_MODULE_OWNER_CUSTOM_<SLUG>`, and **`CCIP_GUARDIAN`** — a single
  **global** address (NOT per-slug; the incident guardian, typically the Pauser
  Safe). `ccip-wire` now hard-errors if it is unset: `ConfigureCcip` wires the
  guardian onto every `GuardianPausable` cross-chain contract, and setting it is
  owner-only — so it MUST land while ADMIN still owns those contracts (before
  handover). Left unset, only the governance timelock could pause them after
  handover, defeating `pause-all-chains.sh`'s fast incident-containment path.

`<SLUG>` ∈ `{ BASE_SEPOLIA, ARB_SEPOLIA, BNB_TESTNET, SEPOLIA, OP_SEPOLIA,
POLYGON_AMOY }` (matches the `CCIP_SLUG` in each script's chain registry).

> Source: Chainlink CCIP Directory — https://docs.chain.link/ccip/directory/testnet
> Verified: 2026-07-01. Re-confirm against the directory before a mainnet or
> high-value deploy; provider addresses can change between CCIP releases.

---

## Testnet — Phase-1 deploy trio

### Base Sepolia — chainId `84532` — slug `BASE_SEPOLIA` (canonical-VPFI)
CCIP chain selector: `10344971235874465080`

```dotenv
CCIP_ROUTER_BASE_SEPOLIA=0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93
CCIP_RMN_PROXY_BASE_SEPOLIA=0x99360767a4705f68CcCb9533195B761648d6d807
CCIP_TOKEN_ADMIN_REGISTRY_BASE_SEPOLIA=0x736D0bBb318c1B27Ff686cd19804094E66250e17
CCIP_REGISTRY_MODULE_OWNER_CUSTOM_BASE_SEPOLIA=0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6
```

### Arbitrum Sepolia — chainId `421614` — slug `ARB_SEPOLIA` (mirror)
CCIP chain selector: `3478487238524512106`

```dotenv
CCIP_ROUTER_ARB_SEPOLIA=0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165
CCIP_RMN_PROXY_ARB_SEPOLIA=0x9527E2d01A3064ef6b50c1Da1C0cC523803BCFF2
CCIP_TOKEN_ADMIN_REGISTRY_ARB_SEPOLIA=0x8126bE56454B628a88C17849B9ED99dd5a11Bd2f
CCIP_REGISTRY_MODULE_OWNER_CUSTOM_ARB_SEPOLIA=0xaD417c0611dBD225471D31F056b8B6beC1CBC153
```

### BNB Chain Testnet — chainId `97` — slug `BNB_TESTNET` (mirror, native-gas mode)

> ⚠️ **Contracts-only — NOT yet a full-ceremony deploy target.** The CCIP env
> block below is provided so the `--phase contracts` diamond deploy can land on
> BNB testnet, but the standard next step (`--phase configure` →
> `DiamondConfigSpell` → `ConfigureOracle`) will **revert** on chainId 97:
> `ConfigureOracle._prefix()` has no `BNB_TESTNET_` case yet, so there are no
> oracle/risk params wired for BNB. Do **not** treat BNB testnet as part of the
> Phase-1 deploy trio until `ConfigureOracle` (and the per-chain oracle env) add
> BNB support — otherwise a BNB contracts deploy strands half-configured. Tracked
> as a follow-up (#853 Codex P2).

CCIP chain selector: `13264668187771770619`

```dotenv
CCIP_ROUTER_BNB_TESTNET=0xE1053aE1857476f36A3C62580FF9b016E8EE8F6f
CCIP_RMN_PROXY_BNB_TESTNET=0xA8C0c11bf64AF62CDCA6f93D3769B88BdD7cb93D
CCIP_TOKEN_ADMIN_REGISTRY_BNB_TESTNET=0xF8f2A4466039Ac8adf9944fD67DBb3bb13888f2B
CCIP_REGISTRY_MODULE_OWNER_CUSTOM_BNB_TESTNET=0x8Cd87FeAC14D69D770E67Bedf029e6fd3F33D0C7
```

> BNB Chain Testnet (97) uses **native-gas mode** for the VPFI buy adapter — it
> is intentionally exempt from the strict WETH-pull list (its gas token has no
> real value; the testnet rate is symbolic). See CLAUDE.md
> "VpfiBuyAdapter — payment-token mode by chain". The mainnet equivalents
> (BNB 56, Polygon 137) MUST use WETH-pull mode.

---

## Other reference addresses

- **WETH-pull bridged-WETH addresses** (mainnet only — needed for
  `*_VPFI_BUY_PAYMENT_TOKEN` on BNB 56 / Polygon 137): documented in `CLAUDE.md`
  → "VpfiBuyAdapter — payment-token mode by chain". Not required for any
  testnet in the Phase-1 trio.
- **Per-chain RPC URLs, deployer/admin/treasury** keys: operator config in
  `contracts/.env` (never committed). See `contracts/README.md` env table.
- **Mainnet CCIP infra**: look up under
  https://docs.chain.link/ccip/directory/mainnet and add a sibling section here
  before a mainnet deploy.

## Maintenance

When adding a chain to the deploy set: pull its CCIP Router / RMN Proxy /
Token Admin Registry / Registry Module Owner Custom + chain selector from the
Chainlink directory, add a section above with the `CCIP_*_<SLUG>` block, and
copy the block into `contracts/.env`.
