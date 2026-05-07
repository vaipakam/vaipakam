# IPFS Hosting Pipeline Design

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.6.
Phase 7 of the platform-optimisation roadmap implements this.

**Last updated:** 2026-05-07.

**Goal:** every Vaipakam release pins the frontend bundle to IPFS
with a content-addressed (immutable) CID, updates an ENS
`contenthash` record so `vaipakam.eth` resolves to the latest
release, mirrors the same CID via DNSLink for traditional URL
access, and registers the bundle with multiple pin services for
redundancy. Independent verification: any user can resolve the
same CID through `ipfs.io`, `cloudflare-ipfs.com`,
`4everland.io`, or a self-hosted Kubo daemon — the page is
hostable without any single centralised dependency.

---

## 1. Why IPFS hosting matters here

A DeFi frontend that depends on a single corporate host
(Cloudflare, Vercel, AWS) is one account-suspension or one
DDoS-redirect away from being unreachable. Every mature
decentralised protocol — Uniswap (`uniswap.eth`), Aave
(`aave.eth`), Compound (`compoundfinance.eth`), Sky/MakerDAO
(`sky.money` via DNSLink + IPFS) — has already executed this
migration. The cost is moderate (a multi-pin pipeline +
reproducible build); the survival benefit is categorical.

For Vaipakam specifically, the parent design doc's "no-server
fallback" requirement makes IPFS hosting the canonical artefact.
The Cloudflare Pages / Workers Static Assets deployment
continues to serve the same bundle for users coming via DNS,
but the IPFS pin is the source of truth: every Cloudflare-served
asset has the same CID-addressed twin reachable via gateway.

---

## 2. End-state architecture

```
Source commit (signed git tag, e.g. v2026.05.07)
         │
         ↓
Reproducible Docker build  →  dist/  (deterministic per source)
         │
         ↓
IPFS CID computed locally (deterministic from dist/)
         │
         ├─→ Pinata API:        pin CID
         ├─→ Web3.Storage API:  pin CID (Filecoin-backed)
         ├─→ 4everland API:     pin CID
         └─→ Operator's own Kubo daemon: pin CID
         │
         ↓
Provenance file `dist/_release.json` — { cid, gitSha, builtAt,
                                         pins: [...] }
         │
         ├─→ ENS:    setContenthash(node('vaipakam.eth'), CID)
         ├─→ DNS:    `_dnslink.vaipakam.com` TXT = `dnslink=/ipfs/<CID>`
         └─→ Cloudflare Pages: deploy dist/ as one of several edges
                              (NOT canonical; the CID is)

User access paths (any one works):
  1. https://vaipakam.com                      → CF Pages → dist
  2. https://app.ens.domains/.../vaipakam.eth   → resolves CID via gateway
  3. ipfs://<CID> (Brave / IPFS Companion / Kubo)
  4. https://cloudflare-ipfs.com/ipfs/<CID>
  5. https://ipfs.io/ipfs/<CID>
  6. https://4everland.io/ipfs/<CID>
```

Every path serves the same bytes. The frontend is the same
React-only static client either way — every dynamic behaviour
runs in the browser or against chain RPC.

---

## 3. Reproducible build discipline

A reproducible build means: same source commit → same dist
bytes → same CID. Without this, every release-engineer
machine would compute a different CID for what's nominally the
same release, breaking trust in the "the CID is the source of
truth" model.

### 3.1 Pin Node + npm versions

Add `engines` to `frontend/package.json` and a `.nvmrc`:

```json
"engines": {
  "node": "20.18.0",
  "npm": "10.8.2"
}
```

```
# .nvmrc
20.18.0
```

### 3.2 Lockfile-only installs

`npm ci` (not `npm install`) for production builds — installs
exact versions from `package-lock.json`, fails on drift.

### 3.3 Deterministic timestamps

`SOURCE_DATE_EPOCH` env var set from the git commit timestamp
during build. Vite's `define` already supports
`__BUILD_TIME__` overrides; the existing `vite.config.ts`
stamps `process.env.VITE_BUILD_TIME` to `new Date().toISOString()`
which is non-deterministic. Replace with:

```ts
process.env.VITE_BUILD_TIME = new Date(
  Number(process.env.SOURCE_DATE_EPOCH ?? Date.now() / 1000) * 1000,
).toISOString();
```

CI passes `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` per
release.

### 3.4 Docker-based build

Wrap the build in a pinned Docker image:

```dockerfile
FROM node:20.18.0-bookworm-slim@sha256:<digest>
ENV SOURCE_DATE_EPOCH=…
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# dist/ is now reproducible from this image + source
```

Operator-side script: `scripts/build-release.sh` runs the
container, extracts `dist/`, computes CID via
`ipfs add -r --only-hash dist/`, asserts CID matches an
expected value if supplied (CI integrity gate).

### 3.5 Determinism asserts

A small CI job builds twice from the same commit and asserts
the two CIDs match. If not, the build is non-deterministic and
the diff names the file(s) that vary.

---

## 4. Multi-pin pipeline

### 4.1 Three pin providers, parallel upload

| Provider | Tier | Why |
|---|---|---|
| **Pinata** | Paid | Reliable, well-documented API, primary for fast gateway response |
| **Web3.Storage** | Free + Filecoin-backed | Long-term archival; storage providers replicate |
| **4everland** | Free + community | Alternate gateway; community-friendly redundancy |

CI / release script: parallel `POST /pinning/pinByHash` (or
equivalent) to all three with the computed CID. Each returns
within seconds since they're pinning bytes already addressed
by content (not uploading). On any provider failure, the
release continues — pin redundancy means one provider being
slow / unavailable doesn't block the release.

### 4.2 Operator's own Kubo daemon (optional but recommended)

A self-hosted Kubo node on the Oracle Cloud operator instance
(see `OperatorNodeDeploymentDesign.md`) pins every release
locally. Survives any pin-service outage; serves the bundle to
the operator's own gateway for ops-side access.

Disk: ~50–100 MB per release, retain last 30 releases ≈ 3 GB.
Negligible against the operator instance's 200 GB block storage.

### 4.3 Provenance file

`dist/_release.json` is built into the bundle:

```json
{
  "cid": "bafybei…",
  "gitSha": "<full-40-char-sha>",
  "gitTag": "v2026.05.07",
  "builtAt": "2026-05-07T12:34:56Z",
  "buildHash": "30a7844",
  "pins": [
    { "provider": "pinata",        "pinnedAt": "2026-05-07T12:35:01Z" },
    { "provider": "web3-storage",  "pinnedAt": "2026-05-07T12:35:02Z" },
    { "provider": "4everland",     "pinnedAt": "2026-05-07T12:35:01Z" },
    { "provider": "operator-kubo", "pinnedAt": "2026-05-07T12:35:00Z" }
  ]
}
```

The diagnostics panel's "Frontend build" row + new
"IPFS CID" row + new "Pinned to" row read from this file at
runtime, surfacing the provenance to operators.

---

## 5. ENS contenthash + DNSLink

### 5.1 ENS contenthash

`vaipakam.eth` is the canonical decentralised name. Each release
updates `contenthash` via `setContenthash` on the ENS resolver:

```ts
// One-line ceremony per release, requires the wallet that owns
// vaipakam.eth (typically a hardware wallet for security).
ensResolver.setContenthash(
  namehash('vaipakam.eth'),
  encodeIpfsContenthash(cid),
);
```

A small CLI (`scripts/release/update-ens.ts`) wraps this. Gas
cost: ~50 k gas on Ethereum mainnet ≈ $0.50–$2 per release.

### 5.2 DNSLink TXT

Mirror the same CID at `_dnslink.vaipakam.com` so traditional
DNS resolvers can find it. Cloudflare DNS API call:

```
TXT _dnslink.vaipakam.com  "dnslink=/ipfs/<CID>"
```

Lets users on browsers that resolve DNSLink (Brave native,
Firefox with extension, etc.) reach the IPFS bundle from a
familiar `vaipakam.com` URL.

### 5.3 Cloudflare Pages mirror (NOT the canonical)

Cloudflare Pages continues to serve `dist/` for users on
`vaipakam.com` who don't resolve via ENS or DNSLink. The CID
is the source of truth: Pages is one of several edges that
serve the same bundle. If Cloudflare ever pushes back the
account / domain, ENS + DNSLink still resolve.

---

## 6. Frontend changes for multi-host robustness

### 6.1 Asset-loading fallback

If the page is loaded from `vaipakam.com` and a chunked asset
returns 5xx (Cloudflare edge issue), the page can dynamically
load the same asset from `cf-ipfs.com/ipfs/<CID>/<asset-path>`
since the CID is known at build time (it's in
`_release.json`). One-line fetch wrapper around dynamic
imports.

### 6.2 Service worker for offline

A service worker registered at install time caches every asset
in the bundle. Subsequent loads work fully offline — including
when both the host AND the IPFS gateways are unreachable. Only
the chain RPC stays required for live data.

Existing `frontend/public/sw.js` is the foundation; extend
with a "cache-first for known asset URLs" strategy.

### 6.3 Diagnostics-panel additions

Three new rows in the Chain & Indexer panel (or maybe a new
"Hosting" panel):

- **Loaded from**: shows whether the page is being served
  from `vaipakam.com` (Cloudflare), `vaipakam.eth` (ENS via
  gateway), or directly from an IPFS gateway URL.
- **IPFS CID**: from `_release.json`. Click-to-copy.
- **Pinned by**: list of pin providers that hold the CID.
  Pulls from `_release.json`.

These reassure technical users that the bundle they're
running is the same one published to IPFS.

---

## 7. Release workflow (per-release ceremony)

```
1. Operator: git tag -s v2026.05.07
2. Operator: scripts/build-release.sh
   → produces dist/, computes CID, writes _release.json
3. Operator: scripts/pin-release.sh
   → uploads CID to Pinata + Web3.Storage + 4everland +
     operator's Kubo daemon (parallel)
4. Operator: scripts/update-ens.ts (signs from hardware wallet)
   → ENS contenthash updated
5. Operator: scripts/update-dnslink.ts
   → Cloudflare DNS API call updates TXT record
6. Operator: cd frontend && wrangler deploy
   → Cloudflare Pages mirror updated
7. Operator: scripts/verify-release.sh
   → fetches the page from each gateway, asserts content hash
     matches the published CID, asserts _release.json
     contents match the release
8. Operator: append release notes (existing daily-cadence file)
9. Operator: git push origin main --tags
   → public release
```

Total elapsed: ~10–15 minutes per release. Steps 1–7 can be
fully scripted; the operator's hardware-wallet signature on
step 4 is the only manual step.

---

## 8. Security considerations

### 8.1 ENS owner-key custody

`vaipakam.eth` is owned by a wallet. Compromise of that wallet
lets an attacker re-point ENS to a malicious CID. Mitigation:

- Owner is a hardware wallet (Ledger / GridLens / etc.).
- For mainnet, owner is upgraded to a Safe multisig
  (3-of-5 protocol team, signers across geographic /
  device diversity).
- `vaipakam.eth` registration includes a name guard
  (e.g. `name.eth` reverse-record verification).

### 8.2 CID trust chain

A user trusts that the CID at `vaipakam.eth` is the right
bundle. If a bad release is pushed (whether via ENS
compromise or operator error), it propagates to every gateway
within seconds. Mitigations:

- Multi-eye review on every release: at least two protocol
  team members verify the CID matches the signed git tag's
  reproducible build before the ENS update lands.
- Public disclosure: every release tag's CID is announced in
  release notes and a separate published release-feed (signed
  RSS / Farcaster cast / Twitter post) so users have a
  cross-channel verification path.
- Rollback: keeping the prior 5–10 release CIDs pinned means
  rolling back is one ENS update, no rebuild needed.

### 8.3 Reproducibility audit

Anyone can clone the repo, check out the release tag, and run
`scripts/build-release.sh` to verify the CID. The
reproducible-build discipline (§3) is what makes this
verifiable — the CI determinism asserts protect this from
silent drift.

---

## 9. Open questions

1. **Which gateway is the default in marketing copy?**
   Recommendation: `vaipakam.eth` (resolves automatically in
   Brave, IPFS Companion). Falls back to `vaipakam.com` for
   users without ENS resolution. Document both prominently.
2. **How long do we keep historical CIDs pinned?**
   Recommendation: 30 days for routine releases; indefinitely
   for any release that landed on mainnet. The mainnet-
   release CIDs are the public-record artefacts users may
   need to refer back to during incident analysis.
3. **Do we sign every release with a release-team GPG key in
   addition to git tag signing?**
   Recommendation: yes — git tag signing is the minimum;
   release-engineering GPG signature on the CID itself adds
   a second verification path independent of git infra.
4. **Service-worker caching boundaries?**
   Recommendation: cache the bundle (HTML / JS / CSS / image
   assets) but NOT the runtime data (chain reads, indexer
   responses). The bundle is content-addressed and stable;
   data is live. Existing PWA pattern.
5. **Initial ENS deployment cost?**
   `vaipakam.eth` registration is a one-time ~$5–20 + annual
   ~$5 renewal. Negligible operational cost.

---

## 10. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.6 (parent).
- `DesignsAndPlans/MultiRpcStrategyDesign.md` — bundled-fallback list
  discipline matters most for the IPFS-hosted path.
- `DesignsAndPlans/CacheStoreDesign.md` — IndexedDB cache works
  identically whether the bundle is served from IPFS or
  Cloudflare; both routes hit the same browser-side cache.
- `OperatorNodeDeploymentDesign.md` — operator's Kubo daemon
  fits in the existing memory budget.
- `frontend/vite.config.ts` — current build-time stamping
  (will switch to deterministic `SOURCE_DATE_EPOCH`).
- `frontend/wrangler.jsonc` — Cloudflare Pages config; stays
  as one of several edges, not canonical.
- Industry refs: Uniswap's deployment workflow
  (`uniswap.eth` IPFS pinning), Aave's IPFS deployment
  pattern, Sky's DNSLink-based hosting.
