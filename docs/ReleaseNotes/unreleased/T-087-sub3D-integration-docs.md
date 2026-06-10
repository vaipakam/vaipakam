## Thread — T-087 Sub 3.D: integration test + FunctionalSpec + Advanced UG (PR #<n>)

Closes out Sub 3 (treasury buyback umbrella #452). Sub 3.A (Base-side absorb) + Sub 3.B (intent ledger + dispatcher refactor) + Sub 3.C (Fusion TWAP + validation + agent) are now wired together by an end-to-end integration test, documented in a new FunctionalSpec entry, and made user-discoverable in the Advanced User Guide.

### What changes

**End-to-end integration test — BuybackEndToEndIntegrationTest.t.sol**

Two tests demonstrating the full buyback flywheel:

- `test_EndToEnd_AbsorbCommitFillCycle` — absorb a Base-side remittance, open a validated commit, simulate a Fusion solver running two partial fills (40% + 60%), then assert terminal invariants: order Filled, kind/validated cleared, LOP allowance fully released, signature now invalid, staking pool budget credited with both partial-delivered VPFI amounts.
- `test_EndToEnd_ExpireAfterPartial_ReturnsUnconsumed` — same start, but only a 30% partial fill, then warp past the deadline and expire. Asserts: 70% returns to budget; the 30% already-swapped portion stays in the staking pool; order marked Expired.

The Fusion-side simulation is a minimal mock that satisfies the LOP DOMAIN_SEPARATOR view and acts as the authorised caller for the diamond's pre/postInteraction hooks. Combined with the unit-level partial-fill tests in BuybackValidatedCommitTest, this gives a complete end-to-end picture of the flywheel without depending on real CCIP routing or a live Fusion solver.

**FunctionalSpec entry — docs/FunctionalSpecs/TreasuryBuyback.md**

Code-free spec covering:

- Per-chain budget accumulation (admin allocator, no-convert list, allow-list, tranche cap).
- Cross-chain remittance flow (CCIP delivery, source vs destination token mapping, fee-on-transfer safety).
- Validated commit lifecycle (on-chain orderHash recomputation, makerTraits binding, canonical extension layout).
- TWAP partial-fill semantics + cumulative pro-rata floor + how constant buy pressure emerges from queued solver auctions.
- Operator-visible failure modes table.
- Staker-facing accumulation in stakingPoolBuybackBudget.
- Out-of-scope deferrals clearly listed (Sub 3 add-ons #472 / #473 / #474, USD-denominated cap with oracle, productive treasury reserve, live Fusion testnet rehearsal).

**Advanced UG addendum — Treasury Buyback Flywheel section**

User-facing primer at the end of `apps/www/src/content/userguide/Advanced.en.md`:

- The three-stage flywheel explanation (accumulate, bridge + commit, deliver).
- What stakers experience: two-source claimable VPFI (original drip + buyback proceeds), no slashing, no special action needed.
- Operator-visible failures the public dashboard will surface.
- The "TWAP design doesn't destabilise the floor" reassurance.

### Producer artifacts

No selector / ABI / cut changes. This slice is integration + docs only.

### Verification

- BuybackEndToEndIntegrationTest 2/2 green.
- All prior Sub 3 unit suites still green (BuybackValidatedCommitTest 15/15, BuybackIntentLedgerTest 28/28, TreasuryBuybackRemittanceTest 28/28, BuybackRemittanceReceiverTest 14/14).
- Frontend + agent tsc clean.

### Sub 3 status

With Sub 3.D merged, the **Sub 3 umbrella (#452) is fully shipped**:

- Sub 3.A (#468, PR #475) — per-chain budget + Base-side absorb + remittance receiver.
- Sub 3.B (#469, PR #476) — intent ledger + IntentDispatchFacet refactor.
- Sub 3.C (#470, PR #477) — Fusion TWAP order template validation + apps/agent extension.
- Sub 3.D (#471, this PR) — integration test + FunctionalSpec + Advanced UG.

The Sub 3 add-ons (#472 priority routing, #473 productive treasury reserve, #474 keeper VPFI rewards) remain queued as scoped follow-ups; they layer onto the Sub 3 core but are not gating for production readiness.
