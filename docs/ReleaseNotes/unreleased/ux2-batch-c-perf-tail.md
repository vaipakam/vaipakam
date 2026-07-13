### UX2 batch C — ABI off the first-paint path + honest Activity empty (UX2-007 tail / UX2-008)

- **The ~761 KB contract-ABI no longer weighs on the landing or help
  page (UX2-008).** The combined Diamond ABI is now its own long-cached
  chunk, and the things that used to drag it onto every route's first
  paint now load only when they're actually needed: the Borrow and Lend
  pages load on navigation; Home's "you have N positions" nudge, the
  shell's sanctions banner, and Help's live-fee answer load only once a
  wallet is connected (a disconnected help visitor sees the fee answer
  with the standard published rates, and any live re-tuned value appears
  on connect and in the receipt they sign). A visitor opening the home
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
