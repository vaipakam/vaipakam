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
- the public marketing surface should remain chain-free and wallet-free: no wallet context, active-chain state, per-user escrow lookups, on-chain diagnostics, or address-book helpers should be loaded by marketing pages
- any marketing-page `Verify on chain` affordance should route users to the connected app's public transparency surface instead of performing chain reads inside the marketing app
- connected-app public-read shells such as `Analytics`, `NFT Verifier`, and `Protocol Console` should keep their top bar focused on app-context navigation. They should not mirror marketing-section dropdowns such as `Learn`; a single `Docs` / whitepaper-style link is acceptable when it points users back to canonical public documentation.
- the canonical marketing source package is `apps/www`, and the canonical public hostname is `https://vaipakam.com`; `https://www.vaipakam.com` should redirect to the apex while preserving path and query string
- legacy hostnames such as `labs.vaipakam.com` should not be emitted as canonical, sitemap, hreflang, or app-back-link origins
- public CTAs that open the connected app should use the label `Launch Vaipakam`, localized for every supported language, rather than the generic `Launch App`
- app-shell links to public-only experiences such as `NFT Verifier` should open in a new tab and use an external-link affordance so users understand they are leaving the connected-app shell
- public-shell pages that sit below the fixed Navbar, including `Analytics`, `NFT Verifier`, `Buy VPFI`, `Terms`, and `Privacy`, must include enough top clearance that their headings never render under the Navbar
- public navigation must preserve the Vaipakam brand mark at its natural size across desktop widths; link spacing and right-cluster spacing should compress before the logo is allowed to shrink
- the footer should expose `Terms`, `Privacy`, `Cookie settings`, and, once published, the public bug bounty program link
- footer resource links that describe deployed contracts should land directly on the Analytics transparency section (`/analytics#transparency`) rather than a generic dashboard top
- landing-page security / trust cards should make high-level claims without repeating per-card `Verify on chain` links; the footer or transparency route remains the single verification path for contract artefacts

SEO and discoverability requirements:

- the marketing build should generate `robots.txt` and `sitemap.xml`
- the sitemap should include every public marketing route in every supported locale and should declare the matching `hreflang` alternates
- every public marketing route should set a unique localized title, meta description, canonical URL, and locale alternate metadata on page mount
- canonical and `hreflang` URLs should be rooted at `https://vaipakam.com`, even if a visitor briefly arrives through `www` or a legacy hostname before redirect / routing settles
- social-preview and prerendering work may be staged separately; JavaScript-rendered metadata plus sitemap discovery is the baseline requirement unless search-console measurements show a remaining indexing gap

PWA requirements:

- the dApp should be installable on supported mobile browsers through the native `Add to Home Screen` / install prompt
- the web app manifest should include Vaipakam branding, app icons, theme color, and shortcuts for high-frequency destinations such as Offer Book, My Loans, Buy VPFI, and Alerts
- the production service worker may cache only the static app shell with a stale-while-revalidate strategy
- navigational HTML should prefer a network-first strategy so newly deployed app bundles replace stale PWA-controlled pages on the next load
- dynamic data including RPC responses, subgraph reads, `/quote/*` worker responses, and transaction-preview responses must bypass service-worker caching so on-chain state is never stale
- the service worker should register only in production builds and should fail safely on browsers that do not support service workers

Farcaster Frame requirements:

- Vaipakam may expose a public read-only Farcaster Frame at `/frames/active-loans`
- the Frame should let a user enter a wallet address and check active Vaipakam loans across supported chains without signing or connecting a wallet
- the result should show total active-loan count, lowest Health Factor, and per-chain breakdown where data is available
- the result should deep-link to the public NFT Verifier so users can inspect individual position NFTs after seeing the wallet summary
- Frame image responses should be stateless, branded, and suitable for common Farcaster clients
- Frame and worker reads must use generated Diamond ABI JSON from the monorepo contract bundle. The active-loan selector is `getUserActiveLoans(address)` on `MetricsFacet`; hand-written ABI strings or obsolete names such as `getActiveLoansByUser(address)` should not be used.

Privacy and consent requirements:

- the public website and connected app must include a cookie-consent banner that supports Google Consent Mode v2 and EU / GDPR expectations
- on a first visit, the banner should slide up from the bottom and present three equally prominent choices: `Reject all`, `Customize`, and `Accept all`
- essential cookies required for session handling and anti-abuse protections are always on
- theme and language sync cookies (`vaipakam_theme`, `vaipakam_lang`) are functionality cookies scoped to `.vaipakam.com`, so the public marketing site and connected app honor the same user preference without requiring analytics, personalization, or advertising consent
- when a sync cookie exists, it should be treated as the cross-subdomain source of truth and may overwrite stale origin-scoped localStorage on initialization; when no cookie exists, the first initialization should seed one from the browser / OS default so subsequent subdomain visits match
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
- the issue-details drawer should stay scoped to support diagnostics: reporting, downloading / clearing the current in-memory journey log, and linking to `/app/data-rights` for broader browser-storage rights
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
- Dashboard should not include a shallow `Your Escrow` / `Your Vault address` card when it only repeats the redacted vault address and explorer link; the dedicated `Your Vaipakam Vault` page is the canonical surface for vault address, asset balances, deposits, withdrawals, dust filtering, and protocol-tracked balance display
- Dashboard's `Your Loans` table should prefer a single bundled read that returns all rows for the connected wallet already tagged by lender / borrower side, so the table first-paints as one complete payload rather than stair-stepping through one call per loan
- Dashboard copy that summarizes lender versus borrower exposure should describe the side where the connected user has more capital, not always frame the headline as lender stake
- Dashboard's active-loans section should expose a manual refresh action for connected wallets that refreshes indexed loans, wallet loan rows, claimability hints, and the user's offers together, while showing shared adaptive rescan cooldown chrome
- Dashboard, Offer Book, Activity, Claim Center, and Vaipakam Vault surfaces should share one refresh / rescan button component and one data-sync chip instead of per-page copy and state machines; the chip should say `Synced` when page data has reached the chain safe head within the accepted gap and `N blocks behind` when the page is still catching up
- public Analytics should not expose a spam-clickable manual refresh button; it should auto-refresh from the shared watermark / indexer signals and show only the data-sync chip
- the top-bar freshness badge should answer whether the current page data is live by comparing the chain safe head with the freshest block reached by either the central indexer or the page's own RPC tail scan, and it should distinguish `Live`, `Live updating`, `Catching up`, `Behind`, direct-RPC fallback, and local-dev states
- the freshness popover should stay user-facing and compact, while the issue / diagnostics drawer should carry the operator breakdown by mounted data lane, including indexer frontier, RPC tail-scan frontier, fetch-in-progress state, and the live-polled chain safe head
- `Offer Book` should be wallet-gated inside `/app`; after connection it should keep market browsing filterable by side, asset, status, liquidity, duration, and per-side count; market-rate annotations should use a filter-scoped recent-acceptance anchor with signed deltas and a mobile-friendly explanatory tooltip
- `Offer Book` should include the market-rate shortcut widget once the user has selected a borrowing pair. The widget should accept a lending amount, estimate minimum collateral from live protocol risk parameters with a small safety buffer, show the current market-rate anchor when one exists, and route `Lend at market rate` / `Borrow at market rate` actions into `Create Offer` with pre-filled fields. It must never submit an offer directly or disable the deep link merely because collateral, price, or rate information is unavailable; in thin or unsupported markets it should deep-link with unset fields and let Create Offer show the caution banner.
- `Offer Book` status tabs should avoid row-count promises that require validating every offer on-chain; scalable scanned / hidden summaries are preferred over tab counts that would force full-market multicalls
- closed / filled offer rows should link to the loan they created when an `OfferAccepted(offerId, acceptor, loanId)` event is available
- `Offer Book` and Dashboard offer tables should link offer IDs to `/app/offers/:offerId`; Activity, Loan Details, borrower preclose, refinance, and NFT Verifier surfaces should use the same offer-detail deep link wherever they render a concrete offer ID
- `/app/offers/:offerId` should mirror Loan Details' read discipline: indexer-first offer lookup, single direct `getOffer` fallback only when the worker is unavailable, creation transaction lookup from the indexed first-seen block, status/type/asset/rate/duration/creator display, contextual creator-only actions, and a `View loan #N` link for accepted offers
- offer-detail external links such as position NFTs, principal / collateral assets, first-seen block, and creation transaction should use consistent link styling, tooltips, and new-tab affordances where appropriate
- `Create Offer` should disable submit until full form validation passes, with typed validator error codes mapped through i18n, and should show token-identification trust blocks under address fields so users can distinguish canonical assets from unknown or suspicious contracts
- in Advanced mode, `Create Offer` should show an ERC-20 / ERC-20 risk-preview card that computes projected Health Factor, LTV, and liquidation-price cushion from live oracle and risk parameters; for Range Orders it should show both best-case and worst-case values and warn clearly when the worst-case Health Factor falls below the initiation floor
- Create Offer and Offer Book accept-review should show a cross-chain thin-liquidity notice when the selected collateral is thin on the active chain but appears deeper on another supported chain. This notice is informational only; it must not redirect the user or override the active-chain oracle / liquidity decision.
- when depth-tiered LTV is enabled, Create Offer and accept-review risk previews should show the collateral's on-chain tier, effective tier after the keeper confidence floor, applicable tier max-init-LTV, whether that value came from a fresh peer-derived cache or a library fallback default, cache age, and whether the requested principal exceeds the active tier cap. While the master switch is disabled, the UI should continue to present the existing conservative LTV / Health Factor rules and may show tier data only as non-binding diagnostics.
- the primary Create Offer duration control should be a bucketed picker using the standard buckets `7 / 14 / 30 / 60 / 90 / 180 / 365 days`, defaulting to `30 days`; defensive validation should still reject out-of-range or non-bucket values if the form is hydrated from an external source
- Range Orders controls should appear only when the corresponding live protocol flags are enabled. Basic mode should keep the existing single amount / single rate flow; Advanced mode may expose min / max amount and min / max rate inputs, approve or Permit2-sign the upper amount bound, and show live balance warnings before submission.
- Periodic-interest cadence controls should appear only when `periodicInterestEnabled` is true, the user is in Advanced mode, both lending and collateral legs are liquid ERC-20s, and the principal value satisfies the configured finer-cadence threshold where required. When those requirements are not met, the cadence section should be absent rather than shown as a disabled dropdown.
- The cadence dropdown should support `None`, `Monthly`, `Quarterly`, `Semi-annual`, and `Annual`; loans longer than one year should surface the mandatory annual-minimum rule when applicable. Offer acceptance should show a prominent cadence callout explaining the missed-checkpoint consequence before the user submits.
- `Loan Details` should be wallet-gated inside `/app`; after connection it should show the live loan state, role-gated actions, a chronological on-chain timeline, claimable-state action bar, and precise event breakdowns for settlement splits, fallback collateral allocations, partial repayments, swap retries, and VPFI rebates
- `Loan Details` should show a periodic-interest checkpoint card for cadence-bearing loans, including cadence label, next checkpoint countdown, expected interest, interest paid this period, shortfall, and whether the period is covered, pending, or past grace. Borrowers with a shortfall should get a `Pay now` action that routes to the partial-repay surface.
- `Activity` rows that reference a loan should use a clickable `Loan #X` pill linking to that loan's full details page
- `Claim Center` is the home for loan claims and platform-interaction rewards; the former standalone in-app `Rewards` page should not be treated as a live route
- public `/buy-vpfi` is the marketing / education surface for VPFI; connected `/app/buy-vpfi` is the wallet-gated home for buying, staking / depositing, unstaking / withdrawing, staking-rewards claims, and chain-level VPFI transparency
- user-facing connected-app copy should call the personal escrow experience `Vaipakam Vaults` generally and `Your Vaipakam Vault` for the connected user's own balance surfaces. Solidity / TypeScript identifiers, code-fenced names, diagnostics, and existing route paths may continue to use `escrow`.
- the existing `/app/escrow` route may remain stable, but its visible sidebar / page label should be `Your Vaipakam Vault`
- Asset Viewer and vault balance surfaces should display the protocol-managed balance clamp `min(raw token balance, protocol-tracked balance)` so unsolicited direct transfers are hidden from ordinary balance, staking, and discount views
- Vault token discovery should be history-driven rather than based on a hardcoded deployment-token list: wallet-related indexed loans and offers should provide the ERC-20 token set, while live `balanceOf` and `protocolTrackedEscrowBalance` reads remain direct RPC checks for each discovered token
- Vault balance rows with a clamped balance of zero should be hidden; tiny display dust below `1e-11` token units may be hidden behind a user toggle that defaults on, with header copy showing how many rows are hidden and low-decimal tokens exempted where the threshold would hide meaningful stablecoin units
- Vault rows should show token icons when available, fall back without layout jitter when unavailable, and use the shared asset-link behavior so token symbols open CoinGecko when indexed or the active chain explorer otherwise
- in the connected-app sidebar, `Claim Center` should sit with the core lending actions before `Buy VPFI`, while token-purchase and advanced utility destinations remain secondary to loan management
- the in-app logo should route to `/app` so connected users return to the dashboard shell; the public navbar logo should continue to route to `/`
- the app's issue drawer should be labelled as `Report Issue` / `Issue Details`, not `Diagnostics`, and should generate a redacted report suitable for GitHub issue filing
- the issue drawer should use one scroll region below its fixed header so expanded chain / indexer details do not crush or hide the journey log; localized labels and long URLs must wrap cleanly on phone-width drawers
- bridged `Buy VPFI` quote failures should be written into the in-memory journey log with enough chain, adapter, and decoded-error context for the issue drawer to produce an actionable support report, rather than leaving the failure only as inline page state
- the connected app should have a route-level render error boundary that turns crashes into a recoverable card with `Reload page` and `Back to Dashboard`, records a redacted app-crash entry in the journey log, and decodes common minified React error codes into plain-language support context where possible
- shared tooltip / info-tip components must keep their layout-measurement effects identity-stable so parent rerenders cannot trigger infinite remeasure loops. If an app route crashes anyway, the error boundary should keep the rest of the shell usable and include the decoded React error and component stack in the issue report payload.

Transaction-safety and single-signature flows:

- review modals for Offer Book accept, Create Offer submit, Repay, and Add Collateral should support the Permit2-first pattern where the action uses Uniswap Permit2 when possible and falls back to the classic approve-plus-action path when Permit2 is unavailable or unsupported
- Permit2 should be presented as a convenience that reduces wallet popups for supported ERC-20 actions, not as a requirement to use Vaipakam
- Permit signatures should use the canonical Permit2 deployment at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, expire after 30 minutes, and include clear review copy so users understand the asset and amount being authorized
- before the final confirmation on supported review modals, the app should show a transaction preview panel backed by the server-side Blockaid proxy when available
- the transaction preview panel should distinguish benign previews, warnings, malicious classifications, and preview-unavailable states with clear severity styling
- Blockaid unavailability must fail soft: it may collapse to a subtle preview-unavailable state, but it must not block the on-chain transaction path by itself
- API keys for transaction scanning and swap quotes must stay server-side; the browser should call only worker-internal proxy routes
- review modals should continue to treat the wallet transaction and smart contract call as the source of truth; scanner output is informational safety context

Wallet connection UX:

- ConnectKit remains the wallet picker, but mobile wallet choices should prefer working deep-link paths rather than QR-only flows when the user is already on a phone browser
- the MetaMask featured wallet path should work on mobile through MetaMask SDK / equivalent mobile-aware connector behavior while preserving direct extension connection on desktop
- Coinbase Wallet should follow the standard connector path unless mainnet testing proves the SDK flow cannot approve reliably, in which case the documented WalletConnect fallback path may be restored
- WalletConnect metadata should include redirect information so mobile wallets can return users to the dApp after approval where supported
- touch devices should show a persistent wallet-connecting banner during wallet picker and deep-link flows: first prompting the user to select a wallet, then indicating that approval is still in progress after the tab backgrounds, and hiding cleanly when the user closes the picker without deep-linking

Liquidation quote orchestration:

- Loan Details should show a `Liquidate` action for active loans with on-chain Health Factor below `1.0`
- liquidation review should quote available routes in parallel across 0x, 1inch, Uniswap V3, and Balancer V2 where configured
- liquidation review should fetch full-size and half-size route quotes when available. When partial liquidation is eligible, the route planner should also fetch an exact-size quote for the computed optimal partial fraction because adapter calldata must encode the precise sell amount. The exact partial quote should be requested only for active, in-term loans in the mildly distressed band where the computed fraction is within live bounds.
- 0x and 1inch quote requests should go through Cloudflare Worker proxy routes so operator API keys are injected server-side and never ship to the browser
- Uniswap V3 quotes may use direct on-chain quote reads across supported fee tiers
- Balancer V2 quotes may use a configured per-chain subgraph URL to find a deep eligible pool and estimate output for route ranking
- successful quotes should be sorted by expected output, with the best route and fallback order shown before the user submits liquidation
- when two half-size quotes from different aggregators together beat the best full-size single route by at least the live configured split-route improvement threshold, the route planner may choose split-route liquidation and show the two legs as one atomic transaction. If the improvement is below the threshold, the planner should prefer the existing single-route try-list to avoid unnecessary gas overhead.
- when an active in-term loan is in the configurable mildly distressed Health Factor band, the planner may prefer partial liquidation and show the computed fraction, expected principal reduction, post-call Health Factor target, fee / slippage assumptions, and non-terminal loan outcome before submission. If the risk-profile read fails, the planner may fall back to the legacy fixed-fraction path where still safe; if the loan is past maturity, if the computed fraction is outside bounds, if the selected fraction would not restore Health Factor to at least `1.0`, or if the fraction would close all remaining principal, the partial path should be hidden and full liquidation should remain the visible route.
- partial-liquidation review must make clear that there is no soft fallback: if the supplied route fails or the post-call Health Factor gate is not met, the transaction reverts and the loan remains unchanged.
- liquidation fallback copy should distinguish the ordinary fresh-oracle fair-value collateral split from the oracle-unavailable fallback where stale or unavailable quorum pricing causes the full collateral to settle to the lender, matching the illiquid-collateral branch. Loan timelines and issue reports should surface the dedicated oracle-unavailable fallback event when present.
- if one quote source is unavailable, the UI should still submit a ranked try-list from the remaining sources where possible
- the quote-proxy routes should use per-upstream rate limits, such as separate 0x and 1inch per-IP budgets, so one upstream cannot exhaust the other
- quote services that target keeper / liquidation swap adapters must carry both the approved swap-call destination and calldata, because venues such as 0x separate the ERC-20 allowance target from the rotating execution target
- frontend, worker, and reference-bot quote packers should validate destination addresses from 0x / 1inch responses and share one wire format for adapter calls so a malformed quote cannot become a half-formed liquidation transaction

Keeper-bot reference UX / ops requirements:

- Vaipakam should support a standalone public keeper-bot reference implementation for third-party liquidators once mainnet selectors are stable
- the bot should mirror the frontend / worker liquidation route orchestration: list active loans, read Health Factor and `getAssetRiskProfile`, compute the smallest feasible partial-liquidation fraction where eligible, quote 0x / 1inch / UniV3 / Balancer V2 for the relevant full, half, and exact partial sizes, rank routes, choose among optimal partial liquidation, split-route liquidation, and single-route failover according to live config, and submit the appropriate liquidation entry point
- the bot may also include a Range Orders matcher detector: page active offers, bucket compatible lender / borrower candidates, call match preview, submit `matchOffers` for valid pairs, respect per-tick preview / submit caps, and keep polling quietly while the partial-fill master flag is off
- the production `apps/keeper` worker may run matching as a scheduled third pass alongside liquidation watching and daily oracle snapshots. The UI and public docs should describe it as a protocol-operated convenience keeper, not as the only valid matcher; community matchers remain allowed whenever the on-chain matching flag is enabled.
- the keeper liquidity-confidence relay should expose enough read-only state for app diagnostics to show when an asset's effective depth tier is being held below its on-chain tier. Promotional checks may include sustained aggregator health and whether the asset is battle-tested as collateral with meaningful supply on Aave, Compound, or Morpho on that chain, but these external venues must remain advisory rather than direct parameter sources.
- keeper and operator surfaces should show tier-LTV cache freshness, peer-derived values, fallback defaults, refresh rejection reasons, and whether the cache has passed the stale-warning threshold so humans can refresh before loan initiation falls back to defaults.
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
- the UI should then guide and facilitate a separate explicit user-intent action to move or deposit that wallet-held VPFI into the user's Vaipakam Vault for staking / discount eligibility
- staking should be messaged as open to any VPFI holder, not only borrowers or users with an existing loan; first deposit should make clear that the user's Vaipakam Vault can be created automatically
- the public marketing page should explain that VPFI can be bought, deposited / staked, and withdrawn / unstaked; the actual app controls should label the vault action as `Deposit / Stake VPFI` and the reverse action as `Withdraw / Unstake VPFI`
- the `Deposit / Stake` card should contain the canonical open-staking explanation in one user-friendly Info callout; duplicate page-level or step-subtitle copies should be avoided
- the VPFI discount-status table belongs on `/app/buy-vpfi` near the purchase / deposit decision, while the shared fee-discount consent toggle remains on `Dashboard`
- the discount-status table should render only for connected wallets and should link users back to `Dashboard` when consent is disabled
- the Phase 1 `30,000 VPFI` user cap is a per-chain cap, not a protocol-wide global cap across all chains
- VPFI deposited / staked in the user's Vaipakam Vault on one chain should count only toward fee-discount tiers for loans initiated on that same chain
- the UI should expose a single common platform-level user setting for consenting to the use of Vault-held VPFI for fee discounts
- that shared fee-discount consent control should live inside the connected app and be shown on `Dashboard`
- the consent control should not be treated as a `Buy VPFI`-page-only setting
- offer-level or loan-level consent toggles are not required for VPFI fee discounts once that common platform-level setting is enabled
- the connected app should show the user's Vault-held VPFI balance, the implied discount tier, and the fact that Vault-held VPFI also counts as staked for the `5% APR` staking model
- on `/app/buy-vpfi`, the `Your VPFI discount status` area should provide a chain selector rather than only showing the currently inferred chain name in the title / balance label
- that chain selector should let the user inspect chain-specific Vault-held VPFI, discount-tier status, and discount eligibility because those values are local to the selected lending chain
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
- periodic-interest checkpoint reminders should reuse the loan-alert rail. Borrower reminders are priority notifications, lender reminders are courtesy notifications, and the lead time should come from the live `preNotifyDays` governance setting shared with maturity reminders.
- the Push rail should disclose the current flat notification fee in the active protocol numeraire, explain that Telegram remains free, and make clear that the VPFI fee is deducted from the user's Vaipakam Vault only on the first paid Push notification per loan side
- the UI should warn when the user's Vault-held VPFI balance appears insufficient for the notification fee, while the on-chain billing path remains authoritative

Reward-claiming UX:

- Vaipakam should provide a simple and consistent reward-claiming experience across all supported chains
- users should be able to claim two reward types directly on the chain where they are actively lending, borrowing, or renting NFTs:
  - `Staking Rewards` earned automatically when VPFI is held in the user's Vaipakam Vault
  - `Platform Interaction Rewards` earned from lending and borrowing activity using the tiered and time-weighted logic defined in `docs/TokenomicsTechSpec.md`
- rewards should be calculated and minted locally on the user's currently connected chain
- no cross-chain messaging or mandatory network switching should be required during the claim flow itself
- the user's protocol-tracked Vault-held VPFI balance on that chain should be treated as the staked balance for reward purposes
- if the user wants to move claimed VPFI elsewhere afterward, bridging should remain optional
- reward surfaces should be split by user intent rather than combined into one `Rewards` page:
  - `Staking Rewards` should be claimed from `/app/buy-vpfi`'s `Deposit / Stake` card, with a compact mirror on Dashboard discount status
  - `Platform Interaction Rewards` should be claimed from Claim Center above the per-loan claim rows
- Dashboard should include a combined `Your VPFI rewards` summary for connected wallets, showing total earned across staking and interaction rewards, per-stream pending / claimed amounts, and deep links to the canonical claim cards
- the combined rewards summary should render even when all values are zero so new users can discover how the rewards programs work
- the old `/app/rewards` route and sidebar entry should remain retired unless a later approved design reintroduces a combined rewards hub
- staking-rewards cards should show pending VPFI, lifetime claimed VPFI reconstructed from `StakingRewardsClaimed` events, and neutral chrome when pending is zero
- interaction-rewards cards should show pending VPFI, lifetime claimed VPFI reconstructed from `InteractionRewardsClaimed` events, and an expandable `Contributing loans` list
- contributing-loan rows should link to Loan Details and describe the user's numeraire-denominated participation contribution, not pretend that a precise per-loan VPFI amount exists
- when a global interaction-reward denominator has not yet been broadcast to the local chain, the Claim Center should show a waiting state for that day rather than offering a transaction that would revert
- after a successful claim, the UI should:
  - show a success state with the exact amount claimed
  - refresh wallet balance and Vaipakam Vault balance in real time
  - offer an optional one-click `Bridge to another chain` action through the official LayerZero bridge flow if the user wants to move claimed VPFI, including a direct link to `https://layerzero.superbridge.app/` when appropriate
- if the user has no pending rewards on the current chain, the `Claim Rewards` action should be disabled or hidden with a helpful message such as `No rewards available to claim on this chain`
- if the user recently changed Vaipakam Vault balance through deposit, withdrawal, or fee deduction, reward displays must still calculate correctly up to the current block
- if the user switches chains, the active reward surfaces should refresh and show rewards specific to the newly connected chain
- if the network is unsupported or the wallet is not connected, the UI should clearly explain that rewards can only be claimed on supported lending chains
- reward data should be fetched from the Diamond on the currently connected chain using the existing hooks and helpers where appropriate
- the shared fee-discount consent flag is separate from reward claiming and must not gate reward visibility or reward-claim actions

Sanctions-screening UX:

- when the active chain has a sanctions oracle configured, the app should show sanctions banners only for a connected wallet or relevant counterparty that actually matches the oracle
- the banner should explain in plain language that new positions, deposits, VPFI fund-flow actions, liquidator rewards, and recipient claims are blocked for the flagged wallet, while debt close-out paths remain available where needed to protect an unflagged counterparty
- the banner should appear on action-heavy app surfaces where the user can be affected, including Dashboard, Create Offer, Offer Book, Buy VPFI, Loan Details, and Claim Center
- clean wallets should not see persistent sanctions education banners; the public Terms prohibited-use clause remains the general policy surface

Stuck-token recovery UX:

- `/app/recover` is an advanced, wallet-gated utility route for unsolicited ERC-20 tokens sent directly to a user's Vaipakam Vault
- the route should not appear in the main nav, footer, Dashboard shortcuts, Asset Viewer actions, or basic user guide; the Advanced User Guide may deep-link to it for users who already understand the risk
- the page should emit `noindex,nofollow` metadata and should not be promoted as a normal portfolio-management surface
- the form should ask for token address, declared source address, and amount; the recoverable maximum is `max(0, raw vault balance - protocol-tracked balance)` for the selected token
- the UI should clearly state that the declared source must be the wallet or contract the user believes sent the unsolicited tokens and that recovery is sent only to the connected user's own EOA
- before signing, the user must pass a deliberate confirmation modal that includes the standing warning and requires typing `CONFIRM`
- the wallet signature should use the on-chain recovery domain / nonce / acknowledgement reads (`recoveryDomainSeparator`, `recoveryNonce(user)`, and `recoveryAckTextHash`) so the app signs the same EIP-712 statement the contract verifies
- receipt parsing should distinguish `StuckERC20Recovered` from `EscrowBannedFromRecoveryAttempt`; a ban outcome is a completed transaction with a blocked recovery, not a generic failed receipt
- if sanctions-oracle checks are unavailable or revert, the app should surface a fail-safe blocked state and avoid retry loops that imply the user can bypass the check
- `disown(token)` may be offered only as an advanced declaration that emits an event; the UI must not imply that it moves tokens or changes accounting
- Asset Viewer may show that unsolicited balance exists through a restrained hint, but it should not expose a direct recovery button inline

Activity and local log-index requirements:

- the frontend log index should be the common source for Activity, Loan Details timelines, reward lifetime totals, filled-offer links, cancelled-offer reconstruction, staking / interaction claim history, and Range Orders match / close events
- cache-reader migrations may reconstruct newly derived fields from already-cached events on hydrate when the old cache captured the necessary event data
- adding brand-new event topics to the `getLogs` allow-list should bump the cache key so historical events are captured once through a deliberate rescan
- user-facing success states for writes must be driven by successful transaction receipts, not merely by inclusion in a block; reverted receipts should propagate as errors across shared Diamond and ERC-20 helpers

Unstaking VPFI:

- because VPFI held in the user's Vaipakam Vault is automatically treated as staked, users should be able to unstake by moving VPFI from the Vault back to their wallet on the same chain
- the UI should provide a clear and prominent `Withdraw / Unstake VPFI` action on `/app/buy-vpfi`
- the unstake action should show the user's current Vault-held VPFI balance and the maximum amount available to unstake
- when the user selects `Unstake VPFI`, the UI should:
  - show a simple amount-entry form
  - include a `Max` shortcut prefilled with the full Vaipakam Vault balance
  - show a confirmation step with:
    - amount being unstaked
    - impact on the current discount tier
    - impact on future `5% APR` staking rewards
- after confirmation, the VPFI should move from the user's Vaipakam Vault to their wallet on the same chain
- after a successful unstake, the UI should refresh Vaipakam Vault balance, wallet balance, reward estimates, and discount tier in real time
- unstaking should be treated as instant with no lock-up period
- users should still be allowed to unstake while they have active loans, but the UI must clearly warn them about the immediate reduction in discount tier and staking rewards
- if the user has enabled the shared `Use VPFI for fee discount` consent flag, the UI should warn that unstaking may reduce or disable future fee discounts
- after unstaking, the UI may offer the standard LayerZero bridge flow if the user wants to move that VPFI to another chain, including a direct link to `https://layerzero.superbridge.app/`
- if the user has zero VPFI in escrow, the unstake action should be hidden or disabled with a helpful message
- if active loans currently rely on Vault-held VPFI for fee-discount eligibility, the unstake flow should show a clear warning before confirmation
- if the user switches chains, `/app/buy-vpfi` should refresh and show the Vaipakam Vault balance, staking rewards, and unstake availability for the newly connected chain
- unstaking should be implemented as a local chain action only; no cross-chain messaging should be required for the unstake itself

Connected-app network model in Phase 1:

- the Vaipakam core protocol is intended to run as a separate Diamond on each supported network; current public testnet deployments may exist on Base Sepolia and Sepolia while mainnet deployments remain gated by the production rollout process
- supported Phase 1 networks are `Base`, `Polygon`, `Arbitrum`, `Optimism`, and `Ethereum mainnet`
- `VPFI` is cross-chain, and the interaction-reward denominator / reward-funding path also uses cross-chain messaging so each chain can claim against one protocol-wide daily interest total; loans, offers, collateral, repayment, liquidation, preclose, refinance, and keeper actions still stay on the currently selected network
- the app should make the active network clear and treat each network as its own local protocol instance with a dedicated Diamond deployment per network
- the connected topbar / wallet menu should show both chain icon and chain name after connection, collapsing to icon-only only on very narrow viewports while preserving the accessible chain name
- in-app pages should not mount a standalone pre-connect chain picker; read-only pre-connect chain exploration belongs on public Analytics, while wallet-gated app pages should take chain context from the connected wallet
- the connected-app top bar should show one shared indexer status badge for cached / live-read state rather than duplicating badges in individual page headers
- the indexer badge should be a compact single-signal data-freshness pill based on block-space: the gap between the freshest data block known to the page and the chain's current safe head
- freshness should combine the worker indexer frontier and the browser's direct RPC tail-scan frontier. The badge should show green `Live` only when the safe-head gap is below 100 blocks and no registered data source is actively fetching.
- badge states should distinguish `Live`, `Live updating`, `Loading`, `Catching up`, `Behind`, live direct-RPC fallback, live chain-scan fallback, and local-dev mode when the wallet is on Anvil / Hardhat
- the badge should avoid stale `minutes ago` framing as the primary health signal because block gap captures both chain progress and watcher liveness more directly
- the badge's info action should open a concise inline popover anchored to the badge, not the full diagnostics drawer; the popover should show the state pill, chain, last safe block indexed, freshest data block, live chain safe head, blocks-to-catch-up, fetch-in-progress status, data source, and a short safe-block footnote, and it should close on click-outside or Escape
- the live chain safe-head probe should run at a short bounded cadence only while the badge popover is open, so merely mounting the top bar does not create a continuous RPC poll
- the Issue Details / diagnostics drawer should include a collapsible `Chain & Indexer` panel; its collapsed header should preserve the state pill, while the expanded table should show chain id, last indexed safe block, freshest data block, live chain safe head, blocks-to-catch-up, next index fetch countdown, fetch-in-progress status, cursor last-advance timestamp, data source, indexer endpoint, browser storage usage, frontend build identifier, and a short explanation of safe blocks
- the diagnostics panel may use the same live safe-head probe as the badge popover only while the panel is expanded
- the Chain & Indexer panel should default collapsed when the drawer is opened from the floating issue button so failure events remain the first visible support context; the expand/collapse control should expose ARIA expanded / controls semantics
- labels should use `Last safe block (indexed)`, `Freshest data block`, and `Chain safe head` so operators can distinguish watcher D1 progress, direct-RPC tail coverage, and the live safe head separately
- `Fetch in progress` should summarize whether registered hooks are still loading. It should not imply that money-moving actions are safe without direct contract reads.
- `Next index fetch in` should count down to the next `/offers/stats` / indexer-cursor fetch and reset from observed indexer updates rather than a guessed timer
- advanced-mode users may get a deliberate `Purge browser-side state` control in that diagnostics panel; it must require confirmation and should clear IndexedDB, localStorage, and sessionStorage for the current origin so stale decode/cache states can be reset after redeploys
- frontend builds should expose a build hash and build timestamp in the diagnostics panel when available, falling back gracefully when git metadata is unavailable
- manual force-refresh controls belong only on pages where the user is inspecting mutable lists, including OfferBook, Activity, Dashboard, and Your Vaipakam Vault
- those page-level refresh controls should share one adaptive cooldown state machine: a 30-second baseline, exponential growth for repeated clicks up to a 5-minute cap, reset after a quiet period, a draining right-to-left progress bar, stable-width countdown digits, and `Syncing` / `Synced` / idle status states
- app refresh probes should use named watermark tiers rather than scattered interval literals: OfferBook `hot` at 5 seconds active with idle backoff, Dashboard / Vault / Offer Details / Activity / badge diagnostics `warm` at 30 seconds active, and Analytics `cool` at 180 seconds active; all tiers pause while the tab is hidden and resume with an immediate catch-up probe on focus
- watermark / indexer-freshness probes should be coordinated through one app-level provider per `(chainId, diamondAddress)` rather than one timer per hook or component. Multiple subscribers may request different tiers, but the provider should run the fastest active tier and fan out one shared snapshot so Dashboard and OfferBook do not create drifting waves of duplicate RPC reads.
- when the shared watermark sees a cold chain with both global counters at zero, it should stretch to a 30-second cadence even if a hot subscriber is mounted, then wake the active pages within that bounded window after the first offer or loan appears
- hooks that know their data frontier or loading state should register with the shared data-freshness context. Offer stats report the indexer frontier, indexed offer / loan lists report the direct-RPC tail-scan frontier, and wallet-scoped hooks that only know they are loading may report loading-only status.
- browser-side log cursors and worker-side D1 cursors should advance only to a safe block (`safe` block tag, or `latest - 32` fallback) so cached rows cannot be stranded by reorgs
- frontend caches for app data must include the active `chainId` and relevant account / filter inputs in their keys, so switching chains naturally misses the previous chain's cache and refetches without requiring a manual refresh
- hooks that read the Diamond should use a shared ready-Diamond helper and short-circuit when the active chain has no deployed Diamond, rather than issuing `readContract` or multicall requests against `ZERO_ADDRESS`
- Diamond reads must use an app-chain-pinned public client derived from the app-selected chain, not bare wallet-chain `usePublicClient()` calls. The Diamond address and RPC client must switch together when the app chain changes; cross-chain tools that intentionally accept an explicit chain id should document that exception.
- when the worker indexer returns an empty active-offer or user-loan page but the browser log index has already observed matching on-chain events, the UI should treat the indexer result as stale and fall through to the direct log / chain fallback instead of presenting an empty market or empty dashboard
- manual refresh should remain an acceleration control, not a correctness requirement after chain switches, stale-indexer gaps, or wallet reconnects

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
- ConnectKit's a major DeFi protocol-account connector / `Continue with a major DeFi protocol` default should be explicitly disabled unless Vaipakam intentionally adopts that branded smart-wallet entry point later

Safe-app embed requirements:

- Vaipakam should be loadable as a Safe app inside the Safe multisig UI
- the app should auto-detect the Safe iframe context and auto-connect through the Safe postMessage handshake without showing a wallet prompt
- when connected in Safe context, the connected wallet should be the Safe itself
- outside a Safe context, the Safe connector should behave as a no-op and the normal browser wallet flow should be unaffected
- Content-Security-Policy headers must explicitly allow Safe's dapp-browser origins as frame ancestors
- the Safe connector should trust only Safe-owned origins for iframe handshake behavior

Governance-configuration visibility:

- loan-screen surfaces should reflect live on-chain governance parameters where those parameters affect the user-facing position
- `/admin` should include a loan-default grace schedule control in the Risk category. Public / non-admin viewers may see the read-only schedule, while admin-wallet viewers can edit the six rows inline and propose the resulting `setGraceBuckets` transaction to Safe.
- the grace-schedule admin UI should display per-slot duration and grace bounds next to inputs, validate before proposal, and show a clear badge when compile-time defaults are in force because no custom schedule is stored
- `/admin` should include a `Periodic Interest Payment` / numeraire configuration category with cards for `periodicInterestEnabled`, `numeraireSwapEnabled`, `numeraireSymbol`, `ethNumeraireFeed`, PAD settings (`predominantDenominator`, `predominantDenominatorSymbol`, `ethPadFeed`, `padNumeraireRateFeed`), `minPrincipalForFinerCadence`, `notificationFee`, KYC thresholds where that surface is active, and `preNotifyDays`. Admin actions should compose Safe transactions; non-admin viewers may inspect the current values.
- the principal-threshold, notification-fee, KYC-threshold, and feed-side cards should display the active numeraire and safe range. A numeraire rotation should be presented as one atomic `setNumeraire(ethNumeraireFeed, numeraireChainlinkDenominator, numeraireSymbol, pythCrossCheckFeedId, minPrincipalForFinerCadence, notificationFee, kycTier0Threshold, kycTier1Threshold)` proposal rather than as independent feed / symbol / threshold / fee edits.
- `/admin` should include a depth-tiered-LTV risk section with read-only tier cache values, cache ages, peer-address status, reference-asset coverage, and refresh rejection reasons for every connected wallet. Admin viewers may compose Safe transactions for `setTierLtvParams`, `setPeerProtocolAddresses`, and the master `setDepthTieredLtvEnabled` switch, while the permissionless `refreshTierLtvCache` action should remain available to any wallet with clear gas-cost copy.
- the tier-parameter editor must update all three `(floor, ceiling, haircut)` triples atomically, validate no overlap and bounded haircut before proposal, and display whether library defaults are currently driving the cache because no storage override or fresh peer-derived value exists.
- each loan-detail page should include a `Lender Discount` card for the current lender when lender discount data is relevant
- the `Lender Discount` card should show the effective time-weighted VPFI discount computed from the current open-loan window and the on-chain discount curve
- this effective discount may be computed client-side by extrapolating the open-loan window against on-chain discount-curve data
- the frontend should expose a shared hook for reading the protocol fallback-split configuration
- fallback-split data should be available as lender / borrower split values so pages can read it without custom one-off contract calls
- user-facing constants, thresholds, and percentages should flow from live protocol config reads rather than hardcoded locale strings where they can change through governance or redeploy
- `useProtocolConfig` should read both mutable config and compile-time constants exposed by the Diamond, and reusable info components should inject common placeholders such as treasury fee, LIF, staking APR, tier thresholds, max slippage, and min Health Factor into translated tooltip copy
- tier tables, rental-buffer math, autonomous tier-LTV safety boxes, cache freshness labels, and validation copy should derive from live config where possible, so governance changes or peer-derived cache refreshes appear on next page load without a frontend redeploy
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
- theme preference should sync across Vaipakam subdomains through a parent-domain functionality cookie, falling back to the user's OS preference until they choose explicitly
- language preference should sync across Vaipakam subdomains through a parent-domain functionality cookie, with that cookie treated as the cross-domain source of truth over origin-scoped localStorage when the two disagree
- first-visit language detection should write the shared language cookie during initialization so the connected app and marketing site start from the same locale
- the React i18n binding should re-render when a lazy-loaded locale bundle is added, so the first language-picker click visibly changes language after the dynamic import resolves
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
- public-read connected-app shells such as Analytics, NFT Verifier, and Protocol Console should keep their top bar focused on in-app navigation. They should not mirror the marketing site's `Learn` dropdown; a single `Docs` link back to the public overview / whitepaper index is sufficient.
- same-origin connected-app CTAs should navigate in the current tab, while marketing-to-app cross-origin CTAs may open a new tab where that is the clearer user expectation
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
- per-offer keeper toggles should live on `/app/offers/:offerId` for the offer creator while the offer is still active, using the position-level setter and explaining that user-level keeper opt-in and whitelist gates must also be active
- per-loan keeper toggles should live on Loan Details for each current Vaipakam NFT holder's own side of the loan, using the loan-level setter and showing an empty-state link to Keeper Settings when no keeper addresses are whitelisted
- offer-list rows should not carry a separate `Manage keepers` shortcut once the detail page exposes the per-offer controls; list rows should direct users into the relevant offer detail when position-specific management is needed
- keeper surfaces should warn when the global master switch is off, because per-offer or per-loan toggles alone do not authorize execution
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
- `Total Value Locked (TVL)` in the active numeraire, including visible `24h` and `7d` change percentages
- TVL breakdown covering ERC-20 collateral, NFT collateral, and escrow balances where meaningful
- active loans, shown as both count and total value
- currently active offers and lifetime offer totals at the combined all-chains level in the global header
- total volume lent in the active numeraire, lifetime
- total interest earned by lenders in the active numeraire, lifetime
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
- when selected-chain dashboard sections need large loan or offer sets, the implementation should prefer worker-indexed aggregate endpoints first and reserve batching / multicall aggregation as an outage fallback
- derive historical series from worker-bucketed event data when available, with raw event logs or chain-side multicalls kept as fallback paths
- a shared Cloudflare Worker indexer may maintain D1-backed `offers`, `loans`, and append-only `activity_events` tables for fast first paint across offers, loans, activity, and claimability hints
- the worker indexer should fan out across configured active chains according to the deployment allow-list; inactive or missing deployment artifacts should be skipped, while an active chain missing its RPC secret should be treated as an operator configuration error before deploy completion rather than silently disappearing from the cache
- the worker should perform one shared event scan per chain / tick across the full allow-list instead of separate per-domain scans; per-domain handlers then persist offers, loans, and activity rows from that shared scan output
- a single cursor per chain / Diamond source should advance atomically so offer, loan, claim, and activity views cannot drift onto different indexed block heights
- frontend hooks such as active offers, active loans, wallet loans, activity, claimables, and offer stats should prefer the indexer when available and return an explicit `indexer` / `fallback` source state
- analytics hooks should also be indexer-first: loan stats, recent loans, recent offers, and loan time series should come from worker endpoints when reachable, with `useProtocolStats` and other per-loan multicall walks gated behind a confirmed worker failure
- expected analytics worker endpoints include `/loans/stats`, `/loans/recent`, `/offers/recent`, and `/loans/timeseries?range=24h|7d|30d|90d|All`; BigInt token sums should be kept out of SQLite integer overflow paths and priced client-side over the unique asset set
- analytics fields such as lender interest earned, recent-offer amounts, recent loans, and CSV / JSON exports should be sourced from the same indexer-backed feeds used to render the page during normal operation. The UI must not depend on disabled chain-multicall stats paths for these fields unless the worker has explicitly failed and the page is in fallback mode.
- sync-distance labels should compare against the relevant safe head and indexed frontier for the selected chain, and must not display nonsensical large behind counts when the indexer cursor is actually caught up.
- active-loan and active-offer worker fetches should paginate through the returned cursor rather than reading only the first page; frontend hard caps may bound defensive fetches, but the UI must not silently truncate ordinary active sets at a single default page
- `Offer Book` should consume indexed active offers first, while keeping the existing browser event watcher so newly created global offers appear within seconds according to the existing non-user-customizable sort
- OfferBook's displayed totals and tab badges should come from the same indexed list that renders rows when in indexer mode, and `Showing X of Y` copy should reflect post-filter visible rows with an explicit hidden-by-filters suffix where applicable
- OfferBook's lending-asset plus collateral-asset filter should use a contract-side active-offers-by-asset-pair primitive when both legs are selected; the UI should require explicit values for both legs, seeded from a per-chain default, instead of using an `all assets` sentinel for either side
- the `Hide my offers` setting should default on and persist across navigation / reloads under a Vaipakam-namespaced localStorage key
- dashboard loan lists may consume indexed loan origination data, but current lender / borrower NFT-holder views should be keyed by current position-NFT owner, maintained from ERC-721 `Transfer` events, and verified by direct chain reads on money-relevant screens so transferred loan NFTs are reflected accurately
- Dashboard's `Your Offers` card should be indexer-first through the creator endpoint, paginate rows locally, reset pagination on status-filter changes, and fall back to direct reads only when the worker is unavailable; when reading directly from chain, it should prefer the struct-returning per-user offers getter over an id-list plus per-row detail fan-out
- the dashboard `Your Loans` card and Claim Center should prefer current-holder keyed endpoints so users who received lender / borrower position NFTs through secondary transfer can see the relevant loans and claims without a global walk
- the dashboard `Your Loans` card may render directly from indexed current-holder loan endpoints after the worker has maintained current position-NFT ownership from ERC-721 `Transfer` events; if the worker is unavailable, it should fall back to the on-chain current-holder view and then the browser-index path
- Dashboard `Your Offers` should also support current-holder offer lookup so a wallet that received an open offer position NFT can manage or inspect that position when protocol rules allow
- user-keyed dashboard and analytics views should scale with the connected user's result count by consuming per-user indexes where available rather than walking global active loan / offer sets and filtering client-side
- Claim Center money-relevant claim payloads should continue to read directly from chain; indexed claimability is only a discovery hint
- periodic-interest checkpoint state may be mirrored by the indexer for fast display and reminders, but `previewPeriodicSettle` and transaction review amounts should read the current Diamond state before signing
- VPFI token-panel scans may remain direct filtered log reads while volume stays low
- ERC-721 `Transfer` events for Vaipakam position NFTs should enter the shared `activity_events` ledger so ownership history is queryable without maintaining a separate mutable `nft_positions` table
- frontend live-tail scanning should converge toward one AppLayout-level provider with topic-routed dispatch, page-aware cadence, and cache-invalidation semantics rather than each hook maintaining an independent scanner
- IndexedDB should be the browser cache layer for user-owned offers / loans and top-N global offers, with versioned schemas, eviction rules, and lazy `getOfferDetails` / `getLoanDetails` fallback only on cache misses
- the app footer should expose one active-chain `Verify on-chain` affordance that opens the current Diamond on the relevant explorer; repeated per-row verify links are not required
- the frontend should be capable of an IPFS / static-hosted no-server fallback where critical app reads can go directly to chain RPC when the centralized API / indexer is unreachable; this fallback should use Multicall3 batching, IndexedDB caching, RPC failover, and optional user-supplied RPC URLs where practical
- Durable Objects, WebSocket, SSE, or webhook push are not required for this cache layer while browser event watchers already refresh visible pages after relevant on-chain events. A future push channel may be layered on for lower-latency client updates, but polling / live-tail reads must remain the canonical fallback for disconnects and unsupported clients.
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
- the drawer toolbar should prioritize artifact and support actions in the order `Download`, `Report on GitHub`, then `Clear`; `Clear` should describe emptying the in-memory journey buffer and should not use more destructive `Delete` language
- the drawer should not expose a separate `Copy JSON` action when `Download` already produces a clean support artifact without clipboard-permission edge cases
- the drawer should allow users to filter visible log events by `All`, `Failure`, `Start`, and `Success`, with live counts shown on each filter option
- the default event filter should be `Failure`, because that is the most likely support-relevant subset when the user opens the drawer after something breaks
- event filtering is a display concern only; export, download, or `Report on GitHub` actions should continue to include the full unfiltered event history unless the product later explicitly adds scoped export choices
- generated GitHub issue bodies should use a human-readable summary first and place stack trace, cause chain, browser environment, and recent event details inside expandable sections
- generated GitHub issue bodies should center recent-event context on the most recent failure with a symmetric default window of 5 events before and 5 events after the failure, plus the failure itself; environment variables may override the before / after window, and URL-length fallback may shrink the window symmetrically
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
