# Features built over existing parts (design)

Owner request, 2026-11-19: design and build now the features of the platform survey that were not set aside. This document covers the ones that need **no change to the contracts**. Each is something the platform can already do, and what is missing is a guided flow in the app, a read in the indexer, or a page on the site.

Cards: #3769 (borrow for someone, and alerts for a loan one does not hold), #3770 (group and team accounts), #3771 (goals, and giving a loan), #3772 (the credit line view, renting access, the agent page), #3773 (the embedded lending kit), #3774 (the public data feed).

Features that do change contracts have their own documents: payments on a schedule from a protected account, interest paid from growing collateral, the repayment record, and savings circles.

Related designs: `VaultOutflowPolicyDesign.md`, `PayoutDestinationRuleDesign.md`, `InstantMarketDesign.md`, `IdleLiquidityMatchingDesign.md`, `AutoLendLendUntilDesign.md`, `IntegratorFeeShareDesign.md`, `PositionSaleStateGuardDesign.md`, `StandingInstructionsDesign.md`, `DefaultPathsDesign.md`.

## 1. The rule for every feature here

1. **No new way for funds to move.** Each flow uses steps that exist: borrow, Withdraw, repay, transfer a position, set a slot. Nothing here adds an outflow from a vault or a new payee.
2. **The app says what the chain enforces and what it does not.** A label kept by the app or the indexer (a goal's name, "borrowed for Asha") gives nobody a right. The review says so.
3. **Where the builder finds that an existing step refuses the flow,** the builder raises it and the flow waits. No step is loosened to make a flow work.

## 2. Borrow for someone (the guarantor)

**What the user gets.** One person puts up the collateral and another person uses the money and repays it. The first person's risk is exactly the collateral they locked.

**Why no contract change.** Every loan is fully secured, and nothing on chain can make a person pay. So "who owes" is only a name. What matters is whose collateral is at risk and who may repay, and both already work:

- The guarantor borrows as any borrower does. The collateral stays in the guarantor's own vault under the loan's lien, and returns to the guarantor when the loan is repaid.
- Anyone who is not on the lender's side may repay a loan **in full**. So the other person can close the loan from their own wallet.
- A part payment is different. Today only the holder of the borrower position may make one, and only where the loan allows part repayment. There is no entry by which another person pays one interest period. So everything short of the full repayment is paid by the guarantor.
- The borrowed funds arrive in the guarantor's vault as free balance. Sending them on is the guarantor's own Withdraw, under that account's own policy, and then an ordinary transfer.

**The flow.**

1. On the Borrow form the guarantor chooses **Borrow for someone** and enters that person's address.
2. The review states: "Your collateral secures this loan. If it is not repaid, your collateral is sold or passes to the lender. {address} is not bound to repay by anything on chain."
3. After the loan opens, the app offers the two steps that send the funds: Withdraw, then send. For a protected account the app says that the address must be an approved destination and that the account's delay applies. It never routes around either.
4. The app gives a link to the loan. The other person opens it, sees the loan with the amount that closes it today, and has one action, **Repay**, which repays the loan in full. Their page states: "Repaying returns the collateral to {guarantor}, not to you." and "Only {guarantor} can pay part of this loan or one interest period. To pay part, send them the amount." The guarantor's own page shows each amount as it falls due, so they can ask for it.
5. Either person may switch on alerts for the loan (section 9).

**Not offered.**

- Sending the borrowed funds straight to the other person's vault when the loan opens. It would let a stolen key borrow against an account's collateral and send the proceeds away without passing the account's Withdraw policy.
- A part payment or an interest payment by the other person. It needs contract work: the part-repayment entry accepts the holder only. The limit has a reason. A part payment changes the loan's principal, and the holder may have a refinance request, a listing or an offset open on the loan that a stranger's payment would disturb. Whether to open it, for example to an address the holder names, is a decision for the owner (section 13). Until then the flow is as above.

**Builder to verify.** The full-repayment route accepts a payer who is not the holder of the borrower position on every loan this flow offers, and what that payer needs first (Terms accepted, not flagged). The flow is offered for loans of an ERC-20 only: a rental is settled by its renter alone. The reserve of a loan stays the holder's alone.

### Alternatives considered

1. **Collateral in one person's vault securing another person's loan record.** The true form of a guarantee. Rejected: every path that reads the borrower's vault for collateral would change (liquidation, the fallback, partial withdrawal, add collateral, the borrower's sale routes, claims, preclose, refinance, the handover of an obligation, the transfer of the borrower position). It would be the largest change to the loan paths since launch, for an outcome the guarantor already has.
2. **A guarantor who covers only the shortfall after the borrower's own collateral.** Useful, and it needs the same change as 1. Not designed. It can be reopened after the refactor if users ask.
3. **A label on chain naming the other person.** Not needed for any right. The app's own record and the public loan are enough for the link and the alerts.

### Recommendation

Build the flow in the app. No contract work.

## 3. Group and team accounts

**What the user gets.** A family, a club or a team holds one lending account that several people control, with a limit per person.

**How.** The account's owner is a multi-signature contract wallet. The vault belongs to that wallet, and the wallet's own rules decide who may sign what and up to how much. The platform's contracts check signatures through the standard contract-signature check, so a contract wallet is expected to pass wherever a signature is taken. The test matrix below confirms it step by step before the feature is offered.

**Why not signers inside the vault.** A protected account's signers are guards: they lock, cancel and approve a replacement. They cannot spend. Giving them the power to spend would change what a signer is for every protected account, in the vault's own code, which is the most sensitive code on the platform. A contract wallet already does this job and is audited for it.

**What is built.**

- The app works when opened from inside a contract wallet: every step that asks for a signature is sent as that wallet's transaction or signed message, a step that needs several approvals shows "waiting for approvals" and resumes when the transaction lands, and the batch of `DefaultPathsDesign.md` 3.4 is sent as one wallet transaction.
- A **team view**: the account's lending by term as a ladder (amount lent per due month), loans out, borrowings, and the recent activity with the approving wallet's own transaction link.
- A guide on the site: how to set up a shared account with a contract wallet, what its limits can and cannot stop, and that a protected account's delay and signers still apply on top.

**Builder to verify, as a test matrix with a contract wallet as owner:** vault creation, Terms acceptance, posting and accepting an offer (including the signed terms), setting a slot with its consents, the refinance payoff permit, a protected account's settings, Withdraw, Collect, the transfer of a position, and a standing instruction. Any step that refuses a contract wallet is reported with its reason, not worked around.

### Alternatives considered

1. **Per-signer spending limits in the vault.** Rejected for the reason above.
2. **A shared account kept by the app, with members' own vaults behind it.** Rejected: the app would be deciding who owns what.

### Recommendation

Support a contract wallet as owner end to end, and add the team view and the guide.

## 4. Goals, and giving a loan

**Goals.** A goal is a name, a target amount and a date that the user attaches to a slot or to loans they made. The app shows progress toward it and, for a slot, sets "lend until" to the goal's date when the user asks.

- A goal is the user's own note. It locks nothing. The page says: "A goal does not stop you withdrawing. Funds in a loan return as that loan is repaid."
- Goals are stored for the wallet by the app's service, signed by the wallet, and are private to it.

**Not built: a lock on free balance until a date.** A lock that its owner cannot undo fails them in an emergency, and a lock that they can undo is a note. A protected account's delay is the platform's answer to haste.

**Giving a loan.** A lender's position is a token, and a holder may transfer it. **Give this loan** guides that transfer:

- The review states what the receiver gets: the holder's remaining entitlement on the loan, paid to the receiver's own vault. That is the later repayments and the claim at the end, **after anything the loan still owes to an earlier seller**. It states what stays with the giver (anything already collected), and that the transfer cannot be undone by the platform.
- **Seller claims.** Where an earlier sale of the position left a seller claim on the loan, interest is paid to that seller first, and a transfer does not remove the claim. The review reads the loan's open seller claims and shows the amount still owed ahead of the holder. Where the app cannot read it, the review says so and does not state what the receiver will get.
- **The fee discount.** The lender's fee discount on a transferred loan is the lower of the figure the loan carries and the receiver's own standing. The review shows the figure that will apply to the receiver.
- The existing transfer checks apply unchanged: the account's delay and lock, the wait after a claim, a flagged receiver. The app reads the transfer check first and shows a refusal with its reason and the time it lifts.
- The receiver sees the loan on their own page with the note "given by {address}", and collects as any holder does.
- A gift to a person who has not used the platform: the token arrives at their address, and they accept the Terms and collect when they first connect. The builder confirms that no step by the giver is needed for it (section 13) before the app offers it.

**Not offered here: a fund held for a minor or released on a condition.** That needs someone to decide when a condition is met. It is on the list for legal advice and is not designed.

### Alternatives considered

1. **A new "gift" contract that holds the position until a date.** Rejected: it holds another person's asset outside any vault.
2. **Lend on behalf of the receiver from the start.** The ruling of 2026-11-19 already gives the loan side to the holder of an offer's token, so transferring the offer's token before it fills does this where the offer has one. The guided flow covers the loan; the offer case follows when that ruling is built.

### Recommendation

Build goals as notes and "Give this loan" as a guided transfer.

## 5. A credit line view

The instant market shown as one line of credit. The user posts collateral once in their vault and sees:

- **Available now:** what the standing sources would lend against the free collateral at this moment, at what rate, from the same simulated call or preview the Borrow form uses (`DefaultPathsDesign.md` section 4).
- **Drawn:** the groups of loans opened from this page, shown as one position each (`InstantMarketDesign.md` section 5), with one **Draw** and one **Repay**.

It states that each draw is its own loan with its own lender, rate and due date, that "available" is not a commitment by anyone and can be zero a moment later, and that nothing is reserved for the user. It is never called an overdraft or a facility.

**Alternative considered: a committed line on chain,** where lenders reserve capital for one borrower. Rejected: it locks lenders' capital without pay or needs a commitment fee, and the instant market already answers "can I borrow now" from live sources.

## 6. Renting access

Memberships, licences, passes and tickets that exist as tokens can be rented by the day through the rental path as it is, where the token is one the rental path accepts: a token that carries a user role for a period, or a multi-unit token the vault holds for the renter. A pass whose issuer reads plain ownership and not the user role gives a renter nothing, and the listing says which kind the token is. The app gains a category for them in the rental listing and wording that fits ("access until {date}" in place of "rental"). The listing states what the platform enforces (the renter's right for the period, the return at its end) and what the token's own issuer controls (whether the pass is honoured). No contract change.

## 7. The embedded lending kit

For wallets, marketplaces and games that want to offer lending inside their own product.

- A small published code package with three entry points: **borrow against this** (an asset the user holds), **lend this** (an amount), and **rent this** (a token). Each opens the platform's own review and signature flow for the user's wallet, pre-filled, with the integrator's registered id carried.
- **Where a share applies, and where it does not.** `IntegratorFeeShareDesign.md` section 5 pays a share only on a loan whose borrower side named the integrator when the loan or the request was made. So the id can bring a share through **borrow against this**. On **lend this** the id is attribution only and earns no share, because a lender's action never names an integrator. The kit's documentation lists, for each entry point, whether a share can apply, read from that design, and says plainly where none does. The review shows the user whether a share is being paid on their loan and to whom.
- The kit never holds a key, never signs, and never shows a rate as the integrator's own. The user always sees the platform's review screen before signing.
- A page of plain documentation and one worked example.

The share an integrator receives is called a share of the fee on loans it brings. It is never described as earnings, income or revenue share.

**Alternatives considered.** A component library that renders the forms inside the integrator's page: rejected for now, because that page could alter what the user sees before signing, and every form change would need a release for every integrator. Documentation of the contract calls alone: rejected, because each integrator would rebuild the review step and some would skip it. A plain link with no package is kept as the simplest form: the package's entry points are thin builders of that link and the wallet hand-off.

## 8. The public data feed

The indexer already serves the app. This makes a stated part of it public and documented: open offers, loans and their states, the rates of filled loans by term, and the totals the transparency page shows.

- Read only, with a stated rate limit per caller and a stated freshness for each figure ("as of block N").
- Every figure names its source and what it leaves out. No figure is presented as the platform's rate or as a benchmark.
- Addresses appear as they do on chain. Nothing the app keeps privately for a wallet (goals, alert settings, the Telegram link) is ever served.

**Alternatives considered.** Leaving the indexer's routes undocumented: rejected, because callers would depend on routes that change with the app. A separate service for public data: rejected, because it would be a second copy of the same reads. The recommendation is a versioned, documented subset of the one indexer.

## 9. Alerts for a loan you do not hold

Needed by section 2, useful alone. A wallet may switch on alerts for any loan by its id: health level bands, a payment falling due, a repayment, a close-out. The data is public, so no consent from the holder is needed, and the alert states that the wallet holds no position in the loan. Limits per wallet apply so the alert service cannot be flooded.

## 10. Running your own agent

A page on the site that explains what already exists:

- A wallet may approve any address as a keeper for chosen actions, and remove it at any time. A keeper acts only inside the limits the owner set on a slot, an offer or an instruction. No keeper action can withdraw.
- The public reference keeper is open source, and the page links to it with the steps to run it for one's own wallet.
- A table of each action a keeper can be given, what it lets the keeper do, and what it never lets it do.

The page promises no result and names no rate.

## 11. What is built, and by whom

| Part | Where | Card |
| --- | --- | --- |
| Borrow for someone and the loan link | alpha05 | #3769 |
| Alerts for a loan one does not hold | the agent service | #3769 |
| A contract wallet as owner, end to end, with its test matrix | alpha05, with the contract threads answering any refusal found | #3770 |
| The team view | alpha05 | #3770 |
| The shared-account guide | the site | #3770 |
| Goals and Give this loan | alpha05, with goals storage in the agent service | #3771 |
| The credit line view, the access category | alpha05 | #3772 |
| The agent page | the site | #3772 |
| The embedded kit | a new package in the workspace | #3773 |
| The public data feed and its documentation | the indexer | #3774 |
| Contracts | none | |

## 12. Tests

1. Borrow for someone: the loan's collateral, lien and borrower position are the guarantor's; a full repayment from the other address closes the loan and the collateral is claimable by the guarantor only; a part payment from the other address is refused; a protected guarantor's send waits the account's delay and is refused to an address that is not approved.
2. The other person's page offers no action except repaying in full and alerts, and shows both statements of section 2.
3. A contract wallet as owner completes every row of the matrix in section 3, or the row is listed as refused with its reason.
4. A goal changes nothing on chain except, when the user asks, the slot's "lend until".
5. Give this loan: the receiver collects later payments into their own vault; the giver keeps what was collected before; on a loan with an open seller claim the review shows the amount owed ahead of the holder, and the receiver's first interest payment is reduced by it; each refusal of the transfer check is shown with its reason.
6. The credit line's "available now" equals what a draw in the same block delivers.
7. The public feed never returns a privately kept record, and each figure carries its block.
8. An alert for a loan the wallet does not hold says so in every message.
9. The kit: an id carried through **lend this** pays no share, and the review and the kit's documentation say so.
10. The access category lists a token only where the rental path accepts it, and each listing says whether the token carries a user role.

## 13. Open items for the builder to raise, not decide silently

1. What a payer who is not the holder must have done before the full repayment accepts them. And, as a decision for the owner and not the builder: whether a part payment should be opened to an address the holder names. It is contract work on the repayment facet, and it is not part of this design.
2. Whether a token sent to an address with no vault can be collected on first connection without any step by the giver.
3. Which wallet connection the app uses inside a contract wallet, and how a step that waits for approvals resumes.
4. The rate limits of the public feed and of alerts per wallet.
