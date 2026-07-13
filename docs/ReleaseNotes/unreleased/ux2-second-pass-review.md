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
