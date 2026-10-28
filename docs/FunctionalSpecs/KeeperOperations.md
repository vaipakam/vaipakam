# Keeper Operations Functional Specification

This document describes the intended behavior of the protocol-operated keeper.
It consolidates the operational decisions in the release notes from August 13
through October 27, 2026, while retaining later recorded intent decisions.
The deployment destination incorporates the owner's
October 27 direction: a dedicated Cloudflare database and a separate always-on
keeper VM in Oracle Cloud. This is the required deployment arrangement, not
evidence that the migration has completed.

## Runtime, data, and authority

- The keeper runs on its own always-on Oracle Cloud VM. Its scheduled duties
  do not also run in a Cloudflare Worker. A legacy scheduled invocation does
  no keeper work and reports why it declined.
- Keeper operational state lives in its dedicated Cloudflare database. This
  includes scan progress, pending work, prior acknowledgement attempts,
  health-factor band memory, reward observation work, and the deployment each
  chain's records belong to. Other services must not write that state.
- Shared user-facing records remain with their owning services: alert
  preferences, the inbox, Telegram links, indexed events, and shared oracle
  and liquidity observations. A dedicated operational database does not turn
  those records into keeper-owned data. A keeper inbox notice must still reach
  the user's shared inbox.
- The keeper requires both its operational store and the shared data it uses
  to be available. Missing access or required database changes hold the run
  and produce an operator-visible reason. The VM does not silently create,
  copy, or migrate state during a tick.
- Moving state must preserve completed-work and prior-attempt records. A
  verified copy is made while the keeper is stopped, so a restart cannot
  repeat paid acknowledgements or notifications because its memory was lost.
  Retired shared copies are not a fallback source and must not be recreated.
- Access must follow the separation of duties. If the VM's database
  credential can reach more than its dedicated database, that broader access
  is disclosed to operators; a dedicated database alone does not prove a
  credential is restricted to it. The VM administrator's ability to read its
  settings and signing key is disclosed as well.
- The keeper is a convenience service. Permissionless actions remain open to
  other eligible callers, and no keeper schedule guarantees a fill, an
  extension, or a successful liquidation.
- Delegation permits only the actions the position holder granted. Keeper
  approval never permits claims, withdrawals, position transfers, or changing
  the destination of another person's funds. Position ownership and the
  protocol's live authorization rules remain authoritative.

## One runner and safe deployment adoption

- Only one keeper runs for a signing key. A shared lease prevents another
  instance from starting ticks while the first owns the lease. A missing
  identity or unreadable lease holds the tick.
- Lease time is judged by the database's clock. Renewal occurs every minute,
  including while a prior pass is running; an unrenewed lease expires after
  ten minutes. A renewal failure is logged and retried. The lease cannot
  cancel work that began before a handover, so operators still stop the old
  runner before bringing up its replacement.
- A slow pass does not start a second copy of itself. Other passes due that
  minute may run, and all sends on a network retain their common ordering.
- Each chain's operational records belong to a specific deployment. Before
  working, the keeper confirms that the indexer has finished adopting the
  same deployment. A disagreement or unreadable adoption state holds the
  tick across chains, including liquidations.
- A deployment change clears only the obsolete state for that chain, verifies
  the reset, and records the new deployment after the indexer has completed
  its own reset. Interrupted resets are retried. Unattributed existing state
  is a reason to stop, not a reason to assume it belongs to the new contract.
- Already-running work checks adoption again before signing or sending an
  alert. A shared-record write applies only if adoption still matches as
  part of that write. A reused loan number must never receive an old
  deployment's transaction or notice.
- Updating or stopping the VM lets work in flight finish. A failed build
  leaves the running release intact. Builds cannot read the keeper's key or
  settings, and the installed release uses its matching service settings.
  A hung stop requires operator action; it is not killed on a timer between
  sending a transaction and recording it.
- The VM installs a release built by CI from the main branch; it does not
  build the keeper itself. Installation requires verified provenance for the
  exact downloaded bundle, this repository's approved build workflow, and
  matching source on main. An uploaded asset alone is not authority to run it.
  Missing verification tools, an invalid attestation, a failed load check, or
  an unavailable bundle leaves the running release intact and states why.
  A merge that leaves the keeper's build source unchanged requires no new
  bundle or restart. The installed service settings belong to that release.

## Fresh decisions, bounded work, and transaction outcomes

- Transactions using one signing account on one network are submitted in
  order. Work on another network is independent. A rejected unsent action
  cannot reserve a transaction number indefinitely; a broadcast whose result
  is unknown must not be replaced as if it had never reached the network.
- Every transaction the keeper sends carries a gas limit above the node's
  estimate by the repository's one fixed margin, unless the call names its
  own limit. A node estimates against the latest block with no margin, and
  the transaction mines in a later block, so a call whose cost moves with
  time would otherwise run out of gas at the bare estimate. Unused gas is
  not charged; the keeper's account must still hold the fee for the higher
  limit for a send to be accepted.
- Every pass has a finite deadline. Ordinarily it is the scheduled minute
  plus the pass's cadence, less a thirty-second margin. A send whose queue
  slot or preparation reaches that deadline is deferred without broadcast.
  The next run starts from fresh state. Logs distinguish this from a failed
  transaction and never imply a transaction exists when nothing was sent.
- A pass's reads stop early enough to leave its sends their time: every read,
  of any kind (a view, the chain's clock or id, a simulation), stops at the
  read cutoff, which sits a send reserve before the deadline. A read not yet
  started there is not made, and one still waiting is abandoned. Either way
  the value counts as unread and is read again next run. A pass that reads in
  stages gives each earlier stage an earlier cutoff, so a slow stage cannot
  use the time of the stages after it.
  This covers the reads an action makes just before it sends, its route
  quotes included: a default, liquidation or periodic settlement whose
  checks are not finished by the read cutoff sends nothing that run and is
  tried again on a later one. A scan that runs out of time keeps the loans it
  did read and reports the rest as unread.
  The chain's finalized block, which decides whether a stored floor may
  move, is read under the same rule: when it does not come back in time the
  floor stays where it is until a later run.
- The daily oracle snapshot has a separate deadline one hour before the end
  of the UTC day being captured. It records the day the mined block actually
  filed, reports a different day explicitly, and records no successful
  capture for a reverted transaction.
- Chains run independently. Long lists rotate their starting point between
  runs, including within pages, so a repeated time limit cannot starve the
  same tail. Reading stops early enough to leave time for actions already
  planned. A partial scan is reported as partial and retains its progress.
- Open work stays queued until chain state proves completion. Age, a fixed
  recent-history window, or the size of a backlog cannot erase it. One
  unreadable or permanently blocked item cannot hold up the rest.
- A submitted or mined transaction is not automatically a success. A revert
  is reported as a failure; an unanswered broadcast or missing receipt has
  an unknown outcome until chain evidence resolves it. A later receipt has
  the same status as one seen immediately.
- A transaction that landed stays reported as landed. When the keeper reads
  the chain afterwards to see what the transaction did, and that read fails
  or the run's time runs out, the report still lists the landed transaction
  and says its result is unknown. It never drops the transaction, and never
  presents an earlier reading as the result.
- Operator-managed tuning survives deployment. Shipping a release must not
  silently reset liquidation thresholds, confidence windows, or arming
  choices. Signing keys and settings whose presence enables transactions
  are treated as secrets.
- Error reports, stored failure reasons, and operator alerts remove provider
  addresses and credentials before becoming text. They retain useful refusal
  names and identifiers, so redaction does not hide why an action was skipped.

## Liquidation, default, and standing intents

- Liquidation and past-grace default follow the loan's authoritative status,
  effective deadlines, current position ownership, sale holds, and protocol
  previews described in [the platform spec](ProjectDetailsREADME.md).
  Collateral changes invalidate an old quote. A failed or unanswered venue
  lookup is not proof that no venue will quote.
- Illiquid loans and rentals with no collateral have no price-based health
  factor. That is an expected result, not a zero health factor or an RPC
  outage. It does not remove time-based default handling.
- Registered, enabled liquidation routes come from live protocol
  configuration. A venue failure does not authorize an arbitrary recipient,
  swap destination, or weaker repayment protection.
- Matching and standing-intent fills respect solver capacity. Once ordinary
  capacity is exhausted, the pass still considers opted-in intents whose
  priority credit the protocol says would unlock a fill. Each fill is
  previewed, and shared per-run time and action limits still apply.
- A priority credit is consumed only when a fill would otherwise be refused
  for capacity. It grants no exemption from offer bounds, collateral safety,
  sanctions, or another authorization requirement. If the deployment cannot
  answer whether a credit unlocks the fill, the keeper sends no such fill.
- A partial liquidation is sized from the liquidation threshold recorded on
  that loan. An unreadable loan is left alone. A refused slice is resized
  within the known lower and upper bounds rather than retried unchanged on
  every tick. A slice must cover accrued interest in full; a short slice is
  increased using the refusal's stated repayment and interest due. The keeper
  moves to a split or full close only when no permitted partial slice remains.
- Each split-sale leg must independently clear its proportional oracle floor,
  rounded up, as well as the combined floor. The keeper chooses the best
  qualifying pair only when its improvement justifies splitting. No qualifying
  split means a single-route attempt; a later on-chain refusal can still occur
  because prices move before inclusion.
- The discounted flash-loan route requires the operator's selected-chain
  enablement, a deployed receiver and provider, and the protocol's own switch.
  An empty chain selection arms nothing. Start-up and skipped-loan reports
  disclose missing enablement or infrastructure. The route respects the same
  internal-match priority window as every external liquidation route.
- A discounted run uses the protocol's debt and seizure preview, sells only
  that seizure through a registered, enabled swap venue, and simulates the
  exact call with its real flash-loan fee. The required profit covers the
  keeper's whole transaction fee in principal-token units. An unpriceable fee,
  a refused preview, an unprofitable simulation, or a short token arrival
  prevents the run. Prior profit or collateral cannot subsidize a losing run.
- Offer matching considers each live offer once per run and each eligible
  pair at most once. A maker's own opposite-side offers are skipped together.
  Standing-intent sizing searches upward after a minimum-size refusal and
  downward after a capacity, collateral, or risk refusal; a dust refusal is
  not proof that every larger fill would fail.
- Auto-roll is reserved for proceeds worth at least one hundred times the
  complete transaction fee, using protocol prices and every fee component
  the chain charges. An unreadable fee component is not zero. VPFI-principal
  loans, transferred positions, reserved or held proceeds, and other loans
  requiring the ordinary claim are left to their owners and counted as such,
  rather than reported as failed fee estimates.

### Periodic settlement and in-place extension

- Periodic-interest settlement has its own fifteen-minute duty and ships
  disabled independently of the master keeper switch. It advances a fully
  paid checkpoint without a sale, or quotes exactly the collateral the
  protocol sizes for the unpaid interest. It leaves an unhealthy loan to
  liquidation and a loan past maturity grace to default handling.
- Immediately before sending, it rechecks those conditions and the sale size
  at one fresh block, and simulates the exact settlement. A changed size or
  failed simulation holds the send. A price change before inclusion can
  still cause a revert and cost gas; a preview is not a completion guarantee.
- An in-place extension is considered only inside the protocol's window:
  from three days before effective maturity, never during the first day of
  the term, through the effective grace end. Its new maturity plus grace
  cannot precede the current grace end. An unreadable window holds the loan.
  On older testnets without this read, the keeper applies the same window
  and grace protections itself until the fresh deployment replaces them.

### Compatibility with older deployments

- The intended forced-sale behavior is the sized, sell-only-what-is-needed
  rule in the platform spec. Until the older testnets are replaced, the
  keeper checks which sale form the deployed protocol supports and previews
  or simulates that exact form before sending. Older whole-collateral sales
  still return the surplus; they are disclosed as compatibility behavior,
  not described as sized sales. A failed routing read holds the attempt.
- A default checks the sale form again at its final gate. An unsupported
  exact call never reaches broadcast. Split sales and the periodic settler
  are not attempted on deployments without the sized-sale plan. These
  temporary paths are removed when the served testnets are freshly deployed.

### Liquidity-confidence relay

- Promotion to the deepest liquidity tier requires evidence that the asset
  is enabled as collateral with positive loan-to-value on an Aave v3 or
  Compound v3 market meeting the configured chain-local liquidity minimum.
  Market capitalization or trading volume must support that evidence; they
  cannot replace it. Supply-only or permissionlessly listed markets do not
  establish this qualification. Turning the collateral-evidence check off
  permits no such promotion.

## Reward delivery proofs and acknowledgements

- A mirror lands each budget delivery's one day in the transaction the
  delivery arrives in (#2828), so no indexing or proof is left for anyone to
  send afterwards, and the keeper has no delivery-proof pass. A day waits
  only on its own parts arriving.
- A mirror day whose delivered parts disagree on the day's whole never
  opens, and nothing can repair it. Operators are alerted as soon as the
  conflict is recorded, told when the day may be skipped or what the skip
  still waits on, which the keeper reads from the contract itself. Once the
  contract allows it, the keeper skips the day (closing it unpaid on that
  mirror, so later days move again) and then moves whatever landed for it
  into that mirror's recycling pool, until nothing is left. What was given up
  and what moved is reported from the chain's own records, never from the
  keeper's estimate. A day that opened before its parts disagreed stays paid
  and is reported as a source fault. A day that cannot be skipped because a
  side whose claims may already have paid carries recycled funding is an
  incident for a person: the keeper reports it and never retries the skip.
  Such a day, and a source fault, leaves the keeper's work only once its
  report has been delivered, so a failed post is posted again. A part that
  lands on such a day later brings it back for another look. This is its own
  pass behind its own switch, shipped off; it pays no fee, and every read
  stops at its stage cutoff so its sends keep their time.
- Each canonical remittance records the destination messenger it was bound
  to. Quoting and sending require a known route before any value moves.
  Replacing a receiver behind the same messenger and replacing the messenger
  itself have different reachability consequences; the route record proves
  only the latter.
- A receipt on the configured destination drives acknowledgement, including
  a delivery that arrived after its reservation was released. Ordinary
  pending acknowledgements have first call on the send budget; late work and
  slow destinations cannot block them or other destinations.
- A missing receipt behind a retired messenger is reported to operators.
  A pending remittance without a receipt after eight hours is reported even
  on an unchanged route. The cause may be manual-execution delay or a
  replaced receiver and is stated as unknown where the keeper cannot tell.
- Reports name destination, amount, age, message identity, original and
  current routes, and any stranded share or compensation gate still held.
  Unreadable values remain unknown. Acknowledgement never proceeds on an
  unread compensation gate or unread attempt history.
- Recovery is an operator decision. Recording an old route does not make
  that route a trusted current peer. Remittance automation stays off while
  an operator temporarily restores an old route to recover a delivery.
- A released remittance is finished only when a current read shows no
  stranded amount and no compensation gate. A missing figure stays unknown.
  Alerts close once current chain evidence establishes completion, without
  requiring a reconstruction or stamping of retired remittance history.

## Sending reward budgets

- Each send funds at most one reward day; days that only close and move no
  value may accompany it. A day's budget may travel in several parts, under
  the source-split, whole-day reservation and delivery rules in
  [the tokenomics spec](TokenomicsTechSpec.md#4-platform-interaction-rewards).
  The keeper sends at most one part per mirror per run, respects configured
  limits and live lane capacity, and continues days already partly sent.
- A day remains owed until all of its parts are accounted for. A send is not
  described as covering the day merely because one part arrived. Part sizing
  also follows the current tokenomics requirements for both lane ends and
  avoiding uneconomic small parts; unread capacity does not become infinite.
- For each day, the protocol's own verdict distinguishes already sent or
  closed, nothing owed, manual-funding-only, awaiting commitments, short of
  backing, partly sent, and ready. Only outstanding obligations are reported
  as blocked work, with their actual reason. An older deployment without that
  verdict retains a qualified warning rather than an invented explanation.

## Closing, finalizing, and broadcasting reward days

- The daily cycle reports each elapsed day's interest from every reward
  chain, finalizes eligible days on Base, and broadcasts finalized totals
  to their mirrors. The keeper checks every fifteen minutes, catches up
  missed days after downtime, and revisits at least the most recent fourteen
  days. Older held days rotate through bounded work after recent days.
- A chain is worked only after its identity, role, reward clock, pause state,
  and reporting configuration are readable for that run. A clock must be
  known to cover the same UTC hours as Base's. Missing knowledge holds
  irreversible steps and is reported.
- Both ends of the reporting channel must be readable and correctly wired
  in the same run. Base must be confirmed canonical. Expected sources must
  be readable, nonempty, and include Base; the keeper assesses coverage
  chain by chain rather than assuming a report count proves coverage.
- Fresh deployments use the single current day-report format. A mirror's
  close checks its destination against the Base the protocol names at execution;
  incompatible reward clocks do not count toward Base's daily figures.
  Authenticated chain-wide accounting still applies to a late or mismatched
  report. A report received before Base's clock is set remains retryable.
- Until fresh deployment replaces older testnets, the keeper may quote their
  older B4 report only when the mirror's sender, its reporting route,
  and Base's receiver are confirmed compatible. An unreadable or unsupported
  channel holds every close and names the broken link. The new contracts
  themselves retain no older-format fallback.
- Every report or broadcast pays at most its configured per-chain send-fee
  ceiling, defaulting to 0.002 native token. An excessive quote holds the send
  and names both amounts; malformed fee settings hold all affected sends.
  Fee-free finalization can proceed while a broadcast is held. A mirror absent
  from the expected-source list is reported explicitly.
- Finalized days are broadcast to every destination owed them, including
  destinations with standing in the day beyond today's lists. Served
  mirrors are read to confirm receipt. A missing receipt is flagged after
  two hours; a resend after six hours targets only still-missing mirrors.
  An unanswered submitted broadcast counts as sent for the retry interval.
- Completion requires confirmation for every owed destination. A destination
  list change before settling leaves the added work owed. Older deployments
  unable to address a destination separately retain the conservative owed
  state and explain the limitation.
- Notices about chains omitted at finalization use that finalization's own
  evidence. If the keeper never saw the day open, it states the basis it can
  use. Whether a landed report contributed to an already-finalized day is
  not claimed when the protocol cannot answer it.
- Held steps, unread lists, persistent send faults, and pending transactions
  produce standing operations alerts. A failed read cannot clear an alert.
  Deployment or role changes close obsolete alerts with an explanatory
  notice and start work under the new deployment's identity.

## Closing out finished reward days

- Every permissionless step that retires a finished reward day, or releases
  value the day no longer needs, has a keeper backstop, so nothing waits on
  someone choosing to make the call. The close-out duty checks every fifteen
  minutes on every chain it serves.
- It proves an elapsed day closed only when the day is reached by both
  interest frontiers and every reward entry covering it has ended. Before
  opening a proof it checks, from its own reading of the chain, that the
  covering entries sum exactly to the day's recorded totals; when they do
  not, it opens nothing and reports the shortfall, because a proof started
  on an incomplete reading could never finish. A day with an entry still
  running is counted as waiting, not attempted. Its own unfinished proof
  for a day is continued rather than replaced.
- However many reward entries cover a day, its proof is reached. A day
  covered by more entries than one run can read is checked, and then
  proven, over several runs: each run carries on from where the last one
  stopped, keeping the day's running sum and the position its proof has
  reached, and never starts the reading again. A day whose reading carries
  on is named on the run's report.
- It finalizes a retired custody era once every day of the era's span is
  proven closed and no staging hold remains on its row, and never touches
  the live era. On a chain with an active reward role it drains the whole
  pending surplus into the live baseline. On a detached chain it leaves the
  pending surplus for the return transport and reports how much waits
  there.
- It parks a transport epoch's remainder once every day the epoch lists is
  proven closed, the epoch's day membership is complete and no staging
  record references it. Releasing a parked remainder stays the
  administrator's acknowledgment; the keeper never makes it, and each run's
  report names every epoch parked.
- It advances a still-open day's transport cursor past an epoch that is
  plainly exhausted: nothing left, fully indexed and unreferenced. An epoch
  exhausted only by its caps is not detected by the keeper; the day's next
  draw passes it.
- On Base, when a remit destination has been taken off the expected-source
  list and the pool room Base held for its abandoned days is not yet fully
  released, it continues that release. It finds the removed chains from the
  indexer's record of removals, but decides from the chain's own record of
  each release. A release that is waiting for an abandoned day to finalize
  costs nothing: the keeper sends only a call that would move the release
  forward, and the run's report names what it is waiting on. A removal is
  treated as finished for good only once the removal itself, and not just its
  release, is in the chain's finalized block.
- It writes each reward reconciliation queue's pending takes into their
  records while any remain, because the administrator's corrections on that
  side refuse until they are written. This moves no value and changes no
  total. It uses only what the run's send budget leaves after the other
  steps. The run's report states how many of its calls landed and the
  pending figure it read before and after them. It does not present the
  difference as its own work, since other payouts can add pending takes, and
  anyone can write them, between its reads. When the read after its last
  call fails, it reports that figure as unread rather than repeating the
  earlier one.
- How long the chain's history grows never stops the duty, and no day, era
  or epoch is ever left out for good. Its work per run is bounded, and each
  bounded read resumes where the previous run stopped, wrapping round, above
  a floor of what is finished for good: the days not yet proven closed are
  read sixty at a time by default, every provable day is read the same way
  for parking, the retired eras not yet finalized are read thirty-two at a
  time, the recorded removals of remit destinations are read a page at a
  time, a day's transport epochs are read a page at a time, and its reading
  of the reward entries starts past the entries that ended before the oldest
  day still open. A day that stays open therefore does not hold back the
  days after it. Where the bound keeps something from being reached in one
  run, the run's report says so.
- None of these steps pays a fee or moves value to the keeper. A paused
  protocol, a missing signing key, an unread value or a Diamond that names
  another chain stops the affected step and is stated in the run's report,
  never treated as nothing to do.

## Recovering deliberately zeroed reward days

- A mirror chain may report a reward day as deliberately zeroed. That day's
  users are owed compensation from Base, and if none comes in time, the day
  is retired as a recorded loss. Each step of that process is permissionless.
  The keeper has a backstop for each one, so a zeroed day never waits for
  someone to decide to make the call. The zeroed-day duty runs on mirror
  chains only and checks every fifteen minutes. It reads sixty elapsed days
  a run by default, resuming where the previous run stopped and wrapping
  round above a floor of days already settled, so a zeroed day of any age
  is reached.
- **Quoting.** Once the day's own interest close has run and its pool stamp
  is installed, the keeper builds the day's compensation quote. It submits
  the covering reward entries page by page, in ascending order, and then
  dispatches the finished quote toward Base, paying the lane fee. Before it
  dispatches, the accumulated conservation must equal the day's recorded
  totals on both sides. A day covered by more entries than one run can
  read is summed and submitted over several runs, each carrying on from
  where the last stopped, so no day is out of reach because it was busy. A day whose quote comes to nothing on both sides is
  resolved as zero and needs nothing more. The fee for each send is held to
  this duty's own ceiling. A send whose quoted fee is above that ceiling is
  refused and stated, and it is tried again on a later run.
- **Lapsing.** A day that is never compensated is lapsed once its frozen
  lapse window has passed. This happens even if no quote was ever sent, and
  the loss is then recorded as a partial figure. The keeper then keeps
  accumulating the day's quote to completion, so the recorded loss becomes
  exact. After a lapse, no quote is dispatched.
- **Short lapsing.** A day that was compensated below its quote on either
  side is short-lapsed once its deadline has passed.
- **Waiting.** A provisional compensation credit waits for its broadcast,
  and a day with no lapse clock waits for one. In both cases the run's
  report says what the day is waiting for, and the keeper does not send
  into a call it knows the chain would refuse.
- **Wedged sides.** Accumulation is permissionless, so a third party could
  move a side's cursor past covering entries that were never submitted.
  When the keeper finds a side whose conserved figure no longer matches the
  covering entries up to its cursor, it raises an operator alert. Only the
  administrator's reset can free that side, and the keeper never attempts
  it.
- Each lapse or short lapse the chain records, whoever made it, is
  announced to operators with the loss it recorded, in VPFI, and again once
  a partial figure becomes exact. A day whose announcement has not gone out
  is kept in view and announced again until it is delivered. None of the
  zeroed-day calls refuses on its own while the protocol is paused, so the
  keeper checks the pause itself and makes none of them while it is set.
  A paused protocol, a missing signing key, an unread value, a
  chain without a live reward role, or a Diamond that names another chain
  stops the affected step, and the run's report says so. None of these
  conditions is ever treated as nothing to do.

## Returning reward VPFI to Base

- Reward VPFI that a mirror holds for Base, and the messages that let Base
  release what it reserved, move only when someone makes a permissionless
  call and pays its cross-chain fee. The keeper has a backstop for each such
  call, so nothing waits for someone to decide to pay. This duty checks
  hourly and pays each fee from the keeper's own key, held to the duty's own
  ceiling.
- **Repatriation.** Only the administrator issues or cancels a repatriation
  authorization; the keeper never does either. For each authorization Base
  holds pending, the keeper sends its instruction to the mirror, executes it
  on the mirror once the mirror's outbound lane can carry the whole amount,
  and, for an authorization the administrator cancelled, sends the mirror's
  cancellation acknowledgement so Base can release the reserved amount.
- **Each message once.** An instruction or acknowledgement is sent once. One
  that has not landed within a day is announced to operators instead of
  being paid for a second time, because a cross-chain message that failed on
  arrival stays there for manual re-execution. A send whose outcome the
  keeper did not see counts as sent, since it may still land; only a send
  that reverted, or that the node refused, is sent again. The keeper stops
  counting a send as made only once the chain's final state shows the
  authorization finished, so a finish that a reorg undoes does not lead to a
  second send. A repatriation the lane can
  never carry, or one the mirror cannot yet fund, is stated rather than
  attempted.
- **One route.** A mirror returns VPFI, and acknowledges cancellations,
  toward its current Base. When a mirror's current Base is not the Base that
  issued an authorization, as after the mirror detached and reattached
  elsewhere, the keeper sends nothing for that authorization and alerts
  operators. Sending would move the VPFI to the other chain and leave the
  issuing Base's authorization unsettled.
- **The right Base Diamond.** Every return names the Base Diamond that is
  meant to credit it: the Base that issued an authorization, the Base that
  remitted a quarantined compensation, or the Base a retired mirror detached
  from. Base credits only a return naming itself. Before sending any return,
  the keeper checks that it serves that Base chain, that the Diamond it
  serves there is the one the return names, and that the Base Diamond's
  return receiver delivers to it. When any of these fails, as after a Base
  Diamond rotation or a mirror that reattached to another Base, the keeper
  sends nothing and alerts operators: the VPFI stays on the mirror, where an
  operator can recover it, instead of travelling to a Base that would refuse
  it. When the keeper cannot make the check (it does not serve Base, or a read
  failed), it sends nothing and says so.
- **Chunked returns.** Compensation a mirror quarantined, and a retired
  mirror's pending surplus, go home in parts. Each part is bounded by the
  sending chain's outbound lane and by the receiving chain's inbound
  capacity where that can be read; where it cannot, the run says the part
  was sized by the outbound lane alone. A part too small to be worth its fee
  that would leave something behind waits for the lanes to refill; the last
  part is always sent.
- Every send that moves VPFI is announced to operators with its amount and
  transaction, whoever made it. The announcement comes from the chain's own
  record of the send, as the indexer recorded it, not from what the keeper
  saw when it sent: a send whose confirmation the keeper never saw is still
  announced, once it is recorded. An announcement that does not go out is
  posted again on later runs until it is delivered, and those after it wait
  behind it. Base's own authorization count names every authorization, so
  the keeper reads them from the chain a bounded number a run, resuming where
  it stopped above a floor of settled ones. Quarantined compensation, which
  no view lists, comes from the indexer's record of on-chain events, read a
  page a run in the same way. That covers both events that quarantine
  value: an arrival quarantined on landing, and a provisional credit demoted
  by its day's broadcast. No authorization or quarantine is left out for good, however long
  the history grows. Every decision comes from an on-chain read, and the
  keeper's own record of what it sent keeps it from repeating a message
  before the indexer has seen it. A paused protocol, a missing signing key, a
  fee above the ceiling, an unread value or a Diamond that names another
  chain stops the affected step and is stated in the run's report.

## Claim-horizon and sanctions observation

- The reward heartbeat discovers all unsettled reward entries and touches
  each about every twelve hours, within the maximum seven-day observation
  gap. While the horizon is off it maintains discovery and completes removals
  already begun; it does not invent claimable time.
- Clock time counts only under the claimability rules in
  [the tokenomics spec](TokenomicsTechSpec.md). A pause causes no sends and
  neither raises nor clears heartbeat alerts. Failing entries yield their
  turn so they cannot consume the whole round's capacity.
- Alerts identify refused touches, entries unreached for two rounds, and
  clocks that did not advance across two landed touches. Reports distinguish
  an owner who could not claim from touches that should have advanced the
  clock. The capacity limit of 300 entries per hour per chain, approximately
  3,600 per twelve-hour round, is disclosed when a backlog exceeds coverage.
- The heartbeat also closes out the entries it reads, behind its own switch.
  A closed entry whose remaining window is worth nothing payable is retired,
  which moves no value and only releases the commitments it still carried;
  an entry that retires a day at a time is retired again until it is done.
  The loan of a forfeited entry is swept once for all its entries, sending
  the forfeited reward to the recycle bucket. A sweep can make progress
  while moving nothing, so the keeper does not judge it by the amount it
  returns: it sweeps such a loan once each round, and again within the run
  while the last sweep moved value or reported progress and an entry is
  still unfinished.
  A forfeited entry stays in the heartbeat's queue until that sweep has
  processed it, whether or not the switch is on, so turning the switch on
  later reaches every forfeited entry already found. A forfeited entry has no
  expiry clock, so any paused-clock or touch report it carried is cleared.
  A retirement is not sent when it would retire nothing. Each run states
  whether the close-out switch is on, and the form of a value it refuses. The run states how many entries were retired
  and the commitments released, and how much each sweep moved, as reported
  just before each call was sent. A refused call is alerted for each entry
  it covers, naming the call and the reason, until the entry runs clean or
  settles; a call that reverts on chain keeps it open. Every one of these calls is open to anyone, and none moves value
  to the keeper.
- The sanctions-hold pass observes held claimants and advances settlements
  only under the protocol's final verdict. Notices state amounts held, paid,
  or forfeited from the transaction's own evidence. A transaction-wide
  recycle credit is not presented as an additional wallet-specific payment
  when figures overlap.
- Sanctions-hold conditions are delivered as one operator digest per chain,
  with chain-wide conditions first and wallets grouped by reason. Omitted
  chat lines are counted, and every line remains in the journal. A condition
  repeats every six hours while it persists. A failed message records no
  delivery, and a failed read cannot clear the condition.
- A restarted observation chain is reported with its new beginning. An exact
  preceding gap is stated only when observed; an already-lapsed chain reports
  only what is known. Notices are best-effort and cover the claimants touched
  by that run, not every claimant on the network.

## User risk and pre-grace warnings

- The keeper and payment-reminder service use the same Push channel identity.
  The keeper publishes its sending readiness without publishing its key.
  Whole-service Push is available only when both senders can send on the same
  channel. A missing or unreadable keeper record, or one older than fifteen
  minutes, proves nothing about its rail; a payment-only answer states that
  limitation. Skipped sends and failures are counted separately from delivery.
- A withdrawal of a nonexistent indexed loan clears only health-band memory
  learned before that withdrawal under the same deployment. It prevents a
  pending obsolete warning from being posted, but preserves observations of a
  real loan later given the same number. An earlier deployment's withdrawal
  cannot clear the current loan's warning history.
- An auto-refinance borrower inside the day before effective maturity is
  warned even when the order book contains a seemingly suitable lender offer.
  An unfilled offer never proves a refinance will happen. Existing throttles
  still apply, and an active protocol pause holds a warning whose date is
  still moving. An unreadable pause record holds the warning and says why.

## Protocol upkeep outside the reward system

- Two permissionless housekeeping steps outside the reward system have a
  keeper backstop, checked every hour on every chain the keeper serves.
- A buyback intent that has passed its expiry while still pending is rolled
  back, so the unfilled part of its reservation returns to the spendable
  buyback budget and its allowance and commitment slot are released. The
  keeper finds intents from the indexer's record of commitments, but decides
  each one from the intent's own on-chain record and the chain's own clock.
  An intent that is still live, filled or already expired is left alone.
- The per-tier loan-to-value cache is refreshed from the peer protocols
  before it can lapse; a cached tier stops counting after fourteen days and
  the governance tier cap applies instead. The keeper first previews the
  refresh and sends it only when it would write a tier whose value changes,
  or one cached long enough ago to need renewing, so a chain whose peers give
  no reading costs nothing. Each tier the refresh rejects is reported with
  the protocol's own reason. Nothing is refreshed while peer readings are
  paused.
- Neither step pays a fee or moves value to the keeper. The keeper works a
  chain only when its connection answers for that chain, and a value it
  could not read stops the affected step and is stated in the run's report.

## Committing flagged prepay-sale recipients

- A prepay sale pays its recipients inside the marketplace fill. The fill's
  own recipient screen reads the sanctions oracle, so during an oracle
  outage it cannot tell a flagged recipient from a clean one, unless that
  recipient is already in the protocol's fail-closed registry of confirmed
  flags. The protocol offers a permissionless sync, by loan and by sale
  offer, that commits any recipient the oracle confirms flagged to that
  registry and cancels the listing. Without a caller nothing commits the
  flag. The keeper is the caller.
- It checks every hour, on every chain it serves that has a sanctions oracle
  set, as a step of protocol upkeep that is armed on its own. Without an
  oracle no address can read as flagged, and the report says so.
- It reads the live listings and, for each, the exact recipients the sync
  would screen, from the protocol's own read of that set. Loans are read a
  window of the active list at a time. Sale offers are nominated by the
  indexer's record of listings posted, and each is decided from the
  protocol's own record. It screens each recipient and calls the sync only
  for a listing with a recipient that reads as flagged. The protocol then
  decides: it re-reads every recipient, commits only a confirmed flag, and
  cancels only then.
- Each recipient is screened by the protocol's own three-way read, the one
  the sync acts on: clean, flagged, or not answerable. An oracle that cannot
  answer for a recipient is never read as clean. A listing with no flagged
  recipient but one the oracle could not answer for is reported by name as
  not screened that run, so an outage cannot show up as "nothing flagged".
- Its reads stop in time to leave its sends their time. Each read stage,
  the oracle setting and the loan window included, stops at its own cutoff,
  whether the read has not started or is still waiting.
- Each sync that lands is reported as having cancelled its listing or as
  having left it live. A listing left live means the protocol found no
  confirmed flag at that moment. A listing whose recipients all read clean
  costs reads, not transactions. The keeper pays only gas and moves no
  value.

## Delivering owed tier pushes

- Base carries a user's effective discount tier to each mirror chain inside
  the user's own action. A mirror lane that cannot be paid or reached then
  stays owed, and the protocol says so with a deferral record naming the
  user, the lane and the reason. Anyone may deliver an owed push later.
  Without a caller nothing does, and the mirror keeps the tier it last
  received until the user's tier changes again. The keeper is the caller.
- It checks every hour, as a step of protocol upkeep that is armed on its
  own. The indexer's record of deferrals nominates the users; each is
  decided from the protocol's own record of which lanes are owed and when
  the protocol's broadcast budget may next pay each one.
- The keeper attaches no value of its own. So it calls the delivery only
  for a user with a lane the protocol budget may pay now and whose quoted
  fee the budget still covers, counting what earlier deliveries in the
  same run actually spent: a delivery that sends no lane holds back no
  later user. Users are tried from a point that moves each run, so one
  whose delivery keeps failing cannot always go first. A user whose owed
  lanes all wait on spacing, or on a budget that cannot cover them, is
  reported as waiting, with why, and costs no transaction.
- A user whose status lists no lane at all is reported as not known: the
  protocol gives that answer both where no lane is configured and where
  the destination list could not be read, so it is never counted as owed
  nothing.
- The delivery spends the protocol broadcast budget: each lane delivered
  pays its cross-chain fee from it, under the protocol's own rule (a push
  that lowers a lane's tier at once, any other at most once per spacing
  window per lane). The report names each lane delivered and each lane
  left owed with its reason, from the transaction's own records, and a
  delivery that found every lane already delivered by someone else as
  exactly that, never as lanes left owed. A record
  of a deferral is passed for good only once the finalized chain shows that
  push delivered, superseded, or no longer owed.

## Listing NFT collateral during grace

- While a loan backed by an NFT is in its grace window, anyone other than the
  borrower-position holder may put the collateral up for sale at the protocol
  floor: the asking price that pays the lender and the treasury what they are
  owed plus the configured buffer. Without a keeper nobody makes that call,
  the grace window passes unsold, and the lender takes the NFT in kind at
  default even when a buyer at the floor existed. The keeper makes it.
- It checks every minute, on every chain it serves, because the shortest
  grace window is one hour and every minute of it without a floor listing is
  a minute a buyer cannot take the NFT.
- It works only loans whose terms allow a prepay listing, whose collateral is
  an NFT and whose principal is a token, and whose borrower has not opted out
  of auto-listing. Whether a loan is in grace comes from the loan's own
  deadlines, pause credit included, against the chain's clock. With no
  listing up it posts one at the floor; a listing above the floor, or built on
  amounts that have since grown, is moved down to it. A listing already at or
  below the floor on current amounts is left alone.
- The price is always the protocol's floor at the moment the call lands; the
  keeper never chooses one. Each listing is reported with its asking price,
  and each loan the protocol declines is reported with the protocol's own
  reason and tried again later.
- Nothing is listed on a chain where prepay listings are switched off or no
  buffer is configured, and the report says so. The keeper pays only gas and
  moves no value to itself. It does not withdraw a listing once grace ends;
  the default that follows is a separate duty.

## Activation and operator visibility

The master keeper switch and each duty's own arming choice are separate.
The periodic-interest settler has its own disabled-by-default activation.
Late acknowledgements, sanctions observation, reward-day automation, reward-day close-out, zeroed-day recovery, the return transport, the reward heartbeat and its entry close-out, protocol upkeep, its prepay-sale sanctions sync and its tier-push retry must each
disclose whether they are armed on the selected deployment. Reward-day
automation, close-out, zeroed-day recovery, the return transport, the heartbeat and its entry close-out, protocol upkeep, its sanctions sync and its tier-push retry ship disabled and require
deliberate activation. Deploying their software does not prove they run, that rewards have launched, or that custody or the
expiry horizon has been activated. The mirror's day-delivery protection is
required by its reward role, as stated in the current tokenomics spec; it is
not an optional keeper setting.

Before a claim horizon is enabled, operators must verify timely observations
on that chain, with the relevant alerts clear. A mirror's funded day lands
with its delivery (#2828), so mirror operation needs no keeper proof for
it. Reports retain
unknowns and partial coverage. An unreadable
dependency is never turned into an empty queue or a successful run.

## Sources

- [August 23](../ReleaseNotes/ReleaseNotes-2026-08-23.md) and
  [August 28](../ReleaseNotes/ReleaseNotes-2026-08-28.md): keeper workload,
  scans, and bounded acknowledgement discovery.
- [October 14](../ReleaseNotes/ReleaseNotes-2026-10-14.md) and
  [October 15](../ReleaseNotes/ReleaseNotes-2026-10-15.md): defaults,
  internal matching, ordered transactions, and runner exclusion.
- [October 18](../ReleaseNotes/ReleaseNotes-2026-10-18.md): dedicated state,
  machine runtime, deployment adoption, and retained open work.
- [October 19](../ReleaseNotes/ReleaseNotes-2026-10-19.md): deadlines,
  fair scans, and priority-credit-backed intent fills.
- [October 20](../ReleaseNotes/ReleaseNotes-2026-10-20.md): proof alerts,
  reward heartbeat, and sanctions settlement notices.
- [October 21](../ReleaseNotes/ReleaseNotes-2026-10-21.md): remittance routes,
  reward-day automation, and retirement of shared keeper state.
- [October 22](../ReleaseNotes/ReleaseNotes-2026-10-22.md): send-fee ceilings,
  finalization evidence, and sanctions-hold digests.
- [October 23](../ReleaseNotes/ReleaseNotes-2026-10-23.md) and
  [October 24](../ReleaseNotes/ReleaseNotes-2026-10-24.md): Push readiness,
  withdrawal-safe warning memory, and verified release installation.
- [October 25](../ReleaseNotes/ReleaseNotes-2026-10-25.md): partial sizing,
  periodic settlement, collateral evidence, bounded matching, and loan clocks.
- [October 26](../ReleaseNotes/ReleaseNotes-2026-10-26.md): split-leg floors,
  extension windows, credential-safe errors, and older-testnet compatibility.
- [October 27](../ReleaseNotes/ReleaseNotes-2026-10-27.md): partial-day reward
  remittances and VPFI loans left to their owners' ordinary claims.
