## Thread — VPFI legal-program copy + orphan sweep (PR #<n>)

The final, non-contract half of the #687 VPFI legal-surface excision: the
residual frontend copy, marketing/user-guide/whitepaper text, i18n strings, and
vestigial deployment plumbing left behind once the fixed-rate sale (#711), the
5% staking yield (#714), and the buyback overflow tier (#715) were removed from
the contracts.

What changed:

- **Connected app (apps/defi)** — the VPFI page's i18n namespaces were renamed
  to match the page (`buyVpfi.*` → `vpfiVault.*`, `buyVpfiCards.*` →
  `vpfiVaultCards.*`) across all ten locales, every dead sale/staking-yield key
  was deleted (the old buy-step, the staking-rewards claim strings, the
  staking-APR card-help), in-app `/buy-vpfi` links were repointed to
  `/vpfi-vault`, and `BuyVPFI.tsx` was renamed to `VPFIVaultAndDiscounts.tsx`.

- **Marketing site (apps/www)** — every description of the fixed-rate sale and
  the staking yield was removed or reworded across the overview, both
  user-guide tiers, and the whitepaper in all ten languages, plus the
  marketing page, nav/hero/footer CTAs (route `/buy-vpfi` → `/vpfi`), the i18n
  bundles, and the glossary. The whitepaper allocation table folds the freed
  25% (sale 1% + staking 24%) into a Reserve line **explicitly flagged as a
  pending governance decision** — its final disposition (hold, burn-to-reduce
  the cap, or reallocate) is the owner's call, not asserted here.

- **Shared package + deployment artifacts** — the now-dead `vpfiBuyAdapter` /
  `vpfiBuyReceiver` / `vpfiBuyPaymentToken` deployment keys were dropped from
  the `Deployment` / `ChainConfig` types, the consolidated `deployments.json`,
  and every per-chain `addresses.json`, with the matching reads removed from the
  app config.

- **Keeper bot (sibling repo)** — the per-facet ABIs the bot reads were
  re-synced to the post-excision contract surface (a separate PR there).

Verified: `tsc` green for every workspace (defi/www/agent/keeper/indexer);
all locale JSON valid; no rendered string carries sale or staking-yield copy.

Closes #712. Completes the on-chain + off-chain #687 excision.
