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
  spoofed-Origin caller can't spam a linked wallet's chat; the test message
  is localized across all ten Worker locales. **Note:** the agent Worker must
  be redeployed for the endpoint to exist live.

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
  your wallet" balance row; the fee-discount tier table uses exclusive upper
  bounds so each threshold appears in exactly one row, with a note for the
  sub-100 band that earns no discount; the faucet page collapses its
  per-token cards into one card with a row list.

- **Input-hint + FAQ + discovery polish (UX-017 / UX-047 / UX-049).** A
  malformed pasted token address now gets a plain-words hint (not just a red
  border), disabled primary buttons are visibly dimmed; the Rent landing
  gains a "Browse NFTs available to rent" CTA; and the Help page gains five
  FAQ entries (Basic/Advanced modes, alert setup, Claim Center, wrong-network
  switch, NFT verifier).

Closes the batch-8 remainder of the 2026-07-11 alpha02 UI/UX review
(`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`), leaving no
open findings in that document.
