# One vault outflow policy, checked twice (#3205)

Status: **design for owner review**. The owner's decisions of 2026-11-05/06
are recorded on #3205 and repeated where they apply. Choices they did not
settle are marked **Default**. Six questions in §8: Q1, Q5 and Q6 were decided by the owner. Q2 to Q4 are built on their recommended defaults (the coordinator, 2026-11-07). The build notes for part 1 sit at the end of §8. §3.7 was refreshed on 2026-11-19 for Stage B3, which is not built yet, and its one user-facing question (sign, then send) is with the owner. This builds on [#3204's central vault code
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

> **Superseded for the vault by #3431 (Stage B1, 2026-11-09).** The vault no
> longer reads the registry. The endpoints it may pay or approve are
> constants in its own code, and its order and swap checks look at outcomes
> rather than at which contract is asking. See build notes, part 2 Stage B1.
> The text below is kept as the record of the Stage A design.

**Default: a small, separate registry contract owned by the Timelock**,
whose address is an immutable of the vault implementation. A Diamond facet
bug cannot write to it. Changing it needs the Timelock, the same as
changing vault code.

The Diamond keeps its own configuration for layer 1. A mismatch between the
two fails closed: the vault refuses.

### 3.7 What the owner authorizes, and what the vault checks (refreshed 2026-11-19 for Stage B3)

The first version of this section (2026-11-08) assumed the owner signs at the moment a position opens. Since then most
positions open with no owner present: a slot fill, the lender side of an instant borrow, a renewal, a continuation with
another lender, a takeover, a keeper run. The payout rule (2026-11-19,
[PayoutDestinationRuleDesign.md](PayoutDestinationRuleDesign.md)) also changed where money goes: what a loan or an open
offer owes a party lands in that party's vault. That makes the end state of §8 Q5 reachable, where every release is
checked by the vaults. This section restates the vault's own records and its own checks for the platform as it now is.
The decisions of §2 and of §8 Q1, Q5 and Q6 stand. Stages A, B1 and B2 are built (the build notes after §8); this is
the design for Stage B3, which is not built yet.

**What the vault promises after B3.** Nothing leaves a vault unless its owner committed it. What was committed leaves
only to a party the vault can establish itself, within an amount the vault can bound itself. The vault does not compute
interest and does not decide when a loan is in default. Those stay the Diamond's (layer 1), and §3.7.8 states what that
leaves.

**Every vault check is an outer bound.** The Diamond's own rule is always the tighter one. A vault bound that refused a
step the Diamond's rules allow would be a defect, because it could hold up a repayment or a liquidation, so the tests
hold every bound at or outside the Diamond's at every step of a loan's life.

#### 3.7.1 One authorization rule, and one rule for wallets

The rule is the one protected mode already uses (Stage B2, `VaultProtectionBase._authorize`): an authorization is a
direct call from the owner's wallet to the vault, or the owner's EIP-712 signature (ERC-1271 for a contract wallet) over
the commitment, in the vault's own domain, spending a nonce. B3 adds no second rule. Three routes meet it, and the app
picks by where the money is and what the wallet can do:

| The action is funded from | Route | Prompts on a plain wallet |
| --- | --- | --- |
| The wallet | The Permit2 witness carries the commitment, and **the owner's own vault is the Permit2 spender**. The vault makes the pull itself, so a successful pull proves the owner signed that commitment. The tokens go from the wallet to the vault and never rest in the Diamond. | Sign, then send |
| The vault's free balance | The owner signs the commitment, and the signature travels with the action to the vault. | Sign, then send |
| Either, from a wallet that sends several calls as one | The owner's batch calls the vault's own `authorize` entry with the commitment first. The vault holds it for that transaction only and spends it when the Diamond records the commitment. | One |

Every funded action then reads the same way to a user: sign what you commit, then send. The typed-data prompt shows the
asset, the amount, the pair and the terms, and that is exactly what the vault enforces.

**A wallet never approves the Diamond.** Today most wallet-funded entries pull on a standing allowance the wallet gave
the Diamond (`LibDelivery.pullExact` behind the vault factory's deposit routes), with Permit2 as an option on a few. A
standing allowance is a commitment to nothing in particular: a faulty Diamond could draw on it for anything. After B3 a
wallet approves two things only: Permit2, for its tokens, which moves nothing without a signature that names the
spender and the purpose, and its own vault, for one NFT it is about to lock. Every pull from a wallet is made by the
payer's own vault under a permit signed for that purpose. This holds for a payment that opens no commitment too (a
repayment from a wallet, a top-up, a deposit, a liquidator's or a buyer's payment). The platform can then state, as a
fact a reader can check on chain, that no change to the Diamond can move tokens out of a wallet or out of a vault
beyond what its owner signed.

#### 3.7.2 The records the vault keeps

1. **The balance record.** For each asset: the owner's free balance, and what is held under liens. Free balance rises
   only by a step the vault takes itself: its own pull from the owner's wallet, a receipt for a payment owed to its
   owner, the release of one of its own liens, or the owner adopting tokens that were sent to the vault directly. It
   falls by a withdrawal or a new commitment. A withdrawal is bounded by the lower of the free figure and the token
   balance less everything held, which is today's rule (`withdrawableNow`) with the figures moved into the vault.
   Tokens that arrive unannounced are in neither figure until the owner adopts them.
2. **Commitments**, each made only under §3.7.1:
   - a posted offer or request: asset, amount, side, the pair and its terms;
   - an accept of someone's offer: the loan terms the acceptor commits to;
   - **the lending mandate**, one per lending asset: the amount set aside to lend
     ([LendingBalanceDesign.md](LendingBalanceDesign.md)), and per slot the bounds the vault can check itself: the
     collateral asset, the highest loan-to-value at opening, the exposure cap and the slot's end date. Fills draw on it
     with no owner present. The slot's consents sit in it: renewal, takeover, and lending for one transaction (#3748),
     which may draw only the part not lent and is judged by the vault's own balance before and after the call;
   - a loan's two reserves and its standing instructions (#3681): how much is reserved, and which draws may spend it
     (a top-up into this loan's own collateral lien, an interest payment or a repayment to the lender side's holder);
   - the due-date plan on a loan ([DueDatePlanDesign.md](DueDatePlanDesign.md)): that the loan may continue with
     another lender, and the borrower's highest rate. The vault uses that rate for the continued loan's ceiling
     (below). It does not check the rate the Diamond then records (§3.7.8);
   - a refinance request: that this loan's collateral lien may be carried to the loan opened from the request, once
     the old loan is paid;
   - an order for an asset the vault holds under a lien (a collateral listing, a sale beside an open offer, a limit
     order that swaps collateral to repay): the asset, the lowest price, and that the price is paid to this vault.
     Whether a loan's collateral may be listed at all is one of the loan's signed terms, and that term is what a
     listing at the floor inside the grace period draws on with no owner present;
   - a fee authorization (a fee paid from free balance, not from a lien), an allowlist change, a pin. These exist
     already.

   Lowering or cancelling a commitment is the owner's own call and takes effect at once for what is not yet drawn.
3. **Liens**, one per position side this vault backs: the `ref`, the asset, token id and amount, this side's position
   token, the other side's position token and the class budgets. A collateral lien also records four figures from the
   terms its owner signed: the principal still owed, the loan-to-value limit it opened under, **the most the loan can
   ever owe** (the principal plus the most interest and fees those terms allow, called the ceiling below), and **the
   earliest time the collateral may be taken for a missed due date**. The principal still owed falls only by the
   principal part of a receipt (item 4), read in the transaction that made it and counted once. A lien opens in exactly
   two ways: under the owner's own authorization in that transaction (a post, an accept), or as a draw on a mandate, a
   plan or a request. Either way the vault names its own side's token and checks who holds it (§3.7.3). A lien never
   opens on the Diamond's word alone.
4. **Receipts.** A vault is paid by another vault through a call that names the `ref` and says how much of the payment
   is principal. The receiving vault checks that the caller is a genuine vault (§3.4), measures what arrived, and
   records "received X of this asset for `ref` from this vault, of which this much principal", under a number, so that
   a receipt can be counted once. The principal part can never exceed what arrived. A receipt is the only proof of
   payment another vault accepts. Because a receipt is counted when it is made, a lender side that changes hands
   later changes nothing in what the borrower's lien has already counted.

**One record, not two.** These records live in the vault and nowhere else, as protected mode's record does since B2.
`LibEncumbrance` stays the one writer, and becomes the one caller of the vault's lien entries. The Diamond keeps the
loan and offer records (which already carry their amounts) and the per-asset pledged total that the concentration rule
reads (#3685), written at the same seam. Its own figures for a vault's balances (the tracked ledger, the depository
holding, the lien amounts) retire or become reads of the vault. A lien change that comes with a token movement rides in
that call. One that moves no tokens costs one more call, and the build PR measures it.

#### 3.7.3 A loan opens as an exchange between two vaults

A loan exists for a vault only as an exchange it took part in. Neither side takes the Diamond's word for the other, and
one rule holds on both sides: **a vault checks its own side's position token against its own owner's commitment, and
learns the other side's token only from the other vault's own record.**

- **Each side's token.** A vault records a lien only with its own side's position token named, and only after checking
  on the position-NFT contract that the token is held by the one entitled to that side under the commitment the lien
  draws on: the vault's owner, or whoever holds the offer's token the commitment was made under (#3744). This holds for
  the borrower's side exactly as for the lender's. A token the Diamond minted to anyone else opens no lien in that
  vault, so it can neither bind collateral nor be paid principal.
- **The paying side.** The vault that funds the principal pays within its offer lien or its mandate. It pays only when
  a genuine vault holds an owner-authorized collateral lien for the same `ref`, on the terms its own commitment states.
  It reads the borrower side's token from that lien, never from the Diamond, and pays the vault of that token's holder
  the principal less the opening fee the terms allow. The fee leaves under the fee budget (§3.7.4). For a mandate fill
  the vault also reads the price guard: the collateral's value must cover the principal at the slot's own
  loan-to-value limit.
- **The locking side.** A collateral lien is bound from the moment the receipt for that payment exists for the same
  `ref`, at the vault of whoever holds its own side's token, whether or not the Diamond says so. It records as its
  other side the token the paying vault's own record names. Until then it binds nothing, and its owner can release it.
- **A loan that pays off another** (a refinance request, or a continuation with another lender under a due-date
  plan). The borrower's commitment names the old loan. The paying vault reads that commitment and the old loan's
  collateral lien in the borrower's vault, and pays the new principal to the vault of the old loan's lender-side
  holder, as that lien names it. The receipt is recorded there for the old loan's `ref` and names the new loan. That
  receipt is the opening proof: the old lien is carried to the new loan and bound to the new lender side once the old
  loan's principal still owed is nil (§3.7.7). The new loan's borrower-side token must be held by whoever holds the old
  loan's, so a payoff can never hand the collateral to another party. The borrower's own vault pays any rest of what
  the old loan is owed, and any part of the new principal beyond it goes to the borrower side's holder as above.
  Nothing is paid to the borrower for the part that pays the old loan.
- **An NFT rental.** Nothing is paid at opening. The lender's vault itself records the renter's right on the token,
  for the holder of the borrower side's token as the renter's prepayment lien names it, and that lien is bound on the
  lender vault's record of the right, in place of a receipt.

So a faulty Diamond cannot name itself or anyone else the lender of a loan without the principal really being paid. It
cannot lock a borrower's collateral unless the entitled borrower was really paid, or the borrower's old loan was really
paid off under the borrower's own commitment. And it cannot make itself or anyone else the borrower of a loan that
another party's collateral backs.

#### 3.7.4 What each outflow is checked against

This table restates layer 2 of §3.3 for Stage B3. Where the two differ, this one is the design.

| Outflow | The vault's own check |
| --- | --- |
| The owner's withdrawal | The balance record (§3.7.2). Own wallet, or an allowlisted address after its delay (B2). On a protected account the withdrawal is a row the vault queues itself (§3.7.9). |
| Principal to a borrower | §3.7.3. |
| A lien released into free balance | A collateral lien, in full: only when the lien's own figure for the principal still owed is nil, which only the principal part of receipts brings down (§3.7.2). In part: only as far as what stays still covers the principal owed at the lien's own loan-to-value limit, by the vault's own price read. An asset with no price returns only in full. An offer lien, a mandate or a reserve: the owner's own call, for what is not drawn. |
| A payment to the other side's holder (repayment, interest, the proceeds of a forced sale, collateral on a default) | Against the lien for that `ref`, to the vault of whoever holds the other side's position token now (§3.7.5), and no more than the lien. What leaves a collateral lien to the lender side without its owner's own authorization never passes the ceiling: sale proceeds are counted as measured, and priced collateral handed over in kind is valued by the vault's own price read. Collateral with no price is handed over only whole, and only at or after the lien's own date. |
| What is left of a lien, to this side's holder | To the vault of whoever holds this side's position token now, under the release rule above. An open offer's escrow goes the same way to the holder of the offer's token (#3744). |
| A swap or a forced sale | Only through `swapOut` (B1): the vault makes the swap, takes no more than the lien from itself, and measures what arrived at this vault or at the other side's holder vault. B3 adds the vault's own outer floor: the price guard's value of what was sold, less the widest slippage the settings allow, fixed in the vault code. The Diamond's tighter floor (#3359) stays layer 1. |
| An internal-match leg | Judged as a forced sale whose proceeds are what this loan's own lender side receives: the same outer floor, measured against the receipt at that holder's vault in the same transaction. |
| An order the vault signs | The vault registers an order's hash (B1) only under the commitment for it, and only for an order whose price leg pays this vault itself, at or above the committed lowest price and never below the principal the lien records, with fee legs inside the lien's budgets. This is the payment-leg check Stage B1 left open. What a buyer pays is held for that `ref` and leaves by the rows above, to the lender side's holder first. |
| The treasury's fee, and the reserve's part (#3641) | The lien's fee budget, or a fee authorization. Both addresses are fixed in the vault code. |
| The backstop | The lien's backstop budget, to the backstop address fixed in the vault code. |
| A non-party paid at a wallet: liquidator, matcher, keeper, inviter | The lien's budget for that class. A liquidator that pays the debt is paid only against the receipt for that payment. |
| An integrator's or a referred user's share | The budget set from the opening fee when the lien was recorded, to a genuine vault. |
| A seller's claim (#1209) | Only the seller the signed sale terms record, up to that claim. |
| Lending for one transaction (#3748) | The mandate's consent, the part not lent, and the balance check at the end of the call. |
| The full tariff in the platform token | A fee authorization. It is the one payment a vault still makes to the Diamond, which holds the recycled amount by design. |
| A side's custody moved to its new holder's vault | Only to the vault of whoever holds this side's position token now, and it stays under a lien there. |
| A grant to a marketplace conduit, a listing escrow, recovery | As built in stages A to B2. |

After this table no class is "checked by the Diamond only". The Stage A residual branch in `_destinationAllowed` is
removed. The Diamond-transient class retires with it, apart from the full tariff: where a payment passes through the
Diamond today (a repayment from a reserve, a sale's price, a takeover's principal, the partial swap-to-repay, an NFT
consolidation, a listing's proceeds), the paying vault pays the receiving vault directly, because a receipt needs to
know which vault paid.

#### 3.7.5 Who the other side is, and how that changes

The payee of a lien is the current holder of the other side's position token, read from the position-NFT contract,
which no facet can write (§3.9). A holder with no vault yet gets one deployed in the same transaction. When this vault's
own side changes hands, the lien answers to the new holder: its actions need the new holder's authorization, and what
is released goes to the new holder's vault. A plain transfer therefore changes nothing in any vault.

A protocol route is different. A sale, a takeover or a handover retires the leaving side's token and mints a new one
(`LibLoan.migrateLenderPosition`), and both the retirement and the loan's pointer to the new token are Diamond storage.
The Diamond can mint. If a lien followed the Diamond's pointer, a faulty Diamond could mint a token to itself and
become the payee of every lien. So:

- **A lien's other side is replaced only by a record the leaving side made.** The position-NFT contract gains one
  entry and one read: "this token is replaced by that one", accepted only from the replaced token's holder or that
  holder's genuine vault. A lien follows that record and nothing else.
- **A vault declares a replacement only in two cases.** Under its owner's authorization for that sale. Or, with no
  owner present, under a standing consent in its mandate (a takeover, a continuation), once it holds a receipt for at
  least the principal it lent on that loan and has not yet received back. A lender's vault never gives up a position
  for less than its principal unless its owner signs.
- A seller's claim exists only from sale terms the seller authorized: signed for that sale, or the standing consent
  the replacement was declared under. Its amount is interest the Diamond computes (§3.7.8).

#### 3.7.6 Release

Under the payout rule a lender is paid vault to vault on every route, so the release check of §8 Q5 is the general case
and its list of exceptions shrinks to two:

- **A forced sale** (liquidation, a default on a priced asset, swap-to-repay): the vault makes the sale itself and pays
  the proceeds to the lender side's holder first, so there is nothing to release on trust.
- **A holder who cannot be paid now** (sanctioned or parked): the amount stays in the paying vault under a lien whose
  payee is that position, and leaves only to that holder's vault later.

#### 3.7.7 What a fill may do with no owner present

A fill under the lending mandate can: move principal within the amount set aside and the slot's exposure cap, in the
mandate's asset, for a loan whose collateral is locked in a genuine vault, in the slot's collateral asset, worth enough
at the slot's loan-to-value limit, before the slot's end date. It cannot: touch free balance outside the amount set
aside, pay any other destination, or lend against collateral the vault itself does not price as sufficient. On the
borrower's side a continuation or a refinance can carry the collateral lien, whole, to the continued or the new loan.
It does so only once the old loan's principal still owed is nil by receipts at the old lender side's holder vault, and
only to a loan whose borrower-side token is held by whoever holds the old loan's (§3.7.3).

#### 3.7.8 What the vault does not check (stated)

- **The rate and the term of a fill, and the interest due.** They are loan-record terms. A faulty Diamond could record
  a fill at a worse rate than the slot allows, or a continuation above the borrower's highest rate, or misstate the
  interest a payment carries or a seller has earned. The principal is still locked against sufficient collateral and
  returns only against receipts for principal, and a borrower's collateral never pays past the ceiling, so the loss is
  bounded to interest for the time it takes to pause.
- **Whether a priced loan may be liquidated now, and what it owes on the day.** A faulty Diamond could sell a healthy
  loan's collateral early, or overstate the debt. The sale is made by the vault at no worse than its outer floor, the
  lender side receives no more than the ceiling and the rest stays with the real borrower. The loss is bounded to
  slippage, the class budgets and the difference between the debt and the ceiling. Collateral with no price cannot be
  taken before the lien's own date at all.
- **Who a budgeted non-party is.** A keeper's or a matcher's wallet is not something a vault can establish. The budget
  bounds it.
- A bad price through a legitimate route stays covered by the price guard's own rules (§7).

#### 3.7.9 The owner record and protected mode

The vault records its owner wallet and, under protected mode, its signers and its allowlist with its own delay, all
from owner-authorized changes. A protected account's primary replacement (a majority of signers, after the delay) is
checked by the vault itself, and the new owner wallet is then both the payout destination and the signer of later
authorizations. Stage B2 built this, and its build notes record how.

B3 moves the last of protected mode into the vault: the queued payouts and the co-sign setting, which B2 left in
Diamond storage. A protected account's withdrawal becomes a row its vault records under the owner's authorization. The
vault holds the amount while the row waits, so nothing else can spend it. It releases the row itself, only after its
own delay, only to the recorded destination, and with a signer's co-signature where its own record requires one. A
lock cancels every waiting row in the same step, with no separate run to apply it.

#### Alternatives considered

1. **A second ledger: the vault keeps a bound, the Diamond keeps the liens.** Rejected: two records of one fact can
   disagree, and the vault's balance check needs the amounts anyway.
2. **The owner signs every fill.** Not possible: fills happen with no owner present. The mandate is the owner's
   signature, given once, over what a fill may do.
3. **The vault checks the rate and the term too**, by reading the borrower's signed terms. Not chosen: the Diamond
   computes what is due from its own loan record, so the check would bind nothing. Stated in §3.7.8 instead.
4. **Every funded action goes through the vault** (the owner calls the vault, which calls the Diamond), one prompt on
   every wallet. Not chosen now: every entry in the Diamond reads its actor from the caller today, and each would have
   to learn it a second way, from a vault. That is a change to every facet and a new thing for an audit to trust. The
   rule in §3.7.1 already accepts a direct call, so this can be added later without changing the vault.
5. **Keep the wallet's standing allowance to the Diamond for payments that open no commitment** (a repayment, a
   top-up, a deposit). One prompt after a first approval. Not recommended: the published statement would then have to
   say that a change to the Diamond can move tokens out of wallets, up to what each has approved.
6. **A sale moves the same token, and nothing is ever replaced.** It meets the rule of §3.7.5 with no new entry on the
   position-NFT contract. Not recommended as the first choice: the retired token is the seller's own receipt today, and
   the sale of part of a position needs a new token in any case. The builder may show it fits better.
7. **`tx.origin`, or trusting the Diamond.** Rejected by the owner on 2026-11-06 (§8 Q1).
8. **Leave the residual classes bounded by the Diamond.** Rejected: the statement that the vault bounds amounts would
   be untrue for exactly the classes paid at wallets.

#### Recommendation

Build B3 as stacked PRs by one builder, after the one-transaction lending build (#3748): the vault's records, entries
and checks with the outflow library moved onto them; the commitments at each opening entry and the wallet rule (after
the lending balance's first part and the borrowing record merge); the vault-to-vault payments, the receipts and the
replacement record; the order check and protected mode's queued payouts; then the apps and the keeper (B4). B3 is
launch code and belongs to the first audit phase. The position-NFT contract and the vault code both change, so it
reaches a chain by fresh deploy, as every stage has.

#### Tests

- An outflow of every class with no matching commitment or lien is refused by the vault with the Diamond's check
  stubbed out, and passes with it.
- A fill beyond the amount set aside, in another asset, with no collateral lien for the loan, or against collateral
  worth too little at the slot's limit, is refused by the lender's vault.
- With the Diamond's checks stubbed out, a loan cannot be opened whose lender token is held by anyone but the paying
  side's entitled holder, and a collateral lien with no receipt for its principal is released by its owner.
- With the Diamond's checks stubbed out, a borrower-side token minted to anyone but the holder entitled under the
  collateral commitment opens no lien and is paid no principal, on an accept, on a keeper's match of two posted offers
  and on a mandate fill.
- A refinance and a continuation open on the receipt at the old lender side's holder vault. The carried lien is bound
  to the new lender side, nothing is paid to the borrower for the part that pays the old loan, and neither route can
  carry a lien to a loan whose borrower-side token another party holds.
- Interest paid over a loan's life, however much, never brings the lien's principal still owed down, and a receipt is
  never counted twice. A lender side that changes hands between two repayments does not hold up the release.
- A lien's other side changes only by the position-NFT contract's replacement record. A minted token that no holder
  declared is never paid. A vault declares a replacement without its owner only against a receipt for the principal
  still out.
- Collateral returns in full only after receipts cover the principal, and in part only while the rest still covers it.
- A forced sale below the vault's outer floor is refused, and its proceeds can leave only to the lender side's holder.
  An internal-match leg is held to the same floor on both loans.
- With the Diamond's checks stubbed out, the lender side of a loan never receives more than the ceiling from its
  collateral, and collateral with no price cannot be taken before the lien's date. Across the lifecycle suites the
  ceiling is never below what the loan owes, and the date is never after the time the Diamond allows a default.
- A non-party is paid no more than its class budget, and a liquidator only against the receipt for the debt it paid.
- An order whose price leg pays anyone but this vault, or whose price is below the committed lowest price or the
  principal the lien records, is not registered. A listing at the floor inside the grace period is registered only on
  a loan whose signed terms allow a listing.
- A protected account's queued withdrawal is released by the vault only after the vault's own delay, with the
  co-signature its record requires, and a lock cancels it in the same call.
- The three routes of §3.7.1 open the same lien, a replayed signature is refused, and an `authorize` does not outlive
  its transaction.
- No entry pulls from a wallet on an allowance to the Diamond: a guard in the pre-deploy check refuses one.
- The vault's free figure plus what it holds under liens never exceeds its token balance after every step of the
  lifecycle suites, and the Diamond holds no second figure.

#### Open items for the builder to raise, not decide silently

- The mapping of each held-amount family in `LibEncumbrance` (lender proceeds, seller interest, held for lender,
  borrower proceeds, the parked refinance leg, the fallback custody row) to a lien kind, or to nothing under the payout
  rule. The claim-custody class of §3.3 is one of them.
- The Diamond's own balance figures (the tracked ledger, the depository holding): which retire and which become reads
  of the vault. The fee-discount record keeps its day history and reads the live figure.
- Each payment that passes through the Diamond today, with the direct form that replaces it. Any that cannot be made
  direct is raised with its reason, never bounded silently.
- Which vault makes the pull for a payer that is no party to the loan (a liquidator, a buyer). Designed: its own.
- The vault's outer slippage figure: the setting's ceiling (25% today) or a tighter figure fixed in code. The
  internal-match leg is confirmed against it on both loans.
- How the ceiling and the date are computed from the signed terms, so that neither can ever refuse a legitimate step:
  the highest rate over the whole term and its grace, the late-fee ceiling, time added by a pause, a renewal or a
  continuation under a plan, a floating rate with no cap, and a loan that ends by notice (#3813), whose date comes
  from the notice the lender side's vault recorded.
- The gas of a lien change that moves no tokens, of the receipt call, and of the price read on a fill.
- The class budgets (§8 Q4), read from the configuration bounds.
- Where the lien code lives: the vault code was measured at about 16.8 KB of the 24,576-byte limit on 2026-11-15, and
  protected mode already runs as fixed code the vault delegates to. The lien code likely needs the same form.
- Whether a borrowing's shared collateral record ([BorrowingDesign.md](BorrowingDesign.md)) is one lien or one per
  loan.
- The NFT rental mapped onto these records: the renter's right, the prepayment and its buffer, the daily deduction and
  the close-out. A rental's prepayment carries no lien today.
- How a buyer's payment for a registered order is recorded as held for the loan when it arrives. A marketplace pays
  the price leg by a plain transfer, so the fill callback is where the vault can measure and record it. Today the
  price leg pays the Diamond, which splits it.

#### For the owner (open)

One user-facing change. On a plain wallet a funded action becomes sign, then send. Today an action funded from the
wallet is a first approval of the token and then one send, and an action funded from the vault is one send. A wallet
that sends several calls as one keeps one prompt, and no wallet gives the Diamond a standing approval any more.
Alternative 4 would keep one prompt on every wallet, at the cost named there. Alternative 5 would keep one prompt for
payments only, at the cost named there. Recommended: accept sign, then send.

### 3.8 What stays as it is

- Sanctions: the lock and move-out windows stay, as layer 1 rules.
- Protected mode's hold, queue and release stay, as layer 1 for the owner
  class, plus the vault's own allowlist check. (Stage B3 moves the queue
  into the vault, §3.7.9.)
- The #3178 counterparty principle: no protocol class ever reads the
  owner's allowlist or version. (#3204 removes the version rules anyway.)
- Delivery measurement and the tracked-balance counter, now inside the one
  library function. (Stage B3 moves the counter into the vault's balance
  record, §3.7.2.)

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
- **Diamond-transient legs.** Stage B3 retires them (§3.7.4): a paying vault
  pays the receiving vault directly, and the only payment a vault still
  makes to the Diamond is the full tariff in the platform token, under a
  fee authorization. Until B3 merges, the vault bounds the amount to the
  lien and only layer 1 checks the onward leg.
- **A grant left standing by a faulty Diamond** can be used by its
  registry spender until someone runs the open cleanup, up to the granted
  amount, which never exceeds that one lien (§3.5). Cleanup debits the
  lien by what actually left.
- **Incentive recipients** are checked only by the per-lien budget, before
  and after B3: who a keeper or a matcher is is not something a vault can
  establish (§3.7.8).
- **A forged close-out.** Until B3 merges, on the listed exceptions of
  §8 Q5 a compromised Diamond can release a lien it should not, and the
  collateral then reaches the borrower's own wallet, never a third party's.
  The loss is the lender's, bounded by that one lien, and is slowed by the
  #3206 delay above its threshold. After B3 the exceptions shrink to the
  two of §3.7.6, neither of which releases on trust. What a faulty Diamond
  can still do is stated in §3.7.8: record a worse rate, or sell a priced
  loan's collateral early, with the loss bounded by the vault's floor, the
  ceiling and the class budgets.

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
   in this change, which widens it a lot. **Answered by the Stage B3 design
   (2026-11-19):** the swap leg was made the vault's own in Stage B1
   (`swapOut`), and the remaining transient legs become direct
   vault-to-vault payments (§3.7.4).
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
   vault to vault. Designed in §3.7 as refreshed on 2026-11-19, and built in
   Stage B3.

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

### Build notes, part 2 Stage B1: outcome checks, no registry trust in the vault (2026-11-09)

Stage B is four stacked PRs under #3379 (owner, 2026-11-09). B1 is the
#3431 hardening: the vault stops trusting any address it is told about and
checks what actually happens instead.

1. **Endpoints are constants in the vault code.** The implementation's
   constructor takes one record: the treasury, the backstop vault, Seaport,
   the 1inch order protocol, the listing conduit and its Seaport conduit
   key, and the price guard (#3447, read from #3268 on). They are
   immutables, readable through `vaultEndpoints()`. The vault reads no
   registry. Changing any of them means new vault code through the
   VaultBeacon, which is the Timelock's, the same as any other vault code
   change. A Diamond setting that differs from the vault's constant fails
   closed: the vault refuses the outflow or the grant. The launch readiness
   check compares the two and names any mismatch.

   > **#3569 (2026-11-12):** the treasury no longer has a Diamond-side copy
   > to mismatch. The vault code's `TREASURY` is the one treasury:
   > `AdminFacet.setTreasury` and `TreasurySet` are removed,
   > `AdminFacet.getTreasury()` reads the current vault code's `TREASURY`,
   > and a fee the Diamond moves itself goes there. A fee drawn from a vault
   > goes to the treasury that vault's own code names, so a vault pinned to
   > an older version pays that version's treasury until it unpins or the
   > version is revoked. "Vault endpoints match" no longer compares the
   > treasury; the other endpoints are unchanged.
2. **The backstop exists before the vault code.** The backstop vault is now
   provisioned in `DeployDiamond` (step 5c-iii), before step 5d builds the
   vault code with its address. Provisioning no longer waits for the
   Diamond to be unpaused; it is still the vault admin's alone. Its upgrade
   keeps the proxy's address, so the constant stays true.
3. **Spender rights name a constant.** A conduit grant and a listing
   escrow's approval must name the listing conduit. An order-taker grant must
   name the 1inch order protocol. Nothing else can be approved.
4. **Order signatures answer only to their protocol, for orders the vault
   hashed itself.** The Diamond no longer hands the vault an order hash. It
   hands it the order terms:
   - For a Seaport listing, the vault checks that the offerer is itself or
     one of its own listing escrows and that the conduit key is the
     constant's key, then asks Seaport for the hash of those terms.
   - For a swap-to-repay limit order, the vault checks that it is the maker
     and asks the 1inch order protocol for the hash.
   
   The vault records which protocol each hash belongs to. Its ERC-1271
   answer is valid only when that protocol is the caller (for an escrow,
   the escrow asks on Seaport's behalf, and the escrow itself answers only
   Seaport). It no longer asks a validator contract the Diamond named.
   Every teardown still revokes the hash.
5. **What B1 does not yet check on an order.** It does not check the order's
   payment legs (who receives the proceeds, and how much). The vault cannot
   judge those without the owner's own terms, and those arrive in B3 with
   the owner-signed liens and the listing-hash rule. Until then, layer 1
   (the Diamond) builds the payment legs, as it does on main, and the
   Seaport zone checks them at fill.
6. **`swapOut`: one atomic swap, judged by its result.** The vault sells at
   most `maxIn` of one asset through an adapter on the fixed swap adapter
   interface and requires the recipient's balance of the output asset to
   rise by at least `minOut`. It refuses an adapter that is itself or the
   asset being sold, and it measures both sides around the call, so a
   faulty adapter can neither take more than it was offered nor deliver less
   than the floor. The allowance it opens for the adapter is closed in the
   same call. The recipient must be a destination the vault can establish
   for itself (its own owner, or the vault of a position's current holder).
   The forced sale still moves the lot to the Diamond and sells there
   (class DiamondTransient). Moving it onto `swapOut` needs the vault to
   know the floor, which is the price guard's job from #3268.

   **The stated residual.** Until #3268, the floor (`minOut`) and the
   adapter are the platform's choice: the vault enforces whatever floor it
   is given, but it cannot judge that the floor is fair. Nothing calls
   `swapOut` yet. A faulty platform module could already move value through
   the DiamondTransient class, so `swapOut` adds no new exposure. From
   #3268 the vault checks the floor against the price guard itself.
7. **The swap-to-repay order still pays the Diamond.** Its receiver is the
   Diamond, which repays the loan inside the fill's post-hook. B1 keeps that
   and states it: the vault checks that it is the maker, and the order's
   receiver is checked by layer 1 and by the order protocol's hooks.
8. **The registry stays the Diamond's.** The protocol registry keeps the
   endpoints the Diamond itself reads, seeded at construction, and the
   deploy refuses a registry whose seeded set is empty. The treasury pointer
   is kept there as the published record. (#3569, 2026-11-12: no longer.
   The registry seeds no treasury pointer and `RegistryKeys.TREASURY` is
   removed; the vault code's `TREASURY` is the published record.) The launch readiness check
   ("vault endpoints match") holds the vault constants to the Diamond's own
   settings: the treasury, the backstop vault, the 1inch order protocol,
   and, once a listing executor is set, its Seaport and an allowed conduit.
   The conduit has one input, its key: the deploy resolves the conduit
   address through Seaport's conduit controller, and the readiness check
   refuses a vault code whose key does not resolve to its conduit.

### Build notes, part 2 Stage B2: protected mode held by the vault (2026-11-10)

B2 moves protected account mode out of Diamond storage into each vault, and
makes vault identity a function of the creation owner (#3393). Owner
decisions 2026-11-10 (delegatecall split; the vault is the only writer).

1. **CREATE2 vaults (#3393).** The Diamond creates every vault with CREATE2,
   salted by the owner wallet, as a BeaconProxy built with no call data
   (initialized in the same transaction). The beacon publishes the proxy's
   init-code hash, so a vault's address is a function of its creation owner
   alone. A vault is genuine when it runs the vault code AND sits at the
   address its own recorded creation owner derives: a look-alike anyone
   deploys, whatever owner record it carries, fails.
2. **One record, one writer.** A vault's protected record (its delay, lock,
   up to five signers, up to five allowlisted destinations, the open
   replacement, the per-key nonces) lives in the vault's own storage, at an
   ERC-7201 namespace the storage-layout guard records. It is written only by
   `VaultProtection`, a stateless, non-upgradeable code contract every vault
   delegatecalls through its `protect` entry. Its address is fixed in the
   vault code like the other endpoints, so changing the rules is new vault
   code through the beacon's delay; its writes refuse a direct call.
3. **Who writes.** Each write names its key (the owner, a signer, or a
   destination verifying itself) and is accepted as a direct call from that
   key, or as that key's EIP-712 signature submitted by anyone. Contract
   wallets sign through ERC-1271. Every purpose has its own typehash (settings,
   allowlist add, allowlist cancel, signer change, replacement, lock,
   destination verification), and every signature is bound to the chain and
   the vault (the domain), to the key's next nonce for that purpose and to an
   expiry. A used nonce is spent; a key may burn its next nonce to void a
   signature it gave out.
4. **The rules carried over unchanged.** A 2–5 day delay. A loosening change
   (an allowlist or signer addition, a signer removal, a delay lowering, an
   unlock, a switch-off) waits the delay, expires one further delay after it
   matures, and can be cancelled by the owner or any signer. A lock (owner or
   signer, also signed and relayed by anyone, #3423) drops every pending
   change and the owner's own replacement proposal. A replacement waits the
   delay from the owner's own proposal, or from the moment a majority of at
   least three signers is reached; the owner cannot redirect a recovery under
   a lock a signer placed.
5. **A replacement moves the owner record, not the vault.** Finalizing it
   sets the vault's owner record to the nominee: the payee of the owner class
   and the key every later owner authorization (and the beacon's pin
   signatures) is checked against. The vault stays the one created for the
   account, and a holder payout goes to the vault whose CREATION owner is the
   holder, so positions the replaced wallet held keep paying the vault the
   new owner controls.
6. **#3415, the verified flag.** Each allowlist entry carries `verified`, set
   only by the destination itself: its direct call, or its signature naming
   the account and the Diamond (the chain and vault through the domain). A
   payout to an unverified destination needs a signer's co-signature when the
   account has signers; an account without signers is unaffected. The
   inbound small-transfer form is the destination's direct call (proven by
   `msg.sender`), so no separate native-transfer path is needed.
7. **The vault enforces the record itself.** An owner-class outflow, and a
   swap paying the owner, is refused while the vault is locked; an
   allowlisted outflow reaches only a finalized entry of the vault's own
   record. This closes the Stage A residual for allowlisted destinations.
8. **The Diamond reads, and applies its own side.** Every Diamond rule
   (`LibProtectedAccount`) reads the vault: on, locked, the delay, the
   manager (the owner record), signers, allowlist, verification. Nothing is
   copied. `applyProtection` (permissionless, tightening only) applies the
   platform's effects of the vault's posture: on a switch-on it voids every
   pending change at the beacon and the position-NFT core and raises both
   delays; on a lock or a replacement it also holds the position NFTs and
   cancels queued payout rows; on a replacement it records which account the
   new owner manages. The keeper's chat LOCK (`lockVaultFor`) locks through the
   vault, which accepts that one write from the Diamond because a lock only
   stops value leaving. The co-sign setting stays on the platform side with
   the payout rows, which move in B3.
9. **Stated residuals.** Queued payout rows are still Diamond storage (B3). A
   payout row cancelled by a lock is cancelled when `applyProtection` runs;
   until then it cannot release, because release reads the lock from the
   vault. The app and keeper move to the vault's entries in B4.

### Build notes, part 2 Stage B3: owner-authorized commitments and the vault's own bounds

Not built yet. The design is §3.7 as refreshed on 2026-11-19. The build
records here the choices it made where §3.7 left room, starting with that
section's open items.

## 9. Order of work

1. #3204's build (central vault code; it supplies the code-hash identity
   and the beacon).
2. This build, in two PRs (decided default, 2026-11-08, for reviewability;
   both before the fresh deploy): Stage A (the vault's two entries, the
   policy, all call sites moved, the old entries deleted, the grants and the
   escrow), then Stage B (#3379: the owner-signed liens, the class budgets,
   the receipt release and the seller-claim check). Stage B is built in
   parts: B1 (outcome checks), B2 (protected mode held by the vault), then
   B3 (§3.7 as refreshed on 2026-11-19: the vault's records; the commitments
   at each opening entry and the wallet rule; the vault-to-vault payments
   with their receipts and the replacement record; the order check and
   protected mode's queued payouts) and B4 (the apps and the keeper).
   The position-NFT contract (§3.9) is part of it, or lands just before it,
   since counterparty payouts read their holder from it.
3. #3206 (rate limits held in the vault's own storage) builds on this
   library and the vault's records.
4. #3246 part 2 (clawback to the recovery address) adds a class: the
   recovery address, held in the vault. Its rules are in
   [RecoveryAddressClawbackDesign.md](RecoveryAddressClawbackDesign.md).

Fresh deploy, no migration.
