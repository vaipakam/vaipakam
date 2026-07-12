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
