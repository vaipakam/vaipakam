## Thread — T-087 Sub 2.B: `VaipakamRewardMessenger` learns `TierUpdated` + `VersionBumped` message kinds (PR #<n>)

Second slice of Sub 2. Adds the outbound surface for the per-user tier push + the tier-table-version bump that the dapp and mirror caches will consume, AND extends the inbound payload-size gate to recognise the new shapes. Sub 2.C wires the receive-side Diamond forwarding; Sub 2.D wires the auto-broadcast trigger from the rollup path.

### New constants

- `MSG_TYPE_TIER_UPDATED = 3` and `MSG_TYPE_VERSION_BUMPED = 4` join the existing REPORT/BROADCAST tags.
- `TIER_UPDATED_PAYLOAD_SIZE = 8 × 32` for `(kind, user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion)`.
- `VERSION_BUMPED_PAYLOAD_SIZE = 2 × 32` for `(kind, newVersion)`.

### Outbound

- `sendTierUpdate(user, effTier, effBps, computedAt, nonce, tierExpirySec, tierTableVersion, refundAddress)` — Base → every configured mirror per-user push. Diamond-only. `msg.value` must cover the sum of per-destination quotes; surplus refunded. Same `msg-value-loop` pattern as `broadcastGlobal` with the bounded `spent` cumulator.
- `sendVersionBumped(newVersion, refundAddress)` — Base → every configured mirror eager tier-table-version bump on governance threshold / BPS change. Diamond-only.
- `quoteSendTierUpdate(...)` / `quoteSendVersionBumped(...)` — quote helpers that mirror the existing `quoteBroadcastGlobal` shape.

### Inbound

The size gate now accepts THREE valid word counts: 4 (legacy REPORT/BROADCAST), 8 (`TierUpdated`), 2 (`VersionBumped`). Any other length is rejected with `PayloadSizeMismatch` before decode — the legacy padded-packet protection extends symmetrically across all four message shapes.

The decode dispatcher gains arms for `MSG_TYPE_TIER_UPDATED` and `MSG_TYPE_VERSION_BUMPED`. Both reject `isCanonical` reception with `BroadcastOnCanonical` (mirrors only). Both emit a receive-side event (`TierUpdateReceived` / `VersionBumpReceived`) with the round-tripped payload so fork tests + ops monitoring can observe the inbound message.

**Sub 2.B intentionally stops at the receive event.** The Diamond's `MirrorTierIngress` interface that the new arms will call to write the mirror cache + raise `currentTierTableVersion` lands in Sub 2.C — letting that slice land + be reviewed independently. Until 2.C lands, mirrors surface the event-only inbound; their Diamond's `userTierCache` stays unwritten, which falls back gracefully to (0, 0) via the existing Sub 1.C mirror cache read path.

### Test coverage

10 new tests in `VaipakamRewardFlowTest.t.sol` covering:

- Happy-path send + receive event round-trip for both new shapes.
- Sender access control (only the paired Diamond can invoke).
- `BroadcastOnCanonical` rejection for inbound on the canonical instance.
- Per-type size validation (a `TierUpdated`-kind tag wrapped in a 4-word REPORT-sized payload reverts with the exact-size mismatch).
- Outer size gate (a 3-word payload is rejected before decode).
- Quote views return the expected per-destination fee.

Together with the 13 existing reward-flow tests, the messenger suite is 23/23 green. Wider cross-chain sweep: 104 tests pass.

### Out of scope

- Mirror-side Diamond `MirrorTierIngress` interface + cache writes → Sub 2.C.
- Auto-broadcast trigger from the rollup path + protocol broadcast budget → Sub 2.D.
- Force-resend recovery + sweep helper → Sub 2.D.
- Fork tests on Base Sepolia → Sepolia mirror → Sub 2.E.
