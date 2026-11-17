# Referral share of the initiation fee: design

**Status:** owner approved the shape on 2026-11-17. Card #3722. Design for review before build.
**Count and inviter's page, 2026-11-17 (owner decision):** the referral runs for the first 50 loans, in place of 10, or 180 days, whichever comes first, and the inviter gets a page showing what their invitations have paid (section 6.1).
**Rates changed 2026-11-17 (owner decision):** the new user's cut and the inviter's share are each 10% of the above-floor part, in place of 20%, together with the higher fee levels of `FeeLevelsDesign.md`. The same day the owner decided against a value cap per new wallet and against identity checks (sections 5 and 9).
**Related:** `IntegratorFeeShareDesign.md` (#3682, #3720), `FeeLevelsDesign.md` (#3649), `ShortfallReserveDesign.md` (#3641, the treasury floor). This replaces the deferred referral half of `VpfiUsagePerksAndReferralDesign.md`, which paid in fee credits.

## 1. What is offered

Any user may invite a new user with a link that carries the inviter's wallet address. When the new user binds that inviter on-chain, then **for the first 50 loans or 180 days, whichever comes first**:

- the new user pays a lower loan initiation fee on the loans they open as borrower, and
- the inviter receives a part of the platform's initiation fee on those loans, paid straight to the inviter's wallet.

Both amounts come out of the fee the new user's own loan pays. Nothing is paid from a budget, so opening loans to collect the share always costs more than it returns.

Scope of the first version: the initiation fee only, and loans the new user opens as **borrower** only, for the reasons `IntegratorFeeShareDesign.md` section 2 gives.

## 2. How much, and from where

The initiation fee divides in a fixed order: the treasury keeps its floor (0.1% of principal) and the rest, the **above-floor part**, goes to the reserve after any matcher and integrator share. Referral amounts come only from the above-floor part. The floor is never touched.

Let **A** be the above-floor part of the fee after the borrower's hold discount.

- **The new user's cut** is 10% of A (less where the discount ceiling below binds). It is simply not charged.
- **The inviter's share** is 10% of A, paid from what is collected.
- Both rates are bounded settings behind the usual delay (each 0 to 30%). The rates in force when a loan opens apply; nothing is repriced later because nothing is paid later.
- **The existing ceiling on a party's fee discount holds for the two together.** A borrower's hold discount and referral cut can never take more than that ceiling (half) off the full fee. The cut is therefore the lesser of 10% of A and whatever allowance the hold discount has left; a borrower already at the ceiling gets no cut. The inviter's share is not affected by this: it stays 10% of A, subject to 2.1. Previews show the cut after this rule.
- A fee at or below the floor has no above-floor part, so there is no cut and no share.
- The added fee an extension pays carries neither.

Examples on 10,000 units of principal with no hold discount: a 30-day loan's fee is 20, of which 10 is above the floor; the new user pays 19 and the inviter receives 1. A one-year loan's fee is 100, of which 90 is above the floor; the new user pays 91 and the inviter receives 9.

### 2.1 Order and ceiling

Order of the above-floor part: the new user's cut (never collected), the matcher's share, the integrator's share, the inviter's share, the rest to the reserve.

This design relies on the fee split of #3649 and #3682, in which the matcher's share, like the integrator's, is taken from the above-floor part. On the code before that build the matcher's share is a rate of the whole fee and may be set as high as half of it; a referral must not be built on that base.

**The cut and the three shares together can never exceed a set part of A** (default 60%, a bounded setting, 40 to 70%). The fee host applies it as one rule on every loan: when the sum would exceed it, the inviter's share is reduced first, then the integrator's, then the matcher's, until it fits. It always can fit, because the new user's cut alone (at most 30% of A) is below the lowest ceiling (40%). The new user's cut is never reduced by this rule, so it does not depend on who else is named on the loan, and the preview a borrower sees is what they pay. The reserve therefore receives at least the remaining part of A on every loan, whatever is named on it and whatever the three rates are set to.

## 3. Binding the inviter

"The first time a wallet connects" happens in a browser and cannot be checked. The binding is on-chain:

- The new user binds an inviter by their own direct call, **once**. It cannot be changed, removed and re-added, or set by anyone else. There is no signed or relayed form.
- It is accepted only while the wallet has **never opened a loan as borrower**. A wallet that has borrowed before is not new.
- The 180 days run from the binding. The 50 loans are the first fifty loans the wallet opens as borrower after it, of any kind (accepted, matched, filled from an intent, instant, a refinance or a roll each count as one).
- Both limits are fixed for a wallet when it binds: the record keeps the end time and the loan limit in force that day, so a later change to either setting applies to new bindings only and never shortens what a bound user was told. The two rates are different: the rates in force when a loan opens apply (section 2).
- The inviter may be any address except the wallet itself and except an address on the integrator list (an integrator, its payout account or a contract it has declared). An inviter needs no vault and takes no step.
- The app reads the address from the link, shows it, and offers the binding inside the user's first borrow flow with one sentence (section 6). The user may decline; declining is not recorded on-chain and a wallet that has still never borrowed may bind later.

A view returns, for a wallet: its inviter, the loans left and the end time. Every borrow preview returns the cut as an amount.

## 4. Payment

- The inviter's share is paid when the fee is collected, in the lending asset, by the one fee host that already divides the fee, **directly to the inviter's wallet**. An inviter is an ordinary person who may hold no vault, and creating one inside someone else's loan would charge the borrower for it.
- **The payment can never fail the loan.** It is one isolated step that is allowed to fail alone. If it fails for any reason, or delivers less than was sent, that step is undone and the whole share goes to the reserve in the same transaction, with an event saying so.
- If the inviter is flagged by the sanctions list at that moment, the share goes to the reserve. The new user's cut is unaffected.
- Nothing is ever held for an inviter in the platform. There is no balance and no claim step.
- One event per loan states the loan, the new user, the inviter, the asset, the cut, the share, which of the wallet's counted loans this is, and where the share went: to the inviter's wallet, or to the reserve with the reason (the inviter was flagged, the payment failed, or the payment delivered short). A second event records a binding with the new user, the inviter, the end time and the loan limit fixed for that wallet. The inviter's page (section 6.1) shows nothing these two events do not state.

## 5. What a self-invitation costs, stated plainly

A person can invite their own second wallet. No on-chain rule can tell two wallets of one person apart, and the design does not pretend to.

- It can never be turned into a profit: the cut and the share together are part of a fee that person paid. At the default rates they are at most 20% of its above-floor part. At the highest rates the settings allow (30% each) they would be 60%, which is the default ceiling of 2.1, so no setting lets them pass the ceiling.
- It lasts fifty loans or 180 days per new wallet. At fifty the count rarely ends a referral before the 180 days do; it was raised from ten on 2026-11-17 so that an inviter keeps receiving through the whole period from an active user. A person who keeps making new wallets keeps a lower fee, at the price of moving their assets each time and of starting each wallet without its history, its hold discount tenure and its raised access (which waits its own delay, #3717).
- The worst case for the platform is bounded by section 2.1: on every loan the treasury still receives its whole floor and the reserve still receives at least the set part of the above-floor amount. A referral can slow the reserve's funding; it can never take from it or from the treasury.
- **The largest case, stated.** Nothing limits the size of a loan that carries the cut and the share. On a 1,000,000-unit one-year loan the fee is 10,000, of which 9,000 is above the floor, and a person who invited their own new wallet gets 1,800 of it back. The treasury still receives its 1,000 and the reserve at least 3,600 under the ceiling of 2.1 (7,200 when no matcher or integrator is named). The owner considered a cap on the value a new wallet's referral applies to and decided against it on 2026-11-17 (section 9).
- The two rates are settings and can be lowered to zero for new loans. Public counters (total cut, total share, loans counted, share redirected) show what the programme costs.

## 6. What a user is told

- In the invite flow, with the figures read from the chain at that moment: "You were invited by <address>. For your first 50 loans or 180 days, whichever comes first, the platform takes <cut rate> off the part of your loan fee above its base fee, and the person who invited you receives part of the platform's fee. On a <example loan> today that is <amount> off. You pay nothing extra. These rates are set by the platform and can change, including to zero; a loan whose fee is only the base fee gets nothing off. This choice cannot be changed later."
- When either rate is zero at that moment, the flow says so in place of the benefit ("Nothing is taken off at present") and still asks before binding.
- On each affected loan's review: the fee, the amount taken off for this loan (which may be zero), and loans and days left.
- To the inviter: "You may receive part of the platform's fee on loans your invited users open, for their first 50 loans or 180 days, whichever comes first, paid to your wallet when each loan opens. The amount depends on each loan's fee and on the platform's current rates. It can be reduced or zero, for example when a loan's fee is only the base fee or when other shares on the loan reach the limit."

The inviter's share is a referral share of the platform's fee for bringing a user. It is never described as earnings, income, yield or a share of revenue, it is not tied to holding anything, and no rate of return is stated. User-facing copy follows the rewards wording checklist before it ships.

### 6.1 The inviter's page

An inviter sees what their invitations have paid, on a page in the app that needs only their connected wallet (an inviter needs no vault). Card #3727.

- **The invite link**, with copy and share.
- **Invited wallets:** for each wallet that bound this inviter, the date it bound, the loans counted out of its limit, and the days left. A wallet whose period has ended is shown as ended.
- **Received:** each payment with its loan, asset, amount and transaction, and a total per asset. Amounts are stated in the asset they were paid in. No total across assets is shown as one figure.
- **Sent to the reserve instead:** each share that was not paid to the wallet, with the reason the event gives (the payment to the wallet failed or delivered short, or the wallet was flagged at that moment).

Rules:

- The page is built from the binding event and the per-loan share event, read through the indexer. Each wallet's loan limit and end time come from its binding event, and each redirect's reason from the share event (section 4), so the page never infers a limit from the current setting or a reason from anything else. It adds no contract state: a list of invited wallets per inviter kept on-chain would grow without bound. The page states the block its figures are current to, and says so when the indexer is behind.
- It counts on-chain bindings only. Link opens and visits are not tracked.
- It shows nothing about an invited user's loans beyond what the share event states.
- Amounts are "received". The page never calls them earnings, income, yield or a share of revenue, states no rate of return, and shows no forecast of future amounts. It repeats the inviter's sentence above, including that an amount can be reduced or zero.
- The new user's own status (their inviter, loans left, end time, amount taken off each loan) is on their loan reviews as above, read from the contract's view.

## 7. Contract changes

| Where | Change |
| --- | --- |
| A referral record per wallet | The inviter, the end time, the loan limit in force at the binding, the loans counted. One writer for the binding; the fee host moves the count. |
| A "has opened a loan as borrower" mark per wallet | Set at the first loan; read by the binding. |
| Treasury fee host | The cut and the inviter's share in the split, the ceiling of 2.1, the direct payment with its redirect. |
| Settings | The two rates, the count (default 50, bounded 1 to 100), the period (default 180 days) and the ceiling, each bounded, behind the usual delay. |
| Views and previews | The wallet's referral status; the cut as an amount in every borrow preview; the public counters. |
| Events | The binding, with the end time and the loan limit fixed for the wallet; the per-loan share event, with the loan's number in the wallet's count and the reason for a redirect; each with the inviter and the new user as indexed fields so the inviter's page can be read by inviter; the integrator id and the warnings mask of #3719 are unaffected. |

The accept facets are close to the size limit: everything is computed in the fee host, and the binding sits in its own small facet with the status view.

## 8. Tests

1. A bound wallet's loans one to fifty pay the cut and the inviter receives the share; the fifty-first pays the whole fee and the inviter nothing. The same at 180 days and one second. A change to the count or the period after a wallet has bound does not change that wallet's limits.
2. Each loan kind counts once: accept, match, intent fill, instant borrow, refinance, roll. An extension counts nothing and pays nothing.
3. The amounts: default rates; a hold discount; a fee at the floor; a rate of zero; both rates at their highest setting. The discount ceiling: a borrower with a hold discount near the ceiling gets only the allowance left, one at the ceiling gets no cut, and the inviter's share is unchanged in both.
4. The ceiling of 2.1 with a matcher, with an integrator, with both, and with each rate at its highest setting: the cut is unchanged, the inviter's share is reduced first, then the integrator's, then the matcher's, and the reserve receives at least its part in every case. The treasury's floor is identical with and without a referral.
5. Binding: once only; refused after the wallet's first loan as borrower; refused for itself and for an integrator's addresses; no one else can bind for a wallet.
6. A flagged inviter, a token that refuses the transfer, a short delivery: the loan opens, the reserve receives the share, the event names which of the three it was, the new user's cut is unchanged. The binding event carries the limit and end time the record stores, and after the count setting changes an earlier wallet's events still state its own limit.
7. Nothing is held: after every case the platform's balance of the lending asset is unchanged by the referral.
8. A rate change does not affect a loan already open. Previews agree with the transactions.

## 9. Alternatives considered

1. **2% of the fee after discount.** Safe, and too small to matter: 0.40 on a 10,000-unit, 30-day loan.
2. **A share for the inviter only.** Links that benefit both sides are the ones people pass on.
3. **Pay into the inviter's vault**, as the integrator share is. Needs a vault the inviter may not have.
4. **Hold the share for a later claim.** Keeps users' money in the platform, which the platform avoids.
5. **Fee credits to the inviter instead of the asset** (the earlier note). Less attractive to an inviter and needs a credit ledger.
6. **Share the interest fee too.** Larger amounts, but it touches every settlement path and takes more from the reserve. Later, if at all.
7. **Bind off-chain in the app.** Cannot be checked, and another front end could not honour it.
8. **A budget per period for the programme.** Bounds the cost another way, but adds a ledger and makes a user's fee depend on what others did that month. The ceiling of 2.1 bounds it per loan instead.
9. **No referral until after launch.** Costs nothing. The build is small because it reuses the fee host's integrator split.
10. **A cap on the value the referral applies to** (for example the first 25,000 units a new wallet borrows). It would make cycling wallets on large loans not worth doing. The owner decided against it on 2026-11-17: the amounts are part of a fee the same person paid, and the ceiling of 2.1 already bounds what the reserve gives up on each loan.
11. **An identity check on the inviter and the new user** (a phone number, a messaging account, an address funded from an exchange). Rejected. A contract cannot check any of them, so the platform would have to sign an approval per wallet and hold personal data, which no other front end could honour and which the platform's permissionless stance excludes. A throwaway number or account costs very little, so the check stops few; an exchange's withdrawals come from shared wallets so they identify no customer, and one exchange account can fund any number of wallets.
12. **Ten loans in place of fifty** (the first count). Replaced on 2026-11-17: an active user could pass ten loans within weeks and end the inviter's share early. **The 180 days alone, with no count**, is simpler to say and nearly the same in effect; the count is kept as a second bound that is a setting.
13. **Keep the inviter's figures on-chain** (a list of invited wallets and totals per inviter). Not chosen: the list grows without bound, and the events already carry everything the page shows.

## 10. Recommendation

The design above: a matching 10% of the above-floor part to each side, for the first 50 loans or 180 days, whichever comes first, bound once on-chain before the wallet's first loan, the inviter paid directly to their wallet, with the per-loan ceiling protecting the reserve.

## 11. Open items for the builder to raise, not decide silently

- Whether a mark for "has opened a loan as borrower" already exists per wallet or must be added.
- The exact place in the fee host where the isolated wallet payment sits beside the integrator's vault delivery, so both redirect by one rule.
- At which settings of the three rates the ceiling starts to reduce the matcher's share, with figures, so the matcher's bounds can be set to make that rare.
