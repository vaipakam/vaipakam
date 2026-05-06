# Contract-level follow-ups from 2026-05-06 testnet rehearsal

These items surfaced during the Base Sepolia + Arb Sepolia + OP
Sepolia rehearsal. Each requires a contract source change + redeploy
(unlike the script-level fixes already shipped, which were resolved
in-flight).

**Take these BEFORE the next mainnet rehearsal pass.**

## 1. `VPFIBuyAdapter.getRateLimits()` view function — REQUIRED for mainnet

**Status**: ✅ SHIPPED 2026-05-06.

**What landed**: A `getRateLimits() returns (uint256 perRequestCap_,
uint256 dailyCap_)` tuple-getter on `VPFIBuyAdapter` paired with
`setRateLimits` for symmetric API. The deploy-script verifications in
[deploy-chain.sh](../../contracts/script/deploy-chain.sh) step `[5d]`
and [deploy-mainnet.sh](../../contracts/script/deploy-mainnet.sh)
`--phase verify` step `[4]` now hard-fail (non-zero exit) when either
cap is still at `type(uint256).max`. Test coverage in
[VPFIBuyAdapterRateLimitsTest.t.sol](../../contracts/test/token/VPFIBuyAdapterRateLimitsTest.t.sol)
(3 cases: defaults-to-max, reflects-set, agrees-with-field-getters).

**Note**: the doc's original premise ("no public getter") was
imprecise — the storage fields `perRequestCap` and `dailyCap` were
already declared `public`, so per-field getters did exist. The actual
problem was the deploy scripts targeting wrong selector names
(`perBlockLimit()` / `perDayLimit()` — those never existed). The
new tuple-getter is still useful API ergonomics (one call confirms
both bounds atomically), and the script fix to use the correct
selector is the substantive change.

---

## 1. `VPFIBuyAdapter.getRateLimits()` view function — original write-up
**Status (original)**: blocking mainnet readiness.

`VPFIBuyAdapter` exposes `setRateLimits(uint256 perBlock, uint256 perDay)`
but does NOT expose any public getter for the resulting state.
Today the deploy script's `[5d]` health check + the mainnet
`--phase verify` step both attempt `cast call <buyAdapter>
'perBlockLimit()(uint256)'` and similar variants — all revert
because no such function exists.

Why this matters on mainnet: per CLAUDE.md "Cross-Chain Security
Policy", BuyAdapter rate limits are a **hard mainnet-deploy gate**
(`uint256.max` defaults are catastrophic — unlimited mint).
Without a public getter, the operator cannot externally verify
that the post-deploy `setRateLimits` call actually landed and
took effect. Storage-slot inspection works but is fragile and
operator-error-prone.

**Fix**: add a single view function to `VPFIBuyAdapter`:

```solidity
/// @notice Returns the currently-configured per-block + per-day
///         buy rate limits in VPFI units (18 decimals). Pairs with
///         `setRateLimits` for post-deploy verification by the
///         deploy-script's health check + the mainnet operator's
///         `--phase verify` step.
function getRateLimits()
    external
    view
    returns (uint256 perBlock, uint256 perDay)
{
    return (_perBlockLimit, _perDayLimit);
}
```

Once shipped + redeployed, restore the cast-call verification in:

- `contracts/script/deploy-chain.sh` step `[5d]` post-deploy health
  check — the operator-confirmation note can be replaced with a
  hard-fail when limits are uint256.max.
- `contracts/script/deploy-mainnet.sh` `--phase verify` step `[4]` —
  same hard-fail behavior, gates mainnet declaration of "deploy
  ready" on actual on-chain limit values.

Both are flagged with TODO comments at those sites pointing at this
doc.

## 2. Deploy-time pause-by-default for the Diamond — RECOMMENDED for mainnet hardening

**Status**: nice-to-have hardening, not blocking.

`DeployDiamond.s.sol` deploys the Diamond unpaused. Between
`diamondCut 1/2` and `diamondCut 2/2` the Diamond is in a half-cut
state — half-2 selectors revert with `FunctionDoesNotExist` until
the second cut lands. On a public mainnet, an attacker watching the
mempool could attempt to call half-2 selectors during this window.

Today the only damage from such a call is a clean revert (no
selector mapping). **But** if a future change ever adds a fallback
that swallows revert reasons, the partial-cut state becomes a
foot-gun.

**Fix**: have the Diamond start paused (set `s.paused = true` in
the constructor or as the first state write in DeployDiamond), and
add an explicit unpause as the final step of the deploy script —
after the post-cut facet-count assertion + the Step 5 init calls.
Mainnet operator can additionally insert a `--phase verify` →
manual eyeball → `setPaused(false)` flow if they want a multi-eye
review before unpause.

## 3. Step 6 role-handover atomicity — NICE-TO-HAVE

**Status**: low priority; existing handover works correctly.

Step 6 of `DeployDiamond.s.sol` does:

- 11 `grantRole(role, admin)` calls to admin
- 1 `transferOwnership(admin)`
- 11 `renounceRole(role, deployer)` calls (in reverse, DEFAULT_ADMIN
  last)

That's 23 separate transactions. If any fails mid-flight (RPC
hiccup, gas spike), role distribution is in an inconsistent state.
Today's recovery is for the operator to manually inspect via
DeploymentRunbook §6 and fix; it has worked fine but adds risk.

**Fix**: add a single batched `transferAdmin(address newAdmin)`
external function on `AccessControlFacet` that grants every role
to `newAdmin`, transfers ERC-173 ownership, and renounces every
role from the caller — all in one transaction. Same end-state as
the current 23-tx flow but atomic, gas-cheaper, and impossible
to leave half-applied.

This needs governance review since the new function carries the
same authority as the manual sequence; if compromised it's a
turnkey takeover. Acceptable today since the deployer EOA already
has root admin — adding the function doesn't increase blast radius
— but worth gating on an explicit role check (`onlyRole(DEFAULT_ADMIN_ROLE)`).

## 4. Indexer `forge verify-contract` dedup patch — VALIDATE

**Status**: shipped but not validated end-to-end.

The mid-rehearsal patch to `deploy-chain.sh` step `[5f]` deduplicates
`forge verify-contract --watch` invocations by lowercased address +
filters out broadcast records older than the current
`deployment_source.json`'s mtime. The patch was applied + syntax-
checked but not run against a fresh deploy.

**Action**: on the next chain after this rehearsal, run with
`--verify-contracts` and confirm:

- The dedup count line ("`N unique contract(s) in verify queue`")
  shows ~30-40, not 200+.
- No mock contracts from prior testnet runs appear in the queue.
- Total runtime is under 30 minutes (vs. the indefinite hang the
  un-deduped version produced before being killed).

Expected total: 1 Diamond + 32 facets + 2 implementations
(VPFIToken + OFTAdapter) + 1 BuyReceiver + 1 RewardOApp Bootstrap
+ 1 RewardOApp Real impl + Timelock + ERC1967Proxy ≈ 40 unique
contracts. With dedup that's roughly 40 × 30s avg = ~20 min.

---

**Recommended order**: tackle #1 first (mainnet-blocking), #4 in
parallel as a side-pass on the next testnet, #2 + #3 as polish in
a single contract-side hardening PR before mainnet deploy.
