### #718 — canonical-aware VPFI vault page on mirror chains

VPFI fee-discount tiers are resolved from your vault balance on the canonical
chain and propagated to every other ("mirror") chain. The VPFI vault page's
discount-status card now reflects that correctly when you're connected to a
mirror chain:

- The tier shown is your real effective tier (it was already correct — it reads
  the propagated value), but the card no longer implies the balance shown on the
  current chain is what sets it. The figure shown is now the **protocol-tracked**
  vault balance (the deposit-flow balance the discount math counts — direct
  transfers to the vault are excluded), labelled "Vault VPFI (tracked, this
  chain)", and points to the canonical chain as where the tier is set.
- The "deposit X more to reach the next tier" hint — now computed from the
  tracked balance — is hidden on mirror chains (depositing locally can't raise a
  tier that's driven by the canonical-chain balance). On the canonical chain it
  behaves as before, just based on tracked rather than raw balance so dust can't
  spuriously show "qualifies".
- A short banner on mirror chains explains the model: your tier is set on the
  canonical chain and mirrored here via cross-chain propagation; it applies on
  this chain's loans only once you enable the discount consent on this chain;
  protocol-tracked VPFI you deposit here (through the deposit flow) is what lets
  that discount apply locally; to change your tier, manage VPFI on the canonical
  chain.
- The canonical-chain name shown is derived from the active network's
  environment (testnet vs mainnet), so a testnet-mirror user sees the testnet
  canonical chain rather than the mainnet default.

Deposits and withdrawals stay available on every supported chain — holding
protocol-tracked VPFI locally is what lets the discount apply to that chain's
loans — they're just framed honestly now. The on-chain discount mechanics are
unchanged; this is a display / copy correctness fix.
