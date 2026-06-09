## Thread — T-087 Sub 2.C: mirror inbound tier-cache writer facet (PR #<n>)

Third slice of Sub 2. Wires the mirror-side Diamond ingress for the cross-chain tier push that Sub 2.B's messenger forwards. The mirror's `s.userTierCache[user]` writer + `s.currentTierTableVersion` raise live in a new dedicated facet; the existing Sub 1.C `LibVPFIDiscount._mirrorEffectiveTierAndBps` read path (with its four freshness gates) reads what this facet writes.

### New facet: `MirrorTierReceiverFacet`

Four public selectors:
- `onTierUpdateReceived(srcChainId, user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion)` — called by the messenger on inbound `MSG_TYPE_TIER_UPDATED`. Writes the cache + stamps `lastUpdateSec = block.timestamp` (local clock, so `cfgMirrorTierMaxAgeSec` backstop is local-time-based, not Base's clock).
- `onVersionBumpedReceived(srcChainId, newVersion)` — called on `MSG_TYPE_VERSION_BUMPED`. Raises `currentTierTableVersion` via `max(current, new)` so out-of-order delivery is benign.
- `getUserTierCache(user)` — public read of the full struct for off-chain monitoring + tests.
- `getCurrentTierTableVersion()` — mirror's current version for "behind by version" detection.

### Trust gates

- **Sender:** `msg.sender == s.rewardMessenger`. The messenger has already authenticated the CCIP source + channel peer + payload shape; the facet trusts what it forwards. Caller mismatch → `NotMessenger(caller)`.
- **Source chain:** `srcChainId == s.baseChainId`. Catches a misconfigured peer where another mirror sends a tier push to a mirror (only Base may push). Mismatch → `WrongSourceChain(got, expected)`.
- **Monotonic order:** `nonce > cache.lastNonce`. Catches replay and out-of-order delivery; reverts `StaleNonce(got, cached)` before the cache is mutated.
- **Nonce fit:** the cache's `lastNonce` is `uint64`; the messenger payload encodes `uint256`. Anything > `type(uint64).max` reverts `NonceOverflow(got)` rather than silently truncating.

### Messenger forwarding wired

`VaipakamRewardMessenger.onCrossChainMessage` was Sub 2.B's event-only inbound stub; now it forwards both new kinds via the new `IMirrorTierIngress` interface:

- `MSG_TYPE_TIER_UPDATED` → `IMirrorTierIngress(diamond).onTierUpdateReceived(...)`.
- `MSG_TYPE_VERSION_BUMPED` → `IMirrorTierIngress(diamond).onVersionBumpedReceived(...)`.

### Producer artifacts

- New facet cut at index 47 (cuts array 47 → 48) in `DeployDiamond.s.sol`.
- `MirrorTierReceiverFacet` appended to `DiamondFacetNames.cutFacetNames()` (47 → 48).
- `_getMirrorTierReceiverSelectors()` added to `DeployDiamond.s.sol` + `HelperTest.sol` (4 selectors each) and wired into `SelectorCoverageTest._populateRoutedSet`.
- `SetupTest.t.sol` cuts array 48 → 49.
- Cut into `DeployDiamondIntegrationTest`, `FacetSizeLimitTest`, `SelectorCoverageTest` (signature bumps 47 → 48).
- `MirrorTierReceiverFacet.json` regenerated via `exportFrontendAbis.sh`; added to the frontend bundle + barrel re-export + `DIAMOND_ABI` spread.

### Mock extension

`MockRewardDiamond` in `VaipakamRewardFlowTest` extended with `onTierUpdateReceived` + `onVersionBumpedReceived` recorders so Sub 2.B's existing 23 tests continue to pass (the messenger now forwards what was previously stubbed) and so the suite can assert what was forwarded.

### Test coverage

10 new tests in a dedicated `MirrorTierReceiverFacetTest.t.sol`:

- Happy-path cache write + event emit.
- Trust gates: `NotMessenger`, `WrongSourceChain` for both surfaces.
- Monotonic ordering: stale nonce + out-of-order nonce + nonce overflow.
- Version bump: raise on higher, benign no-op on equal / lower.

The 23 Sub 2.B reward-flow tests stay green with the extended mock. Wider sweep: 69 VPFIDiscount + 102 cross-chain tests pass. Deploy-sanity 12/12.

### Out of scope (Sub 2.D / 2.E)

- Auto-broadcast trigger from rollup + protocol broadcast budget + force-resend + sweep helper → Sub 2.D.
- Live CCIP fork tests on Base Sepolia → Sepolia mirror → Sub 2.E.
