# Terms of Service acceptance enforced by the contracts (#3734)

Status: **design, decided by the owner** (2026-11-18: the contracts enforce
acceptance, and the app asks for it when the wallet connects). Not built.
Fresh deploy, no migration. Choices the decision left open are marked
**Default**.

"Terms" in this document always means the Terms of Service, never the terms
of a loan.

## 1. The problem

The platform records which version of the Terms a wallet accepted and when.
Nothing reads that record. The gate is in the app only: a wallet that uses
another website, or calls the contracts directly, can post an offer and open
a loan without ever accepting. The
[gate matrix](SanctionsAndTermsGateMatrix.md) states this as "no protocol
backstop".

Two more things follow from the acceptance being a paid transaction:

- The app asks for it only at the first action that commits money, because
  asking a visitor to pay before they can look around drives them away. So a
  wallet is connected, and treated as a user, before it has agreed to
  anything.
- A maker who signs offers without sending a transaction has no way to accept
  at all without paying for one.

## 2. The decisions

| Date | Decision (owner) |
| --- | --- |
| 2026-11-18 | The contracts refuse a new position for a wallet that has not accepted the Terms in force. |
| 2026-11-18 | The app asks for the acceptance at Connect. A wallet that has not accepted is not connected to the app. The acceptance is recorded on-chain. |
| 2026-11-18 | A new version is announced with a notice period. After it, a wallet that has not accepted takes on no new position; its commitments wait and are not cancelled (section 5). |

## 3. The rule

**A wallet that takes on a new position must have accepted the Terms in
force. A wallet that only reduces or leaves a position is never asked.**

This is the rule the app already follows (functional spec, "Terms of Service
acceptance"). The change is that the contracts hold it, so it is true for
every website and every direct caller.

While no Terms version is in force, the rule checks nothing, as today.

### 3.1 Where it is checked

One rule, in one place, read from three kinds of step.

| Step | Who must be current | Why here |
| --- | --- | --- |
| **Opening a loan**, by any route: a direct accept, a match, a signed-offer fill, an Auto-lend fill, an instant-market borrow, a refinance, a rental, a roll or an extension that starts a new term | The two wallets the new loan records as lender and borrower | The one step every loan passes through. This is the rule; the rows below only refuse earlier. |
| **Taking over a position** through the platform: buying a loan, or replacing a borrower | The wallet coming in | It takes on the position. The wallet going out is not checked (3.2). |
| **Posting a standing commitment**: creating an offer of any kind, listing a loan for sale, setting or funding Auto-lend, setting a standing instruction | The wallet posting | So the book never holds a commitment that cannot be filled. |

The previews that the app and the keeper read before sending (accept, match,
Auto-lend fill, sale) ask the same rule and name the wallet that is not
current, so a refusal is known before a transaction is sent.

"Not current on-chain" is not the same as "cannot be filled". A wallet whose
signed acceptance is held in the store (section 6) is made current by the
same transaction that fills its commitment. The app and the keeper treat a
commitment as unfillable for the Terms only when its owner is not current
on-chain **and** no valid stored signature can be carried with the fill.

A refused fill does not cancel anything. The offer or the Auto-lend setting
stays as it is and fills again once its owner has accepted.

### 3.2 What is never checked

- Repaying, closing early, adding collateral, claiming, withdrawing one's own
  assets, cancelling one's own offers and orders, withdrawing Auto-lend
  capital, switching Auto-lend or a standing instruction off, and withdrawing
  a keeper's or a fee consent's authority.
- The wallet that **leaves** a position in one step: a lender being bought
  out, a borrower whose obligation moves to a replacement.
- Defaults, liquidations and every other step a third party or the keeper
  takes to settle a loan. A loan always settles, whatever its parties have or
  have not accepted.
- Third parties who are not a party to the loan: the matcher, the liquidator,
  the keeper. **Default.**
- Opening a vault, depositing into it and account-safety settings.
  **Default.** No rule here may stand between a wallet and its own funds or
  its own protection; the commitment the Terms govern is the position.
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

A wallet accepts in one of two ways. Both write the same record and the same
event, and the event says which way was used.

1. **By its own transaction**, as today.
2. **By a signature that anyone may submit.** The wallet signs a typed
   message that a wallet app shows in plain words: a fixed statement that the
   signer has read and accepts the Terms of Service, the version, the
   fingerprint of the exact text, and an expiry. It is bound to the network
   and to the platform's address. A contract wallet signs in the
   contract-wallet form.

Rules for the signature:

- It is good only for the version and fingerprint it names, and only while
  that version is in force or announced (section 5).
- The expiry may be at most 180 days after it is submitted (**Default**).
- Submitting it for a wallet that has already accepted **that version and
  fingerprint** changes nothing: the first acceptance time is kept. A wallet
  that is current on the version in force and signs the announced one is
  recorded for the announced one too.
- It gives the submitter nothing. It moves no funds, grants no authority and
  opens no position. That is the difference from the relayed consents removed
  earlier (#3238): the worst a hostile website can obtain is a true record
  that the wallet signed the acceptance.

The record is kept per version. Accepting an announced version never
replaces the acceptance of the version in force, so a wallet that accepted
both stays current if the announcement is withdrawn.

There is nothing to revoke. A wallet that no longer agrees closes its
positions, which section 3.2 always allows.

**Default: one signature per network.** A signature without a network would
cover every network at once, but an acceptance signed on a test network could
then be recorded on a main one, and wallet apps warn about typed messages
that name no network.

## 5. A new version of the Terms

A new version is **announced** with the time it comes into force.

- From the announcement, a wallet may accept the new version.
- Until it comes into force, a wallet that accepted the current version or
  the announced one is current.
- From then on, only the new version counts. A wallet that has not accepted
  it takes on no new position: its offers and its Auto-lend stop filling, and
  an extension or a roll does not start a new term, so the loan runs to its
  agreed end. Its open loans are not touched.
- The notice is at least 7 days, and 14 by **Default**. The first version on
  a network needs no notice.
- An announcement can be withdrawn before it comes into force. The version
  number is then spent and never reused.

The announcement and the time are an event. Every alert channel carries it to
wallets with an open offer, Auto-lend or a standing instruction, with the
date their commitments stop filling.

## 6. Recording it on-chain

The owner asked that the acceptance be taken at Connect and recorded
on-chain. A wallet cannot sign before it is connected, and a transaction at
Connect would charge every visitor. The shape:

1. **At Connect** the wallet signs the acceptance (section 7). The app sends
   the signature to the platform's store, which checks it before keeping it.
   The store keeps the wallet, the network, the version, the fingerprint, the
   expiry, the signature and the time received, and nothing else.
2. **The record reaches the chain** by whichever of these comes first:
   - the wallet's first transaction that needs it, which carries the
     acceptance in the same transaction through the platform's batch entry;
   - anyone who needs the wallet to be current, in the same way: the taker
     filling a maker's signed offer, or the keeper filling an Auto-lend or a
     match, submits the owner's stored signature in the same transaction;
   - the keeper, which submits stored signatures on its own (below).
3. **No position can exist without it.** The rule of section 3 refuses the
   first position until the record is on-chain, so there is never a loan
   whose parties have no on-chain acceptance.

**The keeper pass.** It submits stored, unexpired signatures whose version is
not yet recorded for the wallet, the announced version included. Its scope is
a setting:

- *Commitments only*: wallets with an open offer, a signed offer in the
  shared book, Auto-lend or a standing instruction. This is what keeps those
  filling after a new version without their owners paying a transaction.
- *Every signer*: every wallet that signed at Connect, within a daily budget
  per network. This puts the record on-chain within minutes of connecting.
  When the budget is spent the pass falls back to commitments only, and the
  rest are recorded with their first transaction.

Like every new pass it ships disarmed, and each scope is armed separately by
the owner. The cost of *every signer* is one small transaction per wallet per
network per version, paid by the keeper; the daily budget is what bounds a
flood of throwaway wallets.

The app states where a wallet stands, and never more than it knows: not
accepted; signed on a date and not yet recorded; or recorded, with the
transaction.

## 7. App

- **Connect.** The Connect step shows the Terms first: the version, the
  fingerprint, the link pinned to that version, the privacy policy and the
  key risks, with a box to tick. The wallet list opens only after the box is
  ticked. Once the wallet is chosen, it is asked for the signature at once,
  and the request says the acceptance will be recorded on-chain.
- **Not accepted means not connected.** If the signature is refused, the
  wallet gets nothing that creates a position: no market actions, no posting,
  no Auto-lend. What it keeps is every action of section 3.2, and only those:
  repaying and closing, adding collateral, claiming, withdrawing, cancelling
  its own offers and signed orders, and withdrawing a keeper's or a fee
  consent's authority. The app does not test for a position or a balance
  first, because a wallet with neither can still hold a signed order or a
  permission it needs to withdraw. For a wallet with nothing to wind down
  those surfaces are empty, and the app says that accepting is what opens the
  rest.
- **A contract wallet** that cannot sign on the spot accepts by its own
  transaction and is treated as not connected until the record is on-chain.
- **A new version.** From the announcement the app asks again at Connect,
  shows the date, and says what stops on that date if the wallet does not
  accept.
- **Another network.** The first time a wallet uses another network the app
  asks for that network's signature.
- **The book.** An offer whose maker is current on-chain, or whose maker's
  valid signature is in the store, is fillable; in the second case the fill
  carries the signature in the same transaction. Only an offer whose maker
  is neither is shown as not fillable now, with the reason, or left out of
  the fillable list. Nothing is offered as an action that would fail.

## 8. Events and the record

- An acceptance emits the wallet, the version, the fingerprint, the time,
  whether it came by the wallet's own transaction or by a signature, and who
  submitted it.
- An announcement, its withdrawal and a version coming into force each emit
  an event with the version, the fingerprint and the time.
- The refusal names the wallet and the version it needs.

## 9. Tests (acceptance)

1. With a version in force, no route opens a loan while either party is not
   current: direct accept, match, signed-offer fill, Auto-lend fill, instant
   market, refinance, rental, loan sale, borrower replacement, roll and
   extension. Each is driven end to end, not only at the shared step.
2. Every step of 3.2 succeeds for a wallet that never accepted, and for one
   whose acceptance went stale while it had an open loan.
3. A signature for another version, another fingerprint, another network,
   another wallet, or past its expiry is refused. An expiry more than 180
   days ahead is refused.
4. A signature submitted twice, or after the wallet's own transaction, leaves
   the first acceptance time unchanged.
5. During the notice both versions count. One second after the new version
   comes into force, a wallet on the old one is refused and its offer is
   still on the book; it accepts and the same offer fills.
6. A notice shorter than the floor is refused. A withdrawn version number
   cannot be announced again.
7. A maker who never sent a transaction has a signed offer filled in one
   transaction that also records the maker's acceptance.
8. A contract wallet accepts in the contract-wallet form.
9. With no version in force, nothing is checked.
10. A loan whose parties are both stale is repaid, defaulted and liquidated
    normally.
11. A wallet current on the version in force signs the announced one during
    the notice. The signature is recorded, and the wallet's offer fills one
    second after the new version comes into force. If the announcement is
    withdrawn instead, the wallet is still current.
12. With the keeper pass disarmed, the app lists as fillable an offer whose
    maker signed at Connect and is not yet recorded, and the fill succeeds.
    An offer whose maker has neither a record nor a stored signature is not
    listed as fillable.
13. A wallet that refused, with no position and no balance, cancels its own
    signed order and withdraws a keeper's authority through the app.

## 10. Residuals

- **A wallet that signs and never transacts** has no on-chain record unless
  the *every signer* scope is armed. It also has no position. Its signature
  is held and can be recorded by anyone at any time until it expires.
- **A position token moved by a plain transfer** can reach a wallet that
  never accepted. That wallet can only claim and close.
- **The off-chain store is lost.** Nothing on-chain changes; a wallet that is
  not yet recorded is asked to sign again, which costs it nothing.

## 11. Alternatives considered

1. **Keep the gate in the app only.** Declined by the owner: any other
   website goes round it.
2. **A paid transaction at Connect.** Declined: every visitor pays before
   seeing anything, on every network.
3. **Check only when a loan opens, not when a commitment is posted.** Not
   taken: the book would fill with offers that cannot be filled, and a taker
   would learn it only from a failed transaction.
4. **Check every step, close-outs included.** Declined: a new version would
   lock a wallet out of repaying or claiming until it agreed, which is
   leverage the platform must never hold over funds.
5. **Commitments made under an older version keep filling.** Declined by the
   owner (2026-11-18): a loan would open with a party who never accepted the
   Terms in force that day. The notice period gives the same continuity
   without that.
6. **A new version in force at once.** Declined by the owner (2026-11-18):
   every Auto-lend and every standing offer would stop in the same block,
   with no time to accept.
7. **One signature for all networks.** Not taken (section 4).
8. **Require acceptance of matchers and liquidators.** Not taken: settling a
   loan must stay open to anyone, and they hold no position.

## 12. Recommendation

Build it as one change: the rule and its previews, the signature route, the
announcement of a new version, the keeper pass (disarmed), the store and the
Connect step. The build updates the functional spec and the
[gate matrix](SanctionsAndTermsGateMatrix.md), whose "no protocol backstop"
sentence it retires. Test networks that already have a version in force need
their rehearsal and test wallets to accept before their next run.
