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
