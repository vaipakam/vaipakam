### UX2 batch C — ABI off the first-paint path + honest Activity empty (UX2-007 tail / UX2-008)

- **The ~761 KB contract-ABI no longer weighs on the landing page
  (UX2-008).** The combined Diamond ABI is now its own long-cached
  chunk, and the three things that used to drag it onto every route's
  first paint — the Borrow and Lend pages, Home's "you have N positions"
  nudge, and the shell's sanctions banner — now load on demand. A
  visitor opening the home or help page (before connecting a wallet)
  downloads none of it; it arrives only when a wallet connects or a
  contract-reading screen is opened. Because the ABI changes only when
  the contracts are redeployed, its file stays cached across ordinary
  app releases, so repeat visits and in-app navigation reuse it. The
  trade is a brief in-app "Loading…" the first time Borrow or Lend is
  opened — the same treatment every other screen already had.
- **A brand-new wallet's Activity reads "no activity yet" again
  (UX2-007 tail).** The hedged "older events may exist that we couldn't
  scan" line was appearing for wallets that had simply never done
  anything — an artefact of scanning the busy protocol-wide feed, not a
  slow network. Activity now shows that hedge only when the wallet
  actually holds loans whose history is older than the recent scan
  window; a wallet with nothing sees the clean empty state and its
  Borrow / Lend next-step buttons.
