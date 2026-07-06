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

When a live review for a new feature needs a new drive, add the
script here in the same PR (or the follow-up fix PR) so the next
review doesn't rebuild the tooling from scratch.
