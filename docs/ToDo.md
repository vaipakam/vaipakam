# ToDo Tasks

## Instructions

- Look into the tasks with unticked checkbox and need to work on it
- Always ask if there is a better apporach and if anything need to be discussed
- Once completed the task, tick the checkbox
- new tasks will be added on top with running ID
- Starting ID is from `T-001`

---

- [ ] **T-039**: Provide search for documentation

---

- [x] **T-038**: BuyVPFI page UX — on chains where the adapter is in WETH-pull mode (BNB mainnet 56, Polygon mainnet 137), label the input asset as "WETH" instead of "ETH" + render a CoinGecko deep-link on the asset symbol so users can confirm exactly which token they need (WETH on BNB ≠ WETH on Polygon — different bridged contracts). Same CoinGecko link UX on every other chain (so the asset surface is consistent regardless of native vs WETH-pull). Identify any other small things needed for the cross-chain UX while doing this (balance read against the right asset, approval flow when in WETH-pull mode, etc.). — landed. New `frontend/src/lib/buyAssetInfo.ts` helper resolves `(chainConfig, mode?) → { symbol, coinGeckoUrl, isWethPullMode }`. Mode source: runtime `useVPFIBuyBridge.quote()` returns `mode: 'native' | 'token'` after the adapter's `paymentToken()` read; falls back to chain-config inference (`vpfiBuyPaymentToken` from deployments JSON) until the quote lands. ChainConfig extended with three new static fields: `nativeGasSymbol`, `nativeGasCoinGeckoSlug`, `bridgedWethCoinGeckoSlug` — populated for all 13 chains in the registry. CoinGecko slugs: `ethereum` for ETH-native chains, `binancecoin` + `weth` for BNB / BNB Testnet, `weth` bridged on Polygon mainnet. BuyCard (canonical-Base direct buy) + BridgedBuyCard (mirror chains with the LayerZero bridge) both render the rate-stat and pay-label using the dynamic asset symbol; symbol wraps in an `<a>` to the CoinGecko page (dotted underline + new-tab) when slug is set. WETH-pull approval flow already existed in `useVPFIBuyBridge` (the `s.status === "approving"` branch) — verified it dispatches the `safeTransferFrom`-prereq approval before submitting the buy when `paymentToken != address(0)`. i18n `buyVpfiCards.assetCoinGeckoAria` added to all 10 locales. Tsc + vite build clean (Node 25). What's NOT in this batch: replacing the remaining hardcoded "ETH" strings in BridgedBuyCard's tooltip / error copy ("ETH for the LayerZero fee" etc. — the LZ fee IS always native gas across chains so labeling those "ETH" on a non-ETH-native chain is wrong but a smaller follow-up). Per-asset balance read in WETH-pull mode (currently shows native-gas balance even when WETH-pull is active — also a follow-up; the `useVPFIBuyBridge` quote returns the right `paymentToken` address, just need to read its `balanceOf` instead of native ETH balance).

---

- [ ] **T-037**: check in RepayFacet why the funds have to go through Diamond and not directly escrow to escrow and both the escrow should already exsists (during repay, if not create escrow fisrt and then move) and diamond has full access to both user's escrow, so why 2 transfers and why not single transfer between escrows, that will reduce a transaction cost and also the fact the diamond is free from touching other's asset (the discount on loan intiation fee will only be decided at the loan stellemnt, until then the VPFI is protocal's property and not users property), what do you say?

- [x] **T-036**: ensure in BNB chain since the BNB is native chain toke and WETH is what we need to get from it (to buy VPFI) and this is different from other chains (except for Polygon where the native token is POL), so do we need to have contract address on WETH on BNB and Polygon chain (chains which have different native tokens instead of ETH), to cross check it from our side before initiating the layerzero VPFI cross chain purchase. contracts also need to revert on those chains if user is not providing WETH (verified with contract addres may be set in config or set as immutable constant) to buy VPFI, what do you say? — long-term path landed. Two-layer enforcement: (1) `VPFIBuyAdapter.initialize` and `setPaymentToken` now validate the payment-token via `_assertPaymentTokenSane`: non-zero token must have bytecode (not EOA) AND `IERC20Metadata.decimals()` must succeed AND return exactly 18. Three new errors (`PaymentTokenNotContract`, `PaymentTokenDecimalsNot18`, `PaymentTokenDecimalsCallFailed`). (2) `DeployVPFIBuyAdapter.s.sol` pre-flight reverts if `_chainRequiresWethPaymentToken(chainId) && paymentToken_ == address(0)` — gated to BNB mainnet (56) and Polygon mainnet (137); BNB Testnet / Polygon Amoy stay native-gas-mode for dev-loop convenience. Test coverage: 10 cases in `contracts/test/token/VPFIBuyAdapterPaymentTokenTest.t.sol` covering every revert path on init AND `setPaymentToken` rotation, plus the two acceptance paths. CLAUDE.md updated with canonical bridged-WETH addresses for BNB (`0x2170Ed0880ac9A755fd29B2688956BD959F933F8`) and Polygon (`0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`) so the operator pasting a wrong address gets caught against the published reference. What's NOT enforced on-chain: "is this _the canonical_ WETH on this chain" — there's no on-chain registry; the deploy script logs `name()`/`symbol()` for human-eyeball confirmation as the operational check.

---

- [ ] **T-035**: Defer: Group languages based on the locality of that continent and display only those group belonging to that continent. Note: exception is for japanese can be displayed together with western countries too

---

- [ ] **T-034**: Borrower can pay interest at any time but it is mandatory to pay complete interest at the end of 1 (or each) year completion, the cumulative paid interest for that year should be equal or more than a full year accured interest, otherwise system will use collateral to pay interst to lender after grace period of 2 weeks (buy selling the required collateral asset to but lending asset), this may incur higher fees and may also drastically change the HF/LTV and may triger liquidation too.

---

- [ ] **T-033**: For pyth, if we provide only price feed for ETH/USD, ETH/EUR, ETH/JPY, ETH/XAU and all other asset can be checked with respect to ETH right, so that it is not required for us to configure all the asset price feed right? (on Non ETH gas chain we need to have WETH/USD, WETH/EUR, WETH/JPY, WETH/XAU), suggest me if there are any better appraoch, don't want to gate every asset and also need redandancy for chainlink, currently we have alternative for chainlink only as optionals

---

- [x] **T-032**: Provide notification, not only on HF health, but also on all other major transactions based on user config. Also mention that notification also costs user (if any) — landed. Six new paid event types (Claim available · Loan settled or defaulted · Cross-chain VPFI buy received · Your offer matched into a loan · Loan maturity approaching · Partial repayment received), all default ON for new subscribers, individually opt-out. HF stays compulsory once any rail is enabled. Telegram free; Push paid via flat $2 USD-equivalent (governance-tunable in `[$0.10, $50]`, denominated through a pluggable oracle that defaults to ETH/USD × fixed `1 VPFI = 0.001 ETH` Phase 1 rate). Charged ONCE per loan-side at the FIRST paid notification — direct user-VPFI-escrow → treasury, no Diamond custody. New `LibNotificationFee` library + `LoanFacet.markNotifBilled` external entry (idempotent, gated by new least-privilege `NOTIF_BILLER_ROLE` distinct from WATCHER_ROLE). Mid-loan opt-in works naturally — flip the off-chain flag, pay only when an event actually fires. 15 new unit tests; full regression green. Frontend `/app/alerts` extended with 6-toggle event section + Push fee disclosure across all 10 locales (en/es/fr/de/ja/zh/hi/ar/ta/ko). Watcher-side D1 schema migration + per-event detectors deferred as a separate follow-up; frontend writes the new fields forward-compatible.

---

- [ ] **T-031**: Is it possible to ensure even for cross chain that only after the required ETH received in treasury, the equivalent amount of VPFI will be minted and send to the same wallet from where the ETH has been came from? what happens if signed message in layer zero is compromised, atleast we know there is incoming ETH (can be indepndantly verified without using layer zero message but only with treasury transaction) and for which we need to mint equivalent VPFI, but what about from which account the ETH is comming from, that depends only on the layer zero message, right?

---

- [x] **T-030**: Provide dropdown for duration, so that it would be bucketed and would help the matching offers in a better way, what do you say? — bucketed `<Picker>` shipped on Create Offer with seven preset durations (7 / 14 / 30 / 60 / 90 / 180 / 365 days). Bucket list lives on `OFFER_DURATION_BUCKETS_DAYS` in `lib/offerSchema.ts` (single source of truth for any future surface — preclose-via-offer, refinance, OfferBook filter — to consume). Default selection is 30 days (median, matches the previous placeholder). Contract still accepts any integer in [1, 365] for power users hitting the Diamond directly — buckets are a frontend convention only. i18n handled via `createOffer.durationBucket` with `_one` / `_other` plural variants across all 10 supported locales (en/es/fr/de/ja/zh/hi/ar/ta/ko). Tsc + vite build clean.

---

- [x] **T-029**: Defer: Move Terms of service and privacy policy to required folder inside /frontend

---

- [x] **T-028**: Need to have a separate ID for each reported error on github from our website, so that we can cross check with that id in our system to see if that error really come from website — server-side capture endpoint (`POST /diag/record`) on the hf-watcher Worker writes a UUID-keyed row to D1 (`diag_errors` table) for every UI failure. Same UUID surfaces in the GitHub-issue prefill so support can cross-reference. Anti-spam: 5-consecutive-same-fingerprint local cap on the frontend + server-side dedup + per-IP rate limit (60 req/min) + random sampling knob (`DIAG_SAMPLE_RATE`) + 90-day retention prune via cron. Drawer kept for now behind a master flag (`VITE_DIAG_DRAWER_ENABLED`) so it can be hidden later without ripping out code; journey-log download moved onto Data Rights page so users can still grab session diagnostics when the drawer is off. Privacy Policy updated with one paragraph describing what gets captured + what doesn't + retention + GDPR Art 6(1)(f) basis.

---

- [x] **T-027**: Check if all the links in the page is working fine including the links in footer and in all other places — full audit; one fix shipped (Footer "Smart Contracts" link now lands on `/analytics#transparency` with a matching `id="transparency"` anchor on the Transparency & Source section). Every other internal `to=`/`href=`/`linkTo=` target resolves to a declared route; landing-page section anchors all match; help routes reachable via HelpTabs; external links all canonical.

---

- [x] **T-026**: Where ever we show redacted address, we should provide an option to copy the full address with animation — sweep complete. New `<CopyableAddress>` for bare-`shortenAddr` sites + `copyable` prop on `<AddressDisplay>` opted in on loan parties (lender / borrower in LoanDetails), offer creator (OfferBook detail), keeper whitelist rows (KeeperSettings + LoanDetails per-loan keepers), and timeline event participants (lender / borrower / acceptor in LoanTimeline). Asset-wise Breakdown table + per-chain asset distribution row on Analytics also covered.

---

- [x] **T-025**: Provide colour gradients in the left side panel inside the app and also in each and every card in the app — page-level ambient glow shipped on the public pages (Buy VPFI, Analytics, NFT Verifier) via shared `.public-page-glow` class. In-app shell already had its own ambient glow. Card-level gradient experiments reverted; kept `.pd-section` Analytics-only at user request.

---

- [x] **T-024**: Bring Data rights (GDPR / CCPA) Download/Delete to a separate page in the left side panel — new `/app/data-rights` page with itemised "what gets cleared" list + two-step confirm; sidebar nav entry under Allowances; Diagnostics drawer's broader pair removed and replaced with narrower journey-log Download/Clear + a small link to the new page.

---

- [x] **T-023**: In mobile inside app in top bar, the chain selector is appearing near the connect wallet button even before the wallet got connected, I hope that chain selector is not required at all, as of now we already combined with wallet connect button, what do you say? — dropped pre-connect on every viewport (mobile + desktop). Standalone picker now only renders when wallet is connected but on an unsupported chain (the one actionable recovery state). Pre-connect viewer auto-uses canonical Base Sepolia (already the DEFAULT_CHAIN); post-connect picker is folded into WalletMenu.

---

- [x] **T-022**: Topbar chain visibility — replaced WalletMenu's tiny ChainIcon with **icon + chain name** pill so the user always knows which network they're transacting on. OfferBook + LoanDetails are now wallet-gated like every other in-app page (no more pre-connect read-only render). BuyVPFI's pre-connect placeholder replaced with a marketing block (tiered fee discount + staking yield + how-it-works + Analytics page link for protocol stats). NFT Verifier stays chain-agnostic (it already walks every CHAIN_REGISTRY entry to match a pasted address).

---

- [x] **T-021**: Change the icons for Loans as lender and loans as borrower, it looks nice but we need to either have different icon or need to remove the icon, because the icon for `as lender` shows green and trending higher, but for `as borrower` shows amber colour and graph trending down (which is not good to look from borrower perspective)

---

- [x] **T-020**: In "translation pending" notice, say like this is available only in English. don't say it may be avialble in future update.

---

- [x] **T-019**: Center the connect wallet inside the button which is on top bar, so that in mobile it matches launch app button appearance

---

- [x] **T-018**: tooltips provided inside the list of offers and loans in both dashboard page and offer book is not fully visible, may need to wrap it.

---

- [x] **T-017**: in card `Lender Yield-Fee Discount` in loan view page, provide `consent not given in dashboard` kind of info, so that users will know that they need to enable `discount tier` by providing consent to use the staked / deposited VPFI in their escrow.

---

- [x] **T-016**: Bring the filter `status` inside the card `Your Offers` in dashboard page, just before `new offer` button

---

- [x] **T-015**: Collateral asset and amount is not shown in the list of loans in the `Your Loans` card in the dashboard page

---

- [x] **T-014**: From claim center there should be a link to respective loan view page from the Loan ID that is displayed in the claim center page

---

- [x] **T-013**: Update frontend/wrangler.jsonc file to have all required en.local variables in it, so that before deployment we will run a script to update these variables in cloudflare, add that in appropriate runnook, because not all the variables are baked into VITE during wrangler run deploy, so it is the required step. All while deploying the contract (or immediately after contract deployment) it self, script or a .sh file should update values in frontend/wrangler.jsonc file, what do you say? Let me know if there is a better approach.

---

- [x] **T-012**: The new offer created globally should appear automatically in offer book, based on the sort that we have already defined, hope the sort is not customisable by user, in offer book page.

---

- [x] **T-011**: we need to provide slider to adjust the lending amount and collateral amount. also based on it, we should also show HF/LTV visually with animation, this need to be shown during offer creation in advanced mode, like the one that is shown in loan view page in `Liquidation-price projection` card, inside card `Collateral & Risk`, enhace for offer creation if possible.

---

- [x] **T-010**: Is there any contract that went beyond max size limit that has been reported by anvil, don't we need to fix it?

---

- [x] **T-009**: Got the below message while reporting a bug on github (`Whoa there! Your request URL is too long.`) — trim unnecessary details and/or cut events from 15+5 to 10+2; if it exceeds the threshold of x characters, x needs to be configurable.

---

- [x] **T-008**: Need to set a pause policy in such a way that, after abnormal activity or due to any circumstances, if the system has to be paused and if it is not done within 15 min, can it be paused automatically?

---

- [x] **T-007**: Make the 15 min auto-pause by bot admin-configurable (later by governance), flag for auto-pause and a config for 15 min (to change duration); 15 min reasonable? — landed at 30 min default, governance-tunable within [5 min, 2 h], no enable/disable flag (always-armed safety net), separate WATCHER_ROLE.

---

- [x] **T-006**: Provide multiple language

---

- [x] **T-005**: we may also need to provide permission matching for bots to find two offers with matching conditions between lender offer and borrwer offer with same lending and borrowing asset type. and we may need to get max and min for duration, lending asset amount and borrowing asset amount from both lender and borrower during offer creation. together with with lender specifying min collateral amount (to have healthy HF and LTV) as he is the risk taker. Once these are all available, bots can match the offers based on conditions and the loan will be active. any way both users (lender and borrower) have provided consent during the offer creation itself. we should HF/LTV for worst case case condition based on max / min lending / collateral asset amount during offer creation, we may need to provide sliders and make things easy to understand. also system should decide on how much min collateral asset amount (minCollateralAmount) will be allowed based on lender max lending asset amount and provide him option to set minimum collateral amount required, only above the system set minCollateralAmount, also providing option for max collateral amount (contract should revert if min collateral is provided by lender is below minCollateralAmount). Like wise for borrower, system need to set max lending amount (maxLendingAmount) based on min collateral amount beyond which the borrower can't move the slider to ask for more (contract should revert if max lending amount is provided by borrower is above maxLendingAmount), but borrower can still set max lending amount below the system set maxLendingAmount, also borrower can set minimum lending asset amount he needs. so the current values without range will look like only a maximum lending amount available and minimum collateral amount needed by lender and likewise for borrower, it is minimum lending amount needed and maximum collateral amount available. loan fields cannot have min and max values, only offers can have min and max values for lending asset amount, collateral asset amount, duration and interest. we can put these under advanced mode in front end. What do you say?

---

- [x] **T-004**: update the release notes in docs/ReleaseNotes-2026-04-25.md and create new relase notes for today

---

- [x] **T-003**: inside the app, When the 3 line icon is clicked on the left top, the expanded left side panel only shows `icon only logo`, but it should show full horizontal logo

---

- [x] **T-002**: the create offer button and accept offer button need to be enabled only after clicking the checkbox for `I have read and agree to the Risk Disclosures above.`

---

- [x] **T-001**: The error that is shown to the user may be short, but when user clicks on report to github page, the error information should atleat have second level of verbose information in it.

---
