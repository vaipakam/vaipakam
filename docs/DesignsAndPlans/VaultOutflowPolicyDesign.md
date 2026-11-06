# One vault outflow policy, checked twice (#3205)

Status: **design for owner review**. The owner's decisions of 2026-11-05/06
are recorded on #3205 and repeated where they apply. Choices they did not
settle are marked **Default**. The four questions in §8 need an answer
before code starts. This builds on [#3204's central vault code
design](VaultCentralImplementationDesign.md) and ships after it.

## 1. The problem, measured

The vault accepts any recipient and any spender from the Diamond. Where
funds may go is decided path by path, in the facets that move them. An
inventory of `main` (2026-11-06) found:

- **11 vault functions** that move value or grant a spender:
  - `withdrawERC20`, `withdrawERC721` and `withdrawERC1155` (any recipient);
  - three conduit or self approvals;
  - `approveERC20` (any spender, exact amount);
  - listing order-hash register and revoke;
  - `isValidSignature`;
  - the inherited UUPS `upgradeToAndCall`.
- **13 wrappers** over them, in `VaultFactoryFacet`, `LibFacet`,
  `LibSanctionedLock`, `LibCloseoutFreeze` and `TreasuryFeeFacet`, plus the
  payout and depository entry routes on top.
- **About 93 withdraw call sites and 17 approval or listing call sites.**
- **9 groups of sites where the recipient comes from the caller's input.**
  They are listed in the private review notes rather than here, per the
  [threat model](ThreatModel.md)'s rule on attack-surface detail.

Each one pays the right party today because it was written to. Nothing
structural stops a buggy or malicious facet from paying anyone. The rules
that do exist are spread across protected mode (`LibProtectedAccount`), the
lien guard (`LibEncumbrance.freeBalance`), the tracked-balance counter, the
delivery checks and the sanctions lock.

## 2. The decisions (owner, 2026-11-06)

- **One policy.** Every movement out of a user vault passes one Diamond
  function. It takes the vault owner, asset, token id, amount, recipient,
  destination class, reason and the loan or offer id. It checks the
  recipient against the class, applies the pause and version rules, and
  emits one event per movement.
- **Two keys.** The Diamond checks intent. The vault then checks
  independently, against state the Diamond cannot rewrite in the same
  transaction. A vault that asked the Diamond "is this allowed?" would add
  nothing.
- **Own wallet only.** Without protected mode, an owner-directed outflow
  (withdraw, claim, escape, payout release) pays only the owner's own
  wallet. Any other address needs protected mode's allowlist and its delay.
- **The owner's allowlist never gates protocol classes.** Counterparty,
  treasury, adapter, conduit, incentive and backstop are checked against
  loan state and registries. So defaults and liquidations stay unblockable,
  which is the #3178 principle.
- **A vault-held lien record.** A counterparty is paid only against a lien
  the vault itself recorded when the position opened, up to that lien.
- **The treasury** stays one address behind the multisig and Timelock.
  Guardians only pause.
- **Just-in-time approvals.** No vault holds an allowance between
  transactions.
- **Orders follow the pause.** Fills already stop during a pause, because
  their Diamond callbacks are `whenNotPaused` (see the 2026-11-05 comment).
  This part is a test that pins that behaviour.

## 3. The shape

### 3.1 One door in the vault

The vault's three withdraw functions and `approveERC20` are replaced by two
entries: one for transfers out, one for allowances.

    transferOut(Outflow o)       // ERC-20 / 721 / 1155, one asset, one recipient
    grantAllowance(Grant g)      // just-in-time only, see 3.5

`Outflow` carries:
- `kind`, `asset`, `tokenId`, `amount`, `to`;
- `class` (an enum, §3.3);
- `ref`: the loan or offer id the movement belongs to (0 for the owner
  class).

The vault keeps `onlyDiamond`, then runs its own check for the class (§3.3)
before any transfer. There is no other way out of a vault: the old entries
are deleted, not kept beside the new ones. #3204 removes `upgradeToAndCall`.

### 3.2 One function in the Diamond

A library, `LibVaultOutflow`, is the only Diamond code that calls
`transferOut` or `grantAllowance`. It does the following, in order:
1. resolves the owner's vault;
2. applies the pause and the protected-mode gate;
3. checks the recipient against the class, using loan state (layer 1);
4. updates the tracked-balance counter and the depository ledger;
5. calls the vault (layer 2);
6. measures the delivery;
7. emits `VaultOutflow(owner, vault, asset, tokenId, amount, to, class, reason, ref)`.

The 13 wrappers become typed helpers on that library: `toOwner`,
`toCounterparty`, `toTreasury`, `toAdapter`, `toConduitFill`, `toIncentive`,
`toSellerClaim`, `toBackstop` and `toDiamondTransient`. Each takes only the
arguments its class allows. A facet cannot pass a free `to` for a class
whose recipient is derived from state.

**Default: a library, not a facet.** A cross-facet call per movement would
cost a selector lookup and calldata copy on about 90 sites. It would also
push size onto facets that are already near EIP-170. "One function" is
enforced structurally instead: a deploy-sanity test reads the compiled AST
and fails if any contract other than `LibVaultOutflow` references the
`transferOut` or `grantAllowance` selectors. This is the same technique the
storage-layout guard uses. The acceptance test the card asks for ("fails on
a site that bypasses it") is this test.

**The event is emitted by the Diamond**, which the indexer already
watches. That keeps one event per movement, as the fund-transparency rule
asks, without the indexer subscribing to every vault address.

### 3.3 The classes and what each layer checks

| Class | Layer 1 (Diamond: intent) | Layer 2 (vault: independent) |
| --- | --- | --- |
| **Owner** | Recipient is the owner's wallet or, with protected mode on, an allowlisted address after its delay. Version and pause rules apply. | `to == owner` (the owner wallet is recorded in the vault at creation), or `to` is on the vault's **own** allowlist with its delay elapsed |
| **Counterparty** | `to` is the vault of THAT loan's other party (or the current holder of that position). The amount is drawn from that loan's lien and bounded by its claim records | `to` is a genuine Vaipakam vault (§3.4). The amount is at most the open lien this vault recorded for `ref`, and that lien is reduced by it |
| **Treasury** | `to == s.treasury` | `to ==` the treasury address the registry holds (§3.6) |
| **Swap adapter / order taker** | A registered adapter for this action, against a lien | `to` is on the registry. The amount is at most the lien for `ref` |
| **Marketplace conduit** | A recorded listing for `ref`, through a registered conduit | Grant only (§3.5), and only to a registry conduit |
| **Incentive** (liquidator, matcher, keeper) | The actor of THIS action, at the configured rate | The amount is at most the vault's hard cap for incentives (a fraction of the lien for `ref`). The recipient cannot be checked by the vault, so the cap is the bound |
| **Seller claim** | A recorded seller of THIS loan | Genuine vault, or the seller's wallet, against the lien |
| **Backstop** | The configured backstop | The registry's backstop |
| **Diamond (transient)** | Only inside one transaction, with an onward class declared | `to == diamond`, at most the lien for `ref` |

### 3.4 "A genuine Vaipakam vault", without asking the Diamond

After #3204, every vault is the same `BeaconProxy` bytecode with the
Diamond as its immutable beacon. In the stock proxy the beacon is an
immutable, so it is part of the runtime code. Every genuine vault therefore
has the **same code hash**.

The vault implementation records that hash as an immutable at
construction, and checks `to.codehash == VAULT_PROXY_CODEHASH`. No storage
read, and nothing the Diamond can change in the same transaction. An
attacker can still create their own genuine vault. That is the stated
residual (§7), bounded by the lien.

### 3.5 Just-in-time approvals

`grantAllowance` succeeds only inside a fill window the Diamond opens,
which the vault records in transient storage:
- for the swap-to-repay limit order, the pre-fill hook;
- for marketplace listings, the executor's authorize and validate hooks.

The matching post-hook sets the allowance back to zero and asserts it is
zero. A test asserts zero standing allowance after every fill and teardown
path. The spender must be on the registry.

The standing approvals granted at listing time today (the ERC-1155
`setApprovalForAll` for a collection, and the ERC-721 conduit approval) move
into those hooks.

### 3.6 The registry (adapters, conduits, treasury, backstop)

**Default: a small, separate registry contract owned by the Timelock**,
whose address is an immutable of the vault implementation. A Diamond facet
bug cannot write to it. Changing it needs the Timelock, the same as
changing vault code.

The Diamond keeps its own configuration for layer 1. A mismatch between the
two fails closed: the vault refuses.

### 3.7 The lien record and the allowlist, held by the vault

- **Liens.** When a position opens, the vault records `(ref, asset, tokenId,
  amount)`. A counterparty, adapter, seller-claim or Diamond-transient
  outflow is allowed only against an open lien for its `ref`, and reduces
  it. A close-out releases what is left to the owner's free balance.
- **The allowlist** moves from Diamond storage into the vault, with its own
  delay counter.

Both are written through the Diamond, the only caller a vault accepts. So
on its own, "the vault recorded it" would let a compromised Diamond record
a fake lien or allowlist entry. **What makes the record independent is §8
Q1:** the owner's own authorization, checked by the vault.

### 3.8 What stays as it is

- Sanctions: the lock and move-out windows stay, as layer 1 rules.
- Protected mode's hold, queue and release stay, as layer 1 for the owner
  class, plus the vault's own allowlist check.
- The #3178 counterparty principle: no protocol class ever reads the
  owner's allowlist or version. (#3204 removes the version rules anyway.)
- Delivery measurement and the tracked-balance counter, now inside the one
  library function.

## 4. Pause

Both order validators already return false or revert while paused: the fill
callbacks are `whenNotPaused`. This change adds tests that pin it:
- every vault-signed order reads as unsigned while paused;
- fills succeed again after unpause.

`LibVaultOutflow` also refuses every class except close-outs while paused.
Owner withdrawals keep today's escape rule, so the escape window still
opens by itself.

## 5. App and indexer

- **Indexer:** one `VaultOutflow` event per movement, replacing the scattered
  per-path events as the movement record. The per-path events stay for the
  business meaning (repaid, defaulted). The movement event is the money.
- **App:** the withdraw screens state the own-wallet-only rule and how to
  add an allowlisted address under protected mode. The activity view lists
  each movement with its class and loan.

## 6. Tests (acceptance)

- The AST test from 3.2: only `LibVaultOutflow` reaches `transferOut` or
  `grantAllowance`.
- For each class:
  - a wrong recipient reverts at layer 1;
  - a layer-1 bypass (a test facet calling the vault directly with a forged
    class) reverts at layer 2.
- Counterparty:
  - paying any vault other than that loan's party reverts;
  - paying more than the recorded lien reverts;
  - paying a non-vault reverts on the code hash.
- Owner, without protected mode: any address but the owner's wallet
  reverts. With protected mode: an allowlisted address passes only after
  its delay.
- After every fill and teardown path, no allowance remains.
- While paused:
  - every vault-signed order reads as unsigned;
  - close-outs still complete;
  - owner withdrawals follow the escape rule.
- One `VaultOutflow` event per movement, with the class and the ref.
- Targeted suites, the fork marketplace and limit-order suites, and
  deploy-sanity, including the vault implementation's size.

## 7. Residuals (stated, from the owner's direction)

- **Funnelling through the attacker's own vault.** A destination check
  cannot tell an attacker's genuine vault from a counterparty's. The lien
  binding limits this to one recorded lien. §8 Q1 decides whether a
  compromised Diamond can create such a lien at all.
- **A bad price through a legitimate route.** Oracle floors, slippage caps,
  #3227's two-source rule and the #3206 rate limit cover it.
- **Diamond-transient legs.** Once value is in the Diamond for a swap or a
  forced sale, only layer 1 checks the onward leg. The vault bounds the
  amount to the lien. Routing vault-to-adapter directly, where the route
  allows it, would remove the transient leg and is a follow-up.
- **Incentive recipients** are checked only by the amount cap. Who acted is
  not something a vault can verify.

## 8. Questions for the owner

1. **What makes a lien or allowlist entry the owner's?**
   - **A (recommended):** the vault verifies the owner's EIP-712 signature
     (or ERC-1271, for contract wallets) over the commitment: the offer or
     accept terms, or the allowlist change. The app already signs the
     accept terms; posting would add one signature. A compromised Diamond
     then cannot open a lien or add an address at all.
   - **B:** the vault accepts a record only in a transaction the owner sent
     (`tx.origin == owner`). This adds no signature, but it breaks for Safe
     and other contract wallets, and a malicious facet could still add a
     record inside any transaction the owner sends.
   - **C:** trust the Diamond for records (layer 2 checks only code identity
     and amounts). This is the weakest option.
2. **Where the registry lives.** A separate Timelock-owned contract
   (recommended, 3.6), or immutables in the vault implementation, which
   means a new vault version for every adapter change.
3. **Diamond-transient legs.** Accept the residual now and file the direct
   vault-to-adapter routing as a follow-up (recommended), or do the routing
   in this change, which widens it a lot.
4. **The incentive cap.** Default: the highest rate any incentive's
   configuration bound allows today, applied to the lien. It is read from
   `ConfigFacet`'s bounds in the build PR and stated there.

## 9. Order of work

1. #3204's build (central vault code; it supplies the code-hash identity
   and the beacon).
2. This build, in one PR: the vault's two entries, `LibVaultOutflow`, the
   registry, all call sites moved, the old entries deleted, and the tests
   above.
3. #3206 (rate limits held in the vault's own storage) builds on this
   library and the vault's records.
4. #3246 part 2 (clawback to the recovery address) adds a class: the
   recovery address, held in the vault.

Fresh deploy, no migration.
