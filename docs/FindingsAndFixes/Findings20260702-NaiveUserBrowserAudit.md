# Naive-User Browser Audit Findings - 2026-07-02

Scope: real Chrome/CDP walkthrough against `https://defi.vaipakam.com/`, using the MetaMask extension in `/home/pranav/Codes/Vaipakam/vaipakam-cdp-profile` and the connected wallet selected by the tester.

Reference material: `docs/FunctionalSpecs/WebsiteReadme.md`, prior positive-flow artifacts under `cdpwalkthrough/`, and the live connected app only. The perspective for findings is a normal user browsing and trying to use the product, not an engineer reading the specs.

Artifacts saved under `cdpwalkthrough/`:

- `naive-user-20260702-base-sepolia-audit.json`
- `naive-user-20260702-base-dashboard.png`
- `naive-user-20260702-base-offers.png`
- `naive-user-20260702-base-create-offer.png`
- `naive-user-20260702-base-claims.png`

## Environment Observed

- Browser: Chrome remote-debugged at `127.0.0.1:9222`.
- App page: `https://defi.vaipakam.com/create-offer` during the final pass.
- Wallet provider: MetaMask injected and connected.
- Selected account: `0xE873...23Cb`.
- Additional connected account exposed by MetaMask: `0x90F7...b906`.
- Initial chain: Anvil Local Testnet, `0x7a69`.
- Final supported-chain pass: Base Sepolia, `0x14a34`.

## What Worked

- Wallet connection completed through the normal ConnectKit -> MetaMask flow.
- The app's `Switch to Base Sepolia` action opened a MetaMask permission confirmation and, after approval, moved the wallet to Base Sepolia.
- On Base Sepolia, the main connected surfaces rendered with real wallet state:
  - Dashboard showed `1 Active Loans`, `1 As Lender`, and `1 Total Loans`.
  - Claim Center showed claimable Loan `#2`, role `Lender`, status `Repaid`, amount `1,000 mUSDC`, and a `Claim` action.
  - Activity showed grouped loan and offer events with clickable `Loan #` / `Offer #` style rows.
  - Your Vaipakam Vault showed vault address `0xCD84...D1E4`, `2,000 mUSDC` total, `1,000` locked, and `1,000` free.
  - Allowances scanned four tokens and clearly reported zero non-zero allowances.
  - Risk Access rendered the risk-tier controls and strict-mode explanation.
  - Data Rights rendered export, journey-log download, and delete-my-data controls.

## Findings

### F-20260702-001: Offer Book reports no open offers while also saying six open offers are hidden by filters

Status: open

Severity: medium-high

Evidence:

- Artifact: `cdpwalkthrough/naive-user-20260702-base-offers.png`
- Route: `https://defi.vaipakam.com/app/offers` on Base Sepolia.
- Visible page state says `No Open Offers` and `There are no open offers on the book. Be the first to create one!`.
- The same page also says `Showing 0 of 6 open offers (6 hidden by filters)`.
- The visible filter fields were blank / default: lending asset, collateral asset, duration `Any duration`, liquidity `Any`, side `Both Sides`, per side `20`.

Why it matters:

A normal borrower or lender sees contradictory states: there are supposedly no offers, but also six open offers hidden by filters they did not intentionally set. This makes the market look empty and can push the user into creating a new offer unnecessarily.

Suggested fix:

When open offers exist but are hidden, replace the empty-book message with a filter-empty state. Show which filters are active or implicit, provide a clear `Clear filters` action, and avoid the phrase `No Open Offers` unless the unfiltered open-offer count is actually zero.

### F-20260702-002: Supported-chain Create Offer still requires raw token contract addresses

Status: open

Severity: medium

Evidence:

- Artifact: `cdpwalkthrough/naive-user-20260702-base-create-offer.png`
- Route: `https://defi.vaipakam.com/create-offer` on Base Sepolia.
- The Create Offer form shows `Token discovery is not available on this network (testnet). Paste the contract address manually.` for both lending and collateral assets.
- This appears even after switching to the app-recommended supported network, Base Sepolia.

Why it matters:

A naive user who followed the app's own network-switch prompt reaches a supported testnet but still has to know token contract addresses to create an offer. That is a high-friction first-use path and conflicts with the goal that DeFi actions should feel understandable and trustworthy.

Suggested fix:

For supported testnets, provide a curated token picker for known mock/canonical assets, or at minimum show a `Use test assets` helper with known symbols and addresses. Keep manual address entry as an advanced path rather than the default first-use path.

### F-20260702-003: VPFI Vault presents deposit education before revealing VPFI is not registered on Base Sepolia

Status: open

Severity: medium

Evidence:

- Audit artifact: `cdpwalkthrough/naive-user-20260702-base-sepolia-audit.json`, route `/app/vpfi-vault`.
- The VPFI page starts with discount-tier and deposit guidance: `Deposit VPFI into your canonical-chain vault to unlock the tiered discount...` and `Depositing is open to everyone`.
- Lower on the same page it says `VPFI is not yet registered with the diamond on Base Sepolia. Admin must call setVPFIToken before deposits are possible.`

Why it matters:

The user first sees an action-oriented deposit flow, then later learns the chain cannot actually accept VPFI deposits. That reads as a broken product rather than a deliberately unavailable feature.

Suggested fix:

If VPFI is not registered for the active chain, make that the primary page state. Put the unavailable-chain explanation above the tier/deposit education, disable or hide deposit controls, and point the user to a chain where VPFI deposits are actually available if one exists.

### F-20260702-004: Unsupported-network banner uses internal rollout language

Status: open

Severity: low-medium

Evidence:

- Initial Anvil pass, before switching to Base Sepolia.
- The connected app banner said: `Phase 1 Diamond pending (chainId 31337)` and described `Mainnet rollout ... planned for Phase 1`.
- The banner did correctly provide a `Switch to Base Sepolia` action.

Why it matters:

A normal user does not need project-phase terminology. The banner's useful message is that the current wallet network is unsupported and actions require switching to a supported Vaipakam network. Internal rollout language makes the state feel less production-ready and may conflict with product-facing documentation style.

Suggested fix:

Replace phase-centered copy with user-centered copy, for example: `Unsupported network (chainId 31337). Vaipakam is currently available on Base Sepolia and Arbitrum Sepolia. Switch networks to continue.` Keep rollout details in docs or release notes, not the action-blocking banner.

### F-20260702-005: Legacy/direct app route aliases can render a blank page

Status: open

Severity: medium

Evidence:

- Direct route `https://defi.vaipakam.com/app/create` rendered an empty page with empty `#root`.
- Browser console showed `No routes matched location "/app/create"`.
- Direct route `https://defi.vaipakam.com/app/risk` also rendered an empty page with the same kind of route warning.
- The canonical Create Offer routes that worked were `/create-offer` and `/app/create-offer`; the canonical Risk Access route that worked was `/risk-access` or `/app/risk-access`.

Why it matters:

Direct links, old bookmarks, or guessed URLs can strand a user on a blank page with no recovery UI. Even if the sidebar uses the canonical route, a production SPA should not leave unknown app routes empty.

Suggested fix:

Add redirects for likely aliases such as `/app/create` -> `/app/create-offer` and `/app/risk` -> `/app/risk-access`. Add a route-level not-found page inside the app shell for any remaining unmatched app routes, with `Back to Dashboard` and `Report Issue` actions.

## Notes

- The MetaMask console emitted repeated `ObjectMultiplex` warnings during the CDP run. These appear to come from the extension content script and were not counted as app findings.
- Earlier positive-flow transaction findings from `Findings20260630-BrowserPositiveFlows.md` were not re-tested in this pass; this audit focused on the browsing and onboarding experience.
