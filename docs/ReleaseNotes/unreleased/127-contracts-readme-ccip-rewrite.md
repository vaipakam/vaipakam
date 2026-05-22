## Rewrite contracts/README.md cross-chain sections (LayerZero → CCIP) (Issue #127)

The auto-generated docs site at `https://vaipakam.github.io/vaipakam/`
uses `contracts/README.md` as its home page (`forge doc` copies the
project README into the mdbook tree). Until this release, the
README's cross-chain sections still described the pre-T-068
LayerZero OFT V2 surface — file listing referenced `VPFIMirror.sol`
+ `VPFIOFTAdapter.sol`, the topology diagram showed LayerZero
messages with DVN-verification, the deployment guide pointed at
`DeployVPFICanonical` + `DeployVPFIMirror` + `WireVPFIPeers` (all
deleted in T-068's Phase 5), the env-var table listed `LZ_ENDPOINT`
+ `LOCAL_OAPP` + `REMOTE_EID`, and the bridging-flow section walked
through the adapter `send` → DVN → executor → `_credit` pattern.

A "Known doc drift" note at the top of the file warned auditors that
the body was stale. The note was a stopgap; this release retires it
and rewrites the body so it matches what the code actually does.

What changed in `contracts/README.md`:

- **Repository Layout** — `token/` now lists `VPFIToken.sol` +
  `VaipakamVestingWallet.sol`. The pre-T-068 `VPFIMirror.sol` and
  `VPFIOFTAdapter.sol` are gone. A new `crosschain/` directory
  block lists every contract under `src/crosschain/`:
  `ICrossChainMessenger`, `CcipMessenger`, `GuardianPausable`,
  `VPFIMirrorToken`, `VpfiPoolRateGovernor`, `VpfiBuyAdapter`,
  `VpfiBuyReceiver`, `IVpfiBuyCcipMessages`,
  `VaipakamRewardMessenger`.
- **VPFI Cross-Chain Topology** — the topology paragraph + ASCII
  diagram now describes the CCIP CCT shape: `VPFIToken` paired with
  a `LockReleaseTokenPool` on Base; `VPFIMirrorToken` paired with a
  `BurnMintTokenPool` on every mirror chain; the CCIP committing /
  executing DONs plus the Risk Management Network in the
  inter-chain transport. The "Key properties" list adds the
  one-transport-aware-contract pattern (domain code depends only on
  `ICrossChainMessenger`), the per-lane rate-limit policy via
  `VpfiPoolRateGovernor`, and the `GuardianPausable` pause base.
- **Deployment Guide / env variables** — `LZ_ENDPOINT`,
  `LOCAL_OAPP`, `REMOTE_EID`, `REMOTE_PEER` are gone. Replaced
  with `CCIP_ROUTER`, `CCIP_RMN_PROXY`, `CCIP_LINK_TOKEN`,
  `CCIP_TOKEN_ADMIN_REGISTRY`, `LOCAL_CHAIN_SELECTOR`,
  `REMOTE_CHAIN_SELECTOR`, `REMOTE_MESSENGER`, `REMOTE_POOL`.
- **Step 2** (formerly "Canonical VPFI deploy", "Mirror deploy",
  "Wire the OFT peer mesh" as three separate steps) is now a
  single "Deploy the cross-chain layer" step that points at
  `DeployCrosschain.s.sol`. The script auto-forks on
  canonical-vs-mirror by `block.chainid`, so the same broadcast
  deploys the right contracts on every chain — the canonical
  chain gets `VPFIToken` + `LockReleaseTokenPool` +
  `VpfiBuyReceiver`; every mirror gets `VPFIMirrorToken` +
  `BurnMintTokenPool` + `VpfiBuyAdapter`; every chain gets
  `CcipMessenger`, `VpfiPoolRateGovernor`, and
  `VaipakamRewardMessenger`. Deterministic addresses via
  `LibCreate2Deploy`.
- **Step 3** (formerly Step 4, "Wire the OFT peer mesh") is now
  "Configure CCIP lanes + token pools" and points at
  `ConfigureCcip.s.sol`. The script wires chain selectors,
  remote-messenger peers, the `vpfi-buy` + `vpfi-reward`
  channels, per-lane rate limits via `VpfiPoolRateGovernor`,
  the `setBroadcastDestinations` list on the canonical reward
  messenger, and the `TokenAdminRegistry` pool registration. An
  anvil-rehearsal note points at `RehearseCcipAnvil.s.sol` for
  the local end-to-end pre-flight.
- **Step 4** (formerly Step 5) "Rotate `minter` to the diamond"
  is renumbered; the procedure is unchanged.
- **OFT Bridging Flow** → **VPFI Cross-Chain Token (CCT) Bridging
  Flow** — the outbound + inbound walkthroughs describe the
  Router-mediated CCIP path (lock on Base, mint on mirror,
  symmetric inbound), the committing DON + RMN verification + the
  executing DON delivery, and the in-flight-message supply
  invariant. A new "Failure model" paragraph documents that a
  paused contract's inbound CCIP message reverts and CCIP records
  it as a re-executable failed message — nothing is lost.
- **Script Reference** — `DeployVPFICanonical.s.sol`,
  `DeployVPFIMirror.s.sol`, `WireVPFIPeers.s.sol` are removed
  (the underlying scripts were deleted in T-068's Phase 5).
  Added: `DeployCrosschain`, `ConfigureCcip`,
  `ConfigureRewardReporter`, `ConfigureVPFIBuy`,
  `RehearseCcipAnvil`.
- **Cross-Chain Security (CCIP)** section is unchanged — it was
  already CCIP-accurate. The historical contrast with LayerZero
  (the DVN-footgun explanation, the April 2026 ~$292M Kelp
  bridge exploit reference) stays because it's the load-bearing
  rationale for choosing CCIP, not a description of how the
  protocol runs.

The intro paragraph is trimmed — the historical "T-068 migrated this
from LayerZero to CCIP — April 2026" parenthetical is removed in
favour of a forward-looking framing. Detailed migration rationale
stays accessible via the ADR-0004 and migration-plan links retained
in the security section.

The "Known doc drift" warning at the top of the file is now removed.
Visitors to `https://vaipakam.github.io/vaipakam/` see a README that
describes the running protocol.

Closes #127.
