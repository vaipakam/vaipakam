# alpha02 Connected App Functional Specification

This document states the intended behaviour of the alpha02 connected app. It is
the alpha02-specific functional spec distilled from the release notes through
2026-07-12. It is intentionally written without implementation snippets.

## Purpose

alpha02 is the beginner-first connected app for Vaipakam's pre-live testnet
experience. It should let non-expert users borrow, lend, rent NFTs, manage
positions, claim funds, and understand risks before signing. Advanced users can
reveal denser market and management tools without leaving the same product.

## Experience Modes

- Basic mode presents guided journeys, plain-language labels, curated choices,
  and the minimum controls needed for common user goals.
- Advanced mode reveals power-user controls such as filtered books, Rate Desk,
  keeper settings, activity history, richer loan metrics, and direct market
  management.
- The selected mode persists for the user.
- If a Basic-mode user opens an advanced route directly, the app should orient
  them and offer a clear path back to guided flows.

## Navigation and Recovery

- The app is mobile-first, with bottom navigation on small screens and a
  persistent navigation layout on larger screens.
- Unknown routes show a recovery page instead of a blank screen.
- A page display failure is contained to a recovery card. Navigation remains
  usable, and the user is told that funds and on-chain positions are not changed
  by a display failure.
- The global support control remains reachable without covering primary mobile
  action buttons.

## Wallet and Network Behaviour

- Wallet connection should make the active address and network clear.
- Unsupported networks show a plain switch-network state.
- Supported networks should still be named clearly because offers, loans,
  faucet assets, vault balances, and claims are chain-specific.
- A failed or rejected network switch remains visible until the user dismisses
  it or a newer clear state replaces it.
- Display names may be shown for convenience, but names never decide asset
  identity, ownership, authorization, or safety.

## Data Authority and Freshness

alpha02 uses chain reads and indexed reads for different jobs.

- Chain reads are authoritative for the connected wallet's current positions,
  claimability, offer and loan detail pages, ownership, and submit-time safety.
- Indexed reads are the fast market and history layer for shared books, activity
  history, executed-rate charts, market discovery, and historical participation.
- A just-confirmed offer or loan owned by the connected wallet should appear in
  My positions within a block when the chain can enumerate it.
- A just-ended offer should not remain selectable when the chain already shows
  that it was accepted, cancelled, matched, or consumed by a sale.
- A fresh offer deep link should resolve from the chain when the indexed row has
  not caught up yet.
- If the indexer is stalled or unavailable, the app should show a degraded
  data-source warning rather than a confident empty list.
- Activity history may depend on indexed history, but current positions must not
  disappear merely because ingestion is delayed.
- Realtime push refreshes matching indexed views when available. Polling remains
  the fallback.

## Review Receipts and Consent

Every value-moving flow presents a review receipt before signing.

The receipt should answer:

- what the user receives;
- what the user locks or spends;
- what the user may owe;
- what the user can lose;
- what fees apply; and
- when the position or obligation ends.

Consent is collected against the terms actually shown. If a material term,
warning, selected offer, selected listing, or disclosed risk changes after
consent, consent is cleared and the user is told to review again.

Risk Disclosure and Terms links are real links and must not destroy the flow in
progress.

## Wallet Prompt Transparency

- Offer creation, offer acceptance, rental listing, rental acceptance, loan
  management actions, and VPFI deposit should say how many wallet confirmations
  may be needed and in what order.
- The action control should narrate the current wallet step while the sequence
  is running.
- Approval reset cases are named honestly.
- Signature-based token approval may be used when live preconditions make it
  valid. If the signature is declined or unavailable before any transaction is
  submitted, the app falls back to the classic approval path.
- Once an action transaction has been submitted to the wallet, the app avoids
  silent retry paths that could create ambiguity about whether the action may
  still confirm.

## Borrowing and Lending

- Guided borrow and lend flows begin with user intent: asset, amount, duration,
  and acceptable terms.
- Matching open offers are shown first when available.
- Posting the user's own offer is the explicit fallback.
- The app blocks self-authored offers where accepting them would be unsafe or
  nonsensical.
- Direct accept reviews use the live offer terms and the active chain. If the
  reviewed terms and signable terms no longer match, the action aborts before
  wallet prompts.
- Reviews show net wallet proceeds, collateral, repayment expectations, fee
  treatment, expiry, and loss consequences in functional language.
- Partial fills, all-or-nothing fills, immediate-or-cancel fills, and timed
  expiry are advanced concepts and should be disclosed only when relevant.
- Offer modification preserves the same collateral and lending safety bounds
  required at offer creation.

## Offer Book

- Basic mode shows a plain newest-first book.
- Advanced mode may filter by side, asset, rate, duration, and offer type.
- A filter with no matches says the filter has no matches; it does not claim the
  whole market is empty.
- Action labels are role-specific so the user understands whether they are
  borrowing, funding, renting, or buying a position.
- Ended offers are not actionable during indexer lag when the chain already
  shows that they ended.
- Rows that carry risky, unknown, or unverifiable token legs show visible risk
  badges before the user reaches the review screen.

## Rate Desk

Rate Desk is the Advanced-mode market terminal for supported fungible-token
markets.

It should provide:

- a selected market by lending asset, collateral asset, and duration;
- a rate ladder with lender asks and borrower bids;
- cumulative depth and top-of-book context;
- an order ticket for limit-rate offers;
- open orders, live positions, recent fills, and historical participation;
- an executed-rate chart based only on real fills; and
- realtime market refresh when the indexing service supports it.

Thin-market honesty rules apply.

- A market with no fills says so plainly.
- Sparse fills are shown as sparse prints, not as a dense trading chart.
- Quoted midpoint and executed rates are visually distinct.
- A crossed book shows a matchable band only when the protocol confirms that
  the top pair can actually settle.
- Gasless signed orders may appear beside ordinary on-chain offers, but the user
  is told that maker funds are not escrowed until fill and that revocation
  requires an on-chain cancellation.

## Loan and Position Management

- Current holder status controls which actions are available.
- Purchased or transferred positions appear for the current holder.
- Sold, transferred-away, or claimed positions do not remain actionable for the
  prior holder.
- More-settled chain state overrides stale indexed state.
- A terminal loan never presents live obligation actions such as repayment.
- Fallback-pending loans remain visible as active because the borrower may still
  cure them before the lender finalizes the fallback.
- Past-due loan pages show the grace window and the consequence of inaction.
- Health and risk labels escalate when collateral health is poor.
- Position rows should offer the next relevant action where one exists.

## Claims

- Claims are chain-authoritative.
- Indexed data may provide candidates, but live ownership and claimability
  decide whether a claim is actionable.
- A claim attached to a purchased position is discoverable by the current holder
  even if that holder was not an original loan party.
- Claim rows show the amount or asset the user can receive when knowable.
- A stale indexed row must not remain actionable after the chain says it is no
  longer claimable.
- Frozen sanctioned proceeds remain parked until the recorded frozen claimant is
  proven clean.

## NFT Rentals

- NFT rental flows are presented as rentals, not debt.
- Owners list NFTs for rent with a daily fee, payment asset, and duration.
- Renters prepay the fee and refundable buffer before receiving temporary usage
  rights.
- The review explains custody, temporary rights, prepayment, buffer treatment,
  close-out, and claim behaviour.
- Rental detail pages use rental vocabulary: owner, renter, rent, close rental,
  and claim.
- Daily fees are interpreted in the payment asset's human units and the total
  prepayment is shown before signing.

## Secondary Loan-Position Sales

- A lender position sale review is based on the live loan, not only the listing
  row.
- The buyer sees the current principal, collateral, remaining economics,
  borrower identity, and due date before signing.
- The buyer signs the same live facts that the protocol enforces.
- A stale linked offer, an unsupported linked-offer kind, a terminal loan, or a
  self-purchase by the current borrower is blocked before signing.
- Seller settlement readiness is checked before asking the buyer to sign when
  failure would otherwise produce an opaque on-chain error.

## VPFI Vault and Discounts

- The VPFI page is availability-first. A chain without registered VPFI utility
  does not show deposit controls.
- The page shows wallet balance, vault balance, locked balance, free balance,
  active discount, and warming-up discount state.
- Deposits and withdrawals use the same review and wallet-prompt transparency
  model as other value-moving flows.
- Withdrawals cap at free balance, not total balance.
- Discount consent is explicit and visually prominent.

## Token Safety

- Curated tokens are treated as pre-vetted.
- Test networks may show that independent token-security coverage is not
  available instead of blocking faucet-token testing.
- Unknown tokens on supported networks are screened before posting or accepting.
- Dangerous or unverifiable tokens block posting or acceptance with plain
  reasons.
- Softer owner-power risks are warnings that require informed consent.
- Risk findings are re-checked before signing so a new flag or undisclosed
  warning cannot slip in after review.
- Market-listing context may be shown as a soft identity signal, never as a
  hard safety verdict.

## Faucet

- The testnet faucet should provide at least two liquid test assets and at
  least two illiquid test assets.
- Both fully priced and fully unpriced test deals should be possible from
  faucet supply alone.
- Faucet success should offer clear next steps back into borrow, lend, rent, or
  manage flows.

## Alerts

- Alerts are optional and outcome-oriented.
- Users may link an external delivery channel for repayment and risk reminders.
- Link, unlink, and preference changes that affect delivery require proof of
  wallet ownership.
- Stored alert data is described plainly before linking.
- Turning off important reminders is explicit and cannot happen merely because
  the user opens the card from another device.
- If no alert backend is configured, the app states that alerts are unavailable
  and sends nothing.

## Support and Diagnostics

- The support drawer shows network, chain connection health, market-data
  freshness, app build, and the last local error.
- Checks run only while the drawer is open.
- A user may create an in-app support ticket with a message and optional reply
  address.
- Health details are attached only with explicit consent.
- Full wallet addresses are not included in health details.
- If ticket submission fails, the app offers an email fallback and must not
  claim a ticket number it did not receive.

## Operational Kill Switch

- Operators may pause position-opening flows during an incident.
- Pausable entry flows include posting offers, accepting offers, listing NFTs,
  renting NFTs, and depositing VPFI.
- Exit and recovery flows remain outside this switch: repayments, claims, and
  withdrawals stay available.
- A paused flow explains that existing positions are unaffected.

## Privacy and Legal Posture

- alpha02 does not require KYC for the retail flow.
- The Help page states that Vaipakam is decentralized and non-custodial, no KYC
  is required, and users are responsible for their own regulatory compliance.
- Support reports and diagnostics minimize personal data.
- Wallet and analytics integrations should avoid unnecessary telemetry where
  the app can control it.

## Regression Expectations

alpha02 should maintain an executable regression tier that drives the real app
against a forked testnet state.

Coverage should include:

- connection;
- offer posting;
- guided offer acceptance;
- repayment;
- cancellation after cooldown;
- faucet minting;
- token-risk surfaces;
- live market freshness;
- Rate Desk book, chart, history, and signed-order flows; and
- support and diagnostics surfaces where practical.

The regression tier should assert visible app state and the corresponding chain
outcome where a chain outcome exists.
