# Release Notes — 2026-07-14

Two arcs dominate this release. The **RPC read-diet series** (design →
PR 0 → A → B → C, plus two follow-ups found in the post-deploy live
review) rebuilds how the connected app keeps itself fresh: instead of
polling the chain on fixed timers, refresh is now driven by signals —
the indexer's push rail, the user's own receipts, and window focus —
with honest degradation back to polling whenever those signals cannot
be trusted. Steady-state chain reads on the busiest browse surfaces
drop by an order of magnitude, while every money-action gate keeps its
tip-of-chain parity. The second arc is a **contracts hardening batch**
(rental maturity accounting, early-close late-fee parity, partial-repay
health gating, time-based default sizing) closing Pass-2 findings.
Alongside: the claimables feed learns about internally matched loans,
and a deploy-env guard makes the silently-degraded frontend build that
bit us this morning impossible to ship again.

### Rental loans no longer default early or brick their own repayment (Pass-2 D1, #1188)

An NFT rental amortises by consuming one prepaid day at a time. Previously each
daily deduction (and each multi-day rental partial-payment) shrank the loan's
term counter while its start date stayed put, so the platform computed the
rental's maturity — and its grace window — a little earlier every day. On the
designed daily cadence a 7-day rental could be pushed "past due" and
permissionlessly defaulted around day 4 (forfeiting the borrower's remaining
prepayment and full buffer to the treasury), and a borrower trying to close a
fully-funded, fully-serviced rental in-term was first charged a late fee and then
blocked entirely with a "past grace period" error.

The fix fixes the rental's maturity and grace window at origination and never
moves them. Days consumed are tracked separately, so amortisation no longer
pulls the deadline forward. Concretely: a mid-serviced rental can no longer be
defaulted before its original end-of-term plus grace, and the borrower can always
close a fully-serviced rental in-term. The renter also keeps the NFT for the full
agreed term rather than losing access early (the ERC-4907 expiry no longer
shrinks — resolving the manifestation tracked as #893). Rental economics are
unchanged: the same daily fee, buffer, and refunds apply; only the maturity/grace
accounting is corrected. Non-rental loans are unaffected.

## Thread — Early-close paths now charge the late fee and refuse post-grace (PR #1189)

Before this change a borrower who let a loan run past its due date could
sidestep the late-fee penalty — and reopen a repayment door the ordinary repay
path deliberately closes — simply by choosing a different close-out call. The
three "strategic close" entry points (`precloseDirect`, `refinanceLoan`, and
offset completion) only checked that the loan was still active: they charged no
late fee and had no grace-window cut-off, whereas the normal `repayLoan`
charges the standard late fee on any overdue close and blocks a repayment once
the grace period has expired. The gap let a late borrower keep ~99% of the
penalty (which is lender income) in their own pocket and get a post-grace exit
the protocol otherwise routes to the default path.

All three paths now charge the same late fee `repayLoan` does when the close
lands in the grace window (zero within term, so on-time closes are completely
unchanged), routed through the same treasury/lender split the interest uses —
including the VPFI yield-fee discount case, so a discounted close can't silently
drop the penalty. The NFT rental preclose funds its late fee from the loan's
pre-funded buffer exactly as the rental repay path does. The offset-completion
path receives the fee defensively — it was already prevented from completing at
or past maturity by an existing anti-drift guard, so the fee is zero there in
practice today, but the term is now present should that guard ever change.

Where the paths differ is the post-grace **cut-off**, because they differ in
structure. `precloseDirect` is a single atomic transaction with nothing
pre-created, so — like `repayLoan` — it simply reverts once the grace period has
expired; resolution then belongs to the default path. **Refinance is a two-step
flow**: accepting the replacement offer creates and funds the new loan and pays
the borrower in one transaction, and a later transaction completes the swap by
settling the old loan. Reverting that completion once the old loan crossed grace
would strand the borrower with *both* loans active, so a refinance whose
replacement was already accepted always completes — settling the old lender in
full plus the grace late fee, which is strictly better for that lender than a
default recovery (the same reasoning behind `repayLoan`'s post-grace
FallbackPending cure). A *fresh* post-grace refinance is instead refused earlier,
at offer admission: a refinance-tagged offer cannot be created, accepted, or
matched against a target that is already past its grace window, and a tagged
offer's expiry is capped at the target's grace deadline so it can't linger
unfillable. Legacy untagged manual refinances, which the admission layer can't
associate with a specific loan, are allowed to complete on the same
lender-favourable, penalty-charging basis.

On-time and in-term closes see no behavioural difference. Closes #1189
(umbrella #1196).

### Partial repayments: deleveraging is no longer blocked, and settled interest isn't double-counted (Pass-2 A2 + A3, #1190 / #1191)

Two fixes to voluntary partial-repayment paths.

**A2 — a partial repayment can no longer be rejected for "health factor too low."**
A partial repayment reduces the borrower's debt while their collateral stays
locked, so it can only *improve* the loan's health factor. The old check
nonetheless rejected a partial unless the loan's health factor *after* the
payment was already back above the strict 1.5 origination threshold — which
inverted the intent: it blocked exactly the case where a borrower (or the lender)
most wants a partial, i.e. an underwater loan the payment improves but doesn't
fully cure (say health factor 1.2 lifted to 1.4). The check now simply requires
that a partial not *worsen* the health factor, which matches the spec (partial
repayment is granted with no post-payment floor). Under-collateralized borrowers
can now deleverage as intended.

**A3 — interest already settled by an automatic periodic charge is no longer
re-charged or mis-counted at a partial.**
On loans using the (currently dormant) periodic-interest feature, an automatic
period settlement records interest the borrower has already paid. Two voluntary
partial paths — a normal partial repayment and the swap-to-repay partial — did
not account for that previously-settled interest: they could charge it a second
time at the partial, and they left the settled amount lingering afterward, which
downstream settlement then subtracted from future interest — understating the
debt (delaying liquidation) and underpaying the lender at final close. Both paths
now credit the already-settled interest against the partial's charge and clear
it once consumed, matching the treatment the same fix already applied elsewhere.
Loans not using periodic interest are unaffected.

## Thread — Time-based default no longer hands the lender the whole collateral just because Health Factor dipped below 1 (PR #1192)

When a liquid-collateral loan defaulted at maturity, the protocol decided
between two settlement routes: sell the collateral on a DEX and split the
proceeds (lender capped at what they are owed, borrower keeps the surplus), or
hand the lender the borrower's *entire* collateral in kind with no swap and no
surplus returned. The choice hinged on a "value-collapsed" signal that fired
whenever either the loan's LTV exceeded the 110% volatility cap **or** its
Health Factor fell below 1. The second condition was too broad: a Health Factor
below 1 does not mean the collateral is worth less than the debt. For a loan
whose collateral still sat between the debt and roughly 1.25× the debt (the band
where pricing is live and LTV is still under 110%), the borrower had recoverable
value above the lender's entitlement — but the whole-collateral-in-kind branch
took all of it and gave the lender the surplus for free.

This change restricts the whole-collateral-in-kind branch to a genuine LTV > 110%
collapse (and the existing illiquid-with-consent case). A defaulted liquid loan
that is merely Health-Factor-underwater but still covered now routes through the
ordinary swap/split waterfall: it must attempt at least one enabled swap route,
the lender is capped at the amount owed, and the borrower keeps the recoverable
surplus. If that swap cannot execute safely (abnormal market, slippage over the
configured max, liquidity gone), settlement falls through to the same
oracle-aware fallback the platform already uses — which itself gives the lender
the full collateral only when fair-value pricing is unavailable or the collateral
is genuinely insufficient, and otherwise awards the lender their capped
entitlement plus the fallback premium and leaves the borrower the remainder. The
LTV > 110% "extreme crash" branch is unchanged, because at that point the
collateral is below the debt and the lender is entitled to all of it anyway.

This aligns the time-based default path with the intended settlement behaviour
(no automatic full-collateral-to-lender unless the fair-value split cannot be
computed or the collateral is insufficient; the lender ceiling is the amount due
plus interest plus the 3% premium; at least one route must be attempted). No new
functions or selectors were added — the routing reuses the existing on-chain LTV
view — so there is no ABI change. Closes #1192 (Pass-2 conformance umbrella #1196).

# Claimables feed includes internally matched loans (#1234)

The indexer's claimables endpoint — the candidate layer behind the
classic app's Claim Center — listed only repaid, defaulted, and
liquidated loans. An internally matched loan is just as terminal and
just as claimable, and the Claim Center already verifies and labels
it correctly once it knows to look; the missing status meant an
internally matched position's claim could stay invisible in that
app's indexer-fed list until another discovery source surfaced it.

The endpoint now includes internally matched loans. Nothing changes
about authority: the app still confirms every candidate on chain
before showing a claim as actionable.

# Deploy-env guard: builds without the indexer origin can't ship silently

Guard born from a live incident: a connected-app deploy built from a
checkout without its env file compiled and served flawlessly while
silently running the whole app in its all-chain fallback posture — no
indexer offer book, no push rail, no config snapshot. Nothing in the
build or deploy pipeline said a word.

Both connected apps' builds now check for the indexer origin. A plain
build (CI, previews) prints a loud warning and proceeds — automated
builds legitimately lack operator env. The deploy script's build runs
in strict mode and refuses to produce a bundle at all, so the
operator path that publishes to the live site can no longer ship an
indexer-less build by accident.

# VPFI tier table joins the config-snapshot display path (#1238)

Follow-up to the read-diet config-snapshot slice, found while chasing
a residual chain read in the post-deploy live review: the VPFI
discount tier table shown on the VPFI page was still read live from
the chain on every visit, even though the indexer's config snapshot
already carries the tier thresholds and discounts.

The tier-table display now reads the snapshot first — zero per-user
chain reads — and falls back to the live chain read when the snapshot
is absent, stale, or arrives in an unexpected shape. Fee settlement is
unaffected: discounts are applied by the contract on-chain, never from
this display surface.

# RPC read-diet PR 0 — indexer push-completeness + rail-health metadata

Prerequisite slice of the Alpha02 RPC read-diet design
(docs/DesignsAndPlans/Alpha02RpcReadDietDesign.md §9, PR 0). Before the
app can stop blanket-refetching chain data every block (PR A), the
indexer's realtime push signal has to name every class of change the
affected views depend on, and the rail has to report its own freshness.
This PR closes the gaps found in that design's review:

- **New `ownership.changed` push key.** A position NFT changing hands — a
  secondary trade, a claim burning a position, a borrower-obligation
  migration — previously produced at most an activity-feed push, so
  holder-keyed views (My positions, Claims, the detail page's owner
  gates) learned about it only from polling. The ingest scan now counts
  ownership re-points and broadcasts them under a dedicated key, and the
  connected app maps that key onto every holder-keyed view.
- **Entitlement changes now push.** Data-only loan mutations with no
  status transition — a partial repayment, a partial internal match, the
  partial rescue of a pending-fallback loan (which parks funds a lender
  can later claim), a collateral top-up, an extension, a
  periodic-interest advance — previously broadcast nothing beyond the
  activity feed. They now ride the existing loan-update key, and that key
  additionally refreshes vault balances (settlement and interest events
  are exactly the class that moves escrow into a party's vault).
- **Rail-health metadata.** The push channel's greeting now reports how
  recently ingestion advanced and the expected scan cadence; every
  successful scan is followed by a small cursor heartbeat (previously a
  no-change pass sent nothing, making a quiet chain indistinguishable
  from a stalled rail); and the public stats endpoints report the same
  cadence for deployments without a socket. A failed scan deliberately
  sends no heartbeat so a broken rail can never look healthy. PR A's
  signal-gated polling consumes these; until then the app ignores them.

No behaviour changes for existing clients: unknown push keys and unknown
frame kinds were already ignored, so the indexer and app halves deploy
independently. Observing the new `ownership.changed` frame on the live
rail is the gate before PR A ships (design §7c).

# RPC read-diet PR A — signal-gated freshness (phase 1)

The main slice of the Alpha02 RPC read-diet design
(docs/DesignsAndPlans/Alpha02RpcReadDietDesign.md §4 phase 1): the app
stops paying a recurring per-block and per-30-seconds RPC cost for data
the indexer push rail already announces, without giving up update speed
anywhere speed gates a money decision.

- **Rail health decides the polling posture.** The app now judges the
  push rail by the freshness metadata PR 0 added: the socket must be
  open, the server must report its expected scan cadence, and the
  ingest cursor must keep advancing within a cadence-derived window.
  While that holds, the indexer-covered data hooks (lists, activity,
  vault, rewards, approvals, desk views) relax from 30-second polling
  to a 180-second safety net — push frames carry the actual freshness.
  The moment the rail degrades (socket drop, stalled ingest, an older
  worker without the metadata), every interval returns to today's
  cadence. A returning tab re-reads the relaxed set immediately.
- **The per-block refresh narrows to action-gating reads.** On
  WebSocket deploys the block watcher now refreshes only the roots
  where staleness could mislead an imminent decision: the position
  detail page's owner/status/risk gates, pending-offer accept gates,
  the desk's crossable band, and the shared book's ghost-strip. The
  ghost-strip itself moved into its own block-driven query (scanning
  from the same pre-walk cursor snapshot as before) so the book's
  honesty check keeps tip cadence while the book's data rides push.
- **Own actions stay instant, now across tabs.** Every confirmed write
  (Diamond calls and token approvals alike) triggers a centralized
  refresh of the standard own-state set, repeats it once ~two block
  times later for lagging public RPCs, and broadcasts it to every open
  tab of the app — a submit in one tab reflects in the others within a
  block, with no extra chain reads.
- **List rows guard themselves at click time.** Cancel and amend fired
  straight from a list row now simulate the exact call before the
  wallet prompt, so an offer a counterparty consumed moments ago
  surfaces as an inline explanation instead of a doomed signature.
- **The desk cooldown countdown stopped polling.** The cancel-cooldown
  clock reads chain time once, counts down on the offset-corrected
  local clock, and spends a single confirming read at the boundary —
  the button still only unlocks on a real chain timestamp, so a fast
  device clock can never arm a doomed cancel. Partial-filled and
  expired offers keep their immediate-cancel bypasses.
- **Claims verification runs only when candidates change.** The Claim
  Center re-verifies when the candidate set's content (loan, side,
  status, position tokens, amounts) actually changes, instead of on
  every background refresh of the loan list. Actionability stays
  chain-decided at claim time, with the full probe set intact.

Escape hatch: setting `VITE_FRESHNESS_TIMERS=legacy` at build time pins
the rail-health verdict to "down", restoring the previous timer
behaviour byte-for-byte. Ships one release behind that flag per the
design's rollout plan; the live review (design §7) gates its removal.

# RPC read-diet PR B — display config from the indexer snapshot

Second phase-2 slice of the Alpha02 RPC read-diet design (§4.2.1).
Governance-tunable protocol config — the fee bundle, the NFT-rental
prepay buffer, and the range/partial master flags — was chain-only:
every browser re-read it on five-to-ten-minute caches even though it
changes only on rare governance action.

The indexer now maintains a one-row-per-chain snapshot of that config
and serves it at a public endpoint. It refreshes the row whenever an
ingest scan sees a governance setter event (so a retune reaches the
snapshot within about one scan) and on a slow time backstop, always
fail-open: a refresh problem can never block ingest, and the apps fall
back to their live chain read whenever the snapshot is missing or has
gone stale.

The connected app's DISPLAY hooks (protocol fees, rental buffer, master
flags) read the snapshot first — zero per-user chain reads for config —
and keep the chain read as the fallback. The boundary is unchanged and
deliberate: anything a user signs against is still read live from the
chain at submit time, and the master-flag-gated execute paths still
live-check before the write.

# RPC read-diet PR C — claim-candidate hint + memoized claim verdicts

Third phase-2 slice of the Alpha02 RPC read-diet design (§4.2.3),
targeting the connected app's single most expensive recurring read
surface: the Claims verification fan-out, which confirms every
candidate on chain (current position-NFT holder, claimable amount,
borrower rebate) at roughly three reads per candidate.

Two changes, neither of which moves the authority off chain:

The indexer gains a lean claim-candidate endpoint that lists the
terminal loans whose position NFTs a wallet currently holds, most
recently touched first, capped at the two hundred most recent with an
honest truncation marker. It is additive by contract: the connected
app consults it only as fallback discovery when the authoritative
on-chain enumeration is unavailable (an older deployment), and never
lets it suppress a candidate the chain found. The existing claimables
endpoint that another app consumes is untouched.

The connected app now remembers each candidate's verification verdict
for the session, keyed on the candidate's identity (loan, side,
status, position tokens, entitlement-relevant amounts). A re-check
whose candidates are unchanged spends zero chain reads; only
candidates whose identity actually changed are re-verified. Because
ownership can change without any of those fields moving — a position
NFT sold on a secondary market, a claim from another device — every
remembered verdict is discarded the moment an ownership-change push
signal or one of the user's own confirmed transactions arrives, and a
fresh page load always verifies from scratch. Transport failures are
never remembered as verdicts, so "couldn't confirm" still surfaces as
unavailable rather than a confident stale answer.

### alpha02: risk visibility — health-aware list badges, grace countdown, jargon glosses (UX batch 3)

Third batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
covering UX-003, UX-004 and UX-030 — making risk visible before it
becomes loss:

- **Positions list tells the truth about health (UX-003).** A loan
  hovering near the liquidation line used to list with a reassuring
  green "Due in N days" badge, because the list badge only knew about
  time. The list now also reads the loan's live health for active
  priced loans and lets a worse health state override the time badge —
  "Watch closely" or "Close to liquidation" replaces the green, never
  the other way around ("Past due" is never softened by a healthy
  reading).
- **Past-due loans show the actual deadline (UX-004).** The grace
  window was previously read only when submitting a repayment, so a
  past-due borrower could not see whether they had hours or days left.
  The loan detail page now shows a danger banner once a loan is past
  due, counting down the remaining grace ("Repay within about 2d 4h —
  after that the lender can take the collateral"), and switching to
  honest grace-expired wording once the window closes. Lenders see the
  mirror-image copy for their side.
- **Jargon explains itself at the moment of consequence (UX-030).**
  "Grace period" is now glossed inline wherever it appears — with the
  loan's concrete window length once the live read has it; the
  illiquid-asset consent warning spells out what "not priced by the
  protocol" means in outcomes; and the Advanced-mode health factor /
  loan-to-value numbers carry one-clause definitions instead of bare
  figures.

### alpha02: dead-ends removed, product made discoverable (UX batch 4)

Fourth batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
covering UX-010, UX-011, UX-023, UX-024, UX-026 and UX-032 — every
"now what?" moment gets a next step, and the parts of the product
that existed but couldn't be found are now findable:

- **Empty wallets aren't stuck (UX-010).** On a test network with
  seeded faucet assets, a failing "enough balance" check in any
  guided flow now carries a "Get test assets" link straight to the
  faucet.
- **The product is discoverable (UX-011).** The Basic/Advanced switch
  now lives with the navigation — sidebar footer on desktop, the More
  sheet on phones — instead of only inside Settings. The phone tab
  bar's fifth tab is a real "More" menu: a bottom sheet listing every
  destination without a tab of its own (NFT Rental, Claims, vault,
  faucet, Offer Book, Rate Desk, VPFI, Activity, NFT verifier,
  Settings, Help) plus the mode switch, instead of an alias that
  dumped users on the Settings page.
- **Empty states point forward (UX-023).** An empty vault links to
  the faucet (testnets) or Home; an empty Claim Center explains where
  claims come from and links to Positions; an empty rental market
  points at the list-your-NFT path; a successful faucet mint offers
  "Borrow against it / Lend it out" as the next hop.
- **Positions shows what needs you (UX-024).** Loans group into
  "Needs your attention" / "Active loans" / "Ended loans", where the
  attention group is confirmed on-chain (the same claim check the
  Claim Center runs) and its rows carry an explicit "Claim waiting"
  chip. If that check can't run, the list quietly degrades to
  Active/Ended — it never guesses.
- **Power surfaces orient beginners (UX-026).** A Basic-mode user
  landing on the Offer Book or Rate Desk by URL sees a dismissible
  note naming the surface, linking back to the guided flows, and
  offering to enable Advanced mode.
- **The NFT verifier is findable (UX-032).** It now appears in the
  navigation instead of being reachable only by deep link.
- Follow-up from the batch-3 live review: a visitor viewing a loan
  they're not part of now gets neutral "if nothing happens" wording
  instead of being addressed as the lender.

### alpha02: cold-load performance — instant splash + code splitting (UX batch 5)

Fifth batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
addressing UX-005 — the slow-connection cold load that could show a
pure white page for 12 seconds or more:

- **Something paints instantly.** A small, theme-aware boot splash
  (the brand mark and a spinner) is now part of `index.html` and
  renders before the JavaScript bundle even downloads. React replaces
  it the moment the app mounts, so a visitor on a slow connection
  always sees signs of life instead of a blank screen.
- **The app downloads in pieces, not all at once.** Every screen
  except the three most common entry points (Home, Borrow, Lend) now
  loads on demand the first time it's visited, behind a "Loading…"
  state inside the already-painted navigation shell. The heavy Rate
  Desk chart was already on-demand.
- **Shared libraries are cached across releases and download in
  parallel.** The wallet/RPC stack and the React runtime are split
  into their own bundles, so the browser fetches them alongside the
  entry chunk (faster than one serial ~2.4 MB file) and keeps them
  cached when the app itself updates. The wallet stack is still needed
  before the first interactive screen, so it stays on the startup
  path — the boot splash is what covers that download so the wait no
  longer looks like a hang. (Deferring the wallet providers entirely
  so the shell can paint before they load is tracked as a follow-up.)
- **Stale chunks after a deploy self-heal.** If the app is left open
  across a release and then navigates to a screen whose code changed,
  it reloads once to pick up the new version instead of erroring.

Together these cut the initial download from a single ~2.4 MB file to
a ~118 KB entry bundle, with the large dependencies loaded in parallel
and the boot splash covering the wait. No behaviour changed — this is
purely how fast the app starts and how it recovers across deploys.

### alpha02: readable Activity feed (UX batch 6)

Sixth batch from the 2026-07-11 whole-site UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`),
rebuilding the Activity feed (UX-008) and making it reachable and
resilient (UX-050) — the one screen most likely to shatter a
beginner's trust:

- **Plain-language events.** Raw contract event names no longer leak
  into the UI. Each event maps to a readable line ("Loan started",
  "Offer cancelled"), and any unmapped event is humanized without
  mangling acronyms — the old code turned `NFTMinted` into
  "Nftminted"; it now reads "NFT Minted". The cancelled/canceled
  spelling is consistent throughout.
- **One row per transaction.** A single on-chain action used to
  explode into three to six near-duplicate rows. Events are now
  grouped by transaction and shown as one row labelled by the real
  outcome, with a "+N more in this transaction" note when it stood in
  for book-keeping sub-events.
- **Substance and provenance.** Every row shows the loan or offer it
  concerns, when it happened (relative time), and a direct link to the
  transaction on the block explorer.
- **Pagination.** The feed reveals in pages instead of rendering one
  enormous scroll; a "Load older activity" button brings in more.
- **Reachable and resilient (UX-050).** The Positions page links to
  the full activity history so Basic-mode users (who don't see
  Activity in the navigation) can find it, and when the activity data
  source is degraded the page points to the always-available Positions
  view instead of dead-ending.

Per-row amounts are a follow-up (they need per-asset decimal
resolution); the loan/offer link and the explorer transaction link
carry provenance today.

### Rate Desk order ticket — clearer why-disabled, re-confirm note, Max chips + fee preview (UX-009 / UX-016 / UX-027)

The Rate Desk order ticket used to grey out its **Post order** button with
no explanation, silently un-tick the risk-terms checkbox on every
keystroke, and never show the protocol fees it had already loaded. Three
fixes:

- **Why it's disabled.** The ticket now shows the first unmet reason
  directly under the button — connect your wallet, switch to a supported
  network, pick a market, enter the amount / rate / collateral, accept the
  terms, or (for gasless posting) the order-book service being down. When
  no wallet is connected it renders a **Connect** button instead of a
  dead-disabled Post.

- **"Terms changed — please re-confirm."** Editing any term clears the
  consent checkbox (the deal being consented to changed underneath it); the
  ticket now says so beside the box instead of letting the un-tick read as a
  bug. The note only appears when a consent you had actually given was
  cleared, and disappears the moment you re-confirm.

- **Max chips + a fees & commitment summary.** A **Max** chip fills the leg
  you actually escrow from your wallet balance (a lender's amount from the
  loan-asset balance, a borrower's collateral from the collateral balance),
  and a short summary before consent states what you commit now (or "at
  fill" for a gasless order) plus the protocol fee that applies to your side
  — a lender's net yield after the fee on interest, a borrower's one-time
  loan-initiation fee on the principal.

### Rate Desk polish — readable ladder, honest fill %, clearer chips and match band (UX-028 / UX-036 / UX-037 / UX-038 / UX-045 / UX-046)

A batch of Rate Desk readability and honesty fixes:

- **Ladder scanability + accessibility (UX-028).** The rate column is now
  the clickable pick target (a real button) instead of the whole row
  wrapping the Take/Fill actions — so those controls are no longer nested
  inside another interactive element. Rate, size, and depth columns
  right-align with fixed-width figures, and rates show a consistent two
  decimals so the decimal points line up down the book. The ask/bid rates
  drop the alarm red / success green for a neutral colour — a resting
  lender offer isn't an error — with the side carried by the section
  labels and position. Your own resting order now announces itself to
  screen readers.

- **Honest fill percentage (UX-046).** A partly-filled open order used to
  truncate its progress (99.6% → "99%", a sliver → "0%" beside a visible
  bar). It now rounds, shows "<1%" for a barely-started fill and "99%+"
  for an almost-complete one, and states how much size is still left.

- **"Depth" instead of Σ (UX-038).** The cumulative-depth column header
  reads "Depth" (keeping its explanatory tooltip) instead of a bare Σ.

- **Match band gas note (UX-045).** The crossable-match band now says you
  pay the network gas to execute the match, alongside earning the matcher
  fee.

- **Clearer tenor chips (UX-036).** A term with live offers is marked with
  a small "live" dot rather than a heavy border that read as a second
  selection beside the actually-selected term.

- **Chart credit only when a chart draws (UX-037).** The TradingView
  attribution shows only when a rate chart actually renders, not on the
  pick-a-market / loading / empty states where nothing is drawn.

### Accessibility + header chrome — skip link, route focus, network indicator, readable build date (UX-031 / UX-013 / UX-044)

- **Skip link + focus on navigation (UX-031).** A "Skip to content" link is
  now the first thing keyboard focus reaches (off-screen until focused),
  jumping past the nav to the page body. After any in-app navigation, focus
  moves to the main content region so screen-reader users land on the new
  page instead of staying on the link they clicked. The not-found page now
  carries a proper top-level heading.

- **Persistent network indicator (UX-013).** When connected on a supported
  network, a small chip beside the wallet button shows the current chain
  name (the book, vault, and faucet are all per-network, and the chain name
  otherwise only appeared inside the wallet modal). An unsupported network
  still shows the existing warning banner.

- **Readable build date (UX-044).** The Help footer shows the build date in
  a readable form instead of a raw machine timestamp; the full string
  remains available in the diagnostics drawer.

### Guided flow + offer-card clarity — earlier wallet prompt, role-specific CTAs, role-checking state, consistent empty state, "Post another" (UX-014 / UX-018 / UX-025 / UX-040 / UX-041)

- **Connect prompt up front (UX-014).** The guided borrow/lend flow now
  shows a non-blocking "connect your wallet" note with a Connect button on
  its first step, so a disconnected user isn't told only at the final review
  that they need a wallet to sign. Browsing matches while disconnected still
  works.

- **Role-specific offer CTAs (UX-018).** An offer-book card's action now
  says what taking it does: **"Borrow this"** on a lender offer (you become
  the borrower) and **"Fund this request"** on a borrow request (you become
  the lender), instead of a direction-blind "Use this offer".

- **Role-checking placeholder (UX-025).** On a loan's detail page, while the
  app confirms whether your wallet holds the position, the action area shows
  a disabled "Confirming your role…" button instead of nothing — so a
  borrower mid-repay sees the action is loading rather than an empty space
  under the receipt.

- **Consistent empty-matches state (UX-040).** When the guided matcher finds
  no offers, it uses the same icon + heading empty state as the rest of the
  app instead of bare text.

- **"Post another" (UX-041).** After posting an offer, the success screen
  offers "Post another" beside "View my positions", resetting the flow for a
  fresh offer without leaving the page.

### VPFI/faucet polish, nav alignment, and honest Telegram alerts — batch 8 remainder (UX-012 / UX-017 / UX-029 / UX-033 / UX-034 / UX-035 / UX-043 / UX-047 / UX-048 / UX-049)

- **Test-alert round-trip for Telegram linking (UX-012).** Linking Telegram
  alerts used to end on a self-attested "I've done it — the bot replied"
  button that set the "linked" state with no verification, so a fumbled
  handshake silently dropped every future deadline/liquidation alert. That
  button is gone. After you get the link code, the card now offers **"Send a
  test alert"**: your wallet signs a free ownership proof, the agent Worker
  pushes one real "your alerts are working" message to the linked chat, and
  the card records "linked" only when that send succeeds. If the code never
  reached the bot (no stored chat), it says so plainly and stays unlinked.
  The new `POST /telegram/test` endpoint is signature-gated with its own
  distinct message so a captured signature can't cross actions and a
  spoofed-Origin caller can't spam a linked wallet's chat, and it enforces a
  60-second per-wallet cooldown via an **atomic compare-and-set** (D1
  migration `0034`, rollout-tolerant of the column being absent) reserved
  before the send, so even parallel replays of one signed body can't each
  fire — only one request wins the slot within the 10-minute signature
  window. If the handshake code expires (10-min TTL) before the user
  completes the bot step, the card offers a **"Start over"** action for a
  fresh code instead of leaving a dead code on screen. The test message is
  localized across all ten Worker locales. **Note:** the agent Worker must be
  redeployed and migration 0034 applied for the endpoint to enforce the
  cooldown live.

- **Clearer "unlink elsewhere" control (UX-043).** The ambiguous centered
  "Linked on another device? / Unlink here" link is now a labelled block —
  a heading, a plain-words explanation that the link lives on the server, and
  a full-size "Unlink this wallet" button — so the privacy control is an
  obvious, comfortably-sized target.

- **Wallet-SDK analytics turned off (UX-033).** The Coinbase Wallet and
  WalletConnect connectors no longer phone home their own analytics: the
  Coinbase connector gets `telemetry: false` (wallet-selection behaviour
  unchanged) and WalletConnect gets `telemetryEnabled: false`. Naive users
  never opted into third-party analytics, and consoles stay clean on
  locked-down networks.

- **Nav/title alignment (UX-034).** Page titles now match their sidebar nav
  labels — "Claims", "My vault", "VPFI discounts", "NFT verifier" — with the
  descriptive detail moved into each page's lede.

- **VPFI + faucet polish (UX-029 / UX-035 / UX-048).** The VPFI deposit
  toggle is a proper labelled switch with a wrong-network hint and an "in
  your wallet" balance row; the fee-discount tier table shows each band as a
  half-open "min – <next" range so every threshold appears in exactly one row
  and fractional holders just under a threshold still fall in their row, with
  a below-minimum "no discount" note derived from the live first threshold;
  the faucet page collapses its per-token cards into one card with a row list.

- **Input-hint + FAQ + discovery polish (UX-017 / UX-047 / UX-049).** A
  malformed pasted token address now gets a plain-words hint (not just a red
  border), disabled primary buttons are visibly dimmed; the Rent landing
  gains a "Browse NFTs available to rent" CTA; and the Help page gains five
  FAQ entries (Basic/Advanced modes, alert setup, Claim Center, wrong-network
  switch, NFT verifier).

Closes the batch-8 remainder of the 2026-07-11 alpha02 UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`), leaving no
open findings in that document.

### UX2 batch A — connected-mobile header overflow + boot-splash failure state (UX2-001 / UX2-002 / UX2-006)

- **Connected phone header no longer widens the page (UX2-001).** Every
  route at 390 px used to pan ~71 px sideways once a wallet connected —
  the brand cluster, network dot, and wallet chip out-widthed the
  viewport. Two-layer fix: the wallet chip is now a shrinkable flex item
  whose label ellipsizes (the header is structurally unable to overflow,
  whatever gets added to it later), and the phone tier additionally
  hides the alpha badge and wallet glyph and tightens paddings; the
  chain-name hide threshold moved from 400 px to 560 px because the
  400–560 px band still overflowed with the name shown. Verified in a
  real browser against a production build: scrollWidth 461→390 with the
  full address chip intact. A new fork-tier spec asserts the
  whole-document no-sideways-scroll invariant — connected and
  disconnected — so this class of bug can't return silently.

- **The boot splash can now fail loudly (UX2-002).** If a chunk drops on
  a flaky network, React never mounts and the splash used to spin on
  "Starting up…" forever with no message and no way out. A plain-JS
  timer now lives in the HTML itself — independent of every asset that
  can fail — and after 20 s swaps the spinner for "This is taking longer
  than it should — check your connection and reload" plus a Reload
  button. A normal boot removes the splash long before the timer fires.

- **"Connect wallet" renders on one line (UX2-006)** — the label is a
  nowrap token like the address chip, and the phone tier drops the
  wallet glyph, so the first button a new phone visitor sees no longer
  wraps.

- **Test-infra:** the fork-tier wallet fixture gained the live driver's
  `preAuthorized:false` option (a real wallet reports no accounts until
  approved), making genuinely-disconnected states testable in CI at all.

### UX2 batch B — naming drift, real switch, offer-the-remedy CTAs (UX2-003/004/005/007)

- **Settings "More" cards match the nav (UX2-003).** "Claim Center" /
  "Your Vaipakam Vault" / "VPFI fee discounts" → "Claims" / "My vault" /
  "VPFI discounts", finishing the UX-034 rename family.
- **The VPFI discount consent is a real switch (UX2-004)** — a 40×22
  track with a sliding thumb, brand fill when on, a keyboard focus
  ring, and reduced-motion honoured — instead of the bare checkbox the
  toggle-row pattern was wrapping.
- **Dead-ends now offer the remedy (UX2-005).** The faucet's
  "not available here" state and VPFI's "not on this chain" banner gain
  a one-click "Switch to <chain>" button for connected wallets — the
  target resolved from the deployments bundle (the first testnet with
  `testnetMocks`, and the `isCanonicalVPFI` chain respectively), never
  a hardcoded id. VPFI offers it only on the positive not-registered
  verdict, so a failed availability CHECK doesn't claim another chain
  is the answer.
- **Activity's empty feed hands over the first move (UX2-007)** —
  "Borrow something" / "Lend something" CTAs on both the clean and the
  hedged/truncated empty variants; the indexer-timeout tuning half of
  the finding stays open alongside UX2-008.

### UX2 batch C — ABI off the first-paint path + honest Activity empty (UX2-007 tail / UX2-008)

- **The ~761 KB contract-ABI no longer weighs on the landing or help
  page (UX2-008).** The combined Diamond ABI is now its own long-cached
  chunk, and the things that used to drag it onto every route's first
  paint now load only when they're actually needed: the Borrow and Lend
  pages load on navigation; Home's "you have N positions" nudge, the
  shell's sanctions banner, and Help's live-fee answer load only once a
  wallet is connected (a disconnected help visitor sees the fee
  structure described in words and is directed to connect for the exact
  current rates — the platform never publishes a specific percentage it
  hasn't read live, so a governance re-tuning can't leave a stale number
  on the page). A visitor opening the home
  or help page before connecting downloads none of the ABI — confirmed
  by watching the network on a cold load. Because the ABI changes only
  when the contracts are redeployed, its file stays cached across
  ordinary app releases. The trade is a brief in-app "Loading…" the
  first time Borrow or Lend is opened — the same treatment every other
  screen already had.
- **A genuinely-new wallet's Activity no longer implies hidden history
  (UX2-007 tail).** The "older events may exist that we couldn't scan"
  line was appearing for wallets that had simply never acted — an
  artefact of scanning the busy protocol-wide feed. Because the app
  can't cheaply prove a wallet has zero lifetime history (that needs a
  future per-wallet history lookup), the safe line stays, but its
  wording now just states that the page shows recent activity only —
  true whether or not the wallet has older history — instead of implying
  that older events definitely exist. Both the plain and the
  recent-only empty states keep their Borrow / Lend next-step buttons.

### Second-pass alpha02 live UI/UX review — sweep sessions + findings doc

- **Findings doc.** A second full-surface live review of the deployed
  alpha02 site (build `1dc607b`, the night the 50-finding 2026-07-11
  review closed) is recorded in
  `docs/FindingsAndFixes/Findings20260713-Alpha02SecondPassReview.md`.
  It verifies the shipped fixes on production (22 directly observed
  working, including the VPFI tier bands, role-specific offer CTAs,
  Telegram unlink block, and the 116 KB entry chunk), confirms the
  wallet-SDK analytics opt-out produces zero beacons live, and reviews
  two dimensions the first pass missed: the disconnected first-visit
  experience and Arbitrum Sepolia's chain-scoped surfaces (VPFI
  availability, faucet, desk). Two new P2s were found — the connected
  mobile header overflows the 390 px viewport on every route
  (UX2-001), and the boot splash has no failure state when a chunk
  fails to load (UX2-002) — plus six P3/polish items. All are OPEN;
  fixes follow as separate batches.

- **Sweep tooling.** `live-ux-sweep.mjs` grew from one connected
  session to sessions × passes: connected-Base (desktop/mobile/
  advanced), genuinely-disconnected (desktop/mobile), and connected
  Arbitrum Sepolia (chain-scoped routes), selectable via
  `UX_SWEEP_SESSIONS`. The live driver gained `preAuthorized:false`,
  making the injected wallet behave like a real un-approved wallet
  (`eth_accounts` → `[]` until `eth_requestAccounts`) — without it,
  wagmi silently auto-connects the announced provider and a
  "disconnected" pass captures connected states. The report now
  stamps each pass with its session, chain, and connect state.
