# Mainnet Multisig + Timelock Setup

This runbook walks through moving the Vaipakam Diamond's privileged
control from a single deployer EOA to a **Safe multisig → OZ
TimelockController → Diamond** chain. It is the mainnet-readiness
counterpart to the testnet rehearsal flow; do NOT run any of the
broadcast steps below until the testnet sequence has been rehearsed
end-to-end at least once on a fresh Diamond.

The companion docs are:

- [GovernanceRunbook.md](GovernanceRunbook.md) — what the timelock
  guards and how to schedule operations once it's live
- [AdminKeysAndPause.md](AdminKeysAndPause.md) — which roles stay on
  the ops Safe (PAUSER_ROLE, KYC_ADMIN_ROLE) vs the governance Safe
- [DeploymentRunbook.md](DeploymentRunbook.md) — the full per-chain
  deploy sequence the timelock setup plugs into at the end

---

## TL;DR — six steps, in order

```
[A]  Pick signer set + threshold for governance Safe + ops Safe
[B]  Deploy Safe(s) per chain via app.safe.global (or via SafeProxyFactory CLI)
[C]  Set TIMELOCK_PROPOSER=<governance-safe-addr> in .env
[D]  forge script DeployTimelock.s.sol --broadcast
[E]  forge script TransferAdminToTimelock.s.sol --broadcast (CONFIRM_HANDOVER=YES)
[F]  Verify role distribution on-chain + grant PAUSER + KYC_ADMIN to ops Safe
```

Step E is irreversible — once the deployer EOA renounces
`DEFAULT_ADMIN_ROLE`, only the timelock can reach the Diamond's admin
surface. Rehearse the entire sequence on a Sepolia Diamond before
running it on a mainnet Diamond.

---

## Background — what this protects against

After a normal deploy, the deployer EOA holds:

- `DEFAULT_ADMIN_ROLE` + 10 sub-roles (`ADMIN_ROLE`, `ORACLE_ADMIN_ROLE`,
  `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`, `PAUSER_ROLE`,
  `KYC_ADMIN_ROLE`, etc.) — see [AccessControlFacet.sol](../../contracts/src/facets/AccessControlFacet.sol)
- ERC-173 ownership (LibDiamond owner) — controls `diamondCut` (facet
  swaps) and the implementation slot for the per-user vault proxies

A leaked deployer key on this surface is a turnkey takeover: rotate
treasury, replace 0x proxy with an attacker-controlled drainer,
upgrade the vault implementation to one that reads private keys.
The fix is two layers:

1. **Multisig** (Safe) — N-of-M threshold so no single key can act
2. **Timelock** (OZ TimelockController) — every admin op is observable
   for 48h before it lands; users can exit, signers can cancel

Combined: a leaked single signer key alone can't propose anything
(needs threshold), and even a fully captured Safe can't insta-rug
(needs 48h delay during which the protocol watcher / users / other
signers can cancel).

---

## A. Pick signer set + threshold

You will run **two** Safes, each on each mainnet chain:

### A.1 Governance Safe (timelock proposer)

Holds the timelock's `PROPOSER_ROLE` + `CANCELLER_ROLE`. Used for
parameter changes that go through the 48h delay.

| Phase | Threshold | Signers |
|---|---|---|
| **Phase 1 launch** | **2-of-3** | founder + co-founder + ops lead |
| Post-audit / Phase 2 | 3-of-5 | + 2 advisors / external trustees |
| Mature (post-token-launch) | 4-of-7 | + community-elected seats |

Phase 1 sweet spot is **2-of-3**: survives one lost key, requires
collusion of two to act maliciously, low signing friction. **Do not
launch with 1-of-1** — it defeats the multisig layer entirely; the
timelock alone protects against insta-execution but not against a
single-key proposer that can schedule any op.

### A.2 Ops Safe (pause + KYC)

Holds `PAUSER_ROLE` + `KYC_ADMIN_ROLE` directly on the Diamond. These
two roles intentionally **bypass** the timelock per
[TransferAdminToTimelock.s.sol](../../contracts/script/TransferAdminToTimelock.s.sol)
— pausing during an incident can't wait 48h, and per-user KYC tier
bumps need same-hour response.

| Threshold | Signers |
|---|---|
| **1-of-3** | three on-call operators (founder + 2 ops engineers) |

1-of-3 is acceptable here because the only powers are
`pause()` / `pauseAsset()` (defensive) and KYC tier bumps (no
fund-movement authority). The blast radius of a leaked 1-of-3 ops
signer key is bounded to "denial-of-service via spurious pause" — a
governance Safe can call `unpause()` through the timelock to clean up.
The trade is faster incident response; the alternative (2-of-3 ops)
adds ~5 min to every pause and has historically lost protocols
millions in those minutes.

If you want both: deploy ops Safe as **1-of-3 for `pause`** and rely
on the same Safe (or a separate one) for KYC at any threshold —
`KYC_ADMIN_ROLE` and `PAUSER_ROLE` are independent and can be split.

---

## B. Deploy Safes per chain

For each Phase-1 mainnet chain — Ethereum, Base, Arbitrum, Optimism,
Polygon zkEVM, BNB Chain — repeat:

### B.1 Via Safe UI (recommended for first time)

1. Browser → [app.safe.global](https://app.safe.global) → connect
   deployer wallet → "Create new Safe"
2. Pick the chain in the network dropdown
3. Add owners (paste each signer's address; they don't sign anything
   yet — they're just listed as approved signers)
4. Set threshold (2-of-3 for governance, 1-of-3 for ops)
5. Deploy. Cost: ~0.005 ETH on Ethereum, dust on L2s
6. Record the Safe address — you'll paste it into `.env` next

### B.2 Same-address-everywhere (cross-chain via SafeProxyFactory)

If you want the **same Safe address on every chain** for operational
clarity (one address to remember, one address to whitelist on
dashboards), use the cross-chain Safe deploy flow. The Safe v1.4.1
contracts are deployed at a deterministic address on every chain via
CREATE2; if you also use the same nonce on each chain when calling
`createProxyWithNonce`, the resulting Safe address is identical
across chains.

```bash
# One-liner using @safe-global/safe-deployments + ethers (script not
# provided in this repo — out of scope for the runbook)
# See: https://docs.safe.global/sdk/protocol-kit
```

This is the recommended path if you have ops bandwidth to set it up
once. Otherwise per-chain Safes (different addresses) work fine — the
deploy script reads `TIMELOCK_PROPOSER` per chain from `.env` so the
fan-out is just an env-var bookkeeping concern.

### B.3 Two Safes per chain × six chains = 12 Safes total

That's the Phase 1 footprint. Set aside ~1 hour for the full fan-out,
including funding each Safe with a small amount of native gas (so
they can pay for the proposing tx) — `cast send --value 0.05ether`
from the deployer is enough.

---

## C. Wire the governance Safe address into `.env`

Edit [contracts/.env](../../contracts/.env):

```bash
# Old (single EOA — for testnet rehearsal):
TIMELOCK_PROPOSER=0x44CEFFF7643CAfFDD029030D4c7920e1551e9583

# New (governance Safe address from step B):
TIMELOCK_PROPOSER=0x<safe-addr>
```

If different chains have different Safe addresses (you skipped step
B.2), use the per-chain override pattern that the deploy scripts
already use elsewhere:

```bash
ETHEREUM_TIMELOCK_PROPOSER=0x<eth-safe>
BASE_TIMELOCK_PROPOSER=0x<base-safe>
ARB_TIMELOCK_PROPOSER=0x<arb-safe>
# ... etc
```

You'll need to add a small read-with-fallback shim to
[DeployTimelock.s.sol](../../contracts/script/DeployTimelock.s.sol)
to consume those — currently it only reads `TIMELOCK_PROPOSER`. The
shim is a 5-line patch (try `<SLUG>_TIMELOCK_PROPOSER` first, fall
back to `TIMELOCK_PROPOSER`). Take it as a separate small PR before
the multisig rollout if you go this route.

Also set the optional knobs if you want non-defaults:

```bash
TIMELOCK_MIN_DELAY=172800   # default 48h; minimum 1h enforced by script
TIMELOCK_EXECUTOR=0x0000000000000000000000000000000000000000
                            # default open-execute; set to a Safe to gate
                            # execution as well as proposing (see §F.3)
```

---

## D. Deploy TimelockController per chain

Run [DeployTimelock.s.sol](../../contracts/script/DeployTimelock.s.sol)
against each chain's RPC. The script:

- Constructs an OZ `TimelockController` with `minDelay`, the proposer
  Safe as the only proposer/canceller, `address(0)` as executor (open
  execution, see §F.3), `address(0)` as admin (self-administered)
- Writes the deployed timelock address into
  `deployments/<chain-slug>/addresses.json` under `.timelock` so
  downstream scripts can read it

Per chain:

```bash
cd contracts
set -a; source .env; set +a
forge script script/DeployTimelock.s.sol \
    --rpc-url $ETHEREUM_RPC_URL \
    --broadcast \
    --slow
```

Verify the resulting timelock on-chain:

```bash
TIMELOCK=$(jq -r .timelock deployments/ethereum/addresses.json)
SAFE=$(echo $TIMELOCK_PROPOSER)

# Must be the Safe, not the deployer EOA
cast call $TIMELOCK \
    "hasRole(bytes32,address)(bool)" \
    $(cast keccak "PROPOSER_ROLE") \
    $SAFE \
    --rpc-url $ETHEREUM_RPC_URL

# Must NOT have a default admin (self-administered)
cast call $TIMELOCK \
    "hasRole(bytes32,address)(bool)" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    $(cast wallet address $PRIVATE_KEY) \
    --rpc-url $ETHEREUM_RPC_URL
# Should print: false
```

---

## E. Hand Diamond admin to the timelock

Run [TransferAdminToTimelock.s.sol](../../contracts/script/TransferAdminToTimelock.s.sol).
This is the irreversible step. Read the script comments before
running — it spells out the exact 7-step sequence (5 grants, 1
ownership transfer, 6 renounces, in that order so that any mid-flight
revert leaves the deployer able to retry).

```bash
cd contracts
set -a; source .env; set +a
CONFIRM_HANDOVER=YES forge script script/TransferAdminToTimelock.s.sol \
    --rpc-url $ETHEREUM_RPC_URL \
    --broadcast \
    --slow
```

The `CONFIRM_HANDOVER=YES` env guard is a typo-safety net; if the
script is launched against the wrong RPC by accident, the missing
guard fails fast.

After the script completes, the deployer EOA cannot make any
admin-gated call. Test it explicitly:

```bash
DEPLOYER=$(cast wallet address $PRIVATE_KEY)
DIAMOND=$(jq -r .diamond deployments/ethereum/addresses.json)

# Should revert with "AccessControl: account ... is missing role ..."
cast send $DIAMOND \
    "setProtocolPaused(bool)" true \
    --rpc-url $ETHEREUM_RPC_URL \
    --private-key $PRIVATE_KEY
```

If this revert does NOT fire, the handover did not complete cleanly —
DO NOT proceed to step F. Re-read [GovernanceRunbook.md §6](GovernanceRunbook.md)
for recovery steps and contact the deployer.

---

## F. Post-handover wiring

### F.1 Grant PAUSER_ROLE + KYC_ADMIN_ROLE to ops Safe

The handover script intentionally does NOT grant these to the
timelock — they need same-hour response. Grant them directly to the
ops Safe **through the timelock** (because the deployer EOA can no
longer grant roles):

```bash
DIAMOND=$(jq -r .diamond deployments/ethereum/addresses.json)
TIMELOCK=$(jq -r .timelock deployments/ethereum/addresses.json)
GOV_SAFE=$TIMELOCK_PROPOSER
OPS_SAFE=0x<ops-safe-addr>
PAUSER_ROLE=$(cast keccak "PAUSER_ROLE")
KYC_ADMIN_ROLE=$(cast keccak "KYC_ADMIN_ROLE")

# Step 1: encode the grantRole calldata
PAUSER_CALLDATA=$(cast calldata "grantRole(bytes32,address)" $PAUSER_ROLE $OPS_SAFE)
KYC_CALLDATA=$(cast calldata "grantRole(bytes32,address)" $KYC_ADMIN_ROLE $OPS_SAFE)

# Step 2: gov Safe calls TimelockController.schedule(...) for each — see
#         GovernanceRunbook.md for the schedule/execute lifecycle.
# Step 3: wait 48h delay
# Step 4: anyone calls TimelockController.execute(...) for each
```

The
[GovernanceRunbook.md](GovernanceRunbook.md)
documents the schedule → wait → execute lifecycle in full; this
runbook stops at the timelock-is-live state and hands off to that doc
for ongoing operations.

### F.2 Verify final role distribution

After F.1 lands and the 48h delay elapses + execute fires:

```bash
DIAMOND=$(jq -r .diamond deployments/ethereum/addresses.json)
DEFAULT_ADMIN=0x0000000000000000000000000000000000000000000000000000000000000000

for role in DEFAULT_ADMIN_ROLE ADMIN_ROLE ORACLE_ADMIN_ROLE \
            RISK_ADMIN_ROLE VAULT_ADMIN_ROLE PAUSER_ROLE \
            KYC_ADMIN_ROLE; do
  HASH=$([ "$role" = DEFAULT_ADMIN_ROLE ] && echo $DEFAULT_ADMIN || cast keccak "$role")
  echo "=== $role ==="
  echo "  timelock holds: $(cast call $DIAMOND "hasRole(bytes32,address)(bool)" $HASH $TIMELOCK --rpc-url $ETHEREUM_RPC_URL)"
  echo "  gov Safe holds: $(cast call $DIAMOND "hasRole(bytes32,address)(bool)" $HASH $GOV_SAFE --rpc-url $ETHEREUM_RPC_URL)"
  echo "  ops Safe holds: $(cast call $DIAMOND "hasRole(bytes32,address)(bool)" $HASH $OPS_SAFE --rpc-url $ETHEREUM_RPC_URL)"
  echo "  deployer holds: $(cast call $DIAMOND "hasRole(bytes32,address)(bool)" $HASH $DEPLOYER --rpc-url $ETHEREUM_RPC_URL)"
done
```

Expected end-state:

| Role | Timelock | Gov Safe | Ops Safe | Deployer |
|---|---|---|---|---|
| DEFAULT_ADMIN_ROLE | ✓ | — | — | — |
| ADMIN_ROLE | ✓ | — | — | — |
| ORACLE_ADMIN_ROLE | ✓ | — | — | — |
| RISK_ADMIN_ROLE | ✓ | — | — | — |
| VAULT_ADMIN_ROLE | ✓ | — | — | — |
| PAUSER_ROLE | — | — | ✓ | — |
| KYC_ADMIN_ROLE | — | — | ✓ | — |
| ERC-173 owner | ✓ | — | — | — |

If the deployer column has any ✓, step E was incomplete — go back and
finish the renounces.

### F.3 Optional: gate execution behind the gov Safe

Default deploy uses `TIMELOCK_EXECUTOR=address(0)`, meaning **anyone**
can call `execute()` once the 48h elapses. This protects against a
malicious-but-still-threshold-controlled gov Safe blocking benign ops
by simply not executing them — anyone (including a bot or a friendly
community member) can step in.

The trade is a marginal MEV / front-run surface: in the seconds
between "delay elapsed" and "execute lands", a bot could front-run.
For Vaipakam this isn't a meaningful risk because the ops are admin
parameter changes (not value-extracting), but if your threat model
disagrees, set `TIMELOCK_EXECUTOR=$GOV_SAFE` at deploy time. Trade-off:
saves the front-run surface, costs you DoS resilience.

---

## G. Rehearse before mainnet

Before any mainnet broadcast in steps D–F, **fully rehearse on
Sepolia** using the existing testnet Diamonds. Sequence:

```bash
# Use a throwaway 1-of-1 Safe on Base Sepolia for the rehearsal
TIMELOCK_PROPOSER=0x<test-safe-addr> \
forge script script/DeployTimelock.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow

CONFIRM_HANDOVER=YES \
forge script script/TransferAdminToTimelock.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow

# Verify the deployer is now locked out (cast send any admin op,
# expect revert)
# Verify the test Safe can schedule via the Safe Transaction Service
# Verify execute lands after 48h (or set TIMELOCK_MIN_DELAY=3600 for
# the rehearsal)
```

Document the actual gas costs and signer wall-clock times in your
issue tracker before quoting a mainnet maintenance window.

---

## H. Off-chain runbooks signers should have read

Every signer needs to know how to:

1. **Open the Safe Transaction Service** at
   [app.safe.global](https://app.safe.global), connect their hardware
   wallet, review pending transactions, sign or reject
2. **Decode timelock calldata** — Safe UI shows the raw selector;
   signers should paste it into [4byte.directory](https://4byte.directory)
   or use the Tenderly transaction simulator to confirm it's not a
   role grant to an attacker address
3. **Cancel a pending op** — `TimelockController.cancel(bytes32 id)`
   is a fast path the proposer can take during the 48h window if a
   signer turns out to have been compromised. Walk every signer
   through this drill at least once on Sepolia.

If signers don't know step 3, the timelock is effectively no
protection — a stolen signer key + a still-active proposer Safe means
the attacker can schedule, wait 48h, execute. The other signers MUST
know to cancel, and MUST be reachable on a 48h timer.

---

## Appendix: file-level pointers

- [DeployTimelock.s.sol](../../contracts/script/DeployTimelock.s.sol) —
  step D's broadcast target
- [TransferAdminToTimelock.s.sol](../../contracts/script/TransferAdminToTimelock.s.sol) —
  step E's broadcast target
- [AccessControlFacet.sol](../../contracts/src/facets/AccessControlFacet.sol) —
  the `grantRole` / `renounceRole` surface invoked by the handover
- [LibAccessControl.sol](../../contracts/src/libraries/LibAccessControl.sol) —
  role-hash constants (`ADMIN_ROLE`, `PAUSER_ROLE`, etc.)
- [GovernanceRunbook.md](GovernanceRunbook.md) — what to do once the
  timelock is live (schedule/execute lifecycle, common ops)
- [IncidentRunbook.md](IncidentRunbook.md) — pause flow during an
  incident, including the ops-Safe → `pause()` direct path that
  bypasses the 48h delay
