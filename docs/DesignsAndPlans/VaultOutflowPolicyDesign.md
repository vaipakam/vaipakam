# One vault outflow policy, checked twice (#3205)

Status: **design for owner review**. The owner's decisions of 2026-11-05/06
are recorded on #3205 and repeated where they apply. Choices they did not
settle are marked **Default**. Six questions in §8: Q1, Q5 and Q6 were decided by the owner. Q2 to Q4 are built on their recommended defaults (the coordinator, 2026-11-07). The build notes for part 1 sit at the end of §8. This builds on [#3204's central vault code
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
  the vault itself recorded when the position opened, up to that lien, and
  only to the vault of whoever holds the other side's position NFT, which
  lives outside the Diamond (§3.9).
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
| **Owner** | Recipient is the owner's wallet or, with protected mode on, an allowlisted address after its delay. Version and pause rules apply. | `to == owner`, where `owner` is the vault's own record of its owner wallet (set at creation, changed only as §3.7 allows), or `to` is on the vault's **own** allowlist with its delay elapsed. **And** the amount is at most the vault's free balance of that asset: its balance less the sum of its own open liens on it (§3.7), so an owner outflow can never take what a lien still holds |
| **Counterparty** | `to` is the vault of THAT loan's other party, the current holder of that position | `to` is the vault of the **current holder** of the other side's position NFT, read from the position-NFT contract (§3.9) at the moment of payment. The vault accepts `to` only if it is a genuine vault (§3.4) **and** `to`'s own owner record (§3.7) equals that holder; it never consults the Diamond's wallet-to-vault lookup. The amount is at most the open lien for `ref`, and the lien is reduced by it |
| **Treasury** | `to == s.treasury` | `to ==` the treasury address the registry holds (§3.6), **and** the amount is drawn either from the lien for `ref` and its fee budget, or from free balance under the owner's signed **fee authorization** for `ref` (§3.7). Without one of those, the vault pays the treasury nothing |
| **Swap adapter / order taker** | A registered adapter for this action, against a lien | `to` is on the registry. The amount is at most the lien for `ref` |
| **Marketplace conduit** | A recorded listing for `ref`, through a registered conduit | Grant only (§3.5), per amount or token id, and only to a registry conduit |
| **Listing escrow** (ERC-1155) | A recorded listing for `ref` | `to` is an escrow this vault created for `ref` (known code hash), at most the lien for `ref`. The escrow alone holds the operator approval (§3.5) |
| **Incentive** (liquidator, matcher, keeper) | The actor of THIS action, at the configured rate | The amount is drawn from the lien for `ref` and from that lien's **incentive budget**, a running total the vault sets when it records the lien (the cap fraction of the lien) and debits before each payment. Repeated payments against one `ref` cannot exceed the budget in sum. The recipient cannot be checked by the vault, so the budget is the bound |
| **Seller claim** | A recorded seller of THIS loan | `to` is a seller this vault recorded on the lien for `ref` when the position was assigned (§3.7), and the amount is at most that seller's recorded claim, which each payment debits |
| **Backstop** | The configured backstop | The registry's backstop, drawn from the lien for `ref` and its backstop budget (§3.7) |
| **Diamond (transient)** | Only inside one transaction, with an onward class declared | `to == diamond`, at most the lien for `ref` |
| **Owner, allowlisted** (decided default, 2026-11-08) | A protected account's allowlisted address, or its controller once retired, under the payout gate | Stage A: not the vault itself and not the Diamond. Stage B moves the allowlist into the vault and checks it there |
| **Claim custody** (decided default, 2026-11-08) | The STORED party of the receiving side of THAT loan, derived from loan state (the caller passes the side's position token, never a recipient). Used where a side cannot be consolidated to its holder: NFT rentals, FallbackPending, a Tier-2 sanctioned holder, a live listing | Stage A: a genuine vault only. Stage B adds the lien bound. The parked share is never credited to the depository ledger, so the stored party's own withdrawal cannot take it; the claim pays it on to the current holder (PositionHolder). Follow-up #3381 makes custody always follow the holder |
| **Matched counterparty** (decided default, 2026-11-08) | An internal-match leg. The intent carries both loans (`ref` = the paying loan, `counterRef` = the receiving loan); layer 1 checks the match from both loans' state (the paying loan's borrower owns the paying vault; the asset is its collateral and the receiving loan's principal). The payee is the receiving loan's STORED lender's vault, where that loan's lender claim finds it | Stage A: a genuine vault. Stage B: a lien on the paying loan |
| **Principal to borrower** (decided default, 2026-11-08) | A new loan's net principal. The loan and its position NFTs do not exist yet, so the payee is the accepted offer's borrower side in the same transaction (a borrower offer's creator, or a lender offer's acceptor as the accept recorded it in transient storage); no recipient argument | Stage A: a genuine vault. Stage B binds it to the signed accept terms |
| **Consolidation** (decided default, 2026-11-08) | A transferred side's custody moving, under its lien, from the stored party's vault to the current holder's vault (#594) | The same holder binding as PositionHolder; booked as custody, not credited as free money |
| **Liquidation buyer** (decided default, 2026-11-08) | The liquidator that paid the debt in this same transaction: `msg.sender` of the discounted liquidation, which no longer takes a free recipient | Stage A: not the vault and not the Diamond; Stage B bounds it by the loan's lien |

### 3.4 "A genuine Vaipakam vault", without asking the Diamond

After #3204, every vault is the same `BeaconProxy` bytecode with
`VaultBeacon` as its immutable beacon. In the stock proxy the beacon is an
immutable, so it is part of the runtime code. Every genuine vault therefore
has the **same code hash**.

The vault implementation records that hash as an immutable at
construction, and checks `to.codehash == VAULT_PROXY_CODEHASH`. No storage
read, and nothing the Diamond can change in the same transaction. An
attacker can still create their own genuine vault. That is the stated
residual (§7), bounded by the lien.

### 3.5 Just-in-time approvals

Three rules, each enforced by the vault without trusting the Diamond to
pair its hooks.

**1. Signatures and allowances are separate.** An external order protocol
checks the vault's ERC-1271 signature *before* it calls the pre-fill hook,
so signature validity cannot depend on an open window. The vault answers
`isValidSignature` from its own record of the order (the owner-authorized
commitment of §8 Q1, the same record that creates the lien), with no
window. What the window gates is only `grantAllowance`, which the Diamond
calls from the pre-fill hook (swap-to-repay) or the executor's authorize
and validate hooks (marketplace listings). A valid signature with no
allowance moves nothing.

**2. A grant reserves, and cleanup reconciles.** A grant never exceeds the
open lien for `ref`. It does not debit the lien when it is made. It
records a **reservation** in the vault's own storage: `ref`, asset, token
id, spender and granted amount. While a reservation is open:
- the lien still counts in full, so the owner class's free-balance check
  (§3.3) cannot release it;
- the vault refuses every other outflow and grant.

Cleanup reconciles it, from the post-hook or from an open entry any caller
may use, because it can only reduce what the vault has exposed. Cleanup
measures what the **spender consumed**, from the approval itself rather than
from the vault's balance, so tokens sent into the vault in the meantime
cannot mask spending or break the arithmetic: for ERC-20, the granted
amount less the allowance that remains; for ERC-721, the whole token if the
vault no longer owns it, else nothing. It debits the lien by exactly that
and closes the reservation. A grant that was never used leaves the lien
whole. The reservation no longer records a balance snapshot. Clearing
the approval is per asset type:
- ERC-20: set the allowance to zero;
- ERC-721: if the vault still owns the token, clear its approval; if it no
  longer does, the token contract already cleared the approval on
  transfer, so the grant is recorded as consumed and nothing is called
  (calling `approve` on a token the vault no longer owns would revert and
  roll back a successful fill);
- ERC-1155: none to clear, because the vault never grants one (rule 3).

**3. No operator-wide approval on the vault.** An operator approval
(`setApprovalForAll`) covers every token id of a collection the vault
holds, including ones backing other liens, and the token contract honours
it without asking the vault. So the vault never grants one:
- ERC-20 and ERC-721 grants are per amount or per token id;
- an ERC-1155 listing first moves exactly the listed id and amount out of
  the vault, against its lien, into a **listing escrow**: a minimal
  contract for that one listing, created by the vault with a known code
  hash. The escrow holds nothing else. On cancel or expiry it returns what
  is left to the vault, which re-opens the lien for it.

  The escrow is the listing's **offerer**, because the marketplace pulls
  from the offerer and not from whoever granted the approval. So the
  escrow grants the conduit approval, answers the order's ERC-1271 check
  from the vault's record of the listing, and routes the sale proceeds to
  the vault. The prepay-order builder (`LibPrepayOrder`) and the
  executor's canonical-order and offerer checks accept the escrow of the
  listing's vault as offerer, for ERC-1155 listings only. ERC-20 and
  ERC-721 listings keep the vault as offerer.

The standing approvals granted at listing time today (the ERC-1155
`setApprovalForAll` for a collection, and the ERC-721 conduit approval)
become, respectively, the escrow and a per-token approval made in the
hooks.

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
  it. So does an incentive payment, which also debits that lien's
  incentive budget.
- **The payee is the current holder.** Each lien records the other side's
  position (the position-NFT contract and token id). A counterparty payment
  goes to the vault of whoever holds that NFT at the moment of payment,
  read from the position-NFT contract, which no facet can write (§3.9).
  The paying vault checks the destination itself: it must be a genuine
  vault, and its own owner record must equal that holder. Both facts are
  held outside the Diamond, so a compromised Diamond cannot substitute its
  own genuine vault, and nothing has to be handed over when a position
  changes hands.
- **A holder with no vault yet.** Vaults are deployed at an address
  derived from the owner wallet (CREATE2, with the owner fixed by that
  derivation), so anyone may deploy a holder's vault and nobody can choose
  its owner. A route paying such a holder deploys the vault first in the
  same transaction, then pays it under the same check.
- **The holder of this vault's own side.** When a borrower position moves
  from A to B, the collateral stays in A's vault under its lien, and the
  lien now answers to B, never to A. Every action on that lien is
  authorized by the current holder of the borrower NFT, read from the NFT
  contract: a partial withdrawal of surplus, a swap-to-repay, a collateral
  listing. The vault checks the holder's own signature (EIP-712, or
  ERC-1271 from the holder's vault), not A's. At release, what is left of
  the lien goes to B's vault under the same binding check as a
  counterparty payment (a **position-holder** class); it becomes A's free
  balance only if A still holds the NFT. So an ordinary transfer gives B
  everything the position carries, without A's help, and A can no longer
  reach it.
- **Seller claims.** A sale through the protocol's route may split value
  earned before the sale (#1209's seller interest) as a seller claim. The
  vault records it only from the seller's signed sale terms (§8 Q1): the
  seller's vault and the amount. The seller-claim class pays only such a
  recorded seller, up to that claim. On a plain transfer there is no seller
  claim; the value travels with the NFT.
- **The rule behind both.** Every protocol class that names a recipient
  pays only one the vault can establish itself: from the position-NFT
  contract (payee), from a signature (seller claim), from the registry (treasury, adapter, conduit,
  backstop) or from its own creation (listing escrow). Only the incentive
  class and the Diamond transient leg have a recipient the vault cannot
  check, and both are bounded by their per-lien budgets (§7). The vault keeps a running sum of its open liens per
  asset and token id, which is what the owner class's free-balance check
  reads.
- **One rule for every protocol class.** Every outflow that is not the
  owner's own draws from an open lien for its `ref`, and from that lien's
  budget for its class where the class has one: fees (treasury), incentives
  and backstop. The budgets are set when the lien is recorded, from the
  owner-authorized terms (§8 Q1). So no protocol class can reach funds no
  position committed, and the owner class can reach only what no lien
  holds.
- **Fee authorizations.** Some fees are paid from free balance, not from a
  lien: a lender who opts to pay the yield fee in VPFI pays it from VPFI
  held freely. For those the owner's signature (§8 Q1) covers a fee
  authorization: the asset, the `ref` and a cap. The vault records it and
  debits it per payment, so the treasury class can draw from free balance
  only within it.
- **The owner record, and replacing it.** The vault records its owner wallet
  and, under protected mode, its secondary keys, both from owner-signed
  changes. A protected account's primary replacement (a majority of
  secondaries, after the delay) is checked by the vault itself: it records
  the proposal with its time, accepts the finalization only with a majority
  of the recorded secondaries' signatures and after the delay, and then
  sets the new owner wallet, which is both the payout destination and the
  signer of later authorizations. The old wallet stops passing either
  check at once.
- **Release.** A close-out releases what is left of a lien to the current
  holder of this vault's side of the position: the owner's free balance
  when the owner still holds it, otherwise the holder's vault (above). On repay, preclose and refinance the vault releases only
  against a receipt the payee vault recorded for the same transaction
  (§8 Q5, decided). On the listed exceptions a release is trusted to the
  Diamond (layer 1 only), bounded rather than closed. A released lien's assets can leave only by the owner class: to
  the owner's own wallet, or an allowlisted address after its delay, and
  under the #3206 outflow delay for amounts above its threshold, which
  gives the pause time to act. §7 states the residual.
- **The allowlist** moves from Diamond storage into the vault, with its own
  delay counter.

Both are written through the Diamond, the only caller a vault accepts. So
on its own, "the vault recorded it" would let a compromised Diamond record
a fake lien or allowlist entry. **What makes the record independent is the
owner's own signature, checked by the vault** (§8 Q1, decided).

### 3.8 What stays as it is

- Sanctions: the lock and move-out windows stay, as layer 1 rules.
- Protected mode's hold, queue and release stay, as layer 1 for the owner
  class, plus the vault's own allowlist check.
- The #3178 counterparty principle: no protocol class ever reads the
  owner's allowlist or version. (#3204 removes the version rules anyway.)
- Delivery measurement and the tracked-balance counter, now inside the one
  library function.

### 3.9 Position NFTs outside the Diamond (§8 Q6, decided)

The ownership record of a position NFT sits in Diamond storage today, so a
faulty facet could rewrite who holds a position. The position NFTs move to
their own contract:

- **A fixed core.** A standard ERC-721 that keeps owners, approvals and
  transfers. It is not upgradeable, so no upgrade can rewrite owners.
- **Pluggable parts that cannot move a token.** The artwork and description
  renderer, and a transfer check (sanctions screening, the buyer's risk
  access). Each sits behind an address
  the Timelock can swap, after the same kind of contract-held delay as the
  vault-code pointer (#3204). A renderer only draws; a check can only
  refuse a transfer.
- **The Diamond's rights.** It can mint a new position's tokens, and
  nothing else: no move, no lock and no notify power. It cannot move
  anyone's token, and cannot burn one before the position's
  final claim is paid. A protocol route that moves a position (a sale, an
  obligation handover, consolidation) does so with the holder's approval
  for that one token, given in the same step.
- **No route locks: the holder is re-checked at completion.** Today a
  token is locked while a sale listing, an offset, a collateral listing or
  a swap-to-repay order is open, so the seller cannot list and then send
  the NFT elsewhere. Instead, the NFT core keeps a **transfer count** per
  token that only ever increases, by one on every transfer. Each route
  records the count when it starts, and at completion (the fill, the
  accept, the swap) it requires the count to be unchanged. If the NFT has
  moved at all, even away and back, the completion reverts and the route
  stays cancelled for good. Completions are atomic, so the
  worst outcome is a failed fill and its gas, never a loss. The marketplace
  listings already re-check validity at fill, and this check joins them.
  The app says it plainly ("moving this NFT cancels your open listing"),
  and the indexer drops a listing whose NFT has moved.
- **A listing completes without the seller present**, so the seller grants
  the approval for that one token when listing. A transfer clears it, as
  ERC-721 does. While the listing is open, that token is exposed to the
  Diamond the way any listed NFT is exposed to its marketplace; no other
  position is.
- **Protected mode's NFT lock stays, as the holder's own choice.** Only the
  holder can switch it on, switching it off waits their delay, and the
  Diamond has no part in it. It guards against phishing.
- **Primary replacement moves the positions too.** When a protected
  account replaces its primary wallet A with B (§3.7: a majority of
  secondaries, after the delay, verified by the vault), the vault then
  calls the NFT core's recovery transfer. The core accepts it only from a
  genuine vault whose own record shows the replacement of A by B, and only
  for tokens held by A; it moves them to B and counts them as transfers.
  Because a protected account's NFTs are under its own lock, a thief
  holding A cannot move them during the replacement delay. The Diamond has
  no part in it.
- **No notification.** The NFT contract never calls the Diamond. Every rule
  that depends on the holder reads the current owner when it acts:

| Today's holder-dependent feature | Rule after the move |
| --- | --- |
| Payouts, claims, held-for-holder payouts, consolidation | Read the current owner when acting |
| Sanctions freeze of a flagged holder | The transfer check refuses moves to or from a flagged wallet; payouts screen the current owner |
| Seller interest (#1209) | The protocol sale route splits it as a seller claim (§3.7). On a plain transfer it travels with the NFT, as accrued interest does on a traded bond |
| VPFI fee-tier exclusion (#2342) | Worked out from the current owner when read, not at transfer |
| Interaction rewards | Follow the current owner. The build checks each reward rule for anything that must be cut at the moment of a sale and states its rule there; none is added silently |
| Indexer and app history | The standard ERC-721 `Transfer` event |

- **What it costs.** Every place that reads holders from Diamond storage
  switches to the new contract, and minting and the lock calls move there.
  The position-NFT code also leaves the Diamond, which frees room under the
  contract size limit.
- **Residual.** A position NFT is now as phishable as any NFT: one "approve
  all" signature to a fake marketplace can move it. Protected mode's NFT
  protection covers accounts that turn it on, and the app suggests it.

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
  - paying any vault other than the current holder's reverts at layer 2,
    with layer 1 bypassed, including the attacker's own genuine vault
    against an honest user's existing lien;
  - a test facet that writes arbitrary Diamond storage cannot change who
    the vault treats as the holder;
  - after a plain transfer of the position NFT on an outside marketplace,
    the next payment goes to the new holder's vault, with no app step;
  - a payment to the attacker's own genuine vault, whose owner record is
    not the NFT holder, reverts at layer 2;
  - a holder with no vault: the route deploys it at its derived address,
    then pays it;
  - a route started, then the NFT sent away and back: completion reverts on
    the changed transfer count;
  - a borrower NFT moved from A to B: B, not A, authorizes partial
    withdrawals and listings, and the released collateral reaches B's
    vault; A's owner withdrawal cannot take it;
  - a protected account's primary replaced: its position NFTs move to the
    new wallet through the vault-verified recovery transfer, payments then
    reach its vault, and a recovery transfer from a non-vault, or for a
    replacement the vault did not record, reverts;
  - a forged seller claim against an honest user's lien, to any vault but
    a recorded seller or above its recorded claim, reverts at layer 2;
  - paying more than the recorded lien reverts;
  - paying a non-vault reverts on the code hash.
- Owner, without protected mode: any address but the owner's wallet
  reverts. With protected mode: an allowlisted address passes only after
  its delay. An owner-class withdrawal to the owner's own wallet that
  would dip into an open lien reverts at layer 2, with layer 1 bypassed.
- Incentive: repeated payments against one `ref` revert once their sum
  reaches that lien's incentive budget.
- After every fill and teardown path, no allowance remains.
- A grant with no fill and no post-hook: the next outflow is refused; the
  open cleanup restores the whole lien; an owner withdrawal then still
  cannot take the liened amount.
- A partly used grant: cleanup debits the lien by exactly what was consumed.
- An unused grant, then a direct donation of the same token, then the
  open cleanup: it succeeds and leaves the lien whole.
- A yield fee paid from free VPFI under a signed fee authorization passes;
  the same payment without one, or over its cap, reverts at layer 2.
- A protected primary replacement, then a queued withdrawal to the new
  wallet passes; a payout to the old wallet reverts at layer 2; a
  replacement finalized early or without the secondaries' majority reverts.
- A full swap-to-repay fill, from the signature check through the
  post-hook, with the signature valid before the window opens.
- ERC-1155, with two token ids under separate liens: a listing of one id
  exposes nothing of the other, with layer 1 bypassed. The vault never
  holds an operator approval.
- A complete escrow-backed ERC-1155 marketplace fill, with the escrow as
  offerer, and a cancel that returns the rest and re-opens the lien.
- ERC-721 cleanup after a fill (token gone, nothing called) and after an
  unused grant (approval cleared).
- Treasury and backstop: a forged payment from a vault with no open lien
  for `ref` reverts, and one that would exceed its budget reverts, with
  layer 1 bypassed.
- A forged close-out: on repay, preclose and refinance, a release with no
  payee-vault receipt, or one below the recorded principal, reverts at
  layer 2. On a listed exception, the released collateral can reach only
  the owner's own wallet, and above the #3206 threshold only after its
  delay; the release event carries the loan, amount and transaction.
- While paused:
  - every vault-signed order reads as unsigned;
  - close-outs still complete;
  - owner withdrawals follow the escape rule.
- One `VaultOutflow` event per movement, with the class and the ref.
- Targeted suites, the fork marketplace and limit-order suites, and
  deploy-sanity, including the vault implementation's size.

## 7. Residuals (stated, from the owner's direction)

- **Funnelling through the attacker's own vault.** A destination check
  alone cannot tell an attacker's genuine vault from a counterparty's. The
  holder rule closes that for counterparty payments: an honest user's open
  lien pays only the vault of whoever really holds the other side's NFT,
  which the Diamond cannot rewrite. A compromised Diamond can reach a
  counterparty payment only on positions the attacker holds. The
  classes the vault cannot bind to a recipient (incentives, the Diamond
  transient leg) stay bounded by their budgets and are listed below.
- **A bad price through a legitimate route.** Oracle floors, slippage caps,
  #3227's two-source rule and the #3206 rate limit cover it.
- **Diamond-transient legs.** Once value is in the Diamond for a swap or a
  forced sale, only layer 1 checks the onward leg. The vault bounds the
  amount to the lien. Routing vault-to-adapter directly, where the route
  allows it, would remove the transient leg and is a follow-up.
- **A grant left standing by a faulty Diamond** can be used by its
  registry spender until someone runs the open cleanup, up to the granted
  amount, which never exceeds that one lien (§3.5). Cleanup debits the
  lien by what actually left.
- **Incentive recipients** are checked only by the per-lien budget.
- **A forged close-out, on the listed exceptions only** (§8 Q5). A
  compromised Diamond can release a lien it should not, and the collateral then reaches the borrower's own wallet,
  never a third party's. The loss is the lender's, bounded by that one
  lien, and is slowed by the #3206 delay above its threshold. This bites
  where the borrower is the attacker. Who acted is
  not something a vault can verify.

## 8. Questions for the owner

1. **What makes a lien or allowlist entry the owner's?** **Decided
   (owner, 2026-11-06): the owner's signature.** The vault verifies the
   owner's EIP-712 signature (or ERC-1271, for contract wallets) over the
   commitment: the offer or accept terms, an allowlist change, a fee
   authorization or a pin. A compromised Diamond then cannot open a lien or
   add an address at all. The options not taken were a `tx.origin` check
   (breaks contract wallets, and a facet could still add records inside an
   owner's transaction) and trusting the Diamond.
2. **Where the registry lives.** A separate Timelock-owned contract
   (recommended, 3.6), or immutables in the vault implementation, which
   means a new vault version for every adapter change.
3. **Diamond-transient legs.** Accept the residual now and file the direct
   vault-to-adapter routing as a follow-up (recommended), or do the routing
   in this change, which widens it a lot.
4. **The class budgets.** Default: for incentives, fees and backstop, the
   highest rate each configuration bound allows today, applied to the
   lien. They are read from `ConfigFacet`'s bounds in the build PR and
   stated there.
5. **Lien release.** **Decided (owner, 2026-11-06): the vault checks the
   repayment where it can, and the rest is bounded and stated.** A refusal
   checked by the Diamond would stop bugs but not a compromised Diamond, so
   where the check binds, the vaults make it:
   - **Repay, preclose and refinance** pay the lender's due into the lien's
     current holder's vault in the same transaction. That vault measures what
     arrived (balance before and after) and records, in transient storage,
     "received X for `ref`". The borrower's vault releases the lien only if
     that receipt exists and X covers at least the principal the signed
     terms record. A Diamond can fake it only by moving real tokens into
     the lender's vault, which pays the lender.
   - **The exceptions**, where the lender is not paid vault to vault at the
     moment of release, are listed exactly and trusted to the Diamond:
     liquidation, swap-to-repay and fallback custody (proceeds through an
     adapter), a payout held as a claim for later, and a sanctioned or
     parked holder. For these, every release emits one event with the loan,
     the amount the Diamond says was repaid and the repaying transaction; a
     watcher alerts on, and pauses for, any release with no matching
     repayment movement; and the #3206 outflow brake covers collateral
     leaving a vault right after a release.
   - The spec states the residual: on the listed exceptions only, a
     compromised Diamond can release a lien it should not, and the brake
     and the pause bound how much can then leave.

   **End state:** every release is vault-checked, once every payout goes
   vault to vault. Filed as a follow-up.

6. **How position NFTs change hands.** **Decided (owner, 2026-11-07):
   the position NFTs move out of the Diamond** into their own contract
   (§3.9), and the vault pays the current holder. Positions move freely,
   wallet to wallet or on any marketplace, without the app. The options not
   taken were refusing plain transfers while a loan is open, and a signed
   handover for every move; both existed only because the ownership record
   sat in Diamond storage.

### Build notes, part 1: the position-NFT contract (2026-11-07)

These record the choices the build made where §3.9 left room. The coordinator approved points 1 to 5, and point 5 came with the additions listed under it.

1. **The core.** `PositionNFT` is a non-upgradeable ERC-721 Enumerable.
   - It is owned by the Timelock through a two-step transfer; renouncing reverts.
   - Its guardian may cancel a pending replacement.
   - The Diamond is its immutable minter.
   - It keeps a per-token transfer count that only rises.
   - The renderer and the transfer check are replaced in two steps, at least `MIN_COMPONENT_DELAY` (3 days) apart.
2. **No burn.** The core has no burn entry. The Diamond's `burnNFT` became `retirePosition`. It keeps the #569 lien release and the #2342 tier sync, and marks the token retired in Diamond storage. Every Diamond holder read treats a retired token as the old code treated a burned one (`ownerOf` reverts, `holderOrZero` returns 0), so no settlement path changed meaning. The token stays with its holder as a receipt, and it still renders.
3. **Routes in place of locks.**
   - The route record (its reason) stays in Diamond storage, one per token, so two routes still cannot overlap on one token.
   - Opening a route stores the token's transfer count. Each completion (the offset, the lender sale, the collateral sale, the swap-to-repay pre-hook and post-hook) requires it unchanged. Cancels and teardowns do not check it.
   - A swap-to-repay order whose position moved reads as invalid to the order protocol.
4. **The Diamond is the first renderer and the first transfer check.** As the check, it runs:
   - the #821 / #1123 fail-closed sanctions screen;
   - the #2342 tier sync. This is the one-way ping the owner allowed (2026-11-07) for a time-accrued record that must follow the holder.

   The check is guarded against re-entry, as the old guarded transfer was. It can only refuse a transfer.
5. **The Diamond's protected-mode queue is gone.** That covers the queued position transfer, its co-sign and its rows (the storage fields are retired). NFT protection is the core's holder lock. Following the coordinator's additions, the core gives the Diamond the same narrow powers it has over the VaultBeacon's pin delay:
   - It may lock a holder (on enable with NFT protection, on an emergency lock, and on a replacement).
   - It may raise the holder's lock delay toward the protected delay, up to `MAX_DIAMOND_LOCK_DELAY` (5 days, the longest protected delay).
   - It may void a pending unlock or delay lowering, from the same single `_voidPendingChanges` that voids the beacon's pending pin change, and on re-enable.
   - It can never unlock a holder or lower a delay.

   The core applies the VaultBeacon's own rules:
   - every delay is bounded by `MAX_LOCK_DELAY` (30 days);
   - every stored time passes one checked cast;
   - a lowering waits the old delay;
   - any raise drops a pending lowering.

   Approvals granted before a lock are retired by an approval epoch that each lock bumps.

**Interim residual, until part 2.** The recovery transfer (§3.9, "primary replacement moves the positions too") needs the vault's own record of the replacement (§3.7), which part 2 adds. Until then, a replaced account's tokens stay with the old wallet under the holder lock. The old wallet can still ask to unlock and, after the delay, move them. No chain sees this window, because both parts land before any deploy.

**Not automated yet.** Nothing backs the core's `executeUnlock` and `executeLockDelay` with a keeper pass. They are open entry points that only apply what the holder asked for once its delay has passed. They are recorded as a gap in `permissionless-steps.json`.

### Build notes, part 2 Stage A: the vault's one door (2026-11-08)

These record what Stage A built and every decided default it took, with the
coordinator's approval of each.

1. **Two stages** (decided default, 2026-11-08: reviewability of a
   fund-moving diff; both stages before the fresh deploy). Stage A, this
   build: the Diamond's one policy, the vault's two entries with every check
   that needs no owner signature, the just-in-time grants, the ERC-1155
   listing escrow, own-wallet-only withdrawals, payouts to vaults and the
   decided defaults. Stage B (#3379): the owner-signed lien record, the
   class budgets, the payee-receipt release (Q5), the seller-claim check, and
   the app and keeper signing changes. The intent struct already carries
   `ref`, the class, the position token and `counterRef`, so Stage B adds
   checks, not an entry point. **No deploy happens before Stage B.**
2. **A facet behind a self-call, not an inlined library.** RiskFacet,
   PrecloseFacet, OfferMatchFacet, ForcedSaleFacet, AutoLifecycleFacet and
   RefinanceFacet each had under 1.2 KB of EIP-170 headroom, and every call
   site already reached the old withdraw entries through a self-call. The
   policy is `VaultOutflowFacet`; `LibVaultOutflow`'s typed helpers are the
   only callers, and a deploy-sanity test (`VaultOutflowDoorTest`) fails on
   any other facet whose runtime code reaches the vault's doors.
3. **The registry.** The vault reads the protocol registry (its
   `requirePointer` for the treasury and backstop, fail-closed, and
   `isMember` for the adapter and conduit sets) as an immutable of its code.
   The registry is built by the security work stream; until it lands, tests
   use a mock. The launch refuses (`vault registry seeded`) while the
   registry is missing, names another treasury, or lacks a routed swap
   adapter, the 1inch order protocol or, with a listing executor configured,
   any conduit, so an empty registry can never silently refuse every fill.
4. **Payouts go to vaults** (owner decision): claims, the active-loan lender
   share and the new loan's principal are credited to the payee's vault as
   free money, which the payee withdraws.
5. **Decided defaults on the inventory's gaps:** the backstop's own vault
   pays the lender-position holder as an ordinary holder payout; the
   discounted liquidation pays `msg.sender` only (its recipient parameter is
   gone); an internal-match leg is the matched-counterparty class above; the
   backstop sweep pays only the registry's treasury (its free `to` is gone).
6. **The VPFI yield fee** goes through the treasury class and fails closed.
   No spec line lets a discount failure pass silently, so the known refusal
   (VPFI pledged as collateral) is pre-checked from the same free-balance
   rule the outflow applies and takes the direct-reduction fallback; any
   other failure reverts.
7. **The VPFI recycle pulls** (perk purchase, notification fee, the Full
   tariff) are Diamond-transient with the reason RECYCLE.
8. **Stated limits of Stage A's vault-side checks.** For the classes whose
   payee the vault cannot yet bind (claim custody, matched counterparty,
   principal to borrower) it checks only that the payee is a genuine vault;
   for the owner-allowlisted, incentive, liquidation-buyer and seller-claim
   classes only that the payee is neither the vault nor the Diamond. The
   lien bound on the AMOUNT, for every protocol class, is Stage B's.
9. **One check path behind four entries.** EIP-170 left some callers no
   room to encode the whole intent struct, so the policy facet has four
   external entries: the struct entry, a scalar entry carrying the same
   fields as arguments, and two compact entries (to the owner, and an ERC-20
   to the Diamond). Each builds the same intent and calls one private check,
   which carries every class rule, the free-balance check, the protected
   payout gate and redirect, the transfer, the ledgers and the one movement
   event. No entry carries a check of its own, and the policy test drives
   every entry through the same class matrix.
10. **A share that cannot follow its holder yet is reserved, not loose.** The
    claim-custody class parks a terminal share in the vault of the loan's
    stored party for that side. It is not credited as that party's own money,
    so the party's withdrawal (bounded by the depository ledger) refuses it,
    and the claim pays the current position holder. A matched liquidation
    parks the same way for the receiving loan's stored lender. #3381 makes the
    share follow the holder at the time of the movement.
11. **ForcedSaleFacet split** (coordinator: 11 bytes of headroom was not
    acceptable). The two previews moved to `ForcedSalePreviewFacet`, and the
    sizing rule both facets read is `LibForcedSalePlan`, one copy. The two
    facets are refreshed together. Sizes measured on the Stage A head:
    ForcedSaleFacet 21,522 bytes, ForcedSalePreviewFacet 7,972,
    VaultOutflowFacet about 9,800, OfferMatchFacet 24,298, PrecloseFacet
    about 23,938, AutoLifecycleFacet 24,442 and EncumbranceMutateFacet 24,392.
    The last two are the next to split (#3385).
12. **What the adversarial self-review changed** (before Codex round 1).
    - **The free-balance check reads the tracked holding for NFTs.** An
      ERC-1155 lot moved into this vault's own listing escrow is still this
      vault's and still under its lien. Capping the check at the vault's raw
      balance counted that lot twice and refused another loan's release of
      the same token id while the listing was open. The raw-balance cap now
      applies to ERC-20s only, where it guards balance drift.
    - **Only the Diamond may close a grant in the transaction that opened
      it.** A party reentering during a fill could otherwise close an
      ERC-721 listing grant first, leaving the Diamond's close nothing to
      book. A transient flag in the vault code enforces this. A grant left
      from an earlier transaction may still be closed by anyone.
    - **A caller-named recipient may never be the paying vault itself.**
      Owner-allowlisted, incentive and liquidation-buyer outflows naming the
      paying vault would have debited the ledger for tokens that never left.
      They are refused. The derived classes keep the no-move self case,
      which books both sides.
    - **Stated limits.** The vault's own genuine-vault test compares code
      hashes, and a BeaconProxy anyone deploys with a forged owner record
      passes it. That isn't exploitable while layer 1 derives every such
      payee from Diamond storage; CREATE2 vaults close it (#3393). And
      because only one grant may be open at a time, two ERC-721 listings from
      one vault can't be filled in a single Seaport batch. That is a denial
      of service only, with no funds at risk.
13. **What Codex rounds 1 and 2 changed** (root fixes, one seam each).
    - **One spender rule in the vault.** Every spender right the vault
      grants or causes, whether a just-in-time grant or a listing escrow's
      conduit approval, passes `_requireRegistrySpender`.
    - **One free-balance rule.** `LibEncumbrance.vaultFree` is read by the
      policy and by the depository (its free holding, withdrawable amount
      and withdrawal gate). NFTs use the tracked holding; ERC-20s are capped
      at the vault's balance.
    - **No authorization from state the settlement clears.** A prior
      seller's payout is authorized by a transient, single-use record for
      the exact share (`LibSellerPayAuth`), written from the claim being
      paid. It never reads the seller-claim list, which the terminal split
      deletes first.
    - **One place books both sides of a vault move.** The policy books the
      payer's tracked fall and the payee vault owner's rise, for every class
      whose payee is a vault. No settlement books the arrival again. A
      same-vault payout changes no tracked ledger at all, so a VPFI holder's
      tier record sees no intermediate dip. Only the depository credit
      moves, and only for a holder payout or new principal.
    - **One way for a contract holder to claim.** `LibHolderClaim` claims,
      withdraws exactly the credit the claim gave the holder's vault
      (ERC-20, or the collateral in kind) to the holder contract, and
      measures it. The backstop vault and the aggregator adapter use it.
      Both are standalone UUPS contracts:
      - `BackstopVaultImplementation` reaches a chain through
        `BackstopFacet.upgradeBackstopVault`.
      - `AggregatorAdapterImplementation` reaches a chain through the
        adapter factory's upgrade.
      
      On a fresh deploy, each ships with it.

## 9. Order of work

1. #3204's build (central vault code; it supplies the code-hash identity
   and the beacon).
2. This build, in two PRs (decided default, 2026-11-08, for reviewability;
   both before the fresh deploy): Stage A (the vault's two entries, the
   policy, all call sites moved, the old entries deleted, the grants and the
   escrow), then Stage B (#3379: the owner-signed liens, the class budgets,
   the receipt release and the seller-claim check).
   The position-NFT contract (§3.9) is part of it, or lands just before it,
   since counterparty payouts read their holder from it.
3. #3206 (rate limits held in the vault's own storage) builds on this
   library and the vault's records.
4. #3246 part 2 (clawback to the recovery address) adds a class: the
   recovery address, held in the vault.

Fresh deploy, no migration.
