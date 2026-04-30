Add ConfigureNFTImageURIs.s.sol script for governance/admin URL rotation

Anvil smoke: verify status-keyed image lookup

Update docs/ReleaseNotes/ReleaseNotes-2026-04-30.md covering all post-Tier-1 work

---

Phase 2 backlog (not in current scope but explicitly listed in the design):

Borrower-side partial fills (multi-position borrower NFT model + 2D allocation)
Ranges on durationDays and collateralAmount
Match-fee economics revisit (the BPS knob we just shipped lets you tune within the current design; a Phase-2 redesign might also gate by VPFI stake or asset-class)
Commit-reveal / private relay if MEV becomes a problem on matchOffers
On-chain SVG (deferred per our earlier discussion)

---

Outstanding planned items (in priority order):

Testnet redeploy of feat/range-orders-phase1 contracts ⏳ user-gated broadcast.

Sepolia, BNB Testnet, Base Sepolia (canonical) — fresh diamonds at new addresses
Sequence: DeployDiamond → DeployTestnetLiquidityMocks → BootstrapAnvil-equivalent enable steps (skipping the chain-31337 guard) → ConfigureNFTImageURIs.s.sol for art rotation → frontend address sync via addresses.json
This is the real unblocker for the 2-week testnet bake the design called out.
ABI re-export to keeper-bot + frontend after the latest contract changes (per CLAUDE.md convention).

bash contracts/script/exportAbis.sh — keeper-bot picks up the new lifMatcherFeeBps-aware shape (no actual selector change for the bot, but the source-stamp + provenance file rotates)
bash contracts/script/exportFrontendAbis.sh — frontend's per-facet JSONs reflect the new ConfigFacet bundle return + setter selector
Risk if skipped: deployed-vs-frontend ABI mismatch produces opaque eth_estimateGas reverts (the failure-mode the script script-doc explicitly warns about).
Anvil smoke for the new lifMatcherFeeBps knob — quick verification that cast send setLifMatcherFeeBps(500) then matchOffers produces a 5x larger matcher kickback. Not strictly necessary (the regression already covers correctness) but a useful end-to-end check.

Frontend admin surface for the new config knob — UI for the existing Config dashboard to render + tune lifMatcherFeeBps. Phase 1 deploys the contract surface; the UI can land later. Skip if you'd rather operate via cast for now.

Bake-end follow-up — design plan says audit AFTER ~2 weeks of testnet bake. Natural future-scheduled item: a calendar agent to surface the audit-kickoff checklist (open offer count, reverted-tx count, matcher-fee actuals, any new bug reports) when the bake window closes.

Phase 2 backlog (not in current scope but explicitly listed in the design):

Borrower-side partial fills (multi-position borrower NFT model + 2D allocation)
Ranges on durationDays and collateralAmount
Match-fee economics revisit (the BPS knob we just shipped lets you tune within the current design; a Phase-2 redesign might also gate by VPFI stake or asset-class)
Commit-reveal / private relay if MEV becomes a problem on matchOffers
On-chain SVG (deferred per our earlier discussion)
My recommended next step: wait for the regression to finish (will fire from the monitor any moment), then do #2 (ABI re-export) since it's a 30-second pure-tooling task that closes a real divergence risk before the testnet redeploy. After that, decide whether you want to do the testnet redeploy yourself or have me prep a runbook script for it.

Want me to proceed with #2 once regression lands, or anything else higher-priority?

---

Read through the ToDo. Here's my recommended order, grouped by what they unblock and how they cluster:

## Tier 1 — audit / mainnet blockers (do BEFORE testnet redeploy)

Contract size limit (#17) — OfferFacet exceeds EIP-170 (27737 > 24576 bytes); we used --disable-code-size-limit to bypass on anvil and forge. Mainnet cannot ship this way — real chains enforce the limit. Fix: split OfferFacet into two facets (e.g., OfferFacet + OfferMatchFacet separating the matching/range surface). 1-2 days. Audit-blocking.
Auto-pause policy (#24) — design + ship before mainnet. My recommendation: extend the existing HF-watcher Cloudflare Worker infra to also watch for anomaly signals (sudden spike in liquidations, treasury balance drain, etc.) and auto-call pause() if not human-resolved in 15min. Not a contract change — a watcher rule. Discuss before implementing.

## Tier 2 — natural follow-ups to Range Orders Phase 1 (high value, while context is fresh)

- Sliders + HF/LTV preview during offer create (#4) — extends the range-input UI we just landed. Use LibRiskMath-equivalent logic in the frontend to render live HF as the user moves the amountMin/amountMax / collateral sliders. Medium effort, ~1 day.
- Auto-show new offers in offer book (#22) — wire a wagmi useWatchContractEvent subscription to OfferCreated and prepend new entries client-side. Half day.

## Tier 3 — operational / deploy plumbing (before testnet redeploy)

- wrangler.jsonc env sync runbook (#20) — needed before fresh testnet diamond addresses go live. I'd suggest a small bash contracts/script/syncFrontendEnv.sh that rewrites frontend/wrangler.jsonc's vars block from frontend/.env.local after each deploy. Idempotent. Small.
- Long GitHub-URL diagnostics trim (#18) — yes, drop events from 15+5 to 8+3 (more aggressive than your 10+2 because every URL-encoded JSON event chews ~200 chars). Quick fix.
- Unique error ID for GitHub reports (#15) — proper version: hash the diagnostics payload + epoch, store (id → full payload) server-side, embed only the id in the GitHub issue body. Needs a Cloudflare Worker endpoint. Half-day backend, half-day frontend. Reasonable Phase-1 ship.

## Tier 4 — UX polish (ship as one batch PR, low risk)

- (#1) Continent-grouped language picker
- (#5) Wrap tooltips in offer/loan lists
- (#6) "Consent not given" hint on Lender Yield-Fee Discount card
- (#7) Status filter inside Your Offers card
- (#8) Collateral asset+amount in Your Loans
- (#9) Claim Center → loan view link
- (#10) Symmetric icons for "as lender" / "as borrower"
- (#11) Copy-full-address pill on redacted addresses
- (#13) Color gradients on side panel + cards
- (#14) Link-audit pass (footer + body)
- (#16) Data rights → separate page + caution dialog
- (#19) Move T&C / privacy policy under /frontend
- (#21) Mobile: drop the redundant chain selector
  Bundle 8-20 into one focused "UX polish batch" PR. ~2-3 days total.

## Tier 5 — protocol-design discussions (Phase 2 candidates)

- Annual interest payment requirement (#2) — significant change to loan lifecycle. Adds a "must pay accumulated interest by year-end or grace+liquidation kicks in" gate. Impacts RepayFacet, DefaultedFacet, scheduling. Worth a design doc + discussion before code. Phase 2.
- Pyth ETH-cross pricing (#3) — there's a real tradeoff. My take: hybrid is better than pure ETH-cross. Use direct USD feeds for pegged assets (USDC/USDT/DAI — the peg-aware staleness rule we have already favors this); use ETH-cross for volatile assets where you're saving config but the double-conversion error is bounded. Pure ETH-cross would push compounded staleness onto stablecoins where it matters most. Phase 2 scoping.
- Cross-chain VPFI mint atomicity (#23) — partial answer: Phase 5 VPFI buy already routes BUY_REQUEST via LayerZero, processes on Base, mints VPFI on Base, OFT-bridges back. The atomicity comes from LayerZero's guaranteed delivery — if treasury never receives ETH on the source chain, the BUY_REQUEST never fires. Worth confirming this matches your intent. Phase 2 review.
- Notifications on major txs (#12) — extends the existing HF-alert push channel. Needs a per-event-type config UI + cost disclosure copy. Push channel cost (Pushover / FCM) per-tx is real. Phase 2-ish.

## Items I'd flag for clarification

- #5 (tooltip overflow) — fixable in CSS; might be one-line. Easy ship.
- #11 (animated address copy) — Phase 1 candidate if it's a 30-min job; defer otherwise.
- #15 (error ID) — only valuable if you actually expect dispute volume on GitHub issues. For a permissionless DeFi product the dispute surface is small. Worth the half-day?

## My recommendation for sequencing

If we're heading toward testnet redeploy → 2-week bake → audit:

- Right now: finish the lifMatcherFeeBps regression (in flight), then ABI re-export.
- This week: Tier 1 #17 (split OfferFacet) — audit-blocking. Discuss Tier 1 #24 (auto-pause) design.
- Next: Tier 2 #4 + #22 while Range Orders context is fresh.
- Before testnet redeploy: Tier 3 (#20 wrangler sync, #18 URL trim).
- Testnet redeploy → 2-week bake.
- During the bake: Tier 4 polish batch.
- Phase 2 design discussions: Tier 5 items, in the audit window.

---

when you work on auto pause
Make the 15 mins auto pause by bot a admin configurable (later by governance), flag for auto pause and a config for 15 mins (to change duration), do you think 15 mins default is reasonable? or you prefer any better duration?

---
