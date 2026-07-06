### Copy and legal honesty batch (alpha02)

Three small alignment items from the spec-vs-app audit (#1030):

- The mandatory consent line ("I understand and agree to the Risk
  Disclosures and Vaipakam Terms") now carries real links: "Risk
  Disclosures" opens a new plain-language risk section on the Help
  page, and "Vaipakam Terms" opens the marketing site's Terms of
  Service — both in a new tab so the flow being signed is not lost.
  Previously both phrases were dead text.
- The Help page now states the platform disclaimer exactly as the
  specification mandates it — "Vaipakam is a decentralized,
  non-custodial protocol. No KYC is required. Users are responsible
  for their own regulatory compliance." — instead of a paraphrase
  that dropped the KYC sentence.
- Wallet addresses with an ENS name now display that name (the
  connected-wallet chip and the offer book's "by …" attribution);
  everything else keeps the shortened address. Pure display sugar —
  names never participate in any check or verdict, and asset
  addresses deliberately stay hex.
