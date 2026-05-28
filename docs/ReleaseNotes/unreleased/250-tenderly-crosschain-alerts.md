## Thread — Tenderly cross-chain alert presets (issue #250 Phase 1)

Extends the existing `ops/tenderly` alert surface with presets that cover the CCIP cross-chain stack under `contracts/src/crosschain/*`. Phase 1 of the issue #250 plan to replace the legacy `ops/lz-watcher` Cloudflare Worker — that Worker was monitoring the LayerZero V2 surface which T-068 (PR #46, merged 2026-05-18) decommissioned, so it has been ticking against a stack that no longer exists.

The new `alerts-crosschain.yaml` follows the same shape as the existing `alerts.yaml`: per-contract event filters with severity / description / destination metadata, applied per chain via the `envsubst` + `tenderly alerts apply` workflow already in the operator's playbook. The preset set covers six event categories:

- **Pause / Unpause** on every cross-chain contract (P0 — cross-chain layer offline).
- **Messenger config drift** on `CcipMessenger` — chain-selector / remote-messenger / channel-peer changes (P0/P1, since these constitute the cross-chain trust root).
- **Rate-limit / pool drift** on `VpfiPoolRateGovernor` + `VpfiBuyAdapter` (P0/P1, blast-radius changes).
- **Token-pool reassignment** on `VPFIMirrorToken` (P0 — direct path to unsanctioned mirror VPFI inflation).
- **Reward-messenger config drift** on `VaipakamRewardMessenger` (P0/P1, redirect-attack vectors).
- **Ownership transfers** on every cross-chain contract (P0 — should never fire post-handover).

Plus one Web3 Action — `count-stuck-vpfi.ts` — that polls the trailing 1h window for `VpfiBuyReceiver.VPFIStuckForRetry` events and alerts when the rate exceeds a threshold (default 3/hour). Single stuck VPFIs are expected on the retry-path happy case, so a per-event alert would be noise; the rate alarm is the useful signal.

This is the additive half. Phase 2 (deleting the lz-watcher Worker + source tree + D1) lands after the new presets have been verified live on testnet so there's no monitoring gap during the transition. Out of scope and deferred to the mainnet-prep checklist: the CCT supply invariant (cross-call math, awkward in Tenderly's native filters — likely a Forta CCT template fork or a small standalone Web3 Action at that point), auto-pause integration via Web3 Actions, and RMN config drift monitoring (Chainlink-owned surface).
