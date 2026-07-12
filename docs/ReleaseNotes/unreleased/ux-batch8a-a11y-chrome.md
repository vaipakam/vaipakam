### Accessibility + header chrome — skip link, route focus, network indicator, readable build date (UX-031 / UX-013 / UX-044)

- **Skip link + focus on navigation (UX-031).** A "Skip to content" link is
  now the first thing keyboard focus reaches (off-screen until focused),
  jumping past the nav to the page body. After any in-app navigation, focus
  moves to the main content region so screen-reader users land on the new
  page instead of staying on the link they clicked. The not-found page now
  carries a proper top-level heading.

- **Persistent network indicator (UX-013).** When connected on a supported
  network, a small chip beside the wallet button shows the current chain
  name (the book, vault, and faucet are all per-network, and the chain name
  otherwise only appeared inside the wallet modal). An unsupported network
  still shows the existing warning banner.

- **Readable build date (UX-044).** The Help footer shows the build date in
  a readable form instead of a raw machine timestamp; the full string
  remains available in the diagnostics drawer.
