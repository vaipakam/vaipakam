# Vaipakam Website UI/UX Readme

## Purpose

This document will define the website and product experience for Vaipakam.
It is separate from the protocol-level `README.md`, which focuses on smart contracts, workflows, and backend logic.

The goal of this file is to guide the design and development of:

- the public marketing website
- the connected app experience
- user flows for lenders, borrowers, and NFT renters
- mobile and desktop UX behavior
- light theme and dark theme behavior
- basic and advanced product interaction modes
- visual design system decisions

## Website Goals

The Vaipakam website should:

- explain the protocol clearly to first-time users
- help users understand lending, borrowing, renting, collateral, repayment, and claims
- make complex DeFi actions feel understandable and trustworthy
- surface risk, liquidation, collateral, and claim rules clearly before users commit
- provide a smooth path from landing page to connected app actions
- feel intuitive to users familiar with DEX and DeFi product patterns
- support both beginner-friendly guidance and advanced-user efficiency
- include a clear frontend disclaimer that reads: `Vaipakam is a decentralized, non-custodial protocol. No KYC is required. Users are responsible for their own regulatory compliance.`

## Main Experience Areas

### 1. Public Website

This section will later define:

- homepage structure
- public analytics dashboard
- product explanation sections
- how Vaipakam differs from standard lending protocols
- educational sections for ERC-20 lending and NFT rental flows
- trust, safety, and risk communication
- FAQs
- public Terms of Service and Privacy Policy pages

Public-navigation requirements:

- cross-page hash-anchor navigation must work reliably from every public page and connected-app page that links back into the landing-page sections such as `Features`, `How it works`, `Security`, and `FAQ`
- when a user clicks one of those anchor links from pages like `Buy VPFI`, `Analytics`, or any route under `/app`, the frontend should route to the landing page and then scroll to the correct section rather than dropping the user at the top of the home page
- the implementation should tolerate route-change timing where the landing-page section may mount slightly after navigation, so hash-anchor scrolling should retry briefly until the target section exists
- the public `Buy VPFI` link from the home page and footer must resolve to `/buy-vpfi`, which is a no-wallet marketing / education route for VPFI
- the actual buy, deposit / stake, withdraw / unstake, and staking-reward claim controls live inside the connected app at `/app/buy-vpfi`; public CTAs should open that app route when the user chooses to transact
- public navigation should stay informational and should not carry wallet UI, wallet-connected banners, or a VPFI action dropdown unless a later design intentionally restores it
- app-shell links to public-only experiences such as `NFT Verifier` should open in a new tab and use an external-link affordance so users understand they are leaving the connected-app shell
- public-shell pages that sit below the fixed Navbar, including `Analytics`, `NFT Verifier`, `Buy VPFI`, `Terms`, and `Privacy`, must include enough top clearance that their headings never render under the Navbar
- public navigation must preserve the Vaipakam brand mark at its natural size across desktop widths; link spacing and right-cluster spacing should compress before the logo is allowed to shrink
- the footer should expose `Terms`, `Privacy`, `Cookie settings`, and, once published, the public bug bounty program link
- footer resource links that describe deployed contracts should land directly on the Analytics transparency section (`/analytics#transparency`) rather than a generic dashboard top

PWA requirements:

- the dApp should be installable on supported mobile browsers through the native `Add to Home Screen` / install prompt
- the web app manifest should include Vaipakam branding, app icons, theme color, and shortcuts for high-frequency destinations such as Offer Book, My Loans, Buy VPFI, and Alerts
- the production service worker may cache only the static app shell with a stale-while-revalidate strategy
- dynamic data including RPC responses, subgraph reads, `/quote/*` worker responses, and transaction-preview responses must bypass service-worker caching so on-chain state is never stale
- the service worker should register only in production builds and should fail safely on browsers that do not support service workers

Farcaster Frame requirements:

- Vaipakam may expose a public read-only Farcaster Frame at `/frames/active-loans`
- the Frame should let a user enter a wallet address and check active Vaipakam loans across supported chains without signing or connecting a wallet
- the result should show total active-loan count, lowest Health Factor, and per-chain breakdown where data is available
- the result should deep-link to the public NFT Verifier so users can inspect individual position NFTs after seeing the wallet summary
- Frame image responses should be stateless, branded, and suitable for common Farcaster clients

Privacy and consent requirements:

- the public website and connected app must include a cookie-consent banner that supports Google Consent Mode v2 and EU / GDPR expectations
- on a first visit, the banner should slide up from the bottom and present three equally prominent choices: `Reject all`, `Customize`, and `Accept all`
- essential cookies required for session handling and anti-abuse protections are always on
- analytics, personalization, and advertising categories must be off by default until the user explicitly opts in
- the `Customize` view must let users toggle analytics, personalization, and advertising independently
- consent choices must persist across visits
- the footer must include a `Cookie settings` link that re-opens the banner at any time so the user can change or revoke consent
- Google consent defaults must be set to denied before Google's tag loader fires, so tracking cookies are not created before the user makes a choice
- Google Analytics may load only through the consent-aware pipeline
- when analytics consent is granted, the integration should use Advanced Consent Mode defensive defaults, including `ads_data_redaction` and `url_passthrough`
- `ads_data_redaction` should ensure ad-click identifiers are redacted on outbound requests whenever advertising consent is denied
- `url_passthrough` should allow conversion attribution to flow through URL parameters instead of cookies where appropriate
- no non-essential tracking category should load before the user grants the corresponding consent

Legal and data-rights requirements:

- `/terms` and `/privacy` must be public routes that do not require wallet connection
- the Terms page should mirror the source-of-truth text from `docs/TermsOfService.md`
- Terms, Privacy, Risk Disclosures, and User Guide pages should use locale-aware content where available and show a clear English-only notice when the legally binding or guide content is still available only in English for the active locale
- Risk Disclosures may show a translated helper panel beside the English source text, but the UI must identify the English text as the controlling version
- before using `/app/*` routes, connected wallets may be required to sign or submit an on-chain acceptance of the current Terms version and content hash
- if the Terms version or content hash changes, the app should ask the user to accept again before reopening app routes
- a disabled Terms gate state should exist for testnet / pre-launch operation, so the code path can ship without forcing acceptance before governance activates it
- the Privacy page should explain what Vaipakam collects, what it deliberately does not collect, who receives consented analytics data, and how users can exercise GDPR / CCPA-style data rights
- data-rights UI must live on a dedicated connected-app page at `/app/data-rights`, with action cards for exporting or deleting Vaipakam-namespaced browser storage and clear explanation that public on-chain state cannot be erased by frontend action
- the issue-details drawer should stay scoped to support diagnostics: reporting, copying JSON, downloading / clearing the current in-memory journey log, and linking to `/app/data-rights` for broader browser-storage rights
- the Data Rights page should also expose a `Download journey log (this session)` card so a user can share the live session buffer even when the issue drawer is hidden by operator configuration
- Delete-my-data controls should use a deliberate confirmation step and should enumerate the concrete local effects before deleting, including consent reset, journey-log clearing, cached event-index removal, and theme / language / mode preference reset

### 2. Connected App

This section will later define:

- dashboard
- dashboard consolidation of user-owned state: active loans, active offers, fee-discount consent, VPFI discount tier, staking-rewards mirror, and claimable terminal-state shortcuts
- VPFI token transparency, escrow-staking, and fee-discount surfaces in Phase 1, with broader governance UI reserved for Phase 2
- multi-network connected-app behavior for the separate Phase 1 Diamond deployments on `Base`, `Polygon`, `Arbitrum`, `Optimism`, and `Ethereum mainnet`
- create offer flows
- accept offer flows
- repayment and claim flows
- liquidation and warning states
- preclose, refinance, and lender early-withdrawal flows
- loan details timelines, claim readiness, and lifecycle-event breakdowns

Current connected-app surface expectations:

- `Dashboard` is the user's "your stuff" surface: it should include active loans with Role / Status filters, pagination, sortable columns, a most-recent-first default sort, the user's offers across active / filled / cancelled states, the shared VPFI fee-discount consent, a VPFI rewards summary, and a green `Claim` CTA for terminal loans with unclaimed funds
- `Offer Book` should be wallet-gated inside `/app`; after connection it should keep market browsing filterable by side, asset, status, liquidity, duration, and per-side count; market-rate annotations should use a filter-scoped recent-acceptance anchor with signed deltas and a mobile-friendly explanatory tooltip
- closed / filled offer rows should link to the loan they created when an `OfferAccepted(offerId, acceptor, loanId)` event is available
- `Create Offer` should disable submit until full form validation passes, with typed validator error codes mapped through i18n, and should show token-identification trust blocks under address fields so users can distinguish canonical assets from unknown or suspicious contracts
- in Advanced mode, `Create Offer` should show an ERC-20 / ERC-20 risk-preview card that computes projected Health Factor, LTV, and liquidation-price cushion from live oracle and risk parameters; for Range Orders it should show both best-case and worst-case values and warn clearly when the worst-case Health Factor falls below the initiation floor
- the primary Create Offer duration control should be a bucketed picker using the standard buckets `7 / 14 / 30 / 60 / 90 / 180 / 365 days`, defaulting to `30 days`; defensive validation should still reject out-of-range or non-bucket values if the form is hydrated from an external source
- Range Orders controls should appear only when the corresponding live protocol flags are enabled. Basic mode should keep the existing single amount / single rate flow; Advanced mode may expose min / max amount and min / max rate inputs, approve or Permit2-sign the upper amount bound, and show live balance warnings before submission.
- `Loan Details` should be wallet-gated inside `/app`; after connection it should show the live loan state, role-gated actions, a chronological on-chain timeline, claimable-state action bar, and precise event breakdowns for settlement splits, fallback collateral allocations, partial repayments, swap retries, and VPFI rebates
- `Activity` rows that reference a loan should use a clickable `Loan #X` pill linking to that loan's full details page
- `Claim Center` is the home for loan claims and platform-interaction rewards; the former standalone in-app `Rewards` page should not be treated as a live route
- public `/buy-vpfi` is the marketing / education surface for VPFI; connected `/app/buy-vpfi` is the wallet-gated home for buying, staking / depositing, unstaking / withdrawing, staking-rewards claims, and chain-level VPFI transparency
- in the connected-app sidebar, `Claim Center` should sit with the core lending actions before `Buy VPFI`, while token-purchase and advanced utility destinations remain secondary to loan management
- the in-app logo should route to `/app` so connected users return to the dashboard shell; the public navbar logo should continue to route to `/`
- the app's issue drawer should be labelled as `Report Issue` / `Issue Details`, not `Diagnostics`, and should generate a redacted report suitable for GitHub issue filing

Transaction-safety and single-signature flows:

- review modals for Offer Book accept, Create Offer submit, Repay, and Add Collateral should support the Permit2-first pattern where the action uses Uniswap Permit2 when possible and falls back to the classic approve-plus-action path when Permit2 is unavailable or unsupported
- Permit2 should be presented as a convenience that reduces wallet popups for supported ERC-20 actions, not as a requirement to use Vaipakam
- Permit signatures should use the canonical Permit2 deployment at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, expire after 30 minutes, and include clear review copy so users understand the asset and amount being authorized
- before the final confirmation on supported review modals, the app should show a transaction preview panel backed by the server-side Blockaid proxy when available
- the transaction preview panel should distinguish benign previews, warnings, malicious classifications, and preview-unavailable states with clear severity styling
- Blockaid unavailability must fail soft: it may collapse to a subtle preview-unavailable state, but it must not block the on-chain transaction path by itself
- API keys for transaction scanning and swap quotes must stay server-side; the browser should call only worker-internal proxy routes
- review modals should continue to treat the wallet transaction and smart contract call as the source of truth; scanner output is informational safety context

Liquidation quote orchestration:

- Loan Details should show a `Liquidate` action for active loans with on-chain Health Factor below `1.0`
- liquidation review should quote available routes in parallel across 0x, 1inch, Uniswap V3, and Balancer V2 where configured
- 0x and 1inch quote requests should go through Cloudflare Worker proxy routes so operator API keys are injected server-side and never ship to the browser
- Uniswap V3 quotes may use direct on-chain quote reads across supported fee tiers
- Balancer V2 quotes may use a configured per-chain subgraph URL to find a deep eligible pool and estimate output for route ranking
- successful quotes should be sorted by expected output, with the best route and fallback order shown before the user submits liquidation
- if one quote source is unavailable, the UI should still submit a ranked try-list from the remaining sources where possible
- the quote-proxy routes should use per-upstream rate limits, such as separate 0x and 1inch per-IP budgets, so one upstream cannot exhaust the other

Keeper-bot reference UX / ops requirements:

- Vaipakam should support a standalone public keeper-bot reference implementation for third-party liquidators once mainnet selectors are stable
- the bot should mirror the frontend / worker liquidation route orchestration: list active loans, read Health Factor, quote 0x / 1inch / UniV3 / Balancer V2, rank routes, and submit `triggerLiquidation`
- the bot may also include a Range Orders matcher detector: page active offers, bucket compatible lender / borrower candidates, call match preview, submit `matchOffers` for valid pairs, respect per-tick preview / submit caps, and keep polling quietly while the partial-fill master flag is off
- the public bot documentation should describe setup, chain coverage, optional aggregator API keys, logging, MEV-protection options, and clear scope limits
- bot ABI files should be generated from the monorepo contract surface rather than maintained as hand-written selector strings

Borrower VPFI discount UX:

- `Buy VPFI` must remain homepage-visible through the public `/buy-vpfi` marketing page, but wallet-bearing purchase / stake / unstake controls must live in the connected app at `/app/buy-vpfi`
- the canonical learn route is `/buy-vpfi`; the canonical transaction route is `/app/buy-vpfi`
- the homepage and other public-facing CTAs should surface the public VPFI learn flow for everyone and then route users into `/app/buy-vpfi` when they choose to buy, stake, or unstake
- the borrower discount spec describes a VPFI acquisition flow that should work from the user's preferred supported chain once the user is in the connected app
- the app page should support the borrower-side VPFI discount flow described in `docs/TokenomicsTechSpec.md`
- the page should make clear that the user can buy from their currently preferred supported chain, even if canonical-chain infrastructure is used behind the scenes
- `/app/buy-vpfi` should be reachable from inside the connected app sidebar and from in-app CTAs that mention VPFI discounts or rewards
- the page should not require or prompt the user to manually switch to the canonical chain in order to buy VPFI
- if the protocol routes the purchase through canonical-chain infrastructure under the hood, that complexity should be abstracted away from the user-facing purchase flow
- buy-card labels, rate stats, tooltips, and balance checks should be asset-aware: ETH-native chains may label the pay asset as the chain's native gas asset, while WETH-pull chains such as BNB Chain or Polygon PoS must label the configured bridged WETH payment token clearly and provide a verification link for that exact asset
- LayerZero fee copy should label the fee in the active chain's native gas symbol, even when the VPFI purchase amount itself is paid with bridged WETH
- the fixed-rate `Buy VPFI` flow should follow the active tokenomics spec and must not rely on a silent pre-minted sale reserve unless a later approved design explicitly reintroduces one
- if the purchase route settles through a Base-chain receiver, VPFI must be minted or released only after the receiver actually receives ETH, and the delivered VPFI amount must be calculated from the received ETH amount
- after purchase, the VPFI should be delivered to the user's wallet on the chain where the user chose to buy
- the UI should then guide and facilitate a separate explicit user-intent action to move or deposit that wallet-held VPFI into the user's personal escrow for staking / discount eligibility
- staking should be messaged as open to any VPFI holder, not only borrowers or users with an existing loan; first deposit should make clear that the user escrow can be created automatically
- the public marketing page should explain that VPFI can be bought, deposited / staked, and withdrawn / unstaked; the actual app controls should label the escrow action as `Deposit / Stake VPFI` and the reverse action as `Withdraw / Unstake VPFI`
- the `Deposit / Stake` card should contain the canonical open-staking explanation in one user-friendly Info callout; duplicate page-level or step-subtitle copies should be avoided
- the VPFI discount-status table belongs on `/app/buy-vpfi` near the purchase / deposit decision, while the shared fee-discount consent toggle remains on `Dashboard`
- the discount-status table should render only for connected wallets and should link users back to `Dashboard` when consent is disabled
- the Phase 1 `30,000 VPFI` user cap is a per-chain cap, not a protocol-wide global cap across all chains
- VPFI deposited / staked in escrow on one chain should count only toward fee-discount tiers for loans initiated on that same chain
- the UI should expose a single common platform-level user setting for consenting to the use of escrowed VPFI for fee discounts
- that shared fee-discount consent control should live inside the connected app and be shown on `Dashboard`
- the consent control should not be treated as a `Buy VPFI`-page-only setting
- offer-level or loan-level consent toggles are not required for VPFI fee discounts once that common platform-level setting is enabled
- the connected app should show the user's escrowed VPFI balance, the implied discount tier, and the fact that escrow-held VPFI also counts as staked for the `5% APR` staking model
- on `/app/buy-vpfi`, the `Your VPFI discount status` area should provide a chain selector rather than only showing the currently inferred chain name in the title / balance label
- that chain selector should let the user inspect chain-specific escrowed VPFI, discount-tier status, and discount eligibility because those values are local to the selected lending chain
- VPFI tier thresholds should display in token units rather than raw 1e18-scaled base units across discount-status cards, tier tables, tooltip placeholders, and consent copy
- borrower and lender fee-discount messaging should follow the tiered model from `docs/TokenomicsTechSpec.md`, not a single flat `25%` discount
- app pages such as `Create Offer` and `Loan Details` may still link users into this `Buy VPFI` flow as secondary shortcuts when the borrower discount is relevant
- if a `Buy VPFI` app action fails, the page should show a clean error card with secondary actions such as `Report on GitHub` and `Dismiss` aligned consistently and visibly as one grouped action area rather than appearing visually misaligned
- borrower VPFI-discount copy must follow the Phase 5 model: users pay the full `0.1%` LIF up front in VPFI, earn the discount time-weighted during the loan, and receive any earned rebate through the borrower claim on proper close
- the Offer Book accept-review modal should explain the up-front VPFI payment plus time-weighted rebate model before the user accepts a loan through the VPFI path
- borrower-facing shortcut copy may say `earn up to a 24% VPFI rebate`, but should not describe the up-front fee itself as reduced
- the Claim Center should show a visible VPFI rebate line when a borrower claim includes a pending rebate
- VPFI escrow deposit from `/app/buy-vpfi` or related app surfaces may use Permit2 when supported, with fallback to the classic approve-plus-deposit flow

Alerts and notification preferences:

- `/app/alerts` should let borrowers configure per-loan HF threshold alerts and delivery rails
- HF threshold notifications stay compulsory once any delivery rail is enabled
- paid Push notification event types should be individually toggleable, defaulting on for new subscribers: claim available, loan settled / defaulted, cross-chain VPFI buy received, offer matched, maturity approaching, and partial repayment received
- the Push rail should disclose the current flat notification fee, explain that Telegram remains free, and make clear that the VPFI fee is deducted from escrow only on the first paid Push notification per loan side
- the UI should warn when the user's escrowed VPFI balance appears insufficient for the notification fee, while the on-chain billing path remains authoritative

Reward-claiming UX:

- Vaipakam should provide a simple and consistent reward-claiming experience across all supported chains
- users should be able to claim two reward types directly on the chain where they are actively lending, borrowing, or renting NFTs:
  - `Staking Rewards` earned automatically when VPFI is held in the user's escrow
  - `Platform Interaction Rewards` earned from lending and borrowing activity using the tiered and time-weighted logic defined in `docs/TokenomicsTechSpec.md`
- rewards should be calculated and minted locally on the user's currently connected chain
- no cross-chain messaging or mandatory network switching should be required during the claim flow itself
- the user's escrowed VPFI balance on that chain should be treated as the staked balance for reward purposes
- if the user wants to move claimed VPFI elsewhere afterward, bridging should remain optional
- reward surfaces should be split by user intent rather than combined into one `Rewards` page:
  - `Staking Rewards` should be claimed from `/app/buy-vpfi`'s `Deposit / Stake` card, with a compact mirror on Dashboard discount status
  - `Platform Interaction Rewards` should be claimed from Claim Center above the per-loan claim rows
- Dashboard should include a combined `Your VPFI rewards` summary for connected wallets, showing total earned across staking and interaction rewards, per-stream pending / claimed amounts, and deep links to the canonical claim cards
- the combined rewards summary should render even when all values are zero so new users can discover how the rewards programs work
- the old `/app/rewards` route and sidebar entry should remain retired unless a later approved design reintroduces a combined rewards hub
- staking-rewards cards should show pending VPFI, lifetime claimed VPFI reconstructed from `StakingRewardsClaimed` events, and neutral chrome when pending is zero
- interaction-rewards cards should show pending VPFI, lifetime claimed VPFI reconstructed from `InteractionRewardsClaimed` events, and an expandable `Contributing loans` list
- contributing-loan rows should link to Loan Details and describe the user's USD-denominated participation contribution, not pretend that a precise per-loan VPFI amount exists
- when a global interaction-reward denominator has not yet been broadcast to the local chain, the Claim Center should show a waiting state for that day rather than offering a transaction that would revert
- after a successful claim, the UI should:
  - show a success state with the exact amount claimed
  - refresh wallet balance and escrow balance in real time
  - offer an optional one-click `Bridge to another chain` action through the official LayerZero bridge flow if the user wants to move claimed VPFI, including a direct link to `https://layerzero.superbridge.app/` when appropriate
- if the user has no pending rewards on the current chain, the `Claim Rewards` action should be disabled or hidden with a helpful message such as `No rewards available to claim on this chain`
- if the user recently changed escrow balance through deposit, withdrawal, or fee deduction, reward displays must still calculate correctly up to the current block
- if the user switches chains, the active reward surfaces should refresh and show rewards specific to the newly connected chain
- if the network is unsupported or the wallet is not connected, the UI should clearly explain that rewards can only be claimed on supported lending chains
- reward data should be fetched from the Diamond on the currently connected chain using the existing hooks and helpers where appropriate
- the shared fee-discount consent flag is separate from reward claiming and must not gate reward visibility or reward-claim actions

Sanctions-screening UX:

- when the active chain has a sanctions oracle configured, the app should show sanctions banners only for a connected wallet or relevant counterparty that actually matches the oracle
- the banner should explain in plain language that new positions, deposits, VPFI fund-flow actions, liquidator rewards, and recipient claims are blocked for the flagged wallet, while debt close-out paths remain available where needed to protect an unflagged counterparty
- the banner should appear on action-heavy app surfaces where the user can be affected, including Dashboard, Create Offer, Offer Book, Buy VPFI, Loan Details, and Claim Center
- clean wallets should not see persistent sanctions education banners; the public Terms prohibited-use clause remains the general policy surface

Activity and local log-index requirements:

- the frontend log index should be the common source for Activity, Loan Details timelines, reward lifetime totals, filled-offer links, cancelled-offer reconstruction, staking / interaction claim history, and Range Orders match / close events
- cache-reader migrations may reconstruct newly derived fields from already-cached events on hydrate when the old cache captured the necessary event data
- adding brand-new event topics to the `getLogs` allow-list should bump the cache key so historical events are captured once through a deliberate rescan
- user-facing success states for writes must be driven by successful transaction receipts, not merely by inclusion in a block; reverted receipts should propagate as errors across shared Diamond and ERC-20 helpers

Unstaking VPFI:

- because VPFI held in user escrow is automatically treated as staked, users should be able to unstake by moving VPFI from escrow back to their wallet on the same chain
- the UI should provide a clear and prominent `Withdraw / Unstake VPFI` action on `/app/buy-vpfi`
- the unstake action should show the user's current escrowed VPFI balance and the maximum amount available to unstake
- when the user selects `Unstake VPFI`, the UI should:
  - show a simple amount-entry form
  - include a `Max` shortcut prefilled with the full escrow balance
  - show a confirmation step with:
    - amount being unstaked
    - impact on the current discount tier
    - impact on future `5% APR` staking rewards
- after confirmation, the VPFI should move from escrow to the user's wallet on the same chain
- after a successful unstake, the UI should refresh escrow balance, wallet balance, reward estimates, and discount tier in real time
- unstaking should be treated as instant with no lock-up period
- users should still be allowed to unstake while they have active loans, but the UI must clearly warn them about the immediate reduction in discount tier and staking rewards
- if the user has enabled the shared `Use VPFI for fee discount` consent flag, the UI should warn that unstaking may reduce or disable future fee discounts
- after unstaking, the UI may offer the standard LayerZero bridge flow if the user wants to move that VPFI to another chain, including a direct link to `https://layerzero.superbridge.app/`
- if the user has zero VPFI in escrow, the unstake action should be hidden or disabled with a helpful message
- if active loans currently rely on escrowed VPFI for fee-discount eligibility, the unstake flow should show a clear warning before confirmation
- if the user switches chains, `/app/buy-vpfi` should refresh and show the escrow balance, staking rewards, and unstake availability for the newly connected chain
- unstaking should be implemented as a local chain action only; no cross-chain messaging should be required for the unstake itself

Connected-app network model in Phase 1:

- the Vaipakam core protocol is intended to run as a separate Diamond on each supported network, but the current live deployment is still only on Sepolia
- supported Phase 1 networks are `Base`, `Polygon`, `Arbitrum`, `Optimism`, and `Ethereum mainnet`
- `VPFI` is cross-chain, and the interaction-reward denominator / reward-funding path also uses cross-chain messaging so each chain can claim against one protocol-wide daily interest total; loans, offers, collateral, repayment, liquidation, preclose, refinance, and keeper actions still stay on the currently selected network
- the app should make the active network clear and treat each network as its own local protocol instance with a dedicated Diamond deployment per network
- the connected topbar / wallet menu should show both chain icon and chain name after connection, collapsing to icon-only only on very narrow viewports while preserving the accessible chain name
- in-app pages should not mount a standalone pre-connect chain picker; read-only pre-connect chain exploration belongs on public Analytics, while wallet-gated app pages should take chain context from the connected wallet
- cached-data page titles should show an indexer status badge when relevant: green for indexed data with last-updated age and a rescan affordance, amber when the page has fallen back to live chain scanning

Wallet connection requirements:

- mobile wallet connection should open the selected wallet app directly instead of showing only a QR code
- when a phone user taps a wallet in the connect picker, the app should prefer that wallet's mobile deep link
- QR-code pairing should remain available as a fallback for cross-device connection
- the initial-chain prompt must not block first connects on iOS
- users on unsupported chains should still be allowed to connect and then see a clear switch-chain banner
- unsupported-chain connection should not fail silently or prevent the wallet from being recognized
- if no wallet is detected, the app should present that state as a yellow warning rather than a red error
- startup should warn site operators loudly if the WalletConnect project ID is missing from the deployment environment
- a missing WalletConnect project ID should be treated as a production misconfiguration because it can break mobile deep-linking and degrade users into a QR-only flow
- the wallet picker should be powered by ConnectKit on top of wagmi v2 so extension wallets, WalletConnect mobile wallets, and wallet-app deep links appear through one curated picker

Safe-app embed requirements:

- Vaipakam should be loadable as a Safe app inside the Safe multisig UI
- the app should auto-detect the Safe iframe context and auto-connect through the Safe postMessage handshake without showing a wallet prompt
- when connected in Safe context, the connected wallet should be the Safe itself
- outside a Safe context, the Safe connector should behave as a no-op and the normal browser wallet flow should be unaffected
- Content-Security-Policy headers must explicitly allow Safe's dapp-browser origins as frame ancestors
- the Safe connector should trust only Safe-owned origins for iframe handshake behavior

Governance-configuration visibility:

- loan-screen surfaces should reflect live on-chain governance parameters where those parameters affect the user-facing position
- each loan-detail page should include a `Lender Discount` card for the current lender when lender discount data is relevant
- the `Lender Discount` card should show the effective time-weighted VPFI discount computed from the current open-loan window and the on-chain discount curve
- this effective discount may be computed client-side by extrapolating the open-loan window against on-chain discount-curve data
- the frontend should expose a shared hook for reading the protocol fallback-split configuration
- fallback-split data should be available as lender / borrower split values so pages can read it without custom one-off contract calls
- user-facing constants, thresholds, and percentages should flow from live protocol config reads rather than hardcoded locale strings where they can change through governance or redeploy
- `useProtocolConfig` should read both mutable config and compile-time constants exposed by the Diamond, and reusable info components should inject common placeholders such as treasury fee, LIF, staking APR, tier thresholds, max slippage, and min Health Factor into translated tooltip copy
- tier tables, rental-buffer math, and validation copy should derive from live config where possible, so governance changes appear on next page load without a frontend redeploy
- VPFI unit displays should use the token contract's live `decimals()` value where available, with an 18-decimal fallback during transient read failures
- raw wei-denominated config values such as VPFI tier thresholds should be converted through shared display helpers before reaching cards, tooltips, translated strings, or tier tables

Foundational frontend migration requirements:

- the frontend should use wagmi v2 and viem end to end for wallet connection, reads, writes, multicalls, and JSON-RPC control
- ethers.js compatibility shims and the ethers dependency should not remain in the production frontend once the migration is complete
- the wagmi / viem foundation should preserve existing user flows while enabling first-class mobile wallet deep-linking
- contract-read surfaces should use wagmi / viem multicall batching where practical
- log-indexer and direct JSON-RPC paths should use viem-compatible request shapes so public RPCs do not reject legacy ethers-shaped calls
- the migration should leave a clear path for future gasless transactions, smart-account flows, and session-key flows

### 3. User Roles

The UI/UX should support:

- lenders
- borrowers
- NFT owners/lenders
- NFT renters/borrowers
- third-party repayers where supported
- current holders of Vaipakam lender NFTs
- current holders of Vaipakam borrower NFTs

Role-based visibility should follow current Vaipakam NFT ownership where relevant.

- claim actions must be available only to the current owner of the corresponding Vaipakam NFT
- pages and workflow sections may also be visible to the current Vaipakam NFT holder when that NFT represents the active protocol role
- the frontend should not assume only the original borrower or lender wallet is the relevant actor after loan creation
- if a Vaipakam NFT has been transferred, the UI should resolve permissions and visible actions from the NFT role holder

## UX Principles

The Vaipakam interface should be:

- clear before being clever
- trustworthy and transparent
- explicit about risks and irreversible actions
- friendly to both new and advanced users
- optimized for high-signal transaction review before confirmation
- inspired by the intuitiveness of modern DEX and DeFi products while staying easier to understand for non-expert users

## Theme Requirements

The frontend should support:

- a system-default theme that follows the user's OS light / dark preference until the user explicitly chooses a theme
- a selectable light theme
- a selectable dark theme
- consistent usability, contrast, and readability in both themes
- persistent theme preference across sessions where possible
- all states and components designed intentionally for both themes, not just color-inverted afterthoughts
- public Analytics, Buy VPFI marketing, and NFT Verifier pages may use the shared page-level ambient glow used by the app shell, but cards should remain flat unless a page-specific sparse analytics layout benefits from a subtle card gradient

## Responsive Strategy

The frontend should follow a mobile-first design approach while remaining desktop-friendly.

This means:

- key website and app flows must be designed for smaller screens first
- navigation, cards, tables, forms, and transaction review panels must remain usable on mobile devices
- desktop layouts should expand information density without making the UI feel like a different product
- all critical actions should be accessible on both touch devices and desktop browsers

## App Navigation And Layout

Chrome-level layout behavior:

- the left-side app panel toggle should collapse or expand immediately on the first click
- the app shell should not show a horizontal scrollbar when content fits the viewport
- the in-app top bar should remain sticky during page scroll; horizontal overflow guards on ancestors must not accidentally create a scroll container that breaks sticky positioning
- the sidebar header and app top bar should maintain matching height so the shell divider line stays aligned in expanded, collapsed, and hover-expanded states
- fixed or floating layout affordances must not create accidental horizontal overflow
- status severity should match user impact; for example, `No wallet detected` should be a warning rather than a blocking error
- public navigation should remain wallet-free and focused on informational routes, footer links, cookie settings, and core public CTAs; connected-app navigation should keep wallet, network, issue-reporting / support-details, and core app route controls reachable on mobile and desktop
- layout fixes should preserve the existing design language in both light and dark themes
- the settings popover should group global preferences such as Basic / Advanced mode, language, and theme in one predictable place

## Interaction Modes

The frontend should support both basic and advanced UX options through a single mode setting in shared UI context.

- **Basic UX Mode:** Cleaner, more guided, less intimidating, with clearer explanations, fewer visible controls, and safer defaults for new users.
- **Advanced UX Mode:** Higher information density, richer controls, more detailed metrics, and faster workflows for experienced DEX and DeFi users.

Both modes should:

- use the same underlying protocol rules
- clearly show important risks and confirmations
- let users move between guided and advanced views without losing context
- avoid hiding critical obligations such as collateral rules, liquidation rules, and claim rights

Implementation direction:

- use one mode value in frontend context so mode behavior is consistent across the connected app
- prefer toggle plus conditional rendering inside existing pages instead of maintaining separate duplicate page trees
- basic mode should keep create-offer, accept-offer, and repayment flows guided and streamlined
- advanced mode may expose denser controls, diagnostics, and protocol configuration details
- advanced-only inputs should stay hidden behind a clear `Advanced` disclosure when the user is in basic mode
- the primary `Basic / Advanced` mode switch may be placed at the top level of the connected app so users can change modes globally without hunting for inline per-page controls
- page-level inline mode toggles are not required; once the user changes the global mode, each page should react through conditional rendering
- when the `Advanced` section is expanded or enabled, advanced-only destinations such as `NFT Verifier` and `Keepers` may be shown in the left navigation
- when the `Advanced` section is collapsed or disabled, advanced-only destinations such as `NFT Verifier` and `Keepers` should be hidden from the left navigation
- the navigation should make it feel like advanced tools are an optional deeper layer of the app, not the default primary mode control
- card-level info popovers and `Learn more` links should route users to the matching Basic or Advanced guide based on the active mode, preserving role-specific anchors when the card has separate lender / borrower explanations

Advanced-only or advanced-disclosure fields may include:

- liquidity type
- keeper access / third-party execution preferences
- asset-type selectors where the flow supports multiple asset classes
- partial repayment actions
- add-collateral actions
- keeper whitelist / keeper-management configuration

## Key UX Requirements

The website/app should clearly communicate:

- collateral asset type and amount
- asset liquidity status
- current LTV and Health Factor for loan-detail and other relevant position-detail views, wherever those metrics are meaningful for the active asset type
- repayment obligations
- claim rights after repayment or default
- keeper / third-party execution rules
- liquidation conditions
- borrower NFT and lender NFT ownership implications
- the role-relevant Vaipakam NFT ID in dashboard and position views; show the lender NFT ID to lender-side users and the borrower NFT ID to borrower-side users. These Vaipakam NFT identifiers should be clickable and route to a Vaipakam NFT details / verifier view because they control position ownership and claim rights
- the Vaipakam NFT verifier must distinguish between a valid live NFT, a burned NFT, and a token ID that was never minted on the current chain
- a valid NFT should continue to show a normal verified success state with owner and on-chain metadata
- a burned NFT should be shown as a warning state rather than a hard error, because the position NFT was previously valid but is no longer claim-capable after the underlying loan terminated
- when historical indexed data is available for a burned NFT, the verifier should additionally show the related loan ID, whether that NFT represented the lender or borrower side, the final loan status, principal, collateral, interest rate, and duration
- when the token ID was never minted on the selected chain, the verifier should show a clear chain-specific error explaining that the token does not exist on that chain and the user may need to switch to the chain where the position was originally opened
- active theme and view-mode controls when relevant
- ENS and Basenames should be resolved for wallet-address display in Activity, Loan Details, Offer Book, and header/profile surfaces; unresolved names should silently fall back to shortened addresses
- allowance-management copy should stand on Vaipakam's own revoke flow and avoid unnecessary competitor references in page subtitles or helper text
- liquid active loan details should show the collateral-asset liquidation price at which HF reaches `1.0`, both as an absolute price and as a percent move from the current oracle price
- liquidation-price views should be hidden for illiquid loans where no oracle-priced liquidation threshold exists
- borrowers should be able to subscribe to loan-specific HF alerts with a chosen threshold such as `1.20`
- HF alert channels should include Telegram and Push Protocol where available; Push sending may be staged behind production channel setup without changing the client workflow
- Profile should include an Approvals section where users can inspect and revoke ERC-20, ERC-721, and ERC-1155 allowances granted to the Vaipakam Diamond
- whether the user is in a basic or advanced experience mode
- asset identity in a user-friendly format: the default visible label should be the asset symbol, while the full contract address should appear only in a hover / focus tooltip or explicit details view
- implementation note for asset pickers and token selectors: the UI may additionally show a shortened contract address inline next to the symbol/name when that helps users distinguish similarly named assets or verify they selected the intended token; full raw addresses should still be reserved for hover / focus, copy actions, or explicit details views rather than rendered prominently as the primary asset label
- whenever a user directly enters a contract address or selects an asset from a picker/list in a flow where the website/app actually needs to know the asset type, the system should automatically determine that contract's type and treat it as either `ERC20`, `ERC721`, or `ERC1155` without requiring the user to manually classify it first
- interest-rate formatting in user-facing screens should be shown as percentages (`%`) rather than raw basis points (`BPS`), unless the user is in an explicit advanced or developer-oriented diagnostic view
- lending amounts, collateral amounts, repayment amounts, and claimable amounts should be shown in human-readable token units using the token decimals and sensible rounding, not as full raw on-chain integer values
- offer, loan, and dashboard tables should use a shared principal display model where the asset and amount are readable in one cell; ERC-721 and ERC-1155 rows should include token IDs and an explorer link for NFT inspection
- on the Loan Details page and related position-detail views, LTV and Health Factor should be shown clearly when the loan uses liquid collateral and those metrics are applicable; the UI should avoid showing misleading placeholder HF/LTV values for asset types where protocol valuation does not apply in the same way
- when a user is creating or accepting an offer, the UI must show one combined pre-confirmation warning-and-consent area covering both abnormal-market fallback for liquid assets and the illiquid full-collateral-in-kind path when applicable
- liquidity status should be determined only from the current active network's oracle and usable DEX liquidity conditions; the website/app should not rely on Ethereum mainnet liquidity as a substitute for the current network and should not frame asset handling around a required mainnet fallback
- the combined warning must clearly explain that for liquid assets, abnormal conditions can disable normal liquidation: if liquidation cannot execute safely, the protocol must stop trying to convert collateral into the lending asset and resolve through a collateral-asset fallback path instead
- wherever the UI displays the liquidation slippage threshold, it should read the active configured value rather than hard-coding `6%`
- if governance changes the max liquidation slippage within its approved range, risk disclosures and liquidation preview copy should update to the new configured value
- the same combined warning must also clearly explain that for loan with illiquid assets (both lending asset and / or collateral asset) on default, the lender takes the full collateral in-kind rather than through a normal DEX liquidation / price-based conversion path
- the offer-creation and offer-acceptance flows should explicitly advise users to use only collateral assets they personally trust to hold value during stressed market conditions, because fallback settlement can leave the lender holding collateral worth far less than the principal amount
- the offer-creation and offer-acceptance flows must use one single mandatory combined warning-and-consent acknowledgement, not two separate warnings or two separate consents; that one acknowledgement must cover the abnormal-market fallback terms and the illiquid full-collateral-in-kind terms together
- if the user does not give that combined consent, the create-offer or accept-offer transaction must not proceed
- the combined consent must be captured and stored for the relevant offer and resulting loan, and it is acceptable for the resulting loan to store only the combined accepted-by-both-parties consent state because the consent is mandatory for both lender and borrower

Offer and acceptance risk warnings:

- the create-offer flow and accept-offer flow must use a single combined risk-review block rather than separate abnormal-market and illiquid warning blocks
- implementation note for the `Offer Book` accept-review modal: the page may additionally show one extra informational illiquid-leg warning above the combined warning-and-consent block when the selected offer contains an illiquid lending asset or collateral asset, so long as that extra warning does not introduce a second consent or a second required acknowledgement
- the combined warning copy should read in substance: `Abnormal-market & illiquid asset terms. For Liquid Assets, if liquidation cannot execute safely — for example because slippage exceeds the configured max liquidation threshold, liquidity disappears, or every configured swap route fails — the lender claims the collateral in collateral-asset form instead of receiving the lending asset. If collateral value has fallen below the amount due, the lender receives the full remaining collateral and nothing is left for the borrower. If collateral value is still above the amount due, the lender receives only the equivalent collateral amount and the remainder stays with the borrower after charges. The same fallback applies to loans with illiquid assets (lending asset and / or collateral asset) on default — the lender takes the full collateral in-kind. Proceeding confirms you agree to these terms.`
- the same risk-review area should require one combined mandatory checkbox / consent action tied to that single message
- on the create-offer page, these warnings only need to appear clearly on the page before submission; they are not required to be repeated in a separate final-confirmation state
- on the accept-offer flow, these warnings should still appear in the transaction review or confirmation state before the acceptance transaction is submitted
- on the create-offer page, the loan-duration input must be restricted to the supported protocol range of `1` to `365` days
- if the user enters a duration outside that supported range, the page should flag it inline with the validation message: `Enter "Duration between 1 and 365"`

Offer book requirements:

- the offer book should not attempt to render the full global offer set in one unbounded list
- the offer book should use pagination or cursor-based loading instead of trying to render the full market in one unbounded list
- in the combined two-sided market view, the page should support showing up to `50` lender offers and up to `50` borrower offers for the active filter set
- in the lender-only tab, the page should support showing up to `100` lender offers for the active filter set
- in the borrower-only tab, the page should support showing up to `100` borrower offers for the active filter set
- the offer book should also show the connected user's currently active offers in a dedicated section above the filters card so users can quickly review and jump to their own open market positions before browsing the wider book
- the default offer-book layout should make the market anchor readable without hiding normal rate ordering
- the market anchor should be the rate of the freshest recently accepted offer that matches the active filter context, using a rolling recent-match window rather than a single global last-accepted offer
- lender offers should sort by rate descending, with newest-id tie-breaks, so the highest lender rates are easiest to scan first
- borrower offers should sort by rate ascending, with newest-id tie-breaks, so the lowest borrower rates are easiest to scan first
- the Rate column should show a signed delta from the market anchor, e.g. `(+X%)` above market and `(-X%)` below market, with a tooltip explaining the anchor and direction
- if no prior match exists for the active market / filter context, the UI should show a clear fallback state such as `No prior matched rate yet`
- pagination should preserve the chosen market-side ordering instead of trying to load the full market into the browser at once
- filtering and sorting should be applied in a way that keeps the visible market window relevant to the current lending asset, collateral asset, duration, liquidity, and other active filters
- offer-book filter controls should share a pill-style visual language with chain pickers where appropriate, including discrete per-side limits such as `10`, `20`, `50`, and `100`
- the connected user's active-offers section should default to most-recent-first by offer ID
- tab header counts must be based on verified visible offer data, not stale raw log-index IDs
- if reliable counts cannot be produced for a tab, the UI should omit the count rather than displaying a misleading value such as `Open (2)` when one active offer is visible
- single-side lender and borrower tabs should support real pagination with `Previous`, `Page X of Y`, and `Next`
- pagination should reset on tab changes, filter changes, per-side limit changes, and open/closed status changes
- the combined both-sides view may keep a top-N layout without competing per-column paginators
- users should be able to toggle keeper access on their own open offer before acceptance, without cancelling and re-posting the offer

Dashboard offer-management requirements:

- the dashboard should include a `Your Offers` card with `Active`, `Filled`, `Cancelled`, and `All` chip filters
- active offer rows should include a `Cancel` action wired to the protocol's offer-cancel function, disabling the control while the transaction is pending
- filled offer rows should show the resulting `Loan #X` link when the accepted-offer event maps the offer to a loan
- cancelled offer rows should reconstruct terms from the richest available source: first a detailed on-chain cancel event, then a browser-local snapshot captured while the offer was active, then an identity-only fallback with clear unavailable fields
- cancelled-offer reconstruction helpers should stay out of the user-facing Activity feed and Loan Details timeline when they duplicate a single cancel action rather than representing a separate user-visible lifecycle event

Activity and dashboard history requirements:

- the in-app `Activity` page and the `Your Loans` card on the user dashboard should not dump the user's full history in one long unbounded list
- those surfaces should default to showing the most recent `15` entries at a time with explicit `Prev` / `Next` pagination controls and a status line such as `Showing A-B of N`
- when the user changes the `Activity` filter, the page should reset back to the first page of results rather than leaving the user on a stale later page
- dashboard and activity pagination should prioritize responsiveness by loading and rendering only the currently visible window where practical
- the dashboard `Your Loans` experience should use batched on-chain reads or multicall patterns rather than row-by-row chain-wide scans so that user history remains fast even on networks with a large total loan count
- the dashboard `Your Loans` card should provide Role and Status filters, a per-page picker, and sortable columns for core loan fields; the default sort should put the most recent loan IDs first
- loan IDs in the dashboard `Your Loans` table should be direct links to Loan Details, in addition to any explicit `View` button in the action column
- LTV and HF sorts should operate over the filtered result set, not only the currently visible page, while keeping illiquid or unavailable values from surfacing as misleading best results

Repayment UX requirements:

- repayment must be shown as callable by any wallet when the loan is active and repayment is allowed by protocol rules
- the UI must clearly distinguish who is paying from who owns the claim rights after repayment
- when the connected wallet is not the borrower, the repayment screen must show a prominent warning before confirmation
- the warning text should read: `Repaying this loan does not grant collateral rights. Collateral is claimable only by the current holder of borrower NFT #{id}.`
- the borrower NFT identifier shown in the warning should be the live borrower-side Vaipakam NFT for that loan
- the repayment confirmation flow should repeat the collateral-claim rule in the transaction review state, not only in page-level helper text

Keeper UX requirements:

- keeper configuration must be treated as an advanced setting
- keeper opt-in, keeper whitelisting, and any role-manager delegation UI should appear only in advanced mode or inside advanced settings; this does not require a separate inline mode toggle inside each page if the app already provides a global top-level mode switch
- basic mode should not surface the full keeper-management experience as part of the default everyday borrower or lender workflow, but loan-detail pages may show a compact per-side keeper status row with a one-click enable / disable control and a link to the full keeper manager
- wherever keepers are configured, the UI must clearly state that keepers are delegated role-managers only and cannot claim assets; claims remain available only to the current owner of the relevant Vaipakam NFT
- wherever the create-offer or accept-offer flow lets a user enable keeper / third-party execution for that position, the UI must also clearly state that this position-level flag is not sufficient by itself: the relevant user must separately enable keeper access in the advanced keeper settings at the user/profile level, otherwise approved keepers still cannot execute that user's role-entitled actions
- the UI should make it clear that keeper enablement is two-layered: a position may allow keeper execution, but a keeper can act for a given lender-side or borrower-side role only if that side's user-level keeper opt-in and whitelist are also active in advanced settings
- after loan initiation, the website/app should still allow each user to enable or disable keeper access later at the individual loan level from advanced settings for that user's own side of existing loans, even if keeper access was not enabled during offer creation or offer acceptance
- future keeper settings should allow users to choose which operation classes each keeper may perform, with scopes at the global user level, per keeper address, per offer, and per loan
- early withdrawal, borrower preclose, and refinance completion paths may be opened to keepers only when the relevant operation is explicitly allowed for that keeper and scope

Strategic-flow transfer-lock UX requirements:

- when a user starts a borrower preclose flow, the UI must clearly notify them before confirmation that the borrower-side Vaipakam NFT will be locked for transfer until that preclose flow is completed, cancelled, or otherwise unwound by the protocol
- when a user starts a lender early-withdrawal flow, the UI must clearly notify them before confirmation that the lender-side Vaipakam NFT will be locked for transfer until that early-withdrawal flow is completed, cancelled, or otherwise unwound by the protocol
- these transfer-lock warnings should appear in the relevant transaction review / confirmation state, not only as passive helper text elsewhere on the page
- the notice should explain in plain language that while the strategic flow is still in progress, the affected Vaipakam NFT cannot be transferred to another wallet and its ownership-driven actions remain constrained by that in-progress flow
- refinance is different: by the time the borrower calls `refinanceLoan`, the replacement lender has already accepted the new borrower offer and the replacement loan already exists as a separate live loan; the refinance transaction itself is a single atomic settlement step, so the UI should not warn about a refinance-specific borrower-NFT transfer lock unless a later protocol version introduces one
- before signature, lender early withdrawal, borrower preclose, and borrower refinance screens should also show the interest implication of the chosen path in plain language, including forfeited accrued interest, full-term interest, accrued-to-date interest, and rate-shortfall obligations where applicable

## Public Analytics Dashboard

The public website should include a no-wallet-required analytics dashboard focused on transparent, aggregated protocol data for regular users, potential participants, analysts, community members, security researchers, auditors, and public-sector reviewers.

Core dashboard principles:

- all dashboard data must be derived from on-chain contract state or raw on-chain events
- the dashboard must not depend on PII, KYC data, or user-identifying profiles
- displayed metrics must be privacy-preserving and aggregated
- each important number should be traceable back to contract view calls, event logs, or explorer links
- the dashboard should follow the same Vaipakam design language as the rest of the website and connected app, including theme support, responsive behavior, and Basic / Advanced presentation density

Phase 1 scope:

- use only aggregated metrics derived from the existing protocol facets such as `LoanFacet`, `OfferFacet`, `TreasuryFacet`, `EscrowFactoryFacet`, `ProfileFacet`, `OracleFacet`, and `RiskFacet`
- do not require governance dashboards or off-chain warehousing in Phase 1
- high-level cross-chain aggregation is in scope for the public analytics dashboard, but it should remain lightweight and read-only
- prefer lightweight view functions added to an existing facet if direct aggregation from current views/events is too expensive or awkward
- if a dedicated analytics view surface is eventually needed, it should remain minimal and read-only
- reuse existing frontend hooks, formatting utilities, and multicall patterns where practical

Required page placement and access:

- the analytics dashboard should exist as a public route and must load without wallet connection
- the implementation target should be `frontend/src/pages/PublicDashboard.tsx`
- the public website navigation should expose the dashboard clearly
- the connected app shell may also link to the same public dashboard when appropriate, but the page itself should remain usable without connecting a wallet

Required top-level metrics:

- the very top summary row should show protocol-wide combined metrics aggregated from all supported chains at a high level
- this combined top section is intended only for headline totals and should not replace the per-chain drill-down below
- `Total Value Locked (TVL)` in USD, including visible `24h` and `7d` change percentages
- TVL breakdown covering ERC-20 collateral, NFT collateral, and escrow balances where meaningful
- active loans, shown as both count and total value
- currently active offers and lifetime offer totals at the combined all-chains level in the global header
- total volume lent in USD, lifetime
- total interest earned by lenders in USD, lifetime
- `Total NFTs rented`, shown in the combined all-chains summary

Per-chain analytics section:

- all cards, charts, tables, and drill-down sections below the top summary row should be chain-specific rather than combined
- the page should provide a visible chain selector that switches the active chain context for those lower sections
- switching the chain selector should refresh the below-the-fold cards, charts, recent activity, treasury snapshot, and other detailed analytics to the selected chain only
- the selected-chain state should be obvious in the UI so users can clearly distinguish protocol-wide combined totals from chain-local analytics
- `Total NFTs rented` should also be shown in the selected chain's detailed breakdown
- implementation note: it is acceptable for this selector to also become the app's active read-chain context so that subsequent read surfaces follow the chain the user just chose; if a wallet is connected, the app may additionally request a wallet network switch for consistency

Required charts and visualizations:

- `TVL Over Time` as a line chart with range options such as `24h`, `7d`, `30d`, `90d`, and `All`
- daily loan volume and interest earned, shown as a combined bar-plus-line chart or similarly readable equivalent
- active versus completed loans, shown through a composition such as pie plus trend indicator
- asset distribution covering the main lending assets and collateral categories
- NFT rental utilization, showing active rentals versus total NFTs currently in escrow

Advanced-mode detail sections:

- in `Advanced` mode, the page should expose a recent-activity table covering approximately the latest `50` loans and offers with anonymized key parameters such as amount, rate, duration, and status
- in `Advanced` mode, the page should expose an asset-wise breakdown table including asset symbol, total locked amount, and share of TVL
- in `Advanced` mode, the page should expose protocol-health indicators such as average APR, average LTV, and illiquid-asset warning counts
- even in `Advanced` mode, the page must remain privacy-preserving and must not expose raw user-address identity as a primary dashboard data dimension

Transparency and export block:

- the page should show the current block number used for the displayed snapshot
- the page should show a clear data-freshness timestamp
- the page should link to the relevant contract addresses and explorer pages
- the page should provide full export actions for both `CSV` and `JSON`
- exported data should include the snapshot timestamp, contract addresses used, and the relevant block number so auditors and researchers can verify the source context

Implementation requirements:

- follow existing frontend conventions, theme handling, and shared mode handling
- use `ThemeContext.tsx` and `ModeContext.tsx` for theme and Basic / Advanced presentation behavior
- prefer `useDiamond.ts`, multicall utilities, and existing formatting helpers such as `lib/format.ts`
- existing token metadata and market-data helpers may be reused where they help with labels or presentation, but the protocol metrics themselves must remain on-chain derived
- preferred new hooks are `useProtocolStats.ts`, `useTVL.ts`, `useUserStats.ts`, and `useHistoricalData.ts`
- public analytics queries should use caching with approximately `30` seconds of stale time
- loading and error states should follow the product patterns already used in pages such as `Dashboard.tsx` and `OfferBook.tsx`
- the page should be mobile-first and remain usable on both small and large screens
- charting should stay lightweight and consistent with the rest of the frontend stack

Data-fetching strategy:

- prefer multicall-based reads for efficiency
- top-level combined metrics may be assembled by querying each supported chain separately in the frontend and summing the resulting headline values client-side
- all lower sections should continue to read from one selected chain at a time so the detailed analytics remain attributable to a specific chain
- when selected-chain dashboard sections need to fetch large sets of loans or offers, the implementation should prefer batching and multicall-style aggregation so the page remains responsive on chains with larger historical datasets
- derive historical series from raw event logs when feasible
- a shared Cloudflare Worker indexer may maintain D1-backed `offers`, `loans`, and append-only `activity_events` tables for fast first paint across offers, loans, activity, and claimability hints
- the worker indexer should fan out across configured chains on each cron tick and silently skip chains missing an RPC secret or deployment artifact, rather than failing the whole sweep
- frontend hooks such as active offers, active loans, wallet loans, activity, claimables, and offer stats should prefer the indexer when available and return an explicit `indexer` / `fallback` source state
- `Offer Book` should consume indexed active offers first, while keeping the existing browser event watcher so newly created global offers appear within seconds according to the existing non-user-customizable sort
- dashboard loan lists may consume indexed loan origination data, but current lender / borrower NFT-holder views should be live-filtered through `ownerOf(tokenId)` reads so transferred loan NFTs are reflected accurately
- Claim Center money-relevant claim payloads should continue to read directly from chain; indexed claimability is only a discovery hint
- VPFI token-panel scans may remain direct filtered log reads while volume stays low
- the app footer should expose one active-chain `Verify on-chain` affordance that opens the current Diamond on the relevant explorer; repeated per-row verify links are not required
- for aggregates that are too expensive to reconstruct repeatedly on the client, the protocol may expose lightweight read-only helper functions such as `getProtocolTVL`, `getUserCount`, `getActiveLoansCountAndValue`, and `getTotalInterestEarned`
- direct contract reads and browser log indexing remain the fallback path whenever the worker is unavailable, times out, or has no configured origin; the cache must never become an oracle for money-moving actions

Coding and quality requirements:

- new dashboard code should follow TypeScript strict mode
- frontend verification should use `tsc -b --force` for production-build parity because Cloudflare Pages runs the project build graph rather than only isolated no-emit checks
- new hooks and components should include clear JSDoc comments
- errors should use the existing contract-error decoding approach where relevant
- production code should not leave debug `console.log` statements behind
- interactive controls and charts should remain accessible, including sensible ARIA labeling where needed
- the page should include appropriate SEO-friendly metadata because it is a public transparency surface

Security, privacy, and compliance requirements:

- no PII, no personal user data, and no KYC data may be shown anywhere on the analytics dashboard
- all metrics must be aggregated and privacy-preserving
- selected-chain metrics should include nearby `View on-chain` affordances linking users toward the relevant contract call context, event source, or explorer trail where practical
- the combined all-chains headline cards do not need chain-specific explorer links, because those values are frontend-aggregated across multiple Diamond deployments rather than sourced from one canonical read target
- if heavy public queries need protection, lightweight frontend throttling or edge rate-limiting may be used as an implementation safeguard
- where a sanctions oracle is configured on the active chain, Create Offer should pre-flight the connected wallet and the Offer Book accept modal should pre-flight both the connected wallet and offer creator
- sanctions warnings should explain that Vaipakam does not maintain its own sanctions list and that list disputes must be handled with the oracle/list provider
- when no sanctions oracle is configured on a chain, sanctions banners should stay silent
- frontend oracle safety surfaces should reflect the Chainlink-led secondary quorum model using configured Tellor, API3, and DIA sources; the app should not present any separate pull-oracle price-update transaction as part of the current pricing path

Required dashboard disclaimer text:

- `Vaipakam is a fully decentralized, non-custodial protocol. All displayed data is aggregated from on-chain smart contracts. No personal user data is collected or stored. This dashboard is provided for transparency purposes only.`

Acceptance expectations for the dashboard:

- it must load without wallet connection
- displayed values must be verifiable against on-chain contract state or event history
- exports must work and include verifiable metadata
- the page must match the broader Vaipakam design system
- the page must be responsive and accessibility-conscious
- the frontend test suite should include coverage for the new hooks and major dashboard rendering states

## Troubleshooting And Observability

For troubleshooting issues encountered by users while using the website, the frontend should include a proper mechanism to capture what the user went through, what failed, and where it failed.

The website/app should support:

- structured logging of major user journey events across the connected app
- capture of the page, flow, action, and UI area where an error occurred
- capture of wallet errors, contract-call errors, transaction-revert errors, RPC/network errors, and frontend validation errors
- correlation of related events so support and engineering can reconstruct the user journey leading up to the issue
- user-safe diagnostics that help support teams understand what happened without exposing sensitive secrets
- clear user-facing error states together with internal diagnostic context for debugging
- user-facing labels should prefer friendly issue-reporting language such as `Report Issue` for the floating entry point and `Issue Details` for the drawer title, while internal code may still call the feature diagnostics

Implementation requirements:

- every important action path should emit frontend telemetry or logs for step start, step success, and step failure
- logs should identify the relevant area such as wallet connect, create offer, accept offer, repay, claim, liquidation-related view, preclose, refinance, or early withdrawal
- local logs should capture the active wallet address, chain/network, loan ID or offer ID when available, Vaipakam NFT role context when relevant, and the exact error message or revert reason when available, then redact sensitive fields before any user-submitted report is generated
- server-side diagnostics capture, when explicitly enabled by `VITE_DIAG_RECORD_ENABLED`, should send only minimized redacted failure records to the Worker `/diag/record` endpoint using sendBeacon / keepalive fetch; it must never include full wallet addresses, localStorage, cookies, user-agent strings, or freeform error text
- server-side diagnostics capture should fail soft, deduplicate repeated failures locally and server-side, respect CORS / rate-limit / sampling controls, and retain records only for the configured retention period
- the system should preserve enough event history to understand the sequence of user actions before the error happened
- the UI should provide a user-friendly way to surface or export troubleshooting details when support intervention is needed
- observability should work in both basic and advanced modes, and in both light and dark themes, without degrading the user experience
- the issue-details / troubleshooting surface should be available where the operator leaves `VITE_DIAG_DRAWER_ENABLED` on; hiding the drawer must not disable the separate server-side failure capture when that capture is enabled
- the floating issue-reporting entry point should stay hidden on the normal happy path and should become visible when there is at least one recorded failure, when the drawer is already open, or when the user is in `Advanced` mode
- the drawer should allow users to filter visible log events by `All`, `Failure`, `Start`, and `Success`, with live counts shown on each filter option
- the default event filter should be `Failure`, because that is the most likely support-relevant subset when the user opens the drawer after something breaks
- event filtering is a display concern only; export, copy, download, or `Report on GitHub` actions should continue to include the full unfiltered event history unless the product later explicitly adds scoped export choices
- generated GitHub issue bodies should use a human-readable summary first and place stack trace, cause chain, browser environment, and recent event details inside expandable sections
- the filter controls should sit directly above the event list rather than being buried only near the drawer header, so users can clearly understand that the filter changes the list below
- the layout of fixed diagnostics affordances must not cover important page controls, pagination buttons, or footer/legal text; public pages and app pages should reserve enough bottom breathing room so the floating button does not obstruct critical content
- every shared user-facing error alert should include a `Dismiss` action when local dismissal is safe
- `Dismiss` and `Report on GitHub` should appear together as one aligned action group
- dismissed errors should reappear when the underlying error message changes

## Design Direction

This section will later define:

- branding direction
- typography
- color system
- component library
- page layout system
- responsive behavior
- motion and interaction style
- theme tokens for light and dark mode
- design rules for both basic and advanced interface variants

## To Be Added Next

Next iterations of this document can define:

- sitemap
- wireframes
- page-by-page UX requirements
- component inventory
- app information architecture
- light theme and dark theme design specs
- mobile-first layout patterns
- desktop expansion patterns
- basic mode versus advanced mode rules
- onboarding flow
- wallet connection flow
- transaction confirmation patterns
- notification patterns
- empty/loading/error states
- troubleshooting and support diagnostics flow

# Social Links

X - https://x.com/vaipakam
Github - https://github.com/vaipakam
Reddit - https://www.reddit.com/user/Vaipakam/
Discord - https://vaipakam.com/Discord (https://discord.gg/5dTYbQKm69)
