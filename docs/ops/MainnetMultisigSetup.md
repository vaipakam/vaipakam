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
- [AdminKeysAndPause.md](AdminKeysAndPause.md) — which roles sit on
  the Timelock, the Pauser Safe and the governance Safe
- [DeploymentRunbook.md](DeploymentRunbook.md) — the full per-chain
  deploy sequence the timelock setup plugs into at the end

---

## TL;DR — six steps, in order

```
[A]  Pick signer set + threshold for the governance Safe + the Pauser Safe
[B]  Deploy both Safes per chain via app.safe.global (or via SafeProxyFactory CLI)
[C]  Set TIMELOCK_PROPOSER, EMERGENCY_REVOKER_ADDRESS (governance Safe) and
     PAUSER_ADDRESS (Pauser Safe) in .env
[D]  forge script DeployTimelock.s.sol --broadcast
[E]  forge script Handover.s.sol --broadcast
[F]  Accept the cross-chain ownerships through the Timelock, then verify
```

Step E is irreversible — once the admin EOA renounces
`DEFAULT_ADMIN_ROLE`, only the Timelock can reach the Diamond's admin
surface. Rehearse the entire sequence on a testnet Diamond before
running it on a mainnet Diamond. `deploy-mainnet.sh` runs D and E as its
timelock and handover phases; the commands below are what those phases
execute.

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

### A.1 Governance Safe (timelock proposer + emergency revoker)

Holds the Timelock's `PROPOSER_ROLE` (and, through OpenZeppelin,
`CANCELLER_ROLE`), so it queues every parameter change, every grant and
every upgrade, each of which waits out the 48h delay. On the Diamond it
holds exactly one role, `EMERGENCY_REVOKER_ROLE` (owner decision D1,
#934): it can strip a role from a compromised hot key immediately, and
nothing else. It cannot grant a role, cannot touch the role root
(`DEFAULT_ADMIN_ROLE`, which sits on the Timelock) and cannot remove
anything the Diamond owner holds, so a captured governance Safe can
neither take governance nor disarm it without the delay.

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

### A.2 Pauser Safe (pause + the Timelock veto)

Holds `PAUSER_ROLE` directly on the Diamond (and is the guardian of
every `GuardianPausable` cross-chain contract), bypassing the Timelock
because pausing during an incident cannot wait 48h. It is also the
Timelock's **independent canceller** (#938): it can cancel any queued
operation, but it cannot propose one, and it cannot cancel a single-call
operation that removes it as canceller (a proposer or another canceller
can), so a compromised
Pauser Safe cannot block its own removal. It cannot unpause (that is
`UNPAUSER_ROLE`, on the Timelock), so a compromised Pauser Safe cannot
re-enable a contract the incident team froze.

`KYC_ADMIN_ROLE` is no longer an ops-Safe role: `Handover.s.sol` gives it
to the Timelock, and KYC enforcement is off on the retail deploy anyway.

| Threshold | Signers |
|---|---|
| **1-of-3** | three on-call operators (founder + 2 ops engineers) |

1-of-3 is acceptable here because the only powers are defensive:
`pause()` / `pauseAsset()` and cancelling a queued operation. The blast
radius of a leaked 1-of-3 Pauser signer key is bounded to
denial-of-service: a spurious pause (the Timelock unpauses) or cancelled
operations (the governance Safe queues them again). The governance Safe
can also strip the leaked Safe's `PAUSER_ROLE` at once with
`emergencyRevokeRole`. The trade is faster incident response; the
alternative (2-of-3) adds ~5 min to every pause and has historically lost
protocols millions in those minutes.

The Pauser Safe must be a different Safe from the governance Safe:
`DeployTimelock` and `Handover` both refuse the same address in both
places, because a veto held by the proposer is no veto.

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
4. Set threshold (2-of-3 for governance, 1-of-3 for the Pauser Safe)
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

## C. Wire the Safe addresses into `.env`

Edit [contracts/.env](../../contracts/.env):

```bash
TIMELOCK_PROPOSER=0x<governance-safe>          # queues Timelock operations
EMERGENCY_REVOKER_ADDRESS=0x<governance-safe>  # the Safe's one Diamond role
PAUSER_ADDRESS=0x<pauser-safe>                 # PAUSER_ROLE + Timelock canceller
```

`TIMELOCK_PROPOSER` and `EMERGENCY_REVOKER_ADDRESS` must be the same address.
`DeployTimelock.s.sol` refuses a mismatch, and `Handover.s.sol` refuses a
Timelock that does not grant the revoker Safe `PROPOSER_ROLE`.

`DEFAULT_ADMIN_ADDRESS` is retired (D1): `Handover.s.sol` refuses to run
while it is set, because it named the topology in which the governance
Safe held the role root. `TIMELOCK_CANCELLER` is retired too:
`DeployTimelock.s.sol` refuses it and takes the canceller from
`PAUSER_ADDRESS`, so one variable names the Pauser Safe for both scripts.

Optional knobs:

```bash
TIMELOCK_MIN_DELAY=172800   # default 48h; a Phase-1 mainnet refuses less.
                            # Also the permanent floor (MIN_DELAY_FLOOR).
TIMELOCK_EXECUTOR=0x0000000000000000000000000000000000000000
                            # default open-execute; set to a Safe to gate
                            # execution as well as proposing (see §F.3)
```

The deploy scripts read one value of each per run. If the Safes have
different addresses on different chains (you skipped B.2), keep a `.env`
per chain.

---

## D. Deploy the Timelock per chain

Run [DeployTimelock.s.sol](../../contracts/script/DeployTimelock.s.sol)
against each chain's RPC. It deploys `VaipakamTimelock` (an OpenZeppelin
`TimelockController` with no external admin) with:

- `minDelay` as both the delay and the permanent floor;
- the governance Safe as the only proposer;
- the Pauser Safe (`PAUSER_ADDRESS`) as the independent canceller. On a
  Phase-1 mainnet both Safes must be deployed contracts and must differ;
- `address(0)` as executor unless `TIMELOCK_EXECUTOR` is set (open
  execution, see §F.3).

It records the address in `deployments/<chain-slug>/addresses.json`
under `.timelock`, which the handover reads.

```bash
cd contracts
set -a; source .env; set +a
forge script script/DeployTimelock.s.sol \
    --rpc-url $ETHEREUM_RPC_URL \
    --broadcast \
    --slow
```

Verify the resulting Timelock on-chain:

```bash
TIMELOCK=$(jq -r .timelock deployments/ethereum/addresses.json)

# The governance Safe proposes
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" \
    $(cast keccak "PROPOSER_ROLE") $TIMELOCK_PROPOSER --rpc-url $ETHEREUM_RPC_URL
# The Pauser Safe can cancel (#938)
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" \
    $(cast keccak "CANCELLER_ROLE") $PAUSER_ADDRESS --rpc-url $ETHEREUM_RPC_URL
# The floor is the deploy-time delay
cast call $TIMELOCK "MIN_DELAY_FLOOR()(uint256)" --rpc-url $ETHEREUM_RPC_URL
# Nobody but the Timelock administers it: the deployer must print false
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    $(cast wallet address $DEPLOYER_PRIVATE_KEY) --rpc-url $ETHEREUM_RPC_URL
```

---

## E. Hand the Diamond and the cross-chain contracts to governance

Run [Handover.s.sol](../../contracts/script/Handover.s.sol) as the admin
EOA. This is the irreversible step, and the only handover script: #936
retired `GrantOpsRoles.s.sol` and `TransferAdminToTimelock.s.sol`, which
split the roles differently and did not know the D1 topology. The
sequence, and what the script checks before it broadcasts, is written out
in [GovernanceRunbook.md §2–4](GovernanceRunbook.md). In short: the role
root and ownership go to the Timelock, the six delayed roles go to the
Timelock, `PAUSER_ROLE` goes to the Pauser Safe, the emergency revoker
goes to the governance Safe, the admin EOA renounces with the role root
last, and every cross-chain contract gets the Timelock proposed as its
owner. It refuses a Timelock that does not name `PAUSER_ADDRESS` as its
canceller.

```bash
cd contracts
set -a; source .env; set +a
CHAIN_SLUG=ethereum forge script script/Handover.s.sol \
    --rpc-url $ETHEREUM_RPC_URL \
    --broadcast \
    --slow
```

After the script completes, the admin EOA cannot make any admin-gated
call. Test it explicitly — this must revert with a missing-role error:

```bash
DIAMOND=$(jq -r .diamond deployments/ethereum/addresses.json)
cast send $DIAMOND "pause()" \
    --rpc-url $ETHEREUM_RPC_URL \
    --private-key $ADMIN_PRIVATE_KEY
```

If it does NOT revert, the handover did not complete — do not proceed.

---

## F. Post-handover

### F.1 Accept the cross-chain ownerships through the Timelock

Every cross-chain contract now lists the Timelock as its pending owner.
The governance Safe schedules `acceptOwnership()` on each (and
`acceptAdminRole` on the CCIP token admin registry) through the Timelock,
waits 48h and executes. [GovernanceRunbook.md §5](GovernanceRunbook.md)
has the exact calls.

### F.2 Verify final role distribution

```bash
DIAMOND=$(jq -r .diamond deployments/ethereum/addresses.json)
TIMELOCK=$(jq -r .timelock deployments/ethereum/addresses.json)
GOV_SAFE=$EMERGENCY_REVOKER_ADDRESS
PAUSER_SAFE=$PAUSER_ADDRESS
ADMIN=$ADMIN_ADDRESS
ROOT=0x0000000000000000000000000000000000000000000000000000000000000000

for role in DEFAULT_ADMIN_ROLE ADMIN_ROLE UNPAUSER_ROLE KYC_ADMIN_ROLE \
            ORACLE_ADMIN_ROLE RISK_ADMIN_ROLE VAULT_ADMIN_ROLE \
            PAUSER_ROLE EMERGENCY_REVOKER_ROLE; do
  HASH=$([ "$role" = DEFAULT_ADMIN_ROLE ] && echo $ROOT || cast keccak "$role")
  echo "=== $role ==="
  for who in TIMELOCK GOV_SAFE PAUSER_SAFE ADMIN; do
    echo "  $who: $(cast call $DIAMOND "hasRole(bytes32,address)(bool)" $HASH ${!who} --rpc-url $ETHEREUM_RPC_URL)"
  done
done
cast call $DIAMOND "owner()(address)" --rpc-url $ETHEREUM_RPC_URL   # must be $TIMELOCK
```

Expected end-state:

| Role | Timelock | Gov Safe | Pauser Safe | Admin EOA |
|---|---|---|---|---|
| DEFAULT_ADMIN_ROLE | ✓ | — | — | — |
| ADMIN_ROLE | ✓ | — | — | — |
| UNPAUSER_ROLE | ✓ | — | — | — |
| KYC_ADMIN_ROLE | ✓ | — | — | — |
| ORACLE_ADMIN_ROLE | ✓ | — | — | — |
| RISK_ADMIN_ROLE | ✓ | — | — | — |
| VAULT_ADMIN_ROLE | ✓ | — | — | — |
| PAUSER_ROLE | — | — | ✓ | — |
| EMERGENCY_REVOKER_ROLE | — | ✓ | — | — |
| ERC-173 owner | ✓ | — | — | — |

`WATCHER_ROLE`, `NOTIF_BILLER_ROLE` and `KEEPER_ROLE` stay on the admin
EOA until the per-bot keys are set up; nothing else may. If the admin
column has any other ✓, step E did not complete.

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

Before any mainnet broadcast in steps D–F, **fully rehearse on a
testnet** with a fresh Diamond and throwaway Safes (two distinct
1-of-1 Safes are enough). Run steps D and E exactly as above against
the testnet RPC, with `TIMELOCK_MIN_DELAY=3600` so the accepts in F.1
land in an hour. Then:

- confirm the admin EOA is locked out (the `pause()` call in E reverts);
- schedule an operation from the test governance Safe through the Safe
  Transaction Service, and cancel it from the test Pauser Safe;
- schedule it again, let it execute after the delay;
- run the F.2 readback.

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
   is a fast path either Safe can take during the 48h window: the
   governance Safe (the proposer) and the Pauser Safe (the independent
   canceller, #938). Walk every signer of both Safes through this drill
   at least once on a testnet.

If signers don't know step 3, the timelock is effectively no
protection — a captured governance Safe can schedule, wait 48h,
execute. The Pauser Safe exists so that a veto survives the capture of
the governance Safe; its signers MUST know to cancel, and MUST be
reachable on a 48h timer.

---

## Appendix: file-level pointers

- [DeployTimelock.s.sol](../../contracts/script/DeployTimelock.s.sol) —
  step D's broadcast target
- [Handover.s.sol](../../contracts/script/Handover.s.sol) —
  step E's broadcast target
- [AccessControlFacet.sol](../../contracts/src/facets/AccessControlFacet.sol) —
  the `grantRole` / `renounceRole` surface invoked by the handover
- [LibAccessControl.sol](../../contracts/src/libraries/LibAccessControl.sol) —
  role-hash constants (`ADMIN_ROLE`, `PAUSER_ROLE`, etc.)
- [GovernanceRunbook.md](GovernanceRunbook.md) — what to do once the
  timelock is live (schedule/execute lifecycle, common ops)
- [IncidentRunbook.md](IncidentRunbook.md) — pause flow during an
  incident, including the Pauser Safe → `pause()` direct path that
  bypasses the 48h delay
