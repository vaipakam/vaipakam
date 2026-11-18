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
| 2026-11-18 | **The same holds for a new version.** Asked again for the re-acceptance a material change needs, the owner kept one own transaction per network. The app makes it one guided flow across the networks a wallet uses (section 7). |
| 2026-11-18 | A new version is announced with a notice period. After it, a wallet that has not accepted takes on no new position; its commitments wait and are not cancelled (section 5). |
| 2026-11-18 | **A small wording fix does not need re-acceptance.** Each network holds a minimum version beside the latest one. A typo fix or a clarification becomes the latest version and is what a new wallet accepts; existing wallets keep working and pay nothing. Only a material change raises the minimum, and it does so through the notice period (section 5). |

## 3. The rule

**A wallet that takes on a new position must be current on the Terms. A
wallet that only reduces or leaves a position is never asked.**

A wallet is **current** when it has accepted at least one version that has
come into force, from the minimum version up to the latest version, both
included (section 5). Usually those are the same version. A version that is
only announced, or whose announcement was withdrawn, has not come into force
and never counts, whatever its number.

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
contracts refuse it unless that pair is the latest version in force or the
announced one. A wallet never accepts an older version on purpose. The sender is the wallet that accepts. There is no route by which a
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

Each network holds two values: the **latest version**, which is the text
shown at Connect and the one a new acceptance names, and the **minimum
version**, the oldest acceptance that still lets a wallet take on a new
position. A new version is one of two kinds, and its publication says which.

Only one change is open at a time. While an announcement is waiting to come
into force, nothing else is published or announced on that network: no small
change and no second announcement. A correction that cannot wait is made by
withdrawing the announcement first (section 5.2). So the versions in force
are always numbered in the order they came into force, and a pending version
never sits inside the range of versions that count.

### 5.1 A small change

A typo fix or a clarification that changes nobody's rights or duties. It
becomes the latest version at once, with no notice, and the minimum stays
where it is.

- Nobody loses standing, which is why no notice is needed. Every wallet that
  was current stays current, its offers and Auto-lend keep filling, and it
  pays nothing.
- A wallet that accepts from then on accepts the new text.
- A wallet on an older version that still counts may accept the latest one
  whenever it likes. It is never required to.
- The latest version is at most 16 numbers above the minimum (**Default**). A
  small change that would pass that is refused by name, and the minimum is
  raised first (section 5.2). Whether a wallet is current is read across the
  versions from the minimum to the latest at every step of section 3.1, so
  this keeps the cost of opening a loan bounded however many small changes
  are published.

Which kind a change is, is the platform's decision, taken on legal advice and
stated in the publication's event. Each record names the exact version and
fingerprint a wallet accepted, so what a wallet agreed to is never blurred.
If a change is wrongly published as small, the wallets on the older text are
not bound by what it added: that risk is the platform's, never the user's.

### 5.2 A material change

A change that the wallets already here must agree to. It raises the minimum,
and it is **announced** with the time it comes into force. The minimum can be
raised to a new version, or to a version that is already the latest.

- From the announcement, a wallet may accept the version the minimum is
  moving to, by its own transaction like any acceptance (section 4).
- Until it comes into force, standing is unchanged: a wallet is current on
  the old minimum. A position opened during the notice is opened under the
  Terms in force that day, so its parties must be current on those.
- Accepting an announced version early does not make a wallet current by
  itself. It is what keeps the wallet current, with no gap, from the moment
  the new minimum comes into force.
- A wallet that joins during the notice accepts both the latest version in
  force and the announced one, in one transaction.
- From then on, only the new minimum and later versions count. A wallet that
  has accepted none of them takes on no new position: its offers and its
  Auto-lend stop filling, and an extension or a roll does not start a new
  term, so the loan runs to its agreed end. Its open loans are not touched.
- The notice is at least 7 days, and 14 by **Default**. The first version on
  a network needs no notice.
- An announcement can be withdrawn before it comes into force, and a
  withdrawal changes no wallet's standing. What it undoes depends on what
  was announced:
  - **A new version.** The version was never in force. Its number is spent
    and never reused, and an acceptance of it never counted on its own, so
    a wallet whose only acceptance is that withdrawn version is not current.
  - **A raise of the minimum to a version that is already the latest.**
    Only the pending raise is dropped. The version stays published and stays
    the latest, its number is not spent, every acceptance of it counts as it
    did before the announcement, and the minimum stays where it was. The
    same raise can be announced again later, with a full notice.

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
- **After a material change** (section 5.2), the owner of an offer, Auto-lend
  or a standing instruction sends a new acceptance to keep it filling. A
  small change (section 5.1) asks nothing of them. The notice period
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
- **A small update.** A wallet that is current on an older version sees a
  quiet line that the Terms were updated, with the link and what changed. It
  is never a blocking prompt, and accepting the latest text is offered, not
  required.
- **A material change.** From the announcement the app asks again at Connect,
  shows the date, and says what stops on that date if the wallet does not
  accept. For a wallet that is current this request
  can be put off: declining it, or rejecting its transaction, leaves the
  wallet connected with everything open until that date. Being current is
  all that is required to be connected. A wallet connecting for the first time
  during the notice is shown both versions and accepts both in the one
  transaction.
- **Another network.** A wallet accepts on each network it uses, by its own
  transaction there (section 4). The app makes that one guided flow and never
  a surprise:
  - The first time a wallet uses another network the app asks for the
    acceptance there, before anything else on that network.
  - During the notice of a material change, the request at Connect also lists
    the other networks where the wallet has something that would stop on the
    date: an open offer, Auto-lend, a standing instruction, or a loan set to
    extend or roll. It walks through them one at a time: switch network,
    confirm, next. Each step names the network, says that its only cost is
    that network's fee, and says what stops there on the date.
  - A network where the wallet has nothing is not listed and not asked. It
    asks at the wallet's next use there.
  - Each step stands alone. One that is skipped, rejected or fails leaves the
    others recorded, and a wallet short of the fee on one network is told the
    amount and the flow moves on.
  - Two things are shown per network and never merged. One is the wallet's
    standing there now: current or not. The other is the announced version:
    accepted, with the transaction; sent and waiting; or not yet, with the
    date. A wallet that is current on a network and has not yet accepted the
    announced version there stays current, with everything open, until the
    date. Putting a step off changes nothing before it.
  - Neither is ever taken from another network. A wallet is not shown as
    current on one network, or as having accepted the announced version
    there, because of an acceptance made on another.
  - A small update never starts this flow.
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
- A publication, an announcement, its withdrawal and a version or a minimum
  coming into force each emit an event with the version, the fingerprint, the
  time, and whether the minimum moves.
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
5. During the notice of a material change a wallet that accepted the version
   in force is current, and one that accepted only the announced version is
   refused. One second after the new minimum comes into force, a wallet on
   the old one is refused and its offer is still on the book; it accepts and
   the same offer fills.
6. A notice shorter than the floor is refused. The number of a withdrawn
   new version cannot be announced again.
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

16. A small change is published with no notice. A wallet that accepted the
    earlier version opens a loan the next block and its offer keeps filling.
    A new wallet can accept only the new text; the earlier pair is refused.
17. A material change raises the minimum to a later version after the notice.
    Wallets on each earlier version are refused one second after it comes
    into force, and each is current again once it accepts. Raising the
    minimum to a version that is already the latest behaves the same.
18. A wallet whose only acceptance is an announced new version that was
    withdrawn is refused, whatever its number.
19. With the minimum at one version and a later one already the latest, a
    wallet that accepted only the later one is current. A raise of the
    minimum to that version is announced and then withdrawn: the wallet is
    current before, during and after, the version is still the latest and
    can still be accepted, and the same raise can be announced again.
20. While a material change is announced, a small change and a second
    announcement are both refused. After the announcement is withdrawn the
    small change is published. A wallet whose only acceptance is the
    withdrawn version is not current, although its number now lies between
    the minimum and the latest.

21. In the app, during the notice of a material change, a wallet that is
    current on two networks and has an open offer on each is walked through
    both. It accepts the announced version on the first and rejects the
    transaction on the second. The first shows the announced version as
    accepted. The second shows it as not yet, with the date, and still shows
    the wallet as current there: its offer keeps filling until the date and
    stops one second after. The acceptance on the first network changes
    nothing shown for the second. A third network where the wallet has
    nothing is not listed. A small update starts no such flow.

22. With the latest version 16 numbers above the minimum, one more small
    change is refused by name. After the minimum is raised it is published.
    A wallet that is not current is refused at a loan opening within a
    stated gas bound at that widest window.

## 10. Residuals

- **A position token moved by a plain transfer** can reach a wallet that
  never accepted. That wallet can only claim and close.
- **An owner who does not accept a new version in time.** Its offers and
  Auto-lend wait until it does. Nothing is lost, and nothing fills.
- **A change published as small that was material.** Wallets on the older
  text are not bound by what it added. The platform carries that, and can
  correct it by raising the minimum with notice.
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
6. **Commitments made under an older version keep filling after a material
   change.** Declined by the owner (2026-11-18): a loan would open with a
   party who never agreed to what changed. The notice period gives the same
   continuity without that. A small change is different by the later decision
   (section 5.1): nothing a wallet must agree to has changed.
7. **A material change in force at once.** Declined by the owner (2026-11-18):
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

   Asked again the same day for new versions only, with a delay of fifteen to
   twenty minutes accepted, and declined again. With a minimum version only a
   material change needs re-acceptance, so a carried record would save one
   low-cost transaction per extra network, a few times in the platform's
   life. The message costs more than that transaction, since its fee covers
   the gas on the other network. If the platform paid it, anyone could make
   the platform spend. And the same address is not always the same party: a
   contract wallet's address on another network can belong to someone else
   or to nobody, so a carried acceptance could bind an address whose owner
   never agreed, and leaving contract wallets out would make two rules. The
   guided flow of section 7 gives the convenience with none of this.
9. **Every new version is re-accepted, even a typo fix.** Declined by the
   owner (2026-11-18): every wallet would pay again on each network, and
   every offer and Auto-lend would pause, for a change that binds nobody to
   anything new.
10. **Hold both values but always raise them together until a lawyer has
    said what counts as material.** Not chosen. What counts as material is
    still a question for the legal review before mainnet.
11. **Require acceptance of matchers and liquidators.** Not taken: settling a
   loan must stay open to anyone, and they hold no position.

## 12. Recommendation

Build it as one change: the rule and its previews, the per-version record,
the announcement of a new version and the Connect step. The build updates the
functional spec and the [gate matrix](SanctionsAndTermsGateMatrix.md), whose
"no protocol backstop" sentence it retires. Test networks that already have a
version in force need their rehearsal and test wallets to accept before their
next run.
