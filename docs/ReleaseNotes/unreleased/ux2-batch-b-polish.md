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
