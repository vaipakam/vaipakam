## Thread — CCIP guardian-pause coverage (PR #__, Closes #200 + #201)

Two code-vs-docs gaps surfaced during the PR #198 README doc-
verification pass converge to one resolution.

ADR-0004 ("CCIP over LayerZero") used to claim **"every cross-chain
contract carries `GuardianPausable`"**, but the rate-limit admin
`VpfiPoolRateGovernor` deliberately doesn't extend the pause base —
it has no runtime send / receive path of its own, and its setters
are already owner-gated through `Ownable2Step`, so pausing it during
a cross-chain incident wouldn't be load-bearing. Meanwhile,
`ConfigureCcip._setGuardians` wired the guardian on the messenger,
reward messenger, and local buy contract — but not on
`VPFIMirrorToken`, which DOES extend `GuardianPausable` and very
much wants the incident-response fast-pause path on mirror chains.
Operators were left to remember the manual `setGuardian` step, which
is exactly the kind of footgun the deploy script exists to remove.

The fix lands in both directions:

- **ADR-0004 wording qualified** to "every cross-chain contract
  *with a runtime send / receive path*" and the contracts that carry
  `GuardianPausable` are enumerated by name (`CcipMessenger`,
  `VaipakamRewardMessenger`, `VpfiBuyAdapter`, `VpfiBuyReceiver`, and
  the mirror-chain `VPFIMirrorToken`). `VpfiPoolRateGovernor` is
  named as the intentional exception with the reasoning above.
- **`ConfigureCcip._setGuardians` extended** to wire the guardian on
  `VPFIMirrorToken` on mirror chains. The canonical `VPFIToken`
  (Base) doesn't get the call — it's the long-lived OFT-shaped
  token, paused via its own AccessControl path, not the cross-chain
  guardian.

Both findings move from open-divergence to resolved in
`docs/FunctionalSpecs/_CodeVsDocsAudit.md`. Mainnet operators no
longer need to remember the manual mirror-token-guardian step;
auditors reading ADR-0004 see the universal-coverage claim qualified
to match what's actually shipped.

Closes #200, #201.
