## Thread — T-087 Sub 1.D: `getEffectiveDiscount` view + frontend lender-discount hook rewire (PR #<n>)

Fourth slice on the T-087 cross-chain reward redesign. Builds on Sub 1.C (PR #448 / issue #443). The scope of this PR is narrower than the original Sub 1.D card #444 anticipated — see "Deferrals" below for what slid into a follow-up.

### `VPFIDiscountFacet.getEffectiveDiscount(user)`

A new external view returning the post-gate `(uint8 effTier, uint16 effBps)` the fee path actually applies. Internally calls `LibVPFIDiscount.effectiveTierAndBps(user)`, which dispatches by `s.isCanonicalVpfiChain` — accumulator on Base, cached `CachedTier` on mirrors — and applies all four mirror-side freshness gates (round-2 P1 #3 + round-6 P1 #9 + round-6 P1 #10 + round-10 P1 #1).

The existing `getVPFIDiscountTier(user)` stays as-is. The two getters answer different questions:

- `getVPFIDiscountTier` — "what tier does my CURRENT STAKE BALANCE imply, ignoring the min-history gate?" Useful for showing "your stake qualifies for tier N" before the user has held the position long enough.
- `getEffectiveDiscount` — "what discount applies RIGHT NOW at a fee charge?" The dapp should drive any "you'll save X% on this fee" math from this getter.

Codex Sub 1.B round-3 P2 #2 caught that the previous shape (a single raw-tier getter consumed by both UI surfaces) showed the user a tier they couldn't claim during the min-history window. The two-getter split answers both questions cleanly.

### `useLoanLenderDiscount.ts` rewire

The Phase-5 hook reconstructed a time-weighted-average BPS client-side from `getUserVpfiDiscountState` + the loan's `lenderDiscountAccAtInit` anchor + a stamped open-period extrapolation. None of that math applies under T-087 — the lender's discount is the INSTANT `effectiveBps` at the moment a fee path reads it.

The rewritten hook just reads `getEffectiveDiscount(lender)` and reports the BPS. The interface keeps `effectiveAvgBps` + `stampedBpsAtPreviousRollup` (both set to the same value) for backward compatibility with `LenderDiscountCard`'s existing drift-indicator; under T-087 semantics that indicator naturally never fires. `windowSeconds` still surfaces loan tenure for any consumer that wants to display it.

### Producer artifacts

- `_getVpfiDiscountSelectors()` in `DeployDiamond.s.sol` grows from 23 → 24 selectors.
- `HelperTest.sol`'s `getVPFIDiscountFacetSelectors()` mirrors the same growth.
- `packages/contracts/src/abis/VPFIDiscountFacet.json` regenerated via `bash contracts/script/exportFrontendAbis.sh`.
- Frontend `pnpm exec tsc -b --noEmit` clean.

### Deferrals

The original Sub 1.D card #444 included:

- **Mirror facet cut deletion** — the `DeployDiamond.s.sol` conditional cut by `isCanonicalVpfiChain` that strips `VPFIDiscountFacet` / `StakingRewardsFacet` / `VpfiBuyAdapter` from mirrors. Deferred. The runtime fence (`setCanonicalVPFIChain(false)` makes `buyVPFIWithETH` revert + makes the mirror dispatch read from the cache instead of the accumulator) already makes the mirror staking surface inert; the cut deletion is a deployment-size optimisation, not a correctness gate. Tracked on the umbrella for a follow-up alongside Sub 2's CCIP wiring (mirrors get configured at the same operator-action checkpoint).
- **Generic vault VPFI flow rollup hook** (Sub 1.B round-3 P2 #4) — needs careful coordination with the vault chokepoint in `VaultFactoryFacet`. Tracked on the umbrella.

### Verification

131 tests passing across touched surfaces — VPFIDiscount 44/44 + RepayFacet 75/75 + deploy-sanity 12/12. Quick-profile build clean. Frontend `pnpm exec tsc -b --noEmit` clean.
