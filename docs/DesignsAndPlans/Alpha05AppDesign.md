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
  node that has not caught up can never pass a skipped reset as done. An ERC-1155 token needs an operator approval over the
  whole collection taken back after the action, so it is named and handed to
  the current app until that step is built.

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
