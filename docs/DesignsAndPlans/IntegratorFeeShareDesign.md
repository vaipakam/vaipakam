# Fee share for integrators — design

**Status:** owner approved the feature on 2026-11-15, before the feature freeze. Card #3682. Design for review before build.
**Related:** `FeeLevelsDesign.md` (#3649), `ShortfallReserveDesign.md` (#3641, the treasury floor), the matcher's share of the initiation fee, `VaultOutflowPolicyDesign.md`.

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

- The share is a percentage of the above-floor amount actually collected. Default 20%; hard ceiling 50%, in code. Both the default and a per-integrator rate are bounded settings behind the Timelock delay.
- A fee discount reduces the above-floor part first, so it reduces the integrator's share with it. A fee collected at or below the floor pays the integrator nothing.
- The added fee an extension pays carries no integrator share. It goes to the reserve whole, as designed.
- Examples at the default rate on 10,000 units of principal: a 30-day loan pays a fee of 20, of which 10 is above the floor, so the integrator receives 2. A one-year loan pays 50, of which 40 is above the floor, so the integrator receives 8.

The rate in force when the loan opens applies. Nothing is repriced later, because nothing is paid later.

## 4. Who is an integrator

**Registered addresses only.** Governance adds an integrator to an on-chain list with its payout account and its rate; adding or changing an entry waits the Timelock delay, and removing one is immediate.

An open scheme, in which any address may be named, was rejected: a borrower would name themselves and turn the share into a discount for everyone, paid out of the reserve.

A registered integrator that is later flagged by the sanctions list is paid nothing (section 6).

## 5. How the integrator is named

The borrower's own action names it:

- **Direct accept by a borrower:** the accept call carries the integrator.
- **A borrower's offer or request, filled later by a match or an accept:** the offer carries the integrator from creation, and the fill credits it. A matcher or an accepting lender cannot set or change it.
- **A lender's action never names an integrator.** A loan whose borrower side named none pays none.

The field is optional everywhere. An unknown or removed integrator is not an error: the loan opens and the share stays with the reserve, so a stale tag can never block a borrower.

A refinance and a roll open new loans with their own fee, and are credited by the same rule from the borrower's new offer.

## 6. Payment

- The share is paid when the fee is collected, in the lending asset, by the one fee host that already divides the fee. Order: the treasury floor, the matcher's share as today, the integrator's share, the rest to the reserve.
- It is delivered into the **integrator's own vault** on the platform, not pushed to an outside address. The integrator withdraws through the ordinary vault payout, which carries the sanctions gate and the outflow policy.
- **The delivery can never fail the loan.** The vault's own code cannot refuse a transfer, but the token can: an issuer may block the vault's address. So the delivery is one isolated step that is allowed to fail alone. If it fails for any reason, or delivers less than was sent, that step is undone and the whole share goes to the reserve in the same transaction, with an event naming the integrator, the amount and that it was redirected. The loan opens either way.
- If the integrator is flagged at the moment of payment, the share goes to the reserve.
- One event states the loan, the integrator, the asset and the amount. The loan-opened review in the app and the public analytics show it.

Nothing is held for an integrator in the Diamond at any time.

## 7. Disclosure

Where an integrator is named, the borrower's review states: "Part of the platform's fee on this loan goes to <integrator>. You pay nothing extra." The integrator list, the rates and every payment are public on-chain.

This is a payment to a business for bringing a user. It is not offered to users as an earning, it is not a share of platform revenue for holders of anything, and it must not be described either way in user-facing copy.

## 8. Contract changes

| Where | Change |
| --- | --- |
| Integrator list | Address, payout account, rate; the default rate and the ceiling. Timelocked adds and changes, immediate removal. |
| Offer record and creation | An optional integrator on a borrower's offer. |
| Accept and match entries | An optional integrator on the borrower's direct accept; a fill reads the borrower offer's. |
| Treasury fee host | The integrator's share in the split of the initiation fee, after the floor. |
| Views and previews | The integrator's share as an amount for a given loan; the list. |
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

- The exact base of the matcher's share next to the integrator's, so the two together can never exceed the above-floor amount.
- Whether the registration should also carry a display name on-chain or leave names to the app's list.
