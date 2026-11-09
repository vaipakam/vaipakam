# alpha05 — the connected app rebuilt from the functional specs

**Status:** Design v2.3 (2026-11-05), revised after three external review
rounds and a review against the functional specifications (note at the
end); owner direction approved, build not started.
**Module:** `apps/alpha05` (new), replacing `apps/app` at parity.
**Governing specs:** `docs/FunctionalSpecs/ProjectDetailsREADME.md` (canonical),
`TokenomicsTechSpec.md`, `KeeperOperations.md`, `VaultOperations.md`.

**Specification precedence.** The canonical spec decides intended behaviour.
`Alpha02ConnectedApp.md` and `WebsiteReadme.md` describe the current app:
their *presentation* (pages, layout, labels, component names) may change
here with a stated reason, but every *behavioural and funds-safety*
requirement in them stands until a recorded owner decision replaces it.
The feature matrix this design serves (one row per thing a
user does or must see, each with a status, a page, a data rail and its
contract entry points; 396 rows after the spec review and five review rounds) is kept in
the owner's private project files; its
shared rules are the ones below and rows cite them by name.

---

## 1. Why a new app

The current app grew one paragraph at a time. Every review that asked for
transparency added visible text, and the app had nothing that could fold text
away (one collapsible element, no help panel), so the loan page came to carry
ten option cards and about eleven thousand words of copy. Most money actions
take two wallet prompts. The owner's direction (2026-11-05) is to build the
app again from the functional specs, for a user with little DeFi or banking
knowledge, with guidance that does not clutter the page, confidence through
predictability, and the fewest clicks modern consumer finance expects, and to
do it architecturally clean and transparent on every fund movement. No logic
is carried over from `apps/app`: the old app is read for edge cases, never
imported, because many platform features are missing from it.

## 2. The rulebook

Every route PR cites these rules by name. A rule a PR cannot meet is stated
in the PR, never worked around.

### RB-TIERS — three text tiers

Every piece of text on a page is in exactly one tier.

- **Tier A, consent, funds and consequence, always visible in both modes.**
  Anything a signature or a decision depends on: the review receipt rows,
  the accept terms the signature binds, the risk consent, every "You can
  lose" line, the sanctions banner, the plain statement (where a side of a
  deal is not priced by the protocol) that default means the entire
  collateral transfers directly with no price-based liquidation, what a
  listing does to the counterparty, every stated unknown, and the
  *consequence* of a race or a hold (the cure window can close when the
  lender finalizes or opts into the backstop; an accepted sale holds
  settlement until it completes; a listing or a reward expires at a
  stated time). What may move off the page is the mechanism, never the
  consequence, the current blocker or the available remedy.
- **Tier B, status and next step, visible, one sentence.** "Due in 28
  days", "Grace ends Dec 7", "You can repay now", "Held: a sale is
  completing".
- **Tier C, mechanism and background, one tap away.** How the race arises,
  why the protocol holds the action, how listings expire, how a tier is
  computed.

**Tier A overrides every folding and word-budget rule.** A typecheck-time
guard refuses an inline Basic-mode paragraph over a word budget unless it is
tagged tier A, so long text has one legal home.

### RB-HELP — one help system

A one-line summary followed by a "Why?" (or "How does this work?") link that
opens a side panel (a bottom sheet on phones) rendering the full explanation
from the same copy key, so the copy catalog and the locale bundles stay the
one source. The panel ends with a deep link to the matching section of the
user guide. The same component serves Advanced mode: each Advanced feature
gets a one-screen primer (what it does, when to use it, what it costs, what
can go wrong) opened from its card header, and every protocol term shown in
Advanced mode is a tap target that opens its glossary entry. Tooltips are
not used: they fail on touch screens, cannot hold a long explanation and
are poor for screen readers.

### RB-ACTION — action-first pages

One primary action per screen, chosen from the viewer's role and the
position's state through RB-ELIG; every other option in a list under "Other
options", each opening its flow in a panel. For a lender's running position
the first thing stated is the option that forfeits nothing, leaving it
alone: conditionally, never as a promise of repayment, saying when the
loan's own terms pay (during the term on a periodically settling loan, as
each part arrives on a loan that permits partial repayment), and saying so
while those terms are not yet known; every exit is then shown with its
cost, and whether it is open, before the tool behind it opens, and an exit
that is closed explains why, names what remains open, and names a remedy
only where this session can offer it. A status card stays on the page
only while something is pending (a listed sale, a pending refinance, a
close-out that is ready). Rarely used controls sit under an "Advanced
settings" fold inside the card, with a labelled safe default already set.

### RB-ELIG — one eligibility rule per action

Every action (repay full or partial, add or withdraw collateral, claim,
sell, list, refinance, offset, handover, extend, swap-to-repay, position
transfer) is admitted by ONE shared verdict, computed once in the
eligibility module and used by Home quick actions, Positions rows and every
panel alike. The verdict distinguishes at least: an open, unaccepted lender listing
(holds ONLY the offset close-out and excess-collateral withdrawal; full and
partial repayment, the direct early close and adding collateral stay open,
as the canonical spec states: "repayment is never held"; the lender's own
direct instant-exit sale is refused while their listing stands); an accepted
lender sale completing on a running loan (repayment and the other
settlement actions are held, with a fresh pre-send re-check; this hold is
sourced from the current-app specification's behavioural rule, "accepted-sale
pause of borrower settlement" (A02 L4969-4999), binding under RB-PRECEDENCE,
over a window the canonical spec permits but does not name: PD L2702
completes a listed sale in the buyer's acceptance transaction and PD L1100
names the accepted-sale state only to stop a time-based default);
fallback resolution (the borrower's cure stays open until the lender
finalizes the claim or opts into the backstop); a standing refinance
request; an offset link; a pending swap order; a protected-account lock or
queue (a lock blocks new payouts and new positions, taking a lender
position by sale or a borrower obligation by handover included, and never
blocks loan servicing); the Terms gate (which never holds taking one's own
free assets out, releasing an existing payout, withdrawing a settled claim,
a seller claim included, requesting an unlock or increasing protection);
the sanctions tier; and each switch in RB-SWITCH.
Where the Diamond exposes a verdict (the sale-exit verdict, the accept
preview, the preclose and claim previews) the app reads it; where it does
not, the rule is written once in the module and the gap is a recorded
finding. Where the verdict cannot be obtained (the read failed, or the
deployment cannot give it) the surface says so and does not offer the
action; a refusal the app has no words for is still a refusal, never
permission; and where the protocol names the earliest moment a refusal can
lift, that is stated as a time alone, never as a promise, with a note that
a step someone chooses (cancelling a listing) can lift it sooner.

### RB-SWITCH — action-by-switch table

Five classes of switch, each named by name wherever a row or a surface
mentions a pause. The effect is defined per ACTION, not per switch: an
origination control blocks new positions, a lifecycle-feature control
blocks that feature's action on an existing loan too (whoever initiates
it), and a keeper execution control never blocks a user action.

| Class | Examples | Effect on user actions |
| --- | --- | --- |
| 1a. Origination switches | offer creation or accept paused, auto-lend (intent fill) enable, partial-fill matching, lender-intent enable, periodic-interest admission, the fee-entitlement tariff, and the app's own operational switch over position-opening flows (posting and accepting offers, listing and renting NFTs, depositing VPFI) | Block new positions and new enablement only; everything on an open position stays available (repayments, claims and withdrawals included); a paused flow says that existing positions are unaffected |
| 1b. Lifecycle-feature switches | auto-extend enable, auto-refinance enable, internal-match liquidation, the discounted liquidation path, prepay-listing enablement, the backstop opt-in | Block that feature's action on EXISTING loans as well (an in-place extension reverts while auto-extend is off, whoever sends it; the auto-refinance switch stops the MATCHER filling a refinance request — a lender accepting the holder's tagged offer directly is not automation and is never blocked by it, per the canonical spec's Borrower Position Authority); the surface names the switch and what stays open (repay, add collateral, claim, the direct exits), and states the posture in every case, on, off, the protocol paused, or not currently known (still loading, or the latest read failed), never by silence, which would imply automation is available |
| 1a and 1b alike | any feature switch | A user can always revoke their own consent while the feature is off |
| 2. Global administrative pause | the protocol pause (manual, or a time-bounded automatic pause) | Stops new positions (offers, accepts, matches), claims, withdrawals, liquidations, defaults and the keeper-driven settlement steps; leaves full repayment, partial repayment and adding collateral open so a borrower can always lower their risk. The paused time is credited to every open loan's due date and grace end, and the surface shows the effective deadlines beside the original due date (offer, intent and listing expiries do not move). Stated exceptions, each named on its surface: after three unbroken days of an administrative pause the owner's escape withdrawal (bounded as a depository withdrawal, closed to a sanctioned wallet, not opened by an automatic pause, which also does not restart the count) and a protected account's queued payouts keep releasing; tearing down an expired or dead listing, and lowering or withdrawing one's own notification-fee consent, stay open. While the protocol is paused a preview reports the pause and nothing narrower |
| 3. Asset-level pauses and screens | token screen, distrusted price, deposit pause on an asset | Block that asset's new positions and the routes that need its price; the surface states what remains |
| 4. Keeper switches | each keeper pass's arming, the protocol-wide delegated-keeper pause | Never block a user action: position owners still act on their own positions directly and permissionless liquidation stays available, only third-party keepers are frozen; the keeper is a convenience service, so a switch only changes who runs a step; the Console names each |

A contract that diverges from this table is a recorded divergence in the
audit, never contradictory copy. (This table follows the canonical spec's
"Global Pause Leaves Repay And Add-Collateral Open" rule; an earlier
revision said claims and withdrawals stay open under the protocol pause,
which is the rule for the app's own operational switch in class 1a, not
for the protocol pause.)

### RB-REVIEW — review reads plus final authorization

The receipt is built from chain reads at review. Before the wallet opens,
the app re-reads every transaction-critical fact (the eligibility verdict,
amounts, deadlines, the current holder, protected-account state). Changed
economics or disclosures reopen the review and invalidate consent; an
unreadable safety prerequisite withholds signing; an advisory simulation
failure is shown, and the user may proceed only where the spec allows it,
stated per flow. The reason shown for a refusal is the platform's own
first refusal, in words the reader can act on, never re-ranked or reworded;
a refusal the app does not recognise still stops the action (the app can be
older than the deployment), and a measured figure is attached to a refusal
only when the platform supplied it. A change of network, deployment,
wallet, position or asset pair mid-flow clears every answer at once and
holds signing until the new context has its own. Once a transaction has
been handed to the wallet there is no silent retry that could leave it
ambiguous whether the action may still confirm.

### RB-CONFIDENCE — predictable confidence

The same four things on every write, so the app is learned once: a review
receipt before the signature (You receive / You lock / You may owe / You can
lose / Fees / When this ends, plus one plain line per Advanced option the user
changed from its default, plus a fixable-items eligibility checklist: wallet,
network, sanctions status, token validity on both legs, balance, consent,
with any shortfall named as an amount and an asset); receipt amounts are
exact to the token's smallest unit, never rounded, and a typed amount is
sent exactly as typed or refused with the token's decimal places named; the
flow says how many wallet confirmations may be needed and in what order,
and narrates the current wallet step; a simulation of what will happen; a
progress line while the transaction runs; a finish card that reports the *measured*
outcome (never the requested amount), what to watch next, and the next
action as a button. Errors are written as next steps. A first-run
introduction is three dismissable cards on first connect, never a tour over
the live page.

### RB-CLICKS — minimal clicks, measured

Every common job within three decisions from Home; a screen that only asks
the user to confirm what the app already knows is a wasted click. Home shows
each position with its next action as a button; Borrow and Lend open
prefilled from the last pair used; forms validate as the user types with the
fix stated inline (a field's error appears once the reader leaves it or asks
for the review, then follows each keystroke, so nobody is told off mid-entry); amounts carry a Max button and a numeraire equivalent;
impossible choices are greyed out with a count of what remains rather than
refused later. Where the wallet supports call batching or a permit the
contract path accepts, approval and action are one wallet prompt, with the
two-step path as the fallback and the receipt saying which it will be. A
signature-based approval is used only when live preconditions make it
valid; if it is declined or unavailable before any transaction is submitted,
the classic approval path follows. When a check made after a token approval
stops the action, the approval is put back to what it was (best effort, and
only if nothing else changed it), and a failure to put it back is said
beside the reason, never left silent; approval resets are named honestly.

### RB-MODE — mode is defined per capability

Basic is the default. A capability is Basic when a first-time user needs it
to complete or stay safe in a plain borrow, lend or NFT-rental lifecycle
(post or accept an offer, see the position, repay, add collateral, claim, be
alerted, keep the vault safe), or it is a consent, a deadline, a held balance
with its recovery claim, a settlement outcome, or a risk disclosure.
Advanced is optional optimisation, alternative exit and settlement routes,
keeper and automation configuration, reward and tier mechanics, the trading
desk, protocol operations, governance and data-rights tooling. Navigation is
derived: Basic navigation shows a page when it holds any Basic capability,
and a Basic user following a claim, withdrawal or deadline link never lands
on a page that hides what the link promised. Advanced is the same guided
product with more unfolded: the same help system, primers and glossary
reach every Advanced control. Switching mode never navigates, and the
selected mode persists for the user. A Basic user who opens an Advanced
route directly is oriented and offered a path back to the guided flows. In
Basic, the advanced paths of a chooser share one explicit, labelled action
that switches the interface to Advanced in place, always the user's own
choice, never a side effect. The ways out of a lender position are not an
advanced topic: that each exit exists, what it costs and whether it is open
is Basic in every view; only the tool behind an exit may be Advanced.

### RB-CLAIM — one claim flow, many entry points

One shared claim flow (eligibility, payout description, venue, measured
outcome, partial-failure handling) reached from Claims, Home, Position and
Rewards; Claims is the canonical list, not the only button. "Claim
everything" has one canonical inclusion list: loan proceeds (lender and
borrower claims), interaction rewards whose preview completes, eligible
held rewards, un-lent intent capital, free (unencumbered) vault VPFI (an
opt-in, off by default, because that balance backs the fee-discount tier and
pulling it lowers the tier) and, for a payee, withdrawable payroll (the
canonical spec's Batch Claiming names all of these); it excludes
seller-interest claims and anything whose preview cannot complete. The
payee's own page is not yet specified and is a proposed row; the batch leg
is canonical. Each payout is shown for individual include or exclude before
signing; the batch is offered only once every ready amount it would include
is known (a still-loading balance is never silently omitted, and a balance
that cannot be read is named as excluded); the batch is bounded, and a
remainder is collected in a second batch rather than in a transaction that
would fail; the same sanctions posture as an individual claim blocks it
before signing; a bounded rewards leg may leave a residual, which is shown
with a re-claim. The batch reports each leg's measured outcome; a payout
another party finalized between preview and signing is skipped, not fatal,
and anything skipped stays listed to claim on its own; a failed leg never
disappears.

### RB-RAILS — three data rails

| Rail | What | Source | Freshness |
| --- | --- | --- | --- |
| World | the offer book, other users' loans, rates, activity, metrics | the indexer's database, invalidated by its push rail | the indexer's own ingest per chain (a few minutes on the current multi-chain rotation); the push rail announces changes and reports its own freshness, so a quiet rail is told from a stalled one; a stale-data notice once the index has not advanced for half an hour; a stalled or unavailable indexer is a degraded-source warning, never a confident empty list |
| Own, when connected | the user's positions, vault, allowances, claimables, pending rows | the chain, through the user's wallet provider first, the read-only proxy as fallback, and a user-supplied endpoint where the deployment's credential policy permits (the specs ask for provider failover; the order is this design's) | invalidated by signals (own receipt, push hint for the address, focus, reconnection) AND refreshed on a bounded safety interval while the tab is visible (default 60 s, rail-health dependent), paused while hidden; reads that gate an imminent money decision refresh per block while it is on screen; the user's own confirmed action refreshes its views at once in every open tab; a money action fired from a list row is re-checked against the chain at the click; a receipt triggers reconciliation, it does not carry every balance |
| Pre-sign | the receipt, simulation, gas | the chain, same provider order | at review, re-checked before signing per RB-REVIEW |

Every world-rail figure carries its block and age; a time the index does not
know is shown as unknown, never guessed. A figure the app could not read
says so; "nothing here" is shown only when the source positively returned
zero, and a failed or partly read list is unknown, never empty. The receipt
is never taken from the index; governance-tunable display values may come
from the indexer's configuration snapshot, with the chain as the fallback,
but anything the user signs against is read live from the chain. Public chain reads
without a wallet are allowed where verification or recovery needs them (the
NFT verifier, public analytics, the Console, independent recovery), through
the bounded read-only proxy or a public endpoint; "no platform RPC per
visitor" is an efficiency target for the world rail, not a prohibition.

### RB-A11Y — accessibility and i18n

Keyboard and screen-reader operable, WCAG AA contrast, from the first route
(a commitment of this design; the specifications are silent on it). Mobile
first: the same destinations on phone and desktop, with bottom navigation on
small screens and a persistent layout on larger ones (below 720 px a bottom
bar of the first four destinations and More; from 720 px a one-row header of
brand and wallet over a left column, a rail of icons above short names up to
1023 px and a panel of icons beside names from 1024 px, the pages only
Advanced adds grouped under their own label after the Basic ones, and the mode
and theme controls at the column's foot; from 1024 px the panel can be
collapsed to its icons by an icon-only main-menu button (three lines) at
the far left of the header, the pattern everyday web apps use, named "Main
menu" for screen readers with a hover tip and stating whether the panel is
expanded, the choice remembered per browser, and while collapsed a resting mouse (after about 0.3 s, hidden again
0.5 s after it leaves) or keyboard focus reveals the full panel over the page
without moving it, Escape hiding it; folding, revealing and unfolding
slide the panel and the page beside it over a quarter second on the standard
easing while the names fade and the icons stay put, with no motion at all for
a reader whose device asks for reduced motion; the breakpoints follow the common
compact, medium and expanded window classes); on a phone a form's primary
action, with its live summary, and a review's Confirm rest just above the
bottom bar at full width, where the thumb reaches, while the rest of the page
scrolls under them; an unknown route shows
a recovery page, and a display failure is contained to a recovery card that
says funds and on-chain positions are unchanged. Every string in the copy
catalog; locale bundles override per key, and the language rules of the
current-app specification stand: English is the source language; a language
whose translation is unfinished may be offered and then shows English, never
raw keys or a broken page; the chosen language applies at once, persists and
carries across the platform's own subdomains; a right-to-left language flips
the layout direction before the first paint; protocol terms (VPFI, HF, LTV,
asset and network names) and any word the user must type back as a
confirmation stay verbatim in every language; a language offered as
translated shows it everywhere, and a new surface is translated in the change
that ships it.

### RB-ICONS — icons with fixed meanings

An icon draws the eye to what a page needs from the reader; it never carries
a meaning on its own. Every icon sits beside the words that say the same
thing, and is hidden from screen readers, so the text is the whole message
and a reader who cannot see the icon loses nothing. The one icon that stands
without a word is the info button below, because the sentence it follows is
its label. Two families only:

- **Meanings** (a closed list; one shape each, never reused for anything
  else): something to act on (the warn tone), something blocked (the danger
  tone), done (the ok tone), funds leave your wallet (a receipt row that
  moves funds out, or an approval that lets them move), a signature or
  wallet prompt (the confirm button), waiting on the chain (signing,
  submitted, mined), unknown (a figure the app cannot substantiate, beside
  the word "unknown"), and more about this (the info button "(i)" right
  after the sentence it explains, which opens the help panel of RB-HELP; its
  accessible name is "Why?", its description is that sentence, and its tap
  area is at least 44 px square; no hover tooltip, since touch has no hover).
- **Places**: one icon per destination of the page map, beside or above the
  destination's name on the phone bar and the desktop column. The one place
  the names fold away is the desktop panel the reader has chosen to collapse:
  each link keeps its name for screen readers, and a resting mouse or
  keyboard focus brings the names back. The button that folds it is the
  main-menu button (three lines) at the far left of the header, the one
  control without a visible word: its name "Main menu" is spoken, with
  whether the panel is expanded, and the browser shows that name as a hover
  tip. The tip only names the control, never explains anything, so RB-HELP's
  rule against tooltips for explanations is not touched.

A plain information notice carries no icon, so an icon always means the
reader should look. A new meaning is a change to this rule, not a local
choice. Counts on navigation (such as "Claims 2") arrive with the pages that
own them. Shapes come from one open icon set (ISC licence), drawn inline in
the current text colour, so they follow the theme and contrast of their text.

### RB-FUNDS — fund transparency

Every fund-moving flow states the movement in plain words on the receipt
(payer, receiver, token, gross, fee, reason) and the finish card reports the
measured outcome, never the requested figure: the protocol records a payment
or deposit only when all of it arrived, so what arrived is what is stated.
A route the app cannot drive says so instead of offering a
button that would fail. A feature whose prerequisite cannot be verified is
never an actionable signing step; an unavailable convenience may ship with
its gap disclosed.

A token amount is written for reading: digit groups, and a fraction
shortened to four places once there is a whole part, or to four significant
digits below one, cut toward zero and never rounded up, so a small amount
never reads as zero. A figure that lost digits is marked approximate (≈),
and every receipt with such a figure offers its exact figures, every digit,
in place: its amount rows, and every figure written inside a sentence of it
(a row's text or a "You can lose" line), switch together. A figure the protocol will act on exactly as written (an approval,
a tariff ceiling) is always shown exact, in the review, in the wallet step
and in what a stop reports about putting it back; so are the two figures a
measured outcome compares when they differ, since shortened they could read
the same. In a receipt, labels and values
sit in two even columns so a long label never squeezes its value, with a
hairline between rows, the label above its value on a phone, and a number
is never broken across lines.

### RB-INTEGRITY — page integrity

The app runs only script it serves from its own origin; the few scripts
that must run before anything else loads (theme, language and direction,
start-up failure notice) are allowed by their exact content, so any other
script placed in the page is refused. The app never turns text into code at
run time, and its policy says so; a dependency that needs that is a finding
to investigate, never a reason to loosen the policy. Network destinations
are limited to the configured list: its own origin, the platform services
the build is configured with (the indexer, its live-update channel and the
alert service), the chain endpoints of the networks it supports (the
read-only proxy among them), the token-screening services it calls and the
services its wallet connectors need. The build writes that list from the
same settings the app reads, and a build that cannot name one of its own
endpoints stops instead of shipping. The policy ships report-only: requests
outside the list are reported and still made, a review of the deployed app
fails on any such report, and it is enforced only once a deployed build has
been reviewed clean; until then the Help page says the list is not yet
enforced rather than implying it is. No report is sent anywhere, since it
would carry the address a visitor was on. Nothing claims protection against
a compromised deployment, which serves its own policy, or against software
on the user's own device such as a browser extension. This is a deployment
acceptance criterion (§3.2): a route does not reach parity on a deployment
without it.

### RB-GOVERNANCE-QUEUE — queued governance changes are public

Every change governance makes waits out the governance timelock's delay,
and the wait protects users only if they can see the change. So one public
page, reached from the footer without a wallet, lists every operation the
timelock holds on the chain the screen describes, soonest first, with when it
can run, in words what it will do, and its exact call. The queue is read from
the timelock's own storage, and every value on the page is read at one block,
which the page states. What a change will do is shown only when its calls,
read from the chain's schedule records, hash to the id the timelock stores;
a change whose records were not found or do not match is still listed, with
its id, its time and the reason its action is unknown. A call the app cannot
decode is named as such, never guessed. A chain with no timelock recorded, a
failed read and a failed re-read are each stated, never shown as an empty
queue. The page also says that a queued change does not expire: it stays
runnable until it is run or cancelled.

### RB-STATUS — every matrix row has a status

`approved` (canonical intended behaviour), `proposed` (a departure or new
shape; built only after the owner records it), `blocked` (needs a contract,
keeper or indexer capability that does not exist; ships only with the gap
stated), `divergence` (code and spec disagree; recorded in the audit, the
app follows the spec). A `divergence` row is not outside parity: before
cutover each one carries an explicit disposition, which is one of a
verified resolution (code or spec corrected, row becomes `approved`), a
recorded owner decision, or a named release blocker. A release blocker is
tracking, not a disposition that releases: the domain does not switch while
any release blocker is unresolved.

### Named rules the matrix cites

The feature matrix cites some rules by shorter names than the headings
above. Each resolves here, so a route reviewer needs no private file:

- **RB-VISIBLE** = RB-TIERS applied to safety: deadlines (reward expiry
  soonest deadline and final warning, grace end, offset deadline, listing
  expiry), held balances with their recovery claim, settlement outcomes
  (debt cleared vs proceeds paid) and the consequence of a race (the cure
  window can close; a backstop opt-in closes it; an accepted sale holds
  settlement) are Tier A or B and stay on the page in Basic. Inbox and
  alerts supplement, never replace. Accounting detail and mechanism are
  Tier C.
- **RB-TIER-OVERRIDE** = the last paragraph of RB-TIERS: Tier A overrides
  every folding and word-budget rule.
- **RB-REFRESH** = the Own rail row of RB-RAILS: signals first, plus a
  bounded safety refresh while the tab is visible (default 60 s,
  rail-health dependent), paused while hidden; per-block refresh for the
  reads that gate an imminent money decision; own confirmed actions
  refresh every open tab at once; a receipt triggers reconciliation and
  carries no balance.
- **RB-PUBLIC** = the last paragraph of RB-RAILS: public chain reads
  without a wallet are allowed where verification or recovery needs them,
  through the bounded read-only proxy or a public endpoint.
- **RB-PRECEDENCE** = the "Specification precedence" paragraph at the top:
  the canonical spec decides behaviour; presentation in the current-app
  documents may change with a stated reason, behavioural and funds-safety
  requirements stand until a recorded owner decision replaces them.
- **RB-FOUNDATIONS** = §3.1 and the first sentence of §3.2: the capability
  service, identity-scoped reads, the eligibility module, transaction
  tracking and the claim model ship before any route, and keeper posture
  comes from the permissionless-steps ledger with "unknown" as the default.
- **RB-PARTIAL-SWAP** — partial swap-to-repay is sized from a simulation of
  the EXACT proposed call (collateral sold, principal repaid, charges,
  remaining debt), never from the full-settlement preview; a figure the
  simulation cannot give is stated unknown; a dedicated partial preview on
  the Diamond is a contract gap to file.

- **RB-RISK-STEP** — a risk-access block the connected wallet can clear
  itself (level too low, illiquid pair consent, strict-mode acknowledgement)
  is cleared in the flow that hit it, never by sending the reader to
  another page. Which step is the protocol's own answer for that flow (the
  accept preview, the create dry run), never a rule the app restates; the
  lender's own block is shown as the lender's. The step is one signed
  transaction through RB-CONFIDENCE (its reach, when it counts, no funds
  moved), a raise names the observed change counter and terms version, a
  waiting period is stated from the chain and the step is never offered
  twice while it runs, and the flow's review reads again afterwards.
- **RB-NFT-APPROVAL** — a flow that pledges an NFT asks the wallet to
  approve that one token, never the collection, and only when the token's
  own approval (or a collection approval the wallet set before) does not
  already let the protocol move it. Which standard a collection follows is
  the contract's own answer (ERC-165); a read that failed says the standard
  is unknown and offers nothing, never a guess. The approval counts only
  when it reads the protocol at the block its receipt mined in. When what it
  was for does not go through, it is put back, but only while it still reads
  the protocol and the wallet still holds the token; anything else is stated,
  never overwritten. The put-back reads the approval no earlier than the
  block the approval mined in (the same holds for an ERC-20 allowance), so a
  node that has not caught up can never pass a skipped reset as done.
  An ERC-1155 token has no approval for one token, only an operator approval
  over the whole collection. A flow that pledges a quantity of one grants it
  for that action alone and takes it back on every ending, the action's
  success included, as its own named wallet step (the review counts it); an
  operator approval the wallet had granted before is left exactly as set.
  The grant counts only when it reads back at its receipt's block, and the
  take-back reads no earlier than that block, so it is never skipped as
  already done. While the action's own receipt is unknown the grant still
  stands, and the page says so beside the transaction. A take-back that did
  not land or could not be read is stated with what to do in the wallet.
- **RB-RANGE** — a ranged offer (OFF-10) is shown at both ends it can be
  taken at, never as one figure: what a direct taker gets (for a borrower's
  request, the smallest amount against the floor collateral, the rest of the
  collateral back to the wallet) and the largest loan a match can make. The
  risk at each end is the protocol's own figure at today's prices; a
  collateral that values to nothing is said so, never shown as 0%. The
  create dry run checks the protocol's limit at the largest end only, so the
  direct end is asked as its own dry run, and an answer that says nothing
  about the limit is stated as unknown. A match locks the collateral its
  lender asks for, not what the request posts: at least the floor for a
  collateral range (so the largest match is stated from all the collateral
  down to only the floor), otherwise only the lender's requirement (so it is
  stated as able to lock less). The collateral a match does not lock stays
  committed to the request for later matches and comes back only when the
  request closes or is cancelled, never per match, and the review says so
  for every request a match can fill. Every request a
  match can fill therefore warns, in Basic, that a matched loan can start
  riskier than the figures shown, bounded only by the protocol's start-of-loan
  limit; the Advanced row for that limit states a failed read rather than
  dropping it. The matching switch (RB-SWITCH class
  1a) is stated beside every range, with what the range does while it is
  off. A fill mode (OFF-11) the protocol would refuse (all or none with a
  range, immediate or cancel without an expiry) is not offered, and the
  fill mode is said to be fixed once posted. The amounts, the rate and the
  collateral are not fixed: the protocol lets the creator edit an open
  request, never below what matches have already used. Until the app offers
  that edit, the review says the protocol allows it and that the app does
  not, so a missing screen is never presented as a protocol rule. They are Advanced
  options; set in Advanced, they still apply in Basic, which says so and
  offers to clear them, and every risk warning they cause stays in Basic.
- **RB-CADENCE** — an interest schedule (OFF-14) is offered only where the
  protocol's own admission rule allows it for the terms typed, asked of the
  protocol (its admission preview runs the rule offer creation enforces) and
  never re-derived by the app. Every closed schedule says why under its
  name: the switch (RB-SWITCH class 1a), an unpriced leg, a loan over a year
  that must pay at least yearly, a principal under the threshold (both
  figures, in the numeraire), or a period not shorter than the loan. While
  that answer is loading or failed, only interest at repayment is offered,
  and a schedule already chosen holds the review until it is known. The
  review states the schedule, each period's interest as the protocol
  expects it (at both ends of a range), the grace a missed period gets
  (today's figure, or a plain "could not be read" when the read failed,
  never a silently missing row), that the amount owed is the whole term's
  interest plus principal with the instalments counting toward it (not a
  sum still due at the end), and, in Basic, that a period not paid by its grace end
  lets anyone sell part of the collateral to pay it, and that the schedule
  is fixed once posted. Who settles a missed period is Advanced detail:
  anyone may, and the keeper pass's arming is the capability service's
  answer (RB-SWITCH class 4, unknown by default). A schedule is an Advanced
  choice; set in Advanced, it still applies in Basic, which says so.
- **RB-TARIFF** — the creator's opt-in to the Full fee tariff on a request
  (OFF-22) is offered only while the protocol's switch is on (RB-SWITCH
  class 1a), and the form states the switch either way. Every figure is the
  protocol's: today's tariff from its own quote, at the smallest and the
  largest loan of a range, never re-derived. The creator sets the most VPFI
  one loan may take (left blank, today's tariff for the largest loan) and
  what a loan that cannot take the tariff does: it is refused, or it opens
  without it. The review states the choice, the switch, the tariff, the
  ceiling, the rule and the vault's free VPFI as the charge reads it, and,
  in Basic, that each loan pays its own non-refundable tariff priced at
  that loan's amount, that the loan fee is still charged in the lending
  asset with ten more points of discount up to the cap, and that the
  opt-in is a second transaction after posting, so a lender who takes the
  request before it confirms opens a loan without the tariff. Each
  condition the reads show failing is stated as what it does to a loan
  under the chosen rule; a choice under which every loan would be refused
  (switch off, unpriced or illiquid lending asset, a ceiling below the
  smallest loan's tariff, with loans not allowed to open without it) blocks
  the review. After posting, the opt-in opens as its own step below the
  request's finish card, bound to the network and wallet that posted the
  request (signing is withheld on any other), kept apart from that card so
  closing it never drops the step, and holding a second posting back while
  it is open. It re-reads the request before the wallet opens (taken, not
  the creator, already set), treats a routing table still loading as
  unreadable rather than refused, and is measured by reading the request
  back. Closing the step leaves its ending in place until dismissed: set,
  not set, skipped (the step sent nothing, so the tariff is off unless set
  some other way), or not known; a re-check that already read the choice on
  the request ends as set. Skipped and not known are read from the chain
  as the step closes, and offer that read again: one rule reads the request
  for the check and the read (another wallet's request, the choice already
  on it even if since taken, taken without it, open without it); a match
  settles the ending as set, anything else is stated with the time it was
  read, since a pending transaction can still land.
  The tariff is an Advanced choice; set there, it still
  applies in Basic, which says so. The backstop for requests nobody takes
  (OFF-26) is stated as not offered (#3181), never as a step.
- **RB-LEND-ACCEPT** — Borrow and Lend take an offer through one shared
  flow (matching list, review, signing, measured outcome) whose role is the
  acceptor's side: a borrower takes a lender offer, a lender funds a borrow
  request. The role decides which leg the wallet pays and so where funds,
  allowance and approval are measured (the collateral for a borrower, the
  lending asset for a lender), which offers are listed (the other side's,
  ERC-20 on both legs, not the reader's own), the order (lowest rate first
  for a borrower, highest for a lender) and the receipt. A lender's receipt
  states what leaves the wallet, what the borrower receives, the borrower's
  initiation fee and the share of it paid back to the sender, the
  collateral held for the lender, the interest owed at the due date, the
  protocol's share of interest at today's rate as an upper bound (fixed when
  the loan opens, lowered by the lender's fee-discount tier while the
  consent is on, and stated as off when it is), and what comes back if
  repaid on the due date. A request that refinances a loan does not pay the
  borrower: the amount less the fee pays the old loan's lender in the same
  transaction, so the list row and the receipt say whose loan it pays and
  never show it as the borrower's proceeds (the protocol's own rule, a
  borrow-side offer naming a target loan, read once). A borrow-side offer linked to a running loan is a
  sale of that loan's lender position, not a request: the list counts it
  apart and the review blocks it, because buying a running loan has its own
  terms and is not this flow. A request is funded whole, at its smallest
  amount and highest rate; matching is a later update. The amount less the
  fee is paid into the borrower's own vault, credited as the borrower's
  funds (RB-PAYOUT-ROUTE), never to the wallet: a borrower's receipt says
  so, and its finish card measures that credit from the protocol's own
  record of it, the fee share paid back to the sender beside it, the two
  plus the rest of the fee adding up to the principal the loan recorded,
  and offers the withdrawal.
- **RB-LEND-POST** — Borrow and Lend post the reader's own offer through
  one shared flow (form, review, signing, measured outcome) whose side is
  the poster's: a borrower posts a request, a lender posts an offer. The
  side decides what posting locks in the poster's vault, and so where the
  balance, the allowance, the approval, the shortfall and the measured
  lock are read: the collateral for a request, the amount lent for an offer
  (the protocol escrows the offer's largest amount when it is posted). A
  lender's offer states one collateral figure that every borrower must
  lock; it is sent as both ends of the protocol's collateral range, as the
  protocol requires of a lender's offer. The lender's receipt states what
  locks now, the amount a borrower takes and the collateral they must lock,
  what the borrower would receive at today's fee and the fee itself (the
  borrower's, never taken from the amount lent), the interest at the due
  date, the protocol's share of it at today's setting as an upper bound
  (stated as unread, never as zero, when it cannot be read, and then no
  figure built on it is shown), what comes back if repaid on the due date,
  every term it binds, the loan-to-value at today's prices, and the
  lender's consequences: the lock while open, the lapse, a taker opening
  the loan at once, a match lending the whole amount at the offer's rate
  against at least the collateral asked (said only while matching is not
  known to be off), default, liquidation, the position token and the
  binding offer. A refusal whose remedy is the borrower's (lock more
  collateral) is never offered to a lender; the protocol's own reason is
  shown instead, except the protocol's collateral floor, whose remedy (ask
  for more collateral, or lend less) is the lender's and is named with the
  least collateral it asks. In Advanced a lender may lend the offer in
  parts (OFF-10): the amount typed stays the whole amount, which posting
  locks and a direct take borrows (the protocol sizes a direct take of a
  lending offer at its largest amount), and the lender adds the smallest
  part one match may lend. The receipt's figures are the whole amount's; it
  states the smallest part, the least collateral that part asks (the
  requirement pro-rated, rounded down, as the protocol does), that matches
  lend parts at the offer's rate while matching is on (the switch said in
  each state), that no borrower can take the rest directly once a match has
  lent a part (cancelling takes it back), and that the rest below the
  smallest part returns to the wallet as the offer closes. One
  loan-to-value is shown, since a part carries the whole amount's ratio.
  The fill mode (OFF-11) is offered on both sides, worded for each, and is
  stated as fixed once posted. The interest schedule (OFF-14) and the Full
  fee tariff (OFF-22) are offered on both sides in Advanced, through the
  same fieldsets and the same reads. A lender's schedule is admitted at the
  smallest part (or the whole amount without parts), the amount the
  protocol checks at posting, so a schedule the whole amount would clear
  stays closed with both figures while the part is under the threshold.
  The receipt states each period's interest on the whole amount and on the
  smallest part, the whole term's interest as a total the instalments count
  toward, and that a missed period sells part of the borrower's collateral
  to pay the lender while the loan stays open. The tariff is quoted in the
  form at the whole amount (a direct take, the largest loan) and in the
  review at both ends; the receipt states what it costs, what it gives the
  lender (10 more points of discount on the protocol's share of interest,
  up to the 50% cap, for the loan's term, lost on an extension, following
  the lender position), the gap before it is set, and each refusal under
  the chosen rule. It is set by its own measured transaction on the Lend
  page after the offer posts, worded for an offer, and a new offer is held
  back while that step is open. An offer that asks for an NFT is a later
  update.
- **RB-POSITIONS-LIST** — Positions lists the loan positions the connected
  wallet holds on its chain, read from the position tokens it holds (the
  same inventory Home reads, through one shared reader, so a transferred
  position leaves the sender's list and Home and Positions never disagree).
  It lists, in this order: payouts confirmed ready to collect (each names
  its loan and side and sends the reader to Claims, which states the
  amounts); live loans (the most urgent deadline first, the loans one offer
  opened grouped, each with its side, terms, due date and the consequence
  of missing it, any interest period, the health factor and an Open
  button); and ended loans (newest first, each with its side, terms and
  status in words: repaid, defaulted, settled, or closed by a match; a
  status the app does not know is shown by its number, never guessed),
  which point at Claims while a payout on them waits. A side choice (all,
  lent, borrowed) narrows all three lists at once. "Nothing" is said only
  when every walk completed and the latest read succeeded; a list that
  could not be read in full says so. Every row opens its position, where
  the protocol's verdict decides which actions are open (RB-ELIG): the list
  signs nothing and offers no action of its own.
- **RB-POSITION-VIEW** — a loan's own page states, in this order: its
  status in words (an adverse one, fallback or default, as a warning; an
  internal match as closed, with each side collecting on Claims); the
  reader's role, from the position tokens their wallet holds now (both
  holders read; "confirming your role" until they are, and a reader who
  holds neither is told they are viewing); the deadline that needs them,
  worded for the side they hold, with "can now be defaulted" and "anyone
  may now start the default" only when the protocol says the loan is
  defaultable, never "will be", and that verdict is every gate of the
  default a read can answer (the timing, the global pause, the sequencer
  and the lender admission), so the gate that refuses is stated as the
  reason the default cannot start (a grace end passed by the
  clock alone is
  stated as passed, with the protocol's verdict unread or not yet given;
  a list, which does not read the verdict, sends the reader to the loan's
  page);
  the dates from the protocol's loan clock alone (the current term's due
  date before pause credit, labelled as that term's and never as the
  opening one, since an extension or a borrower handover rewrites the
  term; the pause credit, the due date and the grace end; an unread date
  is unknown, never computed from the start and the term), and, for a
  loan with an interest schedule where periodic settlement is switched
  off, that no collateral is sold at a checkpoint; the terms as they stand
  now, said to be so (the protocol keeps no record of the amount first
  lent, and a partial repayment lowers the principal, collateral moves and
  a borrower handover can change the rate, so the principal is "still
  owed" on a live loan and "when it ended" on an ended one; an ended loan
  with no principal on its record says an internal match covered it when
  its status says so, and otherwise only that none is recorded, never
  calling it a write-off it cannot establish; never "you lent"; the
  protocol's share and the initiation fee rate as the loan's own
  snapshots, none for a loan that carries a lender sale, and a share
  recorded as 0 as the fixed legacy rate settlement charges for a loan
  that opened without one, never as 0%; an NFT rental's
  rent per day in its prepayment asset and whether returning early still
  charges every remaining day);
  its health (a failed reading is unknown; a loan with an unpriced leg,
  whose health and loan-to-value reads the protocol refuses, is "no
  price-based reading", never 0 and never unknown, while a successful
  reading of 0 on a priced loan is shown as 0; the liquidation
  threshold is the loan's stored
  snapshot, and the network's internal-match band above it, read from the
  protocol, in which no outside sale can close the loan, or that matching
  is off or holds no band; an initiation fee rate recorded as 0 is "not
  recorded", never 0%); where its collateral is held (the protocol's lien: held in
  the borrower's vault, on an ended loan until its claim is collected,
  released (checked before a zero amount, since a release zeroes it), or
  none, with an ERC-1155 lien's quantity); and, for a loan whose
  collateral has no price, that a default hands the lender the collateral
  itself, while an NFT rental, which has no collateral, states its own
  default instead (the renter's use ends, the prepaid rent goes to the
  lender less the protocol's share, the buffer to the treasury).
  The loan's actions follow the "now" lines, each offered from its
  eligibility rule; the actions still to come are said to be coming.
- **RB-POSITION-REPAY** — repaying a loan in full (LN-21, LN-16) is offered
  to anyone but the lender (recorded, or holding the lender position), and
  is left out for a reader who holds only the lender side. Its one rule
  (RB-ELIG) holds it on a running loan past its grace end (stated with the
  time, and that the loan goes to default), while a swap-to-repay order is
  pending on the borrower position, and for a rental (the app's own limit,
  said so); it never holds for a lender listing, a refinance request, the
  protocol pause, the Terms gate or the sanctions screen on the payer, and
  a loan in fallback stays repayable past grace, since repaying cures it.
  The hold LN-21 names while an ACCEPTED lender sale completes has no window
  on this protocol: the sale completes inside the transaction that accepts
  it, so the verdict reads nothing for it. A refinance request that still
  stands by the protocol's own rule is named on the review: the repayment
  ends it, but its offer stays posted until its creator cancels it. A
  recorded one that no longer stands (cancelled, taken, expired) is not
  named, since the record keeps the last id after a cancel, and an unread
  request is stated unread. The protocol's full repayment takes a plain approval; it has no
  Permit2 route, so none is offered.
  The review states two of the protocol's own payoff figures, now and as of
  a moment about thirty minutes ahead (never later than the grace end),
  the second read by asking the same view with the block time moved, on a
  connection that is checked to have honoured the move (one that ignored it
  is passed over, and if none honours it the repayment is not offered). The
  approval is exactly the later figure, LOWERED to it as well as raised:
  the protocol's full repayment takes no maximum or deadline of its own, so
  the allowance is the only cap on what a late confirmation can take, and a
  larger standing approval (an unlimited one included, named as unlimited)
  would void the stated maximum. The approval caps the AMOUNT, never the
  time, and the review says so: a repayment confirming after that moment
  goes through only while the protocol's figure stays within the approval.
  Where the two figures are equal (full-term interest before the due date)
  the review also says a later confirmation can still go through; it never
  promises a deadline the protocol does not enforce. Where that moment is
  the grace end, it is stated as the grace end as things stand, which a
  protocol pause before it moves later (the protocol checks the moving
  deadline, not the time the review read). It says that what
  the repayment does not use is put back afterwards, to the allowance as it
  stood before. The collateral is named by its asset type (an NFT by its
  token id, an ERC-1155 with its quantity), through the same rule as the
  loan page. A payer who does not hold the borrower position is told it
  gains no right to the collateral. A re-read does not count the payoff
  growing by the second as a change; the figure at the kept moment, the
  holders, the dates, the standing allowance (what a stop puts back) or its
  approval steps, or the verdict moving reopens the review, also when it
  moves between the review and the send, and the kept moment moves forward
  once it is closer than ten minutes. The finish card measures, from the
  transaction's own logs, the status its repayment left the loan in (not
  the status at the block, which both sides claiming later in that block
  moves on to settled), what left the wallet (within the two stated
  figures), and the approval put back.
- **RB-POSITION-SCHEDULE** — a running ERC-20 loan with an interest
  schedule (LN-24) shows its current period from the protocol's settlement
  preview alone: the schedule, the period's end and grace end (the loan's
  pause credit included), the interest for the whole period at the
  principal and rate as they stand now, what has been paid toward it and
  what is still owed, and whether the period can be settled now. The
  preview's "callable now" does not account for the deployment's
  periodic-settlement switch or the protocol pause, so the page reads both
  beside it and states the result in the order the settlement itself
  refuses: switched off (that sentence replaces any warning of a sale:
  nothing can be settled and no collateral is sold), paused (named; no
  sale is announced, and the paused time moves the period's dates), then
  the period's own time. A sale is announced only while the switch is on
  and the protocol is not paused; an unread switch, pause, period or chain
  time is stated as unknown, never assumed. A paid period is said to only
  move the checkpoint forward. The page states how the borrower pays a
  period (by partial repayment where the loan allows it, otherwise only by
  full repayment or by the sale), that a pause moves the period's dates
  later while the interest a period owes stays one period's worth (interest
  keeps accruing through the pause, and any interest a repayment pays counts
  toward the period), that settling is open to anyone and the keeper's posture is
  not known (the capability service does not yet report it), and the chain
  time the period is placed against. When the period itself cannot be
  read, the switch and the pause are still stated as read, so a switch that
  is off is disclosed even with the period's figures unknown. Every read on
  the loan page is pinned
  to the one block whose time is stated, so the loan's status, the preview
  and the chain time describe the same moment; the preview's "callable now"
  is then the last word, and a period past its grace that it does not call
  settleable belongs to a loan that is not running, stated as such and never
  as a sale. The card is read-only; paying a period and settling one come
  with their own actions.
- **RB-POSITION-PARTIAL** — paying part of a loan (LN-22, LN-64) is
  offered to the borrower position's holder alone, since the protocol takes
  a partial repayment from that holder only. Its one rule (RB-ELIG) reads
  the protocol's checks in the protocol's order: a loan in fallback (only a
  full repayment, which cures it), a loan that is not running, a rental
  (the app's own limit, said so), a wallet that is not the holder, terms
  that do not allow it (fixed when the loan opened), past the grace end, a
  pending swap-to-repay order and a live refinance request; it also holds
  while an offset offer on the borrower position is live, since that offer
  was made for the loan as it stands (the app's own rule, said so). It
  never holds for the protocol pause or a lender listing. On the loan page
  only the reasons that close paying part but not repaying in full are
  stated for it, so a shared reason is said once. The principal part is
  checked as it is typed against the protocol's own bounds: more than
  nothing, at least the protocol's minimum part for the lending asset (an
  unread minimum is stated, and the amount is not taken), and less than
  the whole principal, which is sent to Repay in full. The payment adds the
  interest accrued since the loan's interest was last paid, and no protocol
  view gives that figure ahead of the call (#3299), so the review states it
  from the protocol's payoff figure less the principal: as an amount only
  where that is exactly a part payment's interest (a pro-rata loan, at or
  before its due date), and otherwise as "at most", with the reason (a
  full-term loan's remaining term, or a late fee past the due date, which
  a part payment does not charge). The approval is exactly the part plus
  the interest at most by the kept moment, lowered to it as well as raised,
  and it caps the amount, never the time: the approval row and the
  late-confirmation sentences are ONE rule shared with RB-POSITION-REPAY
  (`repayPartial` takes no maximum or deadline either), never a second
  copy. What the payment does not use is put back. The review also states the
  principal left, that the due date does not move, that the lender
  position's holder is paid with the treasury taking its share of the
  interest, and who receives it is settled only at confirmation (earlier
  holders still owed interest from before a sale are paid from it first,
  and a holder the protocol must freeze has the share locked in the
  lender's vault), that a full-term loan then counts the rest of its
  term on the lower principal, and that the interest counts toward the
  current interest period. The reader can go back and change the amount
  from the review. The finish card measures the principal the payment left,
  from its own log (not the loan at the block, which a later transaction
  there can move on), against the principal less the part; the standing
  allowance moving reopens the review, as for a full repayment; and the
  card measures what left the wallet (at
  least the part, at most the stated upper total), where the interest
  period stands afterwards, and the approval put back. The two repayment
  flows never run at once.
- **RB-POSITION-ADD-COLLATERAL** — adding collateral to a loan (LN-31) is
  the borrower position holder's alone, so the action is offered to that
  holder only. Its one rule (RB-ELIG) reads the inputs `addCollateral`
  checks, in its order: a pending swap-to-repay order on the borrower
  position, the holder, a loan that is neither running nor in fallback, a
  rental (no collateral leg), a collateral token governance has paused, and
  collateral the protocol does not price now. Both token checks are read
  live, not from the loan's recorded class at opening. It never holds for
  the protocol pause (a borrower can always lower their risk), a lender's
  listing, a refinance request or an offset, and the page states only the
  refusals no repayment shares (the token paused or unpriced). The amount
  is more of the loan's own collateral token, more than nothing and within
  the wallet's balance, checked as it is typed. The review states the
  collateral before and after, where it is held, the health factor and
  loan-to-value now, the approval, and every consequence. Where it is held
  follows the protocol: the top-up lands in the vault of the borrower the
  loan records, which for a running loan is the holder's own (the position
  is consolidated first), but for a loan in fallback whose position changed
  hands is the recorded borrower's, named, until the top-up cures it. The
  consequences, always shown: added collateral can be lost with the rest to
  a liquidation or default; no view gives the figures a top-up leads to, so
  the finish card states the protocol's own; added collateral can be
  taken back only within the protocol's limits while the loan runs; a loan
  in fallback returns to running only if the top-up restores its opening
  limits; and the pause posture, stated in every case (open, paused and
  still open, or unread). The top-up pulls exactly the amount, so a standing
  approval that covers it is left as it is and a smaller one is raised to
  exactly the amount, put back if the top-up does not go through. A re-read
  reopens the review when a stated loan field, the holder or lock, the
  pause, the allowance, the balance check or the verdict moves; the health
  factor and loan-to-value move with prices and are restated without
  reopening it. The finish card measures, from the transaction's own logs,
  the collateral the top-up left, the protocol's health factor and
  loan-to-value after, the cure of a loan in fallback, and what left the
  wallet.
- **RB-POSITION-TAKE-BACK** — taking back collateral from a loan (LN-32) is
  the borrower position holder's alone, so the action is offered to that
  holder only. Its one rule (RB-ELIG) reads the inputs
  `partialWithdrawCollateral` checks, in its order: the protocol pause, a
  pending swap-to-repay order on the borrower position, a standing refinance
  request, the holder, a loan that is not running (one in fallback
  included), a rental, collateral the protocol does not price now, and the
  protocol's own most that can be taken back now being zero. A lender's
  linked sale listing also holds it; no view exposes that link (#3308), so
  the review's dry run of this very withdrawal names it, and the send runs
  the dry run again. The page states a closed reason only where no action
  above already said it, and a hold said once for two actions (an unpriced
  token with the top-up, a refinance request with paying part) is said in
  words that name both. The amount is more than nothing and at most the
  protocol's limit now (`calculateMaxWithdrawable`), checked as it is typed;
  the form says the limit moves with prices and as interest accrues, and
  offers no "use the most" shortcut, since an amount at the limit is
  refused once a second of interest accrues. No approval is asked: the
  collateral goes from the borrower's vault to the wallet that asks, in one
  prompt. A wallet running protected account mode has it queued for the
  account's delay instead, stated by the one payout rule every flow paying
  the wallet shares (RB-PAYOUT-ROUTE below), and, while the account requires
  it, released only once a secondary signer approves, which the protocol
  checks at release. The withdrawal is always the holder's own: it first
  moves a bought position's collateral into the holder's vault, and every
  state that skips that move is one the rule or the dry run refuses. The
  review states that route, or that
  the mode could not be read, and the finish card measures where the
  collateral went and, when queued, from when it can be released. The review states the collateral before and after, where it goes,
  the limit, the health factor and loan-to-value now, and every
  consequence: the loan moves closer to liquidation; the protocol checks its
  limits again at confirmation, so a price move first refuses it with
  nothing moved; a pause before then does the same; and the finish card
  states the protocol's own figures after. A re-read reopens the review
  when a stated loan field, the holder or lock, the pause, the refinance
  request, the payout route or the verdict moves; the limit, health factor and loan-to-value
  move with prices and are restated, and a limit that falls below the
  amount blocks the review rather than reopening it. The finish card
  measures, from the transaction's own logs, the collateral the withdrawal
  left, the protocol's health factor and loan-to-value after, and what
  arrived in the wallet, was queued for it, or was paid into the vault.
- **RB-PAYOUT-ROUTE** — every flow that pays the wallet (taking back
  collateral, collecting a claim) states where protected account mode sends
  the payment with one rule and one set of words, so two flows cannot
  describe the same queue differently. The route depends on whose vault pays
  and on the receiving wallet's mode: a wallet without the mode is paid at
  once; a payment from the account's own vault is queued for its delay, or
  kept in the vault while the account is locked; a payment from anyone else's
  vault is paid into the account's vault. A queued payment that needs a
  secondary signer's approval to be released says so before signing and on
  the finish card. A payment queued for an account a replacement retired is
  released to the wallet that now manages it, so the review and the finish
  card name that wallet, never the old one. A mode that could not be read is
  stated as unknown, never as the wallet route. A change to the route, or to
  a queued payment's delay, signer requirement or release wallet, reopens the
  review. Some payments never reach a wallet at all: the protocol credits a
  loan claim to the current position holder's vault, and a new loan's net
  principal to the borrower's vault, as that owner's own free funds, whatever
  its mode. Such a flow names the vault as the destination and the mode as
  delaying only the later withdrawal, measures the credit from the
  protocol's own record of a movement into the reader's vault (one that
  stayed in the reader's own vault included, never one into another vault,
  for another loan, or of a class the protocol does not credit), states a
  credit to a vault it could not read as unmeasured, and offers the
  withdrawal on the finish card.
- **RB-POSITION-CLAIM** — collecting a loan payout (LN-48, LN-49, LN-50)
  is one flow under RB-CLAIM, opened from the loan's page and from Claims.
  Each side is decided by its own rule (RB-ELIG), read against that side's
  position holder, never the reader's overall role, in the order
  `claimAsLender` / `claimAsBorrower` checks: the protocol pause, a loan
  whose status pays no claim on that side (a running loan; a settled one; a
  loan in fallback, which pays the borrower only after the lender has
  collected or the loan is cured), a side already collected or with nothing
  recorded, and the holder. On the loan's page the borrower's payout stays
  shown while it waits on a loan in fallback, with that reason, so its
  holder is never left with no payout section and no explanation. The review names every payout the claim makes
  on that side: the lender's recorded row and funds held for the lender
  before the loan ended, a rented NFT back to its lender, the borrower's
  collateral row, collateral the borrower added in another token, and a
  surplus held for the borrower. A row recorded at zero says so, and that
  collecting still closes the position. It states where the payout goes by
  RB-PAYOUT-ROUTE (credited to the holder's own vault, whatever its mode;
  a matching reward a claim-time match pays goes to the wallet, or where
  protected mode routes it), what past sellers of the
  lender position take first (stated as unknown, with what it may take, when
  it could not be read), that collecting burns the position token,
  that collecting in fallback ends the fallback and the borrower's cure, and
  the pause posture. The protocol's dry run of this very claim is part of
  the review, and the send runs it again. The finish card measures, from
  the transaction's own logs, the claim recorded, what the protocol paid
  from the row against what was reviewed, each payout that arrived, was
  queued, kept or credited to a vault (each destination stated, since one
  payment can split between the queue and the vault), an NFT's arrival, and
  the loan's settlement once both sides have collected. A lender claim on a
  loan in fallback runs the protocol's match first with the claimant as its
  matcher. A match rewrites the payout in places the protocol records only
  in part (a full match the row, a partial one the funds held for the
  lender), so when the logs show one the card says the match changed the
  payout and states what each token delivered instead of comparing it with
  the review (a reviewed token that delivered nothing is still flagged), and
  states the matcher's reward each leg paid, in that leg's loan's principal
  token, the collateral token's included. A claim the review
  could not read is stated as unknown, never as zero. A claim flow in progress
  stays on Claims, drawn from the app's record of it, after its position
  token is burnt and the reader leaves and returns, until its finish card is
  closed. Claims lists the payouts of
  the positions the wallet holds now, so a bought position pays its new
  holder, and says "nothing to collect" only when every read completed;
  seller interest is RB-SELLER-CLAIM, an unused extension reserve is
  RB-RESERVE, and a payout frozen for a flagged wallet is RB-FROZEN.
- **RB-PAYOUT-QUEUE** — Claims lists a protected account's payout queue
  (LN-54, LN-55, LN-56): the wallet's own account, then an account it
  manages since a replacement retired it, and in Advanced mode any account
  looked up by address, for a secondary signer. Rows come in the order they
  fall due by the chain's clock, never the browser's. Each row leads with its
  request code exactly as the chain derives it and every alert prints it
  (`@vaipakam/lib/requestCode`), and states what it pays, its destination
  (the reader's wallet, the account's wallet, or an allowlisted address),
  when it can be released, and, where the account requires it, whether a
  signer has approved it. A row or list that could not be read is said so,
  never shown as empty. Each action has one rule (RB-ELIG) read in the order
  the contract checks it. Release is anyone's: held by a pause until the
  pause ends or its escape route opens; open at once for a row whose
  destination is no longer allowed, which the review and the button state
  cancels it instead of paying; otherwise only once due, the account
  unlocked, and approved where required. Cancel belongs to the account's
  manager wallet or a secondary signer and works during a pause. Approve
  belongs to a signer, only where the account requires approval and the row
  is not yet approved. Each runs through one flow (review, the protocol's
  dry run, one wallet prompt) and its finish card is measured from the
  transaction's logs: the release paid, with the protocol's measured
  delivery stated beside a short one; a cancel instead of a payment, stated
  as such; the cancel; the approval. The account's delay and approval rule,
  the keeper service's arming for releases (the capability service's
  answer, unknown by default) and the pause posture are stated above the
  rows. An action in progress stays on screen until its finish card is
  closed: after its row leaves the queue, after the lookup that found the
  account is cleared, and when that account's queue cannot be read. The
  sync stamp covers every queue the section shows, a looked-up one
  included.
- **RB-SELLER-CLAIM** — the interest a past seller of a lender position
  earned and was not paid (LN-52) is collected from Claims, in its own
  section. The loans come from the index (any step of a seller claim filed
  under the wallet); when the index cannot list them the section says so,
  never shows an empty list, and offers a lookup by loan number that reads
  the chain alone. A later poll that fails is said too: the last list stays,
  named as the last list, and "nothing owed" is withdrawn until the index
  answers again. Each loan is read from the chain as the withdrawal reads
  it, and only the chain decides: what the wallet is owed, stated net of the
  loan's own fee on interest (the legacy share said as such where the loan
  recorded none), what already waits in the wallet's vault, and on an ended
  loan the split. The withdrawal has one rule (RB-ELIG) in the order
  `claimAsSeller` checks it: the pause, then something to pay. On a running
  loan it pays what reached the vault, and with nothing there it says the
  claim is paid from later interest, oldest claim first, and offers no
  button; a loan in fallback waits. On an ended loan the withdrawal first
  splits what the lender side recovered (the holder's principal, then each
  claim oldest first, net of the fee), which closes every open seller claim
  on the loan: in the principal token the review states the wallet's part
  exactly and what stays unpaid, and in another token it states that the
  split pays by value when it runs. The protocol's dry run is part of the
  review and the send runs it again. The payment goes from the wallet's own
  vault to its wallet, so it follows RB-PAYOUT-ROUTE. The finish card
  measures, from the transaction's logs, each claim the split closed (paid
  in full, or short with what stays unpaid, and a figure other than the
  reviewed one said beside it) and each payment where it landed. A row that
  could not be read is said so, and a withdrawal in progress stays on screen
  until its finish card is closed, whatever the latest list or lookup shows.
- **RB-RESERVE** — an extension reserve (LN-62) is the depositor's own
  money, set aside in their own vault for a loan's extensions, and Claims
  lists every loan where this wallet has some left: found from the index's
  activity filed under the wallet (funded, charged, withdrawn), or looked
  up by loan number from the chain alone, never shown as empty while the
  index fails. Each row states the reserve and whether an extension can
  still draw on it: only on a running ERC-20 loan with no interest cadence,
  and only while this wallet holds the borrower position, since an
  extension charges the current holder's vault; with the holder unread on a
  running loan, it is said unknown, never safe. The whole reserve is taken
  back in one withdrawal, open whatever the loan's state and whoever holds
  the position, held by the protocol pause (it is one of the withdrawals a
  pause stops, as the protocol enforces) and refused for a flagged wallet
  (RB-FROZEN; an outage is the dry run's). The review says a running
  extension then loses the reserve, the dry run decides the rest (a wallet
  that no longer manages the account is told so), and the finish card
  measures where the money landed (RB-PAYOUT-ROUTE) and what stays
  reserved if more was set aside meanwhile.
- **RB-CLAIM-ALL** — Claim everything (LN-51) leads Claims and carries
  RB-CLAIM's inclusion list, read from the chain: each loan side the
  wallet holds whose claim the loan's own rule opens and that pays
  something; interaction rewards when the claim, run as its preview,
  completes, even paying nothing, since such a claim walks days that paid
  nothing to reach later paying ones (that claim also pays any held
  reward), or else a held reward
  the screen releases; the un-lent capital of each standing offer the wallet
  owns; free VPFI in its vault; and each payroll stream paying it (paid
  into a protected payee's vault, as any payment from outside its own
  vault). A lender
  claim on a loan in fallback is named as collected on its own, since that
  claim settles the fallback first and only then decides what it pays; a
  source or a loan that could not be read is named as left out, never
  dropped, and the other sources are still read and offered (the position
  book failing leaves out the loans only). Every payout has a switch; all are on except free vault VPFI
  and the capital of a standing offer that lends VPFI (both count toward the
  fee-discount tier, which the review says when either is sent; an offer's
  capital is also kept off, and said, while the VPFI token cannot be read)
  and the
  capital of a standing offer still lending (taking it out leaves the offer
  less to lend), which the reader turns on. A held reward the screen
  releases is offered even when the rewards preview cannot be read. The pause and a flagged wallet stop the whole batch before
  signing, said once; anything else is the protocol's call, payout by
  payout: the batch entry runs each payout as its own call with the wallet
  as caller and each allowed to fail, so the review's dry run of the batch
  answers for each one, a refused payout is left out of the transaction
  with the protocol's reason, and one refused when the transaction runs is
  skipped, moves nothing and stays listed. Because a call allowed to fail
  never reverts the batch, its gas limit is sized on the same calls each
  required to succeed, so no payout is skipped only for want of gas. One
  transaction carries at most
  the protocol's bound (30 calls); the rest wait for a second one, said in
  the list and the review. The review states where each payout lands, one
  row per destination when they differ, a queued one with its delay. A
  queued payout's delay or secondary signer
  changing while the review is open is a changed review. The finish card
  reports each payout collected or
  skipped from its own record in the logs, each NFT (collection and token
  id, summed across the payouts that paid it) where its routing records or
  transfer put it, each place with its own quantity, and each token measured where it
  landed (RB-PAYOUT-ROUTE) against what the collected payouts recorded,
  summed across them; a rewards claim that leaves more says so, and the
  rest is listed again, and when that cannot be read after the claim the
  card says it is not known rather than implying nothing is left. A payroll
  figure is a floor (the withdrawal pays all accrued when it runs), stated
  as such; its rise while the review is open is not a change to confirm, a
  fall is.
- **RB-VAULT** — the Vault page (ACC-20, ACC-21, ACC-24) shows the wallet's
  own vault on its chain: its full address with an explorer link, and that
  it is a contract kept for this wallet alone, nothing pooled, leaving only
  by the protocol's rules. With no vault yet the page says so and offers to
  create one (a deposit or a first offer would too); the review says nothing
  moves and no approval is asked, the protocol's dry run decides (a flagged
  wallet is refused before it, since the protocol creates no vault for one),
  and the finish card names the vault the transaction's record gives, or
  that it names none. Each asset row carries the protocol's figures at one
  block, never one worked out by the app: what the protocol counts as the
  wallet's there (the smaller of the vault's balance and the protocol's
  record, so a plain transfer never raises it), what may be withdrawn now
  (the protocol's own answer after every position and queued payout), and
  the rest as held by the wallet's positions; a vault holding less than the
  protocol counts shows both, a row whose figures could not all be read says
  so and shows none as free or held, and a fully held row says so. A part
  that reached the vault outside the protocol is stated as uncounted and not
  withdrawable until adopted, with the route to adopt or disown it. Assets
  come from the deposit record's list (paged to its stated length; an empty
  page before it, or the page cap, is said incomplete) and from the wallet's
  own records (every loan it was ever a party to or holds a position in and every offer it ever
  created, each read from its own record, a rental's prepaid fee token included, since an offer's
  escrow stays in its creator's vault whoever holds its position; and the lent asset of every
  standing offer it owns, a cancelled one included, since funding one adds nothing to the deposit
  record), always from a list kept by the wallet that made the record; the page
  says that a plainly transferred asset shows only if one of those names it,
  says when either source was incomplete or failed, names every deposited
  NFT collection, since only a token a loan or offer names can be listed
  with figures (the record keeps no token ids). Empty rows and dust (below
  1e-11 of a whole token, never one with an uncounted part or a vault short
  of the count) are hidden behind a switch that counts them. VPFI in the
  vault is named as setting the fee-discount tier, holding it for that pledging nothing (VPFI
  pledged to a loan or offer shows as held), with a
  link to Rewards. Withdraw is the next slice; until then the page links the
  current app for it.
- **RB-VAULT-DEPOSIT** — a deposit into the wallet's own vault (ACC-22) is
  one asset, chosen from the suggested tokens and test collections or
  pasted, its standard the contract's own answer, then the amount, the NFT's
  token id, or the token id and quantity. An unaccepted Terms version is
  accepted first, and the Terms are read again as the last check before
  signing: a switch to a wallet that has not accepted them, or a version
  published while the form is open, sends the deposit back through the gate
  (a transaction already under way is left to finish). The review is read at
  one block: the wallet's vault (or that the deposit creates it), the
  protocol pause, the sanctions screen, whether a replacement retired the
  wallet, the account's protected mode, and the wallet's holding and
  approval. The receipt states how the deposit can leave again: to the
  wallet at once without protected mode, after the account's delay (and a
  secondary signer, where the account requires one) with it, not at all
  while the account is locked (the protocol still takes the deposit), and
  that it is unknown when the mode was not read; a change to any of these
  while the review is open is a change. A pause, a flagged wallet, a retired wallet or a shortfall stops
  it by name, and an unread pause or screen is stated and left to the
  protocol's dry run. The approval is exactly what the deposit takes (an
  ERC-20 amount, one ERC-721 token, or an ERC-1155 collection granted for
  this deposit and taken back after it unless the wallet had granted it),
  the dry run runs with it in place (so a token that does not arrive in full
  is refused before the deposit is sent), and an approval the flow made is
  put back when the deposit does not go through. The receipt states that no
  token-safety screening runs. The finish card states what the protocol's
  own deposit record credited and what the token's own logs moved into the
  vault. While the protocol is paused the panel says so, with what stays
  open, and offers no deposit. The form's balance check is read again each
  block, so a balance that grows lifts its refusal by itself.
- **RB-VAULT-WITHDRAW** — a withdrawal from the wallet's own vault (ACC-23)
  takes what is free back to the connected wallet, and only to it: the
  protocol would pay any screened address for an account without protected
  mode, and the app offers none, so the receipt says the destination is the
  wallet that signs. It opens from an asset row with something free, or, for
  an NFT collection the deposit record names without token ids, from that
  collection with the token id typed. The form's limit is the protocol's own
  `withdrawableNow` figure for that asset and token, read again each block.
  The review is read at one block: the vault, the pause and whether the
  escape route is open under it, the sanctions screen, the account's
  protected mode (retired, on, locked, delay, secondary signer) and the free
  figure, then the protocol's dry run of this very withdrawal. No vault, a
  retired wallet, a flagged wallet, a pause that applies (every pause, except
  for a protected account once the escape route opens), a locked account, an
  amount above the free figure, or the dry run's refusal stops it by name;
  an unread pause, screen, free figure or dry run is stated. The receipt
  names the vault it leaves, where it goes (this wallet at once, or the
  account's payout queue for its delay, with a secondary signer's approval
  where required), the free figure before and after, that only what is free
  moves, that a queued withdrawal can be cancelled from the payout queue on
  the Claims page, and that no approval is asked. The finish card states the
  protocol's own withdrawal record (and whether it queued it), the queued
  payout with its release time, and what the token's own logs moved from the
  vault to the wallet.
- **RB-VAULT-SAFETY** — the Vault page's safety card (ACC-36 Basic face,
  ACC-37, ACC-43) reads the account's protected mode at one block, with the
  protocol's delay bounds, the pause, the sanctions screen and the queued
  payout count, on its own reads: it never waits on holdings discovery, so a
  failed holdings scan cannot hide Lock now. A Diamond without the feature reads "unavailable", never
  "off"; an unread mode offers no control and says not to assume it is off;
  a wallet a replacement retired names the wallet that manages the account
  and offers nothing. Off, it offers Turn on: in Basic the shortest delay the
  protocol allows and NFT protection off, both stated; in Advanced the delay
  in whole days inside the bounds and NFT protection. On, it states the
  delay, co-sign, NFT protection, queued count, lock (since when, by whom)
  and every pending change with its time, and offers Lock now (unlocked),
  Ask to unlock (locked, none asked) and Apply due changes (anything due).
  Each receipt states what the mode becomes and every consequence: turning
  on never delays what is owed to others, credits other vaults' payments
  into the vault, cancels any pending vault-code change and raises the wait
  on a future one (said, not read); a lock cancels every queued payout (counted), drops every
  pending setting change (counted) and voids every pending destination,
  signer and vault-code change (said, not counted), cancels a replacement
  this wallet proposed while one its signers proposed survives (said, not
  read), leaves repayment and
  adding collateral open and works during a pause; an unlock waits the
  delay; applying due changes applies every due change together, a shorter
  delay is always shown as the delay it sets beside the current one, and a
  switch-off waits for an empty queue and clears destinations, signers,
  their pending additions and any pending replacement. Every consequence is
  taken from the facet's own code path for that call, whole, not from one
  finding at a time. Each action is dry-run at review and again before the wallet
  opens, and the finish card reads the Diamond's own events for this
  account. The account's own payout queue (RB-CLAIM: the Claims component)
  is shown under the card.
- **RB-VAULT-ESCAPE** — while the protocol is paused, the Vault page
  states it at the top (ACC-30, ACC-31): withdrawals are closed, full and
  partial repayment and adding collateral stay open, and, under an
  administrative pause, when its escape route opens, from the protocol's own
  `escapeOpensAt` against the chain's clock, never a hard-coded period. A
  pause that schedules no route (automatic, or a protocol not yet launched)
  is said to schedule none. Once the route is open, the Withdraw button
  routes a wallet without protected mode through `escapeWithdraw`, and the
  receipt says the asset goes straight to this wallet through the escape
  route and that the route never returns what a loan, offer or claim holds;
  a protected account keeps the ordinary withdrawal, which keeps queueing.
  If the pause, the route or, under an open route, the mode is unread, no
  entry point is chosen and nothing is sent. The finish card reads
  `EscapeWithdrawal` and the token's own transfer to the wallet.
- **RB-OFFERS-MINE** — the Offers page (OFF-46) lists every offer the
  connected wallet created, from the protocol's own per-creator index
  (which keeps a cancelled id), together with every offer whose position
  token it holds now, read in one bulk call with the protocol's own state
  for each, newest first. Filters by state (open, filled, sold, expired,
  cancelled, all) carry each one's count. A request whose collateral sold
  through its parallel listing before any accept opened no loan, so it is
  "sold" with its own note, never counted or described as filled; a list that could not be read to its end says so, and
  nothing missing is reported as none. Each row is matched to the id it was
  asked for, never to the id the view reports: an offer cancelled with
  nothing filled has its record cleared, so the row says the protocol
  cleared its terms and shows only its number and state, never rebuilt
  terms. An offer held by one wallet but created by another says who may
  cancel it and where its return goes. The offer line is one shared helper,
  the same as Home's open offers. Each row opens the offer's own page
  (RB-OFFER-PAGE).
- **RB-OFFER-GATE** — no part of the offer book is read before a wallet
  connects (owner decision 2026-11-09): not the book on Offers, not an
  offer's page, and not the offers or requests Borrow and Lend list for a
  pair; the pair picker shows only once a wallet is connected on a served
  network. Until then each of those pages says to connect a wallet, and a
  wallet on a network the app does not serve is told to switch, with
  nothing read for it on another network.
- **RB-OFFER-BOOK** — the offer book (OFF-39, OFF-40, OFF-43) is on the
  Offers page below the wallet's own offers and is read once a wallet is
  connected (RB-OFFER-GATE): every open offer the index files on the
  screen's network, newest first, a page at a time ("Show older offers"),
  in two tabs (loans of a token, NFT rentals), with a side filter and a
  switch that hides the wallet's own offers. The filters apply to what has been
  read so far, and the count line says how many that is and whether older
  offers remain. The index only names candidates: no row carries an action,
  and each opens the offer's page, which reads the chain. A lapsed offer the
  index still files as open is tagged expired, with anyone allowed to clean
  it up; a refinance request, a loan sale, an offset and an offer whose
  bound position moved are tagged by kind, and a request the index has not
  read as refinance or not says it may be one. A borrower request's
  collateral reads as its range when it has one, and as "at least" its
  floor when the index has not read the ceiling, never as the floor alone;
  an ERC-1155 leg, rented or pledged, states its unit count.
  A row the index returned in
  a shape the app cannot read is counted as unread, never dropped silently;
  a failed read is a degraded-source warning ("nothing here means no
  offers"), and a failed re-read behind a list already shown says the list
  may be out of date. The book refreshes on the index's push signal and on
  a bounded interval while visible (RB-REFRESH). Advanced sorting and the
  remaining filters (asset, duration, amount, liquidity) are later work.
- **RB-OFFER-PAGE** — an offer's page (`/offers/:id`, OFF-41, OFF-45) reads
  it from the chain at one block once a wallet is connected (RB-OFFER-GATE): the stored
  terms, the protocol's state, and the running loan a loan-sale or offset
  offer is tied to. The protocol keeps no count of offers and clears the
  terms of an offer cancelled with nothing filled, so an id with no stored
  terms says exactly that: cancelled, or never posted, and the protocol does
  not say which. The page states the side, the creator, the amount (a range
  when it has one), what is already filled, the collateral asked for or
  pledged (a request's range when it has one, and what of it is already
  committed to loans), the term and when the offer lapses, and what a refinance
  request, loan sale or offset would do. What the reader may do follows
  from that read: take an open loan offer of a token against token
  collateral whole, through the same acceptance flow and Terms gate as
  Borrow and Lend (OFF-50, kept in its own store so a review in flight on
  another page never shows here, and one review at a time); cancel their
  own open offer, or clean up an expired one whoever created it, through
  RB-OFFER-CANCEL; or, for a rental, an NFT-collateral offer, a loan sale or
  an offset, be told it is taken in the current app for now, with a link.
  An ended offer says how it ended and offers nothing. A take, cancel or
  clean-up that is open or in flight keeps its panel, finish card included,
  after its own transaction changes the offer, even when a cancel cleared
  the terms, and a take whose offer the creator cancels under the review
  keeps its panel and its Close. Without a wallet the page asks for one at the action, never
  before reading, and a failed re-read behind terms already shown says the
  terms are the earlier read and may be out of date.
- **RB-OFFER-CANCEL** — cancelling an offer (OFF-48) or cleaning up an
  expired one (OFF-49) is one flow, keyed by the offer, opened from its row.
  The review is read at one block: the offer, the protocol's state for it,
  the loan a sale or offset listing is tied to, the pause and the creator's
  protected mode, then the protocol's dry run. A filled, cancelled or unread
  offer, a pause (or an unread one), a non-creator before expiry, the
  protocol's five-minute cool-down on an unfilled offer (with the time it
  ends, lifting by itself as the chain passes it) or the dry run's refusal
  stops it by name. A row whose cancel is open or in flight stays on screen
  whatever the filter, and even after the refreshed inventory drops it,
  until the finish card is closed. The receipt states what returns, sized from the offer's
  own terms by the facet's own branches (unlent principal, the NFT, unused
  collateral, a rental request's prepay and buffer at its stamped rate), or
  says it cannot be sized (an offer tied to a running loan, a refinance
  request that carries its collateral, a rental request posted before the
  buffer stamp) and leaves the figure to the finish card. It states where
  the return lands: for the creator, its own payout route; for anyone
  cleaning up someone else's offer, the creator's wallet, queue (with their
  secondary signer's approval where required) or vault, named as the
  creator's, never "yours". It also says a filled part stays
  filled, the return leaves the creator's vault, the position token is
  retired, a cancel past the cool-down races an accept and either may win,
  and that no approval is asked. The finish card reads the Diamond's cancel
  event, the routed payout and what the token's own logs moved to the
  creator. A return it could not size is measured in the asset the offer
  itself can return, an ERC-20 or an NFT, and one that moved nothing is
  stated as nothing returned.
- **RB-FROZEN** — money the protocol holds for a wallet the sanctions
  screen flags (LN-53) is stated as "Frozen, awaiting de-listing": locked
  where its loan keeps it, in a vault, not lost, and released once the
  wallet is de-listed. The wallet's standing is read once, from the
  protocol's own views (whether a screen is configured, the screen's answer
  for the wallet, and the registry of wallets confirmed flagged while the
  screen could be read), and is one of four: flagged; an outage, meaning the
  screen cannot be read and the wallet was confirmed flagged before, so a
  payout frozen for it stays locked until the screen answers (release is
  fail-closed), and a payment due to it during the outage is parked too,
  since the protocol keeps treating a registered wallet as flagged; unknown, when the standing could not be read, said and never
  assumed either way; or nothing frozen. An outage alone never freezes
  anyone, so a wallet never confirmed flagged reads as nothing frozen in an
  outage. Claims and the loan's page show a notice for the first three, to
  the wallet itself only. Every claim's rule (RB-ELIG) refuses a flagged
  wallet right after the pause, in these words, and a seller's withdrawal
  also refuses in an outage for a wallet confirmed flagged, as
  `claimAsSeller` checks it; a loan claim's caller check lets an outage
  through, so its dry run decides. A dry run refused for a sanctions reason
  is said in the same words: a party the protocol recorded as frozen on that
  loan side (the app cannot read who, since the protocol keeps no view of
  it), or a release waiting for the screen. On a running loan the page
  states what the loan already paid that is reserved for the lender
  position in the lender vault the loan records, such as a payment made
  while the holder was flagged, until the lender's claim pays it; when that
  amount could not be read it says so, and only a zero read shows nothing. A repaid
  loan whose borrower surplus is still held says that surplus is one of the
  payouts left to collect before it settles (never that collecting it alone
  settles the loan, since the lender's side may be open too), so its status
  reads true. A change to the wallet's
  standing reopens a claim's review. Repayments and close-outs are never
  held for a flagged party; only what it is owed waits. The surfaces never
  promise the other party more than its side recovers: a default or a
  liquidation can recover less than is owed. A standing whose latest read
  failed is unknown, even with an earlier answer in hand.
- **RB-RATE-CHECK** — the rate warning before posting (#3357, OFF-15) sits
  under the rate on both posting forms, a lender's offer and a borrower's
  request. It compares the typed rate with the middle rate of loans that
  started on the same pair and term in the last 30 days, read from the
  index (the lower of the two middles for an even count, so no rate is
  invented). Only agreed rates the index's ledger backs count, and loans a
  lender sale opens are left out, since a sale is not a fresh rate. Loans
  on the pair whose terms the index has not confirmed belong to no term;
  the index counts them and the form states that count beside the
  comparison, so "no confirmed loans" never hides loans of unknown term. More
  than five points either way is a warning that says which way it cuts: a
  lender far under the market or a borrower far over it is the offer taken
  first when rates move; the other way the offer may sit untaken. Within
  five points it is a note with the middle rate and the count. No loans to
  compare, NFT collateral, and an index that cannot be read each say so, so
  a missing comparison never reads as a clean one, and an index answer not
  scoped to the pair and term asked for is refused rather than compared.
  When the read reached its sample cap the note says only the latest loans
  were read. It warns and never blocks: the review still opens. An offer's
  expiry defaults to 7 days; choosing "until taken or cancelled" is
  explicit and shows a note that such an offer keeps its rate as the
  market moves.
- **RB-PUBLIC-QUEUE** — on a network that holds a sent transaction in a
  public queue before it is included (Ethereum, BNB Chain, and BNB Testnet
  so it can be seen before mainnet; #3357; Polygon PoS and Polygon Amoy,
  listed before the app serves them, #3445), the review of a write that a
  watcher could act on first says so before the wallet opens: posting,
  taking or cancelling an offer, repaying in full or in part, and adding
  collateral. It names the exposure (anyone watching, bots included, can
  see the transaction and act first, such as taking an offer before its
  cancel lands) and its help says some wallets can send privately, that
  neither the protocol nor the app can choose that route, and that the
  usual route changes only who sees the transaction before it lands. No
  private sending service is named or set by the app. The single-sequencer
  rollups the app serves keep no public queue, so nothing is said there.
  The list of networks is one rule (`publicQueue.ts`), and a test fails if
  a served network is not decided.
- **RB-INBOX** — Alerts (ACC-54) lists the free inbox the protocol's index
  keeps for the connected wallet on its network, newest first, a page at a
  time: loans starting, repaid in part or in full, defaulted or liquidated,
  nearing their due date, entering or leaving grace, and health crossing
  1.5, 1.2 or 1.05; reward entries nearing or past their claim deadline. Each
  row is one outcome sentence with its time and a link to the loan's page
  (which reads the loan from the chain) or to Claims for a reward entry; a
  row is a pointer, never a figure, and it is written as history: it says
  how the loan or entry stood when the row was written, never that the state
  still holds, and the page says to open the loan for where it stands now. A
  reward entry past its claim window says its return has begun, not that it
  is done. An answer for another network or wallet
  is refused, a row whose shape cannot be read is counted and the count
  stated, and a kind the app has no words for is shown and named, so nothing
  is dropped in silence. A row the index wrote when its own check found an
  outcome no event announced says so, with when it was found and that when
  it happened is not known. A failed read is said, never shown as an empty
  inbox. The header carries a bell beside its word, shown while a wallet is
  connected on a served network and the build reads an index, with the
  count of rows the index wrote after the newest one recorded as seen. The
  index counts them over every row by its row id, which only grows in write
  order, so a row stamped with an older block still counts even when it
  sorts below the first page; a count taken from a page is never used. The
  seen record is kept in this browser only and only moves forward; opening
  the page records every row written so far as seen (as a notification
  centre clears its count when opened), states how many were new, and
  marks those it shows as New for the visit. When the latest count failed,
  the bell says the alerts could not be read and shows no count, even with
  an earlier count in hand. Telegram, push, health warnings and payment
  reminders are set up below the inbox (RB-ALERT-CHANNELS).
- **RB-ALERT-CHANNELS** — Alerts › Telegram, push and warnings (ACC-50,
  ACC-52) sets up the alerts that reach a wallet outside the app. Every
  change is a free signature over a plain message that names what it does,
  taken from the one shared source the alert service rebuilds it from; the
  service accepts each signed request once, and a repeat is refused with
  "sign again". A settings save carries only the setting it changes, and an
  absent setting keeps its stored value. The page states in one sentence
  what the service stores (the wallet, the network, the settings and, once
  linked, the Telegram chat id). The service does not report back what it
  holds, so each card states what THIS browser has done, with its time, and
  says a link or setting made on another device may exist. Telegram is
  linked with a one-time code that lasts ten minutes, opened in the bot
  through the service's link when it gives one (a link of any other shape is
  not shown); the link is called proven only once a test alert reaches the
  chat, and a test before the bot has the code says so. Unlinking states the
  scope the service applied: every network for an ordinary wallet, this
  network only for a smart account; a network whose protected mode holds
  the chat names it and says the chat keeps every alert until the delay
  ends, with the time the service gives, or says the delay has not started
  because the chat has not yet been told. Those holds are kept apart from
  the link's state, so a new code or a test alert never erases them; only a
  later unlink answer replaces them (a one-network answer only that
  network's). Push is offered only when the
  service's current answer, read successfully, says it can send now; when
  its answer covers the reminder sender only, the page says warnings may not
  reach push; when it cannot send, push is not offered, the service's
  reason and the sender it concerns are named, a setup reason is said to be
  this deployment's configuration rather than an outage, and an earlier
  switch-on made here is said to stay stored; when the service cannot be
  asked, that is said and push is not offered. Push also needs the channel
  subscription in the wallet's push app, and it stops by unsubscribing
  there, which the page says. Health warnings are always on once a channel
  is set up and have no off switch; the three lines (the service's 1.5, 1.2
  and 1.05 unless changed) are fixed in Basic and editable in Advanced,
  each above the next and the last above 1.0; a warning is not a promise
  that anyone will act. Payment reminders switch off and on. Linking
  Telegram and switching push on ask for the Terms first (ACC-15), and the
  action asked for survives leaving the page mid-acceptance; switching
  anything off never does. A declined signature sends nothing,
  and every refusal has its own words and remedy. A build with no alert
  service says Telegram and push alerts are not set up and sends nothing.
- **RB-PAID-PUSH** — Alerts › Paid push alerts (ACC-53) is the wallet's
  on-chain agreement to pay for push alerts the alert service charges for.
  The card states the fee per loan side the protocol holds on THIS network,
  in VPFI, and that it is taken from free vault VPFI at most once per loan
  side on the first paid push alert, is not refunded once charged, and that
  Telegram is free. Whether the service charges here comes from its push
  status answer; when that answer cannot be read, that is said and agreeing
  is not offered. The stored cap is shown with the contract's own word on
  whether it covers the fee now; the protection is stated against the CAP (a
  fee rise within it is charged without a new agreement), and a cap at the
  protocol's ceiling is said to accept any fee governance can set. Free
  vault VPFI below the fee is warned; an unread figure is "could not be
  read", never zero. Agreeing is offered only where the service charges, at
  or above the fee and within the ceiling, never to a wallet the sanctions
  screen flags; Basic agrees at the fee now, Advanced types a cap. Agreeing
  asks for the Terms first (ACC-15), and reads them again right before the
  wallet opens, so a version published during the review, or a wallet
  switched to, stops it; withdrawing is offered whenever a cap
  is stored, whatever the Terms, a pause or the service say. The review and
  the protocol's dry run come before the wallet, and the fee is read again
  right before it opens (RB-REVIEW). The finish card names the cap the
  transaction's record stores, and says a mined agreement sets the cap only.
  On a deployment without the consent record, nothing is offered and the
  card says whether the deployment can still charge the fee.

- **RB-SETTINGS** — Settings (ACC-06, ACC-13, ACC-14, ACC-15 status,
  ACC-35, ACC-61) is reached from the navigation's foot on every width; it
  holds no money action, so it is not a primary destination. Mode, theme and
  language need no wallet, apply at once and persist in this browser; the
  theme follows the device until chosen and says which it is following; the
  language picker offers the ten languages, says when the one chosen is not
  translated yet and so shows English, and the document's own language
  stays English until it is. For a connected wallet the page shows the
  Terms state on its network: none in force; accepted, with the version and
  the text's fingerprint; or in force and not accepted, which is asked at
  the first action that needs it and never here, while repaying, claiming
  and withdrawing never need it; a read that failed says it could not
  confirm, which is not "not accepted". The fee-discount consent is the same
  setting as on Home (RW-07). The page says what this browser keeps for the
  app, that nothing secret is stored and that this build sends no
  diagnostics.
- **RB-DATA-RIGHTS** — Your data (ACC-55) needs no wallet and no Terms. It
  states what this browser keeps for the app (its own records, the wallet
  connection's items, this tab's items, the site's databases or that they
  cannot be listed, and the shared language cookie) and how many items an
  erasure would remove, before the reader confirms. The download carries
  the app's own records only, names the wallet addresses in them, and counts
  without copying the wallet connection's session material. Erasure ends
  every wallet connection first so nothing is written back, then sweeps this
  site's storage, databases and the shared language cookie at every scope,
  writes back only the wallet libraries' "disconnected" markers (for every
  connector that was connected or already marked, so the reload's automatic
  reconnection cannot reconnect a wallet that still authorises the site),
  and reloads so each preference visibly resets. Every step reports what it
  removed, kept and could not, each refusal with its reason; nothing is
  claimed that was not measured, and the report survives the reload in that
  tab. When the browser will not keep the report for the reload, the page
  does not reload: it shows the report and says why. The confirmation says what erasure does not reach: the chain, the
  alert service's records, the marketing site and the wallet app.
- **RB-RISK-SETTINGS** — Settings › Risk access (ACC-33) states, for the
  connected wallet on its network and from one block's reads, the level
  that counts in words, and why it differs from the level chosen: a raise
  still in its waiting period, with the time it counts, or new risk terms,
  under which it counts as blue-chip until confirmed. It says whether this
  network enforces levels at all; where it does not, the page and every
  receipt say a change is saved and counts only if the check is switched on.
  Strict mode is stated as on, off, or switched off and still applying until
  a stated time. A level stopped by new risk terms is confirmed in one step
  in either mode; changing the level or strict mode is Advanced. Each change
  is one signed transaction through RB-CONFIDENCE (what counts now and after,
  its reach, when it counts, no funds moved); a level change names the change
  counter and terms version it was read with, so a write from elsewhere or
  new terms refuse it and change nothing. A raise still waiting is never
  offered again; lowering says pairs above the new level close to new offers
  and requests, the wallet's own open ones included, and that open loans are
  not affected; switching strict mode off says it is a check removed and
  when it stops applying. Per-pair agreements and acknowledgements stay in
  the flows that need them (RB-RISK-STEP).
- **RB-APPROVALS** — Settings › Approvals (ACC-32) lists the standing
  approvals the connected wallet gives the protocol on its network: an ERC-20
  allowance (stated as unlimited at half the largest value or above), a
  Permit2 allowance with its expiry where Permit2 is deployed, an operator
  approval over an NFT collection, and a single ERC-721 token's approval.
  No chain read lists every approval a wallet has given, so the page checks
  the suggested assets and every asset the wallet's deposit record, loans,
  offers and standing offers name on this network (a standing offer's lent
  asset and the collateral it asks for), plus any contract the
  reader adds, and says what it checked and that an approval outside that
  set is not found. A record that could not be read to its end, or an asset
  that did not answer, is stated; neither is ever "no approval" (a token the
  wallet owns whose approval did not answer is counted unknown). Each
  approval is withdrawn in one signed transaction through RB-CONFIDENCE (what
  it lets the protocol move now, what still lets it move the asset after, no
  funds moved), read again before the wallet opens and measured at the
  receipt's block. "After" is read with the row at one block: another
  approval of the same asset (the collection's operator approval for one NFT,
  the single-token approvals found for a collection, the Permit2 allowance
  for an ERC-20, the token's own allowance for a Permit2 one) is named as
  staying, one that did not answer makes it unknown, and only when each was
  read and none stands does it say nothing remains; a change in it before
  the signature stops the signature as a change. The receipt
  says that anything relying on it refuses until approved again, and a
  Permit2 withdrawal leaves the token's own approval for Permit2, which other
  apps may use, unchanged.

## 3. Companion specifications

### 3.1 Deployment and service capabilities

A capability service, read by every route, publishes per chain: the Diamond
and its routed selectors, the satellite addresses, listing and executor
availability, alert channel coverage, keeper posture per pass (from the
permissionless-steps ledger and a keeper health endpoint, with "unknown" as
the default when neither answers), provenance (build commit, deploy record)
and an expiry. A route that needs a capability the service reports absent or
unknown says so on the surface and withholds the signing step; it never
guesses.

### 3.2 Frontend architecture and acceptance criteria

Domain boundaries follow the matrix: account, offers, loan, exits, nft,
rewards. Shared modules ship before any route: the capability service,
identity-scoped reads (every answer bound to the connected identity and the
chain), the eligibility module (RB-ELIG, RB-SWITCH), transaction tracking
(submitted, mined, measured outcome, partial success), the claim and payout
model (RB-CLAIM), the help panel and copy tiers (RB-TIERS, RB-HELP), the
receipt and finish card (RB-CONFIDENCE). Scenario tests every route must
pass: stale world data with a fresh own state; a wallet change mid-flow; a
partial batch success; an unavailable indexer, proxy or capability service;
each switch class in RB-SWITCH; a review left open past a change in
economics. Deployment acceptance: the page-integrity policy of RB-INTEGRITY
is verified report-only on a deployed build of the new app (a review of that
build fails on any report outside the list) and enforced before the domain
switches.

## 4. Page map

| Page | Basic capabilities | Advanced capabilities |
| --- | --- | --- |
| Home | positions with next action, deadlines, first-run cards | — |
| Borrow, Lend, Rent | guided flows, review, finish | ranges, fill modes, cadence, keeper flags, tariff |
| Positions, Position | list with quick actions; one loan, action-first; add or take back collateral; consequences of holds and races; every exit named with its cost, whether it is open and why not (the protocol's verdict), a lender's leave-it-alone statement first, an unavailable exit explained rather than hidden | the exit and settlement tools themselves (sale, listing, preclose, refinance, offset, handover, swap-to-repay), automation, liquidation routes, accounting detail |
| Claims | the canonical claim list, Claim everything, seller claims (settled funds owed to the wallet, collected one by one), an extension reserve once nothing can draw it | reserve funding and detail, payout queue detail |
| Offers | my offers and the book | signed orders (Desk) |
| Vault | holdings, deposit, withdraw, untracked, safety card | protection detail (Protection page) |
| Rewards | VPFI deposit and withdraw, discount consent, expiry warnings, held-reward recovery, claim | tier mechanics, day cycle, recycling detail |
| Alerts, Settings, Help, Verifier, Activity | all | — |
| Protection, Desk, Console, Recover, Analytics (public, Advanced navigation) | — | all |

Two presentation departures from the current-app specification, each with its
reason (RB-PRECEDENCE): Activity is Basic, where the current app lists
activity history under Advanced, because a user's own history of fund
movements is RB-FUNDS transparency, not an optimisation; the Offer Book is
in Basic navigation, where the current app keeps it out while still showing
a plain newest-first book in Basic, because RB-MODE derives navigation from
the capabilities a page holds and that book is one. The Analytics view and
the Console render fully without a wallet, are reachable by direct link, and
are never withheld by the Terms prompt or by a connected wallet.

## 5. Delivery

- `apps/alpha05` is a new workspace package with its own hosting and domain
  until parity; `apps/app` keeps serving. The custom domain switches when
  every `approved` row has parity, every `blocked` row is disclosed, every
  `divergence` row has a disposition that is not an unresolved release
  blocker (RB-STATUS), the page-integrity policy is enforced on the
  deployment (RB-INTEGRITY), and the e2e suite passes against the new app; then `apps/app` is retired.
  Rollback is the domain pointing back at `apps/app`, which stays deployed
  until one clean week after the switch.
- The shared modules of §3.2 ship first, with the design system (shell, help
  panel, receipt, action list, form fields, step nav, freshness stamp), the
  wallet-first transport and the word-budget guard.
- Then one PR per route, in this order: Home, Borrow, Lend, Positions,
  Position, Claims, Vault, Offers, Alerts, Settings; then Rent, Rewards,
  Protection, Desk, Console, Recover, Analytics, Verifier, Activity, Help.
  Each PR carries its matrix rows with their status, its e2e spec and
  coverage row, its live review on the deployed testnet, and its user-guide
  section (Basic and Advanced) on the marketing site, because the help
  panel deep-links those sections. A delivery ledger keyed by matrix row id
  records acceptance criteria, shared dependency, guide anchor, evidence and
  blockers.
- Gaps the matrix found (spec features with no contract entry point, user
  entry points no spec covers) are issues, not app workarounds.
- Deployments: a mainnet gets one fresh deploy and every later change is an
  in-place facet refresh or an upgrade of the per-user vault implementation
  (owner decision 2026-11-05), so a chain has one Diamond for its life and
  no user ever has to reach a retired deployment. The app therefore binds
  to one Diamond per chain, re-reads the routed selectors after a refresh
  (and the vault version a user's vault reports) and names what changed
  instead of failing on a missing function (matrix row ACC-65). Testnets
  are reset by fresh deploys, which carry no position or balance over from
  the retired Diamond; retired testnet Diamonds are hidden.
  What makes the one-Diamond rule hold (the enforcement, not the intent):
  every post-launch contract change must keep the storage layout
  append-only (the storage-layout guard refuses a refresh otherwise), must
  refresh each refresh-together family whole, must keep the routed
  selectors and events the app and indexer already consume (a retired
  selector is removed by an explicit cut and announced, never left routed
  to old code), and must preserve every open position and claim as it
  stands, and must keep every routed function's argument and return
  encoding and every event's meaning unchanged (a selector that survives
  while its returned tuple changes would make an older app or indexer
  decode plausible but wrong fee or balance fields; the pre-deploy ABI
  drift check compares the compiled ABIs against the ones the apps and the
  keeper carry, and a change it flags ships only as a coordinated,
  versioned app, indexer and keeper release that lands before the refresh);
  a change that cannot meet those five is not a mainnet change, and the
  refresh gate fails it rather than the app working around it.

## Spec review 2026-11-05

Every behavioural statement in §2 to §5 was checked against
`docs/FunctionalSpecs/` (ProjectDetailsREADME canonical; TokenomicsTechSpec,
KeeperOperations and VaultOperations for their domains; Alpha02ConnectedApp
and WebsiteReadme binding on behaviour and funds safety). One line per change;
PD = ProjectDetailsREADME.md, A02 = Alpha02ConnectedApp.md, VO =
VaultOperations.md, WR = WebsiteReadme.md, KO = KeeperOperations.md, by line.

- Header: matrix size corrected from 388 to 390 rows (owner decision log,
  third-round totals); version to v2.3.
- RB-TIERS: added two Tier A items, the unpriced-side default statement (A02
  L4228-4230) and what a listing does to the counterparty (PD L2704).
- RB-ACTION: added the lender's leave-it-alone-first statement, cost before
  the tool, a closed exit explained and never hidden, no remedy the session
  cannot offer (PD L2704).
- RB-ELIG: the lender's direct instant-exit sale is refused while their
  listing stands (PD L2702); the accepted-sale hold is sourced to A02
  L4969-4999 (behavioural, binding under RB-PRECEDENCE) because PD L2702
  completes a listed sale in the acceptance transaction and PD L1100 names
  the accepted-sale state only for the default; a protected-account lock's scope (VO L68-71); the Terms gate's
  exceptions (VO L131-134; A02 L2950-2951); an unobtainable verdict
  withholds the action, an unfamiliar refusal is a refusal, an earliest
  lift time is stated as time alone (PD L2704; A02 L1600-1603).
- RB-SWITCH 1a: the app's own operational switch over position-opening
  flows added, with its "existing positions unaffected" statement (A02
  L3395-3403).
- RB-SWITCH 1b: the posture must be stated in every case including "not
  currently known", never by silence (PD L1225); consent revocation while a
  feature is off now applies to 1a and 1b alike (PD L1225).
- RB-SWITCH 2: corrected. The protocol pause stops claims and withdrawals as
  well as new positions, liquidations, defaults and keeper settlement, and
  leaves full repayment, partial repayment and adding collateral open, with
  pause credit on every open loan's deadlines (PD L3154); the exceptions
  are the three-day escape withdrawal and queued protected payouts (PD
  L3105; VO L112-115), expired-listing teardown (PD L2708) and
  notification-fee consent (PD L2974); a preview under pause reports the
  pause alone (PD L2702). The "Tier-2 close-outs" phrase was the sanctions
  wind-down set, not a pause rule, and is removed.
- RB-SWITCH 4: wording from the keeper global pause (PD L1228) and "the
  keeper is a convenience service" (KO L38); the code identifier in the
  examples column replaced with plain words.
- RB-REVIEW: the platform's own first refusal, never reworded; an
  unrecognised refusal stops the action; a measured figure only when
  supplied; identity change clears answers and holds signing; no silent
  retry after submission (A02 L331-339, L1591-1607).
- RB-CONFIDENCE: the fixable-items eligibility checklist with named
  shortfalls (A02 L4219-4227); exact receipt amounts and typed amounts
  sent as typed (A02 L1494-1530); wallet-confirmation count, order and
  narration (A02 L1582-1586).
- RB-CLICKS: signature approval only on live preconditions with the classic
  path as fallback (A02 L1588-1590); approval put back best effort after a
  late check, failure said (A02 L4590-4595); approval resets named
  honestly (A02 L1587).
- RB-MODE: mode persists, orientation for a Basic user on an Advanced
  route (A02 L28-31); the one labelled switch-to-Advanced action, never a
  side effect (A02 L4596-4600); lender exits are not an advanced topic (PD
  L2704).
- RB-CLAIM: "the free VPFI opt-in" restated as free vault VPFI, opt-in and
  off by default with its reason (A02 L2966-2970); per-payout include or
  exclude, offered only when every amount is known, bounded with a second
  batch, sanctions posture, skipped payouts stay listed (A02 L2971-2982);
  rewards residual and re-claim (PD L1924).
- RB-RAILS World: freshness restated from the specification (ingest per
  chain on the current rotation, A02 L372-373; push rail reports its own
  freshness, A02 L1447-1449; half-hour stale notice, A02 L402-406; degraded
  warning never an empty list, A02 L380-381); the "chain webhook" and
  "cron backstop" wording came from implementation knowledge, not a spec.
- RB-RAILS Own: provider failover and a user-supplied endpoint where the
  credential policy permits (WR L1240-1243; the provider order is this
  design's, the specs set none); per-block refresh for money-gating reads,
  own actions refresh every tab, list-row actions re-checked at the click
  (A02 L1470-1479).
- RB-RAILS text: unknown times shown as unknown (A02 L382-387); honest
  empty states (A02 L4231-4233; VO L123-124); configuration snapshot with
  the chain as fallback, signing reads live (A02 L1459-1462).
- RB-A11Y: accessibility marked as this design's own commitment (no spec
  statement found); navigation and recovery behaviours (A02 L33-45); the
  Display Language rules (A02 L3404-3431).
- RB-FUNDS: a payment counts only when all of it arrived, so the finish
  card states what arrived (PD L486-487).
- RB-INTEGRITY and §3.2: aligned to A02 L293-325 (chain endpoints rather
  than a single proxy; the build writes the list and stops if it cannot
  name an endpoint; a text-to-code dependency is a finding; reported
  requests are still made; the review is of the deployed build; the
  documentation says "not yet enforced" until then; no protection claimed
  against a compromised deployment).
- Named rules: RB-REFRESH alias carries the per-block and every-tab rules
  (A02 L1470-1479).
- §4 Position: taking back excess collateral is Basic (A02 L2036-2039);
  exits named with cost and availability in Basic, tools Advanced (PD
  L2704). Claims: seller claims and a drained reserve's withdrawal are
  settled funds owed to the wallet (A02 L2938-2951, L2957-2964) and so
  Basic under RB-MODE. Footnote: Activity Basic and the Offer Book in
  Basic navigation stated as presentation departures with reasons (A02
  L26-28, L1624-1625, L1641-1643); public surfaces never withheld (A02
  L56-63).
- §5: later mainnet changes are facet refreshes and vault implementation
  upgrades (owner decision 2026-11-05; VO L116-119 for the vault pin and
  upgrade rule); the hosting term replaced by a vendor-neutral word; testnet
  sentence restated (VO L146-148).
- Checked and left unchanged: RB-HELP (no tooltips, A02 L1763-1765);
  RB-SWITCH 1b auto-extend and auto-refinance (PD L1217, L1225, L3781);
  RB-SWITCH 3 (PD L448, L1221, L1992-1997); RB-ELIG listing hold set (PD
  L2728); RB-VISIBLE and RB-PUBLIC (A02 L47-63, L2820-2823; WR L1240).
