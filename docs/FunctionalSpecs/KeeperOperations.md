# Keeper Operations Functional Specification

This document describes the intended behavior of the protocol-operated keeper.
It consolidates the operational decisions in the release notes from August 13
through October 22, 2026. The deployment destination incorporates the owner's
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

## Fresh decisions, bounded work, and transaction outcomes

- Transactions using one signing account on one network are submitted in
  order. Work on another network is independent. A rejected unsent action
  cannot reserve a transaction number indefinitely; a broadcast whose result
  is unknown must not be replaced as if it had never reached the network.
- Every pass has a finite deadline. Ordinarily it is the scheduled minute
  plus the pass's cadence, less a thirty-second margin. A send whose queue
  slot or preparation reaches that deadline is deferred without broadcast.
  The next run starts from fresh state. Logs distinguish this from a failed
  transaction and never imply a transaction exists when nothing was sent.
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
- Operator-managed tuning survives deployment. Shipping a release must not
  silently reset liquidation thresholds, confidence windows, or arming
  choices. Signing keys and settings whose presence enables transactions
  are treated as secrets.

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

## Reward delivery proofs and acknowledgements

- Each mirror's delivered budgets are discovered from fully indexed history
  and retained as open work. Flat day lists are indexed or proven as their
  delivery requires; rooted lists are rebuilt from the canonical reservation
  and the days actually funded for that mirror. Both recorded roots must
  agree before anything is sent.
- A packet's reservation is read at the source deployment the packet names,
  rather than whichever source is configured today. A delivery awaiting
  admission is admitted before indexing; it must not be treated as having no
  epoch and discarded.
- Calls are simulated first. Sends are ordered and their results checked.
  A delivery is complete only when a fresh read shows its required indexing
  or proofs complete, not merely because an admission or proof transaction
  succeeded. Independently provable chunks can progress despite another
  chunk's refusal.
- Per-mirror operations alerts identify deliveries still incomplete more
  than ten minutes after arrival, oldest first. Partial discovery or reads
  can raise an alert but cannot clear it; counts are qualified as "at least"
  when completeness is unknown. Every affected delivery remains in the log
  even if the chat message cannot hold them all.
- Contract refusals name the affected delivery, day coverage, and safe
  reason. Provider timeouts are retried and are not described as contract
  refusals. Work another caller already completed is not a failure.
  Network error text must not expose provider credentials.
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
- A mirror pays the messenger's quoted reporting fee. An older report shape
  is not sent when Base has finalized, could finalize, or cannot be read.
  A mirror absent from the expected-source list is reported explicitly.
  These are keeper checks: a route or configuration change between checking
  and execution remains a race and must not be described as impossible.
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
- How long the chain's history grows never stops the duty, and no day, era
  or epoch is ever left out for good. Its work per run is bounded, and each
  bounded read resumes where the previous run stopped, wrapping round, above
  a floor of what is finished for good: the days not yet proven closed are
  read sixty at a time by default, every provable day is read the same way
  for parking, the retired eras not yet finalized are read thirty-two at a
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
  totals on both sides. A day whose quote comes to nothing on both sides is
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
  arrival stays there for manual re-execution. A repatriation the lane can
  never carry, or one the mirror cannot yet fund, is stated rather than
  attempted.
- **Chunked returns.** Compensation a mirror quarantined, and a retired
  mirror's pending surplus, go home in parts. Each part is bounded by the
  sending chain's outbound lane and by the receiving chain's inbound
  capacity where that can be read; where it cannot, the run says the part
  was sized by the outbound lane alone. A part too small to be worth its fee
  that would leave something behind waits for the lanes to refill; the last
  part is always sent.
- Every send that moves VPFI is announced to operators with its amount and
  transaction. The keeper's work list comes from the indexer's record of
  on-chain events, but every decision comes from an on-chain read, and the
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
- The sanctions-hold pass observes held claimants and advances settlements
  only under the protocol's final verdict. Notices state amounts held, paid,
  or forfeited from the transaction's own evidence. A transaction-wide
  recycle credit is not presented as an additional wallet-specific payment
  when figures overlap.
- A restarted observation chain is reported with its new beginning. An exact
  preceding gap is stated only when observed; an already-lapsed chain reports
  only what is known. Notices are best-effort and cover the claimants touched
  by that run, not every claimant on the network.

## Activation and operator visibility

The master keeper switch and each duty's own arming choice are separate.
Delivery proofs, late acknowledgements, sanctions observation, reward-day
automation, reward-day close-out, zeroed-day recovery, the return transport, and the reward heartbeat must each
disclose whether they are armed on the selected deployment. Reward-day
automation, close-out, zeroed-day recovery, the return transport and the heartbeat ship disabled and require
deliberate activation. Deploying their software does not prove they run, that rewards have launched, or that custody or the
expiry horizon has been activated. The mirror's day-delivery protection is
required by its reward role, as stated in the current tokenomics spec; it is
not an optional keeper setting.

Before a claim horizon is enabled, operators must verify timely observations
on that chain, with the relevant alerts clear. Mirror operation also requires
timely delivery proofs so funded days do not remain blocked. Reports retain
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
