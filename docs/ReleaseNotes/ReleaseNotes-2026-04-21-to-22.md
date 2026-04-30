# Release Notes — 2026-04-21 and 2026-04-22

Functional record of everything delivered and agreed on the two sessions
before the 23–24 window. Plain-English, no code. Same style and
convention as `ReleaseNotes-2026-04-23-to-24.md`.

## Tokenomics refinements (spec only, no code)

Agreed on the protocol-level posture for the VPFI discount + staking-
reward mechanics surfaced in `docs/TokenomicsTechSpec.md`. Three
decisions locked in:

- **New-tier discount uptake is user-opt-in, not retroactive.** When
  a user crosses into a higher VPFI discount tier mid-loan, the new
  rate applies from that point forward only. Their already-accrued
  fees at the old rate stay at the old rate. No retroactive repricing
  of the loan.
- **Same rule for staking rewards.** The scheduled staking-reward
  percentage is effective from the period boundary; prior periods
  keep the rate that was in force at their accrual time.
- **Platform-interaction rewards are a separate track** from VPFI
  discounts and from staking rewards. Confusion between the three had
  been appearing in review — the spec now calls out the three tracks
  explicitly with one-line descriptions of when each fires.

## Phase A — Governance-config frontend surfaces (shipped)

Three small hooks/components that pull live on-chain governance
parameters into the UI, so pages reflect current protocol state without
each page making its own ad-hoc contract call.

- **Fallback-split hook.** A shared hook exposes the protocol's current
  lender / borrower split for fallback scenarios. Pages that previously
  hard-coded or re-derived this number now read from the hook.
- **Per-loan lender-discount hook.** Computes the effective
  time-weighted VPFI discount for the current lender on a given loan,
  by combining `getLoanDetails` with `getUserVpfiDiscountState` and
  extrapolating the open-loan window against the on-chain discount
  curve client-side.
- **Lender-Discount card on the loan-detail page.** Consumes the hook
  above. Shows the current lender their effective discount as the loan
  progresses.

All three shipped behind a basic / advanced mode split — visible in
whichever mode fits.

## App chrome polish

- **Left-side panel collapses instantly on toggle.** Previously a
  second click was needed because the panel re-evaluated its open
  state from route changes rather than from the explicit toggle action.
  Fixed so the first click commits.
- **Horizontal scrollbar removed** from the app layout when content
  already fits the viewport. The previous behaviour looked like broken
  responsive overflow to users.
- **"No wallet detected" is now a warning, not an error.** Red error
  banners for an expected state (no browser-extension wallet installed)
  were needlessly alarming. Yellow warning, matching the actual
  severity.
- **Analytics page: "Total NFTs rented"** now shows in both the
  combined-all-chains summary and the per-chain breakdown. Previously
  only one of the two sections carried the counter.
- **Buy VPFI link from the home page** — fixed. Stale route reference
  pointed at a non-existent path.

## Branding / namespace policy (decision)

Locked in a policy rule: **no third-party DeFi / DEX platform name
appears anywhere in the Vaipakam codebase, documentation, or any file
we ship.** Wallet names are acceptable (MetaMask, Rainbow, etc.) because
they're a user-facing category, not a competitor category. Generic
phrases like "major DeFi platforms" or "competitor protocols" are the
pattern going forward when referring to industry practice. A historical
sweep removed a handful of stray competitor mentions from comments and
copy; the policy is now a standing convention.

## Wallet picker: strategy + adoption decision

**Decision of record: adopt the ConnectKit + wagmi v2 stack** for the
wallet-connect flow, replacing the in-house connector UI. The driver
was parity with how serious DeFi products present wallet choice today —
a curated picker that lists browser extension wallets, WalletConnect
mobile wallets, and Coinbase Wallet side-by-side, with a clear
"I don't have a wallet" escape hatch. Alternatives evaluated and
rejected:

- **Building the picker UI in-house.** Rejected: the maintenance cost of
  tracking wallet-registry churn, mobile deep-link patterns, and
  connector quirks was higher than adopting a library.
- **The WalletConnect-native modal stack.** Rejected: more opinionated
  about its own product surface than we wanted on our own brand.
- **Keeping the current barebones UI.** Rejected: showed as "this is a
  toy" to users coming from established DeFi venues.

With ConnectKit selected, the theme auto-follows our existing light/dark
mode, and the "No wallet detected" nudge is owned by ConnectKit's
picker inline rather than a separate red banner.

## Safe-app embed

Vaipakam can now be loaded inside a Safe multisig's dapp browser. The
app detects when it's running in a Safe iframe, auto-connects via the
Safe postMessage handshake (no wallet prompt), and treats the Safe
itself as the signer. Outside a Safe iframe this code path is a no-op
— the normal browser flow is unaffected.

**Content-Security-Policy adjustments** on Cloudflare Pages' `_headers`
file: `frame-ancestors` now explicitly allows Safe's dapp-browser
origins; `X-Frame-Options` is deliberately omitted (its legacy
DENY/SAMEORIGIN values would block the Safe iframe — modern browsers
enforce `frame-ancestors` instead, which supersedes it);
`Cross-Origin-Resource-Policy` is set to `cross-origin` so the Safe
parent frame can read our resources.

## Cloudflare build hardening

A series of production-build failures surfaced during the ConnectKit
integration. Each resolved individually:

- **React-is peer dependency** needed pinning — ConnectKit's
  styled-components chain required it at the top level.
- **Valtio / derive-valtio version mismatch.** A transitive breakage
  from upgrading valtio to v2 against a derive-valtio that was
  written against the v1 API. Pinned valtio to v1.13.2 so the derive
  helper resolves cleanly.
- **Npm save behaviour** — initial installs of wagmi/viem/connectkit
  were silently not persisting into `package.json`. Fixed by committing
  `--save --legacy-peer-deps` as the explicit flag and adding a project
  `.npmrc` with `legacy-peer-deps=true`.
- **TypeScript strict-mode parity.** Cloudflare's build runs
  `tsc -b && vite build`, which surfaces errors `tsc --noEmit` misses.
  From this point on the local verification command is `tsc -b --force`,
  matching Cloudflare exactly.

## Google Tag Manager integration (groundwork only)

Google Analytics / gtag.js loader wired into `<head>`, right after the
opening tag. At this point the integration was unconditional — the
Consent Mode v2 wrapper and consent banner landed on 23 April (see the
next release-notes file).

## Phase B-full — frontend ethers → wagmi v2 + viem migration (started)

Decision locked in: migrate the entire frontend off ethers.js onto
wagmi v2 + viem, rather than the smaller "B-opportunistic" cut that
would have left mixed stacks coexisting. Rationale: every non-trivial
future UX feature (mobile deep-linking, gasless txs, ERC-4337 smart-
account flows) depends on the wagmi + viem surface. Coexisting was
paying migration cost twice and leaving a compatibility shim that
outlived its purpose.

Scope: ~30 hooks + 15 pages + the Diamond / ERC20 / event-index
libraries. The migration started on 22 April and completed on 23 April
— the full story is in the 23-24 release notes.

## Documentation convention agreed

No formal agreement on this date, but the practice started of writing
plain-English functional summaries under `/docs/` instead of only
relying on code comments and commit messages. This convention was
formalized on 24 April (see memory `feedback_doc_convention.md`).
