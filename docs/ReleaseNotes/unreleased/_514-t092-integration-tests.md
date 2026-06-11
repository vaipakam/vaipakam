## Thread — T-092 follow-up: integration tests for the auto-lifecycle surface (#514)

Follow-up to T-092 (#499 closed). Phase 3 (#507) deferred a full behavioural happy-path test pending Phase 2's redesign; Phase 2a + 2b have now landed (#509 + #510). This PR adds a focused integration test file that exercises the T-092 surface end-to-end against a real diamond fixture.

### What's new

New `contracts/test/T092AutoLifecycleIntegrationTest.t.sol` — SetupTest-based, with the three admin kill switches enabled in setUp. Coverage:

1. **Kill-switch reverts** — `setAutoLendConsent(true)` reverts `AutoLendDisabled` when the kill switch is off; `extendLoanInPlace` reverts `AutoExtendDisabled`; users can still revoke consent (`setAutoLendConsent(false)`) when the feature is disabled (protects against trap-in-consent).
2. **Kill-switch getter parity** — admin-set state round-trips correctly via the getters (Codex Phase 2a round-1 P2 wiring).
3. **Kill-switch access control** — only `ADMIN_ROLE` can flip; non-admin reverts.
4. **Cap-setter semantics** — `setDefaultAutoRefinanceCaps` accepts a zero rate (Codex Phase 1 round-1 P3); `setAutoOptInOnNewLoan` toggle round-trips.
5. **Error-selector guardrails** — every new error selector across `LibAutoRefinanceCheck` + `RefinanceFacet` (`AutoRefinanceDisabled`) + `OfferCreateFacet` (`InvalidRefinanceTarget`) is asserted non-zero so a rename surfaces immediately at the test compile step.

### What's NOT in this PR

Full multi-step keeper-orchestrated happy-path coverage (create refinance-tagged offer → new lender accepts → keeper calls refinanceLoan → assert old loan Repaid + fund flows + LoanRefinanced event payload). The fund-flow assertions require the same elaborate fixture the existing `RefinanceFacetTest` carries (mocked cross-facet calls + multi-NFT scenarios), and the broader regression already exercises the underlying paths. The scope here is the **NEW T-092 surface bound to a real loan** — kill switches + tagged-offer binding + consent gates — which the existing per-facet unit tests don't reach end-to-end.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 10/10 green.
- AutoLifecycleFacetTest 13/13, ProfileFacetTest 50/50, RefinanceFacetTest 34/34 (97/97 broader) still green.
- Deploy-sanity 12/12.

### Operator action

None — test-only change.
