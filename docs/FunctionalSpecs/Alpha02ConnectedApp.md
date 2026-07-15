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
- Every list built from chain or indexed data is bounded at BOTH layers: the
  fetch is capped and fails loud past its cap (never a silent truncation), and
  the page renders a bounded window of rows with a "show more" affordance that
  states what one click reveals — the screen and any per-row reads grow with
  what the user asks to see, not with the size of the wallet's history or the
  market. Where per-row lookups happen inside the fetch itself (the
  standing-approvals and vault-asset scans), the window bounds the lookup set
  too, and widening it is the same explicit user action. Lists whose size is
  fixed by nature (static tables, contract-capped sets, single cards) render
  whole. Server-side reads are capped too: market discovery serves the
  deepest markets, executed-rate history scans the newest fills, and the
  claim-candidate routes serve the newest terminal loans — each response
  says when depth was dropped, so a spammed market or an unusually long
  history degrades honestly instead of scanning without bound.
- A market maker's own resting signed orders are always visible and
  cancellable from the desk, even when better-priced depth from other
  makers fills the public book's per-side window — the desk reads the
  maker's own orders scoped to their wallet, not from the top-of-book
  slice.
- If the indexer is stalled or unavailable, the app should show a degraded
  data-source warning rather than a confident empty list.
- Activity history may depend on indexed history, but current positions must not
  disappear merely because ingestion is delayed.
- Realtime push refreshes matching indexed views when available. Polling remains
  the fallback.
- The push signal covers every class of change a holder-keyed view depends on —
  including position-ownership transfers (a position NFT changing hands, a
  claim burning one) and entitlement changes that alter what a party is owed
  without changing the loan's status (for example a partial rescue of a
  pending-fallback loan). The push rail also reports its own freshness (how
  recently ingestion advanced, and how often it is expected to), so the app
  can tell a healthy-but-quiet rail from a stalled one instead of guessing.
- Governance-tunable display configuration (fees, buffers, feature flags)
  may be served from the indexer's config snapshot, which follows
  governance changes within moments; the chain remains the fallback when
  the snapshot is absent or stale. Anything the user signs against is
  always read live from the chain at submit time.
- Live-update signals may name exactly which loans and offers an update
  touched, and who caused it. A tab may skip refreshing its own-position
  surfaces for an update that provably does not involve its wallet — but
  only when the signal declares itself complete; any incomplete, older,
  or unreadable signal is treated as if it named everything. Narrowing
  may only ever remove redundant refreshes, never delay an update the
  wallet needed.
- Refresh is signal-driven with polling as the degraded fallback: while the
  push rail is verifiably delivering, background polling relaxes to a safety
  net and freshness rides the push signal, per-block refresh narrows to the
  reads that gate imminent money decisions, and the user's own confirmed
  actions refresh their views immediately — in every open tab of the app. The
  moment the rail cannot prove it is delivering, the app returns to its
  polling cadence on its own. A money action fired directly from a list row
  is re-checked against the chain at the moment of the click, so a row made
  stale by someone else's action produces a plain explanation, never a doomed
  signature.

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
- Once a candidate has been verified on chain, an IDENTICAL candidate (same
  loan, side, status, position tokens, and entitlement-relevant amounts) may
  reuse that verdict within the session instead of re-verifying — but any
  signal that ownership may have changed (a position NFT changing hands
  anywhere, or the user's own confirmed transaction) discards every reused
  verdict; reuse is suspended entirely while the live-update channel is not
  verifiably healthy (no reuse without the signals that would invalidate it);
  a reused verdict expires after a bounded time regardless; and a fresh
  session always verifies from scratch. Reuse may never
  cause a claim to be shown or hidden differently than a fresh verification
  would have decided at the moment the verdict was recorded.
- The indexer may suggest additional claim candidates; suggestions can only
  widen what gets verified, never narrow it — a candidate the chain
  enumeration finds is verified whether or not the indexer suggested it.
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

## Detailed Connected-App Requirements

The following requirements preserve the detailed connected-app behaviour that
was previously carried in the website functional spec.

Its intended behaviour, as the test oracle for this surface:

- The first screen asks what the user wants to do — borrow, lend, rent
  or lend an NFT, or manage existing positions — before showing any
  protocol construct.
- Guided borrow and lend flows surface MATCHING OPEN OFFERS first;
  accepting one opens the loan immediately at the offer's full amount
  and terms (offers are taken whole), and posting the user's own offer
  is the explicit fallback. Before signing an accept, the app must
  verify the on-chain terms still match what was reviewed (an edited
  offer or lagging cache must abort with a plain explanation) and that
  the offer belongs to the network the wallet will transact on.
- Every write flow shows one review receipt with six fixed rows —
  what you receive, what you lock, what you may owe, what you can
  lose, fees, and when this ends — plus a fixable-items eligibility
  checklist (wallet, network, sanctions status, token validity on both
  legs, balance, consent). Fee and buffer percentages in receipts and
  help copy are read from the live protocol configuration. When a
  balance or eligibility check can compute a shortfall, the message
  must name the missing amount and asset rather than only saying the
  user needs more of that token.
- When either side of a deal is not priced by the protocol, the review
  must say plainly that default means the entire collateral transfers
  directly, with no price-based liquidation.
- Empty states are honest: "nothing here" is only shown when the data
  source positively returned zero; a failed or partial load shows an
  unavailable state. A user's positions list must never silently omit
  one side of their positions.
- The wallet's OWN current positions (open offers it created, open
  offers it received by transfer, loan positions it currently holds)
  are discovered from the chain itself, so a just-confirmed
  transaction appears under My positions within a block — never gated
  on background ingestion catching up. The indexed lists serve as the
  redundancy source for the same current positions; when either
  source is unavailable the page still renders from the remaining one
  but must say a data source is degraded, and it shows the
  unavailable state only when both fail.
- Live chain state always outranks the indexed snapshot for the
  wallet's own positions: a just-cancelled offer must not linger as
  cancellable, and a loan whose position token the wallet no longer
  holds (transferred away or burned at claim) must not keep rendering
  as the wallet's active position, even while background ingestion
  lags.
- The SHARED offer book applies the same principle one-sidedly: before
  rendering, the app checks the chain history the cache has not yet
  ingested and removes any offer the chain already ended (accepted,
  cancelled, matched, or consumed by a sale), so ingest lag cannot
  present a dead offer for selection. The check only ever removes
  rows — new offers appear via the cache's own refresh — and it fails
  open: if the chain check cannot run, the book renders the cache
  state unchanged (with the existing staleness note when applicable)
  rather than becoming unavailable. When the cache is too far behind
  for a bounded check, the check is skipped for the same reason.
- The wallet's activity feed is built from indexed event history and
  must refuse to render (unavailable state) when its participation
  filter can't see the wallet's full loan list; an empty feed carries
  the same staleness note as a non-empty one when ingestion has
  positively stalled. Completeness scope, recorded as intent: the
  feed currently covers positions the history service can still link
  to the wallet — events for a loan whose position token the wallet
  burned at claim or transferred away long ago join the feed once
  the history service answers participant-history queries (a tracked
  indexer follow-up), and until then the feed must not present its
  narrower scope as the wallet's complete history.
- NFT rentals are never presented as debt: nothing says "repay", the
  NFT stays in the owner's vault, the renter receives temporary use
  rights, and the renter's total up-front payment (fees plus the live
  refundable buffer) is shown before signing.
- Loan actions follow the CURRENT position-NFT holder, not the
  original addresses; every claimable listed in the Claim Center has a
  working claim action on its detail page, including a borrower's
  residual claim after default or liquidation.
- Wallet-rejection messages appear only for genuine user rejections;
  contract reverts are decoded to plain-language causes.
- Advanced mode reveals power controls in place, never as a different
  product: the Offer Book gains a side filter (lending offers, borrow
  requests, NFT rentals), rate and duration sorting, an asset-address
  filter that matches any leg of an offer, and a per-row detail line
  with the exact basis points, offer id, expiry, range bounds and the
  partial-repay flag. Basic mode keeps the plain newest-first list.
  When active filters match nothing, the empty state must say the
  FILTERS matched nothing (with a clear-filters action) — never that
  the market is empty.
- Where the wallet already holds a standing Permit2 approval for the
  token (acquired once, by the first Permit2-based app the wallet
  used), the token approval that precedes a position-opening action
  may be granted as a one-time, gasless permit signature instead of
  an approval transaction — the sequence becomes sign-then-transact
  with a single gas payment, the authorisation covers exactly one
  pull and expires shortly, and no standing protocol allowance is
  left behind. The permit route engages only when both live-checked
  preconditions hold: no protocol allowance exists at all (a covering
  allowance keeps the cheaper classic path, and a leftover partial
  allowance also keeps the classic path so its clean-up reset still
  clears the stale approval), and the wallet's Permit2 approval
  covers the amount (without it the permit variant cannot succeed
  on-chain, so it is skipped silently rather than attempted). A
  wallet that declines or cannot produce the signature falls back to
  the classic approve-then-act sequence automatically, and the
  pre-disclosed confirmation count never under-promises (the permit
  route matches it or finishes early; a declined permit prompt that
  forces the classic sequence widens the live step counter to count
  the extra interaction honestly). The automatic fallback ends at
  the signature step: once the permit-based transaction has been
  handed to the wallet, any failure is surfaced rather than silently
  retried another way — an ambiguous failure could ride on top of a
  transaction that still confirms (executing the action twice), and
  a definite rejection usually dooms the classic retry as well,
  after it paid for an approval it cannot use. A manual retry
  re-runs every live check.
- Immediately before any approval or signature, the app re-checks the
  facts that decide the transaction live on-chain — balance of the
  asset being locked or paid, asset pause status, current holdership
  of the position being acted on, the live grace window, and (when
  the review showed no unpriced-asset warning) current liquidity of
  both legs. A stale fact aborts with a plain explanation before the
  user pays for anything; where an answer gates a disclosure, an
  unreadable answer blocks rather than silently passing.
- A ticked risk-and-terms acknowledgement is void the moment any term
  it covered changes: editing an offer or listing term, choosing a
  different offer or listing, or a disclosure (such as the
  unpriced-asset warning) appearing after the acknowledgement was
  given all require a fresh acknowledgement. The acknowledgement's
  "Risk Disclosures" and "Vaipakam Terms" phrases are live links (to
  the in-app risk-disclosures section and the marketing site's Terms
  respectively), opening without destroying the in-flight flow; the
  Help surface carries the platform disclaimer verbatim as mandated
  in the shared principles above.
- Review receipts state the loan's interest mode in plain language:
  full-term interest applies even when the loan is repaid early;
  day-by-day (pro-rata) loans cost less when repaid early. The stated
  mode is part of the reviewed terms: it is compared against the
  protocol's canonical record before the wallet is asked to sign, and
  a mismatch aborts like any other changed term. The grace
  period shown in receipts and the grace window enforced at
  repayment come from the same schedule, and signing waits until the
  live schedule answer is known — while it is loading the receipt may
  show the default schedule's wording for display, but no
  acknowledgement can be signed against it, and a failed schedule
  read shows a visible retry rather than silently passing.
- Advanced mode offers close-early (direct preclose) to the borrower
  of an active ERC-20 loan from the loan detail page, up to and
  including the end of the loan's grace window — the protocol keeps
  the early-close door open through grace, charging the same late fee
  a late repayment does, and rejects it only strictly past grace. The
  window is judged by chain time against the live term and grace
  schedule, never the device clock. While the loan is past due but
  inside grace, the surface must say the loan is past due, that the
  quoted amount already includes the growing late fee, and that the
  option ends with the grace window; strictly past grace the surface
  disappears and any attempt stops before a wallet prompt with a
  plain message that the default process applies. The review quotes
  the settlement figure from the protocol's own settlement math —
  honouring the loan's interest mode, any interest already settled by
  partial repayments, and any late fee — never a locally derived
  estimate, and states the interest-mode implication before signing. After a successful close or full repayment the page must
  not re-offer close-early, repay, partial repayment, or collateral
  top-up while off-chain data still shows the loan active. While the
  close-early eligibility reads are in flight or failing, the page
  shows a visible checking/retrying state rather than silently
  omitting the feature. A compliance-flagged wallet is not shown
  close-early at all; its open path remains the wind-down repayment.
  Only one pending-action review can be open on the page at a time.
- Advanced mode offers refinancing on an active ERC-20 loan up to and
  including the end of its grace window (a request can be posted and
  accepted through grace; strictly past grace both are rejected and
  the surface says the default process applies) — and only while the
  position still belongs to the wallet that originally took the loan
  (collateral carry-over binds to the original borrower; a
  transferred position is not offered refinancing). The borrower
  posts a refinance request for exactly the loan's outstanding amount
  at a chosen rate ceiling and duration, and a lender's acceptance
  completes everything in one transaction — new loan opened, old
  lender paid off from the borrower's wallet, old loan closed,
  collateral moved across without unlocking. When the acceptance
  lands after the loan's due date, the payoff also includes the same
  late fee a late repayment charges plus the interest that keeps
  accruing past the due date. Before posting, the review must
  state: the payoff is always principal plus the full remaining
  term's interest (never pro-rata, regardless of the loan's interest
  mode) plus the protocol's cut inside it; that a late acceptance
  adds the late fee, with the largest amount the payoff could grow
  by (late fee plus continued interest) disclosed and the granted
  approval sized to the largest total pull any remaining acceptance
  could make (so a grace-window acceptance cannot fail on a short
  allowance) — and if that bound has grown by signing time (a review
  left open while the loan slid toward maturity), the submission
  stops for a re-review rather than signing undisclosed headroom; the
  spare wallet balance to keep while the request is open (payoff
  interest plus the new loan's initiation fee — the new principal
  arrives in the same transaction); that a short balance only makes
  the acceptance fail, taking nothing; that posting takes multiple
  wallet confirmations; and, for a loan on a periodic interest
  schedule, that the replacement loan will not carry a payment
  schedule. A loan already past due but inside grace shows a plain
  past-due notice on the form, and the quoted figures include the fee
  as of now. If the posting sequence is abandoned
  after the payoff approval was granted but before the request was
  posted, the approval is unwound automatically (best effort). The
  request carries its own on-chain expiry matching the reviewed
  lifetime — acceptance past it fails safely regardless of any wider
  pre-existing guardrails — plus guardrails bounding completion to
  the reviewed rate ceiling. A request whose standard lifetime would
  outlive the loan's grace window is capped on-chain at the grace
  boundary, and the review states that shorter effective expiry
  rather than the standard lifetime. The pending request's view — its state,
  expiry, funding warnings, and cancel action — must outlive every
  gate on the posting form: it stays present through data-source
  errors, unresolved compliance checks, mode switches, the loan
  crossing maturity, and the loan settling some other way (where it
  states the request can no longer complete and offers cancel as the
  cleanup). Once the loan is strictly past its grace window the view
  likewise states that no lender can accept the request any more,
  stops the funding warnings (there is nothing left to fund), and
  keeps cancel as the unwind. The page verifies the request against
  the chain (a cancelled or replaced request clears itself) and warns
  distinctly when the standing payoff approval no longer covers
  completion (with a restore action, which first re-verifies the
  request is still completable — including that the loan is not past
  grace — and restores cover for the largest pull a remaining
  acceptance could carry) or when the wallet balance is short (top up
  or cancel — no false remedy). Cancellation is offered from that view
  (it becomes available a few minutes after posting, per the
  protocol's cancel cooldown, judged by chain time) and also removes
  the standing payoff approval. While a request is live, partial
  repayment and close-early are held off with an explanation —
  either would strand the request — and the full-repayment review
  warns that the request survives settlement until cancelled. The
  pending marker is device-local: another device posting a second
  request for the same loan is possible and each device tracks only
  its own. Loans on a periodic interest schedule carry a visible
  warning that an overdue period blocks completion until settled.
- Advanced mode offers the lender of an active, not-yet-matured
  ERC-20 loan an early exit: selling the position into a matching
  open lending offer. The picker lists only offers the sale can
  actually complete against (matching assets, single-value and
  unfilled, duration within the loan's remaining term, collateral
  demand within the pledged collateral, amount covering the
  principal, and cost within the principal), best payout first, with
  any truncation of the list stated rather than silent; while the
  offer search is loading it says so (loading and "no matches" never
  look the same). The payout math mirrors the protocol's settlement
  to the smallest unit (second-precision accrual, remaining term
  reduced by time elapsed). If the quoted figure moves while a
  review is open, the review closes with a visible explanation and
  must be reopened against the current number. The
  review states the payout plainly: the seller receives the
  principal minus the LARGER of the interest accrued so far or the
  rate difference for the remaining term (when the buyer expects a
  higher rate — flagged before review), paid straight to the wallet
  in the same transaction with nothing to approve and nothing to
  claim afterwards; the borrower's rate and due date do not change.
  Because a consumed buy offer can linger as available in off-chain
  data, confirmation always re-verifies the offer live (still open,
  unchanged terms, not expired) and re-reads the payout with chain
  time, re-reviewing on material drift. The protocol's cut comes out
  of the forfeited interest, never beyond the shown figure.
- The lender can instead LIST the position for sale at a rate of
  their choosing. Before confirming, the review must disclose: the
  lender position NFT is locked for transfer until the sale
  completes or the listing is cancelled; the settlement (the larger
  of interest accrued by acceptance or the rate difference for the
  remaining term — never both) is pulled from the seller's wallet
  inside the buyer's transaction, so listing sets a standing
  approval sized to cover settlement through the loan's term plus a
  stated headroom, with only the actual amount ever pulled — a
  listing that somehow outlives the headroom is flagged by the
  funding watch with a top-up action; and a rate above the loan's
  own attracts buyers at the seller's cost. An explicit
  risk-and-terms acknowledgement is required before listing and is
  voided by any term change.
  The listing's standing surface is chain-authoritative (the lock on
  the position NFT), so a listing made on another device still
  shows, still warns when the standing approval or balance no
  longer covers settlement (with a verified restore action that
  always clears the CURRENT live requirement plus fresh headroom,
  not just the original bound), and still interlocks the
  sell-into-offer exit; where the listing's identifier can't be
  recovered (the recovery search covers the wallet's recent offers
  and retries a bounded number of times), the funding state is
  reported as unverifiable — never a false all-clear. The funding
  verdicts and the cancel/restore actions bind to the wallet that
  currently HOLDS the lender position — any other wallet on the
  same device sees the listing's existence but no funding verdicts
  and no actions. A momentary data failure never hides the listing
  surface while the lock stands, and a listing whose loan has since
  settled says so plainly and steers to cancel-to-unlock instead of
  nagging about funding. The two lender exits share one write lock
  so their transactions can never race each other, and an exit
  listing whose posting fails after the approval was granted unwinds
  that approval best-effort. Cancellation (which
  unlocks the NFT, becomes available after the protocol's cancel
  cooldown judged by chain time, and also removes the standing
  approval — with a note that other standing uses of the same token
  then need their approvals restored) is offered where the listing's
  identifier is known; its outcome is reported on the page even
  though the listing card closes. When a listing ends off-page (a
  buyer accepted, or it was cancelled elsewhere), the page states
  that outcome once instead of letting the card silently vanish.
  While a listing stands, the sell-into-offer exit is not offered,
  and the borrower's partial-repayment surface is held off with an
  explanation — the listing sells the claim at its frozen outstanding
  amount, and a partial repayment under it would make the buyer
  overpay for a smaller claim. Full repayment and close-early remain
  open to the borrower, and a terminal loan state should show the
  seller a clear cancel-to-unlock path for any stale listing. The
  listing form is offered only on networks
  where the protocol's listing entry point is known to work
  end-to-end; elsewhere it is withheld and replaced by a plain note
  pointing at the working instant exit. Every standing-surface rule
  above applies to any listing that exists either way.
  On the BUYER side, an offer tied to an already-running loan is
  reviewed by KIND. A position sale gets a real buy-a-running-loan
  review: it is introduced as buying the lender side of a named,
  already-running loan (the borrower and their obligations do not
  change), and every number shown comes from that loan read live —
  the price is the loan's current outstanding principal, the earnings
  projection covers only the remaining part of the term at the
  listing's rate, the collateral shown is what the borrower actually
  has locked, and the end date is the running loan's real due date.
  The review must also show that no fresh origination fee is charged
  on a secondary lender-position sale.
  The purchase is signable only when every check is positively clear:
  the linked loan is still active and not past its due date, the
  current viewer is not the loan's own borrower, and the seller's
  standing settlement funding covers completing the
  sale right now (a seller who revoked or spent it would make the
  purchase fail on-chain — the review blocks with a plain reason
  instead of letting a doomed transaction be signed). What the buyer
  signs is bound to the same live loan numbers the review showed,
  including the current principal and collateral floor, so any
  movement between review and signing aborts before the wallet
  prompt. An offset vehicle (or a linked offer whose kind cannot be
  positively identified) remains not acceptable in this app version:
  the review flags the link, names the loan, and blocks signing
  entirely. Signing always waits until the link and kind checks
  resolve, and a failed check shows a visible retry rather than
  silently passing. This is a deliberate supersession, on this
  surface, of one specific model: the primary app's borrower-side
  `Borrow or sell` COLLATERAL-marketplace-listing opt-in described
  in the offer-creation requirements earlier in this document (the
  eligibility flag plus the separate marketplace-listing publication
  of NFT collateral). That opt-in, its listing publication, and
  accepting offset or other unidentified linked-offer kinds stay out
  of this surface's scope by intent, not by omission. The
  LENDER-POSITION sale path is emphatically in scope and specified
  above: a lender lists their own position for sale and a buyer
  takes it over through the secondary-sale review — that pair is
  exactly what this surface carries instead.
- Advanced mode shows the role-relevant position-NFT id on the loan
  page (the lender-side id to lender-side users, the borrower-side
  id to borrower-side users), linking to a verifier page that any
  token id can be checked on: a live token shows its current holder,
  the side it controls, its linked loan, and any transfer lock; a
  token that doesn't currently exist is stated as either retired
  by the protocol (a claimed position — or a token burned when its
  offer was cancelled or consumed without becoming a loan) or never
  minted — the network doesn't record which, and the verifier says
  so rather than guessing (the
  three-way distinction the spec asks for is recorded as a
  contract-level gap in the code-vs-docs audit; the general
  verifier requirements later in this document ask for the full
  three-way verdict and carry the matching staging note — the
  enabling follow-up is an on-chain mint-counter view, after which
  this surface adopts the three-way distinction). Only an on-chain
  answer produces a verdict: a transport failure shows a visible
  check-failed state, never a false "doesn't exist". A transfer-lock
  read that fails — or returns a lock reason this build doesn't
  recognise (the lock list is append-only on-chain) — is stated as
  locked/unknown, never rendered as transferable. A token minted for
  an offer that hasn't become a loan yet names that offer. The
  verdict is always scoped to the current network, with a visible
  reminder that token ids repeat across networks.
- Advanced mode's loan-health detail states, alongside the health
  factor and loan-to-value, roughly how far the collateral's value
  can fall before liquidation begins — explicitly framed as
  approximate (it is derived from the health factor, not a price
  feed, and assumes the loan side holds still). Where a holder
  address has an ENS name on Ethereum mainnet, surfaces may show it
  alongside the address as display sugar — never as part of any
  verdict or check.
- Advanced mode lists the wallet's standing token approvals to the
  protocol contract for tokens seen in the user's own loans and
  offers, each with a one-click revoke. The surface states its scope
  honestly (it is not the wallet's complete approvals picture), and
  warns that revoking can break a live refinance request or sale
  listing on the same token — whose own cards will flag it and offer
  restore. When the loan/offer data sources are unavailable the list
  says it can't be built completely rather than showing a partial
  picture as complete.
- Advanced mode surfaces keeper permissions as the protocol's
  three-switch opt-in: a master switch, per-keeper action grants,
  and a per-loan switch on each loan's page — all off by default,
  and all three must agree before any third party can act. The
  settings surface explains each grantable action in plain language
  with whose side it drives, states the safety facts (a keeper can
  never receive funds — payouts always go to the position holder;
  everything is revocable instantly; the protocol can pause all
  keepers; refinances stay bounded by the per-loan guardrails; the
  permissions belong to whoever holds the position), and encodes the
  protocol's edit rules: editing starts from the fetched permissions
  and is refused while they can't be read (saving a synthesized
  default could silently overwrite real grants), permissions the
  surface doesn't render are preserved on save, clearing every
  rendered permission revokes the keeper outright only when no
  unrendered permissions remain (otherwise those are preserved and
  the keeper stays approved), and the whitelist's size cap is
  stated. A transient data failure never replaces the manager while
  retained data exists — revoking must stay reachable — and is
  flagged inline as possibly-stale instead. Capital-deployment permissions (standing-intent fills,
  auto-roll) are not offered here at all. Granting alone is inert
  and the surface says so — the per-loan switch is presented on the
  loan page for either confirmed position holder, with a visible
  reminder when the master switch is off.
- A Support control is reachable from every page, for every user (not
  an advanced-mode reveal). It opens a small panel that answers, in
  plain words, whether the app's connections are working right now:
  the network in use, the wallet (shortened, never the full address),
  whether the blockchain connection is responding, whether the
  market-data cache is up to date / running behind / unreachable
  (with the reassurance that the user's own positions still load
  directly from the chain), the app build, and the last error
  recorded on the device this session. Health checks run only while
  the panel is open. From the panel the user can report a problem: a
  pre-filled public issue carrying exactly the details the panel
  showed — page, network, connection statuses, build, and the last
  recorded error — plus a copy-to-clipboard fallback for users
  without an account on the issue tracker. Reports are redacted by
  construction: the full wallet address never appears, error text is
  length-capped, and nothing else about the device or browsing is
  included. When a page crash is caught by the app's recovery card,
  the error is recorded so a subsequent report carries it.
- The same Support panel can send a message DIRECTLY to the team: the
  user writes what happened in their own words, may leave an email
  for a reply (optional — and its absence never blocks the send),
  and receives a ticket number immediately. The panel's health
  details travel with the message only after one explicit consent
  tick — never silently — and carry the same redaction as the public
  report (the full wallet address never appears). What sending
  stores is stated next to the send control before anything is sent:
  the message, the reply address if given, the consented health
  details, and the ticket number — and that statement names the page
  and network context that always accompanies a ticket, so the
  no-consent case hides nothing. Wallet addresses in the page field
  and health details are shortened again on the receiving service,
  whatever the sending client did — the shortening promise must not
  depend on the widget alone. Tickets are deleted automatically no
  later than 12 months after submission, and the operator alert
  channel receives only the ticket number and context flags (never
  the message text or reply address); if that instant alert fails,
  a daily operational report of open tickets bounds how long a
  ticket can sit unseen. Escalation to a human is a
  prefilled email to the support address quoting the ticket number
  (the stored ticket plus an operator notification guarantee the
  report is seen even if that mail is never written), and the Help
  page carries the same contact route. Failure states are honest and
  each ends at the always-available email path: a rate-limited send
  says to wait, an unavailable inbox says nothing was lost on the
  user's side, and a build with no support backend configured says
  so instead of pointing at another environment's service. The app
  never shows a ticket number it did not actually receive.
- **Rate Desk (Advanced mode).** An Advanced-mode page presents one
  lending market — a lending asset / collateral asset pair at one
  chosen duration — as a two-sided rate book. Lender offers are shown
  as asks at each lender's minimum yearly rate, borrower requests as
  bids at each borrower's maximum, aggregated per rate level with the
  amount still fillable (never the original headline size) and running
  depth totals; offers past their expiry time and offers whose legs are
  not both plain fungible tokens never appear. The page's market list
  covers every pair-and-duration with live offers (a market never
  disappears from navigation merely because its offers are old), and
  duration choices are the same set the guided flows offer. A ticket on
  the same screen posts a limit-rate offer with expiry presets (never /
  a chosen time) and fill modes (partial fills allowed, all-or-none,
  immediate-or-cancel), with the same consent, simulation precheck, and
  under-collateral warning the guided flows enforce. When the ticket
  cannot post, it states the first reason plainly beneath the action —
  no wallet connected (for which it offers a connect action rather than
  only a disabled control), the wrong network, no market chosen, a
  missing amount / rate / collateral, still-loading market details, or
  the terms not yet accepted — so a greyed control is never unexplained.
  Because any change to the terms clears the risk-and-terms consent (the
  deal being consented to changed underneath it), the ticket says so
  beside the box when it clears a consent already given, instead of
  letting the un-tick read as a fault. The field the user actually
  escrows — a lender's loan amount, a borrower's collateral — offers a
  one-tap fill to their wallet balance, and before consent the ticket
  summarizes what the order commits (worded for immediate escrow or, for
  a gasless order, movement at fill) alongside the protocol fee that
  applies to the user's side: a lender's yield after the fee on interest,
  a borrower's one-time initiation fee on the principal, quoted from the
  live deployed fee values. The user's own
  open offers can be repriced or resized in place in one transaction —
  only by their creator; a bought offer position is view-only — and an
  amend that increases the locked amount asks for the token approval
  first. A partly-filled open offer states its fill progress honestly —
  a rounded percentage that never reads as fully empty or fully filled
  when it is neither, alongside how much size remains. Recent fills for
  the market are listed honestly: a market with
  no fills says so, and internal bookkeeping from a loan-sale never
  appears as a fill. Positions show under the book with their health
  status and lead to the existing manage flows. A rate-history chart
  shows the market's **executed** rates over a chosen interval and
  range, under strict thin-market honesty rules: points exist only
  where fills actually happened and quiet periods render as visible
  gaps — nothing is interpolated or synthesized; when the visible range
  holds only a handful of fills (below a stated density threshold) the
  chart must present the individual prints as a sparse tape — a stepped
  line with per-fill markers and a note saying so — rather than
  candlestick shapes, which would misrepresent a thin market as a
  liquid one; every plotted bucket's hover detail discloses the number
  of fills and the total principal it aggregates, never bare
  open/high/low/close alone; the order book's current quoted mid may be
  overlaid for context but must be drawn in a visibly distinct style
  and labelled as a quote — a resting intention, never blended with
  executed rates; and the chart area shows no daily percent-change
  ticker — the header states the last executed fill's rate and its age
  instead. A market with no executed fills says so honestly instead of
  drawing anything, and internal loan-sale bookkeeping never plots as a
  fill (the same rule as the tape). On small screens the ladder and
  ticket remain the primary view with the chart and tape behind an
  explicit view toggle — density changes, capability never. A History
  view lists every loan the connected wallet ever participated in — as
  lender or borrower, including positions acquired by buying or
  receiving a position token — across every market and every status.
  History is permanent: repaid, defaulted, and otherwise closed loans
  remain listed with their final status and the wallet's role(s), and
  each entry links to the loan's detail view; this is deliberately
  different from current-holdings views, which follow the present
  position holder and therefore drop settled or transferred positions.
  Participation is recorded as append-only history — a later transfer
  of the position adds the new holder without erasing the earlier
  participant. Longer histories load in pages on request, and a history
  that cannot be loaded says so rather than showing a partial list as
  if it were complete. The desk updates live: when other participants'
  actions land on the market — a new offer, a change to one, a fill —
  the book and its companion views refresh within seconds rather than
  waiting for the next periodic refresh, and a rate level whose depth
  just changed is briefly highlighted so the change is visible; live
  delivery is a freshness improvement only, never load-bearing — the
  periodic refresh continues underneath, and a deployment without the
  live channel simply refreshes at the normal cadence. When the book is
  crossed (a borrower's maximum meets or exceeds a lender's minimum), a
  match band appears at the book's midpoint ONLY when the protocol
  itself confirms that the two best resting offers can actually settle
  into a loan — crossed rates alone are not enough (their amount or
  collateral constraints can still be incompatible), and a crossed book
  that cannot execute shows no band and no speculation. The band names
  the rate and amount that would match; anyone — not just the two
  makers — may execute the match and earn the protocol's matcher fee
  share (paying the network gas to execute it, which the band states),
  and the resulting loan belongs to the two offer creators at
  the stated midpoint terms. If governance disables the matching
  machinery, the band does not appear. The ticket can also post an
  order gaslessly: instead of a transaction, the maker signs the
  order's full terms once and the signature is published to the
  platform's order-book service — posting costs nothing, nothing is
  locked at signing, and the order is discoverable by anyone reading
  the market. Signed orders appear in the ladder alongside on-chain
  offers, visibly badged as signed so their off-chain, service-sourced
  nature is never disguised as on-chain state; anyone other than the
  maker can fill one in a single transaction, at which point the terms
  the maker signed — and only those — settle into a loan, with the
  maker's side drawn from their vault's spendable balance at fill time.
  A gasless lend order always posts as a single whole fill
  (all-or-nothing): a signed lend order carries one fixed collateral
  requirement, so it cannot honestly be sliced into partial fills — the
  ticket says so, reflects it in the fill-mode choice, and never
  publishes signed lend depth that partial fills could not actually
  consume. Gasless borrow orders are unaffected — they already post as
  a single fixed size.
  Because nothing is locked at signing, a signed order can rest
  unbacked; the platform warns the maker when their vault does not
  currently cover the commitment (without blocking — funding later is
  legitimate), and a taker is told before paying anything when a fill
  would fail for that reason. The maker's own signed orders for the
  selected market are listed with their open orders; withdrawing one is
  an on-chain cancellation that costs a transaction — the platform is
  explicit that this is the only real revocation, since a published
  signature merely hidden from the service could still be filled by
  anyone who saved it. A filled, cancelled, or expired signed order
  leaves the book rather than advertising liquidity that no longer
  exists. Nothing on this page
  invents liquidity, queue positions, or price-change percentages the
  protocol cannot back; the page is reachable by link in either mode
  but appears in navigation only in Advanced mode.
