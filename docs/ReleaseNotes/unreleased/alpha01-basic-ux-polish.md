## Thread — Alpha01 basic UX polish (borrow/lend, positions, activity)

The naive-first alpha01 app now completes the core review loop for borrow, lend, positions, and claims. Borrow and lend wizards use bucketed duration dropdowns, CoinGecko-backed asset pickers, collateral balance checks, and plain-language review receipts. Asset symbols link to the chain explorer everywhere amounts appear, and NFT collateral renders as token IDs instead of mis-scaled ERC-20 decimals.

Positions reads loans and open offers from the corrected indexer endpoints, with an Activity feed under More for per-wallet on-chain history. Legal links (Terms, Privacy, risk disclosure) are surfaced in More and Settings; borrow/lend review steps require explicit consent with links before any transaction is submitted.

Follow-up: on-chain Terms gate parity with the classic defi app is deferred — alpha01 uses action-time consent mapped to `riskAndTermsConsent` on offers.

Codex review follow-ups (P1/P2): accept-term binding now mirrors stored offer fields; spendable balance counts wallet only; open offers and positions resolve role via current-holder indexing; direct-accept pickers hide NFT legs, partial fills, and expired GTT rows; lender fund flow checks wallet principal before approval; sanctions screening fails closed when the oracle read errors.

Round 2: ERC-20 approvals zero stale allowances first; borrow checklist blocks while collateral balance is unresolved; `settled` loans no longer show a borrower claim CTA; linked-loan id reads fail closed except on legacy missing-selector deploys; read-chain resolution skips wallet chains without a Diamond.

Round 3: position cards and borrow wizard reset assets on chain change; lender `settled` claims removed; create-lending balance gate; risk-terms hash fail-closed; APR capped at 100%; collateral hint labels wallet-only.

Round 4: BNB testnet restored as user-facing; token decimals fail closed without persisting a bogus 18; risk-disclosure link targets the Basic guide anchor; vault reads use the view getter; indexer outages surface errors instead of empty portfolios; accept flow rejects cross-chain offer/wallet mismatches.

Round 5: Arb Sepolia and BNB testnet borrow/lend defaults now resolve wrapped-native addresses (with deployment/env fallbacks for mock stable); open offers can be cancelled from Positions; ERC-20 approvals verify receipt success and re-read allowance; borrow matcher requires an exact principal match for direct accept; Claims surfaces indexer failures and shows collateral for borrower claims; create-lending gates on collateral decimals; Help links target real Basic guide anchors; AGENTS.md points at the canonical `~/.codex/scripts/` poller path.

Round 6: Cancel offer is gated to the on-chain creator; create-lending adds curated asset pickers when chain defaults are absent; Activity merges participant loan/offer timelines (not actor-only); borrow accept receipts disclose net wallet proceeds after upfront LIF; create-lending receipt clarifies offers do not auto-expire on the duration field.

Round 7: Activity merge preserves all actor rows; enrichment includes current-holder loans/offers; token metadata cache is chain-scoped; Positions merges creator + holder offers for cancel paths; borrow receipts read live LIF from the diamond; CoinGecko lists clear on chain switch; borrow-request collateral hint is wallet-only.

Round 8: Open offers list is current-holder only so transferred-away positions cannot be cancelled from alpha01; fund-lend receipt discloses principal leaves wallet custody; position cards render asset symbols as text inside the loan link (no nested anchors).

Round 9: Borrow/lend offer pickers exclude self-authored offers and render plain symbols inside selectable rows; raw amount formatting no longer assumes 18 decimals; canonical asset labels use lowercase keys; loan detail and activity pages surface indexer errors instead of empty/not-found states.

Round 10: Raw formatting uses cache-resolved decimals only; offer pickers require wallet connect and clear stale selections; unhealed indexer stubs filtered from lend picker; loan detail warns when indexer origin is missing; lender active loans show Active status; activity merge reserves participant slots; defaulted lender claims show collateral; claim buttons respect wallet chain.