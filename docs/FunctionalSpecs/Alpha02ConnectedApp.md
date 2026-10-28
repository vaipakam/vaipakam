# Connected App Functional Specification

This document states the intended behaviour of the Vaipakam connected app —
`apps/app`, served at `app.vaipakam.com` (bound as of 2026-09-07, and the
marketing site's links resolve here since #1959 ported the last two
destinations and flipped the cutover switch; the `/recover` guide links
alone stay on the legacy host, held by same-origin recovery state rather
than by any missing route). It is the app-specific functional
spec consolidated against the release notes from 2026-08-13 through
2026-10-22, inclusive, while retaining later recorded intent decisions. It is intentionally
written without implementation snippets. (The app was called `alpha02` and
served `alpha02.vaipakam.com` until #1854 renamed it; this file keeps the old
name only in its filename.)

## Purpose

The connected app is the beginner-first surface for Vaipakam's pre-live testnet
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
- On phones, the More sheet closes as navigation occurs, including browser
  back and forward navigation and links outside the sheet. It must not cover
  the destination page with a menu belonging to the previous page.
- A page display failure is contained to a recovery card. Navigation remains
  usable, and the user is told that funds and on-chain positions are not changed
  by a display failure.
- The global support control remains reachable without covering primary mobile
  action buttons.

## Public Transparency Surfaces

Two surfaces exist to be read by people who have not connected anything,
including people who never will.

- An analytics view reports the deployment's loan and offer counts, and a
  protocol console reports the current value of the protocol-wide settings
  governance can change — a bounded subset, not the whole catalogue. Both are read-only. Neither offers any control that changes
  protocol state; parameter changes are a governance action elsewhere.
- Both render fully without a wallet, and both are reachable by direct
  link from outside the app. They resolve their chain the same way every
  other read does when no wallet is connected, so arriving cold shows
  real figures rather than an empty page.
- Connecting a wallet must never take either away. Whatever the terms
  prompt withholds, it does not withhold these: withholding a page
  anyone could read without a wallet, because a wallet is present, is a
  contradiction rather than a restriction.
- Each carries its own page title and description. The analytics view is
  indexable; the console is indexable **only while it is public**. A
  deployment may withhold the console, in which case the page renders
  only its withheld-state message, and it is then excluded from the
  index and from the sitemap alike — indexing a surface a deployment has
  decided not to publish would advertise it anyway, and the description
  would promise current values the page is not showing.
- Figures are reported with their age. A reader is told how current the
  data is beside the data itself, and an unknown age is never presented
  as a fresh one.
- A counter the source did not report is distinguished from a counter
  that is genuinely zero, and neither is inferred from the other. Where
  nothing has been indexed at all, that is stated instead of reporting
  zero for everything — an unread source is a fact about the source, not
  about the protocol.
- A loan whose lending asset the indexer has not recorded is counted in the
  active total and excluded from every typed subtotal, whichever placeholder
  the row carries. Publishing such a row under a type it was merely defaulted
  to would be worse than the gap it hides, because the subtotals would then
  reconcile and the unclassified remainder — the surface's own signal that
  something is unknown — would read zero.
- A counter that arrives but cannot be a count of anything — negative,
  fractional, or not a finite number — is withheld rather than published,
  and is distinguished from one that was never reported. Both withhold
  the figure; only one of them says the source sent something impossible,
  and a reader auditing the source is owed that difference. The same rule
  decides whether a figure may be shown and whether it may be used in a
  subtotal, so the view cannot withhold a derived figure while printing
  the invalid input it came from.
- Where the console knows its values are superseded, it points the reader at the
  chain itself for what is in force — not at documentation that derives from the
  same superseded source. A reference that would answer from the same snapshot,
  or fall back to starting defaults, gives a confident wrong answer exactly when
  the console has established that the values moved; the documentation is still
  the right place to learn what a setting means and where it began.
- The console's values refresh while it is open. A reader who leaves it
  open is shown parameters as they currently stand, not the snapshot the
  page loaded with; reporting the snapshot's age correctly is not a
  substitute for refreshing it, since a parameter superseded minutes ago
  sits well inside any age the page would call current.
- The analytics view names the protocol's contract address for the chain
  being read and offers a way to open it on a public explorer, so a
  reader can go to the primary source rather than accept the page's
  reading of it.
- Any total the analytics view reports is the sum of the categories it
  shows beside it. Every state counted toward a total is either named or
  gathered into a stated remainder, so a reader can add up the parts and
  arrive at the whole. A total that exceeds its visible parts is a defect
  on a page whose purpose is that its figures can be checked rather than
  taken on trust — the reader is left with a discrepancy and no account
  of it.
- Where a figure counts one kind of thing and the product offers another
  kind alongside it, the view says which it is counting. Offers that
  exist only as a signed instruction — fillable, visible in the offer
  book, but never written to the chain — are a different population from
  offers the protocol holds, and an unqualified count of the second
  understates what a reader can see elsewhere in the same product.
  Naming the scope is preferred over merging the two, because the
  populations have different lifetimes and a merged figure cannot be
  reconciled against the chain.
- A state's label describes the state, not the page's knowledge of it. A
  loan whose settlement is part-way through and awaiting a further step
  is a settlement state holding real collateral; labelling it as though
  its details were still being fetched invites a reader to dismiss real
  exposure as a gap in the reporting.
- The protocol console reports each parameter against its own name, and
  never by inferring which value belongs to which name from ordering.
- The console states that it shows a subset rather than implying it is
  complete, and it names what is left out: settings that differ per asset
  or per chain, the reward and recycling settings, and a few protocol-wide
  settings not yet shown. A reader is pointed at the full parameter
  reference rather than left to infer that what is shown is all there is.
  An incomplete view that asserts completeness is worse than an incomplete
  view, because it stops the reader looking further.
- Every protocol-wide setting the parameter reference lists is accounted
  for: either the console shows its current value, or the omission has a
  recorded reason (it differs per asset or chain, it is a fixed constant,
  it belongs to the rewards and recycling surfaces, it is off on this
  deployment, the contracts expose no way to read it, or it is not shown
  yet). A setting added to the reference without either is a defect the
  build catches, so the console cannot silently fall behind the reference.
  Within that, the fees, the risk and price-oracle limits, the periodic
  interest and reference-currency settings, the automation switches and
  the keeper pause, the automatic pause's length and cooldown, the
  cross-chain reporting window and the treasury address are shown.
- Beside the automatic pause's cooldown, the console states when the next
  automatic pause that stops the protocol may start (#2843): the time the
  protocol recorded, and whether that time has passed or how long remains,
  judged against the reader's clock. When no automatic pause has ever
  stopped the protocol, it says so in words, never as a date. It also says
  what the cooldown does not cover: an automatic pause that starts while the
  protocol is already paused by hand neither waits for it nor starts it, and
  a change to the cooldown moves the time at once. That time is a fact the
  protocol records rather than a setting, so the indexer's snapshot
  refreshes it on every event that moves it: an automatic pause, and a
  change to the cooldown.
- A setting that is unset is reported as unset, never as a figure or a
  blank. Where an unset setting means the protocol falls back to a
  documented default, the console names that default and marks it as the
  default, never as a configured value: an unset day-close grace window
  reads as the documented four hours, and a reference currency governance
  never changed is named and marked as the default.
- Where a value's meaning depends on another setting, or a switch does less
  than its name suggests, the row says so: the Pyth cross-check runs only
  while both its oracle and its feed id are set, and the keeper pause stops
  delegated keeper actions on other people's positions but leaves owners'
  own actions, liquidation and reward-commitment submission running, so a
  compromised keeper key must also lose its role. Each automation switch
  states its scope the same way: the auto-lend switch only refuses new
  opt-ins, so the console also shows the separate switch that decides
  whether standing lending intents are filled at all; auto-refinance
  stops only the keeper and matcher routes; auto-extend blocks every
  in-place extension. The layer-2 sequencer guard is described as holding
  prices both while the sequencer is down and for the hour after it
  returns.
- A setting that can change without announcing it on chain (today the
  layer-2 sequencer uptime feed, and the ETH reference feed, which one of
  its two setters changes silently) can lag in the indexer's snapshot until
  its next scheduled refresh. While the console shows the snapshot, that
  row says so. Every other published setting names the events that announce
  its change, and the snapshot refreshes on each of them.
- The console shows the public indexer's snapshot only while that snapshot
  can stand in for the chain: it is dated, recent enough that the indexer's
  regular refresh is still running, not known to be behind a governance
  change, labelled, and complete for every setting the page shows. In any
  other case the console reads the same values directly from the contracts,
  all at one block, and its provenance line says so, names the block and
  when it was read, and gives the reason the snapshot was not used. A value
  read that way is put under a name only when the console can show that its
  names describe the code that answered at that block, by the same rule the
  indexer applies before it stores names; when it cannot, the direct read
  counts as failed rather than labelling values by their position.
- A snapshot that is not current is shown only when the direct read fails
  too. A direct read that answers from a block older than the snapshot's
  own block counts as failed: it is not a fresher reading. When the
  snapshot is already known to be behind a governance change, the direct
  read must come from a block that includes that change: the block at
  which the indexer saw it, when the indexer recorded one, and otherwise
  at least a later block than the snapshot's. Until a reading reaches
  that block, the indexer keeps its own snapshot marked as behind too.
- The indexer refreshes its snapshot after any change to the Diamond's
  code, not only after a setting changes, since an upgrade can change what
  a setting's read returns. The console then says the contracts could not be read and that the
  values may be out of date, alongside whatever the snapshot's own
  warnings are. With neither source readable, the console says the values
  are unknown, not unset.
- An operator may hide the live parameter values on a deployment. In
  that state the console says so plainly, and does not direct the reader
  to any resource that the same setting has also withheld.
- A published snapshot that carries no parameter values is not the same as no
  snapshot, and the console does not collapse the two. The snapshot still
  states when it was read and that the deployment is publishing, and the
  console reports that the values themselves did not arrive. Discarding the
  whole reading because one part of it was empty would tell the reader the
  console has heard nothing from a source that in fact answered — an unread
  source and a source that answered without values are different facts about
  the deployment, and only the first is a reason to stop asking.
- Retaining those facts and not showing them is the same failure with an extra
  step. Where a surface tells the reader that its provenance — which source,
  which block, how long ago — is still accurate, that provenance is on the
  page. A statement that something is disclosed below, followed by nothing
  below, is worse than saying nothing: it spends the reader's trust on a
  disclosure that never happens, and it is the surface's own copy that
  disproves it.

## Wallet and Network Behaviour

- Wallet connection should make the active address and network clear.
- Unsupported networks show a plain switch-network state.
- Supported networks should still be named clearly because offers, loans,
  faucet assets, vault balances, and claims are chain-specific. That holds at
  every screen width: on a phone the network is still shown by name, not only
  by a coloured indicator.
- A failed or rejected network switch remains visible until the user dismisses
  it or a newer clear state replaces it.
- Display names may be shown for convenience, but names never decide asset
  identity, ownership, authorization, or safety.

## Page Integrity

- The app runs only script it serves from its own address. The few
  scripts that must run inside the page before anything else loads (the
  theme, the language and direction, and the start-up failure notice)
  are each allowed by their exact content, so any other script placed
  in the page is refused, including one an attacker manages to inject.
- The app never turns text into code at run time, and its policy says
  so: a dependency that needs that is a finding to investigate, not a
  reason to loosen the policy.
- The app may send network requests only to its own address, the
  platform services that build is configured with (the indexer, its live
  update channel and the alert service), the chain endpoints of the
  networks it supports, the token-screening services it calls, and the
  services the wallet connectors it offers need to connect a wallet. Any
  other destination is to be refused, so a script that got onto the page
  cannot use a request to send what it reads elsewhere. These addresses
  come from the build's configuration, so the build writes the list from
  the same settings the app reads them from, and a build that cannot name
  one of its own endpoints must stop instead of shipping.
- Because a wallet service missed from that list would silently break
  that wallet, the list is first published as a report: requests outside
  it are reported and still made, and a review of the deployed app fails
  on any such report. It is enforced only once a deployed build has been
  reviewed clean. Until then requests to other secure hosts are still
  possible, and the app's documentation says so rather than implying the
  list is already enforced. No report is sent anywhere: it would carry
  the address a visitor was on, and nothing about a visit leaves the
  page without consent.
- This narrows what an injected script can do inside the app. It does
  not protect against a compromised deployment, which serves its own
  policy, or against software on the user's own device such as a
  browser extension. The app does not claim otherwise.

## Data Authority and Freshness

The app uses chain reads and indexed reads for different jobs.

- A displayed answer belongs to the network, deployment, wallet, position,
  asset pair, and request that produced it. Changing any relevant identity
  clears the answer immediately, including the first visible frame. A late
  response cannot restore another identity's answer.
- This applies to asset breakdowns, keeper grants, collateral minima, rental
  sale banners, liquidation quotes, loan totals, offer children, claim lists,
  asset details, admin eligibility, acceptance preflight, and pending changes.
  Loading or unknown is shown until the new context has its own answer.
- Recovery's sanctions-oracle readiness belongs to the active network and
  deployment. A network change or retry returns to checking and holds signing;
  a successful check on the previous network never authorizes recovery here.
- Copy controls and add-token requests display only the latest attempt's
  outcome. Navigation, an identity change, or a newer attempt prevents an
  older response from reporting success for the current action.
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
  history degrades honestly instead of scanning without bound. Market
  discovery is additionally pre-computed as data changes (not aggregated
  per request), so serving it costs the same however many markets exist;
  a market whose only order expires purely by clock leaves the list on the
  next ingest cycle for its chain (a few minutes on the current multi-chain
  round-robin cron) rather than instantly.
- A market maker's own resting signed orders are always visible and
  cancellable from the desk, even when better-priced depth from other
  makers fills the public book's per-side window — the desk reads the
  maker's own orders scoped to their wallet, not from the top-of-book
  slice.
- If the indexer is stalled or unavailable, the app should show a degraded
  data-source warning rather than a confident empty list.
- Every time the index records about when something happened (a loan's
  start, a settlement, a listing, a transfer) is the chain's own time for
  that event. When the index cannot read that time it does not record the
  event yet: it stops there and tries again, rather than dating the event by
  its own clock. Where a time is genuinely unknown it is stored and shown as
  unknown, never as a guess.
- Index records come from the chain. The index takes no unauthenticated
  client claim as a fact about a loan or offer that anyone else could
  overwrite.
- The list of offers a wallet holds is the list of its OPEN offers — the
  same set the protocol's own view of a holder's offer positions returns.
  An offer that has been accepted, cancelled or filled into a sale is no
  longer one of the wallet's offers.
- The index never runs ahead of its own storage layout. A release that
  changes how indexed data is stored updates that storage BEFORE the new
  indexing code goes live, and a release that reaches the indexer without
  that update (an automatic deploy route, a failed update step) pauses its
  scheduled indexing — naming the missing update in the operator log —
  rather than writing records the old layout cannot hold. Indexing resumes
  by itself once the update lands; nothing is lost, because the reading
  position does not move while paused, and no partial or invented record is
  written. During the pause the index's data is old but intact: the market
  and history surfaces that read it show their stale-data notice once the
  index has not advanced for half an hour — the same notice any ingest stall
  produces — and the connected wallet's own positions, which are read from
  the chain, are unaffected.
- Indexed lifecycle status must not drift from the chain's indefinitely.
  A loan's ending is learned from the event announcing it, and an
  announcement the platform does not see is missed for good — resuming
  ingestion restores the reading position, not the records already behind
  it. The platform does not assert WHY an announcement goes unseen: the
  reading survives being stopped, being refused, and falling a long way
  behind, so naming those as the cause would claim something it has not
  established. So the index re-examines what it believes
  to be running against the chain on a continuing rotation, and corrects
  a record the chain says has ended. It keeps re-examining even while the
  totals agree, because one missed ending and one missed beginning leave
  the totals equal with both records wrong.
- That correction only ever moves a record from running to ended, and
  only on the chain's word. A source that is behind reports the loan
  still running, which matches the record and changes nothing, so being
  out of date can cause a correction to be missed but never invented.
  **That direction is necessary and not sufficient, and the platform must
  not rest on it alone.** The correction cannot be undone by the same
  mechanism — a record it has ended is no longer one the check looks at —
  so a reading that is WRONG rather than merely old is permanent. The
  chain state a correction relies on must therefore be read at a point the
  chain treats as settled, never at whatever the source last saw and never
  at a point derived from how far the index itself has read. Without that,
  a reorganisation or a momentarily non-canonical answer can report an
  ending that then disappears, leaving an open loan recorded as closed with
  nothing that would ever revisit it. A
  record that already shows an ending is left to the event path, which
  can tell a forced sale from an ordinary default where the chain's own
  status cannot — a record corrected from the chain may therefore name
  the ending less precisely than the event would have.
- When no settled point can be read, the correction does not run at all,
  and says which chain it is not running on. Guessing one — stepping back a
  fixed distance from the newest block — answers the question with the
  wrong kind of answer, and the whole reason for the rule above is that
  being wrong here cannot be undone. Not running is the honest outcome;
  running quietly on a guess is not, and neither is declining quietly,
  because a check that silently skips itself reports perfect health while
  records stay wrong. What the platform reports is the reason its source
  gave, never a cause inferred from the failure: a source that supports the
  question and merely timed out is indistinguishable at that moment from
  one that cannot answer it, and an operator sent to replace a working
  source has been told something false. A chain in that state keeps
  whatever records it already had — nothing is corrected, nothing is
  damaged — until the settled read succeeds.
- **The same holds for the reading itself, not only the correction.** The
  index reads forward from where it last stopped and never goes back over
  what it has read, so a stretch read on a guess and then reorganised away
  leaves its records wrong for good. When no settled point can be read, the
  index does not read forward at all on that turn: it keeps its place, keeps
  serving what it has, and says which chain is held and the reason its
  source gave. This is a deliberate choice of correctness over liveness —
  a source that never answers the settled question never has that chain
  indexed, and says so on every turn, and the index's reported age grows —
  rather than indexing on a guess that can never be revisited. The
  corrections that read the chain wait on the same terms: on such a turn no
  record is filled in or corrected from a chain reading, because a correction
  is never revisited either.
- Whenever the live set was not checked against the chain on a turn, the
  reminders derived from that set wait for a turn that checked. Due-date
  and grace reminders are read off the records the platform holds, they are
  sent once, and they are never taken back — and a record wrongly showing a
  position as open is exactly what the check exists to find. So a turn that
  refuses to check, or cannot, must not also be the turn that reminds
  someone about a position that may already have ended. This holds for every
  reason a check does not run, not only an unreadable settled point: a turn
  whose own reading has run ahead of the settled point, and one that has not
  yet caught up to it, are equally turns that established nothing. Waiting
  costs nothing a reminder needs — its window is hours to days — and the
  platform already waits on the same surface when the grace schedule the
  reminders depend on has not been read.
- The same rule applies record by record, not only turn by turn. A turn that
  checked may still have records it could not settle — one the chain has
  never heard of, one whose state could not be read, one whose correction
  failed to write, one in a state this build does not recognise — and each
  of those is still recorded as open. Those records are left out of that
  turn's reminders by name, while every record the turn did settle is
  reminded about as usual. The alternative, withholding the whole chain's
  reminders because one record could not be read, would punish every other
  holder for it — and would do so indefinitely if that record stays
  unreadable.
- A record left out for that reason stays left out until a later turn settles
  it, not merely for the turn that noticed. Each turn examines a handful of
  records, so a rule applied only to the current turn's findings leaves the
  same record reminded about on every other turn — the platform would be
  treating *what this turn looked at* as if it were *what is currently
  unconfirmed*, which are different questions. The stricter-looking variant
  of that mistake fails identically: holding back every record on a turn
  whose findings were dirty still reminds on the next turn, because that
  turn's findings are clean for having looked elsewhere.
- What the platform remembers about such a record is which way it could not
  be confirmed and when it was first noticed, and it says so out loud once
  that has lasted. The four ways need different responses, and the age is the
  difference between a source having a bad moment and a position nobody has
  resolved — so neither is flattened away, and the first-noticed time is
  never refreshed by a later sighting of the same problem.
- A record is released as soon as a turn settles it, by any route: corrected,
  found genuinely running, or ended by someone else. It is ALSO released by a
  standing sweep over held records whose loan is no longer running, so a
  release missed at close-out — for any reason, including one nobody
  anticipated — is picked up later rather than leaving the record held for
  good. The sweep runs on every turn and clears a limited number each time,
  so "picked up later" can mean several turns where many are waiting; it is
  not a promise that one turn catches them all. A loan that has ended can generate no reminders, so holding its record
  withholds nothing and only buries the records that do need a person. Holding a record back
  forever on the strength of one unreadable moment is the same defect facing
  the other way, and it is the failure this rule is most likely to produce if
  it is written carelessly.
- **A lookup that covers many records at once must not fail BECAUSE there are
  many.** The platform decides who an inbox row is for, and who a sold-offer
  row belongs to, by asking its own store about every record in the batch it
  is working on. How many that is depends on how busy the network was and on
  how far behind the platform had fallen — so it is largest exactly when a
  catch-up is running. A question the store refuses because it names too many
  records at once is not a slow answer, it is no answer: the work it belonged
  to fails whole, and it fails identically next time, because the backlog that
  made the question too large is still there. So such a question is split into
  as many as it takes and the answers combined, and the splitting is one shared
  rule rather than a number each caller remembers — a limit that has to be
  recalled at five call sites is a limit two of them will not know about.
- **A held record is NEVER released on an inference that the position has
  changed.** A record is released when the position it names is settled, or
  found to have ended — facts the platform establishes. It is not released on
  a judgement that "the identifier must belong to something else now", because
  every basis for that judgement available to the platform has proved unsound:
  a recorded start time may be the platform's own clock substituted when the
  network could not be read; a recorded place in the network's sequence goes
  stale, restarts on a test-network reset, and can be left behind by a
  reorganisation the platform never revisits. Acting on any of them would
  release a record — and resume reminders — on the strength of a read that
  failed.
- **Holding a record is NOT free, and the platform says so rather than
  inferring its way out.** A held record withholds reminders from whatever
  position currently bears that identifier, so where an identifier has come
  round again — after a network redeployment or a reset — a legitimate
  position goes without reminders. The report a person reads therefore names,
  for every long-held record it DESCRIBES, what its identifier points at now:
  no stored position at all, or a stored position in a given state that began
  at a given point — **labelled as stored and unverified**, because that record
  may itself be stale or left behind by a reorganisation, which is the same
  unsoundness that stopped the platform acting on it. A person can see from
  that whether the record is still about the position it was made for, and
  clear it if not.

  Records past the described page are named but not described, and the report
  says so in those terms: being named is not being examined, and nothing above
  such an identifier says what it points at now. That is the check the
  described records got and these did not — see the bounded-report point
  below, which this one does not override.
  Clearing is a deliberate act, and names the exact record that was read, so
  that a re-observation arriving between the reading and the clearing is not
  silently discarded.
- **Held records are named, not merely counted — up to a stated limit, and
  the limit is never silent.** Where more are held than the report describes
  in full, the remainder are still listed by identifier, because a record left
  out entirely would be withholding reminders with nothing anywhere saying
  which position it concerned, and this report is the only surface that
  discloses that at all. The report says plainly that those identifiers are
  named but **not** described, that the descriptions are of the longest-held
  records and do not take turns, and that resolving one of those is what
  brings the next into view. It does not promise detail that a later run
  would supply, because no later run would. Past the listing limit it names
  no more, says exactly how many it is not naming, and gives the enquiry that
  lists them — see the bounded-report point below, which this one does not
  override.
- **A described record's removal is written out in full, to be run exactly as
  printed.** Nothing is left for a person to assemble. Printing the *pieces*
  of a removal and describing how to combine them was tried three times and
  failed three different ways, each only noticed by a reader; the platform now
  emits a finished instruction, and it is checked by being executed rather
  than by being read.

  Records named but not described do not carry one in the message — there is
  no room for hundreds of finished instructions in one line — so the report
  gives them an enquiry that RETURNS each one's instruction, already written.
  Not the values to build one from: the assembly is the thing that kept going
  wrong, and an enquiry handing back parts would have preserved it in the one
  place hardest to check. The store builds the text, so the quoting is done by
  the same engine that will parse it. Naming a record while leaving it
  unactionable would, in practice, push a person toward the unguarded removal
  this report spends a paragraph warning against, and because the described
  page does not rotate it would push them there indefinitely.

  That value is a token **together with** the time of the sighting, and it
  takes both because neither covers the other's case. An ordinary write
  rotates the token, which is what separates two sightings inside the same
  second — a recorded time cannot. A write made while the store is still on
  the older shape CANNOT rotate it, and those are caught by the time moving
  instead. Saying simply that the token changes on every sighting would
  describe protection the fallback path does not provide. Either gap lets a
  removal delete a finding recorded after the person read the report — resuming reminders for a position nothing has
  settled, the exact harm this memory exists to prevent. A guard that can
  silently fail is worse than none, because its value is that it can be
  trusted without checking.

  One gap is left open and is written down rather than implied: a sighting by
  the older write shape landing in the same second as the one the person is
  holding moves neither half. That needs a deployment window or a failed
  question to the store, AND two sightings inside one second. Closing it would
  mean forcing the recorded time forward on a collision, which corrupts the
  one thing telling a person how long ago a record was actually made.

  A record written before that value existed carries an empty one, and the
  report prints it in a form that can be pasted as it stands rather than a
  word standing in for it. A record the platform never re-examines — the very
  case this report is for — would otherwise be named and permanently
  unremovable by the safe route.
- **An upgrade never costs a run its memory.** A deployment can publish new
  platform code before the store it reads has been updated to match, so for a
  short window the code runs against the older shape. Recording a withheld
  position is written to succeed against BOTH shapes, and the report is
  written to be readable against both, because a run that cannot record a
  withheld position leaves the next run free to remind on it — the exact
  failure this memory exists to prevent, arriving during its own upgrade. The
  platform asks the store which shape it has rather than assuming, and keeps
  asking until the newer one appears. Where the sweep that releases records
  must read the store to find them, what it REMOVES is bounded together with
  what it reads, so one run clears up to a stated number and the rest wait for
  later runs — the sweep runs on every run. That number is smaller than the
  report's, and for a harder reason: the store refuses a single instruction
  carrying more than a fixed count of supplied values, and an instruction that
  exceeds it fails the SAME way on every run, releasing nothing while
  appearing to work. The removal also re-checks, at the moment of removing,
  the fact that licensed it — between finding a record and removing it, the
  position under that identifier can have been replaced by a live one, which
  is precisely the reuse this memory is about. The reading itself still grows with
  how much is held, and that is stated rather than claimed away: no index can
  bound a question that spans two records and is not stored anywhere.

  While the older shape is in use, the report names withheld positions on the
  same terms as ever — up to its stated limit, with an exact count of any
  beyond it — because a deployment is exactly when a suppression most needs to
  be visible. What it withholds there is the removal procedure, and it says
  why: every such command names something the older shape does not have, so
  printing one would hand a person an instruction that cannot run and invite
  them to improvise the unguarded removal the report warns against. The
  enquiry that would fetch instructions for the records past the limit is
  withheld for the same reason.

  It does **not** promise how long that lasts. In an ordinary rollout it is
  minutes, and the report says so — but asking the store establishes only that
  the newer shape is ABSENT, never when it will arrive, and an update that
  failed or was skipped leaves this indefinitely. So the report tells a person
  what to do with a second sighting: if the same message appears on a later
  run, the update did not land and wants looking at, because these
  suppressions cannot be cleared safely until it does.
- **The report is bounded, and says so where the bound bites — and says
  exactly what is NOT bounded.** Reporting takes the same small number of
  enquiries every run, returns no more than a stated number of records to the
  platform, and lists no more than a stated number of identifiers however many
  are held. One thing is deliberately *not* fixed: establishing **how many**
  are held requires the database to consider every record that qualifies, so
  that part grows with the size of the fault. It is kept because the
  alternative is telling a person "more than 200" when the true figure might
  be three thousand — and the magnitude is the most actionable thing the
  report carries. The growth is confined to a counting pass the database can
  satisfy from its index rather than from the records themselves, and the
  page the person actually reads is a bounded walk of that same index rather
  than a sort of everything held.

  Stating this precisely matters more than stating it strongly. Earlier
  drafts of this point claimed fixed work outright, and each time the claim
  outran the implementation it was the *claim* that had to be chased — first
  the message length, then the volume returned, then the work the database
  does. A specification that promises more than the system delivers turns
  every review into a search for the next unbounded layer. The run holding
  the most records is the one least able to afford extra work, and the one
  whose failure would leave the network's reading position unrecorded and its
  view frozen; a report whose OUTPUT grew with the fault would fail on the
  only network that needed it. Where more are held than it will name, it
  states **how many** — an exact figure, not "at least", and taken in the same
  instant as the records it describes, so the two cannot disagree about a
  removal that happened between them — and gives the enquiry that lists the
  rest, returning for each that record's removal instruction already written,
  rather than the identifier alone or the values to build one from. A listing that simply stopped would
  be the silent truncation everything here is written to avoid.
- **Every route by which the PLATFORM releases a LONG-HELD record announces
  it, and there is only one way to write such a release of a single record.** The qualifier is not
  hedging: a record released before it was ever reported is deliberately NOT
  announced, because that is the ordinary case this memory is built around — a
  reading failed, the record was held for a turn, the next turn settled it —
  and a line for each would bury the ones that need a person. What must never
  be silent is the release of a record a person has been reading about.

  The platform releases records from more than one place — a periodic sweep, a
  run that settles the position, and the close-out that ends it — and
  disclosure was added to those one at a time as each was noticed, which is
  precisely how one of them stayed silent. A release the platform performs BY
  ITSELF, of a single record, is now expressible only through one shared form
  that always carries back what it removed, so no route has to remember to ask
  for that, and a new route cannot be added without deciding what it
  discloses.

  A removal a PERSON runs is outside that rule, and deliberately so. The
  report writes those out for them, one per record, and they are the subject
  of their own points above — guarded against a sighting arriving in between,
  reporting whether they matched, withheld entirely where they could not run.
  Routing them through a form built to announce what the platform did by
  itself would be announcing a person's action back to the person who took
  it. The rule is about routes that act unwatched; that is exactly why it
  exists.

  The periodic sweep is the exception, and naming it is the point. It removes
  a batch in one instruction, so it cannot use a per-record form and a check
  that demanded it would be wrong rather than strict. It carries its own
  disclosure instead, and it is the only such place: one instruction, and a
  check that refuses any OTHER single-record removal the platform executes by
  hand — the report's own instructions for a person are outside it, as above.
  An
  invariant with a stated exception is worth more than one that reads as
  absolute and is not.

  This is deliberately stated as a strong default rather than a guarantee. A
  route that obtained the shared form and then discarded what it returned
  would still be silent; nothing in the platform can prevent that, because
  these releases exist to be committed together with unrelated work and so
  cannot own their own execution. What closes the gap in practice is that the
  omission is now a deliberate act rather than an oversight, and that a check
  refuses any platform-executed release written by hand. Saying "by
  construction" here would
  promise more than the mechanism delivers, and a guarantee a reader trusts
  without checking is worse than one they check.
- **What a release announces depends on what licensed it, and there are four
  different licences.** A run that read the network for an identifier and got
  an answer has the soundest evidence the platform holds, and says so. A
  repair is a network read too, but of a position whose ending was never
  announced — so it says the ending was FOUND, rather than claiming one
  arrived.

  A repair only says that when its own write is the one that recorded the
  ending. Where it finds another writer got there first, it says less: on
  that path the other writer may well have been the announcement arriving,
  which is the very race the check exists to detect, so claiming no
  announcement came would deny the likeliest explanation. It reports a
  network read and nothing about announcements.

  A close-out did see the ending announced, and establishes that the position
  *currently* bearing the identifier ended, not that the record being released
  was ever about that position. Each names its own basis; none borrows
  another's. Sharing a mechanism does not license sharing a claim, and one
  announcement wired to every route said the strongest of them on all of
  them.
- **One automatic release remains an identity assumption, and is stated as
  one — by the release itself.** A record is released when a stored position
  bearing its identifier is no longer running. Where an identifier has been
  reused, that establishes the replacement ended, not the position the record
  was about — so the original unresolved finding is erased. The platform does
  not have a verifiable identity for a position and so cannot tell the two
  apart; this is recorded as a known limit rather than presented as a settled
  outcome. **The disclosure is made where the assumption is exercised**: the
  release names the CANDIDATES it read immediately before removing — a roster
  bounded by a stated limit — together with a count of what went, where the
  store reports one. Not a list of what it removed: the removal re-checks its
  condition, so fewer can go than were listed, and the platform then knows
  only how many, never which, and not why. Where the store reports no count, that is said:
  the number that qualified a moment earlier is given as exactly that, and
  explicitly not as a count of what went, because any of them may have been
  cleared or become live in between. The removal also re-checks its condition,
  so fewer records can go than were listed, and where that happens the
  difference is stated rather than left for a reader to notice. Leaving this to the held-record report would disclose
  nothing in the very case that matters, since a release can empty the report
  it would have appeared in.
- **A record is also released, correctly, the moment a run examines its
  identifier and the network answers — and that release is announced when the
  record was long-held.** This is a second path on which a reused identifier
  clears a record, and it is deliberately not prevented: the network's own
  answer about that identifier is the only sound evidence the platform has,
  and every basis it declines to act on is a stored value standing in for
  exactly this. Blocking it would withhold reminders indefinitely from a live,
  settled position on the strength of a finding about a position that no
  longer exists — the mirror-image fault this memory was built to avoid.
  What it must not be is invisible: where the record had been held long enough
  to appear in the report a person reads, its release is stated, along with
  the fact that if the identifier had come round, the answer concerns the
  position bearing it now and the earlier unresolved finding is gone with it.
  A record released before it was ever reported is not announced, for the same
  reason it was never reported: the ordinary case is a reading that failed
  once and succeeded on the next run, and announcing those would bury the
  records that need a person.
- The payment-due reminder for a loan paying interest on a schedule is
  confirmed against the chain before it is sent, rather than against the
  memory above — and the confirmation covers the PERIOD as well as the loan.
  A borrower who has just paid leaves the loan open and the platform's own
  record pointing at the period they settled, so every other condition passes
  and the reminder would arrive moments after the payment. The chain's own
  record of when the last period was settled decides it: if the period the
  reminder is about is not the period the chain is on, nothing is sent and the
  record is left for a later run, by which time the platform's own records
  have caught up.
- No reminder is sent on a network where settlement is currently switched off.
  Governance can disable periodic interest platform-wide, which stops new
  positions taking a cadence and makes the settlement itself refuse — but
  positions already open keep the cadence they were opened with, so they go on
  looking due. A reminder then instructs someone to make a payment the platform
  would reject, which is worse than silence and worst during the emergency that
  prompted the switch. A run reads that setting before it speaks, sends nothing
  on a network where it is off, and marks nothing — so reminders resume by
  themselves when it is turned back on. A run that cannot READ the setting also
  sends nothing: not knowing whether a payment can be made is not permission to
  demand one.
- A disagreement about WHICH period is current withholds the reminder in
  either direction, but the two directions are reported apart. The chain being
  further along means the borrower has paid and the platform's records are
  catching up, and nothing needs doing. The platform's own record being
  further along — a payment recorded and then undone by the chain
  reorganising, or a damaged record — does not catch up, because the
  correction pass does not revisit that field, so that position's reminders
  stay withheld until a person fixes the record. Reporting the second as the
  first would tell the reader to wait for something that never arrives.
- Confirmation is only accepted from a source that has first proved it is the
  network it is configured to be. A source pointed at a different network —
  by a swapped setting, say — answers every question confidently and about
  the wrong chain, and could certify a loan that has nothing to do with the
  one being reminded about. A run asks once, and stops if the answer is wrong
  or if the source cannot say at all.
- Confirmation is only accepted from a view of the chain that is at least as
  current as the platform's own records. A source lagging behind what the
  platform has already read still reports an ended loan as running, so it
  would confirm precisely the reminder the check exists to withhold; a run
  that finds itself in that position sends nothing and says so, rather than
  accepting an endorsement worth less than no check at all. A run that cannot
  establish how current its source is — because the comparison itself failed —
  also sends nothing: an unanswered question is not an answer, and treating it
  as one would turn a momentary database failure into permission to send. Every loan in one
  run is also checked against a single point in the chain's history, so a
  source that serves part of the answer from further back fails outright
  instead of quietly mixing two moments. It is the other message a person cannot un-receive, it is sent
  from a different part of the platform on a different schedule, and a rule
  held in one part does not reach the other. Confirmation means the chain
  still has that loan and still has it in the one state the interest payment
  can actually be made from — not merely that it has not ended, since a state
  that cannot be paid from would invite an action the platform would then
  refuse.
- That confirmation is true at the moment it is made, and the platform does
  not claim more. A loan that ends between the confirmation and the message
  going out is still messaged. What the confirmation removes is a record that
  has been wrong for hours or days; what remains is the few seconds in which
  no off-chain check could have known, on a reminder about a payment still
  days away.
- A single run sends a bounded number of these reminders, takes the nearest
  deadlines first, and does not always begin with the same network. Every run
  has a fixed allowance of outbound requests — covering every request it makes,
  its own queries to the chain included — so an unbounded one would stop
  partway through and take every network after it down with it, on every run,
  for as long as the load lasted. A run does not begin work on a network it
  cannot afford to both query and send for — including the cost of confirming
  that network's identity when that has not already been done, so a network it
  refuses spends nothing at all and the ones behind it keep what it would
  otherwise have wasted. The order is what makes the bound safe: a
  reminder deferred by it is nearer the front next time and arrives well
  before the deadline it concerns, where an arbitrary order would reach the
  same records every run and the ones behind them never.
- The bound is on OUTBOUND REQUESTS — every request the run issues, never on
  records examined or records handled. "Every request" includes the run's own
  reads and writes of the platform's records, not only its queries to the
  chain and the messages it sends: those leave the run just as the others do,
  and a bound that ignored them would let a run that believed it was rationing
  its messages exceed the real limit while sending almost none.
- The run holds back the request it needs to RECORD WHAT IT EXAMINED, and
  refuses to begin a record it could only finish by spending it. A run that
  used its last request on a reminder and then could not record what it had
  looked at would stay inside its allowance and examine the same records
  again on every later run, which is the starvation that record exists to
  prevent — so the two requirements are held together rather than traded
  off.
- **What a pass has examined is remembered RECORD BY RECORD, not as a place
  in the list (#2230).** A pass is one trip through every record awaiting a
  reminder. Each record the run examines, whatever came of it, is recorded as
  examined in the current pass, for the payment period it was examined for. A
  run takes the records the current pass has not yet examined, nearest
  deadline first; when none are left, the pass is complete and the next one
  begins with every record awaiting a reminder. A record examined for an
  earlier payment period counts as not examined, because its reminder now is
  a different one. Remembering a *place* instead (first a position in the
  list, then a deadline) could not take a record that appears in front of
  that place, and re-reading the front on every run would let records that
  are examined but never reminded hold the allowance on every run. Where a
  record's examination cannot be read, the record counts as not examined.
- **Each pass is dated and numbered by its own record, kept per chain, never
  by what it has examined.** The service records which pass is in progress
  and when it began, in the same step as that pass's first examinations. A
  record examined in a pass leaves the list once its deadline passes, so what
  is left in the list says neither how long ago the pass began nor which pass
  it is. Read from there, a long pass would keep looking recent and never be
  reported, and a pass whose examined records had all left would fall back to
  the number before it.
- **A pass is recorded as finished when nothing in the list is left
  unexamined in it**: in the same step as its last examinations, or on a run
  that finds no record awaiting a reminder at all. A record that appears after
  that begins the next pass, so a pass that ended days ago is not taken for
  one still running and its age is not reported as a backlog. Where the record
  is missing or cannot be read, the next pass begins, numbered above every
  examination the list still carries, so none of those can count in it; a
  record that cannot be read is reported, not taken silently for none.
- **THE RESTART PROPERTY, stated once and not restated elsewhere.** Every
  surface that describes records being examined again because what a pass
  examined was lost — missing, unreadable, malformed, or deliberately cleared
  during a restore — means exactly this and nothing more: *for that run*,
  examining a record again repeats work already done rather than stepping
  over anything, which is the direction the failure must take. It is **not**
  a guarantee that no reminder is missed. A run whose record of what it
  examined is never kept makes no progress through the list, so records
  further down are not reached and can pass their deadlines; and a single run
  whose re-examined front fills the whole allowance leaves the rest for a
  later run that may arrive too late. The run therefore announces each time
  that what it examined could not be recorded or read, rather than falling
  back quietly on the strength of one run being safe.

  This is written here once because it was written in five places and was
  wrong in all of them, in four consecutive reviews: the per-run property was
  stated as an absolute, corrected where it was flagged, and re-derived in the
  next surface. Anything needing it points here instead of restating it.
- **What "nearest first" does and does not promise, stated exactly.** Within
  one pass, the records not yet examined are taken nearest deadline first,
  and that includes a record that becomes known part-way through the pass: it
  is taken ahead of every unexamined record due after it, not left for the
  next pass. Across passes, every record gets its turn within each pass rather
  than competing forever with the nearest ones. What it does NOT promise is a
  second look within a pass: a record the pass examined without reminding
  anybody (nobody could be reached, a delivery was deferred, the network could
  not be read for it, the index was behind) is looked at again only in the
  next pass. That matters only where a pass takes longer than the notice
  period itself, and in that state the service is under-provisioned in a way
  no ordering can conceal. So the service says, each run, when the current
  pass has run longer than the reminder window, measured from that pass's
  own record and including the run that finishes it, rather than leaving the
  condition to be inferred. The honest statement is that this is bounded by
  how long a pass takes, not that it cannot happen.
- **The same allowance governs the runs that keep the records current, and
  those runs COUNT what they spend rather than estimating it.** The service
  that follows each network and writes down what happened draws on the same
  fixed allowance, covering its reads of the network and its reads and writes
  of the platform's own records alike. Exceeding it does not slow that run
  down; it ends the run before it can record how far it read, so the next run
  begins at the same place and does the same thing — a network that has
  stopped advancing while still appearing to run normally. Because that
  failure is silent, the figure may not be an estimate: a run measures what it
  actually issued and reports it, and a run that passes the limit says so and
  names which run it was, so a stalled network is announced rather than
  inferred later from records that stopped changing.
- **A statement prepared but never sent costs nothing, and statements sent
  together cost one departure but not one allowance.** This is stated because
  getting it wrong in either direction produces a confident figure that is
  still incorrect — counting work that never left the run, or counting one
  departure many times and refusing work that would in fact have fitted.
- **There are TWO allowances, and a run is held to both.** One bounds the
  requests a run may send; the other bounds the database statements it may
  submit. A batch of statements sent together is a single request but many
  statements, so the two allowances legitimately disagree about it, and a
  single figure would have to be wrong about one of them. Both are counted,
  both are reported, and a run that has passed either says so — a report that
  answered for requests alone would read as comfortable on a run about to be
  stopped for its statement count.
- **No part of a run may be exempt from the count by having been overlooked.**
  Whether a request is counted follows from the means it travels by, not from
  a list of the places that make requests. A list has to be revised whenever a
  new place is added and gives no sign when it has not been, which is how the
  figure came to be wrong repeatedly while appearing settled; a request made
  by a part of the system that knows nothing about the allowance is still
  counted against it.
- **The count is the whole run's, and an automatic retry is a request.** The
  limit applies to a scheduled run, and a run does several things at once —
  following the network, catching records up, retrying a listing that failed
  to publish, tidying old rows. Counting each of those separately would report
  several comfortable figures for a run that had already been stopped, so they
  share one count. For the same reason, a read that fails and is retried costs
  what the attempts cost: an attempt that reaches the network is a request
  whether or not the caller asked for it, and the attempts a failing provider
  causes are exactly the ones that decide whether a run survives.
- **These runs do not chase an address that has moved.** A request answered
  with "this has moved elsewhere" is not followed: reaching the new address
  would be a further request, and a count that charged only for the first
  would be short by however many moves the run was sent on. The alternative —
  following, and counting each move — requires the platform to reproduce the
  web's own forwarding rules exactly, and a second set of rules that must
  match the first is a promise to keep matching it. So the run is told plainly
  where it was being sent and stops there. The peers these runs talk to are a
  configured address for each network, a marketplace, and the platform's own
  services; none of them should be moving, and when one does the answer is to
  correct the configured address rather than to have the platform quietly
  follow a provider somewhere new.
- **The run is counted to its own end, not to the end of its main job.** Where
  a run does further work after the part that reads the network — announcing
  what changed to anyone listening, for instance — that work issues requests
  too, and they come out of the same allowance. A figure reported when the
  main job finished would be short by them, and a run finishing at its limit
  could then issue a further request with nothing having said so.
- **Every run reports what it spent, including the ones that end early or
  fail, and a run that passes the limit says so at the moment it happens.**
  The ordinary figure is the one that makes the limits re-settable from
  evidence, so reporting it only on the busiest path leaves the common case
  unmeasured. And the announcement cannot wait for the end of the run: the
  platform ends a run AT the request that passes the limit, so anything said
  afterwards is said by something that may no longer be running.
- Anything that occupies a record slot without issuing a request cannot
  consume the allowance — a record the chain declines to confirm is the case
  that arises, since nothing is worth asking about a loan the chain has never
  heard of. A record whose recipients have switched these reminders off DOES
  cost the run the lookups that established it, because there is no way to
  know someone opted out without asking; what it never costs is the messages.
  Were the bound on records instead, a record that sends nothing would hold
  the whole run's allowance while never being marked as handled, so the same
  few would sit at the front of the order on every run and the people behind
  them would never be reached. A run therefore continues past records it
  cannot send for, up to a stated limit of its own, reaches the ones behind
  them in the same run, and — because its remembered place advances past them
  — does not pay for the same prefix on the next run either.
- A run establishes how far the platform's own records have been brought up to
  date before trusting them against the network's head. If that position
  cannot be READ, or if there is NO stored position for the network at all,
  the run sends nothing — an absent position is only harmless where it
  explains itself, and on a network with stored positions it means they are
  there without the bookkeeping that says how current they are. The two are
  reported distinctly even though they stop the run alike: a failed read
  clears on its own, a position that is gone needs somebody.
- Where the deployment's own configuration prevents a channel from working at
  all, a run says so rather than silently not using it. "Cannot work" includes
  the libraries the deployment is built from disagreeing with each other about
  how to sign, not only a setting being absent or invalid — the disclosure
  names each possible cause, because the remedy differs and they are not
  distinguishable from the symptom. A channel established as unable to send is
  never charged against the run's request allowance and never counted as an
  attempt of unknown fate, because no request was made. A subscriber who has
  asked for a channel the deployment cannot sign for can never be reached on
  it, and a run that marks such records as handled while delivering nothing is
  the hardest failure for an operator to notice. The count is reported once per
  network per run, naming the setting — not once per record, which would train
  a real misconfiguration into background noise. This covers a credential that
  is present and unusable as well as one that is missing, and the platform
  decides which by what the sending step actually did rather than by
  inspecting the setting.
- A message the delivery service ANSWERED and refused is counted apart from
  one whose fate is unknown, and apart again from one it DEFERRED — rate
  limiting, or the service being briefly unwell. A deferral did not deliver
  and needs nobody; a refusal needs a person. Counting a deferral as a refusal
  sends that person to repair a configuration that is fine. They need opposite responses — a refusal is a
  credential or destination to fix and will keep failing until someone does,
  where an unknown attempt may be a passing incident — so flattening them
  leaves a reader unable to tell which is happening. Where a channel cannot
  distinguish the two, the platform says so rather than implying that channel
  never refuses.
- Whether a record is marked as finished is ONE rule about the record, not a
  verdict reached separately for each party. Marking it means "never revisit
  this period", which is justified exactly when no later run could do better
  for anybody. Three questions decide it:
  - **Was anybody actually reached?** Then returning would tell them about the
    same payment twice. The mark is per record, so one confirmed delivery
    settles it.
  - **Is anything uncertain?** A message that was issued and never answered
    for may have arrived. Returning risks the same duplicate, so an unknown
    blocks the retry exactly as a delivery does — the platform does not know,
    and a duplicate reminder is the worse of the two ways to be wrong.
  - **Is anybody owed another attempt?** Three things earn one, and the test
    they share is that each is a state which can CHANGE and then make
    delivery possible: a service that said "not now"; a subscriber who
    switched the reminder off and may switch it back on before the deadline;
    and a subscriber who asked for a channel this deployment cannot currently
    use, which an operator may repair. A refusal does not qualify — it will
    fail identically until a person acts on that credential. Having no
    channel at all, and having no subscription, do not either: nothing about
    those changes on its own.

  The record is left unmarked when somebody is owed, nobody was reached and
  nothing is uncertain; otherwise it is marked.
- The third of those is worth its own statement, because it is the one that
  looks like a settled outcome and is not. A subscriber who asked for a
  channel this deployment cannot currently use is OWED another attempt, not
  written off: an operator may repair the setting, or the dependency, inside
  the notification window, and a record marked as handled is never revisited
  — so marking it is the same "handled while delivering nothing" failure the
  disclosure above exists to make visible, arriving one step later. It stays
  unmarked until a usable channel
  either succeeds or leaves the outcome uncertain.
- A refusal does not earn another attempt, but it does not block one either.
  So a record where one party is owed an attempt and the other's channel was
  refused comes back, and the refused channel is tried again beside the party
  who is owed — there is no way to reach one without the other. The cost is a
  futile attempt each time that record comes round, which on a deployment
  whose credential has been rotated is every record with a party who has
  switched reminders off. What bounds it is the record of what each pass
  examined, which counts an unmarked record as examined exactly as it does a
  marked one: the futile attempt costs once per pass round the window, not
  once per run.
- **Being owed another attempt is not cancelled by the other party having
  nothing to offer.** A borrower whose reminder the service deferred stays
  owed one even when their lender turns out to have no usable channel at all;
  the lender's absence is not a reason to spend the borrower's retry. Only a
  real delivery or a real uncertainty may end it, because only those two can
  result in somebody being told twice. **This changes a previously stated
  behaviour**: a record where one party had no usable channel and the other
  had switched reminders off used to be marked, on the reasoning that the
  first party was settled. That is true of them and says nothing about the
  second, who may re-enable before the deadline — and since nothing was sent
  to anybody, there was no duplicate to protect against.
- Where a run reports how many subscribers a configuration problem affects, it
  counts distinct subscribers and not how many records they appear on. One
  wallet that is a counterparty on many positions is one affected subscriber;
  reporting it as many turns a single stale subscription into what reads like
  a deployment-wide outage, and those call for different responses.
- No reminder is sent on a network that is globally halted, which is a
  separate setting from the periodic-interest one and is checked first by the
  settlement route itself — and the platform asks it first too, so that when
  both are closed the reader is told about the halt rather than the milder
  state, and a failed read of the other setting cannot hide it. A network can therefore have periodic interest
  enabled and still refuse every payment. The halt also closes ordinary
  repayment, so someone told to pay has no route at all — which makes this the
  more serious of the two to get wrong. As with the other setting, a run that
  cannot read it sends nothing.
- Agreeing on a payment date is not agreeing on a payment schedule. Two
  different schedules produce the same date whenever the last payments differ
  by exactly the gap between them, so a run that checked only the date could
  send a reminder describing a schedule the position does not have. The
  schedule the platform read the position with must match the chain's, as part
  of what makes the reminder allowed at all.
- Every question a run asks the chain is asked about the SAME moment in that
  chain's history — whether settlement is currently possible as much as whether
  each position is still running. A setting read at "now" while the positions
  are read at a fixed moment can describe a state the positions were never read
  at, either because it changed in between or because two machines behind one
  address answered from different heights, and the result is the very reminder
  these rules exist to withhold. A run therefore settles on one moment before
  it reads anything, and accepts an extra question on a network with nothing
  due as the price of every answer describing one moment.
- A run that COMPLETES also reports, whenever anything happened that someone
  would want to know about — records nobody could be told about, attempts
  confirmed to nobody, unconfirmed channels, records the chain declined,
  records waiting on the platform's own to catch up, records it could not read.
  A run that reaches nobody never stops early, because reaching nobody costs
  nothing, so reporting only on an early stop is silent in exactly the case
  that most needs a person. A run where everything went right stays silent.
- A run will not begin a record it might not be able to finish, even when some
  allowance remains. Stopping between one party's message and the other's
  would mark the reminder as delivered with one side never told, and that
  side's reminder is then lost rather than delayed. Leaving a little allowance
  unused is the cheaper error.
- A run does not always begin at the front of the order. Not spending the
  bound is not the same as making progress: a record that sends nothing is
  also never marked as handled, so it keeps its place at the front and is
  examined again on every run. If enough such records sit ahead of a record
  that WOULD send, starting at the front every time hides it for good. So a
  run REMEMBERS where it stopped and the next one continues from there,
  wrapping to the front when it reaches the end. Where it resumes is
  remembered rather than derived from the time of day — deliberately, because
  anything schedule-derived can fall into step with another schedule and then
  never move: the platform's other rotations, or the interval between runs
  itself. Which network a run begins with is remembered
  for the same reason and in the same way. Where neither can be remembered,
  the run says so — starting from the front every time restores the unfairness
  the memory exists to remove, and would otherwise do it silently. What is
  remembered advances on the work actually done, which nothing else can align
  with. When the window fits in one run, which is the ordinary case, the
  nearest deadline is examined first as before.
- **What is remembered is the DEADLINE it stopped at, not a position in the
  list** — stated here as well as above because this bullet used to say the
  opposite, and a specification that describes one behaviour in two
  incompatible ways invites the defect back. It said the remembered place was
  approximate, on the reasoning that the list it indexed into changes between
  runs, and that resuming *near* where it stopped was all forward progress
  required. Forward progress was not all that was required: the list is
  rebuilt each run and the records handled last run are gone from it, so an
  index resumed past exactly as many of the nearest remaining deadlines as
  were handled — running the nearest-first rule backwards, which is the one
  guarantee this part of the platform makes. A deadline is not approximate and
  does not move when other records are handled or leave.
- A run that stops early says which limit stopped it, where in the window it
  resumed, and separates what it found — examined, reminded, reached nobody,
  had nobody to tell, declined by the chain, and unreadable — so the categories
  account for every record examined rather than leaving some of them
  unexplained between two totals. A run interrupted part-way still reports what
  its completed work did: the records it already messaged about are stamped
  permanently, so discarding those counts would hide real deliveries behind an
  error about a later step. Those need different remedies — a run reporting
  many declines is reporting records the platform holds wrongly, not load — so
  they are never flattened into one "deferred" count. "Reminded" means a message the
  delivery service CONFIRMED it accepted — not one the platform tried to send.
  A message refused by the service, or one whose fate is unknown because the
  attempt itself failed, is counted separately and never as a reminder; a
  recipient the platform has on file but cannot reach at all is counted as
  handled. Failed messages are counted **per channel and independently of
  whether the person was reached another way**: someone told over one channel
  while the other failed is both a reminder and a broken channel, and
  reporting only the first would hide an outage of one channel for as long as
  the other kept working. So the count can never claim people were told on a run that
  reached nobody, which is the number someone reads while investigating
  silence.
- The bound and the count deliberately disagree about a failed attempt, and
  that is the correct disagreement. A request that may have gone out has to be
  charged, because the limit exists to keep the platform inside what it is
  allowed to send; the same request must not be reported as a delivery,
  because nothing confirms it arrived. What never leaves at all — no signer
  configured, a channel the platform cannot use — is neither charged nor
  counted, and that case matters most because it fails every message of its
  kind rather than one.
- A corrected record carries the loan's amounts as well as its state,
  taken from the same reading and therefore describing the same moment.
  The events that move principal and collateral — a part repayment, a
  liquidation sale, a collateral release or top-up, an offsetting match,
  a written-off shortfall — can be missed exactly as an ending can, and a
  record stale enough to have missed an ending is not to be trusted on the
  amounts. Preferring the chain's figures gives nothing up: an ending does
  not erase what was outstanding, so where the chain holds a smaller
  figure that is an economic event the index missed, not a lost record.
- A record corrected to ended also drops everything the platform was still
  offering to act on for that loan — a collateral sale listing, a committed
  swap the borrower could otherwise still be shown a cancel action for. Each
  would fail at the contract, which is no reason to keep offering it. What a
  close clears is one list, and it is the same list whether the close was
  learned from its announcement or from this correction; a surface added to
  it is covered by both without either being changed.
- Ending a listing, or ending a commitment, is not ending the loan. A
  borrower who withdraws a collateral sale keeps any swap commitment they
  made, and the reverse. The platform never disposes of a position the user
  still holds as a side effect of tidying a different one.
- A corrected record carries NO ending time. The platform cannot determine
  when the loan ended, and the field is published and used to order and cap
  the list of positions with something to claim — so recording the moment
  of discovery there would present a months-old ending as fresh and push
  genuinely recent ones out of a bounded list. Empty is what is true.
- **A position whose ending has no known time ranks as unknown, not as
  recent.** Leaving the time empty is only half of that promise: a surface
  that then falls back to when the platform last WROTE the record makes the
  same false claim by another route, since a correction writes the record
  the moment it makes it. Wherever positions are ordered by how recently
  they ended, the ones with no known ending time come after all the ones
  that have one. They are not hidden — where nothing else competes they are
  all that is listed — but an unknown may never displace something known to
  be recent from a limited list.
- A record the chain has no loan for is not a running loan. Asking about an
  unknown position returns an empty answer whose state is indistinguishable
  from "running", so the platform tests that the position exists at all
  before believing it, and reports the ones it cannot substantiate instead
  of counting them as open forever.
- **Such a record is withdrawn from publication, not only reported.** Once
  the chain, read at its settled point, says it has no such loan, the record
  leaves every surface that lists or counts loans — together with its
  activity entries, its place in wallets' loan history, its notifications,
  and anything the platform was offering to act on for it — in one write, so
  no surface goes on presenting a position that never existed. The withdrawal happens
  only on that proof: a reading that failed is not evidence that a loan does
  not exist, and changes nothing. It applies to every record the platform
  publishes as a loan, running, ended or settled alike (settled records are
  checked for existence only, on a slow rotation, and a real settlement is
  never rewritten), and it is all-or-nothing: if
  the record, or the set of entries about it, changes while the withdrawal is
  under way, nothing is withdrawn and nothing attached to it is touched. The
  platform's memory of which alerts it already sent about the position goes
  with it, so a real loan later given the same number is warned from scratch.
  That includes the health-factor warnings, whose memory the alerting service
  keeps apart from the index: it drops what it remembered for the number on
  its next health check, and keeps only what it learned after the withdrawal,
  which is about the real loan. The record is kept whole, out of
  publication, with the settled point the proof was read at, so a person can
  put it back if the existence test itself was at fault. That kept record is
  backed up with the platform's other records that the chain cannot
  reproduce, since rebuilding the index from the chain cannot bring it back,
  and it survives a redeployment of the contracts, naming the deployment it
  is about;
  and the kept record itself is the operator's finding: every withdrawal is
  named on each pass until a person marks it reviewed, including after the
  records are restored from backup. The position's hold on reminders is
  lifted rather than kept, so a real loan later given the same number is
  reminded normally, because a position
  that vanished from the index is something a person should look at. Nothing
  public says the record was withdrawn, since nothing public about it was
  ever true.
- **A record that shows an ending, where the chain says the loan has since
  been fully settled, is brought up to settled even when the settlement's own
  announcement was missed.** Every ended-but-unsettled record is checked
  against the chain on a continuing rotation (each pass over the records
  finishes at the newest one it started with, so a steady stream of new
  endings cannot keep older ones from being checked), and is moved to settled only
  when the chain, read at its settled point, says so — never to any other
  ending, since the chain cannot say how a loan ended more precisely than the
  record already does. The settlement's block and time are recorded only
  when the announcement that carries them is found and confirmed against the
  chain; otherwise they stay unknown. A record left reading "ended, not
  settled" would otherwise present claims as outstanding on a loan whose
  claims are all made.
- **A corrected position's verified holders enter its participation
  history.** The history of who has held a position is written as transfers
  are announced, and the stretch that lost an ending can also have lost a
  transfer. So when a correction reads the current holder of either side
  from the chain, that holder is recorded as a participant if the history
  has no entry for them on that side — with the chain time of the settled
  point they were confirmed at, since the moment they acquired the position
  is not known. A holder already in the history is left as recorded, and a
  side the chain did not name records nothing.
- **A corrected position's history shows that it ended, as something the
  platform observed rather than something it saw announced.** The activity
  history is a record of the chain's announcements, and a corrected position's
  ending was never announced to the platform, so no announcement is invented
  for it. Instead the history carries a separate entry, marked as found by
  checking the chain: it says the position was in its ended state by a given
  settled point of the chain (and that point's time, when known). It does not
  say when the position ended, which event ended it, who acted, or in which
  transaction — none of those was seen. The entry sits in the history in the
  order of the point at which it was observed, and stays there after the
  position later settles. Positions corrected before this entry existed carry
  no such entry, because the point at which they were observed was not kept,
  and none is made up for them. Where the history cannot say whether such
  entries exist (for example while the platform's records are being upgraded),
  it says that it does not know rather than presenting the history as complete.
- A lifecycle state the platform does not recognise is reported, never
  passed over. Refusing to guess at an unfamiliar state is right; doing so
  silently is how a newly introduced ENDING would leave records published
  as open while every check reported health.
- The correction and that clearing are ONE write: both happen or neither
  does. A correction that landed alone would take the record out of the set
  the rotation examines, so nothing would ever return to finish it — and a
  service interrupted between the two leaves no failure to report. There is
  no partial state to recover from because there is no window in which one
  can exist.
- The correction runs on every tick the index is up to date with the
  chain, INCLUDING on a chain producing no new blocks. A check that only
  ran where new blocks had arrived would never run on a quiet chain, which
  is precisely where an old missed ending sits undisturbed.
- It runs before any surface that tells a person something. Reminder and
  inbox messages are derived from the records as they stand and are never
  withdrawn once sent, so a position corrected after they were composed
  would have produced a payment reminder for a loan that had already
  ended. A correction is also announced to anyone watching that position,
  like any other change, wherever the deployment's ingest arrangement carries
  live announcements at all; where it does not, a corrected screen waits for
  its own next refresh, and the platform says which arrangement is in use
  rather than implying the announcement is universal — a record put right
  silently would leave every
  open screen showing the old one.
- Every holder of a corrected position the platform can establish receives
  the ending in their inbox — and where it can establish neither, which is
  the ordinary outcome once both parties have claimed, nobody is written to
  and nothing is retried. Without this message an establishable holder
  receives nothing at all for that position, since the message surface is
  built from announcements and this ending never had one. Such a message states when the platform FOUND OUT, never when the
  loan ended — the check cannot determine that — and is marked as derived
  from a correction rather than attributed to an announcement nobody saw. A
  bookkeeping position that no person holds produces no message.
- Where the chain establishes that a loan is finished but not how — one
  state is reached by repayment, by default and by forced sale alike — the
  message states only that it ended. It never names a cause the platform
  did not establish, and it is never withheld merely because the cause is
  unknown: an ending nobody is told about is a worse silence than one told
  without its cause.
- The recipients of such a message are established from the chain, never
  from the platform's own record of who holds the position. The gap that
  lost the ending could equally have lost a transfer of the position, so
  that record is stale for the same reason. Where a holder cannot be
  established, that side receives no message rather than one addressed to a
  guess — and the holder the platform does establish is recorded, so the
  surfaces asking who holds a position NOW stop naming the wrong one. The
  parties a loan began with are published separately and a correction does
  not revise them, so a position that has changed hands may still show its
  original names where that half is read; the platform must not present the
  narrower repair as the wider one.
- Asking who holds a position has two answers the platform will act on: it
  has an answer naming a holder, or it has no answer. **An answer is acted
  on; a non-answer changes nothing.** The platform does not read a
  failure to answer as meaning the position was given up, even though that
  is one of the things it can mean — the two are indistinguishable from
  here, and treating an unreachable answer as an empty one would erase a
  record that is still somebody's.
- The cost of that asymmetry is **stated, not implied**: where a holder
  cannot be read, that side is never told its position ended, and no later
  attempt is made. The record is still corrected, because a position wrongly
  published as running is the harm the whole check exists to end. Waiting
  instead — holding the correction until the holder can be established — is
  not available, since the unanswerable case and the legitimately-empty case
  are the same answer, so waiting for one would leave the other's record
  wrong permanently.
- **A position that finished the ordinary way therefore reaches nobody**, and
  the platform states this rather than promising a message it does not send.
  The undifferentiated finished state is reached by both parties taking what
  is theirs, which destroys the holdings the question of ownership is asked
  about — so for the commonest case there is no holder to establish. The
  record is corrected regardless. Relaxing the rule to use the last name the
  platform stored is not the remedy, since avoiding exactly that is why
  ownership is asked of the chain; the remedy is a record of who HELD a
  position that no longer exists, which is a separate capability.
- Such a message is SHOWN as a correction, not merely recorded as one. Its
  headline states the outcome, and a line beneath it says the platform
  found this by checking and cannot tell when it happened. A surface that
  rendered the outcome alone would present a discovery about something
  months old as news of the moment — which is the same unstated unknown the
  message's own date is careful to avoid.
- How fast the correction works through the records depends on the
  deployment's ingest configuration, and the platform states this rather
  than implying a single pace. Where the chain reading has its own capacity
  the correction examines several records a turn; where it shares capacity
  with the other scheduled work it examines one. Every record is still
  reached either way — but only while the shared arrangement is within the
  capacity it is allowed. Beyond that the rotation is best-effort, because
  work can be cut short before the turn advances and the same records can be
  missed repeatedly; the platform states that rather than presenting an
  assurance the arrangement cannot keep. The pace is never raised at the cost
  of the chain reading itself, because a reading that starts being refused drops the
  announcements the correction exists to recover from — and where the
  scheduled work already asks for more capacity than is available, the
  platform says so rather than presenting the smaller share as sufficient.
- A position the platform publishes as open must be one it can still
  substantiate as open. Where it cannot, the surfaces that count and the
  surfaces that list must not answer the same question differently
  without saying so.
- Activity history may depend on indexed history, but current positions must not
  disappear merely because ingestion is delayed.
- The Activity feed's "is this event mine" filter covers the wallet's WHOLE
  loan history, not just currently-held positions: a settlement or
  keeper-triggered default on a loan whose position NFT was since claimed
  (burned) or transferred away still appears in the wallet's feed. If the
  participation history can't be read, the feed reports unavailable rather
  than silently narrowing to held positions only; a wallet with more
  participation history than one read returns folds into the page's
  recent-activity-only disclosure.
- Beyond the wallet's own loans, an event is the wallet's when the wallet is
  one of its PARTICIPANTS: the wallet that acted in it, or a wallet it names as
  affected (a counterparty, a buyer, the owner of a setting, intent, vault,
  perk or reward). It is never the wallet's merely because the wallet's address
  appears somewhere in the event: an administrative event, a treasury or
  cross-deployment record, a service operator's own accounting, or an address
  the event only approves or permits does not put a row on the wallet's page.
  Which addresses count as participants is one platform rule that the history
  service and the app share, written down for every event that names an
  address, so a new kind of event is decided on purpose rather than shown or
  hidden by accident. Every kind the rule admits has a plain-language name in
  the reader's language. Sanctions screening records are not feed rows (a
  flagged wallet is told by the in-app banner); the funds consequences that are
  the wallet's own (proceeds or rewards held, set aside or forfeited) are rows,
  in the in-app flagged wording only, with no list or provider named. A setting
  recorded against the wallet's vault rather than the wallet (the risk-access
  consents) is not yet shown; that gap is tracked (#2707). (#2703)
- An Activity row states the asset and amount its transaction moved or offered
  when the activity record carries them as normalized fields — exact, or as a
  range for an offer that commits one. It never reconstructs an amount the
  record does not state, never presents an NFT leg as a token amount, and where
  an amount exists but cannot be stated it says so rather than showing nothing.
  (Stated in full under the Activity surface below — #2383.)
- Realtime push refreshes matching indexed views when available. Polling remains
  the fallback.
- The push signal covers every class of change a holder-keyed view depends on —
  including position-ownership transfers (a position NFT changing hands, a
  claim burning one) and entitlement changes that alter what a party is owed
  without changing the loan's status (for example a partial rescue of a
  pending-fallback loan). The push rail also reports its own freshness (how
  recently ingestion advanced, and how often it is expected to), so the app
  can tell a healthy-but-quiet rail from a stalled one instead of guessing.
- A live-update signal is not lost because the platform stopped between
  recording a change and announcing it. Some changes cannot be found again
  once recorded (a correction made by checking the chain, a withdrawn record,
  a reminder, and every announcement already read past), so the intent to
  announce is noted before the work starts and cleared only once the
  announcement is out. A turn that finds a note left standing announces that
  everything may have changed, naming no particular loans or offers, since
  what the lost turn changed is not known.
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

### Typed amounts are sent exactly as typed

Every amount a user types into a value-moving form is the amount the
transaction carries, to the token's smallest unit. A token can only be divided
as finely as its own decimal places allow, so an amount with more decimal
places than that cannot be sent as typed. Such an amount is refused, never
rounded up or down into a nearby figure, and the form says why: it names the
token and the number of decimal places it accepts. Until the amount is fixed,
the step or button that would act on it stays unavailable.

This holds for every money input, including amounts the user never sees again
before signing (such as a fee ceiling), because a rounded figure would mean
the review states one amount while the contract moves another.

### Receipt amounts are exact

The amounts a review receipt states are the exact figures the transaction
carries, to the token's smallest unit: what is lent, borrowed, locked as
collateral, or owed in interest. They are never rounded for display, up or
down, because the user's consent is given against those numbers and a rounded
figure would describe a different amount from the one signed. A shorter,
rounded figure may appear on browsing surfaces (lists, cards) where nothing is
being agreed to.

The rule covers every surface where the user agrees to a figure, not only the
offer receipt: refinance, loan sale, offset, obligation transfer, early exit,
the trading desk's ticket and signed-fill confirmation, rentals, VPFI deposit
and withdrawal, the Full tariff quote, the position page's receipts (including what a claim
pays and the recorded debt stated beside it), the Claim-everything checklist,
and the pending-step cards that ask for a top-up or state a bound. A row that
only links to the loan page where the claim is made may round. A shortfall or
minimum stated beside an amount input ("you need X more", "at least X") is
exact for the same reason: a rounded minimum can sit just below the real one,
and a user who typed it would be refused.

Consent is collected against the terms actually shown. If a material term,
warning, selected offer, selected listing, or disclosed risk changes after
consent, consent is cleared and the user is told to review again.

Selecting another offer also resets its Full-tariff choice. Offset funding
figures and a listing's lifecycle, network, or ownership changes invalidate
their acknowledgements in the same update as the displayed change. If an
offset acknowledgement had been ticked, the card explains that its figures
changed and asks for a fresh review; the notice clears on acknowledgement or
completion. An untouched card does not announce a lost acknowledgement.

Clearing it afterwards is not sufficient on its own: at the moment signing is
offered, the consent on file must be consent given against the disclosures
currently on screen. A disclosure that has just arrived must therefore block
signing immediately, in the same breath as it becomes visible — never only
once a follow-up pass has cleared the tick. The two rules differ exactly when a
disclosure resolves late, which is the common case for anything the app has to
fetch before it can warn.

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
- Before asking for the acceptance signature on an offer, the app asks the
  platform whether that acceptance would be refused, and stops without a wallet
  prompt if it would. The reason shown is the platform's own first refusal —
  the same one the transaction would have raised — stated in words the reader
  can act on, and never re-ranked or reworded into a different reason by the
  app.
- A refusal the app does not recognise still stops the acceptance. The app can
  be older than the deployment it is connected to, so an unfamiliar answer is
  treated as a refusal it has no words for, never as permission to proceed.
- The app does not attach a measured figure to a refusal unless the platform
  supplied one for that refusal.
- Where a deployment predates a given refusal reason, the app proceeds as it did
  before that reason existed rather than blocking; the platform still enforces
  it at transaction time.

## Borrowing and Lending

- Guided borrow and lend flows begin with user intent: asset, amount, duration,
  and acceptable terms.
- Matching open offers are shown first when available.
- Matching offers are a recommendation, so only offers the independent token
  security check has answered for are offered as a pick. An offer the check
  flags as dangerous is left out, and the list says how many were left out. An
  offer whose check has not finished is shown in its place, marked as being
  checked, and cannot be chosen until the answer arrives. Offers beyond the
  part of the list the check has covered are never recommended unchecked: when
  flagged offers leave the list short, more of the list is checked, up to a
  bound; past that bound the list says that more matching offers exist and
  links to the Offer Book, which lists every offer and marks those the check
  warns about. The
  link is given in place because the Offer Book is not in Basic mode's
  navigation.
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

- Basic mode shows a plain newest-first book, and lets anyone choose which
  side to show and how to sort it (rate or loan length) — plain choices that need
  no expertise. Advanced mode adds filtering by raw asset address.
- Each token-for-token offer states its loan-to-value, with a one-clause
  definition (the loan's value as a share of the collateral's), worked out from
  the protocol's live oracle prices with each side valued by its own token's
  precision. The figure is the ratio at the amounts the card shows, and it is
  never presented as exact or as a limit across fills: where a fill of another
  size could carry another ratio — a ranged or part-taken offer of either side,
  and EVERY borrow request — the card says so. A borrow request is never stated
  exactly, even one whose collateral ceiling equals its floor: a direct funding
  locks exactly the amounts shown, but a matched fill locks only what the
  lender requires, so the resulting ratio can be higher. A request that earlier
  matched fills have already part-used has no single pair of amounts a further
  fill would carry, so its card states that the ratio is not given rather than
  one taken against the original floor.
  When the
  protocol treats either side as illiquid the card says the ratio isn't worked
  out and names both possible causes (no reliable price, or too little trading),
  since it cannot tell which; when one side's value rounds to nothing at that
  size it says the ratio can't be worked out at this size; when a price could
  not be read it says the ratio couldn't be checked right now; while the prices
  are loading it says so. It never shows a figure it cannot back, and never a 0%
  that only means "unknown". Rentals, offers with an NFT on either side, offers
  with no collateral, and loan-position sales state no ratio.
- A borrow request that asks to refinance a running loan says so on its row
  and names that loan, so a lender can tell it from an ordinary borrow request
  before opening it. The market data records which loan a request is for, or
  that it is not a refinance request, or that it has not been read yet; the
  row shows the tag only when the request is known to be a refinance request,
  and never presents an unread request as an ordinary one by stating that it
  is not a refinance.
- A lender's review of a refinance request says what accepting it does
  (#2421): it names the running loan, and says that accepting opens the
  lender's loan and, in the same transaction, pays off and closes that loan.
  It states how that payoff is funded: the amount the accepting lender lends
  goes to the borrower's wallet as with any loan, less the borrower's
  loan-initiation fee, and the payoff to the running
  loan's current lender is then drawn from that wallet, so the new loan can
  fund part or all of it, with the borrower covering any difference. The
  collateral is described from the request's
  own recorded decision: either the stake already locked under the running loan
  carries over to the new loan (not a new pledge), or the borrower pledged a
  new batch and the old loan's collateral goes back to them when it closes. The
  review reads this from the chain, and until it knows whether the request is a
  refinance it says it is checking (or that the check failed, with a retry),
  shows no lender receipt and cannot be signed. The loan a request targets
  can change after the request is posted (it can be repaid, closed or have
  collateral added), so the review also runs the protocol's own acceptance
  check for the request, and confirms it is the loan's currently recorded
  request (only that one can be taken), re-reads it while the review stays open, and reads it
  once more at signing, refusing to sign against a review it no longer
  matches. A refresh that fails leaves the review unknown again (check
  failed, with a retry) rather than showing the last answer as current, and an
  offer that no longer exists (cancelling deletes it) is shown as no longer
  open, with nothing to sign, never as an ordinary borrow request. Each check
  reads every fact it combines from the same block, so it never mixes a state
  from before a change with one from after it. When that check refuses, the review says the request
  cannot be taken right now and why, shows no lender receipt, and offers
  nothing to sign. When the deployment has no such check, the review says it
  cannot confirm the request is still takeable and that a stale request fails
  on-chain, moving nothing but the attempt's network fee. A check that passes
  does not promise success: the borrower's payoff funding and the market at
  the moment of acceptance are checked only by the accept itself. The offer
  list in the guided flow tags a refinance request the same way the Offer
  Book does.
- Each offer states its collateral as an amount, not only a token name, so a
  lender can judge an offer before opening it. When the collateral is recorded
  as illiquid, the row says that on default it is handed over as-is rather than
  sold. The row never presents collateral as liquid merely because nothing
  marked it illiquid, and says the illiquid flag is the status recorded when the
  offer was posted — acceptance checks liquidity again, and the loan follows that
  result. NFT collateral is named by its token (and quantity, for a multi-unit
  token); a token amount whose details are loading or could not be read says so,
  rather than showing only a contract address. A borrow request can commit a
  collateral RANGE — a floor and a ceiling. Once the market data carries the
  ceiling and the part earlier fills consumed, the card states the request's
  own terms and nothing it cannot know: the collateral the request holds now
  (the whole ceiling for an unfilled request; what is left of it for one that
  earlier matched fills have part-used) and its floor, and that how much a
  given fill locks depends on how the request is filled. It does not narrate
  what each fill path locks, because that depends on the path — a direct
  funding, a matched fill, a refinance that carries over the old loan's
  collateral — and on the deployment (whether partial fills are on, which
  also decides whether unused collateral is refunded at a match or stays
  committed), none of which the card reads. For a part-used request it states
  how much earlier fills consumed — a running total, not what is locked
  today, since a resulting loan may have settled — and when what is left is
  below the request's floor it states that fact rather than presenting the
  remainder as available. A part-used request keeps the same terms — what is
  held, the floor, and the fill-dependence — none drops out after a first
  fill. For the same reason a borrow request's loan-to-value names its basis
  (the requested amount against the request's collateral floor, not the larger
  commitment shown beside it) and is always qualified as the ratio at
  the amounts shown. Until the ceiling or the part already used has
  been read — older market data, or a request the index has not re-read yet —
  the card states only the floor, as "at least" that amount, never an assumed
  range or an assumed exact figure. A lender offer that can be taken in part (a range, or
  already partly taken) states its collateral as the requirement for the full
  offer, since a smaller take needs proportionally less. When the token's details
  cannot be read, the recorded amount is still shown, in the token's raw base
  units, with the failure named — and a borrow request's known commitment and
  floor are stated the same way rather than reduced to "at least" the floor. A loan-position sale row says its collateral is the
  running loan's, rather than showing the zero its own row carries.
- A filter with no matches says the filter has no matches; it does not claim the
  whole market is empty.
- Action labels are role-specific so the user understands whether they are
  borrowing, funding, renting, or buying a position.
- Another user's offer that cannot be taken from this page (part of it is
  already taken, or it uses an NFT as the loan or its collateral) says why on its
  row, rather than showing a bare label with nothing to do. The page's
  introduction promises the review-before-signing step only for offers that can
  be taken here.
- Ended offers are not actionable during indexer lag when the chain already
  shows that they ended.
- Rows that carry risky, unknown, or unverifiable token legs show visible risk
  badges before the user reaches the review screen.

## Rate Desk

Rate Desk is the market view for supported fungible-token markets. It is open to
every user, not only to traders: its wording avoids trading jargon, a short
"how this page works" guide explains it on a first visit, and every choice on the
offer form explains what the selected option means in visible text rather than
only in a hover tooltip. A constraint that narrows a choice (a signed lend offer
being single-fill) is stated beside that explanation, never instead of it. The
page does not promise an offer can be cancelled "any time" where a deployment
makes new offers wait a short while before they can be cancelled, nor that an
offer posted for free by signing only can be changed (it can only be cancelled
and posted again). The middle rate is described as worked out from the best
offers on each side, never as a rate anyone has offered; when those offers come
from a saved copy because the live read failed, the chart's description of it
says so, since on a phone the chart can be shown without the offers list that
carries the same warning. The page's introduction does not claim to show every
offer for the pair, because signed offers can be unavailable or cut short, and
the first-visit guide does not call the list current: it says the list is
normally read from the blockchain and can fall back to a saved copy that may lag. A list scoped to the
selected pair and loan length names both. A free signed offer's "until I cancel"
choice says it stays open for at most seven days, because its signature
expires. Projected earnings are stated as conditional on the offer being taken
and repaid. Wording about automatic matching says it applies while automatic
matching is switched on, since a deployment can switch it off.

Signed offers come from the offer-book service rather than the blockchain, so
the page says when it is showing a market without all of them. One note, above
every view of the market, carries this, because the header's middle rate, the
offers list and the chart all draw on the same merged offers, and on a phone the
list or the chart can be on screen alone. While signed offers are still loading,
or when the service could not provide them, the note says the rates shown come
only from offers posted on the blockchain and that the best rates and the middle
rate may be missing signed offers. A deployment that has no offer-book service
set up says that instead — signed offers are not available there at all — so a
standing configuration is never presented as a temporary failure. When the
service may not have returned every signed offer — it says it cut some, or does
not say whether it did — the note says the rates and amounts shown, even at the
best rate, and the running totals may leave some out. It makes no claim about
which signed offers were included: even the best-priced ones the service kept
can expire before the next refresh while the next-best stays unfetched. A signed
offer that could not be refreshed is treated as missing, never shown from an
earlier read, because it may have been taken or cancelled since. Whenever the
signed offers are anything short of complete, an empty offers list says there
is nothing to show and that not every signed offer could be checked, never
that the market has no offers.

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
- A terminal loan also never presents checks or warnings that only make sense
  for an open loan — for example the lender's forced close-out, or a
  "still checking whether this loan can be closed out" state. Whichever source
  first shows the loan is settled is enough to retire them, because a settled
  loan cannot become open again.
- A loan's outcome is styled as a warning only when it was adverse (a default
  or liquidation). A loan that closed normally reads as settled, not as a risk.
- Fallback-pending loans remain visible as active because the borrower may still
  cure them before the lender finalizes the fallback.
- Past-due loan pages show the grace window and the consequence of inaction.
- Once grace has ended, the lender's notice does not promise that the loan
  will be closed automatically. Whether an automatic close-out runs is a
  per-deployment setting the app cannot read, and even where it runs it
  leaves some loans open, so the notice says automatic close-out may be
  switched off and that the app cannot tell. It does not promise the lender
  can act either: it points to this page's close-out card, when shown, for
  whether the lender can close the loan out now and what stands in the way
  if not, and says anyone may close it first.
- A position row whose loan is past its grace period says so ("Past grace"),
  distinct from a loan that is past due but still inside grace. Whether grace
  has ended is the protocol's own answer, judged by chain time against the
  live grace schedule, never the device clock; until that answer is read the
  row keeps its ordinary time-based label (as it does when a re-read fails or cannot run because the device is offline, rather than repeating an earlier answer; an answer requested before the row was opened, or before the device regained focus or connectivity, is not shown until a read sent since then completes) and, whatever that label says (the device clock may be behind the chain's), says on its own visible line, independent of whatever the badge shows, that the grace answer is still being checked or is unavailable, and it is re-read periodically
  because governance can lengthen the grace schedule and reopen repayment.
  That answer establishes TIME eligibility only — a close-out can still be
  refused for reasons the row does not read, such as a pause — so the row's
  explanation says a close-out may now be possible and points at the
  position page. The explanation is visible on the row (not only on hover)
  and is by side: for the lender the position may now be closed out and
  anyone may do it first; for the borrower the ordinary repay window is over
  and the loan may be closed out against the collateral.
- Health and risk labels escalate when collateral health is poor.
- Position rows should offer the next relevant action where one exists. A row
  with a payout waiting says what that payout is and offers to collect it.

### Taking back extra collateral

The platform lets a borrower withdraw collateral from an open loan as long as
the loan stays healthy (ProjectDetailsREADME, "Allow Borrower to Withdraw Excess
Collateral"). The app offers this to every borrower, in Basic mode, because it
is the borrower's own money.

- The surface appears for the current borrower-position holder on an open loan
  with fungible collateral, using the reconciled loan status (a loan the live read
  confirms is open again appears even before the position lists catch up). When
  the live loan status says the loan is no longer
  open (repaid, defaulted or liquidated elsewhere), the surface goes away, even
  if the position lists have not caught up. A fact the surface depends on — who
  holds the borrower position, whether the loan is open — counts only while its
  latest read succeeded: a read that failed to refresh is treated as unknown, never
  as its last answer. If the collateral token's details cannot be read, the
  surface stays and says so, rather than disappearing. It says plainly that taking collateral back makes
  the loan riskier: with less collateral, a price drop reaches liquidation
  sooner.
- Before asking for anything, it states how much can be taken back right now,
  from the protocol's own live limit, and keeps that figure fresh while the page
  is open. It says that the limit moves with prices, so an amount right at the
  limit can still be refused. The limit is never displayed above its true value:
  a figure shortened for display is rounded down, so typing what the page states
  is always within the limit.
- When nothing can be taken back, it says why, as far as the app can tell: the
  loan needs all of its collateral, or the collateral cannot be priced right
  now. When the app cannot tell which, it says that instead of choosing one.
  A limit the app could not read is never shown as zero. A zero is explained only
  once the live loan status confirms the loan is open, since a closed loan also
  reads zero; until then the surface says the loan's status could not be
  confirmed.
- An amount above the limit is refused on the page, with the limit stated. An
  amount with more decimal places than the token has is refused and named, never
  rounded into a different amount; the confirmation states the exact amount that
  will be sent.
- When the deployment is paused, the surface says withdrawals are paused instead
  of offering the form, and the pre-check refuses to open the wallet.
- When the surface shows an amount but could not read a fact the pre-check
  depends on — whether the deployment is paused, or whether a sale listing is
  linked (including on a deployment too old to answer that ahead of time) — it
  says so beside the amount, rather than presenting the withdrawal as
  unconditionally available and revealing the obstacle only at submit.
- The confirmation's button is disabled whenever the wallet cannot send — an
  unsupported network or no wallet client — or when the reviewed amount is no
  longer valid (the limit fell below it), rather than accepting a click that
  does nothing or can only fail.
- While a review is open or a send is in flight, the amount cannot be edited: the
  amount on screen is always the amount the wallet is asked to send.
- While a refinance request stands on the loan, the surface says
  that taking collateral back would make every lender's acceptance fail and
  asks the borrower to cancel or wait — the same interlock partial repayment
  and early close-out apply — and the pre-check refuses. A request is found
  wherever it was made — on another device or through another tool — because
  the app reads the protocol's record of the loan's refinance request (#2425):
  a request that still stands is the one that holds the loan back, and a
  recorded request that has lapsed but was never cancelled by the current
  holder is shown as expired, for cleanup (the protocol refuses a new request
  until it is cancelled). The pre-check repeats that read just before the
  wallet opens. A request the record does not name — one posted before the
  protocol kept the record, or one a newer request replaced — can never be
  accepted and holds nothing back; the app still looks for one among the
  current holder's own offers and, when it finds it, shows it as a request
  that can never be accepted and offers to cancel it. Cancelling such a
  request never removes its payoff approval: the same approval serves every
  refinance request the wallet posts on that token, and another may stand now
  or be posted from another device at any moment, which no check made before
  a separate revoke transaction can rule out. The card says so before and
  after the cancel and names where to remove the approval by hand. (Cancelling
  the loan's own request still removes it; a request posted elsewhere in the
  meantime then shows its short approval on its own card, with the action to
  re-approve.) When the record proves no request stands but the details of
  its lapsed request cannot be read, nothing is held back and only a new post
  is reported as unconfirmed. That look is best effort: when it cannot answer,
  nothing is held back, because nothing the protocol would refuse depends on
  it, and the page says it could not check for an older request and names the
  manual cleanup (Your open offers; the standing token approvals in Settings). On a deployment that
  predates the record, the search over the holder's own offers decides
  everything, as described next. When the record cannot be read, the
  surfaces a request would be stranded by hold back and say so. When the search cannot answer, the
  surfaces a request would be stranded by — taking collateral back, partial
  repayment, early close-out, obligation handover and offset — hold back and
  say why, rather than assume there is none, and say which of two reasons
  applies: the search failed (it may answer on a later try), or the holder has
  posted more offers since the loan's own offer was made than one search reads
  (a retry will not help, so the surface does not suggest one, and says full
  repayment stays open). Such a search still reads the newest offers, so an
  open request among them is found and shown as usual — only a search that
  found no open request in what it read is reported as unable to answer. The bound is the loan's own offer, which can be older
  than the loan itself, because the chain records no start for a loan that
  later events do not rewrite. The protocol now records each loan's request
  and whether it still stands (#2407) — the same rule the search applies: not
  taken, cancelled or expired, posted by the current holder of the borrower
  position, on a loan that is still active. Whether a lender could fill it
  right now is not part of either rule, so a request that can no longer fill
  holds the loan until the borrower cancels it. The app reads that record first
  wherever the deployment has it (#2425), so the search's two limits — a read
  that fails and a holder with too many offers to read — no longer decide
  whether a request holds the loan back there.
- An open confirmation does not survive a network switch or a change of
  connected account: it closes, and the typed amount is cleared, so a review
  opened on one network or under one wallet can never send on another.
- A pre-check that fails is reported as a check that could not finish — the
  wallet never opened and nothing was spent — never as a failed transaction.
- Before the wallet opens, the app re-checks what would make the protocol
  refuse: the sanctions screen, that the wallet still holds the borrower
  position, that the limit still covers the amount, that no sale listing of the
  lender's position is linked to the loan, and that no swap-to-repay order is
  pending against it. Each refusal is said in plain words. Where the app cannot
  undo the obstacle itself (a swap-to-repay order placed with another tool), it
  says so rather than pointing at a control that does not exist. A swap-to-repay
  order that reached its deadline without filling still blocks the withdrawal
  until it is cancelled, and the surface says so rather than implying expiry
  releases the collateral. When one of these checks cannot be answered, nothing
  is sent and the surface says it could not check, rather than treating an
  unread answer as a clear one.
- Taking back extra collateral stays available to a wallet that has not accepted
  the current Terms, like repaying and topping up: it returns the borrower's own
  assets and opens nothing new.
- The confirmation states what arrives in the wallet, that nothing more is owed,
  what is put at risk, and that the rest of the collateral stays locked until
  the loan closes.
- When the collateral is VPFI, the surface says that taking it out of the vault
  lowers the balance the fee-discount tier is measured on, so the discount may
  drop. When the app cannot tell whether the collateral is VPFI, it says that
  and gives the same caution, rather than treating unknown as "not VPFI".

### Loan status and what is owed, as the page states them (#2466, #2470)

- An internally matched loan is closed but not settled until its claims are
  collected. While a claim is pending, the page says the match closed the loan
  and that it settles once its claims are collected; it never calls the loan
  settled before the protocol has settled it.
- Where the page reconciles an indexed status with a live read of the chain,
  it uses only a live read that is running and did not fail. A stopped read's
  last answer, or an answer kept across a failed refresh, describes the loan as
  it was, and is never allowed to override the indexed status — so a settled
  loan is never shown as merely repaid because of an old answer.

### Forced close-out of an overdue loan

- A lender holding an active position whose repayment window and grace period
  have both elapsed is offered a way to close the loan out from the position
  page. The capability exists in the protocol for any caller; the product's
  obligation is to make it reachable by the party who is owed.
- Whether the grace period has elapsed is decided by the protocol, not by the
  app. The grace schedule is configurable, so an app that recomputed it from the
  loan's own dates would be correct only until a deployment changed it, and
  would then be wrong about the one fact this surface exists to state. The app
  may show the grace window to explain a wait; it must never use its own
  arithmetic to decide whether the action is permitted.
- The card states what it decided and as of when. Beside its wording it
  carries, in a form a machine can read, the state it resolved and the block
  at which every fact behind that state was evaluated — one block for all of
  them, because they are read together. Every resolved state names its block;
  a decision the app cannot date is not stated, and shows as still checking
  instead. The block is omitted, never stated as zero, only beside that
  still-checking state — while the facts are unread, or when the app has set
  the state aside as unknown for a reason of its own rather than resolved it
  from those facts. A reviewer, or an automated check, can therefore ask the
  protocol the same questions at the same block and compare the answers to
  what the card says, instead of inferring the state from prose.
- Two settlement routes are distinguished, because they are not equally
  available. Where closing out transfers the collateral as-is — collateral
  without a reliable market price, or collateral whose value has collapsed far
  enough that selling it is moot — the app offers the action directly. An
  overdue NFT rental is offered directly too, but it is NOT that route and must
  not be described as one: ending a rental removes the renter's access, leaves
  the lender's own asset exactly where it is, and makes the rent paid up front
  claimable less fees. Nothing belonging to the borrower moves, and no
  valuation of collateral decides what comes back. Where the protocol requires the collateral be sold on an exchange,
  the app routes the sale itself and offers the action directly. When the
  lender confirms, it asks every exchange it can reach for a price on selling
  the loan's whole collateral for the lent asset, and sends the answers with
  the close-out, best price first and the rest as back-ups. Which exchanges
  the protocol can use, and how it refers to each, is read from the protocol
  at that moment, never from a list the app keeps, because governance can add,
  remove, disable or reorder them. Prices are asked for at confirmation rather
  than when the page loads, because they do not keep. The app never protects
  the sale price itself and does not claim to: the protocol checks each
  attempt against its own price feed and will not sell below its minimum.
- That route has an outcome the lender must be told before confirming: if no
  attempt can sell at the protocol's minimum when the transaction runs, the
  close-out still goes through but the sale does not, and the loan moves into
  the protocol's fallback — the lender can claim collateral instead of sale
  proceeds, and until they do the borrower can still repay or add collateral.
  Before sending, the app runs the close-out against the chain as it stands
  and, where the network can show it, checks whether that run would end in a
  sale or in the fallback. If it would end in the fallback, nothing is sent
  and the lender is told why; the card described a sale, and a close-out that
  would not be one is not sent on that description. Where the network cannot
  run that check, the disclosure on the card is the whole of what is known.
  Where the app cannot ask any exchange because the deployment is not set up
  to, it says so as a standing condition rather than as a passing lack of
  prices, and a roster the app could not fully read is reported as unread,
  never as "no exchange". The confirmation describes sale proceeds up to what the lender is owed (any
  surplus going to the borrower), the fallback, and a settlement against an
  opposing position, and names no amount. A successful sale may pay whoever
  submits it a caller incentive out of the proceeds, before they are divided;
  the incentive is reduced by the sale's realised slippage and can be nothing,
  and is never paid to a wallet the sanctions oracle has flagged. The surface
  says which of those applies to the viewer, or that it does not yet know, and
  names no amount. Because a settlement against an opposing position may be
  reached instead, and that route pays its submitter a matcher incentive
  straight to the submitting wallet, the surface also states that payment as
  conditional on the match, for the viewer's own wallet, wherever it says a
  match may appear and the viewer can submit. That incentive is a share of the
  settled amount and can round down to nothing, which the surface says rather
  than promising a payment.
- Aggregator prices are requested with the protocol's own effective
  liquidation slippage ceiling, read from the protocol at confirm time, not
  with a figure the app or its quote service assumes. When that ceiling cannot
  be read, no aggregator is asked.
- The card's own judgement of whether a route can be offered is the same
  per-exchange judgement the confirmation uses, made from the same reads: an
  exchange the app does not ask at all (0x, below), or one
  the app cannot price on that network (a Uniswap V3 adapter trading another
  set of pools than the app's quoter), does not count as one the app can
  ask, and a
  refresh of the exchange list that failed leaves the card saying the list
  could not be read, not repeating the last answer.
- An aggregator that may bind its liquidity to the account originating the
  transaction (0x) is never asked by the app. The account that originates the
  transaction cannot be known for every wallet the app supports (a Safe, a
  smart account sent through a relayer, one not yet deployed), so asking on a
  guess could return a price the protocol then cannot use. A confirmation that
  then finds no price says some exchanges could not be asked from here, and,
  when another exchange also gave no reliable answer, that a retry may help
  but the unasked exchanges stay unasked.
- Whether an aggregator can be asked is judged from what the quote service
  says it can quote, not from the service merely being configured: an
  aggregator the service holds no key for is not counted as available, and
  the card says an operator is needed rather than offering a sale every
  confirmation would refuse. When the service's answer cannot be read, the
  card says the exchanges could not be read.
- A route that is sent although some exchange the app asked never answered
  says so before the wallet is asked: it carries fewer back-ups than it
  might, and if its prices fail when it runs the close-out goes to the
  fallback. The lender can still reject it in the wallet.
- An answer from the quote service that carries an error, even with a success
  status, counts as no answer from that exchange rather than as a refusal.
- The sale disclosure also states the in-kind outcome: if, before the
  transaction runs, the protocol comes to treat the collateral as illiquid or
  its value collapses past the protocol's threshold, the collateral is handed
  over directly and the loan ends at once, or, where the loan's terms do not
  allow that, nothing happens beyond the network fee.
- The last checks before the wallet is asked (that no buyer has accepted a
  sale of the position, and that the collateral is still the amount the
  prices were collected for) are read at one block, so they describe one
  state of the chain. They cannot cover the time between that block and the
  transaction running; the app says what it checked, not that the race is
  closed.
- Where the protocol's own exchange list has no enabled entry on that network
  (or none is registered), no caller can close the position by sale until
  governance enables one; the app says that, rather than suggesting an
  operator could close it, and offers no button.
- Where the protocol has enabled exchanges on that network but none is one
  the app can ask, the app states that the position is closable, that the sale
  must be routed by whoever submits it, and that nothing submits it on its own,
  and offers no button it cannot honour. Presenting an action that is certain
  to be refused is worse than presenting none: the user pays a network fee for
  the refusal. While the list of exchanges has not been read, the surface says
  it is still checking; when the read failed, it says so. A confirmation that
  gets no usable price sends nothing and says that nothing was sent or spent.
- A third route is available where the protocol can settle the overdue
  position against an opposing one instead of selling anything. The app
  can perform that close-out directly, and says so — it is distinguished
  from the in-kind route in what the lender receives, since this one
  repays the asset that was lent rather than handing over collateral.
  Whether such an opposing position exists is asked of the protocol, not
  inferred. An unanswered question resolves to the surface's
  outcome-neutral state — the one that says a check is still running —
  and NOT to whichever description seems more cautious. There is no
  cautious description here: every other route names what the lender
  receives, so choosing one of them on an unread answer is a claim, and
  the wrong one whenever the protocol settles the position against an
  opposing one instead.
- Settling against an opposing position is a capability each deployment can
  switch off (#2082). "No opposing position right now" and "this deployment
  does not settle against opposing positions" are different statements, and
  the surface keeps them apart: it reads the deployment's setting alongside
  the other facts behind the card, as of the same block. Where the surface
  would otherwise warn that an opposing position may appear before the
  transaction runs, and the setting is off, it says instead that internal
  matching is switched off on this deployment, so the outcome it describes is
  the one that happens unless that setting changes first — and it does not
  offer the matcher incentive, which only a settlement against an opposing
  position pays. Where the setting cannot be read, the surface keeps the
  warning, which is true whichever way the setting stands.
- Where that opposing position exists, the surface must not describe the
  consequence of losing it as a single outcome. Another party may settle
  against the same position first, and what happens then is decided by the
  route the protocol reaches next — which may hand over the collateral as it
  stands, end a rental, or refuse the close-out for the cost of the network
  fee alone. Telling a lender the only downside is a wasted fee, on a
  transaction that can instead complete and return a materially different
  asset, is a false statement about what they recover. The surface states the
  route it would actually fall to, and where it cannot read enough to know,
  says that rather than choosing the likeliest.
- Where losing the opposing position would leave a sale, the close-out carries
  that sale with it (#2078). The race is intrinsic — the opposing position is
  one anyone can act on, so no fresher read removes it — and the protocol tries
  the settlement first and reaches the sale only when the settlement is gone.
  So the confirmation asks the exchanges for a price exactly as it does for a
  sale and sends those routes with the settlement: a lost settlement then ends
  in a sale, or in the protocol's fallback when every route fails at that
  moment, rather than in a refusal the lender paid for. Not finding a price
  does not withhold the settlement itself; the close-out is then sent without
  a route, and the surface says in advance that a lost settlement would then
  fail for the network fee alone. A route the chain already shows would fail
  into the fallback is not sent, as on a sale. Because the ending may be a
  sale, the surface says that a sale pays no matcher incentive and may instead
  pay its submitter the sale incentive, under that incentive's own conditions.
- That fallback is the surface's own routing decision asked again with the
  opposing position absent — never a second, hand-written account of the order
  the protocol tries things in. One description of that order is a
  requirement, not a convenience: two will diverge, and the divergence surfaces
  as a confident sentence about somebody's money that no longer matches what
  the protocol does.
- The confirmation shown before the lender signs is part of this surface and
  carries the same obligation. It must describe the route being confirmed
  rather than the commonest one: an overdue rental sells nothing, transfers
  nothing belonging to the renter, and leaves no shortfall for the lender to
  absorb, so a confirmation written around collateral sale economics misstates
  every one of its own lines for that route.
- The in-kind route also covers collateral that is itself a non-fungible asset
  held against an ordinary loan. That is a supported shape and a distinct one
  from a rental: the leg being lent and the leg securing it are separate
  questions, and a surface that answers only the first will ask an
  inapplicable question about the second and wait indefinitely for an answer
  that cannot arrive.
- Nothing on this surface states an amount. The settlement path is chosen while
  the transaction executes, so no figure is knowable in advance, and a predicted
  one would be invented.
- The asset returned is not assumed to be the collateral. The protocol may
  instead settle the position against an opposing one and return what was lent,
  in the asset it was lent in, and the surface says so rather than naming one of
  the possible outcomes as though it were the only one.
- Closing out is not stated as certainly final. It ordinarily ends the loan, but
  a settlement that covers only part of the position, or a sale that cannot be
  carried out, leaves the loan open and closable again later.
- Nothing on this surface implies the lender is the only party who may act. Any
  caller may close out an overdue loan, and a lender returning to find the
  position already closed is to read that as the normal course rather than as a
  loss.
- Nor is the party who submits assumed to be the party who is paid. What a
  close-out recovers goes to whoever holds the lender's position for that loan
  at the moment it executes, so a holder who has since transferred or sold the
  position is told plainly that it is no longer theirs.
- Closing out is not presented as payment. It ends the loan; what the lender is
  owed becomes claimable afterwards through the ordinary claim route — with one
  stated exception. Where the protocol settles the position against an opposing
  one, it pays whoever submitted the transaction an incentive directly to that
  wallet, deducted from the settled amount rather than added to it. A surface
  that says nothing reaches the wallet by itself is wrong twice over on that
  route: about the payment, and about the amount left to claim. Both are
  disclosed.
- A surface must not describe an amount as depending on a valuation the route
  does not perform. An overdue rental makes an already-paid, fixed sum
  claimable; a settlement against an opposing position returns the lent asset
  priced when the transaction runs. Neither is a question of what collateral is
  worth, and neither may borrow that sentence.
- A close-out confirmation must not state a loss that cannot occur. A rental
  becomes closable only once its term and the grace period after it have both
  expired, and the full term was paid at origination — so there is no remaining
  term to forgo. Where a route genuinely risks nothing, the surface says so
  rather than filling the space, and states what is actually at stake instead:
  until the close-out runs, the renter retains access they are no longer
  entitled to.
- What a surface says immediately after a close-out is submitted must not
  assert an outcome the transaction has not yet reported. A settlement covering
  only part of the position leaves the remainder running with nothing claimable
  yet, so the post-submit message describes the result as still being decided
  and directs the lender to the refreshed position, never to a claim that may
  not exist.
- A surface that has lost track of a submitted transaction says so, and keeps
  the action withheld while it does not know. Elapsed time is not evidence that
  a transaction failed: one that has not confirmed may still confirm, and
  offering the action again on the strength of a timer invites a second
  close-out behind a live first one. So the surface states that it cannot
  account for the transaction, that this does not mean it failed, why the
  action is withheld, and that the wallet is where the answer is.
- Withholding an action indefinitely over a question the platform cannot answer
  requires an answer from someone who can. Because a record of the submitted
  transaction now survives leaving the page and returning, no ordinary action
  by the lender clears a transaction that has genuinely vanished — so the
  surface offers them a way to state that their wallet no longer shows it,
  which ends the wait. It is framed as the lender's statement about their own
  wallet rather than as a control that checks anything, and it says what it
  costs to be wrong, because presenting it as a check would claim a capability
  the platform does not have.
- A record that a close-out was submitted belongs to the position and the
  network it was sent on, not to the page that sent it. Reloading, navigating
  away and returning, or having the same position open more than once must not
  produce a surface that offers the action again over a transaction already on
  its way; and equally, learning that the record has been cleared elsewhere
  must stop the wait rather than leave it running against a record that no
  longer exists.
- A conditional sentence whose condition cannot arise on the route being shown
  does not belong on it. The swap-to-repay cancellation note is the case in
  point: that facility covers ordinary-asset loans only, so an overdue rental
  can never carry such an order — and the sentence, while never false, puts a
  borrower repaying a loan on a surface whose position has a renter paying
  rent. Unreachable conditions are shown only where they are reachable.
- Where a surface shows subtotals beneath a total, and the source may count
  something in the total that it cannot yet place in any subtotal, the surface
  states the difference. A reader who can subtract and find an unexplained gap
  is worse served than one shown the gap and told what it is. The rule holds
  even when the omission is the source behaving correctly — an admitted
  undercount is still an admission the surface must carry.
- The same rule binds in the opposite direction, and more strongly. Where the
  subtotals add up to MORE than the total they sit beneath, the figures
  contradict each other, and the surface says so rather than presenting the
  smaller discrepancy of nothing at all. Rounding a contradiction away asserts
  by omission that the numbers reconcile, which is a claim the surface cannot
  support and a reader can disprove with arithmetic. What it states is the
  disagreement itself: that the fault lies in the counting rather than in any
  position, that nothing is at risk because of it, and that the correct split
  is not known. Both the total and the breakdown remain on screen exactly as
  reported, so the discrepancy can be seen rather than taken on trust.
- Where one freshness figure is stated over data drawn from more than one
  request, it is the figure of the LAGGING request. Quoting the more advanced
  of two reads presents one dataset's coverage as though it covered both.
- The order in which a surface reports obstacles follows the order the protocol
  applies them. A loan still inside its repayment window is refused for being
  early before any infrastructure condition is consulted, so a surface that
  reports an infrastructure pause first tells a lender their close-out is
  merely delayed about a position the borrower may have most of the term left
  to save. Where two gates would each block, the one the protocol reaches first
  is the one the reader is told about.
- A route the protocol may only partly complete is not described as completing.
  Settling against an opposing position moves the smaller of the two, so where
  that position is smaller than this loan only part settles and the remainder
  stays open — which the surface says before the lender acts, not only
  afterwards.
- Where a single freshness figure covers more than one request, EVERY request
  it covers must carry its own position marker. A response that arrives without
  one is not a weaker claim to be outvoted by its sibling; it is the absence of
  a claim, and it disqualifies the combined statement rather than borrowing the
  other's.
- A disclosure about cancelling something belonging to the counterparty is
  suppressed only on facts that cannot change for the life of the position.
  Predicting it from a live measurement that may have moved since the position
  opened withholds a warning that is still true.
- Where the protocol re-decides a route at execution time, every surface that
  names an outcome discloses that it may be re-decided — in BOTH directions.
  The opposing-position check runs when the transaction executes, not when the
  page was read, so a position described as returning collateral may instead
  repay what was lent, exactly as one described as settling against an opposing
  position may lose it. Disclosing one direction of a symmetric race and not
  the other leaves the undisclosed half reading as a promise.
- Operator instructions name a file the tooling actually reads. Telling an
  operator to configure a value in a template that nothing loads produces a
  deployment that is misconfigured while its operator believes otherwise, which
  is worse than no instruction at all.
- Where a settlement may be partial, no sentence on the surface may describe
  its result as terminal — including sentences about what SOMEONE ELSE's
  close-out does, and sentences about when the proceeds can be collected. A
  partial settlement leaves the position open and smaller, and holds the
  settled portion until the remainder closes, so "it will show as closed" and
  "it becomes claimable once this settles" are both wrong for it.
- Withholding an action for safety must not withhold the explanation with it.
  Where a check that guards the close-out is unanswered — pending, failed, or
  undecodable — the surface stays visible in its unresolved state and says a
  check is running. Removing it entirely leaves the lender with neither the
  action nor a reason, for as long as the underlying failure lasts, which is
  indistinguishable from the capability not existing.
- The surface appears before it can be used — while checks are still running,
  and while the borrower still has time — and says which of those applies. A
  capability shown only at the moment it becomes actionable cannot be
  anticipated, planned around, or asked about.
- An unresolved check is never reported as "not available". The two are opposite
  claims: one describes the app's knowledge, the other the protocol's answer.
- That rule binds hardest on the read that decides whether the surface belongs
  on the page at all. A loan whose status has not been read yet is not a loan
  the protocol has said is closed, so the surface appears in its unresolved
  state rather than being removed. Removing it is the strongest possible
  statement — it tells the lender the capability does not apply to this
  position — made on the one reading that has not happened, and a lender who
  never sees the surface has nothing to wait on and no reason to return.
- Sequencer health is judged before collateral is classified. While the sequencer
  is unavailable the protocol reports every asset as unpriceable, so a surface
  that classified collateral first would describe the wrong settlement route and
  offer an action the protocol refuses for an unrelated reason.
- Conditions the protocol checks before it will close a loan out are reported as
  states of this surface, not discovered when the action is attempted. Two are
  distinguished because they mean different things to the reader: a
  protocol-wide pause, which is temporary and affects everyone; and a loan
  opened without both parties recording the risk acknowledgement the protocol
  requires before it will hand over collateral that has no market price, which
  is permanent for that loan and refuses every caller equally. The second is
  stated as such — not as a limitation of this app, and not as something waiting
  will resolve.
- The protocol is asked one final time immediately before the action is sent.
  Several facts behind the decision can change while the user is reading the
  confirmation, and each turns a correct action into a certain refusal. Asking
  the protocol whether the action would succeed is preferred over the app
  re-deriving that answer from its own copy of the rules.
- Forced close-out is not offered while a completed sale of the lender's position
  is awaiting its final step, nor while the app has not yet established
  whether one is — an unanswered question about a pending sale withholds
  the action rather than permitting it. The check is repeated against live
  state immediately before the action is sent. A buyer's funds must never be
  stranded by a close-out ending the loan their purchase depends on. The
  protocol keeps the two apart itself: a sale's acceptance completes it in
  the same transaction, and is refused from the loan's maturity on, while a
  close-out is possible only once the grace period has passed (#2078). The
  surface's check is the rule it shares with the protocol's own keeper, kept
  as a second line rather than as the only one.
- Forced close-out remains available to a lender who has not accepted pending
  changes to the Terms. Withholding it would place paperwork between a lender and
  collateral owed to them by a counterparty already in breach.
- It likewise remains available to a lender whose wallet is flagged by sanctions
  screening. Screening withholds the ability to open new exposure; closing out a
  loan that has already defaulted is a wind-down, which the protocol keeps open
  to every caller so that a position cannot be made unclosable by the status of
  the party who is owed. Surfaces that create exposure are withheld from a
  flagged wallet; this one is not, and the distinction is deliberate rather than
  an oversight in the gating.
- The surface claims a loan is overdue only where the protocol has said so.
  States reached before that question is answered — a protocol-wide pause, checks
  still running — describe what is being waited on instead, since those are
  reachable by a loan that is nowhere near its due date. An unavailable sequencer
  is NOT one of them: the protocol settles the repayment window before it
  considers sequencer health, so a loan withheld for an outage has already been
  confirmed overdue and is described as such.
- A close-out this app has broadcast is watched continuously until its outcome is
  known, and the record of it survives leaving the page. Watching that stops and
  restarts can no longer recognise a replaced or cancelled transaction, because
  recognising one requires the original to still be in flight — so the wait is
  never given a deadline. Elapsed time changes only what the surface SAYS: past a
  few minutes it stops describing an ordinary pause and states that it can no
  longer account for the transaction, while continuing to watch.
- The action stays withheld for as long as the surface has not reconciled the
  transaction, and the device-local record backing that is kept for exactly as
  long as the withholding lasts — including after a success, whose figures the
  surface has not yet caught up with. After a successful close-out the surface
  waits for the refresh it asked for to COMPLETE, rather than judging by
  timestamps whether the figures look new enough; a device whose clock moves is
  then unable to make a refreshed reading look stale, or a stale one look
  refreshed.
- The refresh it waits for must be one that could have seen the close-out. A
  read already in flight when the outcome arrived was sent against the position
  as it stood BEFORE settlement, so letting it satisfy the wait releases the
  action over figures that predate the transaction — the exact staleness the
  wait exists to prevent, arriving faster than the wait can notice. Reads
  outstanding at that moment are therefore abandoned rather than counted, and
  the surface waits on reads it started afterwards.
- The wait is also scoped to the reads whose answers the lender is about to act
  on. A read the surface has stopped consuming, or one the refresh would not
  re-issue, can never report anything and would hold the action open forever if
  the wait included it. Waiting on more than is needed is not the safer error
  here: it is indistinguishable, to the reader, from the surface having lost
  the transaction.
- Reads left out of that wait are DISCARDED, not just left alone. A read the
  surface has stopped consuming still holds its last answer, and the states
  that stop it consuming one are reversible: a close-out that leaves the loan
  awaiting a further step suspends these checks, and a borrower curing that
  state resumes them. Resuming them against answers taken before the close-out
  would put a route, and an action, back on screen on facts the close-out
  already invalidated — with the wait long since satisfied, because there was
  nothing left in it to wait for. So a reading that will not be refreshed is
  dropped rather than kept: the check resumes from nothing, says it is running,
  and asserts no route until it has an answer of its own.
- Dropping a reading has to reach whatever is displaying it. Discarding it
  somewhere the surface no longer consults, while the part of the app that
  renders it still holds its own copy, leaves the stale figure on screen and
  makes its disappearance depend on something unrelated happening to redraw the
  page. The discard tells the reader of that value, directly, that there is no
  longer a value — which is what makes the surface fall back to saying a check
  is running.
- Where a transaction is never resolved, the lender's own statement that their
  wallet no longer shows it is the only route back to the action. Because it is
  the only one, when the surface offers it must not depend on the device's clock
  being correct: a clock corrected backwards after the transaction was sent, or a
  record written while the clock was wrong, cannot be allowed to withhold that
  route. Elapsed time is measured so that no clock fault can delay it
  indefinitely.
- Where the browser refuses to keep that record, the surface says so and names
  the consequence: this page still withholds the action, a reload will not.
- When the protocol establishes that a close-out did NOT execute, the surface
  says which of the three things happened — the call was rejected, the wallet
  cancelled it, or another transaction from that wallet took its place — rather
  than returning silently to its ordinary state. All three leave the position
  untouched and the action available again, so the surface offers it; what
  differs is the cause, and the cause is what tells the lender whether to expect
  the same result next time. A screen that looks untouched after a funds-moving
  attempt makes the reader reconstruct the outcome for themselves.
- Learning from another browser tab that a close-out has been disposed of does
  not, by itself, release this tab's withholding. The other tab knows about its
  own transaction and nothing about whether this tab's figures have caught up;
  after a partial settlement the position remains open and legitimately
  actionable, so the protocol would accept a second close-out while this tab
  still described the first one's expected outcome. Only this tab's own refresh
  can end its withholding.
- Before a close-out is sent, the surface re-reads that record so a confirmation
  open in a second tab does not send a duplicate. It does not claim this is a
  lock — two tabs acting in the same instant is a race the browser offers no way
  to settle — and it says what it did rather than implying the position closed.
- Erasing this browser's data does not reach a transaction already sent. The
  erasure states that: what is removed is this app's note of it, the transaction
  continues, and the app will no longer be following it.
- Where the protocol has no path that could produce an outcome, the surface does
  not warn about that outcome. A rental cannot be settled against an opposing
  position — the protocol's search requires the rented asset to carry a market
  price and its settlement moves fungible assets only — so a rental close-out is
  described as ending the rental, with no competing-settlement caveat.

## Claims

- Once the reward claim window is in force, the interaction-rewards card states
  the soonest date by which an unclaimed reward must be claimed before it
  returns to the rewards programme. The date is the earliest the platform could
  act under the CURRENT claim window — it assumes the reward stays claimable
  from now on — so time the reward cannot be claimed moves it later, while a
  change to the claim window itself can replace it with an earlier date; the
  card says both. Inside the final notice period the card switches to a
  final-notice warning. The card shows no date while the claim window is
  off. It considers every one of the wallet's LIVE rewards — not settled, not
  already expiring — however many, all as of one moment, and never re-prices
  the wallet's settled history; when it cannot read every reward's date it says the check could not
  be completed, rather than showing a date that might be later than the real
  one, or nothing at all (which would read as "no deadline").
- A wallet with interaction rewards set aside for it can always take them on
  their own, and the page does not describe the wallet's claims as empty while
  such a balance is ready. The balance is described as READY only when the
  wallet is clear to claim: while the wallet is flagged it is described as set
  aside and claimable once the flag is lifted, and while the screen has not
  answered it is described as set aside and nothing more. The reward claim
  gates read the same bar the platform enforces — flagged now, or carrying a
  committed flag while the sanctions oracle is unreachable — so a wallet the
  platform would refuse is shown blocked, while an unflagged wallet during an
  outage stays able to claim. When the card cannot preview the wallet's whole claim (for
  example because the claim cannot complete), it still shows the set-aside
  balance and offers a claim that pays exactly that balance. When the whole
  claim can be previewed, its figure already includes the set-aside balance,
  so the card does not show it a second time. The card never says why the
  balance was set aside.
- Claims are chain-authoritative.
- Indexed data may provide candidates, but live ownership and claimability
  decide whether a claim is actionable.
- A claim attached to a purchased position is discoverable by the current holder
  even if that holder was not an original loan party.
- Claim rows show the amount or asset the user can receive when knowable.
- Every surface that offers a claim — the claims list, the collect-everything
  checklist, the loan's own page and its confirmation, and the positions list —
  states the same payout in the same words. A surface never asks the user to
  collect "your funds" while another surface knows the amount.
- While the exact payout is still being read, or if it cannot be confirmed, the
  surface says so instead of leaving the amount out. Collecting stays available
  either way: the claim pays the on-chain entitlement, and an informational read
  must never stand between a user and their funds. When the read confirms there
  is nothing on that side, the surface says so and does not offer to collect.
- A payout is described by what the claim actually pays: the amount the protocol
  records for this claimant (a lender's share of a fallback settlement, not the
  whole collateral), and every separate lane the same claim pays — including a
  borrower's left-over amount from a swap that repaid the loan, which is listed
  even when it is the only thing to collect, and collateral added while the loan
  was in a failed-liquidation state that the claim pays in a different asset.
  An amount whose token details are still loading is described as an amount,
  never as something else, and never replaced by another lane of the same claim.
  An NFT the claim pays is named beside any other lane — a lender's in-kind
  recovery is listed together with proceeds held for them, not instead of them.
  Proceeds held for a lender are paid in a single asset, so their amount is
  stated like any other. An amount whose token details cannot be read at all is
  said to be unreadable; it is never shown as still loading.
- The confirmation keeps the same honesty as the page: while the payout is being
  checked, could not be confirmed, or is confirmed empty, the confirmation says
  that rather than a general description of what such a claim usually pays —
  and rather than an earlier answer kept from before the latest check failed.
- A position row with a claim waiting shows the loan's live status, not an
  indexed status the chain has already moved past.
- The payout is composed from the loan's status as the page currently knows it,
  after the live chain read has been taken into account. A loan the chain shows
  as repaid is never described as a default recovery because the indexed record
  has not caught up.
- A confirmation that was opened while the claim was still being checked stands
  down, and says why, if the check then confirms there is nothing to collect.
- Whether a claim is collectable is decided once. The check that runs just
  before signing uses the same rule as the one that lists the claim, so a claim
  the list offers is never refused by the confirmation as "nothing to claim".
- A payout the claim itself can still change is labelled as what is recorded
  now, not as what the user will receive, and the reason is stated beside it and
  again at signing. A lender's claim on a fallback-settled loan is the case
  today: claiming first tries to match the loan with another, and a match pays
  the loan's asset instead, for all or part of the recorded amount. The reason
  travels with the payout onto every surface that states it — the
  collect-everything checklist and the positions list as well as the loan page.
- A loan's own page learns its payout from that loan alone. Opening one position
  must not scan every position the wallet has ever held.
- A lender's claim on a defaulted loan says what the recovery is (a cash amount,
  the collateral itself, or partly held in other assets). A shortfall is shown
  only against what the loan actually owed when it defaulted, and that figure
  is the one the protocol recorded at the default (#2374): principal
  outstanding, interest outstanding, and the late fee. When the protocol holds
  that record the claim states it, phrased for whoever holds the position now
  ("the loan still owed", never "you lent"). The recovery is set against the
  PRINCIPAL only, because no protocol share is taken from principal; a gap
  there is a substantiated shortfall, while interest and late fees are paid
  after the protocol's share and are not compared. No comparison is made, only
  the figure stated, when the recovery may have come in more than one part:
  proceeds held beside the claim, a claim in another asset, or a default that
  went through the full-collateral fallback. A claim on a loan still in the
  fallback states the recorded figure too (entering the fallback is the
  default), beside its existing note that the claim can still change the
  payout, and never compares it. When the token's details cannot be read the
  amounts are not written, but the principal comparison is still stated,
  since the recovery and the principal are in the same token's own units.
  With no record — a loan that defaulted before the protocol kept one — the
  claim says the figure is not available rather than computing one; when the
  record cannot be read, it says that instead. The loan's current principal is never presented as what the
  holder lent: partial repayments change it, and a holder who bought the
  position never lent it at all.
- A lender's claim on a loan closed by internal matching states what the
  protocol recorded that matching cleared (#2427): the principal, and, when any
  had built up, the interest and late fees that are not charged when a loan
  closes this way. It says what the matches paid toward that principal and
  compares only those two: the gap is the matcher's fee, and the claim says so
  in those words. It is phrased about the loan and the matches, never "you
  lent", since the holder may have bought the position. When the protocol's
  record is incomplete (part of the loan was matched during the fallback, or
  the lender had already been paid in part), the claim says no figure can be
  shown and why. With no record it says the figure is not recorded for this
  loan; when the record cannot be read it says that, and the loan page reads
  it again shortly. When the token's details cannot be read the amounts are
  not written, but whether the matches paid the principal in full is still
  stated.
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
- When two or more payouts are ready at once, the user may collect them all in a
  single wallet signature instead of one transaction per claim. The batch spans
  lender and borrower loan proceeds, pending interaction rewards, and free
  (unencumbered) vault VPFI.
- The batch presents each payout for individual include/exclude before signing.
  Withdrawing parked vault VPFI is opt-in and off by default, because that
  balance backs the fee-discount tier and pulling it lowers the tier.
- A payout that another party finalizes between preview and signing is skipped,
  not fatal — the remaining payouts still succeed, and anything skipped stays
  listed for the user to claim on its own.
- The batch is bounded; when more payouts are ready than fit in one batch, the
  user is asked to collect the remainder in a second batch rather than being
  allowed to submit a transaction that would fail.
- The same sanctions posture as any individual claim applies to the batch: a
  flagged wallet, or an oracle that cannot be read, blocks the batch before it
  is signed.
- The batch is only offered once every ready amount it would include is known; a
  still-loading balance is never silently omitted, and if a balance genuinely
  cannot be read, the user is told it is excluded rather than the batch
  pretending to be complete. A batch that would pre-select more payouts than the
  bound allows starts within the bound instead of forcing the user to unselect.

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
  failure would otherwise produce an opaque on-chain error. The settlement is
  deducted from the buyer's payment, so the check is that it fits inside that
  payment; the seller's own wallet plays no part in it and is not read.

## VPFI Vault and Discounts

- The VPFI page is availability-first. A chain without registered VPFI utility
  does not show deposit controls.
- The page shows wallet balance, vault balance, locked balance, free balance,
  active discount, and warming-up discount state.
- Deposits and withdrawals use the same review and wallet-prompt transparency
  model as other value-moving flows.
- Withdrawals cap at free balance, not total balance.
- Discount consent is explicit and visually prominent.
- The tier table states each band's boundaries exactly as the protocol applies
  them, including which tier an amount sitting exactly on a threshold belongs
  to. A holder must never be shown a better discount than the protocol would
  apply to their balance.
- The explanation of how the discount is earned names every check that decides
  it: a minimum period of continuous holding, the recent average balance, and a
  cap at the lowest level the holding has reached over its own history. It
  never presents one look-back period as the whole rule, and it says plainly
  why topping up does not raise the discount straight away.

### Full VPFI Tariff Opt-In

- Each party opts their OWN side into the Full tariff at the moment their
  authorization is signed: the acceptor on the accept review (classic accept
  and desk signed-order fill alike), and a standing-offer creator on their own
  open offer after posting, and a signed-order maker on the gasless order
  itself — the order shape carries the opt-in, so it travels with the
  signature and applies to every fill of that order, a keeper-matched slice
  taking its share of the maker's ceiling counted cumulatively, so the
  slices' ceilings together never exceed the ceiling the maker signed and
  reach it exactly once the order is fully filled. (A slice's share comes out
  zero only when the signed ceiling is below one unit per slice; such a slice
  cannot take Full.) A signed Full opt-in without a ceiling is refused
  before any value moves, on every fill path. Nobody can opt a counterparty
  in.
- **A signed-order maker chooses on the order ticket, before signing.** The
  control appears in the ticket's sign-only (gasless) mode, and only while the
  feature is enabled. It quotes the tariff on the order's full size, so the
  suggested ceiling covers any fill, and it says plainly that the choice is
  signed into the order — changing it means cancelling and posting again — and
  that each fill is charged its own tariff, never more than that fill's share
  of the ceiling. A ceiling the live quote already exceeds is called out with
  both figures but does not stop the maker posting: what counts is the quote
  when a fill actually happens, and it may fall back. An opt-in that cannot
  complete at all (the feature off, the loan's tariff unquotable, or its
  principal illiquid) is never signed. Changing the opt-in, its ceiling or its
  downgrade choice clears the maker's confirmation, like any other change to
  the order's terms; the control's own re-checks of availability do not.
- **A party's Full authorization is honoured whichever venue fills their
  offer.** A standing offer armed with Full is charged the tariff when it is
  filled by a keeper matching it against a counterparty offer, exactly as it
  would be on a direct acceptance — the authorization belongs to the party who
  signed it, not to the route the fill took. The app may therefore present an
  armed standing offer identically regardless of how it is expected to fill,
  and must not imply that a matched fill escapes the tariff. The counterparty
  side is unaffected: each side is resolved from its own signed artifact, so a
  party who armed nothing is never charged because the other side armed
  something. The refusal posture travels with the authorization too: while
  the feature is off, an armed offer whose owner did not permit a downgrade
  cannot be filled by a match any more than it can be accepted directly — the
  app must not present a matched fill as a way around a strict opt-in.
- New Full opt-ins can be collected only while the on-chain fee-entitlement
  feature is enabled. While the feature is off (the launch posture), no
  opt-in control renders — a Full authorization presented while the feature
  is off fails on chain, so the app must not invite one. One recovery
  surface deliberately remains while off: the creator of a standing offer
  that is ALREADY armed with Full can still reach the offer's tariff form to
  clear that commitment (a strict armed offer is otherwise unfillable while
  the feature is off); the form only permits clearing there, never arming.
- An engaged opt-in shows a live tariff quote for the prospective loan and
  requires an authorization ceiling before it can be signed. The ceiling is
  pre-filled from the quote with small headroom and remains user-editable; the
  charge at loan open can never exceed it.
- The user chooses explicitly between the two failure postures: reject the
  whole acceptance if the tariff cannot complete, or open the loan without
  Full (and without any tariff charge) in that case. The consequence of the
  current choice is stated next to it.
- **On an acceptance or fill review**, the quote is live and keeps moving while
  the review is open, so it can rise above the ceiling the user authorized
  without anyone touching anything. When it does, the app says so plainly,
  naming both the current quote and the authorized ceiling, and offers a single
  action to raise the ceiling — stating the figure that action would authorize.
  The ceiling is never raised on the user's behalf; the choice stays theirs.
  The standing-offer creator's arm form carries the paired warning: arming a
  ceiling the live quote already exceeds is called out, with both figures and
  the consequence stated as it actually is — a fill above the ceiling cannot
  charge the tariff, so it is rejected, or opened without Full where that
  fallback was chosen. The quote shown is for the largest fill the offer
  can still receive — what is already filled is excluded, so the figure is one
  a taker could actually reach — and the warning says so, because a smaller
  partial fill can price under the same ceiling. It
  appears only while arming is actually available. It warns rather than refuses — what the
  protocol judges is the quote when a fill actually happens, and it may fall
  back before then; saving an offer is reversible in a way an acceptance is
  not. That matches how the same form already treats a vault balance below the
  quote.
- Whether that warning also HOLDS signing follows the failure posture the user
  already chose. Under the reject posture the app refuses to send an acceptance
  it can see would be rejected. Under the open-without-Full posture it does not
  refuse: that choice says to proceed in exactly this situation, so the warning
  is there to make proceeding an informed decision rather than a surprise.
- **Under the reject posture**, the app attempts a fresh read of the quote at
  each point it is about to ask for a signature or send a transaction —
  including before each additional wallet prompt the flow needs, whether a
  separate permit signature or a token approval — and before EACH approval
  prompt where a token needs its allowance reset to zero first, since that
  path prompts twice with a mined transaction between them. This holds on the
  signed-fill path as well as the direct accept. Those steps are paced by the
  user and can take arbitrarily long, and a signature collected for an
  acceptance about to be refused is exactly the waste these checks exist to
  prevent. The attempt is BEST-EFFORT: if the read itself fails (an unreachable
  node, a selector the deployment does not have), the app proceeds rather than
  refusing. Its purpose is to spare the user a doomed signature, not to be a
  second enforcement layer — the protocol enforces regardless, and a preflight
  that failed closed on its own transport trouble would block acceptances the
  chain would have allowed.
- **Under the open-without-Full posture** no such re-read is required, and the
  displayed warning may lag: the re-read exists to stop a signature that is
  already doomed, and under that posture none is — the loan opens either way,
  which is what the user asked for.
- Even under the reject posture this narrows the window in which the price can
  move unnoticed; it cannot close it. The protocol has the final word on the
  price at the moment a transaction lands, and an acceptance can still be
  refused there.
- The copy is dual-fee honest: the tariff never replaces or waives the loan's
  asset fees — it adds a deeper discount on the payer's own side's fees, up to
  the overall cap — and it is non-refundable, priced on the loan's full term
  at open. No purchase, price, or yield framing is used.
- A vault balance below the quoted tariff is warned about before signing.
- Loan Details shows the stamped per-party fee modes and each Full party's
  absorbed tariff once a party actually paid Full; the early-close surface
  warns that none of a paid tariff comes back; and the lender's sale surfaces
  note that the Full fee mode travels with the position NFT to a buyer.

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
- Link, unlink, a test alert and every preference change require proof of
  wallet ownership: a free signature over a plain message naming what the
  request does, which for a preference save means each setting it changes
  and its new value. Each signed request is accepted once, so one that was
  captured cannot be presented again; a save that is refused for that reason
  asks the user to sign again rather than failing silently. Ownership proven by one network's account contract (a
  smart-account wallet) counts for that network alone: an unlink under such
  proof disconnects that network's alerts only, and the confirmation says
  so — an ordinary wallet's signature proves its keyholder everywhere and
  unlinks the wallet everywhere.
- Stored alert data is described plainly before linking.
- Turning off important reminders is explicit and cannot happen merely because
  the user opens the card from another device.
- A saved preference change carries ONLY the settings the user changed in that
  save. Settings the user did not touch are preserved as stored — a device
  that has never seen the wallet's preferences cannot silently overwrite a
  choice made elsewhere by saving its own starting assumptions alongside an
  unrelated change.
- If no alert backend is configured, the app states that alerts are unavailable
  and sends nothing.
- The alerts card states what this browser knows about the link: when no link was
  made from this browser, it says so, and says that a link made on another device
  would not show here — rather than implying the wallet is linked nowhere. It
  does not claim alerts still reach such a link either, since this browser cannot
  check it; it says the wallet may still be linked elsewhere.
- Push delivery is offered only when the alert service says it can send Push
  right now. The app asks before it shows the option, and the subscribe link
  opens the channel the service actually posts as, never a channel named only
  in the app's own build settings. When the service cannot send, the card says
  Push can't be switched on right now and offers nothing; when the app could
  not ask, it says that instead, and offers nothing either. Neither state is
  shown as Push being on.
- The answer covers every sender it can vouch for, and says which. Payment
  reminders and the warnings when a loan gets risky come from two separate
  senders. The warnings' sender regularly publishes what it can do, and when
  that record is recent the answer covers both: Push is offered only when both
  can send, and on the same channel, since a user subscribes to one channel.
  When that record is missing, unreadable or out of date, nothing is known
  about the warnings' sender. The answer then covers payment reminders alone and
  says so. While Push is offered on such an answer, the card says the check
  covers payment reminders, that the warnings may not reach Push, and suggests
  keeping another alert channel on. The caveat goes only when one answer
  covers every sender.
- A new Push opt-in is stored only where it can be honoured. If the service
  cannot send when the opt-in is saved, it refuses that save as a whole and
  stores nothing, in a way every version of the app reads as "not saved"; the
  current app then saves the rest again without the opt-in, keeps Push off,
  and says why. An opt-in made earlier is kept through an outage and resumes
  when sending is back; the card says so while sending is unavailable.
- Paid Push alerts carry an on-chain consent to be charged, and the alerts card
  shows it plainly. For the network it is on, the card states the fee per loan
  side in VPFI as currently configured on that network, that it is paid from
  the free VPFI in the user's vault, at most once for each loan the user is on,
  on the first paid Push alert about it, and that Telegram alerts are free. It
  states the most the wallet has agreed to pay and whether that covers the
  current fee, as the contract judges it; a cap below the current fee is said
  to be below it. The card says what the agreement protects against in terms
  of the agreed cap, never the fee of the day: nothing above the cap can be
  charged, so a rise in the fee is charged without a new agreement while it
  stays within the cap, and only a fee above the cap needs one. Figures it could not read are stated as unread,
  never as zero. When a later refresh fails, the figures last read stay on
  screen labelled as the last successful read that may be out of date, never
  as the network's current record; agreeing is held until a read succeeds,
  and withdrawing stays offered. A mined agreement or withdrawal is shown as
  the recorded cap straight away, but it establishes only the cap: it never
  marks the fee, or the rest of a failed read, as current.
- On a network whose contracts predate the consent record, the card says
  so, and offers neither agreeing nor withdrawing (there is no record to
  write). It still states the fee and the service's billing answer. It also
  states, from the contract's own routing, whether that older version can
  still charge the fee: if it can, the card says the fee may be charged
  without an agreement. It never says the wallet cannot be charged there.
  If the routing can't be read, the card says it couldn't check. Only the
  contract's own "no such function" answer counts as an older version; any
  other failure is a failed read.
- Whether paid Push is billed on a network is the alert service's own answer,
  never inferred from the fee being configured, and the card states that
  answer in every case: that the service charges the fee there, that it
  does not, or that it could not check. Whether a fee is being charged is
  never left to whether a button appears. Agreeing to pay is offered
  only on a network the service says it bills on, and at the current fee;
  elsewhere the card says paid Push is not billed there and there is nothing
  to agree to, or that it could not check, and offers no agreement.
- Withdrawing the consent is always offered while any is stored — whatever the
  service says about billing, whether or not an alert service is configured,
  whatever the Terms state, and while the protocol is paused. A fee already
  charged for a loan is not refunded, and the card says so.
- A confirmation or error from agreeing or withdrawing belongs to the wallet
  and network it was sent for. After a switch of wallet or network it is no
  longer shown, including when the write completes after the switch, so one
  wallet's withdrawal is never presented as covering another wallet.
- Where a covering consent stands on a billed network and the vault's free
  VPFI appears to be below the fee, the card warns that a paid alert cannot be
  charged until VPFI is added; the charge itself remains the authority.

## Notifications

- A connected wallet sees an in-app inbox: a header bell with an unread count
  and a panel listing that wallet's newest loan updates. It is free and needs
  no setup — the same lifecycle outcomes the optional external channels
  deliver.
- Each notification is phrased as an outcome (a loan matched, a repayment came
  in, a loan was repaid or defaulted, a loan closed by matching) and links to
  the affected position, where the exact state is re-confirmed on chain. The
  inbox is a convenience view, never the authority for an action.
- The inbox also carries time-based reminders that no on-chain event produces:
  the borrower is reminded when a loan is due within a week and again within a
  day, and both parties are told when a loan goes past due while its grace
  window is still running. These reminders cover loans whose collateral has no
  price feed, fire once per due date (extending a loan re-arms them for the
  new date), and the past-due reminder is only ever CREATED while the grace
  window is still running. Like every inbox entry it then remains as
  history, so its wording states the past-due fact and points at the
  position page — the authority for whether the repay window is still
  open — rather than promising a window that may have since closed. The
  definitive outcome arrives as its own notification. The grace length
  follows the protocol's configured schedule (the default one unless
  governance has set custom tiers).
- Both parties are also told when a loan's grace window has CLOSED while the
  loan is still open. This is a statement about TIME only: the loan's grace
  period is over, so the time condition for a default close-out is met. It
  does not promise that a close-out will succeed — the protocol can still
  refuse one (for example while paused, while the network's sequencer is
  unhealthy, or when another close-out prerequisite fails), and the notice
  defers to the position page for what can actually be done. "Closed" means
  what the protocol itself means by it: strictly after the due date plus the
  loan's grace length, measured on the chain's own clock rather than the
  indexer's, so the inbox never says the window closed before the chain
  would agree. This reminder is created only during the
  first week after grace ends (a loan still open after that is not
  re-announced), once per due date, and states the fact as of the notice —
  whether the loan was then closed out, repaid, or is still open is the
  position page's to say.
- For loans whose collateral has a live price, the borrower is also warned in
  the inbox when the loan's health worsens past protocol-level lines (below
  1.5, below 1.2, and below 1.05 — the last close to the 1.0 liquidation
  line). These fire only on the way DOWN — a recovering loan is not an alert —
  at most once per line per day, and follow the borrower position to its
  current holder. The wording states the dip as of the notice and defers the
  live number to the position page, so an old entry stays truthful after the
  loan recovers or closes. Loans without a price feed have no health number;
  their risk reminders are the due-date and grace entries above. These health
  warnings ride the platform's autonomous monitoring, so they are only
  produced while that monitoring is running, and they may reach the inbox
  less immediately than the optional external alert channels a user has
  linked.
- Once the reward claim window is in force, the inbox also carries its free
  pre-expiry notice. When one of the wallet's interaction rewards enters its
  final notice period — it has stayed claimable for the whole claim window and
  will return to the rewards programme if it is still unclaimed when the notice
  period ends — the wallet is told, and told again if a change to the claim
  window restarts that notice. When an unclaimed reward does reach that point
  and returns to the programme, the wallet is told that too. These entries name
  the reward, not a loan, and open the Claim Center. They reach the reward's
  owner through this free inbox and never only through a paid channel, because
  a paid channel would skip exactly the dormant claimants the notice exists
  for. A notice that could not be written at the moment its event was
  recorded is not lost: the inbox's completion mark does not move past that
  event until the notice has been re-derived from the recorded event and
  written, so a passing storage failure delays the notice rather than
  dropping it. This holds for every inbox entry the recorded events produce,
  not only the reward notices.
- Whether a notification is read is tracked on the user's own device, per
  wallet. Opening the inbox marks the shown updates as read; that state is not
  stored on any server, so no one else can clear another wallet's unread
  updates, and it persists across reloads.
- The unread count is shown compactly and never regresses to re-surface updates
  the user has already seen.
- If the notification feed is briefly unavailable, the panel says so rather than
  showing an empty inbox as if there were nothing to report.

## Support and Diagnostics

- The support drawer shows network, chain connection health, market-data
  freshness, app build, and the last local error.
- Checks run only while the drawer is open.
- A user may create an in-app support ticket with a message and optional reply
  address.
- Health details are attached only with explicit consent.
- Full wallet addresses are not included in health details.
- Before a public support report leaves the app, the user can inspect all
  text that will be sent, including the longer error and trace omitted from
  the compact drawer summary. Opening a pre-filled external issue already
  sends its link contents to that service, so review and consent happen first.
- Redaction covers percent-encoded addresses and recognizable forty-digit
  address values without their usual prefix, as well as ordinary addresses.
  It is not a promise to recognize every possible encoding; the full report
  preview remains available so the user can check what will leave the device.
- If ticket submission fails, the app offers an email fallback and must not
  claim a ticket number it did not receive.
- Support is reachable from every page without covering page content: it is a
  navigation entry (the side navigation on wide screens, the More menu on
  phones), never a floating button over the page.

## Operational Kill Switch

- Operators may pause position-opening flows during an incident.
- Pausable entry flows include posting offers, accepting offers, listing NFTs,
  renting NFTs, and depositing VPFI.
- Exit and recovery flows remain outside this switch: repayments, claims, and
  withdrawals stay available.
- A paused flow explains that existing positions are unaffected.

## Display Language

- The app ships English as its source language, with a Language
  selector in Settings offering additional display languages. The
  first wave is English, Spanish, Chinese, Hindi, and Japanese;
  further languages are added by filling in their translation
  bundles, without code changes to the selector.
- A language whose translation is not finished may be offered in the
  picker; selecting it shows English text (never untranslated keys,
  never a broken page) until the translation lands.
- The chosen language applies immediately across the whole app,
  persists for future visits, and carries across the Vaipakam
  subdomains — a choice made on the marketing site is honoured in the
  connected app and vice versa.
- Right-to-left languages flip the layout direction, and the correct
  language/direction is applied before the first paint (no flash of
  wrong-direction layout).
- Protocol-specific terms (VPFI, HF, LTV, asset and network names)
  stay verbatim in every language. So does any word the app asks the
  user to TYPE BACK as a confirmation: a translated confirmation word
  would be compared against the English one the app expects, leaving
  the user unable to pass a gate they had typed correctly in their own
  language.
- A language offered as translated shows that language everywhere it is
  offered. Falling back to English is the documented behaviour for a
  language still being filled in — not for a page inside a language
  already presented as available. A newly added surface is translated in
  the same change that ships it, so a user never meets a page that
  switches to English partway down.
  *(Not yet true of the whole app, but now bounded. Every key EXISTS in
  every advertised language, and a second check asks the question key
  presence cannot: does the key hold anything other than the English
  string? Several hundred message identity and language pairs still do — Hindi carries
  the bulk of them, and `apps/app/src/i18n/english-valued-baseline.json`
  is the current count, deliberately not restated here — and every one is
  recorded, dated, and enforced in both
  directions: a text that regresses to English fails the build, and one
  that gets translated must leave the record or the build fails too. The
  record can only shrink. The question asked is whether the text is
  built from the same words as the English, in any order and whatever
  the punctuation, spacing or invisible characters around them: an
  English sentence rearranged into another language's word order is
  still English to the person reading it. A handful of leaves are
  correct despite matching (the product name, standard trading
  acronyms, and one French heading that genuinely uses the same two
  words the English does); those are listed separately, each naming the
  languages it applies to, carrying a written reason, and recording the
  exact wording it was granted against, rather than inferred from a
  pattern — a match can be correct in one language and a regression in
  the next, and a reworded string is a judgement nobody has made yet.
  Deleting words from the English is not translating the ones that
  remain, so that counts as untranslated too; adding words to them does
  not, because text with words from somewhere else is a translation
  someone has started. Each language is also held to the alphabets it is
  actually written in, because a letter swapped for an identical-looking
  one from another alphabet reads as English on screen while comparing
  as a different word — the one way text can pass every other check and
  still show the reader English. And text holding no words at all, where
  the English is a sentence, is not a translation either: the reader
  would see punctuation where the words should be. See the dated row in
  [`_CodeVsDocsAudit.md`](./_CodeVsDocsAudit.md). The intent above is
  deliberately left stated in full, because a spec narrowed to the
  surfaces that happen to be finished cannot be violated and would
  erase the only record that the rest is unfinished rather than
  intended.)*
- Where a sentence embeds a live value, that value survives translation.
  A translation may reorder the values to fit its grammar, and may leave
  one out where the grammar already carries it (a dual form that means
  "two days" in the noun itself), but it never invents a value slot the
  English does not have.
- The translation covers the whole displayed interface, not only the
  page chrome: the Activity feed's plain-language event labels, the
  loan-status badges shown on positions and history, the Claim Center's
  per-item labels, and every review-receipt line and hint switch with
  the chosen language once a locale's bundle is filled in. Text that
  embeds a live value mid-sentence — a day count, an amount, a position
  number — is translatable too: the count picks the language's correct
  plural form and numbers format for the locale. Only signing-critical
  text (the exact message a wallet signs, cryptographic domain names)
  and proper nouns (chain and asset names) stay in one language by
  necessity.
- A number standing on its own follows the chosen language the same way a
  number inside a sentence does. Figures printed as their own cell — a
  parameter's value, a counter on a public page — are formatted for the
  language the reader picked, not for the one the device happens to be
  configured in. The two disagree often enough to matter: a reader who has
  chosen a language whose digit grouping and decimal mark differ from their
  operating system's sees the surrounding page in one convention and the
  figures in another, and has no way to tell which of the two the page meant.
- Every figure in a line, not the first one. Where a sentence carries a value
  and then restates it in the underlying unit — a percentage beside the raw
  basis points, an interval in hours beside the same interval in seconds —
  both are figures the reader is being shown, and formatting one while leaving
  the other reproduces the mismatch inside a single line instead of across the
  page. The rule is about the reader's ability to tell which convention is in
  force, and one raw figure is enough to remove it.
- Formatting a figure may never change it. Where a value carries more
  precision than the formatting path can represent — a threshold taken from a
  full-width integer, shown to the digit so it can be checked against the
  chain — the surface formats it without a lossy conversion, or shows it
  unformatted. Losing the reader's separators is a cosmetic failure; losing a
  digit of the number they came to verify defeats the purpose of publishing
  it, and does so invisibly.
- Where signing-critical text cannot be translated, the reader is not
  simply left with a language they may not read. A declaration the user
  must affirm they have understood is shown in their own language
  alongside the exact text being signed, labelled so it is never
  ambiguous which of the two is the authoritative one. Untranslatable
  is a constraint on the SIGNED BYTES, not a licence to leave the
  person signing them without comprehension — an acknowledgement the
  user cannot read is not an acknowledgement.
- That reading aid appears only when a translation genuinely exists for
  the reader's language. Choosing a language the app does not yet
  translate, or a translated language whose text fails to load, leaves
  the page in English throughout — and in that state no aid is shown at
  all, rather than English text presented as being "in your language".
  A label claiming a language the text is not written in would be a
  false statement made at the exact moment the user is affirming they
  understood what they read. Nothing else about the page changes; the
  aid reappears on its own if the translation arrives. Text that merely
  repeats the English word for word does not count as a translation for
  this purpose, and neither does a translated declaration under an
  English label: the label is what states which language the reader is
  being shown, so both halves have to be in their language or neither
  is shown. The aid is also kept honest over time: it explains one
  specific declaration, so if that declaration is ever changed, the aid
  cannot continue to be published in a form written for the previous
  one.
- The plain-language explanation shown when a transaction fails — the
  friendly cause a contract revert is decoded to ("Health factor too
  low", "This offer has expired", "Only the lender can perform this
  action", and the "the wallet could not estimate this transaction"
  guidance) — is translatable and shows in the chosen language once a
  locale's bundle is filled in, on both the pre-sign review footer and the
  submit-error banner. Until then it falls back to English. A known error
  with no curated explanation still reads as a humanized sentence (from its
  error name) rather than a bare code, and is translatable too. Only a
  genuinely unrecognised revert (a selector in no table) falls through to a
  support-triage string that appends the raw selector — that residual case
  is not translatable by design. The explanation is derived from the
  error the contract or the network reported. The app's own record of the
  transaction it sent, which accompanies a failure, is never read as the
  error. What the network itself reports as the error is taken as
  reported: a report that happens to repeat the request cannot be told
  apart from a real error that shares the called function's code, so the
  app does not second-guess it.

## Indexing Policy

- Generic product surfaces (home, borrow, lend, rent, offer book,
  rate desk, VPFI, NFT verifier, help) are indexable by search
  engines, each with its own title, plain-language description, and a
  canonical address rooted at the production hostname.
- Wallet-scoped, per-user surfaces (positions, claims, vault,
  activity, settings, faucet) are never indexed. The exclusion is
  visible both to browsers and to crawlers that do not run
  JavaScript.
- A per-item lookup reached from an indexable entry point is not itself
  indexed. The NFT verifier's own page is listed; the individual token
  pages beneath it are an unbounded space of thin lookups, have never
  been listed in the sitemap, and are excluded — in the response as well
  as in the page, so the exclusion does not depend on the crawler running
  the app.
- A crawl policy file and a sitemap of the indexable pages ship with
  every build.
- The public data service's root address should answer with a
  self-describing catalogue of keyless public data surfaces, so search
  crawlers, AI agents, and integrators can discover supported protocol
  reads without scraping wallet-scoped app pages.
- Public data discovery must stay read-only and keyless. It may
  describe endpoints for market, loan, offer, activity, freshness, and
  transparency reads, but it must not expose wallet-private state,
  secrets, write authority, or action shortcuts.
- The crawl policy for the app must be consistent in both rendered
  pages and response headers: a crawler that does not execute
  JavaScript sees the same indexable / noindex decision that a browser
  sees after the app loads.
- **A compatibility address is never indexed.** Addresses kept working
  for bookmarks from a retired deployment — including the forms that
  carried a language in the address itself — answer by sending the
  visitor to the current address, which is the one that belongs in a
  search index. A crawler that does not run the app never follows that
  hand-off, so the exclusion has to be stated in the response rather
  than left to the page. Two failures are prevented by the same rule: a
  per-user address becoming indexable merely because it was reached by
  an older spelling, and a public page being listed twice under two
  addresses.
- **Every address the retired deployment served has an answer that does
  what the address was for.** Keeping old bookmarks working is a claim
  about every address the old app had, so the set is enumerated from that
  app rather than patched as visitors report misses. An address whose page
  became part of another page lands at that part and brings it into view,
  even when it appears only after the page's data arrives — an old loan
  action page lands on that loan at the card that lists the same action,
  says whether it can be taken now and why not, and offers it. That card
  must be one shown in whichever mode the visitor uses: an action whose own
  form appears only in the fuller mode, or only while the loan can take it,
  is reached through the list that names it, never through an anchor that
  may not exist. An
  address for a settings page lands on that setting, and is shown even in
  the simpler mode that normally hides it, because the visitor asked for it
  by name (one of them holds the way to withdraw a spending permission). An
  old offer address opens that offer where it is taken; since the old
  address never said which network the offer was on, and offer numbers
  repeat across networks, a miss says it looked on the current network and
  names the other reasons it can miss, rather than calling the offer gone.
  A feature this app does not have yet is said to be missing, together with
  what that leaves unseen, rather than answered with a page-not-found. A
  surface that was removed on purpose stays not-found.
- **Every address the app asks to have indexed is a single top-level
  page.** That is a deliberate property rather than an accident of the
  current route set: it is what allows the compatibility exclusion above
  to be expressed as one rule instead of one per language, which in turn
  keeps the response-header policy inside the limit its host imposes.
  Publishing a nested public page would break that, so it is a decision
  to be taken knowingly and with the exclusion rule revisited alongside
  it — not a change that should be able to pass unremarked.
- **Each indexable page has exactly one address.** Its form with a
  trailing slash is not a second page: a request for it is sent,
  permanently, to the address without the slash, keeping any query
  string, before anything is served. So the response and the page can
  never disagree about whether that address belongs in an index, and a
  crawler never meets a copy of a listed page that its response headers
  withhold.

## Privacy and Legal Posture

- The app does not require KYC for the retail flow.
- The Help page states that Vaipakam is decentralized and non-custodial, no KYC
  is required, and users are responsible for their own regulatory compliance.
- Support reports and diagnostics minimize personal data.
- Wallet and analytics integrations should avoid unnecessary telemetry where
  the app can control it.

### Data rights over locally-held data

- The app offers a page where a user can **download everything the app keeps in
  their browser** as a single readable file, and **erase it from that device**.
  Both are reachable without connecting a wallet and without accepting any
  terms.
- The page states the number of stored items before an erasure is confirmed,
  and what was actually removed afterwards. **A browser that refuses to let the
  app clear its storage is reported as a refusal, not a success** — private
  windows and restrictive privacy settings do this, and reporting it as done
  would be a false assurance about a legal right. The user is pointed at the
  browser's own controls, which work.
- Erasure covers what this app stored, and also the browser storage its wallet
  connectors keep on the app's behalf. That reverses an earlier intent recorded
  here — that connector state was left untouched so a data right would not
  disconnect anyone — because leaving it made the control report success while
  a reload could restore the same connected wallet, and a right to erasure that
  does not erase is the more serious of the two failures.
- The erasure requires the removal of those records AND the ending of the
  session. Both halves are now in scope: the connection is torn down, and the
  session material a connector keeps outside Web Storage — WalletConnect's live
  session and the Coinbase smart-wallet keys, both in IndexedDB — is deleted
  with it. An earlier version of this bullet required only the records, because
  the cleanup was synchronous and reached neither; that limit is gone, and the
  bullet states the intent rather than the interim.
- **The session material is REMOVED IN PLACE, not by deleting its container.**
  Deleting the whole store is refused while anything holds it open, including
  the erasing page itself, so it could not succeed where it matters. The
  requirement is that the records are gone, by a means that a still-open
  handle cannot block.
- **The order is required, not incidental.** The teardown runs before the
  storage sweep, and the sweep before the session records are cleared. Erasing
  while the wallet client is still running is a race — it can write its session
  straight back — so closing the connection first is what ends it; and a
  teardown writes on its way out, so a sweep placed first would leave those
  writes behind. The intent is the ordering, not merely the three steps.
- **A connection that reloads the page as it closes is closed LAST.** Some
  wallet connections end by reloading the page, and nothing in the app can
  stop that. Closed with the others, the reload could land in the middle of
  the erasure and leave the rest undone with no word on it; closed after
  everything the erasure counts, the reload can interrupt nothing. That
  connection's own library clears its session on the way out, which is why
  it can safely wait. **The report must survive that reload.** A page that
  reloads straight after an erasure returns the user to a blank screen, and
  on this page the report is the point — so the report as it stands just
  before that last step is kept for this tab alone, holding only counts and
  outcomes, and is shown again after the reload and then discarded. The
  connection reporting itself closed is NOT proof that no reload is coming
  (the reload can follow a moment later), so the kept copy lives for a short
  bounded window rather than ending with the step, and is removed when the
  window ends, when the report is dismissed, by the next erasure, or when
  it is read; a copy found after the window is discarded unread, and so is
  one found on any load that is not a reload — a tab opened from this one
  inherits its per-tab storage, and must not show a report for an erasure it
  never ran. The kept
  copy is the erasure's own record, not the user's data: it is never
  counted as something the erasure left behind, and no sweep but its
  owner's removes it. It must claim nothing about
  the step that was interrupted: the page says the connection was ASKED to
  close last and the page reloaded during that step or shortly after it,
  before its outcome was known — never that it closed — and tells the user
  how to check their wallet.
- **A wallet that is still reconnecting is waited for, not reported as
  refusing.** While the app restores a wallet connection from a previous
  visit, there is no connection yet that can be closed, and the restore
  cannot be cancelled — it may finish after the erasure and put a session
  back. So the erasure waits, for a bounded time, for the restore to finish
  and then closes whatever is live; if the wait runs out it says the wallet
  could not be disconnected YET, that it may sign the user back in, and that
  erasing again once it has will finish the job. That is a different remedy
  from a wallet that declined, and the page keeps the two apart. Each wallet
  is judged on its own: wallets are restored one after another, so when one
  is back and another is still restoring, the one that is back is closed and
  only the other is reported as not closed yet. A restore that is stuck must
  never keep a live wallet attached.
- **A refusal must be reported as a refusal, and the kinds are
  distinguishable.** The session records can fail to clear, the browser can
  refuse to expose that storage at all, and a wallet can decline to
  disconnect. None may be reported as an erasure, all leave everything else
  removed, and the page must say WHICH held out, because the remedies differ:
  the browser's own site-data controls, versus disconnecting in the wallet's
  own interface. **A storage holdout and a wallet holdout can occur together**,
  so reporting is additive rather than a first-match ladder — the wallet's
  remedy is not reachable from any storage message. Both waits are bounded,
  since a request that never answers would otherwise strand the erasure with
  nothing removed, and running out of time is a refusal rather than a success.
- **A browser that hides the storage is not a clean result.** Nothing was
  removed and nothing was observed absent, which is the same "could not look"
  case the pre-erasure disclosure already distinguishes from "nothing is
  here". It must not fall through to a success message.
- **The count reported must cover everything erased.** Session records removed
  from the wallet's own storage count as erased data, so a browser whose
  ordinary storage was already empty must not be told there was nothing to
  erase. **The requirement is on the NUMBER SHOWN and not only on the choice
  of sentence**: a report that decides to claim a success on the wider set and
  then states a figure drawn from the narrower one understates what was
  removed, and reads as a contradiction where the narrower set was empty.
  It binds on the PARTIAL report as well as the successful one: a mixed
  outcome states a number too, and a figure that means one thing in two
  sentences and something else in a third means nothing in any of them.
- **What is offered BEFORE the confirmation must cover what the confirmation
  will erase.** The figure shown while asking is a promise about the button
  next to it, so it spans every store the erasure reaches, including the
  wallet's own. Where a store cannot be read in time to say, the page reports
  that it could not look rather than presenting a floor as a total — the same
  distinction it already draws elsewhere between "nothing is here" and "could
  not tell". Reading it must not modify anything, and must not bring into
  existence a store it is reporting on.
- **Completeness is not "something was removed".** A browser holding nothing
  erases nothing and is complete; a browser that gave up its storage but held
  its session records or a connection is incomplete. The report keys on the
  second.
- **A sign-out may only be claimed where one happened.** A visitor with no
  wallet connected must not be told they were signed out, so the intent is
  that the teardown is attempted only when there is a connection to end —
  a successful no-op is not evidence of anything. **This applies to EVERY
  connection, not the one in use**: where more than one wallet is connected,
  every one of them must be ended before a sign-out is claimed, since a wallet
  left connected is a live client able to write its session back into storage
  the erasure has already cleared. A teardown that finds nothing left to end
  by the time it runs is the same no-op and claims nothing either. What
  counts as "connected" is the set of live connections, not a summary status:
  while the user is part-way through connecting a further wallet, the ones
  already connected are still connected and are ended.
- **The erasure ends the connections the request found, and none made
  since.** It runs for some seconds with the app still usable, and a wallet
  the user connects in that time is a sign-in after the request, not part of
  it; ending it would destroy a session the user just created. The same holds
  for a connection that was still being made at the request and completes
  afterwards, and for a further wallet connected while a session that was
  restoring at the request finishes restoring: only the restored session is
  the request's. A follow-up of another tab's erasure fixes this tab's
  connections when the request arrives, even if it must wait for an earlier
  follow-up before closing them.
- **A late cleanup waits until the request's last connection has closed.**
  Cleaning up after a wallet that answered late must not run while another
  connection of the same request is still closing: at that moment it cannot
  tell that connection from one the user has made since, so it would
  decline, and what the late wallet wrote back would stay.
- **A sign-out must outlast a reload.** Ending a connection only for the app to
  reconnect on the next visit is not an ending, so the erasure must leave in
  place whatever record tells the app not to reconnect on its own, and the
  wallet types the app supports must be configured to keep such a record.
  Removing it would be more thorough and less faithful: what the user asked
  for was to be signed out, and the record says only that.
- **A tab with nothing to disconnect must not be asked to disconnect.** The
  cross-tab request is best effort, but it is not free: acting on it writes,
  and a tab that was already signed out would write into storage the erasing
  tab had just cleared. Only tabs holding a connection act on it, and a tab
  that does act ends **every** connection it holds, for the same reason the
  originating tab does.
- **A tab told about another tab's erasure must bring ITSELF into line, not
  only its storage.** Everything the erasure promises that is held per
  browsing context has to be reset there too — the connection, and equally
  the preferences the user can see. A second tab still displaying a theme or
  a language that was erased is showing the user data they were told was
  gone; that the value is now only in memory is a distinction the promise
  does not make.
- **Nothing a peer tab does in response may write.** Its resets run after the
  originating tab's sweep, so any write lands in storage that was just
  cleared and stays there — a peer tab restoring the keys the erasure
  removed. Where the natural way to reset something persists, the peer tab
  removes exactly what it wrote and nothing more; and where the user has set
  that preference again since the erasure, the peer tab adopts it rather
  than overwriting it. This holds for every preference the tab shows —
  theme and mode as well as language.
- **One tab never runs its own erasure and a follow-up of another tab's at
  the same time.** Both close this tab's wallet, and a wallet that reloads
  the page as it closes would cut the tab's own erasure off mid-clear,
  before it had kept a report. A request from another tab that arrives while
  this tab's own erasure is running is carried out after it — never dropped,
  since a wallet connected or data written after this tab's own request is
  the later request's to remove, against what this tab held when that
  request arrived. An erasure requested while a follow-up is
  still closing the wallet waits for it before doing anything, so a reload
  in that time interrupts nothing and the page simply offers the erasure
  again. **A reload the tab may still owe blocks the next erasure, whoever
  caused it.** After any close of a connection that reloads the page —
  this tab's own erasure or a follow-up of another tab's — the reload can
  follow the close by a moment, so for the same short bounded window the
  kept report uses, an erasure requested in that time shows as running and
  does nothing (not even discard the previous report) until the window ends.
  A reload in that time therefore interrupts nothing and shows the report of
  the erasure that caused it. The same window holds back a further
  follow-up of another tab's erasure waiting its turn: it begins closing
  nothing until a reload the previous one may have caused can no longer
  come.
- **A peer tab does not clear the stores it shares with the erasing tab.**
  The shared stores are cleared by the tab where the user asked, which is
  also the only one that reports on them. A peer tab clearing them as well
  is a second, uncoordinated clearer: arriving late — a background tab can
  receive the request long after it was sent — it deletes what the user has
  stored since, sessions included, and arriving early it empties the stores
  before the erasing tab has counted them, so the report understates what
  was removed. The stores record nothing about who wrote what, so "clear
  only what this tab's teardown wrote" cannot be expressed. The accepted
  cost is that a wallet closing in another tab may write a small connection
  record back after the erasing tab has finished, and **the page says so**,
  with the remedy: erasing again from any tab removes it.
- **A request abandoned for taking too long must not be left free to act
  later.** Giving up on a wallet teardown bounds the wait, not the work: the
  wallet may still complete afterwards and write its state back into storage
  the erasure had already cleared, leaving the device holding what the user
  was told was removed. What arrives late must be cleared up after, by the
  tab that made the request (a peer tab clears no shared store; see above). The
  REPORT is not revised — it is fixed at the moment it was made, and it
  already says the wallet held out — so this is about the device, not the
  claim.
- **Bounding a wait must not leave work running.** Where the app gives up on a
  storage operation that has not answered in time, it must also stop that
  operation and release its hold on the storage. A wait that only stops
  waiting leaves the next attempt queued behind the abandoned one, and leaves
  a hold in place that blocks the browser's own site-data deletion — the very
  remedy the app directs the user to when it reports the refusal.
- **What remains outside reach is still stated.** A browser extension, or a
  Safe the app is embedded in, holds its own record that this site was
  authorised, in a place no page can reach. Erasure does not remove it and the
  copy must say so, including that reconnecting there takes one click — a user
  who deletes and finds one click restores the connection should have been told
  in advance, not discovered it.
- The page states its limits as prominently as its controls, and each is
  stated at its true extent. It does not reach on-chain data — which is public,
  so the user can look it up themselves, and permanent, so nobody can erase it.
  **The wallet address is named as the one exception**: where the user saved
  per-wallet settings, the address is part of the locally stored data and
  therefore part of the download, and the file itself says so — being public
  on the chain and being absent from this browser are different facts, and a
  user deciding whether the file is safe to share is owed the second one.
  It does not reach the alerts service: **unlinking removes the messaging
  connection only, and the alert preferences are deliberately retained there
  for a future relink**, so removing those is a support request. It does not
  reach the marketing site's separate store; and the LOCAL download-and-erase
  controls do not reach the error reports held by support — those have their
  own signed control on the same page, described below. **Overstating reach is
  the primary way a page of this kind misleads** — and understating what a
  user can obtain is the same failure pointed the other way — so each
  exclusion is named at its real size.
- The same page carries the **signed erasure of the error reports support
  keeps** — the server-side counterpart the Privacy Policy promises. The
  request is authorised by a free wallet signature (no transaction, no gas)
  proving ownership of the wallet whose records it names. The service's
  answers are deliberately uniform, and the page must not out-inform them:
  a processed request never says whether any records existed — records can be
  under a retention order the service is forbidden to mention, and one
  wallet's confirmation must not read differently from another's — and the
  page states exactly that, identically to everyone. A companion check
  reports retained records only where the law allows saying so; its quiet
  answer is phrased as "none are reported", never "none exist", because only
  the first is knowable. The erase and the check each sign THEIR OWN words —
  what a user signs to look at their records can never be replayed as
  authority to delete them. A build with no support-service connection says
  the control cannot be used from there and names the e-mail route instead.
  Smart-contract wallet accounts (a Safe, a smart wallet — deployed or not
  yet deployed) can use the signed controls like any other wallet: the
  service verifies their signatures against the network the account lives
  on. When that network cannot be reached for verification, the user is told
  the signature could not be CHECKED — never that it was wrong — with the
  e-mail route as the alternative, since an immediate retry cannot help.
  Authority a network's account contract approved reaches only that
  network's records: such an account can be controlled by different parties
  on different networks, so an erasure it signs covers the records captured
  on the approving network, and the confirmation says so plainly — pointing
  at a network switch, or the e-mail route, for the rest. An ordinary
  wallet's signature proves its one keyholder everywhere, so its erasure
  keeps the wallet-wide scope. The retention check's answer stays
  wallet-wide in both cases, because retention has no per-network shape to
  narrow to. The
  e-mail route promises what the signed route promises — that a request will
  be processed — never an unconditional removal the retention rules cannot
  always satisfy.
- **Every live preference the erasure covers is visibly reset**, not merely
  cleared from storage: the theme, the interface mode, the display language,
  and the record of which notifications have been seen. A page that reports
  preferences returned to their defaults while the app keeps showing them is
  making a claim the user can see is untrue.
- **The erasure reaches storage the app causes to exist but does not itself
  write**, specifically the wallet connection. A deletion that leaves the
  connection in place lets the next page load reconnect the same account, which
  is wallet-linked state surviving a deletion the user was told had happened —
  and the app's own storage names are no guide to it, because the wallet
  libraries choose their own. The intent is that a user who deletes is
  disconnected, and that the session material behind the reconnection is
  deleted with the connection rather than left for the next page load.
- **The download and the deletion deliberately cover different sets.** A
  download is a file the person keeps and may pass on, and wallet session
  material does not belong in one; the same material left on the device is what
  makes a deletion incomplete. So the download carries what this app stored
  about the user, and the deletion reaches further. Where the two differ, the
  page says which it is describing.
- Two shared-domain preference cookies are part of what this browser holds,
  so the download includes them and an erasure removes them — and they differ
  in kind, which the page states rather than blurs. The language is genuinely
  shared: both surfaces read it, so a choice on one follows to the other. The
  theme cookie is the marketing site's own preference, which this app never
  consults — this app's theme is stored separately and is not shared. **The
  page promises no cross-site reset**: the marketing site keeps origin-local
  copies of its preferences and restores them, shared copies included, on the
  next visit, so resetting that site belongs to its own data controls and the
  page says so. Erasing here fully resets this app's own language and theme.
- **An erase request must never destroy a session that came after it.** A
  wallet can be slow to let go, and the app tidies up whatever such a teardown
  writes on its way out. That tidying can arrive long after the request, by
  which time the person may have gone back to using the app and connected
  again — and the stores involved hold no record of which session wrote what,
  so the only honest question is whether a session exists now that postdates
  the request. If one does, the tidying is skipped: a leftover connection
  record is a far better outcome than deleting a wallet session the user is
  holding. **The intent is that this is decided from the app's own knowledge
  of connections having happened, not from the wallet library's current
  view.** A teardown the app gave up on can, on finishing, publish a stale
  picture that omits the newer connection entirely, so asking the library
  after the fact can return the answer that destroys the session — the
  guarantee has to rest on something a late correction cannot revise. **That
  knowledge must also outlive the page that started the request.** Erasing
  resets the display language, which rebuilds the screen, so the surface the
  user pressed the button on is gone while the request it made is still
  running — and anything the app remembers only for as long as that surface
  exists stops being remembered exactly when it is needed. A protection with a
  shorter life than the thing it protects is not a protection.
- **The erasure itself, and its report, outlive that screen too.** For the
  same reason, the request has to be one operation for the tab rather than
  something the page holds: the rebuilt page must show that an erasure is
  running, must not let a second one start over it, and must show the
  report when the first finishes. A report written to a screen that no
  longer exists is a report nobody sees, on the one page whose purpose is
  the report.
- **A report of how much was erased must not attribute it to a source it
  cannot vouch for.** Where the browser refuses a check, the page may still
  know how many items it removed; that figure spans ordinary storage,
  cookies and any wallet session together. Naming one of those as the origin
  is a claim about the user's wallet the app is in no position to make, and
  is plainly false for someone who never connected one.
- **Anything a support report will disclose can be read before it is sent.**
  The report opens as a pre-filled issue on a public tracker, and the details
  travel with the link rather than with the decision to file, so they leave
  the device as soon as that step is taken. The intent is that reviewing the
  contents never requires taking it: the full report is readable in the app,
  and the shorter summary alongside it is a convenience, not the only view.
  A copy that the browser refuses must say so — and must leave the reader
  able to read the report anyway, since a failure notice that ends the
  attempt returns them to the disclosing action as the only way to look.
- **A late answer must not speak for a newer question.** Where a control
  starts work that finishes later and then reports on it, two attempts can be
  outstanding at once — a second press, or a wallet prompt left open while the
  person carries on. The intent is that only the most recent attempt may
  report: an earlier one that settles afterwards is discarded rather than
  displayed against whatever is now on screen. This holds across a change of
  subject as well as a repeat, so an approval for one token cannot mark a
  different one.
- **A confirmation belongs to the thing it was earned by, and does not outlive
  it.** Being the most recent attempt is not enough on its own: when the
  account, the network, or the item a control sits beside changes, no newer
  attempt has begun, yet the question the outstanding one answers has gone
  away. The intent is that a confirmation states what it is about and appears
  only beside that — so "added to your wallet" is never shown over a wallet
  that was not asked, and a confirmation that an address was copied does not
  carry over to a different address that has taken its place on screen.
- **Silence is correct where a refusal is the person's own decision.** A
  wallet declining to add a token is usually the user declining it, and the app
  cannot distinguish that from a genuine failure; reporting an error over
  someone's own choice is its own inaccuracy. That is the line: a control says
  plainly when it could not do what was asked, unless "could not" is
  indistinguishable from "you said no".
- **A control must not report a success it has not verified.** Copying to the
  clipboard can be refused, so a button that confirms a copy has to wait for
  the result before confirming. Claiming a success that did not happen is
  worse than reporting nothing, because it stops the person doing the thing
  that would have worked — reading the value still displayed beside it. This
  covers a refusal that arrives as an ANSWER rather than as a failure: a
  wallet asked to add a token may simply reply that it did not, and the
  intent is that such a reply is read and believed, not treated as agreement
  because nothing went wrong.
- Erasing does not reload the page, so the confirmation of what happened
  survives long enough to be read.
- **If any part of the browser's storage could not be read, the result is
  reported as incomplete rather than successful.** The app cannot claim to have
  emptied a store it was never allowed to look inside.
- **A partial download warns inside the file itself**, naming the stores whose
  contents are missing. The file travels away from the page, so the page's
  on-screen warning must travel with it — a partial export that reads as
  complete is the same false assurance in portable form.
- **The controls act on what is stored at the moment they are used, not at the
  moment the page was drawn.** Browser storage can change without the page
  noticing — from another tab, or from the app's own surfaces in the same one —
  so neither control is withheld on the strength of a possibly stale count. A
  store that really is empty yields an honestly empty download or a "nothing
  was stored" erasure report, which are truthful answers; a control that
  denies data it would in fact find is not.
- **The page promises no prompt it does not produce.** Erasing returns display
  preferences to their defaults; it does not re-ask for cookie consent, which
  belongs to the marketing site and is stored on that site's own origin, and it
  does not re-ask for a language. Promising a prompt that never arrives is the
  same failure as promising an erasure that does not reach — a user expecting
  to revisit a choice would keep it while believing they had not.
- **An erasure reaches the app's other open tabs.** A small amount of data
  belongs to each tab individually, and a page that says "this browser" may not
  mean "this tab". The download is the exception and says so: it covers the tab
  it was taken from, because collecting the others would mean waiting on tabs
  that may never answer. The reported COUNT is likewise what the acting tab
  removed, and the wording says so rather than presenting it as a
  browser-wide total.
- **The marketing site's equivalent page does not cover the connected app, and
  cannot.** Browser origin isolation means neither site can read or clear the
  other's stored data. Each surface needs its own controls; neither may claim
  to cover the other's.

### Terms of Service acceptance

- The protocol can have a version of the Terms of Service in force, or none.
  While none is in force, the app behaves as though the requirement does not
  exist: no user is asked anything and no surface is withheld.
- While a version IS in force, a connected wallet that has not accepted that
  version cannot take on new exposure and cannot reach the surfaces that exist
  only to create it. It is shown which version applies, a fingerprint of the
  exact text, and links to read the Terms and the Privacy Policy before
  deciding. The language control is available on that prompt, because a user
  who cannot read the terms cannot meaningfully agree to them.
- **The Terms link on that prompt is pinned to the version being accepted.**
  The marketing site keeps every published Terms version readable at its own
  permanent address, unchanged forever, alongside the always-current page —
  so the prompt's link resolves to the exact text whose version and
  fingerprint the acceptance records, even during a rollout window when the
  current page already shows the next version's text. A pinned address for a
  version the site does not serve yet must say so honestly rather than fail
  silently, so a user is never left unable to tell whether they are reading
  what they are accepting.
- **Anything that reduces the user's commitments stays available**, whether or
  not they have accepted. That covers repaying and closing positions,
  claiming settled funds, withdrawing their own assets (vault balances and a
  service operator's capacity deposit alike), cancelling their own
  standing offers and orders, adding collateral to a position at risk, and —
  in both cases where a third party or an automatic process holds authority —
  withdrawing that authority: a keeper's permission over their positions, and
  the consent that allows fees to be deducted automatically from their vault.
  It also covers **handing a position over in one step** to someone who has
  already offered to take it — a lender being bought out, or a borrower's
  obligation moving to a replacement. Those end the user's position outright,
  so refusing them would leave the slow route open and the instant one shut.
  Publishing a standing offer of one's own is a different thing and is not
  covered, even when the intent behind it is to leave.
- **The protection follows the destination, not the spelling of the address
  used to reach it.** A retired deployment's addresses remain in circulation as
  bookmarks and links, including forms that carried a language in the address
  itself. Such an address is answered by sending the visitor to the current one
  — but that answer is itself something the gate can withhold, so an address
  that leads to a protected destination is treated as protected. Otherwise a
  user holding unaccepted terms meets the prompt on the way to repaying or
  claiming, purely because of which link they followed. Normalising the address
  this way never widens the protection: an old address leading to a surface that
  creates new exposure is withheld exactly as its current form is.
- **An acceptance is honoured in every open tab, not only the one that paid.**
  The chain permits a second acceptance and would charge for it while changing
  nothing but a timestamp — so the moment one tab's acceptance is confirmed,
  every other tab holding the same wallet on the same network is told. For an
  acceptance confirmed within its short safety window — the ordinary case —
  every tab applies the same correction at once: its prompt closes and its
  writes proceed without asking again. An acceptance that took unusually long
  to confirm — network congestion can hold a transaction pending beyond that
  window — is instead announced to every tab as a signal to re-check the
  chain immediately: prompts close as soon as that re-check reads the
  recorded acceptance, which by then any current node reports, rather than
  in the same instant. The correction, where applied, is bounded by the same
  short window in every tab, expiring simultaneously, so an acceptance undone
  by a chain reorganisation is not papered over anywhere for longer than in
  the tab that made it. A tab that has meanwhile seen a newer terms version
  keeps prompting for the newer version — an acceptance of older text never
  opens the gate on newer text.
- The requirement applies to notification settings on the same terms, even
  though nothing there touches the protocol. Signing up — linking a messaging
  channel, or switching a reminder on — waits for acceptance. Switching a
  reminder off, or unlinking a channel, always works. **Each reminder can be
  switched off on its own**: turning one off is never read as signing up for
  whichever others happen to be on, which would leave a user unable to
  silence any of them.
- **Where that requirement is enforced for notification settings is a
  deliberate, recorded choice, not an oversight.** The check lives in the app
  the user runs; the notification service that stores the preferences does
  not verify acceptance itself, even though for these settings the app's
  check is the only one. That is accepted because notification preferences
  create no exposure: nothing there moves funds, creates an obligation, or
  touches the protocol, so circumventing the app's check gains only reminders
  about one's own positions — while every action that does create exposure
  has its own check in front of it. The boundary this records for the future:
  should the notification service ever gain a capability that creates a
  commitment or moves value, that capability must carry its own service-side
  acceptance check rather than inheriting this posture.
- A refusal never costs the user anything. Where an action needs a separate
  approval transaction first, the requirement is checked before that approval,
  not after it.
- The check is made against the network the action is scoped to. A wallet
  connected to a network the app does not support is not thereby exempt: an
  action still aimed at a supported network is judged by that network's terms,
  not permitted for want of an answer.
- Acceptance is a single action recorded against that exact version and
  fingerprint, so what a user agreed to remains checkable afterwards.
- **A user is never asked to pay for the same acceptance twice.** Once an
  acceptance has been confirmed as recorded, the app treats it as recorded even
  while its own subsequent checks are still catching up. Re-presenting the
  prompt in that window would invite a second payment that buys nothing.
- Where the app refuses an action and tells the user to go and accept, the
  destination it names is one that actually asks. The surfaces that stay open
  regardless of acceptance deliberately do not ask, so naming them would send
  the user back to the same refusal.
- A user is asked again only when the terms change to a new version. An
  earlier acceptance no longer counts once a new version is in force.
- Acceptance is recorded separately per network. A user who has accepted on
  one supported network is asked again on another.
- A visitor with no wallet connected is never gated. The requirement is about
  the party who would transact.
- **Surfaces that only show information are never withheld.** The explainer,
  the user's own history, and position-token verification carry no action at
  all, so there is nothing on them for the requirement to withhold — and a
  user asking what the terms mean must not be met by a page that will not
  open.
- **When the app cannot determine whether terms apply, it withholds new
  exposure and says so, rather than allowing it.** This is the intended
  behaviour and not a degraded one: the requirement is enforced by the app
  alone — the protocol records acceptance and publishes the version in force,
  but does not itself refuse an action from a wallet that has not accepted —
  so allowing access on an unanswered check would mean the requirement stops
  applying exactly when the check is unreliable.
- **Not knowing is not refusing, and the user is told which it is.** A check
  that has not finished, failed, or grown too old to trust is reported as an
  inability to confirm, with an invitation to retry. Only a current, answered
  check reports that the user has not accepted. Telling somebody who has
  already accepted that they must accept is both untrue and leaves them
  nothing to do.
- Repaying, claiming and withdrawing are never withheld by this requirement.
  A user must always be able to close a position and take their assets out.

## Regression Expectations

The app should maintain an executable regression tier that drives the real app
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

Where a surface decides whether to offer an action, and that decision is
expressed only as rendered prose, the surface should also state the decision in
a form a review can read directly. A control's absence is otherwise ambiguous
between "the answer is no" and "the answer has not arrived", and a review that
cannot separate those must either wait out a timeout and guess, or report a
healthy page as a defect. Two facts are enough: whether the decision has
settled, and what it settled to. A failed prerequisite should be reported as its
own third state rather than folded into either, because the decision has settled
in that case but its answer is not trustworthy as a negative.

This is a requirement on surfaces whose correctness depends on offering or
withholding an action — not a general instruction to annotate the app.

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
- A position of the wallet's whose ending the platform found by checking the
  chain, because the ending itself was never announced, appears in the feed
  as an observation and is worded as one: the position had ended, in the
  state the chain showed, by a given block, and when and how it ended was not
  recorded. It carries no transaction link and names no one who acted,
  because neither was seen, and any time it shows is the time of the checked
  block, not of the ending. It sits in the feed in the order of that block and
  opens the position. Only the wallet's own positions are shown, by the same
  participation rule as every other row. When the history cannot say whether
  any such entries exist, the feed states that a position's ending may be
  missing rather than presenting itself as complete. (#2643; the history
  side of this is stated under the record corrections above.)
- Every kind of event the platform files under one of the wallet's loans or
  offers, or under the wallet itself, is shown with a plain-language name in
  the reader's language, never a name generated from the contract's event. None is hidden: each is something
  that happened on the chain to the wallet's loan or offer. Record-keeping and
  companion events (a status edge, a fee record, a swap route tried) never
  name a row on their own when their transaction did something more
  meaningful; they are counted in that row's "more in this transaction". An
  outcome (a liquidation, a failed collateral sale, a claim) names the row
  over the steps inside it, and a more specific outcome over a general one (a
  failed sale with no price for the split says so). A name that one event
  uses for changes in both directions (a loan's VPFI entering or leaving the
  discount-tier exclusion) names the change, never one direction, and an
  event that also confirms a setting already in place (automatic
  grace-period listing switched on when it was already on) names the
  resulting setting rather than a change. When a transaction's only sign of
  the outcome is the loan's status moving into an end state (the last daily
  rental deduction repays the loan), the row is named by that end state
  ("Loan repaid"), not by the step that caused it. A share
  held back because the wallet is flagged is named in the in-app wording
  only, with no list or provider named. (#2658)
- Each activity row states the asset and amount its transaction moved or
  offered, when that is known: a loan start states the principal, an offer
  creation or cancellation states the offer's size (as "X–Y" when the offer
  is a range, since its first figure alone is only the minimum fill), an
  amendment states the new size, an acceptance or match states the fill, and
  a claim states what was claimed. An NFT is named by its token, never given
  an amount. In a transaction that carries several offers or loans, each row
  states its OWN offer's or loan's value. The value is established by the
  history service while it reads the chain — from the event itself, its
  companion events in the same transaction, and the loan or offer record —
  and the app shows it as given. Where it is not established (an event with
  no single amount, such as a repayment; a claim whose asset the loan record
  cannot place unambiguously; history recorded before this was introduced),
  the row says the amount was not recorded rather than reconstructing one.
- A row states EVERY value its action moved for its own loan or offer, not
  only one: a borrower claim that pays residual collateral and a frozen
  principal surplus in different assets states both. A companion event that
  restates the same value (an offer's creation and its details, a loan start
  and the acceptance that made it) is counted once. When the same action moved
  something the history service does not itemise — a value it could not
  establish — the row says an amount is not itemised. A
  lender claim always notes that it also pays out any funds held for the
  lender from earlier top-ups, which its event does not include in the amount
  shown. A neighbouring loan or offer in the same batched transaction is never
  folded into the row.
- A collateral sale's row states what the buyer paid, in the loan's lending
  asset. To each party it also states their own part: the lender's part
  always waits for the lender's claim, and the borrower's remainder is either
  sent to their wallet or held for their claim, whichever the sale did. A part
  is stated only when the sale event names it and the history service
  established the amount; a party with no part, or a viewer who is neither
  party, sees no part. (#2876)
- A token amount names its contract beside its symbol, because a symbol is
  whatever the token reports and two contracts can share one. While the
  token's details load, the row says the amount is loading; if they cannot be
  read, it states the figure explicitly as base units of that contract — never
  as if it were a token amount, and never by silently dropping a known amount.
- An ERC-1155 states how many copies moved (one copy and a hundred are
  different positions); when the record does not carry the number, the row
  says so. An ERC-721 is always a single token and states no count. A
  collateral top-up states the amount added, in the loan's collateral asset.
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
  schedule. The form, the review and the standing request all say that a
  request is not a guarantee (#544): until a lender accepts it, the loan
  keeps its due date and grace window, and if none accepts in time it can
  still default like any other loan, so the borrower must be ready to repay
  it themselves; the standing request card says this while it is still
  checking the request's state, too. A loan already past due but inside grace shows a plain
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
  warns that the request survives settlement until cancelled. While
  the search for a request has not answered, the full-repayment review
  stays available (it is the safety valve) but says that a request
  could exist, posted from another device, and that repaying would
  strand it too. Because the page's search runs on a cadence, a review
  is checked again every time it is confirmed: when what the review
  showed does not cover what that check found (a request turned up, or
  the check could not answer, after the review said nothing; or a
  request is now open after the review said only that the check had not
  answered), nothing is sent that time and the review now says what
  repaying would do — the next confirmation repays unless the answer has
  changed again. A warning from an earlier check is dropped once a later
  check comes back clear, and never carries across a change of network,
  account or loan. Repayment is never refused, only disclosed first. Only an acceptable request is live: one that has
  expired, whose loan is past grace, or whose poster no longer holds
  the borrower position can never be filled, so it holds nothing back.
  The request is found on chain from the borrower-position holder's own
  offers, so a request posted from another device or tool shows here
  too, with its cancel action, to the wallet that posted it; this device's
  own record of a request it just posted only speeds that up. A request
  the search has already found stays named, with its cancel action, when
  a later search fails — the surfaces it would strand hold back
  meanwhile — and stops being named only once the chain confirms it is
  gone. A wallet
  that posted a request and then transferred the position, or whose loan
  has settled, is shown that request from any device too — only the
  poster can cancel it and remove its payoff approval. When that search
  of the wallet's own offers cannot answer — it failed, or the wallet has
  posted more offers since the loan's own offer than one search reads —
  the page says it cannot show such a request (and, for a failure, that
  a later try may) and names the manual cleanup (cancel it from the
  wallet's open offers if it is still open — an expired request is not
  listed there, and the page says so — and, either way, remove the token
  approval it relied on if nothing else needs it), rather than staying
  silent. This depends only
  on that search, not on any other role the wallet holds in the loan. An expired
  request is still shown so it can be cancelled and its approval removed,
  and the card outlives the loan's settlement for the same reason. A new
  request is not posted while the app can see one open, and the form waits until the search has answered, checking again just
  before posting. The protocol enforces the same limit (#2407): while a
  request stands against the loan, posting a second is refused, so two
  devices that both pass the app's check in the same moment cannot both
  post — the protocol refuses the second, naming the request already
  open. Only the request the protocol has recorded for the loan can be
  taken; a second request left over from before that limit can never be
  taken, and the page shows it so it can be cancelled. An expired request
  that was never cancelled must be cancelled before a new one is posted —
  the protocol refuses the new one otherwise, because the expired request
  may still hold a fresh collateral pledge and the loan's record is how it
  is found — so the form says so and offers the cancel rather than letting
  the post fail. A request the search has already found
  expired stays treated as expired even when the page's fuller check of
  it cannot finish. Loans on a periodic interest schedule carry a visible
  warning that an overdue period blocks completion until settled.
- The borrower of an active ERC-20 loan sees, in BOTH interface
  modes, one chooser surface that names every early-repayment path
  the protocol offers — full repayment, partial repayment (marked
  unavailable when the lender did not enable it), direct early close,
  handing the obligation to a replacement borrower, offsetting into a
  new lender position, and refinancing — each with its cost
  implication stated up front in plain words: a direct close costs
  the full agreed term's interest (or only accrued interest on a
  day-by-day loan, per the loan's interest mode), a handover costs
  the interest accrued so far plus a top-up when the replacement rate
  earns the staying lender less than promised, and an offset requires
  fresh lending capital now plus the automatic payoff at completion.
  Choosing partial repayment, where the lender enabled it, settles
  the interest accrued up to that moment and reduces the outstanding
  principal by the amount paid, and the loan CONTINUES on the smaller
  balance rather than closing — that continuation is the whole point
  of the option, and it is what separates a partial from every other
  path on this list. Retiring the balance in full is the full-repayment
  path's job, so a "partial" sized at the entire outstanding amount is
  refused rather than quietly settling the loan. Because a partial
  changes the outstanding amount, it is held while another arrangement
  is pinned to that amount, and the reason is stated rather than the
  option vanishing. All three holds are answered by the chain and so
  hold wherever the borrower is signed in: a live offset, a sale a buyer
  has already accepted, and a standing refinance request (found among
  the current borrower-position holder's own offers). When the search
  for a refinance request cannot answer, the partial is held too, with
  that reason. Each borrower action that would change or settle the
  loan — a partial, early close-out, an obligation handover, an offset,
  taking collateral back — repeats the search just before the wallet
  opens. No check made before signing can rule out a request posted in
  the moments between that last check and the transaction being mined,
  so the protocol closes that race itself (#2407): while a request
  stands against the loan it refuses a partial (paid directly or by swapping
  collateral), an early close-out, an obligation handover, an offset and
  taking collateral back, naming the request in its refusal, which the app
  explains in plain words in every supported language even when the wallet
  returns only the raw revert. Full
  repayment, adding collateral and every enforcement action (including a
  partial liquidation) are never held by it. When one of those last checks — or any other check made after
  the token approval — stops the action, the approval it granted is put
  back to what it was before (best effort, and only if nothing else has
  changed it since), and a failure to put it back is said alongside the
  reason, never left silent. The same holds when the transaction itself
  fails.
  The chooser never submits anything itself: in Advanced mode each
  path leads to its own tool with its own review; in Basic mode the
  advanced paths share one explicit, clearly labelled action that
  switches the interface to Advanced in place — the mode change is
  always the user's own choice, never a side effect. Paths that
  cannot currently apply (past the due date, held by a live linked
  request, held while the search for a refinance request has not
  answered — which says whether it is still checking, failed, or cannot
  cover every offer — or one the position doesn't qualify for — refinancing on a
  position acquired on the secondary market stays with the original
  borrower) say so instead of disappearing silently; a
  past-the-due-date unavailability is judged only from chain-anchored
  time and live terms — with no live reading in hand the chooser
  leaves the path offered and lets the target tool enforce the real
  gate, rather than expiring an option off the device clock or a
  lagging data row. The interest-mode-dependent cost lines are priced
  from the loan's actual mode in BOTH interface modes, with neutral
  checking wording while the mode is unknown — the full-term default
  is never asserted for a loan that may accrue day by day. The chooser is
  not shown for NFT rentals (their close path is the rental close),
  nor once the loan is settled or strictly past its grace window.
- Advanced mode offers the borrower of an active, not-yet-matured
  ERC-20 loan an obligation handover (preclose Option 2): accepting a
  standing borrow request from a replacement borrower, who takes over
  the debt with their own pledged collateral while the original
  borrower's collateral is released and the lender keeps the same
  protection. The picker lists only requests the handover can
  actually complete against — same lending, collateral, and prepay
  assets; an amount covering the loan's outstanding principal; at
  least the loan's collateral; a term ending no later than the loan's
  original due date; not the borrower's own request and not one
  already promised to another purpose — cheapest handover first, and
  quotes each candidate's cost to the borrower: the interest accrued
  so far plus the lender-protection top-up. While the request book is
  loading it says so, and an unavailable book is stated honestly
  (loading, empty, and unavailable never look alike). Confirmation
  re-verifies the chosen request and the loan live: a consumed or
  no-longer-fitting request — or one that turns out to be a linked
  sale/position vehicle rather than a genuine standing request (the
  fast market layer may not label vehicles on older data) — stops
  before any wallet prompt with a plain explanation, and a request
  whose terms have CHANGED since the review opened (requests are
  editable in place, and a lowered rate raises the borrower's top-up)
  stops for a fresh review rather than charging more than was
  reviewed; the same fresh-review rule applies when the LOAN's own
  economic terms moved while the review sat open (a keeper extension
  re-stamps the rate, term, and interest clock). For NFT collateral,
  the replacement pledge's exact identity — the token id, and the
  quantity where applicable — is shown on every candidate row and
  repeated at confirmation, because the handover adopts the chosen
  request's pledge and two requests from the same collection can
  carry materially different tokens; where the collateral is a
  fungible token whose details have not loaded, the flow says so and
  holds rather than describing the pledge as an NFT. Before any
  spending approval is requested, the app also checks — where the
  protocol exposes it — that the replacement borrower would actually
  be admitted (risk tier, per-pair consent, jurisdiction), so a
  request that has gone ineligible since it was posted fails with a
  plain explanation instead of leaving a pointless approval behind a
  reverted handover; an unreadable check never blocks an otherwise
  valid handover. One check cannot be satisfied by that ordering: the
  accepted-sale interlock has to be asked as late as possible, since
  its whole purpose is to catch an acceptance that lands while the
  review sits open, so it necessarily runs after the approval. Where a
  check must come after the spending approval like that — or where the
  handover simply fails once the approval has been given — the app
  withdraws the approval it just obtained, so a handover that never
  happened leaves no spending authorisation standing against a form
  with nothing left to cancel. This holds however the flow stopped —
  whether it failed outright or was halted by one of those late
  checks. It is best-effort: if the withdrawal is itself declined, the
  original failure stays the headline rather than being replaced by a
  second, more confusing error — but it is not the whole message. A
  withdrawal that clears the approval and then fails to put a prior
  standing grant back leaves that grant erased, which the person has
  to act on, so that outcome is reported after the original failure
  rather than passed over in silence. Being UNABLE TO ESTABLISH what
  the approval was left at counts as that same outcome, not as a clean
  withdrawal: the app stands back from an approval it cannot account
  for, and says that it could not account for it. A withdrawal that
  reports nothing is a promise that nothing needs acting on, and it
  may only be made when that has actually been determined. Standing
  back because ANOTHER TRANSACTION IS IN FLIGHT on the account is the
  same kind of outcome and is reported the same way: the withdrawal is
  right not to queue behind a transaction whose effect it cannot yet
  see — that one could mine first and be overwritten by ours — but the
  approval it declined to clear is still standing, or, past the
  clearing step, the person's earlier grant is still erased. Not being
  able to tell whether anything is in flight counts here too: that is
  weaker ground than knowing something is, not stronger. Where the
  withdrawal takes two steps — clearing an approval to zero before
  writing the earlier figure back — both the standing-back rule and
  the no-overwrite rule apply to the SECOND step as well as the
  first: what matters is what the approval is worth at the moment of
  writing, not what it was worth when the clearing step happened, so
  a grant made by someone else in between is left alone. And a
  clearing step that succeeded followed by an approval that did not
  take effect is a case for putting the earlier figure BACK, not for
  standing down — the person's approval was cleared by a step that
  did work, and nothing else has claimed it. The mirror case is the
  CLEARING STEP itself not holding — undone by a chain reorganisation
  after it was reported as done, or a token that reports success
  without moving the approval. What the app then sees is its own
  flow's figure still standing, which is not somebody else having
  changed the approval and must not be treated as one: nothing has
  claimed it, so there is no other decision to defer to, and the
  approval this withdrawal exists to clear is still live. That is
  reported, never passed over in silence. The distinction is between
  a figure that is OURS and a figure that is not — never merely
  between zero and non-zero. An
  approval the wallet already held is never withdrawn — it was granted
  for some other purpose and is not this flow's to revoke. Nor does the
  withdrawal act on an allowance that has changed hands since: if the
  figure standing now is not the one this flow put there — because
  another tab, or the person themselves, has raised, lowered or revoked
  it in the meantime — the cleanup leaves it exactly as found, even
  where that means the flow's own approval stays behind. Restoring an
  earlier figure over a deliberate change would hand the spender an
  authorisation the person had just taken away, which is worse than the
  approval it was trying to tidy. The cleanup also reports when it
  cannot confirm its own last step: having cleared the approval and
  written the earlier figure back, being unable to establish that the
  figure is there is not the same as knowing it is, and it is said
  aloud, because the person's approval is definitely cleared and only
  might have been restored. The review states what is paid
  now, that the exact figure is computed on-chain at execution, that
  the borrower's collateral is returned straight to their wallet in
  the same transaction (no separate claim step exists for it), and
  that a failed check aborts the whole handover leaving the loan
  unchanged. After a successful handover the page treats the
  borrower's involvement as ended.
- Advanced mode offers the borrower of an active, not-yet-matured
  ERC-20 loan an offset exit (preclose Option 3): funding a new
  lending offer on the same assets, linked to the loan, whose
  acceptance by a counterparty automatically pays off the original
  loan in the same transaction and leaves the exiting borrower as the
  new loan's lender. The form seeds from the loan's own terms; the
  replacement term may not extend past the loan's due date and the
  demanded collateral may not be less than the loan's. Two
  disclosures must be made BEFORE the review opens and repeated in
  it: the borrower's position token is transfer-locked while the
  offer is open (no moving, listing, or selling it until completion
  or cancel), and posting locks the new offer's lending money now
  while the payoff — principal plus accrued interest plus any rate
  top-up for the current lender — is pulled from the wallet
  automatically at acceptance, so the wallet must stay funded and
  approved for that pull the whole time the offer is open (a short
  wallet only makes the acceptance fail; nothing is taken). The
  token approval granted at posting is sized to the largest pull any
  completion could make, and the quoted keep-available figure states
  that bound. If posting stops after that approval was granted but
  before the offer was posted — a last check found a refinance request,
  the due date came too close, or the posting itself failed — the
  approval is put back to what it was before (best effort, and only if
  nothing else has changed it since), and a failure to put it back is
  said alongside the reason posting stopped, never left silent. A live offset gets a standing view driven by the
  chain's own lock record — an offset made on another device still
  shows — with the linked offer's identity when known, warnings when
  the standing approval or wallet balance no longer covers the
  completion pull (with a restore action for the approval), and
  cancellation (available after the protocol's cancel cooldown,
  judged by chain time), which unlocks the position, returns the
  lending money straight to the wallet, and removes the standing
  payoff approval — but never silently: because a token's spending
  approval is a single shared authorization whose SIZE cannot identify
  which commitments rest on it, the app does not automatically remove
  it, and instead states plainly that the approval is still standing
  and can be reviewed or removed from the wallet's own approvals view.
  What the user must never get is silence about a payoff-sized
  approval outliving the commitment it was granted for. If the loan's own economics moved while
  the posting review sat open (a keeper extension), the submission
  stops for a fresh review rather than granting a standing approval
  larger than the reviewed figure. A dead offset is
  never presented as completable: when the loan has settled another
  way, or when time has passed the point where the offer's
  replacement term can still end by the original maturity, the view
  says the offset can no longer complete, stops the funding warnings
  (there is nothing left to fund), and keeps cancel as the unwind. A
  device-remembered offer identity that the chain no longer knows
  (cancelled elsewhere, with a newer offset now holding the lock) is
  discarded rather than offered for cancellation. While an offset is
  live, the other settlement paths are held off or warned: partial
  repayment, direct close, refinancing, and the handover are not
  offered (any of them would strand the linked offer), and the
  always-open full-repayment review carries a warning to cancel the
  offset first. Because the lock record is chain-authoritative and
  can be created from another device, those same settlement tools
  hold in a visible checking state until the app has actually
  confirmed whether an offset is live — an unresolved or failed lock
  read must not expose a path that would strand a funded linked
  offer. An offset is not offered for NFT rentals, while a sale
  listing is live on the loan, or once the due date is too close for
  any fitting replacement term.
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
  their choosing and for a listing window of their choosing, picked
  from a small set of preset durations. The form must state that
  every listing expires on its own — at the end of the chosen window
  or at the loan's due date, whichever comes first — and that once a
  listing ends without a sale (expiry or cancellation) the same loan
  cannot be listed again for a day, a breathing space for the
  borrower whose offset close-out (its pinned lender offer cannot
  coexist with the listing) and collateral-withdrawal options are held
  while a listing stands (repayment is never held — full, partial, and
  the direct early close all stay available; a partial repayment while
  the listing stands can make it unbuyable, as below, and the seller
  relists at the new terms).
  Changing the chosen window, like changing the rate, voids any
  acknowledgement already given and closes an open review.
  The form must also state the seller's guaranteed minimum for the
  rate and window on it: the least the seller comes out with if a
  buyer takes the listing at any moment before it ends (what the buyer
  pays, less the settlement, which is deducted from that payment
  before it reaches the seller), read from the
  protocol's own quote rather than recomputed by the app, and — when
  there is any — the balance already set aside for the lender that
  goes to the buyer with the position rather than to the seller. The
  quoted minimum allows for the time the listing takes to confirm and
  for the protocol's rounding, so it may sit slightly below the
  instantaneous figure; it must never sit above what the listing will
  record. The listing is submitted bound to the figures the seller
  reviewed, so the protocol refuses it — nothing listed — rather than
  record a lower minimum or a higher set-aside balance; such a refusal,
  or a listing transaction that fails after it was sent, closes the
  review and asks the seller to review again against the current
  figures, which the form reads afresh before it offers a review again.
  Every review starts unconsented: consent covers only the figures it
  was given with. Where the minimum cannot be read, the form says so
  and does not offer the listing, rather than listing without a
  stated guarantee.
  Before confirming, the review must disclose: the
  lender position NFT is locked for transfer until the sale
  completes or the listing ends — and honestly, not loosely: expiry
  by itself stops the listing being buyable, while the lock is
  released by cancelling or by a cleanup step that anyone may
  trigger after expiry (even while the protocol is paused), and the
  disclosure must say so rather than imply the lock vanishes at the
  expiry moment; the settlement (the larger
  of interest accrued by acceptance or the rate difference for the
  remaining term — never both) is deducted from the buyer's payment
  inside the buyer's transaction before the rest reaches the seller,
  so nothing is drawn from the seller's wallet and listing asks for no
  token approval; and a rate above the loan's own attracts buyers at
  the seller's cost. An explicit
  risk-and-terms acknowledgement is required before listing and is
  voided by any term change.
  The listing's standing surface is chain-authoritative (the lock on
  the position NFT), so a listing made on another device still
  shows and still interlocks the sell-into-offer exit; the recovery
  search for its identifier covers the wallet's recent offers and
  retries a bounded number of times. There is nothing about the
  seller's wallet for the surface to watch: the sale cannot fail for
  want of the seller's funds. The cancel action binds to the wallet
  that currently HOLDS the lender position — any other wallet on the
  same device sees the listing's existence but no actions. A
  momentary data failure never hides the listing surface while the
  lock stands, but while the latest read has failed the surface
  states nothing drawn from the listing's record or the loan's status
  (taken, expired, settled, or an end time) and says instead that the
  current state could not be read; a listing whose loan has since
  settled says so plainly and steers to cancel-to-unlock. The two
  lender exits share one write lock so their transactions can never
  race each other. Cancellation (which
  unlocks the NFT and becomes available after the protocol's cancel
  cooldown judged by chain time) is offered where the listing's
  identifier is known; it removes no approval, since the listing set
  none, and its message points a seller whose listing was made by an
  earlier app version (which did set one) at their wallet's
  approvals view. Its outcome is reported on the page even
  though the listing card closes. When a listing ends off-page (a
  buyer accepted, or it was cancelled elsewhere), the page states
  that outcome once instead of letting the card silently vanish.
  While a listing stands, the sell-into-offer exit is not offered.
  The listing surface must also say, from the listing's own record
  when it can be read, whether a buyer can still take it: open until
  its end time; already taken and still settling (which can still
  complete); or ended without a buyer (no one can buy it, and the
  lock remains until cancel or cleanup). It must say that a listing
  records the seller's minimum and the set-aside ceiling, that a loan
  change breaking either — a partial repayment is enough — makes
  buyers' attempts fail, and that the remedy is to cancel and relist;
  while the protocol offers no way to read the recorded figures, the
  surface states that it cannot tell whether that has happened rather
  than implying it checked. Listings made before these figures existed
  recorded none and are not presented as broken. The exit chooser's
  pending-cost disclosure follows the same record: a listing that can
  no longer complete stops carrying its costs as pending — but only on
  a current read: a refresh that fails never drops them, since a loan
  can return to a state where the sale can complete. An accepted listing is described
  as accepted, not as live; and the surface names the cancel action
  only where it offers one.
  The borrower's repayment surfaces are NOT held off — full and
  partial repayment stay open throughout (a buyer's acceptance binds
  to the loan's current outstanding amount, so the buyer can never
  overpay for a shrunk claim; on a listing that recorded the seller's
  figures, a partial repayment that breaks them makes the listing
  unbuyable until the seller relists).
  What a listing does hold is the borrower's offset close-out (its
  pinned lender offer cannot coexist with the listing) and
  collateral-withdrawal options, and the borrower-side surface must
  say so (see the borrower listing-hold notice below). The direct
  early close is never held — a borrower may settle the loan under a
  live listing, after which the dangling listing is cleaned up
  permissionlessly. A terminal
  loan state should show the seller a clear cancel-to-unlock path
  for any stale listing. The
  listing form is offered only on networks
  where the protocol's listing entry point is known to work
  end-to-end; elsewhere it is withheld and replaced by a plain note
  pointing at the working instant exit. Every standing-surface rule
  above applies to any listing that exists either way.
- On the BORROWER's own loan page, a lender-sale listing on their
  loan is surfaced as a listing-hold notice — the borrower is exactly
  who the listing lifecycle's action window exists for, so the notice
  is where that escape reaches them. While the listing is live it
  explains, honestly and without any action: which options are held
  (the offset exit and withdrawing collateral), which stay open
  (repaying fully or partially and closing early — with the note that
  a partial repayment shrinks what a buyer would take over), and the structural
  bound on the hold (the listing ends on its own — at latest the
  maximum listing window after creation, sooner at the loan's due
  date — or earlier if the lender cancels). The chooser's offset
  entry is marked held with the same why instead of jumping to a flow
  that would fail. Once the listing has ended but the hold has not
  yet been cleaned up, the notice grows a one-click cleanup that
  anyone may send — available even while the protocol is paused —
  which frees the held options immediately and reminds the borrower
  that the lender cannot relist for the quiet period. The notice's
  existence is judged from the chain alone (never a local marker or
  an off-chain index), it appears for a listing made on any device,
  and when the state cannot be judged the surface shows NOTHING
  rather than a false hold or a cleanup that would fail.
- A sale that a buyer has ACCEPTED but which has not yet finished
  completing is the one state where the borrower's settlement options
  are paused rather than merely explained. In that window the buyer's
  funds are committed while the purchase still depends on the loan
  standing as it is, so repaying, part-paying, closing early,
  transferring the obligation, or requesting a refinance would strand
  the purchase permanently. The app must pause those paths for the
  duration and state the reason up front, rather than letting the
  attempt fail unexplained at the end; adding collateral stays
  available throughout, since it strands nothing. The pause is honest
  about its own limits: it promises that the options the loan's
  remaining term still allows come back once the sale settles, not
  that every option returns.
  The pause holds ONLY while the loan is running normally. A purchase
  can only complete against a running loan, so once a loan has fallen
  into fallback resolution the purchase is already stranded and there
  is nothing left for a pause to protect — while the lender's own
  claim stays available to them throughout. Pausing there would be
  permanent, not momentary, and would close the borrower's last door.
  So in that state the app states the situation instead of enforcing
  it: the borrower is told a purchase is attached, that it cannot
  complete until the loan is brought back to normal, and that settling
  the loan instead ends the purchase with it — and then the borrower's
  own choice is left open to them. The same rule binds the final
  pre-send check: it may only refuse a settlement on a loan the chain
  confirms is still running.
  Because a cached answer can be stale by the time a review screen is
  confirmed, every one of those settlement paths must re-ask the chain
  immediately before it sends, and an unanswered check must pause the
  path rather than let it through. This is app-level protection over a
  window the protocol itself still permits.
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
  prompt. An OFFSET vehicle — a lending offer a borrower posted to
  close their earlier loan early — is acceptable here (#2523; this
  reverses the earlier exclusion by owner decision, the approved
  issue plan of 2026-10-20). The taker's loan is an ordinary new loan
  on the offer's own terms, and the review describes it as such; it
  must also state, before signing and in the receipt consent is given
  against, that the same transaction pays off and closes the earlier
  loan from the poster's own wallet, that the taker owes nothing
  toward that loan, and that if the close-out cannot complete the
  whole acceptance is refused with nothing moved (the network fee is
  still spent). The acceptance is signable only when every condition
  the close-out needs is positively clear, each read live: the earlier
  loan is still active; a loan started now on the offer's terms would
  still end by the earlier loan's due date; no swap-to-repay order is
  waiting on the earlier loan; and the poster's standing approval and
  wallet balance both cover the most the close-out can pull — the
  same bound the poster's own offset card watches, so the two parties
  are told the same thing. Each failed condition is named in plain
  words, an unanswered check blocks and offers a retry, and submission
  re-reads every condition and aborts before any signature or approval
  if one has failed or changed since the review. Which vehicle a
  linked offer is follows the side of the book it sits on (a position
  sale is a borrowing offer, an offset a lending offer), never who
  created it, because one wallet may hold both sides of a loan. For
  every acceptance review that is re-read at submission (refinance,
  position sale, offset), a re-read or background refresh that fails
  leaves the review unknown, with its retry and nothing signable,
  never showing the earlier clear answer. A linked offer whose
  kind cannot be positively identified remains not acceptable: the
  review flags the link, names the loan, and blocks signing entirely.
  Signing always waits until the link and kind checks
  resolve, and a failed check shows a visible retry rather than
  silently passing. This is a deliberate supersession, on this
  surface, of one specific model: the primary app's borrower-side
  `Borrow or sell` COLLATERAL-marketplace-listing opt-in described
  in the offer-creation requirements earlier in this document (the
  eligibility flag plus the separate marketplace-listing publication
  of NFT collateral). That opt-in, its listing publication, and
  accepting unidentified linked-offer kinds stay out
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
- The verifier is built to be held up against a copy of itself,
  because a copied page can render any verdict and can add a step
  that asks the visitor to connect a wallet and sign, which is how a
  wallet is drained. No page can prevent being copied, so the real
  one states what a visitor can check without trusting the page:
  - it says permanently, on the page itself, that checking a token
    never needs a wallet, a signature or an approval, and that a
    "verifier" asking for any of those is not Vaipakam's;
  - it names, in full and never shortened, the contract address the
    token was checked against, linked to the network's block explorer,
    and says that this address, not a name or picture, is what makes a
    token a Vaipakam position;
  - every verdict, "live" or "does not exist", links the same token on
    the block explorer, labelled as an independent view that may run a
    few blocks behind.
- Help lists the Vaipakam contract address for every supported network
  in full, and explains how to recognise a fake verifier or a fake
  position NFT: the real verifier never asks for a wallet, names and
  pictures can be copied but contract addresses cannot, and the app is
  best opened by typing its address or from the visitor's own bookmark
  rather than from a link inside an NFT, a message or an email.
- Advanced mode's loan-health detail states, alongside the health
  factor and loan-to-value, roughly how far the collateral's value
  can fall before liquidation begins — explicitly framed as
  approximate (it is derived from the health factor, not a price
  feed, and assumes the loan side holds still). Beside them it states
  the liquidation price (#2531): the collateral price, in the protocol's
  reference currency per whole collateral token, at which the health
  factor reaches 1.00. The price and the health factor it is derived
  from are read together, as of one block. It says what it assumes —
  the borrowed asset's price and the amount owed held where they are,
  with accruing interest moving it up — and it is rounded so it never
  shows a line below the real one. It never shows a zero price: a loan
  the protocol does not price says there is no liquidation price and
  why, a loan whose collateral price or token details could not be read
  says the figure is unknown, and a loan whose debt is too small to
  reach the line says no price brings it there. Where a holder
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
  picture as complete. When the wallet's loans or offers could be read
  only from the backup source, which can lag behind the chain by a minute
  or two, the list is still shown but says that a token from a very
  recent position may be missing until that source catches up. It does
  not promise the next refresh fixes it.
  When part of the offer list could be read from neither source, the list
  says instead that tokens from offers the wallet holds may be missing
  whatever their age, and to try again, since that gap does not close by
  itself. When both apply (one list lagging, part of another unread),
  both are stated; neither is dropped in favour of the other.
- The vault page builds its asset list partly from the wallet's own loans
  and offers. It states the same two cases the same way: an asset behind
  a very recent position may be missing when the lagging backup source
  answered, and an asset behind any held offer may be missing when part
  of the offer list could not be read at all, stating both when both
  apply. It never presents the list as complete in either case.
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
  pre-filled public issue carrying the reviewed support details — page,
  network, connection statuses, build, and the last
  recorded error — plus a copy-to-clipboard fallback for users
  without an account on the issue tracker. Reports are redacted by
  construction: the full wallet address never appears, error text is
  length-capped, and nothing else about the device or browsing is
  included. When a page crash is caught by the app's recovery card,
  the error is recorded so a subsequent report carries it.
- The address redaction should hold however the address is spelled in
  the text being redacted, not only when it is written plainly. A page
  address is carried into a report as the browser reports it, and a
  browser leaves percent-escapes in a query string undecoded — so an
  address that arrives escaped must still be shortened, since a reader
  of the report can recover it with one decode. Redaction that a link's
  encoding can step around is not redaction; the promise is about what
  the recipient can learn, not about which spelling the matcher happens
  to recognise. Text the redaction does not need to change should reach
  the report spelled exactly as it was, since a support reader may need
  the link as the user actually had it.
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
  appears as a fill. A fill is a fact about the moment the loan was
  agreed: the tape, the header's last executed rate and the chart's
  per-fill markers show the rate and amount the loan was agreed at,
  and it stays in the tenor market it was agreed in. An extension,
  a partial repayment or a match changing the loan later moves none of
  that. A loan belongs to a tenor market only once its agreed terms are
  confirmed from its opening record. Until then its tenor is unknown, so
  it is shown under no duration, never under a guessed or current one.
  The recent-loans list states how many such loans the pair has in all,
  and an empty list then says only that no loan with confirmed terms
  sits at this duration. The chart states how many the pair has in the
  period,
  counted from the same reading of the data as the chart itself. Past a
  stated limit the chart says "more than" that many rather than an exact
  figure. A rate history that does not state these exclusions (how many
  loans it leaves out, and in each bucket how many amounts are
  unconfirmed) is shown as unavailable, never as complete, and so is a
  tape that does not state it was read under this rule for this market:
  an empty tape counts as "no loans yet" only when the indexer says so.
  When the tape already shows a loan in the chosen period that the
  chart's last refresh did not include, the chart says it is catching up
  rather than claiming the period is empty.
  Where only the agreed amount cannot be confirmed, the fill appears, with
  its own marker on a sparse chart, and its amount reads as not recorded. The loan's current terms are never
  shown in place of agreed ones. Positions show under the book with their health
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
  open/high/low/close alone; a bucket whose total leaves out fills whose
  agreed amount cannot be confirmed says the total is a minimum and how
  many it leaves out; when the pair has loans in the period whose agreed
  terms are unconfirmed, an empty chart claims only that no confirmed
  loan sits at this duration, never that none was agreed; a clipped
  history is disclosed whether or not anything is drawn; the order book's current quoted mid may be
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
  That substitution replaces the PARTIAL choice only. Immediate-or-
  cancel remains available on a gasless lend order and is posted as
  chosen, because immediate-or-cancel says when an order stops resting
  rather than how much of it may fill — so it is not in conflict with
  single-whole-fill, and the requirement that such an order carry an
  expiry continues to apply to it. The ticket never posts a fill mode
  other than the one it is showing: the mode displayed on the chips is
  the mode that goes into the order, at every moment, including while
  the terms that force the substitution are themselves changing.
  Choosing to lend rather than borrow, or to post by signature rather
  than on-chain, changes what is being agreed to, so it withdraws any
  risk-and-terms acknowledgement already given — at the moment of the
  change, not after it. This matters most for a signature-only post,
  where the signature is the last checkpoint: nothing downstream
  re-examines whether the acknowledgement matched the terms displayed
  when it was given.
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
