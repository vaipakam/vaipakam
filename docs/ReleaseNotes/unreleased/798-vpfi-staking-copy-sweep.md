## VPFI copy sweep — no more "buy / stake / yield" language (#798)

After the legal-surface excision that removed the fixed-rate VPFI sale and the
staking-yield program, some user-facing copy still implied you could buy VPFI from
the protocol or earn a staking APR on vault-held VPFI. Vault VPFI only ever gives
**fee discounts** now (deposit / withdraw / hold), and interaction rewards are
separate.

This sweeps the **English** (canonical) copy across the connected app and the
marketing site:

- Removed the stale, unused "earn the protocol APR on VPFI in your vault" string
  from the connected app's locale files.
- Rewrote the app FAQ so it no longer describes a fixed-price buy or an in-app
  "Buy VPFI" purchase flow — it now says VPFI is acquired on the open market or
  bridged by the user, and the in-app VPFI Vault is for depositing and holding
  VPFI to earn fee discounts.
- Swept the marketing site's "Stake / Unstake VPFI" labels, taglines, and the
  consent/tooltip copy to deposit / withdraw / hold wording.

No behaviour, route, or contract change — back-compat routes (the old
`/buy-vpfi` link) and code identifiers are intentionally untouched. The
non-English translations still carry the old terms in places and need a separate
translation pass to match the corrected English source.
