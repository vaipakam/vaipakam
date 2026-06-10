## Thread — T-087 Sub 4 phase 2 — Stake VPFI CTA + chain-switcher + manual tier-poke button (PR #<n>)

Frontend UX completion of T-087 Sub 4. Phase 1 (#482) shipped the contract foundation (`pokeMyTier()` selector + tracked-tier getters), the user-scoped `useEffectiveDiscount` hook, and the LenderDiscountCard "min-history pending" copy. This phase 2 ships the dashboard-side surface that uses all of it.

### What changes

**New `StakeVPFICTA` component on the Dashboard**

A self-hiding card that renders ONLY when the user has a tier-related action to take:

- **On a mirror chain**: shows "VPFI staking is managed on {canonical}. Switch chains to stake or check your tier." + a one-click "Switch to {canonical}" button (uses `useWallet().switchToChain`). Without this, a user landing on a mirror with no stake had no on-ramp to staking — they had to manually find the chain switcher in the topbar.

- **On the canonical chain, no stake yet**: shows "Stake VPFI on this chain to start earning a discount on the protocol's yield fee. Tier 1 starts at 100 VPFI." + a "Stake VPFI now" CTA linking to the Buy VPFI page (where the existing buy + deposit-to-vault flow lives).

- **On the canonical chain, tier waiting to propagate (min-history pending)**: shows "Tier update pending propagation" notice + a "Push my tier to mirrors now" button wired to `pokeMyTier()`. The button:
  - Fires the contract call via wagmi `useWalletClient().writeContract`.
  - Awaits the receipt via the public client.
  - Reloads the tier data so the dashboard reflects the post-poke state.
  - Surfaces any error inline (warning alert) — no silent failures.

When none of the above applies (settled tier on canonical, or user simply hasn't connected a wallet), the card renders nothing — Dashboard stays uncluttered.

**Wiring**

- Mounted in `Dashboard.tsx` next to `VPFIDiscountConsentCard`. Same visual cluster as the consent toggle since they're tied to the same fee-discount intent.
- i18n strings added under `stakeVpfiCta.*` in `en.json` (other locales fall back to English until translator pass).

### Test coverage

UX-only PR — no new contract surface. The phase-1 `PokeMyTierTest` covers the on-chain behaviour the button triggers; the component itself is a thin wrapper around hooks + writeContract that's exercised by visual smoke + tsc.

### Out of scope (Sub 5)

- Mounting the same CTA on Offer / Loan pages (the card was scoped to Dashboard for this phase; the cross-page propagation is a separate sub-card).
- Indexer event handlers for `TierPoked` (Sub 5).
- The functional-spec + Advanced UG additions (Sub 5).
- "Your tier is ready — claim on mirrors" CTA variant (waits on Sub 5 indexer + mirror cache polling).

### Verification

- Frontend tsc clean.
- Visual smoke on Dashboard with disconnected wallet (card hidden), connected on Base with no stake (Stake CTA shown), connected on Sepolia (switch-to-Base CTA shown).
