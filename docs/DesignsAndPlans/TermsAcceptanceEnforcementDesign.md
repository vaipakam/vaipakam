# Terms of Service acceptance enforced by the contracts (#3734)

Status: **design, decided by the owner** (2026-11-18). Not built. Fresh
deploy, no migration. Choices the decisions left open are marked **Default**.

"Terms" in this document always means the Terms of Service, never the terms
of a loan.

## 1. The problem

The platform records which version of the Terms a wallet accepted and when.
Nothing reads that record. The gate is in the app only: a wallet that uses
another website, or calls the contracts directly, can post an offer and open
a loan without ever accepting. The
[gate matrix](SanctionsAndTermsGateMatrix.md) states this as "no protocol
backstop".

The app also asks for the acceptance late, at the first action that commits
money. So a wallet is connected, browses and is treated as a user before it
has agreed to anything.

## 2. The decisions

| Date | Decision (owner) |
| --- | --- |
| 2026-11-18 | The contracts refuse a new position for a wallet that has not accepted the Terms in force. |
| 2026-11-18 | The app takes the acceptance at Connect. Connecting a wallet means agreeing to the Terms, and a wallet that has not accepted is not connected to the app, not even to browse it. |
| 2026-11-18 | **The acceptance is the wallet's own paid transaction, sent right after it connects.** There is no free signature, and nobody else may record an acceptance for a wallet: not the keeper, not a counterparty, not a relayer. A paid step also keeps throwaway wallets out, and a record that someone else submitted could be questioned. |
| 2026-11-18 | **A wallet accepts on each network by its own transaction there.** An acceptance is not carried from one network to another by a cross-chain message. |
| 2026-11-18 | A new version is announced with a notice period. After it, a wallet that has not accepted takes on no new position; its commitments wait and are not cancelled (section 5). |

## 3. The rule

**A wallet that takes on a new position must have accepted the Terms in
force. A wallet that only reduces or leaves a position is never asked.**

This is the rule the app already follows (functional spec, "Terms of Service
acceptance"). The change is that the contracts hold it, so it is true for
every website and every direct caller.

While no Terms version is in force, the rule checks nothing, as today.

### 3.1 Where it is checked

One rule, in one place, read from four kinds of step.

| Step | Who must be current | Why here |
| --- | --- | --- |
| **Opening a loan**, by any route: a direct accept, a match, a signed-offer fill, an Auto-lend fill, an instant-market borrow, a refinance, a rental, a roll that opens a new loan | The two wallets the new loan records as lender and borrower. Where the record exists only to carry the sale of an existing loan, the seller is not checked and the buyer is (see below) | The one step every loan passes through. This is the rule; the rows below only refuse earlier. |
| **Starting a new term on an existing loan in place**: an extension that resets the loan's start and term without opening a new loan | The wallets that hold the lender and the borrower position at that moment | It does not pass through the loan-opening step, so it asks the rule itself. A refused extension changes nothing: the loan runs to its agreed end. |
| **Taking over a position** through the platform: buying a loan, or replacing a borrower | The wallet coming in | It takes on the position. The wallet going out is not checked (3.2). |
| **Posting a standing commitment that would give the poster a new position**: a lending, borrowing or rental offer, an offer to buy a loan, an offer that offsets a loan with a new one, setting or funding Auto-lend, setting a standing instruction | The wallet posting | So the book never holds a commitment that cannot be filled. |

The previews that the app and the keeper read before sending (accept, match,
Auto-lend fill, sale) ask the same rule and name the wallet that is not
current, so a refusal is known before a transaction is sent.

**A sale that passes through the loan-opening step.** When a buyer fills a
lender's sale listing, the platform opens a short-lived loan record that
names the seller as one of its parties and then completes the sale. That
record is not a new position for the seller. The shared check recognises it
and checks only the incoming buyer, so the exit that section 3.2 protects is
open at every step of the route, not only at posting.

**No new term without the rule.** A loan's start and term are written only
by a step in the table above. The build adds a check, beside the existing one
for a loan's principal and rate, that fails when any other code writes them,
so a later entry cannot start a term without asking the rule.

A refused fill does not cancel anything. The offer or the Auto-lend setting
stays as it is and fills again once its owner has accepted.

### 3.2 What is never checked

- Repaying, closing early, adding collateral, claiming, withdrawing one's own
  assets, cancelling one's own offers and orders, withdrawing Auto-lend
  capital, switching Auto-lend or a standing instruction off, and withdrawing
  a keeper's or a fee consent's authority.
- The wallet that **leaves** a position in one step: a lender being bought
  out, a borrower whose obligation moves to a replacement.
- **Listing one's own loan, or one's own collateral, for sale.** The listing
  only ends the lister's position, and the buyer is the one checked when it
  fills, so the seller's standing can never make it unfillable. Without this
  a lender who declines a new version could leave only if a buyer's offer
  happened to be standing. An offer that offsets a loan by opening a new one
  is different: its poster becomes a party to a new loan, so it is checked.
- Defaults, liquidations and every other step a third party or the keeper
  takes to settle a loan. A loan always settles, whatever its parties have or
  have not accepted.
- Third parties who are not a party to the loan: the matcher, the liquidator,
  the keeper. **Default.**
- Opening a vault, depositing into it and account-safety settings.
  **Default.** No rule here may stand between a wallet and its own funds or
  its own protection; the commitment the Terms govern is the position. A
  deposit binds the wallet to nobody, and a wallet whose acceptance went
  stale may need to fund its vault to repay or to add collateral, so the
  contracts must not refuse it. The app is stricter and may be (section 7):
  it offers a free-standing deposit only to a wallet that is current.
- Receiving a position token by a plain transfer. The holder can claim and
  close; it cannot sell or hand over through the platform into a wallet that
  is not current.
- The platform's own backstop vault, identified by the registry pointer and
  never by a list. It is the platform, not a user.

### 3.3 Whose acceptance

An acceptance belongs to one wallet address on one network. It does not move
with a position token, a replacement of a protected account, or any authority
given to a keeper or an integrator. A contract that takes positions for
others accepts for itself.

## 4. Accepting

**A wallet accepts by its own transaction and in no other way.** The
transaction names the version and the fingerprint of the exact text, and the
contracts refuse it unless that pair is the version in force or the announced
one. The sender is the wallet that accepts. There is no route by which a
signature, a keeper, a manager, an integrator or a counterparty records an
acceptance for another address.

- A contract wallet sends the same transaction itself.
- The record is kept per version. Accepting an announced version never
  replaces the acceptance of the version in force.
- During a notice period (section 5) one transaction may name both the
  version in force and the announced one, so a wallet that joins then pays
  once.
- Accepting a version twice changes nothing: the first acceptance time is
  kept.
- One acceptance per network. Each network has its own record, and the wallet
  pays that network's fee once per version.
- Accepting stays possible while the platform is paused.
- A wallet may send its acceptance and another of its own actions as one
  transaction through the platform's batch entry. It is still the wallet's
  own transaction; this only serves callers that do not use the app.

There is nothing to revoke. A wallet that no longer agrees closes its
positions, which section 3.2 always allows.

## 5. A new version of the Terms

A new version is **announced** with the time it comes into force.

- From the announcement, a wallet may accept the new version, by its own
  transaction like any acceptance (section 4).
- Until it comes into force, the version in force is the only one that makes
  a wallet current. A position opened during the notice is opened under the
  Terms in force that day, so its parties must have accepted those.
- Accepting the announced version early does not make a wallet current by
  itself. It is what keeps the wallet current, with no gap, from the moment
  the new version comes into force.
- A wallet that joins during the notice accepts both versions, in one
  transaction.
- From then on, only the new version counts. A wallet that has not accepted
  it takes on no new position: its offers and its Auto-lend stop filling, and
  an extension or a roll does not start a new term, so the loan runs to its
  agreed end. Its open loans are not touched.
- The notice is at least 7 days, and 14 by **Default**. The first version on
  a network needs no notice.
- An announcement can be withdrawn before it comes into force. The version
  number is then spent and never reused. A withdrawal changes no wallet's
  standing, because an acceptance of the announced version never counted on
  its own before the in-force time.

The announcement and the time are an event. Every alert channel carries it to
wallets with an open offer, Auto-lend or a standing instruction, with the
date their commitments stop filling.

## 6. What follows from a paid, own-wallet acceptance

- **Cost.** One small transaction per wallet, per network, per version, paid
  by the wallet as a network fee. The platform charges nothing for it.
- **A maker of signed offers** must accept by its own transaction too, before
  its signed offers can be filled or shown as fillable. Signing offers stays
  free; taking a position on the platform does not start without the paid
  acceptance.
- **After a new version**, the owner of an offer, Auto-lend or a standing
  instruction sends a new acceptance to keep it filling. The notice period
  and the alerts of section 5 are what give time for that.
- **The keeper records nothing.** Its fill passes read the preview and skip,
  with the reason, a fill that the rule refuses. It carries the
  announcement's alert to affected wallets and does no more.
- **No off-chain record.** The on-chain record is the only one. The platform
  keeps no store of acceptances or signatures.

## 7. App

- **Connect.** Clicking Connect shows the Terms first: the version, the
  fingerprint, the link pinned to that version, the privacy policy and the
  key risks, and a plain statement that connecting a wallet means agreeing to
  these Terms and that the agreement is recorded on-chain by a transaction
  the wallet pays for. The wallet list opens from there.
- **The transaction, at once.** As soon as the wallet is chosen, the app asks
  it to send the acceptance on the network it is on. The request says what
  the transaction records and that its only cost is the network fee. A wallet
  with no balance for the fee is told so, with the amount it needs.
- **Not accepted means not connected.** Until the acceptance is recorded, the
  connected app is not shown, browsing included. If the wallet rejects the
  transaction or it fails, the app drops the connection. What a wallet that
  has not accepted keeps is every action of section 3.2, and only those:
  repaying and closing, adding collateral, claiming, withdrawing, listing its
  own loan or collateral for sale, cancelling its own offers and signed
  orders, and withdrawing a keeper's or a fee consent's authority. The app
  does not test for a position or a balance first, because a wallet with
  neither can still hold a signed order or a permission it needs to withdraw.
  For a wallet with nothing to wind down those surfaces are empty, and the
  app says that accepting is what opens the rest.
- **Deposits.** A free-standing deposit is not a wind-down action, so the app
  offers it only to a wallet that is current, as it does today. Funding that
  a wind-down action needs (the amount of a repayment, the collateral being
  added) is part of that action and stays open. The contracts do not check a
  deposit (section 3.2); the app's stricter rule is a choice of what to
  offer, not a second gate on funds.
- **Where a wallet stands** is stated and never guessed: not accepted; sent
  and waiting for confirmation; or recorded, with the transaction. While the
  record cannot be read the app stays closed and offers a retry, as today.
- **A new version.** From the announcement the app asks again at Connect,
  shows the date, and says what stops on that date if the wallet does not
  accept. For a wallet that is current on the version in force this request
  can be put off: declining it, or rejecting its transaction, leaves the
  wallet connected with everything open until that date. Only the version in
  force is required to be connected. A wallet connecting for the first time
  during the notice is shown both versions and accepts both in the one
  transaction.
- **Another network.** The first time a wallet uses another network the app
  asks for the acceptance there, before anything else on that network.
- **The book.** The book applies the rule of section 3 and nothing wider. A
  commitment that would give its maker a new position (a lending, borrowing
  or rental offer, an offer to buy a loan, an offset offer) is shown as not
  fillable now, with the reason, or left out of the fillable list, while its
  maker is not current. A signed offer of that kind is not shown in the
  shared book as fillable until its maker has accepted on-chain. A listing
  that sells the lister's own loan or collateral is never marked by its
  maker's standing (section 3.2): it stays fillable, and the app checks the
  wallet that would buy. Nothing is offered as an action that would fail.

## 8. Events and the record

- An acceptance emits the wallet, the version, the fingerprint and the time.
- An announcement, its withdrawal and a version coming into force each emit
  an event with the version, the fingerprint and the time.
- The refusal names the wallet and the version it needs.

## 9. Tests (acceptance)

1. With a version in force, no route opens a loan while either party is not
   current: direct accept, match, signed-offer fill, Auto-lend fill, instant
   market, refinance, rental, loan sale, borrower replacement and roll. Each
   is driven end to end, not only at the shared step. An extension in place
   is refused through its own entry while either holder is not current, and
   the loan's start and term are unchanged.
2. Every step of 3.2 succeeds for a wallet that never accepted, and for one
   whose acceptance went stale while it had an open loan.
3. No entry records an acceptance for an address other than the sender. A
   keeper, a manager with full authority over an account and a counterparty
   each try and are refused or have no route.
4. An acceptance sent twice leaves the first acceptance time unchanged. One
   naming another version or another fingerprint is refused.
5. During the notice a wallet that accepted the version in force is current,
   and one that accepted only the announced version is refused. One second
   after the new version comes into force, a wallet on the old one is refused
   and its offer is still on the book; it accepts and the same offer fills.
6. A notice shorter than the floor is refused. A withdrawn version number
   cannot be announced again.
7. A maker who has not accepted has a signed offer refused at fill. It
   accepts by its own transaction and the same signed offer fills.
8. A contract wallet accepts by its own call and opens a loan.
9. With no version in force, nothing is checked.
10. A loan whose parties are both stale is repaid, defaulted and liquidated
    normally.
11. A wallet current on the version in force accepts the announced one during
    the notice. Its offer fills one second after the new version comes into
    force. A wallet that joins during the notice accepts both in one
    transaction and is current before and after that time. If the
    announcement is withdrawn instead, both wallets are still current, and no
    wallet's standing changes at the withdrawal.
12. A wallet that has not accepted, with no position and no balance, cancels
    its own signed order and withdraws a keeper's authority through the app,
    and reaches nothing else.
13. A lender whose acceptance is stale lists its loan for sale, the book
    shows the listing as fillable, and a buyer who is current fills it. The
    fill is driven end to end through the listing route, including the
    short-lived loan record that names the seller, and the direct sale into a
    buyer's standing offer. A buyer who is not current is refused on both.
    The same lender's offset offer is refused.
14. The keeper's fill passes send nothing for a fill the preview refuses for
    the Terms, and the keeper sends no acceptance for any wallet.
15. In the app, a wallet that rejects the acceptance transaction is not
    connected; one that sends it reaches the app only after the record is
    read back from the chain. During a notice, a wallet current on the
    version in force declines the announced one and stays connected, and is
    closed out of the app only from the in-force time.

## 10. Residuals

- **A position token moved by a plain transfer** can reach a wallet that
  never accepted. That wallet can only claim and close.
- **An owner who does not accept a new version in time.** Its offers and
  Auto-lend wait until it does. Nothing is lost, and nothing fills.
- **A visitor who will not pay a network fee to look around** does not see
  the connected app. The public site is where the platform is explained.
- **Another website** can show the platform's public data without any
  acceptance. It cannot open a position for a wallet that has not accepted.

## 11. Alternatives considered

1. **Keep the gate in the app only.** Declined by the owner: any other
   website goes round it.
2. **A free signature at Connect, recorded on-chain later** with the wallet's
   first transaction, by the counterparty that fills its offer, or by the
   keeper. Declined by the owner (2026-11-18): the acceptance must be the
   wallet's own paid act. A record submitted by someone else could be
   questioned, and a free step lets throwaway wallets in.
3. **Ask only at the first action that commits money.** Declined by the
   owner: a wallet would be connected and browsing before it agreed.
4. **Check only when a loan opens, not when a commitment is posted.** Not
   taken: the book would fill with offers that cannot be filled, and a taker
   would learn it only from a failed transaction.
5. **Check every step, close-outs included.** Declined: a new version would
   lock a wallet out of repaying or claiming until it agreed, which is
   leverage the platform must never hold over funds.
6. **Commitments made under an older version keep filling.** Declined by the
   owner (2026-11-18): a loan would open with a party who never accepted the
   Terms in force that day. The notice period gives the same continuity
   without that.
7. **A new version in force at once.** Declined by the owner (2026-11-18):
   every Auto-lend and every standing offer would stop in the same block,
   with no time to accept.
8. **One acceptance for all networks, carried to the others by a cross-chain
   message.** Declined by the owner (2026-11-18): the wallet accepts on each
   network by its own transaction. A carried record would be written on the
   other network by the platform's messenger and not by the wallet, which is
   the kind of record the owner already declined (alternative 2). It would
   also make opening a position on one network depend on a message from
   another, and add a message fee and a delay to something the wallet can do
   itself in one step.
9. **Require acceptance of matchers and liquidators.** Not taken: settling a
   loan must stay open to anyone, and they hold no position.

## 12. Recommendation

Build it as one change: the rule and its previews, the per-version record,
the announcement of a new version and the Connect step. The build updates the
functional spec and the [gate matrix](SanctionsAndTermsGateMatrix.md), whose
"no protocol backstop" sentence it retires. Test networks that already have a
version in force need their rehearsal and test wallets to accept before their
next run.
