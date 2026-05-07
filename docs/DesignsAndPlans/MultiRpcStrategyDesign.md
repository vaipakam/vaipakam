# Multi-RPC Strategy Design — Health-Aware Failover

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.4.
Phase 5 of the platform-optimisation roadmap implements this.
Independent of Phases 1–4; can ship in parallel.

**Last updated:** 2026-05-07.

**Goal:** every chain RPC call goes through a health-aware
multi-provider router that tries primary → fallback chain on
rate-limit / 5xx / timeout, with optional user-supplied RPC and
wallet-injected provider preference. Removes the single point
of failure of today's one-URL-per-chain env config and matches
what every mature DeFi frontend does.

---

## 1. Why this matters now (especially for IPFS-hosted)

Today: `frontend/.env.local` has `VITE_<CHAIN>_RPC_URL` —
exactly one URL per chain. If dRPC is throttling (which we hit
during today's broadcast retries), every read fails. If
Cloudflare's RPC proxy is down, every read fails.

For an IPFS-hosted decentralised frontend, this is the core
bottleneck. There's no Cloudflare Worker to proxy / cache; the
frontend talks directly to RPC. A single-provider single-point-
of-failure undermines the whole "no centralised dependency"
posture.

Industry pattern: Aave, Uniswap, Compound, Sky all configure
3–5 fallback RPCs per chain in their public configs +
prominently expose a "Custom RPC" setting + auto-detect the
wallet's injected provider via EIP-6963 + use chainlist.org-
maintained public-RPC lists as a community-curated source.

---

## 2. Architecture

### 2.1 `MultiRpcProvider` per chain

Single class (or small `viem` `Transport` wrapper) that holds:

```ts
interface RpcEndpoint {
  url: string;
  label: string;             // e.g. "Alchemy", "publicnode", "User-supplied"
  source: 'env' | 'wallet' | 'public' | 'user' | 'mev-protected';
  rank: number;              // lower is preferred
  // Health state, mutated on every call:
  lastSuccessAt: number;
  lastErrorAt: number;
  consecutiveErrors: number;
  rateLimitedUntil: number;  // backoff window
  latencyP95Ms: number;      // rolling
}

class MultiRpcProvider {
  endpoints: RpcEndpoint[];
  request(method: string, params: any[]): Promise<any> {
    // Try each healthy endpoint in rank order; on failure, mark
    // endpoint unhealthy and retry the next.
  }
}
```

### 2.2 Endpoint sources, in preference order

1. **User-supplied** (if configured via Settings page) — top
   priority. User has explicitly chosen this; their choice wins.
2. **Wallet-injected** (`window.ethereum` via EIP-6963) — if
   the user's connected wallet exposes a chain provider that
   covers the active chain.
3. **Operator paid tier** — primary configured URL (today's
   `VITE_<CHAIN>_RPC_URL`). Renamed to `VITE_<CHAIN>_RPC_URL_PRIMARY`
   to signal it's one of several.
4. **Operator fallbacks** — `VITE_<CHAIN>_RPC_URL_FALLBACK_1`,
   `_FALLBACK_2`, etc. (operator-curated public-RPC list).
5. **Community-curated public RPCs** — a static list bundled at
   build time, drawn from chainlist.org. Last-resort fallback.

For write transactions on supported chains, optionally try a
**MEV-protected RPC** (Flashbots Protect, MEV Blocker) before
the standard fallback chain. Configurable per-chain.

### 2.3 Health-check protocol

- On every successful call: `lastSuccessAt = now`,
  `consecutiveErrors = 0`, `latencyP95Ms` updated via rolling
  EWMA.
- On rate-limit response (HTTP 429 or JSON-RPC error code in
  the standard rate-limit set): `rateLimitedUntil = now + 30 s`
  initially; doubles up to 5 min cap on consecutive
  rate-limits.
- On 5xx / timeout: `consecutiveErrors++`. After 3 consecutive
  errors, endpoint is marked `unhealthy` for 60 s before retry.
- On reconnect (after `rateLimitedUntil` or unhealthy window
  passes), endpoint goes back into rotation but at the bottom
  of the rank for one cycle (give it a chance without trusting
  it for the hot-path immediately).

A periodic background health-check (every 60 s on the slowest
cadence) probes `eth_chainId` against all endpoints to refresh
liveness — not on the user's hot path, just a passive monitor.

### 2.4 Per-call retry + failover policy

```
for endpoint in rank-ordered healthy endpoints:
  try:
    response = call endpoint with method + params
    if response is success: return
    if response is rate-limit: mark + skip; try next
    if response is server-error: mark + skip; try next
    if response is invalid JSON: mark + skip; try next
  except network timeout (>10s): mark + skip; try next
return last error to caller
```

No exponential backoff at the per-call level — the whole point
of failover is to immediately try the next endpoint. Backoff
applies to RE-USING a marked-unhealthy endpoint.

### 2.5 viem integration

Wrap as a custom `transport`:

```ts
import { custom } from 'viem';

const transport = custom({
  async request({ method, params }) {
    return multiRpc.request(method, params);
  }
});

const publicClient = createPublicClient({ chain, transport });
```

Migrating today's `useDiamondPublicClient` is a one-line swap of
the transport. Hooks downstream don't care.

---

## 3. User-supplied RPC UX

Settings page (or an existing Settings drawer) gets a new
section:

```
┌─ Custom RPC ────────────────────────────────────┐
│  Chain: Base Sepolia                            │
│  ┌────────────────────────────────────────────┐ │
│  │ https://your-private-alchemy-key.../       │ │
│  └────────────────────────────────────────────┘ │
│  [Save]   [Test connection]   [Reset to default]│
│                                                 │
│  Status: Connected — primary source (overrides  │
│  Vaipakam's default endpoints).                 │
└─────────────────────────────────────────────────┘
```

- Persists in localStorage (`vaipakam:rpc-override:<chainId>`).
- Test button: calls `eth_chainId` and asserts the chainId
  matches; otherwise warns with a clear error.
- Reset clears the override; next request uses operator
  fallbacks.
- One per chain.

Industry parallel: Aave's app has this exact UX in their
Settings page. Uniswap's interface accepts a `?rpc=...` URL
query parameter for the same purpose.

---

## 4. EIP-6963 wallet detection

Modern wallets announce themselves via the `eip6963:announceProvider`
window event. Multi-wallet support means the user can pick
between MetaMask, Rabby, Coinbase, Frame, etc. without one
stomping the other on `window.ethereum`.

Implementation: a small `useEip6963Wallets()` hook that listens
for the announce event and surfaces the wallet list. The
multi-RPC provider checks if any announced wallet supports the
active chain (via the `wallet_switchEthereumChain` capability)
and uses it as endpoint #2.

This is increasingly table stakes — Aave, Uniswap V4 interface,
and most newer DeFi already support it.

---

## 5. MEV-protected RPC (write-tx only)

For chains where MEV protection is meaningful (Ethereum
mainnet primarily; Base, Arb, OP have less MEV exposure due to
sequencers but Flashbots Protect still adds value), the
provider supports a separate write-tx endpoint preference:

```ts
multiRpc.requestWrite(method, params);   // tries MEV-protected first
multiRpc.requestRead(method, params);    // standard rank order
```

Read calls (eth_call, eth_getLogs, eth_getBalance, etc.) go
through the read chain. Write calls (eth_sendRawTransaction)
go through the write chain — MEV-protected first, then standard
read endpoints as fallback.

Supported MEV-protected RPCs:

| Chain | Provider | URL pattern |
|---|---|---|
| Ethereum mainnet | Flashbots Protect | `https://rpc.flashbots.net/fast` |
| Ethereum mainnet | MEV Blocker | `https://rpc.mevblocker.io` |
| Base | Coinbase RPC (no MEV exposure under sequencer) | n/a |
| Arbitrum | n/a (sequencer model) | n/a |
| Optimism | n/a (sequencer model) | n/a |
| BNB Chain | bloXroute / 48 Club | `https://rpc-bsc.48.club/v1/...` |

Per-chain config in `frontend/src/contracts/config.ts` extends
with an optional `mevProtectedRpcUrl` field.

---

## 6. Per-chain endpoint defaults

Bundled into the frontend at build time. Today's plus
fallbacks:

```ts
const DEFAULT_RPC_ENDPOINTS: Record<number, RpcEndpoint[]> = {
  // Base Sepolia (84532)
  84532: [
    { url: env.VITE_BASE_SEPOLIA_RPC_URL_PRIMARY,  label: 'Operator dRPC',     source: 'env',    rank: 0 },
    { url: env.VITE_BASE_SEPOLIA_RPC_URL_FALLBACK_1, label: 'publicnode',     source: 'env',    rank: 1 },
    { url: 'https://sepolia.base.org',             label: 'Coinbase public', source: 'public', rank: 2 },
    { url: 'https://base-sepolia.gateway.tenderly.co', label: 'Tenderly',     source: 'public', rank: 3 },
  ],
  // Arb Sepolia (421614)
  421614: [
    { url: env.VITE_ARB_SEPOLIA_RPC_URL_PRIMARY, label: 'Operator dRPC', source: 'env', rank: 0 },
    { url: 'https://sepolia-rollup.arbitrum.io/rpc', label: 'Offchain Labs', source: 'public', rank: 1 },
    { url: 'https://arbitrum-sepolia.publicnode.com', label: 'publicnode', source: 'public', rank: 2 },
  ],
  // OP Sepolia (11155420)
  11155420: [
    { url: env.VITE_OP_SEPOLIA_RPC_URL_PRIMARY, label: 'Operator dRPC', source: 'env', rank: 0 },
    { url: 'https://sepolia.optimism.io',       label: 'Optimism public', source: 'public', rank: 1 },
    { url: 'https://optimism-sepolia.publicnode.com', label: 'publicnode', source: 'public', rank: 2 },
  ],
  // Mainnet entries follow the same pattern when those chains land.
};
```

The list is pinned at build time so an IPFS-hosted bundle
doesn't depend on a dynamic config endpoint. New endpoints
require a frontend release. If a public RPC list at a stable
URL (chainlist.org) is preferred, the frontend can fetch it
async on mount and merge into the bundled list — but the
bundled list is the canonical fallback.

---

## 7. Diagnostic surface

A new row in the Chain & Indexer panel (advanced mode):
**RPC source**: `Operator dRPC (primary, healthy)`. Updates as
the provider switches endpoints. Plus a sub-row showing the
last error per endpoint when one is marked unhealthy.

Operators can verify "yes my user-supplied RPC is being used"
or "yes the failover kicked in and we're on the public
endpoint" without opening dev tools.

---

## 8. Open questions

1. **Should the frontend ship with a bundled chainlist.org
   snapshot at build time, or fetch it on mount?**
   Recommendation: bundle. IPFS-hosted bundles must work
   offline-of-our-infrastructure. Accept slightly stale lists
   (~weekly snapshot at build).
2. **Should write-tx fallback proceed silently to non-MEV-
   protected if the MEV-protected endpoint fails?**
   Recommendation: no — show the user a confirmation. Some
   users specifically chose MEV-protected; fallback without
   notice would surprise them.
3. **Per-call retry budget?** Recommendation: 3 endpoints max
   per call (primary + 2 fallbacks). Beyond that the chain is
   probably actually down; surface error to user instead of
   stalling.
4. **Health-check probe cost?** ~10 endpoints × 60 s cadence =
   600 calls/hour passive. Negligible vs read-side load on
   active pages, but stop probing on tab-hidden + idle.
5. **Logging?** Privacy concern — we shouldn't log the user's
   RPC URLs (could contain API keys). Diagnostic surface shows
   labels only ("Operator dRPC", "User-supplied"); raw URLs
   never enter the journey log.

---

## 9. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.4 (parent).
- `frontend/src/contracts/config.ts` — extended with the
  endpoint list per chain.
- `frontend/src/contracts/useDiamond.ts` — `useDiamondPublicClient`
  uses the multi-rpc transport.
- `DesignsAndPlans/IPFSHostingPipelineDesign.md` — bundled-fallback
  list discipline matters most for the IPFS-hosted path.
- Industry refs: Uniswap interface multi-RPC config; Aave
  Settings page custom-RPC UX; EIP-6963 spec.
