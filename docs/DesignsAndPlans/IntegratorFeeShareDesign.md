# Fee share for integrators — design

**Status:** owner approved the feature on 2026-11-15, before the feature freeze. Card #3682. Design for review before build.
**Related:** `FeeLevelsDesign.md` (#3649), `ShortfallReserveDesign.md` (#3641, the treasury floor), `ReferralFeeShareDesign.md` (#3722, the order and the per-loan ceiling), the matcher's share of the initiation fee, `VaultOutflowPolicyDesign.md`.
**Rate changed 2026-11-17 (owner decision):** the default share is 10% of the above-floor amount, in place of 20%, together with the higher fee levels of `FeeLevelsDesign.md`.
**Reviewed 2026-11-17:** the additions of #3720 (suspension, declared contracts, public record, a list anyone can check) are in sections 4, 6 and 7; the order of the split and the ceiling follow `ReferralFeeShareDesign.md` 2.1; the matcher's base is settled (section 12).

## 1. Why

Most users of on-chain lending do not arrive at a platform's own app. They arrive through a wallet, a portfolio tool or another front end that offers lending inside it. Those front ends choose where to send their users, and the common arrangement is that the venue passes them part of its own fee. The user pays nothing extra.

Scouting the code on 2026-11-15 found no such route. The only third party paid from a fee is the matcher, who receives a small part of the initiation fee for submitting a match. The accept and match entries carry no field naming who brought the user.

## 2. What is offered

A front end that the platform has registered as an **integrator** may be named when a borrower opens a loan through it. When that loan opens, the integrator receives a bounded part of the platform's loan initiation fee. The borrower's fee is the same with or without an integrator.

Scope of the first version:

- **The initiation fee only.** It is paid once, by the borrower, at acceptance, so the share is one payment at one moment. The treasury's share of interest is not shared: it is collected on every settlement path over the life of a loan, and sharing it would touch all of them.
- **The borrower's side only.** The borrower pays the initiation fee, so the integrator credited is the one the borrower came through.

## 3. How much, and from where

The initiation fee already divides in a fixed order: the treasury keeps its floor (0.1% of principal), and the rest goes to the reserve (`ShortfallReserveDesign.md` section 8). The integrator's share comes out of **the part above the treasury floor**, never out of the floor.

- The share is a percentage of the above-floor amount actually collected. Default 10% (owner decision 2026-11-17; 20% before the fee levels were raised); hard ceiling 50%, in code. Both the default and a per-integrator rate are bounded settings behind the Timelock delay.
- A fee discount reduces the above-floor part first, so it reduces the integrator's share with it. A fee collected at or below the floor pays the integrator nothing.
- The added fee an extension pays carries no integrator share. It goes to the reserve whole, as designed.
- Examples at the default rate on 10,000 units of principal: a 30-day loan pays a fee of 20, of which 10 is above the floor, so the integrator receives 1. A one-year loan pays 100, of which 90 is above the floor, so the integrator receives 9. Because the fee is larger, 10% of it pays an integrator about what 20% of the earlier fee did on a one-year loan, and less on a short one. A per-integrator rate above the default remains possible up to the ceiling.

The rate in force when the loan opens applies. Nothing is repriced later, because nothing is paid later.

## 4. Who is an integrator

**Registered addresses only.** Governance adds an integrator to an on-chain list with its payout account and its rate; adding or changing an entry waits the Timelock delay, and removing one is immediate.

An open scheme, in which any address may be named, was rejected: a borrower would name themselves and turn the share into a discount for everyone, paid out of the reserve.

A registered integrator that is later flagged by the sanctions list is paid nothing (section 6).

Added with #3720 (owner approved 2026-11-17):

- **Suspension.** The guardian may suspend an integrator at once, without waiting for the delay. A suspended integrator is paid nothing; restoring it waits the delay. Removal stays a governance step. An integrator's status never blocks a user: the loan opens and the share goes to the reserve.
- **Declared contracts.** An integrator declares the contracts it operates. The share is not paid on a loan whose borrower is the integrator, its payout account or one of those contracts, so an integrator earns nothing by standing between a user and the platform. Its terms forbid holding users' vaults or positions.
- **Not an inviter.** None of an integrator's addresses may be bound as a referral inviter (`ReferralFeeShareDesign.md` section 3).
- **What "registered" means.** It earns a share and has accepted the terms. It is never described as approved, verified or safe, on-chain or in copy.
- **A display name on-chain (settled 2026-11-17).** Each entry carries a short name, set and changed only by the same delayed step as the entry, with an event stating the old and the new name. A name is 1 to 32 printable ASCII characters, and no two entries may carry the same name at once, compared without regard to letter case. The integrator cannot change it. The list anyone can check then says who each entry is without the platform's app. A name is not a verification, and a suspended entry keeps its name and shows as suspended.

## 5. How the integrator is named

The borrower's own action names it:

- **Direct accept by a borrower:** the accept call carries the integrator.
- **A borrower's offer or request, filled later by a match or an accept:** the offer carries the integrator from creation, and the fill credits it. A matcher or an accepting lender cannot set or change it.
- **A lender's action never names an integrator.** A loan whose borrower side named none pays none.

The field is optional everywhere. An unknown or removed integrator is not an error: the loan opens and the share stays with the reserve, so a stale tag can never block a borrower.

A refinance and a roll open new loans with their own fee, and are credited by the same rule from the borrower's new offer.

## 6. Payment

- The share is paid when the fee is collected, in the lending asset, by the one fee host that already divides the fee. The treasury keeps its floor first. Order of the above-floor part: a new user's referral cut (never collected), the matcher's share, the integrator's share, the inviter's share, the rest to the reserve. One per-loan ceiling (default 60% of the above-floor part) bounds the cut and the three shares together; when it binds, the inviter's share is reduced first, then the integrator's, then the matcher's (`ReferralFeeShareDesign.md` 2.1).
- It is delivered into the **integrator's own vault** on the platform, not pushed to an outside address. The integrator withdraws through the ordinary vault payout, which carries the sanctions gate and the outflow policy.
- **The delivery can never fail the loan.** The vault's own code cannot refuse a transfer, but the token can: an issuer may block the vault's address. So the delivery is one isolated step that is allowed to fail alone. If it fails for any reason, or delivers less than was sent, that step is undone and the whole share goes to the reserve in the same transaction, with an event naming the integrator, the amount and that it was redirected. The loan opens either way.
- If the integrator is flagged or suspended at the moment of payment, or the borrower is one of its declared addresses, the share goes to the reserve.
- One event states the loan, the integrator, the asset and the amount. The loan-opened review in the app and the public analytics show it.

Nothing is held for an integrator in the Diamond at any time.

## 7. Disclosure

Where an integrator is named, the borrower's review states: "Part of the platform's fee on this loan goes to <integrator>. You pay nothing extra." The integrator list, the rates and every payment are public on-chain.

This is a payment to a business for bringing a user. It is not offered to users as an earning, it is not a share of platform revenue for holders of anything, and it must not be described either way in user-facing copy.

Added with #3720 and #3719:

- **A public record per integrator**, kept as counters: loans brought, loans opened with a warning in the loan's warnings mask, and loans defaulted or liquidated within 7 days of opening.
- **A list anyone can check.** One view returns the platform's contracts on the chain and the registered integrators with their status, so a user or a wallet can check whether a site is registered and whether a contract is the platform's.
- **A better standing offer, checked in previews (settled 2026-11-17).** A borrow preview accepts one standing offer that the caller points to (a front end finds it through the indexer). The platform checks that offer itself: the same lending asset and collateral asset, a term that fits, open amount for the borrower's amount, and that this borrower could take it now under the same refusal checks an acceptance runs. It returns the offer, its rate, the amount it covers and whether it beats the quoted terms. So any front end can show "a better standing offer exists" without trusting the platform's indexer for the figure. The preview speaks only for the offer it checked: it never says an offer is the best on the book, and when no offer is pointed to it answers "not checked", never "none better". Nothing that writes reads it.
- **The integrator is named in events.** The loan-opened details, offer-created details, offer-modified and intent-set events state the integrator id, so the platform's own alert can name the door the user came through. On a lender's action the id is attribution only and earns no share; section 5 is unchanged.

## 8. Contract changes

| Where | Change |
| --- | --- |
| Integrator list | Address, display name, payout account, rate, status and declared contracts; the default rate and the ceiling. Timelocked adds, changes and removal; suspension by the guardian at once (the immediate stop), with a delayed restore. Counters per integrator. |
| Offer record and creation | An optional integrator on a borrower's offer. |
| Accept and match entries | An optional integrator on the borrower's direct accept; a fill reads the borrower offer's. |
| Treasury fee host | The integrator's share in the split of the initiation fee, after the floor, in the order and under the ceiling of section 6. |
| Views and previews | The integrator's share as an amount for a given loan; the list with status and the platform's contracts; the check of one standing offer in a borrow preview. |
| Signed offers | The integrator is part of what the borrower signs. |

The accept facets are close to the size limit; the share is computed in the fee host, and the accept path only passes the address through.

## 9. Tests

1. With and without an integrator the borrower pays the same fee; the treasury receives the same floor.
2. The share at the default rate, a per-integrator rate, the ceiling; a discounted fee; a fee at the floor.
3. Naming: direct accept, a borrower offer filled by accept and by a match, an Auto-lend fill; a lender-side or matcher-supplied tag is ignored.
4. An unregistered, removed or flagged integrator: the loan opens and the share goes to the reserve. The same when the token refuses the transfer to the integrator's vault or delivers short: the loan opens, the reserve receives the share, the event says so.
5. An extension pays no integrator share.
6. The payment lands in the integrator's vault and leaves only through the ordinary payout.
7. A rate change does not affect a loan already open.
8. A suspended integrator: the loan opens and the share goes to the reserve; restoring waits the delay. A borrower that is the integrator, its payout account or a declared contract earns it nothing.
9. With a matcher and an inviter on the same loan the ceiling holds and the reductions run in the stated order; the reserve receives at least its part.
10. The counters move once per loan; the list view returns status and contracts.

## 10. Alternatives considered

1. **No integrator share.** Costs nothing, and leaves front ends no reason to list the platform beside venues that pay them.
2. **Let the integrator add its own fee on top.** The user pays more through an integrator than directly, and every review would have to show a third party's charge. Rejected: the borrower's cost must not depend on the door they came through.
3. **Share the interest fee as well.** A longer-lived incentive, but it touches every settlement path and needs the integrator stored on the loan for its whole life. Left for after the audit, if integrators ask for it.
4. **Open to any address.** Becomes a self-rebate. Rejected.
5. **Pay from the treasury floor.** Rejected: the floor is what operations need.
6. **Credit the lender's side too.** Two integrators per loan and a second split. Left for later with alternative 3.

## 11. Recommendation

Registered integrators, named by the borrower's own action, paid a bounded part of the initiation fee above the treasury floor, into their own vault, at the moment the fee is collected.

## 12. Open items for the builder to raise, not decide silently

- Settled 2026-11-17: the matcher's share, like the integrator's, is a part of the above-floor amount, and the per-loan ceiling bounds them together with the referral amounts (section 6).
- Settled 2026-11-17: the registration carries a display name on-chain (section 4). Names kept only in the app's list would leave another front end and the platform's alert unable to name an entry, and a name the integrator sets itself invites impersonation.
- Settled 2026-11-17: a preview checks one standing offer the caller points to (section 7). Not chosen: a sorted index per pair and term, which is exact but slows every write to the book and adds code to facets near the size limit; a stored best rate per pair and term, which goes stale on a cancel or a fill unless rebuilt, which is the index again; a scan of the open list up to a fixed count, which is wrong without saying so once the book is longer than the count.

## 13. Build notes (#3682 with #3719 and #3720)

What was built, and where it differs from the text above. Each difference is stated for the design thread to accept or send back.

- **The list.** One new facet, `IntegratorFacet`, holds the list: the id, a payout account, a rate (0 means the default, 10%; at most 50%), a display name of 1 to 32 printable characters that is unique without regard to letter case, a status, the declared contracts, and three counters. An address may belong to one integrator only (its id, its payout account or a declared contract). Adding, changing and removing an entry, restoring a suspended one and setting the default rate are administrator steps, so they wait the administrator's delay. The guardian suspends at once.
  - Removal waits the delay; the immediate stop is the guardian's suspension, which keeps the entry's name and record (accepted by the design thread 2026-11-18; section 8 updated).
- **The ceiling.** A per-loan ceiling over the matcher's, the integrator's and (from #3722) the inviter's shares: default 60% of the part above the treasury floor, settable from 40% to 70%. The matcher's share is filled first, then the integrator's, then the inviter's, so the inviter is reduced first and the matcher last, as section 6 states.
- **Naming.** A borrower's offer carries an optional integrator, and so do the borrower's signed accept terms and a signed offer. A fill, a match and an Auto-lend fill all accept the borrower's offer, so they read that offer's integrator. A lender's offer may carry one for attribution, which earns nothing; a matcher has no field to name one.
- **Payment.** The fee host already divides the initiation fee at the floor. The accept step now sizes the matcher's and the integrator's shares from the part above the floor, under the ceiling, and delivers the integrator's share from the lender's vault into the payout account's vault (a new vault outflow class with its own reason code), as one isolated step. If that step fails or delivers short, it is undone and the share stays in the treasury leg, above the floor, so it is the reserve's. One event, `IntegratorShareSettled`, states the loan, the offer, the integrator, the asset, the amount, whether it was delivered, and why an integrator was not paid.
  - The fee is charged before the loan is written, so the event names the id the loan is about to take (the next loan id). The loan's creation refuses to open under any other id while an integrator is pending, so on every route (accept, match, refinance, Auto-lend fill) the event joins exactly one loan without relying on log order (design thread ruling 2026-11-18: an offer can fill more than once). Tests pin it on a direct accept, a lender's accept of a borrower offer and a match; the refinance and Auto-lend routes reach the same charge and the same creation check.
- **Counters.** Loans brought counts every loan a registered integrator was named on, paid or not. Loans defaulted or liquidated within 7 days of opening is raised when such a loan ends that way.
  - *Not yet moving:* loans opened with a warning stays 0 until the loan warnings mask (#3685, carried in the loan-opened event per #3719) exists; the counter is there so the record's shape does not change when it does. **Merge note:** a test fails as soon as the loan-opened event carries a `warnings` field, so the change that adds the mask must connect this counter and replace that test with one that opens a warned loan and sees the counter move.
- **The list anyone can check.** `getIntegrators` returns every entry with its status, rate, record and declared contracts; `getPlatformContracts` returns the Diamond, the vault beacon, the position NFT and the protocol registry; `integratorRateFor(integrator, borrower)` returns the rate that would be paid now, or 0 with the reason.
- **Events.** The integrator is named in `OfferCreatedDetails`, `OfferModified`, `LoanInitiatedDetails` and `IntegratorShareSettled`.
  - The lender intent's setter was left unchanged. A companion entry, `nameLenderIntentIntegrator(owner, …)`, called in the same batch, emits `LenderIntentIntegratorNamed` for an active intent. Accepted by the design thread on three conditions, all built: only the intent's owner or the account's current manager may call it; the integrator must be registered, or zero to clear; and it stays attribution only, changing no rate, amount or recipient.
- **Not built in this step:** the standing-offer check in borrow previews (section 7). The preview facet has about 225 bytes of room, so the check goes in its own facet as the next step.
