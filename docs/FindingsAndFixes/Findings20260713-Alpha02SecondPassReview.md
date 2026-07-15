# Findings 2026-07-13 — alpha02 second-pass live UI/UX review

Second full-surface review of **apps/alpha02** on the deployed testnet
site (alpha02.vaipakam.com, build `1dc607b` — i.e. `main` after the
final UX-batch merge #1175), run the same night the 50-finding
2026-07-11 review closed. Purpose: (1) verify the shipped fixes behave
on the live site, (2) sweep dimensions the first review did not cover —
the **disconnected first-visit state**, and a **second network
(Arbitrum Sepolia)** for the chain-scoped surfaces — and (3) catch
anything the fix batches themselves regressed. New findings carry
`UX2-###` IDs; unmarked findings are OPEN.

## Method + evidence

The committed sweep driver (`apps/alpha02/e2e/live/live-ux-sweep.mjs`)
was extended for this pass from a single connected session to
**sessions × passes** (committed with this review):

| Session | Wallet / profile | Chain | Passes |
| --- | --- | --- | --- |
| `main` (connected) | throwaway KEYS, connected via ConnectKit; **persistent role profile** (`lender` — pristine in this run's fresh container, but not guaranteed clean on re-runs) | Base Sepolia | basic-desktop 1440px · basic-mobile 390px · advanced-desktop |
| `disconnected` | throwaway keys, **never authorized** (driver `preAuthorized:false` + `allowRequestAccounts:false` — a real wallet reports no accounts and rejects unprompted requests until approved) on a **throwaway profile** (`freshProfile:true`) | Base Sepolia | disconnected-desktop · disconnected-mobile |
| `arb` (connected) | throwaway keys; persistent role profile (`newBorrower`, pristine this run) | **Arbitrum Sepolia** | arb-desktop over the chain-scoped routes (/, /offers, /desk, /vault, /vpfi, /settings, /faucet) |

92 full-page screenshots + per-route console stream, network
failures/heavy assets, landmark probes (h1, horizontal overflow,
unlabeled buttons, alt-less images), and the DevTools probe (storage,
IndexedDB, cookies, SW, nav/paint timings, JS heap, long tasks) in
`report.json`. Every screenshot was reviewed visually. The sweep is
read-only (driver-enforced): zero write attempts were logged.

**Sandbox caveats, tagged not hidden:** the review environment relays
all browser traffic through a node-side fetch (the driver's built-in
egress shim), which adds ~1–2 s per request, disables the browser HTTP
cache (per-route asset refetch), and can transiently fail a chunk
fetch. Findings caused by the relay are classified as environment
artifacts below — except where the relay merely *exposed* a real
product gap (UX2-002). The sweep wallet is fresh, so position-rich
states (receipts, grace banners, claim rows) were not re-reviewed here
— they are covered by the first-pass evidence and the fork-tier CI
specs.

## Site-wide health baseline (the good news)

- **Zero real console errors and zero HTTP ≥400s** across all 92 route
  visits in all six passes (17×3 Base-connected + 17×2 disconnected +
  7 Arb; the only tagged noise: the known CSP-blocked Cloudflare
  beacon, and relay-induced aborts).
- **Zero unlabeled buttons, zero alt-less images** on every route,
  every pass — including the two new sessions.
- **Cold-load performance fixes hold on the deployed build**: entry
  chunk **116 KB** (pre-fix monolith: 2,407 KB), boot splash ships in
  the HTML, react/wallet vendor chunks split (226 KB / 1,803 KB
  uncompressed), TTFB 0.4–0.6 s, zero long tasks, JS heap 18–50 MB
  with no growth across 17-route passes.
- **Storage hygiene unchanged**: 3–4 localStorage keys all <1 KB, no
  cookies, no session storage, no service worker; the only IndexedDB
  is the wallet SDKs'. Notably the WalletConnect/Coinbase analytics
  beacons are **absent** from every network log — the UX-033 telemetry
  opt-out verifiably works in production.
- **The Arbitrum Sepolia surfaces are honest**: VPFI shows its
  availability-first "not available on Arbitrum Sepolia yet" banner
  (education table retained, no dead deposit form); the faucet shows
  "Test assets aren't available here" with a Back-to-home CTA; the nav
  hides "Get test assets" on chains without mocks; the Rate Desk
  renders real Arb market data (mUSDC/mWETH, sparse-market dot chart
  with its honest caption, recent fills) with the TradingView credit
  correctly present only because a chart actually drew.

## Fix verification matrix (50-finding review, on the live build)

Directly observed working on `1dc607b`: UX-005 (splash + 116 KB entry +
vendor split), UX-006 (desk single-column on mobile), UX-009 (disabled
Post order shows "Enter the amount above."), UX-011 (persistent mode
switch), UX-013 (network chip, name at desktop, dot on mobile), UX-014
(early connect prompt on step 1, disconnected), UX-018 (+ helper copy:
"Borrow this" / "Fund this request" on live offers), UX-026 (Basic-mode
power-surface banner on /offers and /desk), UX-027 (Max chip), UX-029
(wallet-balance row under the deposit input — but see UX2-004), UX-032
(NFT verifier in nav), UX-034 (page titles — but see UX2-003), UX-035
(half-open tier bands "100 – <1,000 VPFI" incl. the fractional-safe
refinement, live-threshold below-min note), UX-037 (chart credit absent
on empty chart, present on drawn chart), UX-039 (compact "Step 1 of 5"
stepper), UX-042 (copy+explorer chips on faucet rows), UX-043
(labelled "Unlink this wallet" block), UX-044 (readable "Build 1dc607b
· Jul 13, 2026" footer), UX-047 (Rent browse CTA), UX-048 (faucet
single-card row list), UX-049 (all five new FAQ entries). Not
re-observable with a fresh wallet (position-dependent): UX-001/002/003/
004/030 and the desk fill/amend states — covered by fork-tier CI and
first-pass evidence.

Severity: **P1** = misleads or blocks a core journey / trust damage;
**P2** = real friction; **P3** = polish. Effort: S (<½ day), M (a
day-ish), L (multi-day).

## Status ledger

As fix batches land, a row per batch is added here (same convention
as the 2026-07-11 doc) plus a status line under each finding.
Unmarked findings are OPEN.

| Batch | Findings | Status |
| --- | --- | --- |
| A — P2s (2026-07-13) | UX2-001, UX2-002, UX2-006 | ✅ Fixed — structurally shrinkable header chip + phone-tier trims (badge/glyph) with a 390px fork-tier no-overflow spec; splash failure state (HTML-resident 20s timer → plain-words message + Reload); one-line Connect label rides the same header work |
| B — P3 polish (2026-07-13) | UX2-003, UX2-004, UX2-005, UX2-007 | ✅ Fixed — Settings More cards renamed to the nav names; the discount consent is a real switch (track + sliding thumb, focus ring, reduced-motion); faucet + VPFI dead-ends gain one-click "Switch to <chain>" (mocks-bearing / canonical-VPFI chain resolved from the deployments bundle); Activity's empty feed hands over Borrow/Lend CTAs |
| C — perf tail (2026-07-13; hardened after Codex #1200) | UX2-007 (tail), UX2-008 | ✅ Fixed — the ~761 kB Diamond-ABI chunk is split out (`contract-abis`) AND lifted off first paint. Because `React.lazy` fetches on MOUNT, each ABI consumer is gated to when the ABI is actually wanted: Borrow/Lend are lazy routes; Home's positions banner + the shell's SanctionsBanner mount only when connected (the banner behind its own quiet `ErrorBoundary` so a chunk-fetch failure degrades to no banner, not a shell crash); Help renders a non-committal fee card when disconnected and mounts the live-value card (its only ABI dep) only when connected — so a disconnected /help never publishes a possibly-stale hardcoded rate. Runtime-verified: a disconnected `/` and `/help` fetch NO `contract-abis`; `/borrow` does. Activity's hedged empty title stays for EVERY truncated case (a `myLoanIds`-gated clean title would falsely claim "no activity yet" for a returning wallet whose loans aged out of the indexer leg); the fix is the WORDING — it no longer implies older events exist, it states the page's recent-only scope |

---

## P2 — real friction

### UX2-001 · Connected mobile header overflows the viewport on every route (P2 · S)

With a wallet connected, every one of the 17 routes at 390 px reports
`scrollWidth 461` vs `clientWidth 390` — the whole app pans ~71 px
sideways for every connected phone user. The measured culprit is the
header wallet chip (`.btn.btn-secondary`, width 185 px at x=276; the
left cluster logo + alpha badge + network dot already consumes
276 px). The honest disconnected pass shows **zero** overflow on the
same routes, isolating the regression to the connected header cluster
— most likely the UX-013 network chip + UX-021 `nowrap` wallet chip
combining past the width the first-pass mobile fixes budgeted for.
Fix direction: below ~420 px let the wallet chip shrink (shorter
truncation, e.g. `0xA7…380`, drop the wallet glyph, tighter padding)
and/or collapse the alpha badge; add a 390 px fork-tier assertion that
`document.documentElement.scrollWidth === clientWidth` so the class of
bug can't return silently.

**Status: ✅ FIXED (batch A, 2026-07-13).** Two layers: (1) the header
is now STRUCTURALLY unable to widen the page — the wallet chip is a
shrinkable flex item (`min-width:0`) whose label ellipsizes; (2)
phone-tier trims ≤430px hide the alpha badge + wallet glyph and
tighten paddings, and the chain-name hide threshold moved 400→560px
(the 400–560px band still overflowed with the name shown). Verified in
a real browser against a production build at 390px connected:
scrollWidth 461→390 on /, /desk, /vpfi with the address chip intact.
Regression guard: `e2e/tests/20-mobile-header.spec.ts` asserts the
whole-document no-sideways-scroll invariant connected AND disconnected
(the fork fixture gained the live driver's `preAuthorized:false` so
the disconnected state is testable at all).

### UX2-002 · Boot splash has no failure state — a dropped chunk strands users on "Starting up…" forever (P2 · S/M)

One first-visit navigation in the sweep (basic-desktop `/settings`)
lost an asset fetch (`net::ERR_FAILED`); the page sat on the static
splash — logo, spinner, "Starting up…" — for the full 13 s capture
window with no error copy, no retry affordance, and no timeout. The
*trigger* here was the sandbox relay, but the *exposed gap* is real:
on any flaky network, a user whose entry/vendor/route chunk fails
sees an indefinite silent spinner. The app's `vite:preloadError`
reload handler lives in the bundle that failed to boot, so it cannot
rescue this case. Fix direction: a plain-JS timer in the splash HTML
itself (independent of the bundle) that after ~15 s swaps in "This is
taking longer than it should — check your connection and reload" with
a reload button.

**Status: ✅ FIXED (batch A, 2026-07-13).** A plain-JS timer now lives
in `index.html` itself — independent of every asset that can fail.
After 20 s (far beyond the measured 0.7–2 s FCP) with `#boot-splash`
still mounted, it hides the spinner and swaps in "This is taking
longer than it should — check your connection and reload" plus a
Reload button. A normal boot removes the splash long before the timer
fires and the check no-ops. Verified present in the built
`dist/index.html`.

## P3 — polish

- **UX2-003** Settings → "More" cards still carry the pre-rename
  labels — "Claim Center", "Your Vaipakam Vault", "VPFI fee
  discounts" — while the nav and page titles now say "Claims",
  "My vault", "VPFI discounts" (UX-034 missed these three card
  labels). (S)
  **Status: ✅ FIXED (batch B, 2026-07-13).** All three More-card
  titles now match the nav names; the descriptive sub-lines stay.
- **UX2-004** The VPFI "Use my vaulted VPFI for fee discounts"
  consent renders as a bare native checkbox at the row's far edge;
  the batch-8c release note describes a labelled toggle. Either style
  it as an actual switch or keep the checkbox and align the wording —
  as shipped it reads slightly under-designed next to the rest of the
  card. (S)
  **Status: ✅ FIXED (batch B, 2026-07-13).** `.toggle-input` is now a
  real switch — 40×22 track with a sliding thumb, brand fill when
  checked, :focus-visible ring, reduced-motion honoured — so the
  control finally matches the toggle-row pattern (and the release-note
  wording that promised it).
- **UX2-005** The Arb Sepolia dead-ends name the remedy but don't
  offer it: the faucet empty state says "Try a different test
  network" and the VPFI banner says deposits aren't available here,
  yet neither offers the one-click "Switch to Base Sepolia" action the
  app already knows how to render (the unsupported-network banner has
  one, and Help promises it). (S)
  **Status: ✅ FIXED (batch B, 2026-07-13).** Both dead-ends now offer
  the switch when a wallet is connected: the faucet's unavailable
  state targets the first supported testnet whose deployment carries
  `testnetMocks`, and the VPFI banner targets the `isCanonicalVPFI`
  chain (only on the positive not-registered verdict — a failed CHECK
  doesn't claim another chain is the answer). Both resolve the target
  from the deployments bundle, not a hardcoded chain id.
- **UX2-006** The header "Connect wallet" button wraps to two lines
  at 390 px (mobile, disconnected) — cosmetic, but it's the first
  button a new phone visitor sees. (S)
  **Status: ✅ FIXED (batch A, 2026-07-13).** The label is now a nowrap
  single token (same `.connect-label` treatment as the address chip)
  and the phone tier drops the wallet glyph; spec 20's disconnected
  case asserts the one-line render.
- **UX2-007** With a fresh wallet whose indexer lookups time out, the
  Activity page shows the degraded-scan copy ("Older events may exist
  that we couldn't scan right now") rather than a clean "no activity
  yet" — honest, but for a genuinely-new wallet it hedges
  unnecessarily and offers no forward CTA (the UX-023 pattern:
  "make your first move → Borrow / Lend"). Worth revisiting alongside
  the indexer-timeout tuning for slow networks. (S)
  **Status: ✅ FIXED (batch B CTA half + batch C tuning, 2026-07-13).**
  The empty feed (both the clean and the hedged/truncated variants) now
  offers "Borrow something" / "Lend something" forward CTAs (batch B).
  Batch C then addressed the hedged-copy tail. The mis-diagnosis was
  that the hedge was a slow-network artefact; it's structural — the
  protocol-wide 5×100 scan can't reach the feed end whenever the testnet
  holds >500 total events, so `truncated` stays true for ANY wallet,
  including a brand-new one with nothing. An initial attempt gated the
  clean title on `myLoanIds.size > 0`, but Codex #1200 correctly showed
  that makes a FALSE "no activity yet" claim for a returning wallet whose
  only loans are closed/transferred and older than the scan window
  (those aren't in `myLoanIds` once they age out of the indexer leg). So
  the hedge stays for every `truncated` case (it is never false), and
  the fix is in the WORDING instead: the hedged copy no longer asserts
  "older events may exist that we couldn't scan" (which read as an
  unnecessary hedge implying hidden history for genuinely-new wallets)
  — it now states the page's recent-only scope ("This page lists recent
  activity only, so anything older isn't shown here"), which is true
  whether or not the wallet has history. Both variants keep the batch-B
  Borrow/Lend forward CTAs. A definitive clean "no activity yet" for a
  PROVEN-new wallet still needs the participant-history route (#1023).
  *(2026-07-15 update: #1023 shipped — Activity now unions the
  `/loans/by-participant?scope=all` ids into its filter, so LOAN events
  beyond the held-position window are caught. The recent-only hedge
  stays for truncated feeds regardless: offer-only history older than
  the scan window is still outside any loan-id set.)*
- **UX2-008** The ABI bundle (`abis-*.js`, ~761 KB uncompressed) loads
  on every surface's critical path. It's one shared chunk today;
  splitting the rarely-read facet ABIs (or deferring until first
  contract read) would trim first-paint bytes on marketing-ish routes
  like Home/Help. Enhancement candidate, low urgency. (M)
  **Status: ✅ FIXED (batch C, 2026-07-13; hardened after Codex #1200).**
  Two moves. (1) The combined Diamond ABI is now its own Rollup chunk
  (`contract-abis`, matched in `vite.config.ts:manualChunks`) — lifted
  out of the every-deploy entry chunk, downloaded in parallel, and
  long-cached (ABIs change only on a contract deploy, so the hash
  survives ordinary app deploys and every in-app navigation reuses it).
  (2) It is lifted off the FIRST-paint critical path. The subtlety Codex
  #1200 caught: `React.lazy` fetches its chunk the moment the component
  *mounts*, so merely making the ABI consumers lazy wasn't enough — an
  unconditionally-rendered lazy child still pulls the ABI right after
  paint. Each consumer is therefore gated so it only mounts when the ABI
  is actually wanted: **Borrow/Lend** are lazy routes (loaded on
  navigation, which is when their contract flow is needed); **Home's
  active-positions banner** and the shell's **SanctionsBanner** mount
  only when a wallet is connected (a disconnected visitor has no
  positions and no address to screen); **Help's fee FAQ** renders a
  NON-COMMITTAL fee card for disconnected visitors (the fee structure in
  words + "connect for the exact current rates", never a specific
  percentage it hasn't read live, so a governance re-tune can't strand a
  stale number) and mounts the live-value card (its only ABI dependency,
  itself gated on `fees.ready` so an in-flight read never shows a default
  as an exact rate) only when connected. Verified at
  **runtime**: a disconnected `/` and `/help` paint fetch NO
  `contract-abis` request, while `/borrow` (a real action route) does;
  the entry `modulepreload` set is ABI-free (only react/wallet vendors).
  Connected users, who need the ABI for reads anyway, load it on demand.
  The always-on sanctions *gate* still runs at the contract level; only
  its advisory banner is deferred.

## Environment artifacts (recorded, NOT product findings)

- Relay latency (~1–2 s/request) inflates all `loadMs` figures; the
  DevTools TTFB (0.4–0.6 s) is the truer signal.
- Route interception disables the browser HTTP cache, so vendor/ABI
  chunks re-download per route — production users get normal caching.
- `HEAD /` and two indexer `by-lender`/`by-borrower` aborts per pass
  are the app's own timeouts firing under relay latency.
- The first "disconnected" run silently connected: the driver's
  injected wallet reported accounts on `eth_accounts` pre-approval
  (a real wallet doesn't), so wagmi treated it as an authorized
  session. Fixed in the driver (`preAuthorized:false`) and re-run —
  kept here as a note for future sweep readers, and as the reason the
  driver option exists.
- The Cloudflare-insights CSP beacon failure is long-known noise.

## Follow-ups owed by this review

1. Fix UX2-001 and UX2-002 (P2s) — small, high-leverage.
2. Sweep the UX2-003/004/005/006 polish batch.
3. Consider UX2-007/008 alongside future perf/indexer work.
4. The sweep now covers disconnected + second-chain sessions; keep
   running all six passes in future review nights (they cost ~10 min
   total and caught both P2s here).
