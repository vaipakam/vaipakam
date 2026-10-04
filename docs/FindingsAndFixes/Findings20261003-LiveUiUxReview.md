# Findings 2026-10-03 — live UI/UX review, scenario-coverage audit, and feature backlog

Third whole-site review of the connected app (`apps/app`) on the deployed
testnet site, after the 2026-07-11 review (`Findings20260711-Alpha02UiUxReview.md`,
50 findings, all closed) and the 2026-07-13 second pass
(`Findings20260713-Alpha02SecondPassReview.md`). Requested by the owner
as three questions:

1. Is the platform being tested, through the website, for all scenarios,
   and are those tests recorded so they can be re-run?
2. Is there a better approach?
3. What would improve the UI and UX, including new features?

Each finding carries an ID (`UX3-###`) for follow-up PRs and board cards.
Unmarked findings are OPEN.

## Method + evidence

| Stream | What ran | Re-run it with |
| --- | --- | --- |
| Whole-site sweep | `apps/app/e2e/live/live-ux-sweep.mjs` — 95 route visits over six passes: Basic desktop 1440px, Basic mobile 390px, Advanced desktop (connected `lender` wallet); disconnected desktop and mobile (never-authorized wallet, throwaway profile); Arbitrum Sepolia desktop | see [Re-running this review](#re-running-this-review) |
| Targeted probe | the lender's repaid loan `/positions/15`, re-read at 3 s, 8 s, 15 s, 30 s and 45 s through `driver.mjs` in `readOnly` mode | same launcher, `readOnly: true` |
| Live driver batch | `apps/app/e2e/live/run-live-batch.mjs` — every committed live driver | see [Live driver batch](#live-driver-batch) |
| Screenshot review | every key route, desktop and mobile, read by eye | artifacts land in `apps/app/e2e/live/shots/ux-sweep/` (gitignored) |
| Source check | each finding below was traced to the code on `main` before being written down, and two candidate findings were dropped when the code disproved them | — |
| Coverage audit | every spec scenario in `docs/FunctionalSpecs/` mapped against `apps/app/e2e/tests/` (32 specs), `apps/app/e2e/live/` and `contracts/test/scenarios/` | — |

**Target build.** `app.vaipakam.com` and the `vaipakam-app` `workers.dev`
URL served the same entry chunk (`index-BCN-stE9.js`) at review time. The
deployed bundle contains copy introduced by the latest `apps/app/src`
change on `main` (#2355, 2026-09-29), so the review describes current
`main`, not a stale deploy.

**Contracts caveat.** The live Base Sepolia Diamond is not on the latest
contracts (owner, 2026-10-03). Read-side findings are about the app;
anything a signing drive reports must be read against that.

## Status ledger

| Batch | Findings | Status |
| --- | --- | --- |
| 1 — trust and accuracy (#2373) | UX3-001, 002, 003, 004, 005, 006, 010, 011, 014 | Fixed in the PR that adds this document. Each funds-facing rule is a pure function with a mutation-checked unit test (`resolveForcedCloseActive`, `tierBandRows`, `defaultRecoveryNote`). The repay spec now also drives the lender's view of a repaid loan. UX3-005 is fixed as "state the unknown": the claim says what the recovery is and that no shortfall is shown. An exact shortfall needs the amount owed at default, which the app does not have; that is tracked in #2374. |
| 2 — plain language and approachable advanced tools (#2378) | UX3-007, 012, 013, plus a wording pass over the core journeys | Fixed in #2378, with two parts still open: amounts on Activity rows (withdrawn from the app and moved to the indexer as #2383) and the loan-to-value on Offer Book cards (UX3-007's third fact, #2384). What shipped: Rate Desk and Offer Book in plain words, with a first-visit guide; collateral amounts and the illiquid flag on offer cards; Basic-mode filters; the Alerts link status; and a vocabulary pass, all in the 10 translated languages. |
| 3 — the missing borrower feature and the bundle | UX3-009, 008 | Fixed. UX3-009 in #2389: the loan page's "Take back extra collateral" card, with every refusal the app can see beforehand checked before the wallet opens, and every unknown stated rather than implied. A price move between that check and the transaction landing can still make the protocol refuse a withdrawal at the limit; the card says so. Three gaps it found are tracked separately: refinance requests made on another device are not discoverable yet (#2391), the ladder does not yet disclose missing signed offers (#2386), and other money inputs still round typed amounts instead of refusing extra decimals (#2390). UX3-008 in #2392: the combined contract ABI is built once with exact duplicates removed, 2.81 MB to 645 KB. |

## Site-wide health baseline

- **95 of 95 route visits loaded**, with zero HTTP ≥ 400, zero
  page-initiated write attempts, and zero analytics beacons (the #1816
  configuration holds).
- **Zero real console errors.** Every visit logged one Chrome warning,
  `Deprecated API for given entry type.` It fires identically on all
  95 visits, including the 404 route, so it is almost certainly the
  sweep's own performance probe rather than the app. Recorded here so
  nobody chases it.
- **No layout overflow** on any route at 390px; no unlabeled buttons;
  no images without alt text; exactly one `h1` per page.
- **Fast paint**: first contentful paint 112–268 ms on every route,
  warm.
- **Honest unknowns remain the house style.** The NFT verifier explains
  that a missing token was either retired or never minted and that the
  chain does not record which; the Activity page says it shows recent
  events only; the Arbitrum Sepolia surfaces say what does not exist
  there.

## P1 — misleads on a funds or lifecycle surface

### UX3-001 · A repaid loan shows "If this loan is not repaid … Still checking" indefinitely (M)

`/positions/15` is a loan the borrower repaid in full. The page states
that correctly ("Owed: Nothing — 25 tLIQ plus interest was repaid in
full", badge **Repaid**), and then, directly underneath, renders the
lender's forced close-out card: **"If this loan is not repaid — Still
checking whether this loan can be closed out. Nothing has been ruled
out."** The targeted probe re-read the page at 3, 8, 15, 30 and 45
seconds and the card was present every time, so it is a stuck state, not
a loading flash. It shows on mobile as well.

The code on `main` intends the opposite. The comment above
`forcedCloseActive` (`apps/app/src/pages/PositionDetails.tsx:1442`)
says: *"without this gate a repaid loan would resolve `unknown` and paint
'still checking' over a position that is settled."* The gate does not
fire here. What the code shows:

- The gate closes the card only when `resolvedLoanStatus` is defined and
  terminal. Otherwise it falls through to `forcedCloseReads.active`.
- The readiness reads behind `forcedCloseReads` are, per the same
  comment, not mounted for a settled loan, so `active` stays `undefined`.
- `decideForcedClose` maps `active === undefined` to `unknown` by design
  (round 65 P2: unread is not terminal). The card renders `unknown` as
  "Still checking".
- The **Repaid** badge and the "Owed: Nothing" row come from the indexer
  row (`/loans/by-lender` returns `status: "repaid"` for loan 15). The
  gate reads a different source, the page's live-status candidates.

So two individually correct rules deadlock: "a settled loan does not
mount the readiness reads" and "an unread status is unknown, never
not-applicable". The likely cause is that `resolvedLoanStatus` is
`undefined` on this page while the indexer already knows the loan is
repaid. That needs confirming in a debugger before a fix is written.
The root fix belongs in the gate, not in another override at the card.

**Why P1.** It is the exact failure the funds-transparency directive
names: a surface asserting an uncertainty the system does not have,
next to a terminal outcome it does know. A lender reading it is told
their settled loan might still need closing out.

**Coverage.** `30-forced-close` covers the card's states on active loans;
nothing asserts the card is absent on a terminal one. Add that case.

### UX3-002 · The VPFI tier table shows the wrong discount at exactly the Tier-4 boundary (S)

The table on `/vpfi` reads `5,000 – <20,000 VPFI → 20%` and
`20,000+ VPFI → 24%`. So a holder with exactly 20,000 VPFI is told 24%.

The contract gives 20% at exactly 20,000. Tier 3 is closed at the top
and Tier 4 starts strictly above the threshold
(`contracts/src/libraries/LibVaipakam.sol:658-662`, "T4 starts strictly
ABOVE this"). The spec agrees (`docs/FunctionalSpecs/TokenomicsTechSpec.md:587-588`:
Tier 3 is `>= 5,000 and <= 20,000`, Tier 4 is `> 20,000`).

The thresholds are read live from `getProtocolConfigBundle`, which is
right. Only the labels are wrong: `apps/app/src/data/vpfi.ts:154` builds
every band as half-open `[min, next)` and the last as `min+`. Lower bands
are genuinely half-open (Tiers 1 and 2 start inclusive), so the fix is
only to the Tier 3 and Tier 4 labels, at the boundary the contract
treats differently. Note that the July review's batch 8c deliberately
introduced the half-open bands, so this is the boundary that fix got
wrong.

**Why P1.** It is a fee figure. Small population, but a wrong
statement of what a user will pay, on the page that exists to state it.

## P2 — real friction or incomplete disclosure

### UX3-003 · The VPFI explainer describes a mechanism the protocol does not use (S)

`/vpfi`, "How the discount works": *"The discount uses your average
holding over the last 30 days — topping up today grows your discount
gradually, not instantly."* (`apps/app/src/content/copy.ts:3995`, and
the same sentence in `en.json` and the translated locales.)

`CLAUDE.md` § "VPFI Fee Discounts" records the actual rule as three
gates, all of which must pass, and lists this exact phrasing as a
mistake made and corrected in #1981:

- **A minimum-tenure gate on the current continuous stake.** A new
  holder gets no discount at all for the first few days (default 3,
  governance-tunable 2–14). The explainer does not mention it.
- **The average is the default window, not "30 days".** 30 is the
  default and the cap (governance range 14–30), and recent days carry
  extra weight.
- **A minimum-tier clamp over the stake's own history, which the
  explainer omits.** That clamp is why a top-up does not grow the
  discount gradually. The effective tier stays at the lower historical
  level until those lower days leave the look-back, and then steps up.

**Why P2.** It sets a wrong expectation about when a fee discount
arrives. That counts under the funds-transparency directive even though
no amount is misstated. The fix is copy only, but must follow the
#1981 rule: write the average and the clamp as two separate look-backs,
and never let one borrow the other's window.

### UX3-004 · Claimable amounts appear on one surface and are missing on three (S/M)

The Claims page cards state exact amounts (`25.1831 tLIQ`,
`0.005041 WETH`). Every other surface that offers the same claim drops
the figure:

- the "Claim everything at once" checklist on the same page reads
  `Loan #15 — your proceeds`;
- the position detail button reads `Claim my funds`;
- the Positions list shows a `Claim waiting` chip with no amount.

The amount is already read (`getClaimable`, per the July batch-1 fix).
Reuse it everywhere a claim is offered, so the user sees the figure
wherever they are asked to act.

### UX3-005 · A defaulted loan's claim states what was recovered but not what was lost (S)

Loan #8: the lender lent 0.005 WETH; the claim reads `0.00285 WETH
recovered from the default`. The shortfall against principal plus
accrued interest is never stated, so the lender has to do the
subtraction, and cannot do it for interest at all. Show owed, recovered
and the difference. If any part is not determinable, say so rather than
omitting the row.

### UX3-006 · On phones, the support button covers page content (S)

The July fix moved the floating support button to the bottom-left on
phones so it would stop covering right-aligned buttons. It now covers
left-aligned content instead:
- the `Loan #15 · The borrower repaid…` line on Claims;
- the Rate Desk's last-fill value (`10% · 17h ago` becomes `· 17h ago`);
- body text on Home and on the loan detail page.

Reserve space for it (bottom padding on the content column above the
tab bar), or fold Support into the mobile **More** sheet.

### UX3-007 · Offer Book cards omit the numbers a lender decides on (M)

A borrow request card reads `9% yearly · 1 month · collateral tCOL`.
For a lender pressing **Fund this request**, the deciding facts are the
collateral **amount**, the resulting LTV / health factor, and whether
the collateral is liquid or illiquid (which decides between a swap and
an in-kind transfer on default). None is on the card. There is also no
sort or filter by asset, rate, term or collateral class. All four fit
in one secondary line plus a filter row.

**Status — partly fixed in #2378.** The collateral amount (or "at least" its
floor), the illiquid flag as recorded at posting, NFT collateral by token, and
Basic-mode show/sort now appear. The loan-to-value is not shown yet; it needs
per-offer pricing and an honest "can't be priced" state, tracked in #2384.

### UX3-008 · The contract-ABI chunk has tripled since July (M)

`contract-abis-*.js` is **2.58 MB** uncompressed. The July second pass
recorded about 761 KB when it was split out. Every connected session
loads it (disconnected sessions correctly still do not). The likely
driver is facet growth, which `exportFrontendAbis.sh` exports in full.
Options: per-route ABI slices, or event-only / function-only subsets
generated at export time.

**Status — fixed in #2392.** The cause was repetition rather than growth:
each facet's ABI repeats the shared errors and events, and about three
quarters of the chunk was exact duplicates. The combined ABI is now built
once, at export time, with exact duplicates removed (2.81 MB to 645 KB),
and a package test fails if it goes stale or an exported facet ABI is missing
from the manifest it is built from. Which facets are exported at all is still
the hand-kept `FACETS` list in the export script, which leaves internal facets
out by design; a facet left off that list is not caught by these checks. Per-route
slicing was not needed.

### UX3-009 · "Withdraw excess collateral" is specified and live on chain, with no app surface (M/L)

`ProjectDetailsREADME.md` § "Allow Borrower to Withdraw Excess
Collateral (Health Factor)" describes it as a borrower feature.
`PartialWithdrawalFacet` (`calculateMaxWithdrawable`,
`partialWithdrawCollateral`) is cut into the Diamond. A search of
`apps/app/src` finds neither selector. A borrower whose collateral has
appreciated has no way to use that from the app. This needs a product
decision on placement (the position detail page is the natural home),
then a CI-Anvil spec.

**Status — fixed in #2389.** The loan page carries a Basic-mode "Take back
extra collateral" section for the borrower-position holder of an Active loan.
It states the live ceiling, explains every zero, refuses an over-ceiling amount
on the page, and re-checks every protocol refusal it can see before the wallet
opens. Covered by `apps/app/e2e/tests/32-withdraw-collateral.spec.ts` (CI-Anvil)
and `apps/app/src/data/partialWithdraw.test.ts`.

## P3 — polish

- **UX3-010** On a repaid loan, "What happens next — The borrower
  repaid…" is set in the warning orange used for risk. A settled
  outcome should read neutral or positive.
- **UX3-011** The mobile header's network chip is a bare green dot, and
  the address is cut to `0x1DAe……`. A dot does not say which network,
  and the July rationale for a persistent network chip was that it
  should. Keep a short network label (e.g. `Base Sep.`) and trim the
  address instead.
- **UX3-012** Activity rows for offers carry only the offer number and
  time (`Offer created · Offer #43 · 22d ago`), and `Transfer` carries
  nothing at all. Asset, amount and side would make the feed readable
  without opening the explorer.
- **UX3-013** Settings → Alerts shows **Link Telegram**, **Unlink this
  wallet** and both preference checkboxes together, and never says
  whether this wallet is linked now. If the browser cannot know, say
  that it cannot.
- **UX3-014** The Positions subtitle promises "the one action each needs
  right now", but the cards carry status chips only. An inline **Claim**
  (with its amount, per UX3-004) on the `Claim waiting` rows would make
  it true.

## Environment artifacts (recorded, not product findings)

- **Indexer WebSocket TLS failure.** `wss://indexer.vaipakam.com`
  failed with `ERR_CERT_AUTHORITY_INVALID` inside the review sandbox,
  whose egress proxy re-signs TLS. The sweep classifies it as sandbox
  noise, correctly.
- **JS heap readings.** The heap climbs from route to route within a
  session and drops at garbage collection (for example 235 MB to 29 MB
  on the mobile pass). Chrome reports that figure for the whole
  renderer process, not per document, so this is not evidence of a
  leak. It is also not evidence against one; a dedicated soak test on
  one long-lived page would settle it.
- **Browser-path mismatch.** The sweep first came back BLOCKED because
  the workspace's Playwright expects a different Chromium build from the
  one the container ships. `LIVE_CHROMIUM_PATH=/opt/pw-browsers/chromium`
  fixed it. The driver reported BLOCKED rather than a pass, which is the
  verdict contract working.

## Question 1 — is the platform tested end to end, and recorded for re-runs?

**Partly. The recording is in good shape; the scenario coverage is not.**

What exists and is re-runnable:

- **CI-Anvil tier:** 32 Playwright specs in `apps/app/e2e/tests/`, run
  on every PR against a local Anvil carrying the repository's current
  contracts (#2334). Deterministic, and no live-chain dependency.
- **Live tier:** about 20 committed drivers in `apps/app/e2e/live/`,
  with a batch runner and a three-verdict contract (PASS / FAIL /
  BLOCKED).
- **Coverage matrix:** `apps/app/e2e/COVERAGE.md`, updated with every
  behaviour-changing PR.

What this session had been doing before this review: contract fixes
verified by Foundry tests and Anvil-fork rehearsals. The live drivers
had not been run against the site in this session until this review.

**Scenario gaps.** These scenarios from the functional specs have no
UI-level test at either tier. Ranked by funds risk:

| # | Scenario | Covered today | Belongs in |
| --- | --- | --- | --- |
| 1 | Claims (lender, borrower, Claim-All) | contract tier only | CI-Anvil |
| 2 | Illiquid collateral: consent → accept → in-kind default | contract tier only | CI-Anvil |
| 3 | NFT rental: list → rent → daily deduction → close → claim | contract tier only | CI-Anvil |
| 4 | Health-factor display, low-HF warnings, liquidation outcome | contract tier only; the UI suite has no way to move a price | CI-Anvil, with a price fixture |
| 5 | Lender early withdrawal: listing form, direct sale, buyer completion | listing seeded by direct write; form untested | CI-Anvil |
| 6 | Withdraw excess collateral / add collateral | `32-withdraw-collateral` (CI-Anvil, batch 3) / contract tier only | add-collateral still needs a CI-Anvil drive |
| 7 | Sanctions banner and Tier-1 / Tier-2 gating in the UI | contract tier only | CI-Anvil |
| 8 | Wrong network / chain switch | none | CI-Anvil |
| 9 | VPFI deposit, withdraw, tier display | accept-path opt-in only | CI-Anvil |
| 10 | Offset completion; paused settlement after a sale is accepted | partial | CI-Anvil |
| 11 | Full repay inside grace; grace countdown banner | partial | CI-Anvil |
| 12 | Kill switch blocks entries but never exits | lend review only | CI-Anvil |
| — | A user **rejecting** a transaction | Permit2 signature only | CI-Anvil (wallet fixture option) |
| — | Terminal loan detail pages (UX3-001) | none | CI-Anvil |

**Where `COVERAGE.md` claims more than the spec asserts** (line numbers
in `COVERAGE.md` at `895494a`; each claim checked against the spec file):

- **Line 432 (network gate):** the spec checks only that the address chip
  renders.
- **Line 540 (listing hold):** the listing is created by a direct
  contract write, not through the UI.
- **Line 606 (forced close):** `triggerDefault` is never sent.
- **Line 439 (kill switch):** only the lend review is checked.
- **Line 516 (notifications):** the row describes a 2-item badge; the
  spec asserts 4.
- **21 rows** say "driven post-deploy" without naming a committed
  driver, which breaks the matrix's own rule.

## Question 2 — a better approach

The two-tier structure is right, and the verdict discipline is better
than most projects have. The gaps are in what it is pointed at. In order
of payoff:

1. **Source the scenario list from the functional specs, not from the
   PRs.** Today `COVERAGE.md` grows one row per feature PR, so a flow no
   PR touched never gets a row. That is how claims, the most-used
   terminal step, have no UI test at all. Give each spec scenario a
   stable ID and expected outcome, and make the matrix a projection of
   that list with the tier and test filled in. A blank cell is then a
   visible gap. This is the same rule that keeps the functional specs
   independent of the code.
2. **Add a price fixture to the CI-Anvil tier.** It unlocks the whole
   risk half of the product (#4 above). The tooling exists:
   `RepriceTestnetMock.s.sol` (#2372) moves a faucet asset's feed, pool
   price and swap-venue price together and proves the oracle follows.
   The Anvil global setup can call the same logic.
3. **Add a "reject" mode to the injected test wallet.** Then every
   signing flow can assert its cancelled state, not only its success.
4. **Run the live batch on a schedule, not only before a release.**
   Read-only drivers (the sweep, the position observer) need no funded
   key and can run nightly against the deployed build, posting their
   verdict table. Signing drivers stay manual.
5. **Redeploy the testnet to current contracts before trusting live
   signing drives.** Until then, a live FAIL on a signing path cannot be
   told apart from contract-version skew.
6. **Close the overclaims listed above.** Either strengthen the spec or
   narrow the row.
7. **Small friction fix:** have `driver.mjs` fall back to
   `/opt/pw-browsers/chromium` when the bundled browser is missing, so
   the documented command works unmodified in the cloud environment.

## Question 3 — UI/UX improvements and new features

The findings above are defects against current intent. These are
additions, roughly ordered by value to a first-time user. None involves
VPFI as a yield or price surface (RL-6).

**Clarity on money**

- **One cost breakdown before signing**, for both sides. Interest for
  the term, the loan-initiation fee, the treasury share of interest,
  and the network fee, as one total in the lending asset. This makes
  UX3-004 and UX3-005 the same pattern at the other end of a loan.
- **A settlement receipt on every terminal loan.** What was owed, what
  was paid or recovered, fees, and what is still to claim, and the
  shortfall when there is one. It should be downloadable.
- **Activity export (CSV)** with asset, amount and transaction link per
  row, for record-keeping.

**Risk you can see**

- **Health and deadline on the Positions list.** A health gauge with the
  liquidation price for liquid collateral, and a countdown to due date
  and to the end of grace. Today both appear only after opening a loan.
- **A "what if the price moves" slider** on the loan detail page,
  showing health factor and liquidation price at -10%, -25% and -50%,
  read from the same oracle.
- **Due-date reminders in the app**, in addition to Telegram and Push:
  a banner when a repayment falls due within N days, and a calendar
  (.ics) export of due dates.

**Finding the right deal**

- **Offer Book filters and richer cards** (UX3-007): asset, rate, term,
  collateral class, LTV.
- **Saved searches.** "Tell me when a 30-day WETH offer at 8% or less
  appears", delivered through the existing alert channels.

**Getting started**

- **A testnet onboarding checklist on Home:** get test assets → create
  vault → post or take an offer → repay → claim, each step ticking off
  from chain state. It doubles as a manual smoke test that anyone can
  run.
- **A connected-home summary:** what you have lent and borrowed, what is
  claimable, the next deadline. Today Home shows the same four job cards
  whether or not you have positions.

**Completing the specified product**

- **Withdraw excess collateral** (UX3-009) and a more discoverable **Add
  collateral**, both on the loan detail page with the health factor
  before and after.
- **NFT rental gallery** with token images and metadata, plus a rental
  calendar, so renters can see what they are paying for.

## Live driver batch

`run-live-batch.mjs` against `https://app.vaipakam.com`, 2026-10-03,
with the dev test wallets. **13 PASS, 3 FAIL, 0 BLOCKED.**

| Driver | Verdict | What it means |
| --- | --- | --- |
| live-alerts-link | PASS | |
| live-collateral-precheck | PASS | |
| live-connect-telemetry | FAIL | Environment. The one failing step is "WalletConnect relay initializes": no relay socket exchanged a frame. Inside the review sandbox, whose egress proxy re-signs TLS, every WebSocket fails the same way (the indexer socket too). The telemetry assertions themselves all passed: no beacons on load or when the modal opens. Re-run outside the sandbox to close it. |
| live-desk-i18n-capture | PASS | |
| live-dryrun-review | PASS | |
| live-killswitch-regression | PASS | |
| live-position-observe | PASS | |
| live-rate-desk | PASS | |
| live-recover-locales | PASS | all nine translated locales serve and render `/recover` in their own language |
| live-recover | FAIL | **Possibly real, on `vaipakam.com`, not the app.** The Help link to the Advanced User Guide resolves (HTTP 200, the `#stuck-recovery.what` anchor exists), but after navigating, the attested heading sat 31,282 px down the page instead of below the fixed header. The deep link opened the guide at the top rather than at the section the signed declaration points to. Re-run first, since a late-loading page can do this; if it repeats, it is a marketing-site defect. |
| live-risk-access | PASS | |
| live-role-journeys | PASS | |
| live-rpc-audit | PASS | |
| live-signed-book | FAIL | Environment: a transient indexer ingest lag. Steps 1–6 passed: a gasless signed offer was posted with one signature and no transaction, landed on the wire and both UI surfaces, and was cancelled on chain. The final step timed out waiting for the indexer to drop the cancelled row; the driver itself diagnosed the production ingest cursor as stalled (at block 47,630,236, cancel at 47,630,244, no advance for 546 s against a 300 s scan cadence). Minutes later the cursor was at 47,630,639 against a chain head of 47,630,734, inside its cadence again. Re-run. |
| live-support-ticket | PASS | |
| live-ux-sweep | PASS | 95 of 95 route visits loaded |

**Side effects on the shared testnet.** The signing drivers act with the dev
test wallets: live-signed-book posted and then cancelled one gasless signed
offer (WETH/tLIQ, 60 days); live-support-ticket sent one clearly marked
test ticket. Nothing was left open.

## Re-running this review

From `apps/app/e2e/live/`, with the dev wallet file (never committed):

```bash
export SITE_URL=https://app.vaipakam.com          # or the workers.dev URL a deploy prints
export TESTNET_WALLETS_FILE=../testnet-wallets/wallets.json
export LIVE_CHROMIUM_PATH=/opt/pw-browsers/chromium   # cloud sessions only

node live-ux-sweep.mjs        # read-only; screenshots + report.json in shots/ux-sweep/
node run-live-batch.mjs       # every committed driver; signing ones use the dev wallets
```

Before reviewing `app.vaipakam.com`, confirm it serves the same build
as the latest deploy: compare the `/assets/index-*.js` name in both
hosts' HTML. A status code proves nothing, because both hosts return the
same 200 shell for every path.
