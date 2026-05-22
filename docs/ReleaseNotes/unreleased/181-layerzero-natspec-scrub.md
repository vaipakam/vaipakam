## Thread — LayerZero NatSpec scrub + `IRewardOApp` → `IRewardMessenger` rename (PR #<n>)

Mechanical follow-up to T-068. The cross-chain transport has been
Chainlink CCIP since April 2026, but a number of NatSpec headers,
inline comments, and one interface name still spoke as if the
protocol were on LayerZero — describing OFT adapters that no longer
exist (`VPFIOFTAdapter`), peer meshes that were dismantled, and OApp
packets that are now CCIP messages. The stale wording was the kind a
new reader would honestly try to follow before discovering the code
no longer matches it. This thread scrubs that surface in one pass.

`IRewardOApp` is renamed to `IRewardMessenger` — the only file-level
rename in the change. Its method names (`sendChainReport`,
`broadcastGlobal`) stay because they describe an intent
("send a chain report", "broadcast the global denominator"), not a
transport. The rename is reflected in `RewardReporterFacet`,
`RewardAggregatorFacet`, and the test double `MockRewardOApp` →
`MockRewardMessenger`. The Diamond's storage slot `rewardOApp` and
the related custom errors (`RewardOAppNotSet`,
`NotAuthorizedRewardOApp`) are deliberately **not** renamed: those
are part of the deployed ABI / storage layout, and renaming them is
an upgrade-path break the migration explicitly avoided. NatSpec next
to each retained legacy name now states why it's still called that.

In addition, `GuardianPausable`'s header no longer reads as the
provider-neutral successor to a deleted pause base — that framing
was correct mid-migration but became a backwards-looking artefact
once the LayerZero base was actually gone. It now describes the
contract for what it currently is: the pause base for every
cross-chain contract under `contracts/src/crosschain/`, named
transport-neutrally on purpose.

No production code paths change. The Diamond ABI is unchanged. The
57-test `CrossChainRewardPlumbingTest` suite passes; the four
`VPFI*` test suites pass (69 cases); the 12-case deploy-sanity gate
(facet-size limit, selector coverage, selector collision, deployed-
Diamond unpaused) passes. The public reference keeper bot and the
frontend ABI bundles do not change — none of the touched symbols is
in the Diamond external surface.

Closes #181.
