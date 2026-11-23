# Alpha05 Connected App Functional Specification

This document defines the intended experience of the new app in `apps/alpha05`,
consolidating the November 5–22, 2026 release decisions. It supplements the
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
  wallet connects on a supported network and completes the required Terms
  step, or enters the explicitly limited close-out-only experience. A disconnected or wrong-network
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
  terms. The lender ladder names each offer's individual amount and rate;
  instant borrowing shows each actual loan slice separately. A sum of offers
  is never promised as one loan.
  Rate and Advanced LTV filters count what they hide, keep unknown LTV rows,
  and disclose unread filters instead of silently applying them.
- A request form states funded standing lenders' count, largest available
  single amount, and lowest accepted rate from one block, excluding one's
  own intents and paused aggregator lenders. Likely matching is conditional
  on protocol, matching, intent, and keeper switches and compatible terms.
  Restricted-filler intents are separate; an unread switch stays unknown.
  No guaranteed or immediate fill is promised. The default requires full-term interest and no partial repayment; a lender
  opted into pro-rata may also fill pro-rata requests allowing partial payment.
  Counts and availability apply each intent's lend-until bound and opt-in, and
  disclose incompatible schedules rather than promising a fill.
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
- Lend opens on lending continuously (Auto-lend) as the pre-selected choice,
  with one link to a one-time offer instead; a deployment may instead ask
  the lender to choose between "Lend continuously (recommended)" and "Lend
  once" with neither selected. The device remembers the last choice per
  wallet and network. The form pre-selects, each as its own switch:
  re-lending repayments through the platform's keeper (the roll action only,
  added to what that keeper already holds), interest by time, and the
  instant market's fills, renewal and takeover consents. A switch the
  contracts would refuse is off and greyed with its reason: the instant
  consents need interest by time, the market on for the network and an
  eligible pair (an unreadable answer is "not known", never a guess);
  re-lending is never offered for the platform token, is stated as given
  where it already is, and is not pre-selected where keeper access is off
  with other keepers approved, where switching it on lists every keeper and
  the actions it would regain and needs that list confirmed. Rate auction
  bids, advances and buying existing loans stay visible and off. The slot's
  terms, funding and every chosen consent go in one transaction with every
  step required, and the review states each choice as sent, what a slot
  fills (no prepay listing or interest cadence) and that the instant
  choices are ready a few seconds after landing. Changing a slot's terms
  sends its instant consents again in the same transaction, or states them
  cleared when the new terms cannot carry them. Free vault balance is never
  lent by any of this.
- Auto-lend has no end date unless the lender states one: "Lend for a set
  period" is a choice, off at the start. Re-lending a repayment is
  pre-selected only where the platform's keeper reports that step running on
  the network, and the form says when it is not running or not known. Until
  loan renewal is built, renewal is shown as not available yet and no renewal
  consent is sent. The review says what "no end date" means here, and that
  funds in a loan come back when it is repaid, sooner only by a handover at
  face value (where deployed) or a sale available at that moment; no date of
  return is promised.
- Borrow opens on "Borrow now": the borrower states the amount, the most
  collateral, the term and the highest rate (no rate is suggested). The
  review is the protocol's own answer for the borrower's wallet in that
  block, labelled as what this block gives, listing each loan with its
  lender, rate and collateral. Signing asks again just before the prompt and
  never borrows less than the figure shown. Collateral comes from the vault's
  free balance first, then the wallet, approved for exactly the wallet's part
  and naming the contract it is given to. Where the lenders ready cover part,
  the borrower may borrow that part and then post a request for exactly the
  rest; where they cover none, or the market is off on the network, the
  review says nothing is borrowed now and offers a request. Every loan ends
  on its due date; it does not renew.
- An Auto-lend that already exists gains no instant-market consent until
  its owner signs for it. Where the market can take its pair, its card
  offers one line that opens a review of those consents alone, each
  pre-selected and switchable; it moves no money and changes no limit.
- Every Auto-lend starts with lending paused while the collateral price is
  moving fast. Its card states, from the protocol's own answer, whether
  fills may go ahead, are paused and why (a fast move, the pair lacking its
  last two hourly price checks, no readable price), or the owner switched
  the pause off; a paused Auto-lend never reads as "no matches". The owner
  may switch it off or back on for one Auto-lend through a review that moves
  no money, and the setup review says the pause starts on and what off means.
- An active Auto-lend with money waiting can say why it is not lending.
  The app asks the index for the open borrow requests on its pair closest
  to its terms, then asks the protocol whether it would fill each from this
  Auto-lend now, and states the closest one's first refusal in the
  protocol's terms, a fill it would take, or that no request stands. It
  never promises a fill, and an index that does not answer is said as
  unknown, never as an empty pair.
- A live loan's page says what the loan is to the side the reader holds:
  a fixed-rate loan for its term that does not renew (until renewal is
  built), that lent funds cannot be withdrawn, and, for the borrower,
  whether repaying early pays interest only for the days used. The date row
  is the date the loan falls due, never a date funds come back.
- The lender holder of a live loan has one door, "Get cash from this loan":
  Leave it comes first, then Sell now (a handover to another lender at face
  value where the instant market's takeover takes the loan, or a sale into a
  standing buy offer) and Sell at my price (a listing at the lender's stated
  rate). Each route states what the lender receives as the protocol states
  it, and that interest earned and not yet paid stays theirs. A route that is
  not open names each reason in the protocol's words and when it can open,
  or that no time is set.
- The Vault page shows each token on three lines kept apart: the free
  balance (the only figure Withdraw offers), capital waiting in Auto-lend
  (taken out of the Auto-lend as its own step), and principal in loans,
  labelled "in loans, not withdrawable".
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

## Offer changes, matching guidance, and signed protections

- Before a post, an already-takeable opposite offer is presented only if it
  fits every typed limit: term, interest mode, partial repayment, schedule,
  amount range, rate, and collateral for that amount. Taking opens the normal
  review at that offer's terms; posting remains an explicit alternative.
  Drafts with Full tariff or a price guard are not offered this shortcut.
  An old book is labelled stale, and nothing is automatically taken or posted.
- A pro-rata lender's term is its maximum exposure term. A pro-rata borrower
  may match a same-term or longer lender but always receives the requested
  borrower term. A direct taker receives the offer's full term. Full-term
  interest still needs matching terms. Setup and review state that shorter
  pro-rata loans earn interest only over that shorter period.
- An open own offer explains its closest opposite candidates using live
  protocol previews. It distinguishes no counterparties, matching off, a
  currently matchable pair, and a confirmed rate, term, or lifecycle gap.
  Unread candidates are unknown. A rate gap links to the in-place rate edit,
  prefilled to close it, without promising a match or taking another offer.
- Eligible open loan offers edit their rate and amount ranges and token
  collateral without cancel/repost. Refinance requests edit only rate; terms
  and repayment options require reposting. Rentals, sale and early-close
  vehicles, expired or ended offers, and other owners' offers are excluded.
  Pause and standing sale-order refusals are named.
- Edit review states old and new figures, checks live shape and filled amount,
  pulls only extra required capital with exact approval, and returns a decrease
  through the payout rules. Rate-only changes move nothing. Terms seasoning
  restarts and backstop opt-in ends. Pre-send simulation runs after approval
  where needed, unused approval is restored, and receipt evidence verifies
  both the new figures and actual funds movement.
- New signed orders cap both protocol fees at the rates reviewed. Changed
  fees refuse posting; fee rises above a signed cap hold fills only while
  above it and do not cancel the order. Nonces meet the maker's cancellation
  floor, which can only rise. Old signed shapes are not fillable after the
  contract transition and the book removes them.
- Contracts also permit a named taker, a fresh per-fill co-signer approval
  expiring within fifteen minutes, and up to 32 independently lived offers
  under one readable set signature. The apps currently sign single orders
  without taker or co-signer restrictions. Restricted depth has no Fill action
  when this interface cannot satisfy the restriction. Set placements accompany
  all supported fills and previews; malformed placements are unfillable.
  A set-signing screen, co-sign service, taker choice, and cancel-all control
  remain follow-ups. Contracts and book support alone do not offer those UI
  controls, and signed fills need compatible freshly deployed contracts.

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
  remainder disclosed. Payment reserves use authoritative owner checks.
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
  follow the vault-only delivery rule below and do not promise yield. An unavailable
  receiving vault is not silently presented as a successful vault credit.
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

### Reward delivery, waiting reasons, and paid history

- Every account kind receives rewards in its own vault, including contract
  wallets and delegated accounts. The supported claim route opens a vault when
  needed. There is no Advanced wallet-delivery choice or silent wallet fallback.
  A refused credit cannot be presented as paid. Counted home-network vault VPFI
  affects the holding tier; mirror holdings do not establish a home tier.
- The review and outcome name the actual vault credit and separate subsequent
  withdrawal. Protected withdrawal retains its delay. Claim everything uses
  the same route. Rewards come from the rewards phase, without a promised
  return; until holding discounts launch, the app says no holding discount,
  while still showing any substantiated referral or other fee reduction.
- The claim card explains the exact blocking day at the claim's read block:
  reporting or finalization waits on the home network, broadcast or each
  funding component on a mirror, or mismatched declared wholes that require
  a possible unpaid close. It names the permissionless clearing step, says
  later days wait behind it, and never suggests the wallet's own setting fixes
  it. Detached networks offer no fictitious remedy; unconfigured reward roles
  say no day can yet be finalized or claimed there.
- Funding refusals separate exhausted fresh allocation, live reservations,
  insufficient recycled backing, and insufficient local holdings, using the
  protocol's needed and free figures. Unread facts stay unread. Recycled VPFI
  can pay later claims even after fresh allocation is exhausted.
- Lifetime claimed totals come from indexed payment records on this network,
  with the paid UTC day and coverage timestamp. They include released held
  rewards. Historical wallet payments remain identifiable in past totals;
  they do not imply a wallet option for a new claim. Incomplete or unread history is
  unknown, never zero; a confirmed claim refreshes the total.

### Claim and withdraw

- Every loan-claim entry offers Claim and withdraw as the lead and Claim to
  my vault as the alternative, including Claims, loan details, and Claim
  everything. The review explains that the claim credits the vault and each
  asset withdrawal is a separate reviewed transaction and wallet confirmation.
  Single-confirmation batching is not yet available.
- After confirmation, withdrawals use only the exact assets and credits in
  that claim's events, including an asset received by a claim-time match.
  A changed review quote is never used as the credited amount. Protected
  withdrawals queue under the vault's delay. A refused, failed, or abandoned
  withdrawal leaves the successful claim's funds in the vault and offers retry;
  a completed withdrawal is not offered again. Pending follow-ups retain their
  state, keep the finish card open, and run only on the same account and chain.
- Claim everything withdraws only its loan-payout legs; other rows keep their
  disclosed routes. Open-loan receipts use the position's current claimable
  held amount; they are never shown as already received wallet payments.
- Home and Claims total Ready to claim per asset using the same eligibility
  verdict as each row. Waiting, unread, and fallback-variable amounts are
  counted separately, never added as fixed receivables or described as received.

## Vault and protection

- The vault is opened when a supported deposit, offer, or reward claim needs it. Asset reads
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
  NFT protection is a holder lock with the qualified protected sale and
  handover exits in [Vault Operations](VaultOperations.md); it has no NFT-transfer queue. Protection
  changes read and write the vault directly. Contract relays await the Stage B4
  app surface; owner lock and proposed-replacement alerts await vault-event
  indexing, and only ledger-discovered matured changes are keeper-finalized.
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

### Recovering an uncounted asset

- Recover discovers the token kind from the asset, reads the exact uncounted
  amount and identifier, and accepts the Vault page's asset identity link.
  Unknown standard or unread balance prevents a guessed adoption.
- Adoption names the source, displays the exact declaration, requires typing
  CONFIRM, then a declaration signature and a transaction. It credits ownership
  without movement; later withdrawal retains protection. Replaced wallets,
  unsupported contract-account declarations, existing bans, sanctions, absent
  sanctions service, pause, or a mismatched declaration are named in protocol
  order. Unknown checks prevent signing.
- The source is screened before signature and again immediately before send.
  A flagged or unread source is not sent even when simulation would succeed:
  the contract deliberately records a ban without credit rather than reverting.
  A later source flag is still possible and disclosed. Delisting the recorded
  source lifts the ban and permits a new adoption without erasing its history.
- Disowning records non-ownership publicly and credits or moves nothing. It
  needs no declaration, message signature, or sanctions screen, and remains
  available during pause, a ban, or account retirement. Pause escape links to
  the Vault page rather than suggesting adoption releases funds by itself.

## Public transparency, activity, and risk disclosure

- Analytics and Protocol Console open without a wallet on one named served
  network, selected explicitly or from wallet/default context. Analytics reads
  contract figures at one block, with deployment start, age, and per-field
  unknowns; it does not describe index figures as contract measurements.
  A future block time means unknown age; a failed refresh retains the last
  block with a stale label. A rate without a denominator is absent, never zero.
- Analytics shows open and total loans and offers, participants, and agreed
  rates. It withholds a default-rate calculation while the protocol's closing
  counter also counts ordinary repayment. Current loan valuation and historic
  lending totals are valued now; unpriced assets count as nothing and are
  individually listed as omissions. NFT collateral is counted, not valued.
  Interest includes borrower payments, not collateral recovered after default.
- Fee history states collection-time valuation, omitted unpriced fees, and
  bounded-scan day/week lower bounds. The treasury is named from current vault
  code; pinned vaults can pay an older treasury. Earlier Diamond treasury
  holdings remain visible within their stated open-loan asset discovery limit.
- Token facts use reported name, symbol, decimals, and supply. Unread decimals
  show base units, never an assumed precision. The home network reports cap,
  initial mint, remaining headroom, minter, and owner; a governance wait is
  claimed only when actual ownership supports it. Mirrors report local supply
  and the home cap, not a zero cap. Deployment-record discrepancies are flagged.
  Published allocations are maximum mint headroom, including the undecided
  24% reserve, not already-issued balances or a promise of price or return.
- Protocol Console accepts a named, dated index snapshot younger than one day
  only if not behind an observed governance change. Otherwise it reads the
  chain at one block and explains why. An older chain answer cannot replace
  a newer snapshot. Missing, future-dated, stale, or incompatible-code evidence
  is labelled rather than interpreted as unset. Zero is called unset only
  where that setting's meaning supports it.
- Console names switch classes, affected actions, live global pause, and rescue
  paths; unimplemented reads remain listed as not read. It describes a subset,
  separates totals from settings, and does not invent keeper posture. A config
  change is not said to reprice existing loans.
- Activity queries the wallet's own full indexed history, including events
  on every position it held and events directly concerning it. Transactions
  group their events, retain the recorded wallet, identifiers, explorer link,
  known amounts, and boolean outcomes. No recorded amount means no amount
  recorded. Pending events are first, not final, without an invented time;
  inferred loan endings say what was and was not seen. Incomplete historical
  backfill, unread rows, and service failure are disclosed instead of an empty
  or complete-history claim.
- Before connection, Home and the wallet picker state that users bring a
  self-custody wallet, control and protect their own keys, and lose access if
  keys are lost. Brand-neutral guidance explains recovery phrases and phone
  and desktop connection. Dismissing the picker leaves Connect usable; only
  session restoration is labelled Connecting.
- Terms prompts show the approved key risks: irreversible uninsured loss,
  borrower collateral loss, lender recovery shortfall, software/oracle/token/
  network failure, wallet responsibility, and no financial advice. Loan and
  rental reviews include the side-specific downside; future fills explain
  both liquid and illiquid outcomes because liquidity is checked at fill.
  The public Key risks page also covers depegs, delayed or wrong prices, local
  tax and law responsibility, and third-party wallets and networks.
- Taking an offer, for either side, shows "What happens if" under the
  side's downside line, labelled an illustration and not a forecast, with
  amounts for this loan: what a 30% fall in the collateral price does to the
  loan-to-value against the liquidation threshold the loan would carry, and
  roughly how far the price can fall before liquidation starts (or that no
  price-based liquidation applies, or that the figure could not be read); a
  late repayment (a late fee, then the default once the grace period for
  this term ends); and an early repayment (the whole term's interest still
  owed, or about half the interest halfway through a pro-rata loan, with the
  initiation fee not returned). The late fee's amount is shown once the
  protocol publishes its schedule: the current schedule is 1% of principal
  for the first late day plus 0.5% per further day, capped at 5%. Unread live
  settings remain unknown; the illustration never silently assumes them.
- A published Terms version takes effect for acceptance only after it is
  configured on the network. Earlier frozen versions remain unchanged.
  Version 3 rewords the software and network risk line, which now ends
  "These risks come with every blockchain system"; the app's key-risk list
  carries the same sentence as the Terms text. Version 4 adds to the lending
  risk line that lent funds stay in the loan until the borrower repays and
  cannot be withdrawn before that, and that a sale of the loan to another
  lender is possible only if one accepts. The list stays at six entries, and
  the app's lending entry carries the same sentences. The approved
  clauses describe the interface's non-party role, non-custody, eligibility,
  as-is service, indemnity, and a liability ceiling of the prior twelve months'
  fees bounded between $10 and $1,000; governing law and dispute handling are
  not invented where the approved version omits them.

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
  accepted, or unread. The connection journey below collects acceptance
  before wallet data; close-out-only access remains available. Repayment,
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

## Connection consent and fresh wallet evidence

- Before Connect, the app presents the pinned Terms version and complete
  fingerprint, privacy notice, and six approved risk statements. Connection
  follows the acknowledgement. Once connected, the account accepts on each
  network by its own transaction before wallet data loads. No signature or
  remembered browser checkbox stands in for chain acceptance.
- If that transaction cannot be sent, the app states the low-gas need or other
  hold and offers close-out-only access or disconnect. Close-out access keeps
  repayment, claim, withdrawal, and cancellation available without inventing
  consent to new exposure. The app names other-network offers or intents that
  may be affected by Terms; it does not claim to have checked all loan
  extensions and instructions when those checks are not built.
- Before every write or signature, the app checks the live wallet account and
  network again. A changed binding figure clears consent and explicitly says
  no wallet prompt was opened. Wallet-provider checks have a fifteen-second
  budget before trying another source.
- After token or NFT approval, the dry run uses a source that has reached at
  least the approval's receipt block and pins the call to that source's head.
  Lagging sources are retried briefly or skipped. If all lag, the result is
  unread, never a protocol refusal based on stale approval state.
- A fixed-terms approval can use thirty minutes, twenty-four hours, three days,
  or seven days; price-sensitive approvals remain thirty minutes. Signature
  and transaction share the selected deadline, but this does not merge the
  separate approval rounds. Asset-adoption declarations retain their supported
  thirty-minute or twenty-four-hour choice and single-key support limit.

## Auto-lend management and market comparison

- Setup reviews the asset, amount, rate floor, maximum LTV and term, optional
  end date, pro-rata choice, exposure cap, and minimum fill. Amounts parse
  exactly, use the live minimum and maximum, and receive exact approvals with
  restoration after failure. Terms and funding are atomic. Eligibility still
  waits the protocol's terms age; setup never guarantees a borrower match.
- Add funds requires an active, unexpired intent and unpaused assets and
  protocol. Withdrawing unlent capital remains available during an asset pause
  but not global pause; stopping remains available during global pause.
  Stop and withdraw is atomic where allowed. A stopped slot with no reserved
  capital leaves the manageable list even if it still has outstanding loans;
  a completed action's result stays visible after the row disappears.
- Editing or restarting preserves unchanged exposure, minimum fill, and
  restricted-keeper choices, allows zero added funding, restarts terms age,
  and renews the relevant priority choice. Existing loans do not change.
  A cap at or below principal already out admits no more fills until capacity
  returns. A minimum above the cap or usable capital prevents a fill.
- Summaries keep assets separate and use downward-rounded shares. Slot
  principal means exact outstanding principal, not the original fill or a
  sold position. Partial repayment lowers it immediately; terminal settlement
  releases it before claim. Dropped slots' loans may be absent from the
  on-chain slot list; the app discloses that coverage gap rather than claiming
  a complete loan inventory. Stopped or ended capital waiting is separate.
- Declared limits, funded Available, and principal Lent keep their distinct
  [platform meanings](ProjectDetailsREADME.md). Fullness divides slot
  principal by that principal plus Available, never by Declared. Date-bound
  aggregates state their UTC-day basis and seasoning does not itself remove
  declared or reserved capital. A fill's fresh preview remains authoritative.
- Indexed history can show a slot's capital usage and comparable-rate samples,
  naming sample size, time, and coverage. Missing slot events make this
  unavailable, never a speculative average or a recommendation.
- Instant-borrow comparison lets the borrower choose the best rate or fewer
  lenders within their own stated rate difference. Both alternatives show
  principal, number of loans, and estimated weighted rate. No option is
  recommended and an allocation preview does not prove loan admission.

## Account, embedded use, and personal context

- Unrecognised assets are closed by default with a count. Indexed candidates
  are verified against the exact vault and asset at one chain block. The app
  shows plain labels and addresses without images or external links and sends
  no alert about unsolicited assets. Adopt and Disown are neutral choices.
- Position approval shows the full approved operator and offers per-token
  revocation. A deployment needing two protection prompts says when protected
  mode succeeded but NFT locking failed, and offers retry; it cannot claim
  full protection. The intended atomic contract rule remains in Vault Operations.
- Outflow alerts offer Default, Always, and Never. Default enables them for
  protected accounts; it is not a delivery guarantee or an authority grant.
- A registered integrator link names its origin and network, and reads active,
  suspended, unregistered, or unread status from the registry. The user can
  remove attribution or stop the link. Borrow reviews show the actual fee;
  lender attribution earns no share, and rentals carry no integrator share.
- A third-party payer acknowledges the current borrower before paying; the
  app rechecks the holder before send. Watchers and alerts grant no authority.
  A guided lender-position giveaway states that future claims follow the
  receiver while past seller interest remains owed to the seller.
- Local saving goals and borrowing-for-someone notes stay on this device;
  they neither lock funds nor bind another person. Partial or unread history
  makes goal progress unknown, not an invented completed target.
- Multisig embedding permits exactly one approved HTTPS parent origin.
  Cross-origin manifest and icon access is limited to that parent, and an
  ancestor handshake is required. A hidden or wrong parent cannot connect.
- Shared token-label and export rules follow
  [public data and diagnostics](PublicDataAndDiagnostics.md#issuer-powers-and-token-labels).

## Multisig alert authorization

- An own-key authorization, including a delegated account, lasts ten minutes.
  A contract-only authorization uses that contract's signature check on the
  named network and may last seven days. A timestamp more than ten minutes
  ahead is refused; replay protection lasts the full authorized window.
- The browser binds a secret's hash into the signed request and keeps the
  secret locally. Only that browser can finish the pending request. Pending
  work survives until the service records its answer; an early rate refusal
  or service error is retryable. Exporting pending records excludes the key.
- Link and unlink ordering is per wallet and network. A global own-key unlink
  advances every network's order, and settings have their own ordering record.
  An older request cannot undo a newer change. Test alerts are not settings
  updates; unlinking voids outstanding link codes.
- A Safe request waits while proposed and finishes when approval is confirmed
  on chain or its service supplies the combined signature. Account or network
  changes hold the request. New alert links and Push consent require current Terms.
  Discarding clears only this browser's pending request, never another tab's
  newer one. A remembered Push refusal is not overwritten by a later refresh.

## Alert phrase and chat-change notices

- An owner with a linked private Telegram chat may set or remove a phrase by
  a signed alert request. The service accepts the phrase exactly as typed,
  from three to thirty-two permitted plain characters, without surrounding
  spaces, links, slashes, colons, or at signs. Invalid text is refused, never
  silently cleaned. The signed text contains a request-key-bound fingerprint,
  not the phrase; a mismatch is refused. Phrase changes have their own ordering.
- A request signed with the wallet's own key sets the phrase across networks,
  replacing network-specific phrases. A contract-only approval sets it only on
  the named network, where a private chat must already be linked. That phrase
  takes precedence there. The newest applicable request wins across scopes;
  an old request cannot undo a newer network or global setting.
- Each private chat starts messages with the phrase it was last told for that
  wallet and network. A phrase change first sends a notice led by the phrase
  the chat knew, and switches only when Telegram accepts that notice. A newly
  linked chat receives no phrase until it is set again; the same chat linked
  on another network already knows it. A manager's chat uses the manager's
  phrase. Groups and Push never receive the phrase, and the app explains this.
- Status shows only whether a phrase is set, since when, and its scope. A
  pending contract-wallet request keeps no phrase in browser storage; finishing
  requires typing it again and matching the approved fingerprint. Applying the
  phrase on another network requires a separate approval and re-entry there.
- An unprotected account's old chat is notified when it stops receiving alerts;
  existing chats are notified when another chat is added. Notices use each
  chat's known phrase, try immediately, and retry for at most one hour. An old
  chat identity is kept only for that notice. Consented Push gives a notice
  naming only the network. Protected accounts retain the delayed chat-change
  procedure, with the known phrase on its notices as well.

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

Additional dated sources: [November 12](../ReleaseNotes/ReleaseNotes-2026-11-12.md)
and [November 15](../ReleaseNotes/ReleaseNotes-2026-11-15.md). No November 13
or 14 dated release exists in this range. Later intent already present in the
platform specification remains governing, including newer Auto-lend controls.

The [November 15–22 source map](README.md#release-note-consolidation-november-15-through-november-22-2026)
adds Auto-lend management, receipt-aware approval reads, Terms, vault-only
rewards, account context, and multisig alert authorization. Later intent
already present in this document, including default journeys and the
price-move pause, remains in force.
