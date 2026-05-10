# Safe Transaction-Builder batches

Pre-encoded Safe transaction batches for ownership-gated operator
actions that the deploy scripts can't broadcast directly because the
target contract's owner is the Safe multisig, not an EOA.

## Current batches

| File | Chain | # tx | Authority | Purpose |
|------|-------|------|-----------|---------|
| `peer-wiring-base-sepolia.json` | base-sepolia (84532) | 6 | Safe `0x2C7B…1dd0` | LayerZero `setPeer` on canonical's three OApps |
| `peer-wiring-sepolia.json` | sepolia (11155111) | 4 | Safe `0x2C7B…1dd0` | LayerZero `setPeer` on Sepolia mirror's three OApps |

## How to execute

1. Open <https://app.safe.global> on the relevant chain (top-left
   network selector).
2. Confirm you're on the right Safe — `0x2C7B2328E2906c58F2cc6fa3920DB4fa1ecb1dd0`.
3. **Apps → Transaction Builder → "Drag and drop a JSON file"** —
   drop the batch file in.
4. The Builder UI lists every `setPeer` with its decoded
   `contractInputsValues` (eid + peer). Eyeball-check that:
   - `to` matches the OApp address you expect.
   - `_eid` matches the remote chain (40245 base-sep, 40231 arb-sep,
     40161 sep).
   - `_peer` is the right-padded peer address on that remote chain.
5. **Create Batch → Send Batch** → propose. 2-of-3 signers approve →
   execute.
6. Verify post-execute (per chain) with:
   ```
   cast call <local-oapp> 'peers(uint32)(bytes32)' <remote-eid> --rpc-url <local-rpc>
   ```
   Should return the right-padded peer address (not bytes32(0)).

## Why these aren't auto-broadcast by `deploy-peers.sh`

`deploy-peers.sh` overrides `PRIVATE_KEY → ADMIN_PRIVATE_KEY` on the
assumption that ADMIN owns every OApp post-deploy. After the
multi-party Safe handover ceremony, OApps on chains where the
ceremony completed (base-sepolia + sepolia) are owned by the Safe.
ADMIN-signed `setPeer` from those chains reverts
`OwnableUnauthorizedAccount`. The peer-wiring matrix splits across
two authority contexts, so the ADMIN-signed legs run via the script
or `cast send`, and the Safe-signed legs run via these batches.

Arb-sepolia legs (4 calls) are still ADMIN-owned because Safe v1.4.1
isn't supported on Arb Sepolia testnet. Those were broadcast directly
on 2026-05-11 (txs `0x2d73f3…`, `0xfc24d6…`, `0x97d8d9…`, `0x945729…`).

## Status (as of 2026-05-11)

Both batches **executed and verified** ✓. All 14 mesh legs wired
symmetrically across base-sepolia ↔ arb-sepolia ↔ sepolia. The
post-execute `cast call peers(uint32)(bytes32)` readback confirmed
every leg returns the right-padded peer address on the remote chain.
Cross-chain LayerZero packets can flow in every direction.
