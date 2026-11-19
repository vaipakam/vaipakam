# One rule for where the platform pays a user

**Status:** owner decision 2026-11-19 ("all to the vault, one Withdraw"). Design ready for the builders. Nothing here is built yet.
**Scope:** every step that returns or pays an asset to a user: loan payouts, offer refunds, releases of capital and reserves, rewards. Payments to someone who is not a party (a liquidator, a matcher, a keeper, an inviter) are covered only to say why they differ.
**Related:** `VaultOutflowPolicyDesign.md` (#3205), `LenderPayoutsThroughClaimDesign.md` (#3629), `PositionSaleStateGuardDesign.md` (#3710, whose section 3.3 this design replaces), `ProtectedCommitmentGuardsDesign.md`, the protected Ready balance (#3344), the offer position holder rule (#3744).
**Scouted on:** the batch branch `claude/project-thread-ijafuu` at `4d138a83c` (batch PR #3743), 2026-11-19. File and function names below are from that tree.

## 1. The question

Before protected mode a user met one step: a claim, which showed the position NFT and moved the asset from a vault to the wallet. The platform now has three things side by side:

- a **claim**, which moves what a position is owed into the holder's vault;
- a **withdraw**, which moves free vault balance to the wallet, and which is where a protected account's delay applies;
- several steps that pay a **wallet directly**: the refund of a cancelled offer, the unused part of a matched offer, surplus collateral taken out of a live loan, capital taken back from Auto-lend, a loan reserve taken back.

A user cannot tell from the action which of the three will happen. The same person sees a cancelled offer arrive in the wallet, a repaid loan arrive in the vault, and, once protected, the cancelled offer arrive nowhere for some days. The audit surface is also wider than it needs to be: every wallet-paying step has to carry the protected-mode checks itself.

## 2. The rule

1. **Everything the platform owes a user lands in a vault, as free balance.** For an amount owed to a loan or offer position, the user is whoever holds that position's NFT, read from the token by the platform, never named by the calling step.
2. **Only the owner's Withdraw from their own vault pays a user's wallet.** It is the one place protected mode's delay, lock and allowlist apply.
3. **Only someone who is not a party is paid at a wallet**: a liquidator, a liquidation buyer, a matcher, a keeper, an inviter. Section 4.6 lists them and says why.
4. **One "and withdraw" option** runs the user's own action and then withdraws exactly what that action credited to their vault, in the same transaction. A user who wants the money in the wallet still gets it in one click. A protected account's withdrawal queues behind its delay, as any withdrawal does.

Two words carry the whole model for a user:

- **Collect**: show the position NFT, receive what the position is owed into your vault.
- **Withdraw**: move free vault balance to your wallet.

### 2.1 Terms

- **Free balance** is the part of a vault its owner may take out. On chain it is the depository ledger (`LibDepositoryLedger`), bounded by what is not under a lien or an earmark. An offer's escrow, a loan's collateral, Auto-lend capital, a loan reserve and an amount held for a position are **purpose-bound** and are not free.
- **Releasing** an amount means turning purpose-bound balance into free balance. When the entitled user owns the vault the amount already sits in, nothing moves: the lien drops and the free-balance ledger rises. When the entitled user is someone else (a position changed hands), the amount moves to that user's vault and is free there.
- **Held for a position** means purpose-bound balance that belongs to whoever holds a position NFT when they collect it (`heldForLender`, the lender and borrower claim rows, the borrower surplus row).

## 3. What exists today

### 3.1 Already follows the rule

- Every claim on a loan (`ClaimFacet`, 14 call sites, plus `PrecloseFacet`, `RefinanceFacet` and the handover's held extra in `LibCloseoutFreeze`) pays through the position-holder payout into the holder's vault as free balance. A claim never pays a wallet (#3629).
- Every payment made to a lender while a loan stays open is held for the lender position and collected by its holder (#3629).
- A new loan's principal goes to the borrower's vault as free balance (`OfferAcceptFeeFacet`, #3205 part 2).
- A swap-to-repay surplus is held for the borrower position; its unused collateral goes back under the loan's lien.
- Sale proceeds, a buyer's held amounts and a refinance's payoff move vault to vault.
- A registered integrator's share is paid into its payout account's vault as free balance (#3682).

### 3.2 Pays a wallet today

Every row below reaches the owner's wallet through `LibVaultOutflow.toOwner` (or `toAllowlisted`, or the holder's-wallet payout), outside the Withdraw itself. For a protected account each of these is queued behind the delay by the outflow policy, so the same action behaves differently by account type, and a step another person triggers can open a queued payout on someone else's account.

| Step | Who triggers it | Code | Sites |
| --- | --- | --- | --- |
| Offer cancel: the unfilled principal, collateral, lent NFT or rental prepayment | The offer's creator | `OfferCancelFacet` | 7 |
| Offer size-down: the released part | The creator | `OfferMutateFacet` | 1 |
| A match's leftovers: unused collateral, a closing offer's remainder | A matcher, or the other side | `LibOfferMatchExecute` | 3 |
| A direct accept's unused collateral | The acceptor | `OfferAcceptFacet` | 1 |
| A collection offer's released backing | The creator | `CollectionOfferFacet` | 1 |
| A loan-sale vehicle's collateral (zero today, wired defensively) | The buyer's accept | `EarlyWithdrawalFacet` | 3 |
| Surplus collateral taken out of a live loan | The borrower position's holder | `PartialWithdrawalFacet` (holder's-wallet payout, #3710) | 1 |
| A prior seller's interest claim | The seller | `SellerClaimFacet` | 1 |
| Auto-lend capital taken back | The slot's owner, or anyone for a recovered account | `LenderIntentFacet` | 2 |
| A loan reserve taken back | The borrower position's holder | `StandingInstructionFacet` | 2 |
| VPFI taken out of the vault | The owner | `VPFIDiscountFacet` | 1 |
| A reward, when the claimant is a contract or the vault credit fails | The claimant | `RewardClaimFacet`, `LibRewardStaging` | 2 |
| A salary stream | The beneficiary | `PayrollFacet` | 1 |

The Withdraw (`VaultDepositoryFacet.withdrawFromVault`) and the release of a queued payout (`VaultPayoutFacet`) are the two places that should pay an owner's wallet. Today thirteen other steps do as well.

## 4. Design

### 4.1 Every release goes into free balance, through the outflow policy

Each step in table 3.2 stops paying a wallet and releases into free balance instead. The outflow policy stays the one seam: it already books a payout whose payee vault is the paying vault as a ledger change with no transfer, and it already places the position marks of #3710. Three ways of reading the payee cover every case:

| Payee is read from | Policy class | Used by |
| --- | --- | --- |
| A loan's position token | The position-holder payout (exists) | Surplus collateral, a loan reserve taken back, every claim |
| An offer's position token | A new offer-holder payout (#3744) | Cancel, size-down, a match's leftovers, a direct accept's unused collateral, a collection offer's released backing |
| The account itself | A new own-balance release: no payee, no transfer, the free-balance ledger rises | Auto-lend capital, a seller's interest claim, a sale vehicle's collateral, a reward, a salary |

No step names a payee. A step passes the loan or offer and the token, or nothing at all for the account's own balance, and the policy does the rest. The policy emits the same `VaultOutflow` event for each, with zero delivered outside the vault when nothing moved, so the indexer shows one kind of entry: "returned to your vault balance".

The holder's-wallet payout of #3710, its isolated wallet step and its fallback into the vault are deleted. Surplus collateral taken out of a live loan is released to the holder's vault by the position-holder payout, which makes the fallback case the only case. `PositionSaleStateGuardDesign.md` section 3.3 is rewritten to say so; the marks and the two waits are unchanged.

### 4.2 Own action, or someone else's

Who triggers a step decides whether a Collect is needed.

- **The holder's own action** (cancel, size-down, take out surplus collateral, take back a reserve, a claim) releases at once. The caller is checked to hold the token, so the holder is known at that moment.
- **Someone else's action on a live loan** (a repayment, a liquidation, a default, a periodic sale) cannot know who will hold the position when the money is wanted, and must not create a vault for a stranger or run a sanctions screen on one. The amount is held for the position and its holder collects it. This is #3629 and is unchanged.
- **Someone else's action that ends an offer's claim on its escrow** (a match that closes the offer, a fill that leaves unused collateral) releases the leftover to the offer token's holder at that moment. In almost every case that is the creator, whose vault already holds it, so nothing moves. If the offer's token has changed hands, the leftover moves to the new holder's vault. A holder who cannot be paid (flagged, or a vault that cannot be made) must never block the other party's fill: the leftover then stays in the creator's vault, held for the offer's token, and its holder collects it later. #3744 builds this.

A new loan's principal keeps going to the borrower's vault as free balance at the accept. The borrower is a party to that same transaction, as creator or acceptor.

### 4.3 One door to a wallet

`LibVaultOutflow.toOwner` and `toAllowlisted` are called from two hosts only: the Withdraw and the release of a queued payout. A build check, beside the raw-payout check of #3710 (pre-deploy step 1d3), reads the compiler's AST and refuses any other caller of the two helpers, and any other construction of the owner classes. The clawback and a recovered account's sweep keep their own class (the recovery payout) and are listed.

With one door, the protected-mode checks live in one place:

- The payout gate inside the outflow policy can be reached only from the Withdraw and its release. For any other route an owner-class payout from a protected account becomes a refusal, not a queue.
- `requirePayoutRoom` is called by the Withdraw alone. The calls at the collateral withdrawal and the VPFI exit go.
- Nobody but the owner can open a queued payout on an account, or use up its room. Today a matcher's fill can.
- A locked account needs no special branch: a release stays in the vault because every release does. The recovered-account branch in the Auto-lend capital withdrawal goes for the same reason.

### 4.4 "And withdraw"

The platform already has a batch entry (`MulticallFacet.multicall`): it runs several of the caller's own calls in one transaction, each as the caller, each keeping its own authorization. "And withdraw" is that batch with a withdraw as its last item. Two additions make it exact:

1. **The amount is what the batch credited, not a figure fixed in advance.** A claim's amount moves with per-second interest, a cancelled offer may have been part-filled between signing and mining, and a fee-charging token delivers less than was sent. So the free-balance ledger keeps, in transient storage and only while a batch is open, what was credited to the batch's caller per asset. A debit or a spend inside the batch lowers it. The figure is cleared when the batch ends.
2. **A withdraw of exactly that figure**: `withdrawCredited(kind, asset, tokenId)` on the Withdraw's own facet, which takes the lesser of the batch figure and what is withdrawable now, and then runs the ordinary Withdraw to the account's own wallet. It returns zero outside a batch, or when nothing was credited.

The figure sizes the withdrawal and gives no authority. Who may withdraw, the free-balance bound, liens, the sanctions screens, and protected mode's delay, lock and allowlist are all the Withdraw's own checks, unchanged. A withdrawal of all free balance was considered and refused: it would sweep VPFI a user holds in the vault for a fee tier, and balance they chose to leave.

The app marks the withdraw item as allowed to fail. If the withdraw is refused (a paused platform, a token that will not deliver), the user's action still stands and the amount stays in the vault as free balance, where an ordinary Withdraw takes it later.

A batch can chain: "repay, collect the collateral, withdraw it" is three items and one signature.

### 4.5 What protected mode keeps

Nothing in protected mode is weakened. A protected account's assets reach a wallet only by a Withdraw, queued behind the delay, to its own wallet or an allowlisted address, and a lock stops it. What changes is that this is now true by construction for every account, and the differences between a protected and an unprotected account shrink to one sentence: a protected account's Withdraw waits.

The Ready balance is unchanged. A release goes to free balance, not to Ready, in line with the 2026-11-08 decision that Ready is never refilled automatically.

### 4.6 Who is still paid at a wallet, and why

| Paid at a wallet | Why |
| --- | --- |
| The owner, by Withdraw or by the release of a queued payout | Rule 2 |
| The recovery address, by a clawback or a recovered account's sweep | The account's own exit under protection (#3246 part 2) |
| A liquidator's bonus, a liquidation buyer's collateral | A liquidator is often a contract that must settle within its own transaction, holds no position, and should not need an account here |
| A matcher's fee, a keeper's bonus and reward | The same: paid for a service in the transaction that did it |
| An inviter's share (#3722) | Paid inside another user's accept; a wallet payment creates no vault at that user's cost. A protected inviter is credited in its vault, as built |
| Swap adapters, the treasury, the backstop vault, the cross-chain messenger | Protocol destinations, not users |
| A caller's own unspent native fee | A refund of what the caller sent with the call |
| An admin's treasury claim and broadcast-budget withdrawal | Protocol funds, to an address the admin names |

A payment in this table to an address that has protected mode on is credited to that account's vault instead, by the policy's existing redirect. That is unchanged.

### 4.7 Open offers (#3744)

#3744 (owner decision 2026-11-18) makes an open offer's refund and its cancel and edit rights follow the holder of the offer's position NFT. It was written to pay "the same way #3710 pays live-loan payouts", meaning the holder's wallet. Under this rule it pays the holder's vault, by the offer-holder payout of section 4.1. The rest of #3744 stands.

### 4.8 Paying from the vault (follow-on, #3746)

Once everything lands in the vault, a user will want to use that balance without a round trip through the wallet. Today only two steps can: a vault-backed signed offer and the instant market's collateral. Posting an offer, accepting one, adding collateral, repaying, funding a reserve and funding Auto-lend take wallet money only. A borrower who left the principal in the vault cannot repay from it.

The follow-on: every step that takes a user's money takes a stated amount from free vault balance and the rest from the wallet, through one funding helper that replaces the two private copies. A protected account can spend only its Ready balance, as today. This is not part of the decision of 2026-11-19. It is recommended, filed as #3746 for the owner to decide, and can follow the payout work.

### 4.9 Stated positions on four routes

- **VPFI.** There should be one Withdraw. The VPFI exit either becomes the Withdraw (preferred: on a fresh deploy every VPFI arrival can be credited to the free-balance ledger, and the tier record is already refreshed by the tracked-balance writer), or stays as the VPFI form of it, listed in the build check as a second caller with that reason. The builder says which, with the reason.
- **Rewards.** A reward lands in the claimant's vault, for every claimant. The choice of a wallet venue and the wallet fallback are removed. If the vault credit cannot complete, the reward stays owed and claimable; it is not sent to a wallet. This matches the copy rule that rewards "land in your vault, ready to use".
- **A salary stream.** Collected into the beneficiary's vault; the beneficiary's "and withdraw" gives the one-click path.
- **A prior seller's interest.** The seller's withdraw becomes a Collect into the seller's own free balance. If nothing still needs the reservation between payment and collection, the builder may credit it as free when it is paid and drop the step; say which.

## 5. Route table

"Free" means free balance in the vault named. "Held" means held for the position until its holder collects.

| # | Route | Triggered by | Entitled | Lands today | Lands under the rule |
| --- | --- | --- | --- | --- | --- |
| 1 | Lender claim at the end of a loan | Lender token holder | That holder | Holder's vault, free | Unchanged |
| 2 | Borrower claim (collateral back, surplus) | Borrower token holder | That holder | Holder's vault, free | Unchanged |
| 3 | Payment to the lender on an open loan (partial repayment, interest, periodic sale, partial liquidation, rental day) | Borrower, keeper, liquidator | Lender token holder | Held in the stored lender's vault | Unchanged |
| 4 | Collect a held amount on an open loan | Lender token holder | That holder | Holder's vault, free | Unchanged |
| 5 | New loan principal | Either side's accept, or a matcher | The borrower of that accept | Borrower's vault, free | Unchanged |
| 6 | Swap-to-repay surplus | Borrower token holder | That holder | Held for the borrower position | Unchanged |
| 7 | Preclose, refinance, handover payouts | The borrower side | Each side's token holder | Vaults, held or free by the step | Unchanged |
| 8 | Sale of a lender position: the price | Buyer or seller | The seller | Seller's vault | Unchanged |
| 9 | Surplus collateral out of a live loan | Borrower token holder | That holder | Holder's wallet (vault on failure) | Holder's vault, free |
| 10 | Offer cancel | Offer token holder | That holder | Creator's wallet | Holder's vault, free |
| 11 | Offer size-down | Offer token holder | That holder | Creator's wallet | Holder's vault, free |
| 12 | A match's leftovers | Matcher or the other side | Offer token holder | Creator's wallet | Holder's vault, free; held for the token if the holder cannot be paid |
| 13 | A direct accept's unused collateral | Acceptor | Offer token holder | Creator's wallet | As 12 |
| 14 | Collection offer: released backing | Offer token holder | That holder | Creator's wallet | Holder's vault, free |
| 15 | Loan-sale vehicle's collateral (zero today) | Buyer's accept | The selling lender | Seller's wallet | Seller's vault, free |
| 16 | Prior seller's interest claim | The seller | The seller | Seller's wallet | Seller's vault, free |
| 17 | Auto-lend capital taken back | Slot owner; anyone for a recovered account | The account | Owner's wallet | The account's vault, free |
| 18 | Loan reserve taken back | Borrower token holder | That holder | Owner's wallet | Holder's vault, free |
| 19 | Integrator's share | An accept | The registered integrator | Payout account's vault, free | Unchanged |
| 20 | Reward claim | The claimant | The claimant | Vault, or wallet for a contract or on a failed credit | Vault, always |
| 21 | Salary stream | The beneficiary | The beneficiary | Wallet | Beneficiary's vault, free |
| 22 | VPFI taken out | The owner | The owner | Owner's wallet (queued if protected) | The one Withdraw (4.9) |
| 23 | Withdraw, and the release of a queued payout | The owner | The owner | Owner's wallet, or an allowlisted address | Unchanged: the one door |
| 24 | Clawback, recovered account's sweep | Owner, signer, keeper as allowed | The recovery address | Recovery address | Unchanged |
| 25 | Liquidator bonus, liquidation buyer's collateral, matcher fee, keeper bonus and reward, inviter's share | The actor | The actor | Actor's wallet | Unchanged (4.6) |

Rows 9 to 18 and 20 to 22 change: the thirteen steps of table 3.2. Every other row stays as it is.

## 6. What a user sees

- **One balance view.** "In your vault": *Available* (free balance), *In use* (offers, loans, Auto-lend, reserves), *To collect* (held for positions you hold), and, for a protected account, *On its way* (queued withdrawals with their dates).
- **Every action says where the money goes before the user signs**: "Returns to your vault", with a ticked option "Also withdraw to my wallet". For a protected account the option reads "Also request withdrawal (arrives after N days)".
- **Two verbs only.** *Collect* wherever a position owes the holder something; *Withdraw* wherever vault balance goes to a wallet. "Claim", "refund to wallet" and "release" are not used for the same thing in different places.
- **A position bought on a marketplace** shows its *To collect* amount to the new holder, and nothing to the old one.
- The app never says a release "paid" anyone. It says the amount is available in the vault, which is what happened.

## 7. Tests

1. For every row 9 to 18 and 20 to 22: the wallet's balance does not change, the vault's free balance rises by the amount, and one `VaultOutflow` entry records it.
2. The same rows against a protected account: nothing is queued, no payout room is used, free balance rises.
3. The same rows against a locked account: the step succeeds where it did before and the amount is free in the vault.
4. A matcher's fill on a protected creator's offer opens no queued payout on that account.
5. Offer cancel and a closing match when the offer's token has changed hands: the new holder's vault is credited, the creator's is not; a flagged holder does not block the match, and the leftover is held for the token.
6. Surplus collateral out of a live loan: to the holder's vault; the borrower token takes the long wait; no wallet step exists.
7. `withdrawCredited` inside a batch withdraws exactly what the batch credited to its caller: after a cancel, after a claim on a loan accruing interest, and after a fee-charging token delivered short. It never touches balance that was free before the batch.
8. `withdrawCredited` outside a batch, and in a batch that credited nothing, moves nothing.
9. A batch whose withdraw item fails keeps the action and leaves the credit free in the vault.
10. A protected account's batch queues the withdrawal for the credited amount; a locked account's batch keeps the amount in the vault.
11. The batch figure counts only the batch's caller: a credit to another account in the same transaction does not enter it, and the figure is zero after the batch.
12. The build check refuses a new caller of the owner payout helpers, and passes with the two listed hosts.
13. The drive-every-route test of #3568 (nothing reaches a protected wallet before the delay) passes with no route-specific allowance.
14. Rewards: a contract claimant is credited in its vault; a failed credit leaves the reward claimable and pays no wallet.

Transient storage does not carry between a test's top-level calls on current forge. Drive each batch test inside one call.

## 8. Alternatives considered

1. **Pay the wallet for an unprotected account and the vault for a protected one.** This is close to today. Rejected: one action has two outcomes by account type, every wallet-paying step carries its own protection checks, and a step another person triggers pushes tokens at a wallet that may refuse them.
2. **Keep today's mix and explain it in the app.** Rejected: it is the confusion the owner raised, and copy cannot fix a model with three destinations.
3. **Drop Collect and credit the holder's vault at every payment.** Rejected: a payer would create a vault for, and screen, a stranger; a position resting in a marketplace's escrow would be paid there; and an uncollected amount should travel with the position (owner rule 2026-11-15).
4. **A "to my wallet" flag on every action.** Rejected: it is one wallet door per action, each needing the protection checks. The batch gives the same single click through the one door.
5. **Withdraw all free balance at the end of a batch.** Rejected: it sweeps balance the user left on purpose, including VPFI held for a fee tier.
6. **A standing "forward everything to my wallet" setting.** Rejected for now: it brings back wallet payments triggered by other people's actions, and a setting that redirects money is a target. It can be revisited as an owner-only, delayed setting if users ask.
7. **Pay every non-party into a vault too.** Rejected: a liquidator must often settle inside its own transaction, and forcing an account on bots adds cost with no safety gain. A protected recipient is already credited in its vault.

## 9. Recommendation

Build the rule as decided: every release into free balance through the outflow policy, the payee read from a token or the account itself, one door to a wallet enforced by a build check, and "and withdraw" as the existing batch plus a withdraw of exactly what the batch credited. Remove the holder's-wallet payout of #3710 before it merges. Build #3744 on the offer-holder payout. Take paying from the vault (4.8) as the next card, since it is what makes a vault-first model comfortable to use.

## 10. Build notes

**Order.** (1) The own-balance release, the batch figure and `withdrawCredited`. (2) Rows 9 to 18 moved onto the releases, the holder's-wallet payout deleted, the build check added with two hosts. (3) #3744 on the offer-holder payout. (4) Rewards, salary and the VPFI exit. (5) The app's two verbs, the balance view and the "also withdraw" option. (6) Paying from the vault (#3746), if the owner agrees.

**Facets that change together.** `VaultOutflowFacet` and `LibVaultOutflow` with every facet in table 3.2; `MulticallFacet` and `VaultDepositoryFacet` for the batch figure; `LibDepositoryLedger` is inlined widely, so this is a fresh-deploy change like the rest of the batch.

**Checks and ledgers to update.** The new owner-payout caller check; the raw-payout check's reasons where a wallet push goes away; `permissionless-steps.json` if any entry's caller gate changes (the recovered-account capital return stays open to anyone); the event-coverage allowlist if an event is retired (`HolderWalletPaymentToVault`, the VPFI withdrawal event if the exit is folded).

**Stale comments found while scouting.** `SwapToRepayFacet`'s header still says the surplus goes to the holder's wallet; it is held for the position. `OfferAcceptFacet`'s "refund to borrower's wallet" goes with row 13.

**Functional spec lines the build PRs change** (the spec states intent, and the intent changed on 2026-11-19): `ProjectDetailsREADME.md` where a lender may "withdraw the un-lent remainder back to their wallet", where a size-down "refunds the unused portion to the creator's wallet", and every place that describes a cancel refund, a surplus collateral withdrawal or a reward venue; `Alpha02ConnectedApp.md` where a sale's proceeds are "sent to their wallet or held for their claim".

**Keeper.** No pass pays a user's wallet today, so none changes. The "claim all" batch gains the withdraw item in the app only.
