# Vaipakam Storage Libraries

This directory contains the namespaced storage libraries that back every facet
in the Vaipakam Diamond. Reviewers and auditors should read this document
before evaluating cross-facet storage safety.

## Why namespaced storage (not AppStorage)

Vaipakam uses **per-domain namespaced storage libraries** rather than the
monolithic `AppStorage` pattern popular in earlier Diamond deployments.
Each storage struct lives at its own collision-resistant slot derived
from an ERC-7201 namespace.

Rationale:

- **Audit isolation.** A bug in `RepayFacet` cannot reach into `LibERC721`
  owner mappings by accident. Each library exposes a typed `_storage()` or
  `storageSlot()` accessor and the slots are at unrelated keccak-derived
  positions.
- **No reliance on Solidity slot-0 conventions.** AppStorage depends on every
  facet declaring `AppStorage internal s;` as its *first and only* state
  variable. A silent violation anywhere corrupts everything. Our namespaced
  slots are self-evident — the slot constant is printed in the library and
  any reviewer can verify it independently.
- **Independent append-only evolution.** Each `*Storage` struct grows in
  isolation. Adding a field to `LibERC721` cannot affect `LibVaipakam`'s
  layout.

Cost we accept in exchange:

- Cross-facet calls use `address(this).call(abi.encodeWithSelector(...))`
  rather than free internal library calls across shared storage (~2.5k extra
  gas per cross-facet call). See `CLAUDE.md` for the convention.

## The ERC-7201 slot formula

Every storage library in this directory computes its slot as:

```
slot = keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))
```

The `-1` and `& ~0xff` mask exist to guarantee the slot cannot collide with
Solidity's ordinary storage layout (slot 0 for plain state variables, `keccak256(key . pos)` for mappings). This is the same derivation used by OpenZeppelin v5's upgradeable contracts.

Slots are **precomputed and hardcoded as hex literals** with the formula
documented in a comment. This avoids depending on the Solidity compiler's
ability to constant-fold `keccak256(abi.encode(...))`, which has historically
varied across versions.

## Current namespace → slot mapping

| Library                  | Namespace                          | Slot                                                                 |
|--------------------------|------------------------------------|----------------------------------------------------------------------|
| `LibVaipakam`            | `vaipakam.storage`                 | `0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00` |
| `LibERC721`              | `vaipakam.storage.ERC721`          | `0xffc14e8dfa13b7ea215d815404bdf757f7212df791bac9ce070c8e8dcd574f00` |
| `LibAccessControl`       | `vaipakam.storage.AccessControl`   | `0xc48a173852129618ce28c4cefb1235c11826e47de4a4b918e1a2ff7ad659ae00` |
| `LibReentrancyGuard`     | `vaipakam.storage.ReentrancyGuard` | `0x04ba3822bc69a2ad3e1ccb8944f5c7cebff98e1206031ba7be7244e7e3f82700` |
| `LibPausable`            | `vaipakam.storage.Pausable`        | `0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400` |

Verifying a slot:

```bash
python3 - <<'PY'
import sys
from eth_hash.auto import keccak  # or use `cast keccak` for each step
ns = "vaipakam.storage"
h1 = int.from_bytes(keccak(ns.encode()), "big")
h2 = int.from_bytes(keccak((h1 - 1).to_bytes(32, "big")), "big")
print(hex(h2 & ~0xff))
PY
```

Or step-by-step with Foundry `cast`:

```bash
H1=$(cast keccak "vaipakam.storage")
V=$(python3 -c "print(format(int('${H1#0x}', 16) - 1, '064x'))")
H2=$(cast keccak "0x$V")
python3 -c "print(hex(int('${H2#0x}', 16) & ~0xff))"
```

## Append-only storage rule

Every `*Storage` struct in this directory is annotated with:

```solidity
/// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
///      rename, or change types of existing fields on live diamonds.
struct XxxStorage { ... }
```

**Pre-launch:** free to reorder, rename, and retype fields. The chain is
empty of Vaipakam state, so nothing is at risk.

**Post-launch:** the rule is strict:

1. New fields must be appended *at the end* of the struct.
2. Existing fields must not be reordered.
3. Existing fields must not be renamed.
4. Existing fields must not change type (including mapping key/value types,
   struct shape, or array inner type).
5. Fields that become logically unused must be kept in place and marked with
   a `// DEPRECATED` comment. The precedent is `LibVaipakam.Storage.liquidAssets`.

Violating any of these corrupts every offer, loan, user escrow, role, NFT,
and pause state in storage.

Upgrade review checklist:

- [ ] `forge inspect VaipakamDiamond storageLayout` compared against prior
      build for each `*Storage` struct.
- [ ] New fields added only at the end.
- [ ] No field removed, renamed, or retyped.
- [ ] Any `// DEPRECATED` field kept with its original type.
- [ ] Slot constants unchanged (the ERC-7201 hex literals in each library).

## Library inventory

- **`LibVaipakam.sol`** — Main protocol storage: offers, loans, escrows, risk
  params, KYC, country whitelists, treasury. Accessed by every non-trivial
  facet.
- **`LibERC721.sol`** — Position-NFT storage: owners, balances, approvals,
  statuses, image URIs, royalties. Backs `VaipakamNFTFacet`.
- **`LibAccessControl.sol`** — Role-based access (admin, pauser, KYC admin,
  oracle admin, risk admin, escrow admin). Backs `AccessControlFacet` and the
  `onlyRole` modifier on every admin function.
- **`LibReentrancyGuard.sol`** — Cross-facet reentrancy guard. The
  `DiamondReentrancyGuard.nonReentrant` modifier is mixed into every facet
  with external callbacks (ERC-721 transfers, escrow withdrawals, 0x swap
  paths).
- **`LibPausable.sol`** — Global circuit breaker. The `DiamondPausable`
  modifiers gate every user-facing mutation facet.
- **`LibLoan.sol`**, **`LibFacet.sol`**, **`LibFallback.sol`**,
  **`LibCompliance.sol`**, **`LibRevert.sol`** — stateless helper libraries
  (no storage slots of their own; they read/write `LibVaipakam` state).

Only the five libraries in the slot table above declare their own namespaced
storage. The rest are pure-logic helpers.
