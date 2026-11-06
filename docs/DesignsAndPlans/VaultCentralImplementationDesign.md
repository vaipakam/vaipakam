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
vault. (Section 3.1 proposes holding that pointer in a separate
Timelock-owned beacon instead of the Diamond's storage, for the reason it
gives.)

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

Each new vault is an OpenZeppelin `BeaconProxy` whose beacon is a **separate
`VaultBeacon` contract**, not the Diamond. On every call, the proxy calls
`implementation()` on its beacon and delegatecalls the address it gets back.

**Why not the Diamond (a change from the decision's wording, review round
4).** The decision says each vault asks the Diamond. But every facet runs by
`delegatecall` in the Diamond's storage, so a faulty or malicious facet
could overwrite a version's implementation address directly, with no
`diamondCut` and no Timelock, and every vault would then run its code. That
would void #3205's vault-side checks, which exist precisely to bound what a
facet can do. Keeping the decision's intent (one timelocked pointer that
reaches every vault) needs the pointer to live where no facet can write it.
**This is put to the owner** with the rest of this design.

`VaultBeacon` holds the version registry and the pins, and answers **for
the calling proxy**:
1. If the calling vault has a pin and the pinned version is not revoked,
   return that version's implementation.
2. Otherwise return the **current** version's implementation. A caller that
   is not a vault gets the current version, which tells it nothing useful.

Its owner is the Timelock. The Diamond has no write path into it except
the pin entries below, which can only choose among registered, non-revoked
versions.

Because the lookup goes to the beacon and not the Diamond, the Diamond's
fill lock (#1566 slice 3) never sees it, and needs no exception.

**Default: a stock `BeaconProxy`, not a custom proxy.** It is audited, and
its only dependency is a beacon that answers `implementation()`.

**Cost.** Every vault call adds one external view call into the beacon:
about three storage reads, roughly 5-8k gas cold and much less when warm in
the same transaction. It is measured in the build PR and reported against
the current per-call cost. If it proves material for the heaviest paths
(the batch payout loops), the fallback is to cache the answer in transient
storage for the transaction, keyed by vault. Nothing is cached across
transactions, because that would bring the lag back.

### 3.2 The version registry

Storage of `VaultBeacon` (not the Diamond):

| Field | Meaning |
| --- | --- |
| `versions[id]` | `{implementation, status}`, where status is Registered or Revoked. Ids start at 1. |
| `versionCount` | The highest id. |
| `currentVersionId` | The version every unpinned vault runs. |
| `pinnedVersion[vault]` | 0 = not pinned. Otherwise the id the owner chose. |

Entry points, on `VaultBeacon`:

| Call | Who | Rule |
| --- | --- | --- |
| `registerVersion(impl)` | The Timelock (owner) | `impl` must have code and report the vault layout identity (a constant the implementation exposes, so a non-vault contract cannot be registered by mistake). Its initializers must be disabled at construction. That cannot be read on-chain, so a test and the deploy script check it. Emits `VaultVersionRegistered(id, impl)`. |
| `setCurrentVersion(id)` | The Timelock | `id` must be registered and not revoked. Emits `CurrentVaultVersionSet(old, new)`. |
| `revokeVersion(id, successorId)` | The Timelock | See 3.3. |
| `guardianRevokeVersion(id, successorId)` | The Pauser Safe, **only while the Diamond reports paused** | Same effect as the timelock revoke. Can never register code. |
| `setPin(vault, id)` / `clearPin(vault)` | The Diamond, on the vault manager's request | `id` must be registered and not revoked. The Diamond applies the manager check and, under protected mode, the delay and the lock (below). The beacon additionally verifies the owner's signature over the pin change (#3205 §8 Q1, decided 2026-11-06), against the owner wallet the vault itself records. |

The Diamond's request entries keep today's rules for who asks:

| Call | Who | Rule |
| --- | --- | --- |
| `pinVaultVersion(id)` | The vault's manager (`LibProtectedAccount.requireManager`) | Replaces `pinVaultImplementation`. Without protected mode it takes effect at once. Under protected mode, **every** pin change (a first pin, a replacement, a removal) changes the code the vault runs, so it goes through protected mode's delayed, cancellable settings path and is refused while the account is locked. |
| `unpinVaultVersion(account)` | The manager | Same rule: immediate without protected mode, the delay (and the lock check) with it. |

**Default: the guardian is the Pauser Safe**, the holder of `PAUSER_ROLE`.
The existing pause holder is the party the decision means. The beacon
reads the Diamond's pause state; a faulty facet could only set it to
paused, which lets the guardian move vaults to registered code and
nothing more. A separate role would add a key to protect and gain
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
- **No facet can change which code a vault runs**, because the registry
  and pins live in `VaultBeacon`, which no facet's storage writes reach.
  The Diamond can request a pin, only to registered non-revoked code, and
  only with the owner's authorization.
- **Vault storage stays one layout across versions.** Every registered
  version must keep the vault's storage append-only. The storage-layout
  guard's vault root changes from "UUPS implementation" to "beacon
  implementation", with the same rule, and `registerVersion` checks the
  layout identity constant.
- **A pin change is a code change.** Under protected mode, a stolen primary
  key cannot move a vault to another version on the spot, whether by pinning,
  re-pinning or unpinning. Today's `upgradeUserVault` refuses a protected
  pinned vault for the same reason.
- **Who can change vault code does not widen.** Today the same role can swap
  the template and anyone can push unpinned vaults onto it, with no delay.
  After this change, a code change needs the Timelock. The Diamond's own
  `diamondCut` was already able to rewrite any storage, and stays behind the
  same Timelock.
  This authority is custody-equivalent: registered code can do anything with
  a vault's funds, and a revoke moves pinned vaults too. #3205's vault-side
  checks live in the vault code, so they bound what a facet can make a vault
  do, not what governance's next version does. The 48h delay, the Pauser
  Safe's cancel and the alerting in #3237 are the defence, as the threat
  model's residuals state.

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

- One `setCurrentVersion` changes the code every unpinned vault runs,
  checked by a version marker the implementation reports.
- A pinned vault keeps its version across a current-version change, and
  moves when its version is revoked.
- The guardian revoke is refused while unpaused, and refused for an
  unregistered successor. The guardian can register nothing.
- `registerVersion` refuses:
  - a contract without the layout identity;
  - a caller other than the Timelock.

  The deploy script refuses to register an implementation whose
  initializer can still be called.
- Under protected mode, a first pin, a re-pin and an unpin each wait the
  delay, can be cancelled, and are refused while the account is locked.
- `implementation()` answers per calling proxy. A pin by user A never
  affects user B.
- A test facet that writes arbitrary Diamond storage cannot change any
  vault's implementation, and a pin request without the owner's
  authorization is refused by the beacon.
- Every vault still refuses a non-Diamond caller, on every version.
- Storage-layout guard: the beacon-implementation root, and a version that
  breaks layout fails the guard.
- A complete swap-to-repay fill with beacon vaults succeeds, and the
  Diamond's fill lock is unchanged.
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
