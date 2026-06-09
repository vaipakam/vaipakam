## Thread — T-087 Sub 2.E: integration test + FunctionalSpec + Advanced UG addendum (PR #<n>)

Fifth and final slice of T-087 Sub 2. Closes the cross-chain tier propagation work with a happy-path end-to-end integration test, the code-free functional spec, and a user-facing addendum.

### Integration test

New `contracts/test/CrossChainTierPropagationIntegrationTest.t.sol` wires the full Sub 2.A–D chain against a `MockCcipRouter`:

- A canonical Base diamond with the broadcast facet cut, a real `CcipMessenger`, and a real `VaipakamRewardMessenger` configured with one mirror destination.
- A funded `protocolBroadcastBudget` so the rollup's fail-CLOSED gate doesn't trip.

Two tests:

- `test_DepositVPFI_TriggersBroadcastToMirror` — first deposit silent-skips (pre-min-history; resolves to (0, 0)); after the `cfgTwaMinStakedDays` elapse, a 1-wei top-up triggers a fresh rollup → the de-dup gate sees the new non-zero tuple → ProtocolBroadcastFacet quotes, debits, sends. Asserts `router.pendingCount() == 1` + `getUserTierPushNonce(user) == 1`.
- `test_DepositVPFI_DustTier0_SilentSkip` — a sub-tier-1 dust deposit resolves to (0, 0) AND last-pushed is (0, 0), so the round-2 P1 #3 silent-skip fires; `router.pendingCount() == 0`. Closes the dust-deposit drain vector that earlier rounds caught.

This is NOT a fork test against live Chainlink CCIP testnets — those require operator-run RPC infrastructure and are tracked separately in the cutover runbook. The mock-router integration catches the same regressions across the rollup → broadcast → messenger chain at unit-test speed.

### FunctionalSpec

New `docs/FunctionalSpecs/CrossChainTierPropagation.md` — code-free, implementation-independent spec of cross-chain tier propagation. Six sections:

1. A user's tier is decided on Base.
2. The canonical chain broadcasts on every nonce-bumping mutation (including the de-dup gate rationale).
3. The mirror cache writer applies trust + ordering rules.
4. The cross-chain push is protocol-funded with fail-CLOSED semantics.
5. Version bumps are atomic across the broadcast set.
6. Decay is enforced by the cache freshness gate, not by mirror computation.

Plus what the spec does NOT cover (out-of-scope cross-references to Sub 3 / Sub 4 / Sub 5), operator-visible failure modes (`ProtocolBudgetExhausted`, `NoBroadcastDestinations`, `StaleNonce`), and the trust-model summary.

### Advanced User Guide addendum

`apps/www/src/content/userguide/Advanced.en.md` gets a new "How your VPFI tier travels across chains" section under the Buy VPFI flow. Plain-language for end users:

- You stake on Base; other chains read a cached copy.
- The push is automatic — no "sync my tier" action required.
- Typical propagation time is minutes via CCIP.
- Cache expiry: 60-day max-age backstop.

Includes a link to the FunctionalSpec for users who want the full mechanics. Translation sync is deferred — other locale files keep the previous version until translators catch up, per the existing localisation discipline.

### Scope deferrals

- **Live CCIP fork tests** — require operator-run RPC + funded testnet CCIP lanes. Tracked in the cutover runbook (`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md` § operator gates).
- **Other-locale translations** — translator-driven; Advanced.{de,es,fr,ar,hi,ja,ko,ta,zh}.md keep the previous text until translation sync.

### Verification

- 2 new integration tests pass.
- Deploy-sanity 12/12 still green.
- No new producer artifacts (the test uses existing fixtures + mocks).
