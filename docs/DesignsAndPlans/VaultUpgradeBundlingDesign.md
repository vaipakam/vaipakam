# Mandatory vault upgrade bundling (E-12)

**Status:** design for review (contracts + frontend). Card: #1214.
Umbrella: #1221.

## Problem

A mandatory vault upgrade hard-blocks all interaction until the user
submits a dedicated upgrade transaction — a dead stop mid-flow, plus an
extra gas payment, at exactly the moment the user wanted to do something
else.

## Design

### Contract

A thin Diamond entry point that composes the two steps atomically:

```
upgradeVaultAndCall(bytes actionCalldata)
```

1. Verifies the caller's vault implementation is behind the required
   version (reads the factory's current implementation pointer).
2. Executes the UUPS upgrade on the caller's vault proxy via the existing
   user-authorized upgrade path — authority semantics unchanged: the
   *user* triggers their own vault's upgrade, exactly as today, just
   inside the same transaction.
3. `address(this).call(actionCalldata)` — routes through the Diamond
   fallback into the intended action (accept offer, repay, claim, ...).

Guards:

- Step 3 executes only if step 2 succeeded; any revert unwinds both
  (atomicity is the point — no half-upgraded stuck state).
- `actionCalldata` selector allowlist = the normal user-facing surface
  (deny admin/diamondCut selectors defensively).
- Reentrancy: same internal-call discipline as other Diamond self-routes
  (the #951 lesson: internal paths, not external self-calls, where guards
  overlap).
- If the vault is already current, step 2 no-ops and the action runs —
  the frontend can use this entry point unconditionally during a rollout
  window.
- Upgrade initializers: the implementation's `reinitializer` runs inside
  the same tx; the version gate on step 1 prevents double-init.

### Frontend

- The "upgrade required" interstitial becomes a checkbox-style notice
  inside the action's review screen: "this transaction also upgrades your
  vault to vN (required)" — one signature, one gas payment.
- Standalone upgrade path stays for users who prefer it.
- Transaction preview simulates the composed call (existing preview
  surface; fail-soft).

## Why not batch at the wallet layer (EIP-5792 / AA)

Wallet-level batching isn't universally supported and puts the atomicity
guarantee in the wallet's hands; the protocol-level composition works for
every EOA today. AA/paymaster work is a separate bet (enhancement note
§3.5).

## Tests

Upgrade+action success; action-revert unwinds upgrade; already-current
no-op; selector allowlist; reinitializer once; event ordering
(`VaultUpgraded` then action events); preview simulation parity.

## Spec edit

ProjectDetailsREADME vault-upgrade policy paragraph: blocked-until-upgrade
becomes "blocked or bundled"; FunctionalSpecs vault domain updated in the
implementing PR.
