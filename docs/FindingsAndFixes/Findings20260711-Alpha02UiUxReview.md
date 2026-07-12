# Findings 2026-07-11 — alpha02 whole-site UI/UX review

Full-surface UI/UX review of **apps/alpha02** on the deployed testnet
site (alpha02.vaipakam.com, Base Sepolia, build `1c90b73`), logged for
later work per the review request. Each finding carries an ID
(`UX-###`) so follow-up PRs and board cards can reference it
individually; the **Status ledger** below tracks which findings have
since been fixed and in which batch — unmarked findings are OPEN.

## Method + evidence

Three evidence streams, cross-checked:

1. **Live sweep** — the committed driver
   `apps/alpha02/e2e/live/live-ux-sweep.mjs` (added with this review)
   visited all 17 routes with the dev lender wallet connected, in three
   passes (Basic desktop 1440px, Basic mobile 390px, Advanced desktop),
   capturing full-page screenshots, the console stream, network
   failures/heavy assets, landmark probes, and a per-route DevTools
   probe (storage, IndexedDB, cookies, service worker, nav/paint
   timings, JS heap, long tasks). Evidence regenerates into
   `apps/alpha02/e2e/live/shots/ux-sweep/` (gitignored).
2. **Screenshot review** — every capture reviewed visually (desktop +
   mobile + advanced sets).
3. **Static code review** — all 17 pages + the shared flow/desk/shell
   components read for the states screenshots can't show (loading /
   empty / error handling, a11y, copy, responsive rules).

**Site-wide health baseline (the good news):** zero real console
errors and zero HTTP errors across all 51 route visits; storage
hygiene is clean (3 localStorage keys, all <1 KB; no cookies; no
session storage; IndexedDB only the wallet SDKs'); warm-cache
performance is good (TTFB 0.4–0.6 s, FCP 0.7–2 s, zero long tasks,
heap 18–50 MB with no growth trend); no unlabeled buttons or alt-less
images anywhere; badges pair text with color throughout; the six-row
confirm receipts, honest loading/empty/unavailable trichotomy, and
plain-language copy are consistently strong. The design kit is
coherent — the issues below are almost all **state-awareness, dead
ends, and discovery**, not the component system.

Severity: **P1** = misleads or blocks a core journey / trust damage;
**P2** = real friction; **P3** = polish. Effort: S (<½ day), M (a
day-ish), L (multi-day).

## Status ledger

Work lands in batches; each finding below also carries its own status
line when addressed. Unmarked findings are OPEN.

| Batch | Findings | Status |
| --- | --- | --- |
| 1 — trust (2026-07-11) | UX-001, UX-002, UX-007, UX-020, UX-021, UX-022 | ✅ Fixed — state-aware loan receipts, exact claim amounts via `getClaimable`, FAB moved bottom-left on phones, header chip nowrap, Try-again on unavailable states, spinning loaders |
| 2 — mobile (2026-07-11) | UX-006, UX-019, UX-039, UX-042 | ✅ Fixed — desk stacks single-column below 560px, item-row cards stack with full-width CTAs ≤480px, compact "Step N of M" wizard line on phones, tappable copy+explorer address chips (44px touch targets) |
| 3 — risk visibility (2026-07-11) | UX-003, UX-004, UX-030 | ✅ Fixed — position-list badge escalates on poor health, past-due detail pages show a live grace countdown banner, grace/HF/LTV jargon carries one-clause inline glosses |
| 4 — dead-ends/discovery (2026-07-12) | UX-010, UX-011, UX-023, UX-024, UX-026, UX-032 | ✅ Fixed — faucet link on failing balance checks, persistent mode switch + real phone More sheet, forward CTAs on Vault/Claims/Rent/faucet-success, Positions grouped with chain-confirmed "Claim waiting" chips, Basic-mode orientation banner on /offers + /desk, NFT verifier in the nav |
| 5 — performance (2026-07-12) | UX-005 | ✅ Fixed — static HTML boot splash, React.lazy route chunks under a Suspense'd shell, wallet/React vendor-chunk splitting; entry chunk 2,407 kB → 118 kB |
| 6 — Activity rebuild (2026-07-12) | UX-008, UX-050 | ✅ Fixed — event label map + acronym-safe humanizer, per-transaction coalescing, substance sub-line + explorer link + relative time, load-more pagination; Basic-mode Activity link from Positions + chain-authoritative fallback when the indexer degrades |
| standalone (2026-07-11) | UX-015 | ✅ Fixed by #1094 (plain-language contract errors) — name-keyed decoder across `CollateralPrecheck` / `SimulationPreview` / dry-run footer; #1112 adds the early under-collateral warning on the borrow step |

---

## P1 — trust, correctness, core-journey blockers

### UX-001 · Repaid loan detail still shows "Owed" + the default warning (S)
A loan with the green **Repaid** badge still renders "Owed: 25 tILQ +
up to ~0.1849 tILQ interest" and the orange "If nothing happens — you
can claim their collateral" consequence row (`PositionDetails.tsx`
~1265–1276; seen live on `/positions/16`). Contradictory state on a
money page erodes trust in every other number. Fix: make the receipt
rows and the "what happens next" cell state-aware — on Repaid, show
"The borrower repaid — claim below; nothing else can happen to this
loan."

**Status: ✅ FIXED (batch 1, 2026-07-11).** `loanOver` gates the receipt: "Owed" answers per terminal status and the consequence row becomes "What happens next" with repaid/defaulted/closed-specific copy.

### UX-002 · Claim cards don't say what you'll receive (S/M)
The defaulted-loan claim card is titled with what reads as a leaked
field description — "What this loan recovered (proceeds or
collateral)" — instead of an amount, and every repaid-loan card says
"25 tILQ **+ interest**" with the interest unquantified even though
the detail page computes it. On the one screen whose job is "collect
your money," the user can't see the number. Fix: resolve and show the
concrete recovery/total per card.

**Status: ✅ FIXED (batch 1, 2026-07-11).** `useMyClaimables` now carries `getClaimable`'s exact asset + amount onto each row; claim cards show the real number (repaid totals include interest; default recovery shows the settled proceeds, with a plain-language fallback only for pure in-kind transfers).

### UX-003 · Positions list shows green "on track" on loans near liquidation (M)
`LoanRow`'s badge derives only from status + days remaining
(`loanState.ts:38-51`); collateral health is read only on the detail
page. An active loan at HF ≈ 1.05 lists as reassuring green. Fix: let
a danger/warn health state override the time-based badge for active
priced loans ("At risk — add collateral"), or add a health chip per
row.

**Status: ✅ FIXED (batch 3, 2026-07-11).** `LoanRow` reads health for active priced loans and lets a WORSE health badge override the time-based one (never a better one — "Past due" is never softened); the badge tooltip states the health number and the 1.00 liquidation line.

### UX-004 · Past-due loans never show the grace countdown (M)
The grace window is read live only at submit time
(`PositionDetails.tsx:561`) and never displayed; a past-due borrower
can't tell if they have hours or days before collateral seizure, and
nothing escalates visually beyond a small badge. Fix: countdown
("Liquidation possible in ~2d 4h") + a banner once inside the window.

**Status: ✅ FIXED (batch 3, 2026-07-11).** New `useGraceSeconds` hook surfaces the grace window for display; a past-due loan detail page shows a danger banner with a live countdown ("Repay within about 2d 4h…"), switching to grace-expired wording once the window closes, with role-appropriate copy for borrower and lender. The "If nothing happens" row now states the concrete grace length too.

### UX-005 · Cold load is a blank white page — 2.4 MB unsplit bundle (M/L)
One `index-*.js` of **2,407 KB** ships on every route; there is no
route-level code splitting, no service worker, and no HTML-level boot
splash. During the sweep, two visits whose bundle fetch exceeded ~12 s
captured **pure white pages** (`/borrow` mobile, `/offers` desktop) —
exactly what a slow-connection user sees, with no sign of life. Warm
performance is fine; the cold path is the problem. Fix, in order of
value: (1) static splash/skeleton in `index.html` so *something*
paints instantly; (2) `React.lazy` route chunks (the desk, charts,
GoPlus/analytics surfaces don't belong in the boot chunk); (3)
vendor-chunk splitting.

**Status: ✅ FIXED (batch 5, 2026-07-12).** All three fixes shipped. (1) A theme-aware boot splash (brand mark + spinner) renders from `index.html` inside `#root` before the bundle loads, replaced when React mounts — a slow connection never sees a blank page. (2) Every route except Home/Borrow/Lend is now `React.lazy`, with the AppShell's `<Outlet>` under Suspense (the charts were already lazy). (3) `manualChunks` splits the wallet stack (wagmi/viem/connectkit/react-query) and React into separate cacheable vendor chunks. Measured: the entry chunk dropped from **2,407 kB → 118 kB** (34 kB gzip); wallet-vendor (1.85 MB) and react-vendor (232 kB) download in **parallel** with the entry chunk (faster than one serial 2.4 MB file) and stay cached across app deploys, and per-route chunks (RateChart 181 kB, PositionDetails 60 kB, Desk 54 kB, …) load on demand. **Honesty note (Codex #1169 r1):** the wallet stack is still statically imported by `main.tsx`, so it remains on the critical path to first *interactive* paint — the boot splash is what covers that download (no blank page); genuinely deferring the wallet providers so the shell paints before they load is a larger refactor tracked as a follow-up. A `vite:preloadError` reload handler self-heals stale chunk requests after a deploy.

### UX-006 · Rate Desk is crushed side-by-side at phone widths (M)
`.desk-main` is `1fr 1fr` at its base breakpoint and never stacks
(global.css ~1075/1100–1128), so at 390 px the ladder and ticket get
~150 px each: ladder headers wrap to fragments, the "Borrow this"
button overlaps the rate text, every ticket label wraps (screenshot
`basic-mobile--desk.png`). Fix: single-column stack below ~560 px, or
add Book|Ticket to the existing mobile toggle.

**Status: ✅ FIXED (batch 2, 2026-07-11).** `.desk-main` stacks to one column below a 560px container width — full-width ladder above the ticket; the Book|Chart toggle is unchanged.

### UX-007 · Support FAB covers right-aligned Claim / "Use this offer" buttons (S)
The fixed Support button sits exactly where list-card CTAs land on
mobile — in the Claims capture it visibly paints on top of Loan #8's
**Claim** button, stealing the tap (`DiagnosticsDrawer.tsx:68-77`).
Fix: dodge/offset the FAB above the tab bar, or make list CTAs
full-width under the text on narrow viewports.

**Status: ✅ FIXED (batch 1, 2026-07-11).** The Support FAB sits bottom-LEFT on phones (right-aligned card CTAs can no longer be covered); desktop keeps the conventional bottom-right.

### UX-008 · Activity feed is unusable for comprehension (M)
Raw event names leak straight into the UI ("Nftminted"), each action
explodes into 3–6 near-duplicate rows ("Offer created" + "Offer
created details" + "Transfer"), rows carry no amounts, counterparties,
times, or explorer links ("Protocol event · Jul 10, 2026" ×100), the
list is unpaginated (~5,500 px), and spelling drifts between
"cancelled"/"canceled". This is the one screen that would shatter a
beginner's trust. Fix: label map + coalesce per-transaction + one line
of substance per row (amount, asset, offer/loan id, tx link) +
timestamps + pagination.

**Status: ✅ FIXED (batch 6, 2026-07-12).** New `lib/activityView.ts` (unit-tested): an explicit event-kind label map + an acronym-safe humanizer fallback (the "Nftminted" bug — `NFTMinted` → "NFT Minted", not "Nft minted") that also normalizes the cancelled/canceled spelling drift, plus `coalesceByTx` collapsing each transaction's many events into ONE representative row (highest-priority action, e.g. `LoanInitiated` over its `*Details`/`Transfer` companions) with a "+N more in this transaction" note. Each row now carries a substantive sub-line (loan/offer id · relative time · sub-event count), a per-row explorer transaction link, and the feed reveals in pages of 25 (load-more) instead of one ~5,500px list. Amounts-per-row remain a follow-up (they need per-asset decimals; the id link + explorer tx cover provenance today).

### UX-009 · Order ticket's "Post order" dead-disables with no reason (M)
`canPost` ANDs ~15 gates (`OrderTicket.tsx:446-467`) and the only
feedback is a greyed button — no "connect your wallet" (there's no
connect affordance in the ticket at all), no "switch network", no
"finish the fields". Same pattern on the guided flows' disabled Sign
button (`OfferFlow.tsx:2440-2444`) and the review checklist lives far
above it. Fix: surface the first blocking reason directly under the
button, and render a Connect button when no wallet.

### UX-010 · "Not enough balance" dead-ends without the faucet (S)
The failing balance checklist item has no `fix` action
(`useEligibility.tsx:106-127`) — on a seeded testnet whose Home
advertises free assets, the most common naive journey (try to lend
with an empty wallet) stops at the final step with nowhere to go. Fix:
link the failing item to `/faucet` on testnets (explainer link on
mainnet).

**Status: ✅ FIXED (batch 4, 2026-07-12).** The failing balance item carries a "Get test assets" link whenever the active chain is a testnet with deployed mocks (same availability predicate as the nav entry).

### UX-011 · Half the product is undiscoverable; mobile "More" strands users in Settings (M)
The Basic/Advanced toggle exists only inside Settings
(`Settings.tsx:63-93`); nothing persistent hints that Offer Book, Rate
Desk, VPFI, or Activity exist (`AppShell.tsx:61-64`). On mobile the
fifth tab is a gear icon labeled "More" that routes to the full
Settings page, with secondary destinations (Vault, Claims, Offer Book,
Help) buried at its bottom. Fix: a persistent mode switch (top bar or
sidebar footer) + a real "More" menu/sheet on mobile.

**Status: ✅ FIXED (batch 4, 2026-07-12).** A Basic/Advanced segmented switch lives in the sidebar footer (desktop) and the new More sheet (phones); the fifth tab is now a real More menu — a bottom sheet listing every destination without a tab (NFT Rental, Claims, vault, faucet, power surfaces, verifier, Settings, Help) plus the mode switch. Settings keeps its explanatory toggle.

---

## P2 — friction

### UX-012 · Telegram link is self-attested and untestable (M)
"Linked" is set by the user clicking "I've done it — the bot replied"
(`AlertsCard.tsx:122-128`); there is no test-notification round-trip,
so a fumbled handshake silently drops the exact deadline/liquidation
alerts the feature exists for. Add "Send test alert" and gate the
linked state on its success.

### UX-013 · No persistent network indicator when connected (S)
`NetworkBanner` renders only on unsupported chains; on a supported one
the current network shows nowhere outside the wallet modal. Offers,
vault, and faucet are all per-network. Show the chain name next to the
ConnectButton.

### UX-014 · Wallet requirement surfaces only at the final review step (S/M)
The guided flows let a disconnected user fill four screens before
revealing "Connect a wallet" in the review checklist
(`useEligibility.tsx:45-58`). Prompt earlier (details step or on
entering terms).

### UX-015 · Raw contract revert text shown to naive users (S)
`CollateralPrecheck` and `SimulationPreview` render decoded revert
strings verbatim (`CollateralPrecheck.tsx:24-27`) — selector-style
jargon on the highest-stakes screen. Map known reverts to plain
sentences; keep raw text behind a details expander.

**Status: ✅ FIXED (#1094, 2026-07-11).** A shared name-keyed error decoder (`lib/errors.ts`) now maps the reverts a normal user can actually reach to plain sentences across `CollateralPrecheck`, `SimulationPreview`, and the pre-sign dry-run footer; any unmapped error humanizes from its NAME (stable across a signature-level change) instead of a hex blob. Complemented by the early under-collateral warning on the borrow terms step (#1112).

### UX-016 · Consent silently un-ticks on term changes / keystrokes (S)
Both the guided review (`OfferFlow.tsx:787-1178` effects) and the desk
ticket (`OrderTicket.tsx:209-214`, every field handler) clear consent
without saying why — it reads as a bug. Show "Terms changed — please
re-confirm" beside the cleared checkbox.

### UX-017 · Invalid inputs signal by color only; disabled CTAs give no hint (S)
Bad pasted addresses get only a red border (`AssetPicker.tsx:180-188`);
empty/zero amounts just disable the button with no message; the
disabled lavender fill reads as almost-active (also flagged visually
on Lend, VPFI, NFT verifier). Inline field hints + a clearly muted
disabled style.

### UX-018 · "Use this offer" is direction-ambiguous on borrow requests (S)
Both card types share the CTA; on a borrow request it makes you the
*lender* — the opposite money direction — with nothing signaling it.
Role-specific CTAs: "Borrow this" / "Fund this request". (Offer rows
also print "1000 bps" beside "10% yearly" — drop the bps duplication
outside Advanced.)

### UX-019 · Offer Book cards crushed two-column on mobile (S)
Title wraps mid-string ("Lending offer ·" / "0.005 WETH"), meta breaks
into 3–4 fragments beside the button (`basic-mobile--offers.png`).
Stack: full-width text, then full-width CTA.

**Status: ✅ FIXED (batch 2, 2026-07-11).** Shared `item-row` rule at ≤480px: text full-width, CTA full-width below — fixes Offer Book and Claim Center cards together.

### UX-020 · Header wallet chip wraps the address onto two lines (S)
"0x1DAe… / 8282" on every mobile page — the orphaned "8282" reads like
a stray number. `white-space: nowrap` on the shortened address.

**Status: ✅ FIXED (batch 1, 2026-07-11).** The connected-address chip renders as one non-wrapping token.

### UX-021 · Unavailable/error states tell users to retry but offer no button (S)
`UnavailableState` has no action slot (`EmptyState.tsx:33-40`) yet its
copy says "try again in a moment" (Positions, Claims, Rent browse,
rewards check, loan-health row). Add a retry action that refetches the
failing query.

**Status: ✅ FIXED (batch 1, 2026-07-11).** `UnavailableState` gained an `onRetry` action, wired on Positions, Claims (list + rewards card), and the Rent browse branch.

### UX-022 · Loading icons don't animate (S)
`EmptyState` renders `LoaderCircle` without the `spin` class
(`EmptyState.tsx:22-24`) — "Loading your positions…" looks frozen on
slow RPCs. One-line CSS fix.

**Status: ✅ FIXED (batch 1, 2026-07-11).** `EmptyState` auto-spins `LoaderCircle` — every loading state animates with zero call-site changes.

### UX-023 · Empty states dead-end on Vault, Claims, Rent, and post-faucet (S/M)
"No vault yet" and empty-assets have no CTA (`Vault.tsx:38-78`); empty
Claim Center has no body/action; empty rental browse is a bare muted
sentence; faucet success offers explorer links but no "now go borrow/
lend" next step — the guided faucet→first-offer path breaks after hop
one. Add forward CTAs to each.

**Status: ✅ FIXED (batch 4, 2026-07-12).** Vault's "No vault yet" and empty-assets states link to the faucet (seeded testnets) or Home; the empty Claim Center explains where claims come from and links to Positions; the empty rental browse points at the list-your-NFT path switch; faucet mint success carries "Next: Borrow against it · Lend it out" links.

### UX-024 · Positions page promises "the one action each needs" but shows none (M)
Cards render status badges only — the Defaulted loan with a claim
waiting says nothing and links nowhere (visual: `basic-desktop--
positions.png`). Add per-card actions ("Claim funds", "Repay") and
group Needs-action / Active / Closed as history grows.

**Status: ✅ FIXED (batch 4, 2026-07-12).** Loans group into "Needs your attention" / "Active loans" / "Ended loans"; the attention group is fed by the same chain-confirmed `getClaimable` query the Claim Center runs (shared cache) and its rows carry an explicit "Claim waiting" chip. While that read is loading or unavailable the list degrades to Active/Ended — it never guesses a claim.

### UX-025 · While role verification runs, the detail page's main action vanishes silently (S)
`role === 'checking'` renders `null` in the action region
(`PositionDetails.tsx:1834-1849`) — a borrower mid-repay sees the
receipt but no Repay button. Render a disabled "Confirming your
role…" state.

### UX-026 · Basic user landing on /desk or /offers gets no orientation (S)
Both are URL-reachable in Basic by design, but nothing says "this is a
power surface" or routes back to the guided flows. Dismissible banner
with links (and an "enable Advanced" action).

**Status: ✅ FIXED (batch 4, 2026-07-12).** `PowerSurfaceNote` renders on /offers and /desk in Basic mode: names the surface, links to the guided flows, offers "enable Advanced mode", and remembers dismissal per browser. Never shown in Advanced.

### UX-027 · Desk ticket lacks Max buttons and any fee/total preview (M)
Amount/collateral are free-typed 18-decimal fields with no
balance-fill (`OrderTicket.tsx:850-917`; `exactAmountString` exists
for exactly this); protocol fees load but are never shown — no
escrowed-total or net-rate line before consent. Add Max chips + a live
fee/total summary.

### UX-028 · Ladder scanability + a11y (M)
Numbers left-aligned with inconsistent decimals ("5%" over "12.25%"),
rows are `role="button"` wrapping nested Take/Fill controls
(`RateLadder.tsx:105-167`), Signed-chip variants and own-order marker
are tooltip/color-only, asks reuse the error red. Right-align with
tabular-nums + fixed decimals, un-nest the interactive elements, give
chips visible text/aria, neutral ask/bid palette.

### UX-029 · VPFI page: the one switch that matters is a tiny checkbox, and status ignores wallet balance (S/M)
The fee-discount opt-in is an 18 px checkbox below a secondary button
(`Vpfi.tsx:478`), disabled silently on wrong networks; the status card
says "0 VPFI / no discount" while the form's fine print shows 25,000
VPFI in the wallet. Promote to a full-width toggle row with inline
wrong-network hint; add "In your wallet: X — deposit to activate" to
the status card.

### UX-030 · Jargon without inline definition on consent surfaces (S)
"grace period", "liquidation", "default", "not priced by the protocol"
appear at the highest-stakes moments with no gloss (copy.ts:355-356,
799-802); advanced-mode HF/LTV numbers get no tooltip. One-clause
inline glosses + Help links.

**Status: ✅ FIXED (batch 3, 2026-07-11).** "Grace period" is glossed inline where it appears ("a short extra window to repay before the lender can take the collateral"), with the concrete window length when the live read has it; the illiquid-asset consent warning now explains "not priced by the protocol" in consequences; the advanced HF/LTV parenthetical defines both numbers in one clause each.

### UX-031 · No skip link / focus management on route change (M)
No skip-to-content anchor; focus stays on the clicked NavLink after
SPA navigation so new content is never announced (`AppShell.tsx:112-165`).
Add the anchor + focus the page h1 on pathname change. Related: /offers
and the 404 (and full-page EmptyStates generally) render no `h1` —
confirmed mechanically by the sweep's landmark probe.

### UX-032 · NFT verifier is unreachable without a deep link (S)
A trust tool for exactly the off-platform user, absent from all nav
and Help. Add to secondary nav / Help ("Check a position NFT before
you buy").

**Status: ✅ FIXED (batch 4, 2026-07-12).** "NFT verifier" now sits in the secondary nav (desktop sidebar + phone More sheet). The Help-page mention lands with UX-049 (the Help content catch-up).

### UX-033 · Wallet-SDK analytics phone home (S)
Consistent with the zero-real-error baseline above: the WalletConnect/
Coinbase "Analytics SDK" fetch failures observed during the sweep are
classified as environmental noise (they fire only where egress is
restricted, as in the review sandbox). The finding is that the SDKs
phone home at all — disable their analytics for privacy, which also
keeps consoles clean on locked-down networks.

---

## P3 — polish

- **UX-034** Nav labels vs page titles drift ("Claims"→"Claim Center",
  "My vault"→"Your Vaipakam Vault", …) — pick one name each. (S)
- **UX-035** VPFI tier table boundaries overlap (1,000/5,000/20,000
  each in two tiers; sub-100 unaddressed). (S)
- **UX-036** Desk term chips: selected 29d + bold 30d look
  double-selected; only the selection should carry weight. (S)
- **UX-037** Desk header stats show bare "—" and three empty-state
  voices in one region; unify + hide TradingView credit until a chart
  renders. (S)
- **UX-038** Σ column header — label it "Depth", tooltip the rest. (S)
- **UX-039** Wizard stepper wraps on mobile, orphaning "Done";
  compact "Step 1 of 5" under ~400 px. (S)
  **Status: ✅ FIXED (batch 2, 2026-07-11).**
- **UX-040** Empty-matches state in the guided flows doesn't reuse
  `EmptyState`; visual inconsistency with sibling pages. (S)
- **UX-041** Done screen offers no "Start another". (S)
- **UX-042** Addresses (vault, faucet contracts) lack one-tap copy and
  use ~16 px link glyphs on mobile — sub-44 px targets. (S)
  **Status: ✅ FIXED (batch 2, 2026-07-11).**
- **UX-043** Telegram "Linked on another device? / Unlink here"
  centered link pair is an ambiguous small target. (S)
- **UX-044** Raw ISO build timestamp in the Help footer — format as a
  date, keep the full string in diagnostics. (S)
- **UX-045** MatchBand "earn the matcher fee" doesn't state you pay
  gas up front. (S)
- **UX-046** Open-orders fill % truncates (99.6 % → "99 %", <1 % →
  "0 %" with a visible bar); round and show remaining size. (S)
- **UX-047** Rent landing is two cards in a sea of whitespace — add a
  browse strip or honest empty section. (S/M)
- **UX-048** Faucet card-in-card nesting + ragged mint-button
  alignment; flatten and fix the button column. (S)
- **UX-049** Help page lags features: nothing on modes, alerts setup,
  Claims, wrong-network, or the NFT verifier. (S)
- **UX-050** Activity page is advanced-only and all-or-nothing when
  the indexer degrades; link basic users to it from Positions and fall
  back to the on-chain loan list. (M)
  **Status: ✅ FIXED (batch 6, 2026-07-12).** Positions carries a "See your full activity history →" link (both modes, since Basic doesn't get Activity in the nav); the Activity page's indexer-degraded unavailable state now points to the chain-authoritative Positions page instead of dead-ending.

---

## Suggested working order

1. **Trust batch (mostly S):** UX-001, UX-002, UX-007, UX-020, UX-021,
   UX-022 — visible correctness/trust wins, each small.
2. **Mobile batch:** UX-006, UX-019, UX-039, UX-042 (+ re-sweep with
   the driver to verify).
3. **Risk-visibility batch:** UX-003, UX-004, UX-030.
4. **Dead-end/discovery batch:** UX-010, UX-011, UX-023, UX-024,
   UX-026, UX-032.
5. **Performance:** UX-005 (splash first — one file; then route
   splitting).
6. **Activity rebuild:** UX-008 (+ UX-050).
7. **Desk ergonomics:** UX-009, UX-016, UX-027, UX-028, UX-036–038,
   UX-045, UX-046.
8. Remaining P2/P3 as fillers.

Re-run `live-ux-sweep.mjs` after each batch — the screenshots +
report.json make before/after diffs cheap, and the landmark/console
probes catch regressions mechanically.
