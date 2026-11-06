# Vault code resolved centrally (#3204)

Status: **design for owner review**. Nothing here is built yet. The owner's
decisions of 2026-11-05 are recorded in the issue and repeated where they
apply. Every other choice this document makes is marked **Default**, so the
owner can overturn it before code starts.

## 1. The problem

Every user vault is its own UUPS proxy (`ERC1967Proxy` created by
`VaultFactoryFacet.getOrCreateUserVault`). A new vault implementation reaches
a vault only when that vault is upgraded, one at a time:

- `upgradeVaultImplementation` (VAULT_ADMIN_ROLE) swaps the shared template
  and bumps `currentVaultVersion`. Existing vaults do not move.
- `upgradeUserVault(user)` moves one vault to the current template. Anyone
  may call it, except on a vault its owner has **pinned**: only the owner
  upgrades a pinned vault, and under protected mode only after the unpin
  delay.
- `setMandatoryVaultUpgrade` sets a floor. A vault below it is held back from
  Diamond interactions, and since #3178 (PR #3220) from its owner's own
  outflows only.
- The rental route's catch-up upgrades an unpinned lender vault in passing.

So a fix to vault code is never platform-wide in one step. A pinned vault
may run old code forever. The "vault below the mandatory version" rules exist
only to contain that lag, and #3178 had to trade one trap (counterparties
blocked) for an accepted residual (old vault code keeps running for its
owner's payouts).

## 2. The decision

Owner, 2026-11-05: **one central pointer, beacon style.** Each vault proxy
asks the Diamond which code to run, so one timelocked change reaches every
vault.

- A **pin** means "stay on version N", recorded per vault.
- Governance can **revoke** a version through the timelock, which moves every
  vault on it, pinned or not, off it.
- **Q1, the emergency path.** The guardian can revoke a version immediately,
  but only while the protocol is paused, and vaults move only to a version
  already in the registry. The guardian can take code away, never bring code
  in. Adding a version stays timelock-only.
- **Q2, notice.** The app's countdown reads the timelock's own schedule.
  There is no separate "announced" step inside the Diamond.
- **Q3, #3178.** Its below-mandatory rules are removed in this change, since
  they become unreachable. #3178 still ships first and protects vaults until
  this reaches a chain.

## 3. The design

### 3.1 How a vault finds its code

Each new vault is an OpenZeppelin `BeaconProxy` whose beacon is **the
Diamond**. On every call, the proxy calls `implementation()` on its beacon
and delegatecalls the address it gets back.

The Diamond routes `implementation()` (selector `0x5c60da1b`) to the vault
factory, which answers **for the calling proxy**:

1. `user = vaultUserOf[msg.sender]`. A caller that is not a registered vault
   gets the current version's code. That is harmless, because a non-vault
   gains nothing from knowing it.
2. If `user` has a pin and the pinned version is not revoked, return that
   version's implementation.
3. Otherwise return the **current** version's implementation.

One function decides which code every vault runs, and it reads three storage
slots. No vault can run code the registry does not hold.

**Default: a stock `BeaconProxy`, not a custom proxy.** It is audited, and
its only dependency is a beacon that answers `implementation()`. No other
facet exposes that selector today (checked against `main`).
`SelectorCoverageTest` keeps it unique.

**Cost.** Every vault call adds one external view call into the Diamond:
the fallback's selector lookup plus about three reads. That is roughly 7-10k
gas cold, and much less when warm within the same transaction. It is measured
in the build PR and reported against the current per-call cost. If it proves
material for the heaviest paths (the batch payout loops), the fallback is to
cache the answer in transient storage for the transaction, keyed by vault.
Nothing is cached across transactions, because that would bring the lag back.

### 3.2 The version registry

New Diamond storage, appended at the tail per the storage-layout rules:

| Field | Meaning |
| --- | --- |
| `vaultVersions[id]` | `{implementation, status}`, where status is Registered or Revoked. Ids start at 1. |
| `vaultVersionCount` | The highest id. |
| `currentVaultVersionId` | The version every unpinned vault runs. |
| `vaultPinnedVersion[user]` | 0 = not pinned. Otherwise the id the owner chose. |

Entry points, all on the vault factory:

| Call | Who | Rule |
| --- | --- | --- |
| `registerVaultVersion(impl)` | VAULT_ADMIN_ROLE (the Timelock after handover) | `impl` must have code and report the vault layout identity (a constant the implementation exposes, so a non-vault contract cannot be registered by mistake). Its initializers must be disabled at construction. That cannot be read on-chain, so a test and the deploy script check it. Emits `VaultVersionRegistered(id, impl)`. |
| `setCurrentVaultVersion(id)` | VAULT_ADMIN_ROLE | `id` must be registered and not revoked. Emits `CurrentVaultVersionSet(old, new)`. |
| `revokeVaultVersion(id, successorId)` | VAULT_ADMIN_ROLE | See 3.3. |
| `guardianRevokeVaultVersion(id, successorId)` | PAUSER_ROLE (the Pauser Safe), **only while paused** | Same effect as the timelock revoke. Can never register code. |
| `pinVaultVersion(id)` | The vault's manager (`LibProtectedAccount.requireManager`) | `id` must be registered and not revoked. Replaces `pinVaultImplementation`. |
| `unpinVaultVersion(account)` | The manager | Unchanged rules: immediate without protected mode, the delay with it. |

**Default: the guardian is `PAUSER_ROLE`.** The existing pause holder is the
party the decision means. A separate role would add a key to protect and gain
nothing.

### 3.3 Revocation

Revoking marks a version Revoked, so every vault resolving to it moves at
once. **Default: where its vaults go.**

- A **pinned** vault whose version is revoked resolves to the **current**
  version. Its owner may pin again to any registered version.
- Revoking the **current** version requires `successorId`. That must be
  registered and not revoked, and it becomes current in the same call.
  Otherwise `successorId` must be 0.
- So there is one resolution rule, "pinned and not revoked, else current",
  and there are no successor chains to walk. Revocation is final. A revoked
  version is never un-revoked: a fixed build is registered as a new version.

Both revoke paths emit `VaultVersionRevoked(id, successorId, byGuardian)`.

On notice (Q2): a timelock revoke or upgrade is visible as soon as the
Timelock schedules it (`CallScheduled`), with its execution time. The app
counts down from that. A guardian revoke has no countdown, because it is the
emergency path. The app states the protocol is paused and which version was
revoked.

### 3.4 What is removed

Fresh-deploy family, so it is removed outright, with no migration (prelive):

- per-vault UUPS: `UUPSUpgradeable` comes out of `VaipakamVaultImplementation`, so no vault can be upgraded on its own;
- `upgradeUserVault`, `upgradeVaultImplementation` (#3235's first entry: no delay and open while paused; registration is now timelock-only, and a guardian revoke works only while paused, which is the point);
- `setMandatoryVaultUpgrade`, `currentVaultVersion`, `mandatoryVaultVersion`, `vaultVersion[user]` and `vaultPinnedImplementation`;
- `LibVaipakam.vaultUpgradeRequired` and every #3178 rule built on it (Q3);
- the rental route's catch-up upgrade in `vaultSetRentalUser`;
- the `VaultUpgradeRequired` / `VaultNotCurrent` errors and their app copy.

The storage-layout guard records the removed fields as a deliberate break in
`breaks.ack.json`. That records that no chain is upgraded in place across
this change, which is true by decision O1 = A and by the mainnet rule (one
fresh deploy).

**Out of scope:** the ERC-4626 aggregator adapters run the same per-proxy
machinery (`currentAdapterVersion`, `mandatoryAdapterVersion`). They hold
protocol-owned capital, not user custody, so they are a separate follow-up
card if wanted. They are not folded in here.

### 3.5 What stays true

- **Every vault accepts calls only from the Diamond.** The implementation's
  `onlyDiamond` gate is unchanged, and the beacon changes only which code
  runs.
- **Vault storage stays one layout across versions.** Every registered
  version must keep the vault's storage append-only. The storage-layout
  guard's vault root changes from "UUPS implementation" to "beacon
  implementation", with the same rule, and `registerVaultVersion` checks the
  layout identity constant.
- **Who can change vault code does not widen.** Today the same role can swap
  the template and anyone can push unpinned vaults onto it, with no delay.
  After this change, a code change needs the Timelock. The Diamond's own
  `diamondCut` was already able to rewrite any storage, and stays behind the
  same Timelock.

### 3.6 The vault-side checks (#3205)

#3205 adds checks inside the vault implementation itself, so a faulty or
malicious facet alone cannot pay an arbitrary wallet:
- an owner allowlist held in the vault's own storage;
- a genuine-vault code-identity check;
- a timelocked adapter and conduit registry;
- a lien the vault recorded when the position opened.

They belong to the first version registered under this design, and #3205's
design note specifies them. They are why this change is fund safety and not
only upgrade plumbing: with central resolution, one timelocked registration
puts those checks into every vault at once.

## 4. App and indexer

- **Vault page:** the version the vault runs, whether it is pinned and to
  which version, and whether that version is revoked. If a timelock change to
  the current version or a revoke is scheduled, show what changes and when,
  read from the Timelock schedule (Q2).
- **Indexer:** `VaultVersionRegistered`, `CurrentVaultVersionSet`,
  `VaultVersionRevoked`, `VaultVersionPinned` and `VaultVersionUnpinned`.
  These replace the per-vault upgrade events.
- **Remove:** every "upgrade your vault" prompt, and the #3178 "waits for
  the upgrade" copy.

## 5. Spec changes

`ProjectDetailsREADME.md` (vault pin and mandatory-version rules) and
`VaultOperations.md` are rewritten to state:
- the resolution rule;
- what a pin promises: your vault runs version N until you change it, or
  until governance revokes N;
- who can register, revoke and pin;
- that a revoke can move a pinned vault without its owner's consent;
- that the guardian path works only while paused and only to registered
  code.

## 6. Tests (acceptance)

- One `setCurrentVaultVersion` changes the code every unpinned vault runs,
  checked by a version marker the implementation reports.
- A pinned vault keeps its version across a current-version change, and
  moves when its version is revoked.
- The guardian revoke is refused while unpaused, and refused for an
  unregistered successor. The guardian can register nothing.
- `registerVaultVersion` refuses:
  - a contract without the layout identity;
  - a caller without VAULT_ADMIN_ROLE.

  The deploy script refuses to register an implementation whose
  initializer can still be called.
- `implementation()` answers per calling proxy. A pin by user A never
  affects user B.
- Every vault still refuses a non-Diamond caller, on every version.
- Storage-layout guard: the beacon-implementation root, and a version that
  breaks layout fails the guard.
- Gas: the per-call cost of the beacon lookup on the heaviest paths,
  reported in the PR.
- Deploy-sanity and targeted suites, as usual.

## 7. Order of work

1. #3220 (#3178) merges and protects vaults on today's chains.
2. This design is reviewed.
3. #3205's design note (vault-side checks) is written, since they ship in
   the first registered version.
4. One build PR for this change, then #3205's.

Both reach chains by fresh deploy.
