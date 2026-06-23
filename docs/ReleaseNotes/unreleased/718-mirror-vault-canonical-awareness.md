### #718 — canonical-aware VPFI vault page on mirror chains

VPFI fee-discount tiers are resolved from your vault balance on the canonical
chain and propagated to every other ("mirror") chain. The VPFI vault page's
discount-status card now reflects that correctly when you're connected to a
mirror chain:

- The tier shown is your real effective tier (it was already correct — it reads
  the propagated value), but the card no longer implies the balance shown on the
  current chain is what sets it. The balance is labelled "Vault VPFI (this
  chain)", and its sub-label now reads "held on this chain to use your discount —
  your tier is set by your balance on <canonical chain>".
- The "deposit X more to reach the next tier" hint — which is computed from the
  local balance — is hidden on mirror chains (depositing locally can't raise a
  tier that's driven by the canonical-chain balance). On the canonical chain it
  behaves exactly as before.
- A short banner on mirror chains explains the model: your tier is set on the
  canonical chain and applies everywhere automatically; VPFI you deposit on the
  current chain lets you *use* that discount on that chain's loans; to change
  your tier, manage VPFI on the canonical chain.

Deposits and withdrawals stay available on every supported chain — holding VPFI
locally is still what lets the discount apply to that chain's loans — they're
just framed honestly now. No on-chain behaviour changed; this is a display /
copy correctness fix.
