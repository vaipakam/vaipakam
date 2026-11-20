# Named-keeper approvals, action by action — review and design

**Status:** review for the pre-audit refactor, card #3790. The owner asked on 2026-11-19 for better options than an "owner mode" in the public keeper bot, and chose two things: a "my positions" mode over the steps anyone may run (#3789, built by the keeper thread), and this review. One decision per action is put to the owner in section 5. Nothing here is built until then.
**Related:** `StandingInstructionsDesign.md` (#3681), `ExitBeforeLiquidationDesign.md` (#3752), `DueDatePlanDesign.md` (#3785), `InstantMarketDesign.md` section 7, `LenderCashOutDesign.md` (#3760), `ProtectedAccountDesign.md`, `RepaymentByOthersDesign.md` (#3779).
**Base:** read on the batch branch of #3743: the authority library, each entry that names a keeper action, the accept path's auto-completion, and the public keeper bot. Checked against that code again after writing.

## 1. What a named-keeper approval is today

A wallet may approve up to five keeper addresses, each with a set of actions, behind a master switch and a per-loan switch. A keeper holding an action may call that entry in the wallet's place. Eight actions exist.

The alternative the platform has grown since is the **standing instruction**: the wallet states its own limits on-chain, and then anyone may run the step, the caller choosing nothing and gaining nothing. The top-up, the interest payment, the repayment at due, the exit before liquidation and the due-date plan all work that way.

The difference matters for one reason. **A key that may choose terms can cause a loss if it leaks. A step that anyone may run inside the owner's own limits cannot**, because there is no key to leak and nothing for the caller to choose.

So the test applied to each action: *what can the holder of this key choose, and what does the wallet lose if the key is in the wrong hands?*

## 2. The actions

| Action | Entry | What the key chooses | Loss if the key leaks |
| --- | --- | --- | --- |
| Complete a loan sale | the lender's `completeLoanSale` | Nothing. | None. But the entry has no work: a buyer's accept completes the sale in the same transaction and reverts if completion fails. The entry is a recovery hook for sales made before that was so, and a fresh deploy has none. |
| Complete an offset | the borrower's `completeOffset` | Nothing. | None, and no work, for the same reason. |
| Start a lender exit | the lender's sale listing; the takeover at face value | For a listing: its terms, bounded only by "not above the loan's own rate". For a takeover: which consenting slot takes the loan. | A listing on poor terms sells the position at a discount to whoever is waiting for it. A takeover cannot lose: the holder is paid the principal outstanding into its vault whichever slot takes it. |
| Start an early close | `precloseDirect`, the handover to another borrower, the offset | Direct close: nothing, and the caller pays from its own wallet. Handover and offset: the offer used, so the terms. | Direct close: none (it is a repayment by someone else, which #3779 opens to anyone through the ordinary repayment). Handover and offset: a shortfall charged to the borrower on terms it did not choose. |
| Extend | `extendLoanInPlace` | The new rate, anywhere inside both sides' limits, and the new term inside both sides' latest dates. | The borrower pays its own highest rate for the longest term it allowed, where a fair run would have kept the loan's rate. Bounded by the borrower's limits, but chosen against it. |
| Fill a restricted slot | the slot match, where the slot's owner asked for named solvers only | Which borrower request fills the slot, inside the slot's terms. | None beyond what any caller may do on an unrestricted slot. This action narrows who may fill; it grants nothing. |
| Re-lend what came back | the roll of a repaid slot loan; re-committing held payments | Nothing: the money goes back behind the owner's own slot, on the slot's terms. | The owner's returned money is committed to lending again when the owner may have wanted it free. Bounded: the slot must still be active and inside its lend-until time. |
| Lock a protected account | `lockVaultFor` | Nothing. | A lock the owner did not ask for: a nuisance, never a loss, and the owner's exit is the recovery address. |

A ninth, automatic refinance, was removed earlier (#3042): a refinance now completes inside the accept of the borrower's own request.

## 3. The principle proposed

1. **An action whose caller chooses nothing, and which the wallet's own on-chain limits fully describe, is opened to anyone.** The wallet's consent is the limits it set. No key is named.
2. **An action whose caller would choose terms is either given terms by rule, so that it falls under 1, or taken out of automation.** Starting a sale and starting an early close on chosen terms are the holder's own decisions.
3. **A named keeper is kept only where naming is the point**: restricting who may fill a slot, and the lock, which acts for one owner on a message from that owner.

## 4. Each action under the principle

**Complete a loan sale, complete an offset: removed.** The two actions, the two external entries and their rows in the ledger of open steps go. The internal completion the accept calls stays. Before removal the builder proves by test that no state can exist in which an accept succeeded and its completion did not; if one is found, it is reported, not worked around.

**Start a lender exit: the listing leaves automation, the takeover becomes an instruction.**
- A listing is a price decision. Only the holder lists. The lender cash-out door (#3760) is where a holder leaves in one step.
- The takeover at face value pays the holder the same whichever slot takes the loan, so it fits rule 1 once the holder has said so on-chain: a per-loan instruction, "hand this loan to a consenting slot at face value", with an optional earliest time. Anyone may then run it. It replaces the key-held mandate of `InstantMarketDesign.md` section 7.

**Start an early close: removed as a keeper action.**
- The direct close needs no keeper action once #3779 lets anyone repay. Someone other than the holder who wants to pay a loan off uses the ordinary repayment, which #3779 opens to any payer: the caller pays, and the collateral is released to the borrower position. The direct close entry itself stays the holder's own, so there is one route for a repayment by someone else and not two.
- The handover and the offset are the borrower's own decisions on chosen terms. What a borrower wants automated at the end of a loan is already an instruction: repay at due, repay from collateral, exit before liquidation, the due-date plan.

**Extend: opened to anyone, with the terms set by rule.**
- The rate is the loan's own rate where that lies inside both sides' limits; otherwise the midpoint of the range both allow, as a match prices two offers. The term is the borrower's base term, cut to the earlier of the two sides' latest dates. No range in common, no extension.
- Both sides' limits are then the whole consent, as the lender's already are today. The platform switch for automatic extension keeps its meaning: it stops a run by anyone but the holder.
- This is the first step of the due-date plan, which already assumes the loan's own lender continues "at the unchanged rate".

**Fill a restricted slot: kept.** It is the one action that exists to name someone.

**Re-lend what came back: opened to anyone, on the slot's own consent.** A slot gains a setting, "lend again what comes back", which the owner switches on or off with the slot's other terms. With it on, anyone may run the roll and the re-commit. With it off, the money stays free in the owner's vault. A slot with no end date (`#3763`) has it on by default, since that is what no end date means. Amended 2026-11-19 (#3811, `LendingBalanceDesign.md` 3.5): the money returns to the owner's lending balance for that asset, which every slot of that owner lends from, and the setting read is the origin slot's.

**Lock a protected account: kept.** It must act within seconds of the owner's message, for one owner, and it can only stop movement.

**What remains of the approval system:** two actions (fill a restricted slot, lock), the list of up to five keepers, and the master switch. The per-loan switch has no action left to gate and goes with the six.

## 5. Decisions for the owner

| # | Action | Recommended | The other choice |
| --- | --- | --- | --- |
| 1 | Complete a loan sale, complete an offset | Remove both actions and both recovery entries | Keep the entries as unused recovery hooks |
| 2 | Keeper-started sale listing | Remove: only the holder lists | Keep, with a floor price the holder sets on-chain |
| 3 | Keeper-started takeover at face value | Replace the key by a per-loan instruction anyone may run | Keep the named keeper |
| 4 | Keeper-started early close, handover, offset | Remove | Keep for the handover and offset only |
| 5 | Extension | Open to anyone, rate and term by rule | Keep the named keeper choosing inside the limits |
| 6 | Re-lending | Open to anyone on a slot setting | Keep the named keeper |
| 7 | Restricted slot fill, lock | Keep as they are | (none proposed) |

## 6. What changes

| Where | Change |
| --- | --- |
| The action constants and the approval setter | Six actions removed; the setter refuses them by name. The storage is fresh at the next deploy. |
| The authority library | The loan-keyed check and the per-loan switch go; the owner-keyed check stays for the two kept actions. |
| Sale, close-out and offset facets | The keeper branches and the two recovery entries removed; the listing and the three close-out entries (direct close, handover, offset) take the holder only. A repayment by anyone else goes through the ordinary repayment of #3779, never through the direct close. |
| Extension | The entry takes the loan id alone; rate and term by the rule of section 4; one preview returning both and why it would refuse. |
| Slots | The "lend again what comes back" setting; the roll and the re-commit read it and take any caller. |
| Takeover | The per-loan instruction, its setter and clearer; the executor takes any caller and reads it. |
| Ledger of open steps, keeper, public bot | Extension, roll, re-commit and takeover become open steps with keeper passes behind them, shipped disarmed; the public bot's "my positions" mode gains them. The platform keeper stops needing approvals for them. |
| App | The keeper approvals page shrinks to the two kept actions. Each automated step is set where its limits are set: the due-date card, the slot form, the loan page. |

## 7. Tests

1. An accept that completes a sale or an offset leaves nothing for a later completion; no state exists with the accept done and the completion not.
2. Listing, direct close, handover and offset refuse every caller but the holder; a third party repays the same loan through the ordinary repayment.
3. Extension by any caller: the loan's rate where it is inside both limits; the midpoint where it is not; refused with no range in common; the term cut to the earlier latest date; nothing the caller passes changes the outcome; the holder may still extend while the platform switch is off.
4. Roll and re-commit by any caller with the slot setting on; refused with it off; never for a position that was sold.
5. Takeover by any caller under the instruction: the holder receives the principal outstanding whichever slot takes it; refused before the earliest time and after the instruction is cleared.
6. The two kept actions behave as today.
7. A removed action cannot be approved.

## 8. Alternatives considered

1. **An owner mode in the public bot**, a key the wallet approves for its own actions. Rejected by the owner on 2026-11-19: it spreads keys that can choose terms.
2. **Keep every action and add limits to each key** (a floor price, a rate band per keeper). It keeps the leak and adds settings to bound it. Rejected for rule 1, which removes the key.
3. **Remove named keepers entirely.** Rejected: the restricted slot and the lock need a name.
4. **Leave the two "complete" entries as recovery hooks.** Harmless, but an entry with no reachable work is surface an audit must still read. Rejected, subject to test 1.
5. **Extension always at the loan's own rate, refused otherwise.** Simpler than a midpoint. It loses the extensions where both sides stated limits that no longer include the old rate, which is the case limits exist for. Offered to the owner as the narrower form of decision 5.

## 9. Recommendation

Adopt the principle of section 3 and the seven decisions of section 5 as recommended, built in the pre-audit refactor in one change, after the due-date plan's steps exist so the extension rule is written once.

## 10. Open items for the builder to raise, not decide silently

- Any caller of the six removed actions this review did not find (the aggregator adapters act as owners, not as keepers; confirm).
- Whether the service-capacity charge that a keeper action carries today has any meaning for an open step, or goes with the keys.
- Whether the midpoint rule for an extension needs the warning band's check on the new rate.
