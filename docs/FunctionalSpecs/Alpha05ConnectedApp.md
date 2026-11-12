# Alpha05 Connected App Functional Specification

This document defines the intended experience of the new app in `apps/alpha05`,
consolidating the November 5–11, 2026 release decisions. It supplements the
[platform](ProjectDetailsREADME.md), [tokenomics](TokenomicsTechSpec.md),
[vault](VaultOperations.md), and [keeper](KeeperOperations.md) specifications.
The [existing app](Alpha02ConnectedApp.md) remains the production entry at
app.vaipakam.com until the new app reaches parity and an explicit cutover is
made. A feature described here is not evidence of deployment, funding, or
keeper activation. Unsupported contract capabilities are stated as unavailable.

## Shared experience and access

- Basic mode starts with the user's job: borrow, lend, rent, manage a position,
  or collect funds. Advanced mode adds market tools and settings. Mode, theme,
  and language can be chosen without a wallet and persist on this device.
  The ten supported languages disclose an English fallback where needed.
- Each screen has one role-appropriate primary action and a list of other
  options. Consent, money movements, loss consequences, current blockers,
  available remedies, and unknowns remain visible in both modes. Background
  mechanisms open in a help panel with a guide link. An Advanced page reached
  in Basic mode offers orientation, guided alternatives, and a mode switch.
- Mobile navigation keeps the wallet control visible, uses bottom navigation
  and a More sheet below 720 pixels, a rail from 720 to 1023, and a wider
  panel from 1024. Collapsing the desktop panel is remembered. Controls have
  text labels; help works by touch, keyboard, and Escape, restores focus,
  respects reduced motion, and provides touch targets of at least 44 pixels.
- The interface uses indigo in light and dark themes, with readable text and
  controls meeting a 4.5:1 contrast ratio. The navy-and-green logo remains.
- Every response requests exclusion from search indexing. The connected
  account panel shows the full address, copy, network switching, and disconnect;
  showing an account does not make an undisclosed mainnet name lookup.
- Wallet data is scoped to account, network, and deployment. Reads try the
  wallet's provider, then the platform proxy, then the network's public source.
  A refusal without its reason is retried through another source before it
  becomes an unknown refusal. Old answers cannot populate a new identity.
- Offers, pair books, offer details, and the Rate Desk are read only after a
  wallet connects on a supported network. A disconnected or wrong-network
  visitor does not trigger a fallback offer-book read. The governance queue
  remains public and readable without a wallet.

## Evidence, review, and transaction outcomes

- Discovery may use the index; ownership, eligibility, fees, free funds, and
  binding action figures come from the chain. Related review facts are read
  at one block, with their source, age, and incomplete coverage stated. An
  unavailable or partial list never becomes an empty list or a zero balance.
- A review states who sends and receives each asset, its exact identity,
  principal, rate, collateral, term, interest mode and schedule, partial-payment
  rules, expiry, fees, protection delays, and default consequences. It
  distinguishes a vault credit from a payment to a wallet. Consent covers the
  displayed deal and is invalidated when its binding terms change.
- Amounts shown for reading may truncate toward zero to about four fractional
  digits, or four significant digits below one, with an approximation marker
  and access to every exact digit. A small nonzero amount never reads as zero.
  Typed amounts, approvals, signature limits, and maximum charges stay exact.
- Informational current values use the protocol's numeraire and valuation
  rule: principal rounds up and collateral down. An unpriced asset is named
  as valued at nothing by the protocol, a disputed price as disputed, and an
  unread price as unread. These values are not binding future prices.
- The app shows each wallet prompt's purpose. Acceptance signs the exact
  deal, makes only required approvals, then dry-runs the actual signed call
  before sending. Fees and Terms are checked again before signing. Reviews
  refresh when a new block clears a funding or eligibility block.
- Each transaction uses a fresh gas estimate with a 30% margin where one is
  available, trying the wallet provider first. Unused gas is not charged. A
  failed estimate supplies no invented limit. A best-effort batch estimates
  the work with every item required to succeed, adds the margin, and executes
  with individual failures allowed; already-invalid items are sized separately.
- Price-exposed sends use the protocol's required valid-until time, ordinarily
  30 minutes after chain time. This is distinct from an offer's lifetime.
  Rescue actions follow the platform's deadline-free rules.
- The result is measured from the transaction's own receipt, events, and
  state at its mined block. It names paid, credited to a vault, queued, held,
  refused, or unresolved results. A mined revert changed nothing; exhausting
  the gas allowance is labelled a likely gas failure. A replay at the prior
  block gives only a likely refusal, because block time and intervening
  transactions may differ. An unread reason stays unknown.
- Transactions and approval-cleanup work survive page navigation and identity
  changes. A missing receipt retains its hash and unresolved status and blocks
  another send for the same action. Restoring an approval requires chain
  evidence; an unknown outcome never authorizes a blind retry. Finish cards
  remain after a completed action removes its row.
- Before writes exposed to the public transaction queue on Ethereum, BNB,
  Polygon PoS, or Amoy, the app states that exposure and the wallet's possible
  private-send option. It does not claim to control that option or recommend
  a provider. Sequencer networks do not receive that public-queue notice.

## Home, positions, and loan servicing

- Home discovers positions by current position-NFT ownership, puts claims
  first, then deadlines and offers, and states protocol and keeper posture.
  Grouped loans show weighted rates and the weakest measured health. A net
  lending-versus-borrowing label appears only if unknown valuations cannot
  reverse it. Unpriced positions state that no price-based safety check exists.
- With two or more loans, Positions summarizes outstanding principal per token,
  separately lent and borrowed; it excludes interest and never adds different
  tokens. Rentals are counted. Side filters narrow both rows and totals.
  The next repayment, interest checkpoint, or rental close links to its loan;
  unread dates and partial inventory coverage are counted. Grace ended,
  past-due, and fallback warnings list each loan once at its most severe stage.
- Loan pages use current role ownership and the protocol's published deadlines,
  including pause credit and sequencer recovery. A grace repayment review
  counts down using chain time and says to send early: after grace a repayment
  can be refused and a default can win the race. Within the last hour it says
  to send now. A re-read, rather than the visual clock, decides eligibility.
- Full repayment remains available during a protocol pause and while an
  unaccepted sale listing or refinance request stands. Anyone except the
  lender may fund an ordinary full repayment. Fallback remains curable until
  its final claim. Accepted sales and other holds follow the platform rules.
- Repayment reviews quote now and a short later horizon capped by grace, state
  the exact approval ceiling and actual settlement, and restore unused approval.
  A partial leaves positive principal and meets the live minimum. Where the
  protocol cannot quote partial interest exactly, the app labels the full-payoff
  derived bound rather than claiming an exact amount; already-settled interest,
  unchanged period dues, and remaining reserves are disclosed.
- Adding collateral requires the current borrower, a liquid live asset, and
  no asset or swap-order hold; a protocol pause alone does not block it.
  Projected health is unknown if it cannot be established. Taking back surplus
  uses the protocol's exact maximum and dry run, names the resulting debt and
  protected route, and has no misleading Max shortcut while the ceiling moves.
- The extension card states that the network switch controls keeper execution.
  Direct extension within both parties' consents and reserve funding remain
  contract capabilities while it is off; the app does not imply a direct
  extension button exists. Reserve withdrawal requires ownership evidence.
- A refinance review fixes the exact request and expiry it quotes. The same
  expiry, payoff ceiling, signature limit, and route are sent. It expires
  30 days after review, capped by grace; after ten minutes of chain time the
  review must be renewed. Changed loan, fee, route, or bound requires re-review;
  a batch leaves an aged request out with its own reason.
- A lender sees the protocol's per-loan holding discount: the lower of entry
  and settlement, whether entry caps it, and that a later fall can lower it.
  Consent off, unread consent, absent entry records, and unsupported deployments
  are distinct. Advanced mode shows both figures, entry time, delivery mode,
  and any paid Full addition. This section is not shown as a borrower benefit.

## Borrow, lend, and offers

- Borrow and Lend each name taking an existing offer and posting one's own
  terms. Borrow's lender ladder runs from lowest rate upward and names each
  offer's individual amount; it never promises their sum as one available loan.
  Rate and Advanced LTV filters count what they hide, keep unknown LTV rows,
  and disclose unread filters instead of silently applying them.
- A request form states funded standing lenders' count, largest available
  single amount, and lowest accepted rate from one block, excluding one's
  own intents and paused aggregator lenders. Likely matching is conditional
  on protocol, matching, intent, and keeper switches and compatible terms.
  Restricted-filler intents are separate; an unread switch stays unknown.
  No guaranteed or immediate fill is promised. Full-term interest, no partial
  repayment, and no schedule are disclosed as standing-lender requirements.
- Posting uses exact asset precision, live term bounds, a rate no higher than
  100% with two decimal places, and disclosed collateral. Every supported
  lifecycle field is retained in Basic mode with guidance rather than hidden
  loss consequences. Offer expiry, the five-minute creator cancellation
  cooldown, and the fee being determined at fill are explicit.
- A one-size offer is all or none. Partial and immediate-or-cancel modes need
  an amount range with a minimum fill; immediate-or-cancel also needs expiry.
  A range match uses the largest mutually admissible amount, limited by
  collateral and origination risk; the rate is the midpoint of the rate overlap.
  Collateral rounding, unused offer capital, and separate loans per slice are
  explained without promising a smaller fill for a one-size offer.
- The live minimum offer value is 10 units of the numeraire and an account
  may hold at most 25 open offers, subject to the platform's documented
  exemptions. The creator is warned within five slots of the cap. Unpriced
  and NFT legs are not rejected merely for having no protocol valuation.
- Token choice shows the live pricing class separately from public trust
  rankings. Distrusted pricing blocks the action; an illiquid pair states
  zero protocol value, in-kind default, and absent health protection. A token
  safety screen that has not run is never represented as passed.
- Rank tiers use contract addresses on this network, never token names:
  priced top-20 blue chips, then top 100, 200, 300, and 500. Unranked assets
  carry an own-risk warning; name copies show the ranked address and a copy
  warning. Source disagreement is unverified, test assets are labelled, and
  dates and failed refreshes accompany the retained lists. Search by name,
  symbol, or address retains full addresses and gives ranked results priority.
- The interest schedule uses live admission rules at the lender's smallest
  fill, states grace and settler posture, and keeps a chosen schedule while
  its checks are unread. It blocks rather than silently removing that choice.
- Risk access is checked for maker and taker separately before prompts where
  supported. Only the taker's own block can open an in-place direct risk-setting
  action for the exact named pair. A maker's block is not fixable by the taker.
  Illiquid standing consent must already have cleared its cooldown. Pending
  raises are not resubmitted to restart the wait; an unread effective time is
  unknown. Stale Terms can return effective access to blue chip pending renewal.
- Token approvals are exact and read back, including zero-first token prompts.
  On stopped or failed acceptance the prior allowance is restored. An ERC-721
  approval covers one token and is restored only while the wallet still owns
  it and this flow's approval remains. ERC-1155 collection approval covers the
  collection for this flow, is clearly disclosed, and is removed after success
  or failure unless it was already present. Unknown receipts keep it unresolved.
- Full tariff quotes both sides' per-loan, non-refundable VPFI cost and uses the
  user's exact ceiling. Refusal offers a fresh review or an explicit choice
  without Full. The post-followed-by-Full route has a second transaction and
  a disclosed race in which the offer can fill first; no new post starts while
  that follow-up is unresolved. The lender's extra ten percentage points are
  capped at 50% with its holding discount and expire on an extension's new term.
- Advanced token-for-token offers can carry a 0.5%–50% price-move guard in the
  same transaction as posting, or add, change, or clear it later. The review
  names current protection, priceability, recorded reference, and checkpoint
  requirements; adding a guard later leaves the offer fillable until it lands.
  Missing hourly coverage blocks fills, and an unsupported deployment says so.
- A newly posted or edited offer waits the protocol's minimum terms age
  before fill. The review shows the configured wait and remaining chain time,
  offers no signing step while blocked, and refreshes each block. An unread
  duration retains the refusal rather than inventing a countdown.
- Your offers combines creator escrow with current token ownership, since
  cancelled escrow returns to its creator. Unknown historical terms are not
  reconstructed from a zeroed record. The general offer book is newest first;
  the ladders have their own stated rate ordering. Each detail re-reads chain
  standing before any action, and outcomes remain after a row disappears.

## Advanced Rate Desk and signed orders

- A market is a lending token, collateral token, and agreed term. Market
  summaries and history name their index source, deepest-market truncation,
  unread rows, and delayed standing. Lender ladders ascend and borrower
  ladders descend by rate. Added amounts are labelled market depth, never one
  fillable amount. Expired, spent, moved-position, sale, and wrong-term vehicles
  are excluded and counted. Crossed sides and the computed middle rate are named.
- The compact ticket fixes the market and accepts side, amount, collateral,
  exact rate, expiry, and minimum fill where a range permits parts. It states
  the guided defaults: full-term interest, no partial repayment, repayment-time
  interest, no rate or collateral range, no tariff, and no guard. Fill to
  balance copies the exact spendable wallet amount. Consent is per market.
- Recent loans and rate charts use opening amount, rate, and original term;
  extensions do not move a loan to another market and sale bookkeeping is not
  a new loan. Unconfirmed terms are counted separately. Seven-, thirty-,
  ninety-day, and all-time charts leave gaps where no loan was agreed, give
  keyboard-accessible figures and a table, and label the ladder midpoint as
  a reference. The chosen period persists in the page address.
- Live loans use the same chain ownership inventory as Positions. Desk history
  retains every side a wallet held, including closed positions, from the
  append-only index, newest first in pages of twenty. Older-page controls
  appear only with evidence of another row; incomplete inventory is disclosed.
- Signed orders are separate from posted offers. Signing costs no gas and
  reserves no funds; a later fill draws the maker's free vault stake. The app
  signs token-for-token, one-size, all-or-none orders with expiry, no tariff,
  and no guard. The order is built once with its nonce for review and binds
  only this network and deployment. An underfunded vault is named without
  blocking signing, since funding may change before fill.
- Publication distinguishes listed, refused with the book's reason, and
  unknown. An unknown submission retains the signature on this device and
  offers idempotent resubmission. Removing it from a book does not revoke it;
  anyone with its signature can fill it until lapse or on-chain cancellation.
- All makers' signed orders have chain-verified standing and show free vault
  backing as enough, short, or unread, with a warning that a maker's orders
  share that backing. Own orders are queried by signer and validated against
  wallet, market, and hash, so other makers cannot crowd them out.
- A signed fill uses the contract's own accept and risk previews, names maker,
  order hash, exact full fill, free backing, and each refusal. A viewer's own
  or partly matched order is not offered for whole acceptance. The maker and
  taker risk blocks are separate. Where the risk preview is unsupported, the
  review says the post-signature dry run performs it; a remedy appears only
  when the actual refusal names the taker. The receipt identifies the opened loan.
- A maker can cancel one still-fillable order or a nonce shared by several.
  The review names the remaining draw, the fill-before-cancel race, and that
  nonce cancellation also stops unseen orders on other markets or books.
  Nothing is refunded because nothing was reserved. A pause blocks cancellation,
  stale standing disables it, and the finish card verifies the cancel event.
- After an index rebuild, held signed orders are excluded from the shared book
  and counted. Their maker still sees them flagged as awaiting re-check and
  may cancel after fresh chain standing. An unread held count means incomplete,
  never zero; the signature can still be used outside the shared book.
- The match band asks the protocol about best-priced overlapping rate ranges,
  offers only a confirmed pair, and explains a skipped better pair or disabled
  matching. It excludes the viewer's own offers. The sender pays gas, takes no
  position, and may receive a share bounded above in review because the
  borrower's discount settles at fill. Capacity use and competing-fill races
  are disclosed; the result measures the actual loan and incentive separately
  from principal or refunds. A residual ranged fill can be smaller than reviewed.

## Rentals

- Owners list an exact NFT and quantity; renters may post a request naming
  them and the payment token. Daily rent is one fee, not a loan rate. The
  renter funds whole-term rent and the agreed buffer; a request fixes that
  buffer share. The owner keeps the NFT in their vault and grants temporary
  use, never ownership. Every standard and quantity is checked before prompts
  and ownership or exact delivered quantity is verified on arrival.
- Taking a renter's request shows the renter, use term, rent rule, funded
  prepayment and buffer, owner's net rent, and default consequences. It uses
  exact signed Terms and the same temporary NFT approvals as other flows.
  The outcome verifies this rental's user assignment from its own event,
  rather than inferring it from aggregate balances shared by concurrent rentals.
- Closing a rental is offered to the current renter holder in place of loan
  repayment, uses prepaid rent and buffer without a wallet approval, and
  quotes current and short-horizon rent, settled days, late fee, renter claim,
  and owner's net receipts. The horizon is not a deadline or price ceiling.
  Unfunded or past-grace closes are refused before a prompt; the finish card
  verifies closure, the actual claim, and revocation of this rental's use.
- A pause shifts late-fee and default dates and stops daily settlement. It
  never extends the renter's original use expiry. Other readers see the three
  endings: renter close, completion of daily settlement, or default.

## Claims and rewards

- Loan claims follow current token ownership and distinguish recorded zero
  claims from no claim. Ordinary proceeds credit the holder's own vault;
  withdrawal is a separate protected action. Every asset and side is named.
  A changed fallback payoff from an internal match is not compared as though
  it were the unchanged earlier quote.
- Seller-interest claims stay in individual rows outside Claim everything,
  with live fee, principal-first shortfall, oldest-seller allocation, and unpaid
  remainder disclosed. Extension reserves use authoritative owner checks.
  Indexed discovery has manual loan lookup where that can resolve a missing row;
  incomplete ownership reads cannot make a reserve appear safe to withdraw.
- Claim everything accepts at most thirty selected payouts. It may include
  ordinary claims, interaction rewards, free VPFI, standing-intent capital,
  and payroll, but excludes seller interest and fallback lender claims.
  Free VPFI and working intent capital start unselected to avoid silently
  changing fee tiers or matching capital. Simulation filters refused items;
  each item is reconciled as paid, credited, queued, failed, or unresolved.
- Reward previews state the exact next claim's bounded work. A lower bound
  is labelled and cannot enable a claim that needs an exact simulation.
  There is no zero claim unless the contract establishes it. A claim can
  instead advance a large wallet's window without payment, explicitly labelled
  as progress. Days, entries, preparation, and work left for later calls are
  stated; thirty finalized days is a ceiling, not a completion promise.
- The next claim reads at most 128 entries and a claim domain snapshots at
  most 32. Waiting outside reachable work never advances expiry. The earliest
  removal date is conditional on claimability and includes the full ninety-day
  final notice; it is not presented as a guaranteed expiry date. Rewards can
  use an existing receiving vault or the permitted wallet route, never open
  a vault just to claim, and do not promise yield.
- Rewards states this network's programme role, start time, delivered funds,
  recycled funds net of reservations, custody, detachment, and claim-removal
  posture at one block. It says running only with evidence, states a future
  start or unread fact, and separates no standing mirror funding from the
  day-specific delivery that can still pay claims. A global pause stops reward
  claims and reward withdrawals but leaves full and partial repayment and
  adding collateral available. It does not claim to monitor daily-close uptime.
- VPFI shows wallet balance, counted vault balance, free and held funds, and
  direct transfers awaiting adoption. No configured VPFI means no deposit or
  withdrawal. Deposits require Terms; withdrawals do not and retain pause escape.
  Counted VPFI is not collateral. Only home-network balances determine tiers;
  moving VPFI elsewhere does not change the home tier.
- Exact token approval is the default VPFI deposit route. A one-use, thirty-minute
  signature is optional only where Permit2 exists and is already approved;
  the app never requests the shared open-ended Permit2 approval. The signature
  names this amount and spender and is usable only by the wallet's own send.
  The receipt verifies actual counted deposit, not just a successful call.
- Fee-discount consent is separate from tier qualification. The page reads the
  applied tier from the protocol, shows raw balance qualification and each
  holding rule's explanation at the same block, and names no cause when the
  explanation cannot be reconciled. Advanced mode distinguishes minimum tenure,
  weighted average, and look-back settings. The home-network table uses live
  boundaries and fees; mirrors show the authenticated cached tier.
- Both modes show other-network tier delivery on the home network. Updating
  the source record costs network gas; first, raised, or new-table discounts
  need a caller-paid cross-chain message, while qualifying reductions use the
  protocol budget. A paid send requires a current record and quotes for every
  owed lane, sends their sum plus 20%, and refunds unused value in the same
  transaction. Sent message fees are non-refundable. Outcomes are per network
  at the receipt block. The app discloses that the table version is not readable,
  so a version-only stale record cannot be conclusively detected.

## Vault and protection

- The vault is opened only when a deposit or offer needs it. Asset reads
  distinguish actual, tracked, held, and free balances, use the lesser of
  actual and tracked where backing is short, and expose underfunding. Creator
  offer escrow remains the creator's even if its token moved. Dust hiding
  states its coverage and never makes a partial inventory complete.
- Deposits and withdrawals follow [Vault Operations](VaultOperations.md),
  including exact arrival checks, adoption of untracked balances, protected
  payout delays, pause escape, lock refusals, and outcomes measured on chain.
  A voluntary withdrawal cannot succeed as a silent zero payout.
- Basic protection enables a two-day delay with separate NFT protection off.
  Advanced mode permits delays up to five days and an explicit NFT choice.
  Unread or unsupported settings expose no protection write controls. The
  current pause-escape period is read, never assumed to be three days.
- Protection shows destinations, signers, pending changes, request codes,
  release times, application windows, and lapses by chain time. Cancels,
  applications, removals, locking, and unlock requests each have their own
  review and measured outcome; removing a destination names cancelled payouts.
  NFT protection is a holder lock, not an NFT-transfer queue.
- Every address receiving value or control is shown in full, checked for a
  valid checksum, and refused without override if its first and last three
  characters match a known address but its middle differs. A new address
  needs explicit full-address acknowledgement.
- Saved addresses are local to this browser, wallet, and network. A saved
  wallet proves control by a signature naming account, address, and network;
  an exchange address is labelled unverified with its exchange name, and needs
  acknowledgement of wrong-address loss, rejected vault deposits, and address
  reassignment. Protected destinations are chosen from these saved entries.
- Secondary signers must be verified wallets, accept with their own key on the
  correct network, and wait the account delay before activation within one
  further delay. A lapsed request is cancelled before a new one. Removal also
  waits and can be cancelled by another signer. Enabling payout co-sign is
  immediate; disabling waits. Removing the last signer disables it and says so.
  Signers may cancel, co-sign, lock, and participate in recovery, but cannot
  move funds, open positions, or add destinations or signers. Pending signer
  addresses also count as known addresses for look-alike detection.
- Name-service recipients, unknown-sender flags, test payouts, incoming-payment
  fallback, and the app's withdrawal to a saved destination remain separate
  follow-ups at this source cutoff. Displaying an allowlist does not imply
  those withdrawal controls are available.

## Alerts, settings, and user controls

- Alerts discovers wallet lifecycle events, health bands, deadlines, and reward
  expiry from the index; unread counts and unknown alert kinds are explicit.
  The header compares alert identities rather than dates. Seen state is local;
  a discovery timestamp is not presented as the underlying event time.
- Channel settings use a free, action-specific wallet signature that updates
  only changed preferences and cannot be replayed. Enabling channels needs
  Terms; disabling does not. Telegram uses a ten-minute linking code and proof
  of delivery. Protected unlink or chat replacement waits the account's own
  delay only after notice reaches the old chat; failures retry every thirty
  minutes, and the old chat may cancel. Adding the first chat or keeping the
  same one is immediate. Unread protection changes nothing.
- Telegram link and LOCK state belongs only to the agent's private store;
  testnet owners must relink after the recorded migration. A Telegram LOCK is
  not an on-chain lock: after one unanswered hour the owner is told to lock
  from the app. Pending requests hold only keeper releases; permissionless
  releases may win until the lock lands. Push remains independent.
- Paid Push is a separate per-chain consent with the current quoted ceiling,
  initially the fee and at most 50 VPFI. Its first paid alert per loan charges
  free vaulted VPFI once and is non-refundable. Fee changes above consent need
  a fresh review; Telegram is free. Revoking consent remains available during
  pause, stale Terms, or provider failure. Unsupported billing is stated.
- Approval discovery is bounded by known assets and explicit manual lookup,
  never labelled global completeness. It distinguishes ERC-20, Permit2 spending
  amount and expiry, individual NFT, and collection approvals. A revocation
  names other surviving authority, or unknown authority, rather than implying
  another approval was removed. Each action prechecks and reads back the result.
- Keeper permissions expose at most five keepers, master, action, and per-loan
  grants where applicable, all off by default. They never grant claims,
  withdrawals, or position transfers. Increasing grants requires Advanced
  review and Terms. The global keeper pause stops every keeper-role action;
  a pause is disclosed separately from permanent revocation.
- Settings show Terms acceptance as current version and fingerprint, not
  accepted, or unread; acceptance is collected on the gated action. Repayment,
  claims, and withdrawals are never held for Terms. Browser records can be
  counted and downloaded without exporting wallet sessions. Erasing disconnects
  first and removes shared preferences, local records, and saved app code,
  states failures, and leaves chain, provider, and wallet-held data unaffected.
- Installation saves only this build's code files as they are used. It never
  caches navigation pages, prices, balances, or service responses. A fresh
  page sees the new deployment. Apple devices get installation instructions
  instead of an unavailable prompt; erasure counts saved code separately.
- The test faucet states that its token and NFT outputs have no value and
  are not protocol minting. Outcomes are measured. Discount opt-in requires
  Terms when enabled, not disabled, and the protocol pause is disclosed.

## Sources

The dated reference set is [November 5](../ReleaseNotes/ReleaseNotes-2026-11-05.md),
[November 6](../ReleaseNotes/ReleaseNotes-2026-11-06.md),
[November 7](../ReleaseNotes/ReleaseNotes-2026-11-07.md),
[November 8](../ReleaseNotes/ReleaseNotes-2026-11-08.md),
[November 9](../ReleaseNotes/ReleaseNotes-2026-11-09.md),
[November 10](../ReleaseNotes/ReleaseNotes-2026-11-10.md), and
[November 11](../ReleaseNotes/ReleaseNotes-2026-11-11.md).
The [alpha05 design](../DesignsAndPlans/Alpha05AppDesign.md) supplies the shared
experience rules; dated later decisions govern capabilities and supersession.
