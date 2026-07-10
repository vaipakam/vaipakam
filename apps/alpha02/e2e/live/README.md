# Live testnet reviews (post-deploy DoD)

Per the standing directive in CLAUDE.md, every user-facing merge to a
deployed surface gets a LIVE review on the deployed testnet site
(alpha02.vaipakam.com) **after the production deploy** — driving the
real feature end-to-end with the dev test wallets and confirming the
observable behaviour, not just preview builds or CI.

These are the reusable Playwright drivers for those reviews. They are
NOT part of any CI job (the fork-tier suite under `../tests/` is the
automatic regression); they run manually, post-deploy, against the
live site. The results belong in the PR thread of the change under
review — see e.g. #1059, where this exact drive produced the
before/after evidence for the classifier fix.

## Running

```bash
# from apps/alpha02/e2e/live/
TESTNET_WALLETS_FILE=~/secrets/vaipakam-dev-wallets.json \
  node live-dryrun-review.mjs

# target a branch preview instead of production:
SITE_URL=https://<branch-preview>.workers.dev node live-dryrun-review.mjs
```

- `TESTNET_WALLETS_FILE` — JSON of dev TEST wallets (throwaway keys
  holding testnet dust). **Never commit this file.** Shape:
  `{ "lender": { "address": "0x…", "privateKey": "0x…" }, … }` or an
  array of `{ role, address, privateKey }`.
- `SITE_URL` — defaults to `https://alpha02.vaipakam.com`.
- `LIVE_PROXY_SETUP` — optional path to an egress-proxy shim module,
  for sandboxes whose gateway resets Chromium TLS (the driver then
  routes page traffic through undici in-process).
- `FAUCET_JSON` — optional deployments artifact for the faucet mock
  token addresses (defaults to the live Base Sepolia set).

## Scripts

| Script | What it verifies live |
| --- | --- |
| `driver.mjs` | Shared launcher: persistent Chromium profile per role, injected EIP-1193 wallet signing with the role's key, undici page routing. |
| `live-dryrun-review.mjs` | #1058/#1059 — drives a fresh lend offer to the review step and asserts the pre-sign dry-run footer renders a real verdict (and, post-#1059, the benign approval note rather than the cry-wolf would-fail). |
| `live-alerts-link.mjs` | #1055/#1056 — Settings → Link Telegram → wallet signs the ownership proof → a six-digit handshake code renders. |
| `live-killswitch-regression.mjs` | #1056 — zero-regression sweep: every page renders and the kill-switch banner copy appears nowhere while `VITE_DISABLED_FLOWS` is unset in production. |
| `live-signed-book.mjs` | #1131/#1145 — Rate Desk phase 3 live half, the GASLESS signed-offer book: posts a tiny lender order from the ticket's Gasless sign-only mode (ONE EIP-712 signature, ZERO transactions — pinned at both the injected-provider boundary and the on-chain pending nonce; Partial→AON auto-flip observed), captures the order hash DETERMINISTICALLY from the page's own `POST /signed-offers` response (every later lookup/cancel/ledger read keys on that hash — a rerun with a stale same-shape leftover can't be mis-targeted; pre-existing own rows are snapshotted at preflight and reported for manual attention, never auto-cancelled), asserts the row lands on the production `GET /signed-offers` (200 + `no-store`, wire shape single-value AON, orderHash reproduced by the Diamond's `signedOfferOrderHash`), on the ladder (Signed chip + own marker) and in the Open orders own-signed block, then revokes it via the on-chain `cancelSignedOffer` (NO cooldown) and asserts the fill ledger poisoned to the ceiling. Post-cancel it accounts THREE independent observations separately in its summary: (i) the row leaving the book on the next ingest scan, (ii) the production WS push rail (`wss://…/ws/chain/84532`, observed from a NODE-side client — the observation the fork tier structurally cannot make) delivering `offer.changed` on the CROSSING `invalidate` frame (first `scannedTo` at/past the cancel block), credited only when the Node socket held continuity over the cancel-submission→frame window (a close/reconnect gap → AMBIGUOUS: the true crossing frame may have been missed), the crossing scan's window is sweepable (a crossing frame that is the FIRST frame observed leaves the scan's start unknown — no-op scans broadcast nothing — → AMBIGUOUS) AND the same-scan confound sweep of that window's blocks finds no unrelated offer-mutation event (the coarse key could otherwise belong to concurrent offer activity → AMBIGUOUS with the events printed), and (iii) the BROWSER push path (page WS → `IndexerPushSync` → book refresh before the poll) — NOT observable from a sandbox whose proxy blocks page WS: the driver instruments the page's WebSocket (frames parsed per message) and window.fetch (`/signed-offers` refetch starts) and, when the socket reaches OPEN, credits push only on the evidence chain — a page-WS `invalidate` frame carrying `offer.changed` at the crossing frame's exact `scannedTo` (same scan, delivered to both observers — a reconnect `hello` never credits, and a page frame with a LATER `scannedTo` means the page missed the crossing frame → AMBIGUOUS with both values printed) → refetch starting within ~3 s → row gone — recording AMBIGUOUS with timestamps when the 30 s poll tick was itself plausibly due; a never-connected socket prints an explicit OPEN marker and an earlier abort reads UNCHECKED, so (i)+(ii) green never implies (iii). Blocks up to ~5 min on the genuine indexer scan cadence; self-cleans via a direct on-chain cancel + ledger re-verify keyed on the captured hash. |
| `live-rate-desk.mjs` | #1129/#1134 + #1130/#1139 — Rate Desk live half, phases 1+2: loads the WETH/tLIQ market via the custom-pair branch (chain-read book), posts a 0.002 WETH GTC/Partial lend order at a distinctive rate, amends it in place (one `modifyOffer`, same offer id), waits out the REAL 300 s cancel cooldown, cancels (escrow refunded) — every offer-scoped step verified on-chain via viem, and the indexer-backed surfaces ASSERTED healthy: a degraded indexer (any of them rendering its "couldn't load" copy) fails the drive by design. Phase-1 surfaces: markets summary + tape. Phase-2 pass (rides the same drive, no new waits): the executed-rate chart card must render a drawn series or an honest empty copy — never `copy.desk.chart.unavailable` — with interval/range chips + the TradingView attribution asserted and a direct `GET /loans/rate-candles` wire probe (200 + `buckets` array, count recorded); the History bottom tab as the lender must render rows or its honest empty copy — never `copy.desk.history.unavailable` — with a direct `GET /loans/by-participant` wire probe (200 + `loans` array + `nextBefore`, counts/roles recorded, UI/wire emptiness cross-checked). `INDEXER_ORIGIN` overrides the probed worker (default `https://indexer.vaipakam.com`). NB: performs real testnet writes and blocks ~6 min on the genuine cooldown; self-cleans via an unconditional offer-index delta sweep with a receipt-verified direct on-chain cancel fallback. |

When a live review for a new feature needs a new drive, add the
script here in the same PR (or the follow-up fix PR) so the next
review doesn't rebuild the tooling from scratch.
