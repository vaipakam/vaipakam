# Features built over existing parts (design)

Owner request, 2026-11-19: design and build now the features of the platform survey that were not set aside. This document covers the ones that need **no change to the contracts**. Each is something the platform can already do, and what is missing is a guided flow in the app, a read in the indexer, or a page on the site.

Cards: #3769 (borrow for someone, and alerts for a loan one does not hold), #3770 (group and team accounts), #3771 (goals, and giving a loan), #3772 (the credit line view, renting access, the agent page), #3773 (the embedded lending kit), #3774 (the public data feed).

Other survey features have their own documents: payments on a schedule from a protected account (#3776) and interest paid from collateral (#3777), which change contracts, and the repayment record (#3778), which does not.

Related designs: `VaultOutflowPolicyDesign.md`, `PayoutDestinationRuleDesign.md`, `InstantMarketDesign.md`, `IdleLiquidityMatchingDesign.md`, `AutoLendLendUntilDesign.md`, `IntegratorFeeShareDesign.md`, `PositionSaleStateGuardDesign.md`, `StandingInstructionsDesign.md`, `DefaultPathsDesign.md`.

## 1. The rule for every feature here

1. **No new way for funds to move.** Each flow uses steps that exist: borrow, Withdraw, repay, transfer a position, set a slot. Nothing here adds an outflow from a vault or a new payee.
2. **The app says what the chain enforces and what it does not.** A label kept by the app or the indexer (a goal's name, "borrowed for Asha") gives nobody a right. The review says so.
3. **Where the builder finds that an existing step refuses the flow,** the builder raises it and the flow waits. No step is loosened to make a flow work.

## 2. Borrow for someone (the guarantor)

**What the user gets.** One person puts up the collateral and another person uses the money and repays it. The first person's risk is exactly the collateral they locked.

**Why no contract change.** Every loan is fully secured, and nothing on chain can make a person pay. So "who owes" is only a name. What matters is whose collateral is at risk and who may repay, and both already work:

- The guarantor borrows as any borrower does. The collateral stays in the guarantor's own vault under the loan's lien, and returns to the holder of the borrower position when the loan is repaid. That holder is the guarantor for as long as the guarantor keeps the position, and the position can be transferred or sold.
- **One rule for every statement in this flow that says who benefits or who may act: it names the current holder of the borrower position, read from the chain at that moment.** The address that opened the loan appears only as history. And the other person's page never tells them to send funds to an address: it offers only repayment actions on the platform, whose effect the chain decides. (The one transfer in this flow is the guarantor's own, in step 3, to the address the guarantor entered.)
- Anyone who is not on the lender's side may repay a loan **in full**. So the other person can close the loan from their own wallet.
- A part payment is different today. Only the holder of the borrower position may make one, and only where the loan allows part repayment, and there is no entry by which anyone, the holder included, pays interest alone from a wallet. Card #3779 (`RepaymentByOthersDesign.md`) opens the part payment to anyone who is not on the lender's side, and adds a wallet payment of the interest accrued so far, at any time, on a loan with or without part repayment. That is a contract change and is not part of this document. Until it is built, everything short of the full repayment is paid by the guarantor.
- The borrowed funds arrive in the guarantor's vault as free balance. Sending them on is the guarantor's own Withdraw, under that account's own policy, and then an ordinary transfer.

**The flow.**

1. On the Borrow form the guarantor chooses **Borrow for someone** and enters that person's address.
2. The review states: "Your collateral secures this loan. If it is not repaid, your collateral is sold or passes to the lender. {address} is not bound to repay by anything on chain."
3. After the loan opens, the app offers the two steps that send the funds: Withdraw, then send. For a protected account the app says that the address must be an approved destination and that the account's delay applies. It never routes around either.
4. The app gives a link to the loan. The other person opens it and sees the loan with the amount that closes it today. By the rule above, the page reads the current holder from the chain when it opens and again when the payment is prepared, and never takes it from the link. Their page states: "Repaying returns the collateral to {current holder}, not to you."
   - **Where the position has moved.** If the current holder is not the address that opened the loan, the page says so before any payment, above the action: "This loan's borrower position is now held by {current holder}. It was opened by {opening address}. Your payment benefits {current holder}." The payer must confirm that line. If the holder changes between the page opening and the signature, the app stops and shows the new holder first.
   - **Before #3779 is built:** one action, **Repay**, which repays the loan in full, and the line "Only the holder of this loan's borrower position, {current holder}, can pay part of it. You can repay it in full." The page gives no instruction to send money to anyone. The holder's own page shows each amount as it falls due.
   - **Once #3779 is built:** the loan's page offers what that design gives any wallet that is not on the lender's side: **Repay**, **Pay part** where the loan allows it, and **Pay interest** where any has accrued. The flow adds nothing of its own. The app reads which entries the deployment routes and shows only those.
5. Either person may switch on alerts for the loan (section 9).

**Not offered.**

- Sending the borrowed funds straight to the other person's vault when the loan opens. It would let a stolen key borrow against an account's collateral and send the proceeds away without passing the account's Withdraw policy.
- A rule of its own for the guarantor's borrower, such as an address the guarantor names as allowed to pay part. The owner's direction of 2026-11-19 is one rule for everyone (#3779), so this flow has none.

**Builder to verify.** The full-repayment route accepts a payer who is not the holder of the borrower position on every loan this flow offers, and what that payer needs first (Terms accepted, not flagged). The flow is offered for loans of an ERC-20 only: a rental is settled by its renter alone. The reserve of a loan stays the holder's alone.

### Alternatives considered

1. **Collateral in one person's vault securing another person's loan record.** The true form of a guarantee. Rejected: every path that reads the borrower's vault for collateral would change (liquidation, the fallback, partial withdrawal, add collateral, the borrower's sale routes, claims, preclose, refinance, the handover of an obligation, the transfer of the borrower position). It would be the largest change to the loan paths since launch, for an outcome the guarantor already has.
2. **A guarantor who covers only the shortfall after the borrower's own collateral.** Useful, and it needs the same change as 1. Not designed. It can be reopened after the refactor if users ask.
3. **A label on chain naming the other person.** Not needed for any right. The app's own record and the public loan are enough for the link and the alerts.

### Recommendation

Build the flow in the app. No contract work.

## 3. Group and team accounts

**What the user gets.** A family, a club or a team holds one lending account that several people control, with a limit per person.

**How.** The account's owner is a multi-signature contract wallet. The vault belongs to that wallet, and the wallet's own rules decide who may sign what and up to how much. The platform's contracts check a signature through the standard check that accepts a contract wallet (signed offers, the accept terms, a protected account's settings), with one known exception: **adopting an asset that reached the vault by a plain transfer takes a key's signature only, so a contract-wallet account cannot adopt** (#3780 changes it, and is contract work outside this document). Until then the guide and the app say that such an account must deposit through the app, and that tokens sent to its vault by a plain transfer stay untracked. The test matrix below confirms every other step before the feature is offered.

**Why not signers inside the vault.** A protected account's signers are guards: they lock, cancel and approve a replacement. They cannot spend. Giving them the power to spend would change what a signer is for every protected account, in the vault's own code, which is the most sensitive code on the platform. A contract wallet already does this job and is audited for it.

**What is built.**

- The app works when opened from inside a contract wallet: every step that asks for a signature is sent as that wallet's transaction or signed message, a step that needs several approvals shows "waiting for approvals" and resumes when the transaction lands, and the batch of `DefaultPathsDesign.md` 3.4 is sent as one wallet transaction.
- A **team view**: the account's lending by term as a ladder (amount lent per due month), loans out, borrowings, and the recent activity with the approving wallet's own transaction link.
- A guide on the site: how to set up a shared account with a contract wallet, what its limits can and cannot stop, and that a protected account's delay and signers still apply on top.

**Builder to verify, as a test matrix with a contract wallet as owner:** vault creation, Terms acceptance, depositing through the app, adopting a plain transfer (expected to be refused until #3780, and listed as such), posting and accepting an offer (including the signed terms), receiving a position token (it is minted by the safe route, so the wallet must accept an ERC-721), setting a slot with its consents, the refinance payoff permit, a protected account's settings, Withdraw, Collect, the transfer of a position, and a standing instruction. No check in the contracts refuses a caller for being a contract. One more row is not about signatures: a contract wallet's address on one network need not be the same wallet, or exist at all, on another, so every step that names the same address on another network (a reward claim, the per-network Terms) is in the matrix, and the guide says it. Any step that refuses a contract wallet is reported with its reason, not worked around.

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
- The existing transfer checks apply unchanged. A transfer is refused while the giver's positions are locked, in the block in which value last left the position and for a short wait after it (a payout, a release of collateral, a repayment), where the giver or the receiver is flagged, where the receiver is a vault and not a wallet, and from an account that has been replaced or recovered. The app tries the transfer as a simulated call first and shows a refusal with its reason and, for the wait, the time it lifts.
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

Memberships, licences, passes and tickets that exist as tokens can be rented by the day through the rental path as it is. That path keeps the token in its owner's vault and records the renter for the period: in the vault's own record in every case, and on the token itself where the token carries a user role for a period. A pass is of use to a renter only where its issuer reads one of those. An issuer that reads plain ownership sees the vault and not the renter. So each listing says which the token is: "carries a user role", or "recorded by the vault only: check that the issuer honours it". The app gains a category for them in the rental listing and wording that fits ("access until {date}" in place of "rental"). The listing states what the platform enforces (the renter's right for the period, the return at its end) and what the token's own issuer controls (whether the pass is honoured). No contract change.

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

**Rulings for the build (2026-11-19, #3774).**

- **One prefix that carries the version.** The feed lives under `/public/v1`, and a `GET` of the prefix returns the feed's own catalogue. The version sits inside the public surface's own prefix, because the indexer's other routes are unversioned and change with the app.
- **The limit.** 120 requests a minute per caller address, one budget across every feed route, refused when the limit cannot be applied. The catalogue states it, each refusal states the limit and the period, and the documentation says that counting is per network location, so the figure is approximate. The figure for reads is higher than the one for writes because every route is cached and a caller pages through the book.
- **The routes.** Open offers (the book, recent offers, the pair-and-term list, totals, one offer by id) and loans (active, recent, totals, the agreed rates by pair and term, one loan by id). The rate figures carry the number of loans behind each interval. Held back: the reads the app uses for one wallet's own page, the signed-offer book and its posting route, the live socket and the webhook. A new route is an addition inside the version. A read that takes an address joins the feed only when a design names it as public; today that is the repayment record alone (`RepaymentRecordDesign.md` 4.3), one read per address, with no route that lists, ranks, searches or filters addresses by their record.
- **A route accepts only the parameters it lists.** The feed answers with the app's own read, so it forwards the listed parameters and the chain and refuses any other by name. A later change to the app's read cannot open a wallet filter in the feed without a decision.
- **The version's promise is tested.** One test pins the route list and each route's parameters, one pins each route's field names (a removal or a rename fails, and the fix is an adapter in the feed or a new version), and one records the tables each route reads and refuses any that is not rebuilt from chain events (the indexer's own table classification decides, so a table born off chain can never be served).
- **What the rate figures are called.** The agreed rates of this platform's own past loans, by pair and term. They are never called a market rate, a benchmark or the platform's rate.

- **A later addition, decided on 2026-11-19 (#3821).** One more route, the lender positions whose holders have opened them to sale: a listing, or a standing instruction with a lowest accepted price. It is the same read the app's for-sale book uses (`SecondaryDebtMarketDesign.md` section 10). A position is named by its token and its loan, never by its holder. The figures that depend on the chain's state now come from a table of `positionWorth` reads, each with the block it was read at, and a figure past its bound is returned as not stated. The platform sets and suggests no price: no reference worth, no computed return, no order by price. It is built after the lender-exit builds.

**Alternatives considered for the limit and the prefix.** 60 a minute, the figure the posting routes use: rejected, because these are cached reads and one page of a client loads several routes at once. A `/v1/feed` prefix: rejected, because it reads as a version of the whole indexer. Forwarding every query parameter to the app's read: rejected, because the feed's surface would then change with the app.

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

1. Borrow for someone: the loan's collateral, lien and borrower position are the guarantor's; a full repayment from the other address closes the loan and the collateral is claimable by the holder of the borrower position only; after the guarantor transfers the position, every statement on the other person's page (who receives the collateral, who can pay part) names the new holder, and no line on it tells the payer to send funds to an address; the page also names the new holder and the original guarantor before any payment, and a holder change between opening the page and signing stops the payment; a protected guarantor's send waits the account's delay and is refused to an address that is not approved.
2. The other person's page offers repayment and alerts and nothing else. On a deployment without #3779 it offers the full repayment only and shows both statements of section 2; with it, the part payment appears where the loan allows it and the interest payment where any interest has accrued.
3. A contract wallet as owner completes every row of the matrix in section 3, or the row is listed as refused with its reason.
4. A goal changes nothing on chain except, when the user asks, the slot's "lend until".
5. Give this loan: the receiver collects later payments into their own vault; the giver keeps what was collected before; on a loan with an open seller claim the review shows the amount owed ahead of the holder, and the receiver's first interest payment is reduced by it; each refusal of the transfer check is shown with its reason.
6. The credit line's "available now" equals what a draw in the same block delivers.
7. The public feed never returns a privately kept record, and each figure carries its block.
8. An alert for a loan the wallet does not hold says so in every message.
9. The kit: an id carried through **lend this** pays no share, and the review and the kit's documentation say so.
10. Each listing in the access category says whether the token carries a user role or is recorded by the vault only, read from the token.

## 13. Open items for the builder to raise, not decide silently

1. What a payer who is not the holder must have done before the full repayment accepts them (Terms accepted, not flagged). #3779 carries the same question for the part payment.
2. Whether a token sent to an address with no vault can be collected on first connection without any step by the giver. Settled with the builder on 2026-11-19: it can. A payout to a position's holder resolves the holder from the token and creates the holder's vault if there is none, so the receiver's vault is made at their first collect, in their own transaction. The review says so, and says to send only to a wallet the receiver controls.
3. Which wallet connection the app uses inside a contract wallet, and how a step that waits for approvals resumes. And any signature-taking entry besides adoption (#3780) that refuses a contract wallet.
4. The rate limits of the public feed and of alerts per wallet.
