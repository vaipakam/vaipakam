## Thread — Alpha01 basic UX polish (borrow/lend, positions, activity)

The naive-first alpha01 app now completes the core review loop for borrow, lend, positions, and claims. Borrow and lend wizards use bucketed duration dropdowns, CoinGecko-backed asset pickers, collateral balance checks, and plain-language review receipts. Asset symbols link to the chain explorer everywhere amounts appear, and NFT collateral renders as token IDs instead of mis-scaled ERC-20 decimals.

Positions reads loans and open offers from the corrected indexer endpoints, with an Activity feed under More for per-wallet on-chain history. Legal links (Terms, Privacy, risk disclosure) are surfaced in More and Settings; borrow/lend review steps require explicit consent with links before any transaction is submitted.

Follow-up: on-chain Terms gate parity with the classic defi app is deferred — alpha01 uses action-time consent mapped to `riskAndTermsConsent` on offers.

Codex review follow-ups (P1/P2): accept-term binding now mirrors stored offer fields; spendable balance counts wallet only; open offers and positions resolve role via current-holder indexing; direct-accept pickers hide NFT legs, partial fills, and expired GTT rows; lender fund flow checks wallet principal before approval; sanctions screening fails closed when the oracle read errors.