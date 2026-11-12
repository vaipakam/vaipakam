# Release Notes — 2026-11-11

The day's contract work closes several ways funds or budgets could be drained or mispriced. The protocol's cross-chain broadcast budget now pays only for a push that lowers a tier, so toggling a discount cannot spend it (#3580). Treasury conversions carry an on-chain minimum output the caller can only raise (#3414). CCIP lanes are created already rate-limited, and NFT deposits are checked on arrival (#3539). The price-guard pointer waits at least the guard's own seven days (#3540). A lender's fee discount is the lower of the tier held at entry and at settlement (#3562). Loan deadlines wait out an L2 sequencer outage (#3410). Range matches now lend the largest amount both offers accept instead of the midpoint, capped by the borrower's collateral and the start-of-loan risk rule (#3326).

The rest of the day covers:
- **Operations:** the keeper checks fees and the chain before it signs, uses several private endpoints with a timed public fallback, keeps its one-runner lease in its own database, and returns a closed day's mirror reward leftover to Base. The RPC proxy shapes and weighs every method. CI secrets move to a main-only environment. The positive-flow scripts broadcast again, in stages.
- **Indexer and agent:** a reorganisation below the settled block is caught and rebuilt, pending actions show at once marked not final, and Telegram links and LOCK requests move into the agent's own storage.
- **Previews:** accept and risk-access previews for gasless signed offers.
- **The new app (alpha05):** the rate desk signs, lists, fills, matches and cancels signed orders, shows orders held for a re-check after a reorganisation, and previews a signed fill's risk-access check; lenders see their fee discount on each loan and their tier on other networks; every transaction uses the shared gas margin.

## Cross-chain tier pushes — the protocol budget pays only for a lowered tier (PR #3580)

Base sends each user's VPFI discount tier to every other chain, and the
protocol's broadcast budget paid for those messages. It paid a lowered tier
at once and a raised one once per day per chain. Toggling the discount
consent off and on, then refreshing the tier, therefore cost the protocol
about two paid messages per chain per account per day, and cost the caller
only gas. Many accounts could drain the budget that way.

The budget now pays only for a push that takes a discount away: a push to
tier 0, or one that lowers the tier or its discount under the same tier
table without raising either. That push still goes out at once. Every other
push (a first discount on a chain, a raised tier, a later expiry on its own,
or any push under a new tier table) is delivered only when someone pays its
cross-chain fee through the existing delivery call. Until then the chain
keeps what it last received, which grants no more than before. Each paid
drop now needs a raise someone paid for first, so churn can never spend the
budget faster than the person churning spends their own funds. The daily
spacing window, its setter and its getter are removed; the storage slot is
kept and marked retired.

Two things are deliberately not paid by the budget. An earlier expiry on its
own: the expiry moves with every balance change, so paying for each one
would let small unstakes spend many messages per paid raise; the other
chain's copy lapses at the old expiry instead, never later than its maximum
age. And a push under a new tier table: after governance changes the table,
each user's discount on other chains returns only when a paid push carries
the new version.

The tier status view now says, per chain, whether the budget pays the owed
push, instead of when it may. The keeper's tier-push retry delivers only
those lanes and no longer treats an owed raise as its work. The connected
app does not offer the delivery call yet, so for now a raised tier reaches
another chain only through a direct contract call; a "use my discount on
other chains" action in the apps is follow-up #3579.

Closes #1277.

> Caveat: until the apps offer the paid delivery call, a user's first or raised discount does not reach other chains through the app.
> Caveat: a tier-table change leaves every other-chain discount reading as none until a paid push carries the new version.

_Committed 2026-11-11 13:34 UTC (5955a02fd)._
<!-- assembled-fragment: 1277-broadcast-budget-pays-only-lowers.md sha256=bf2849e85d4adf112b2bab20b54aa322dfc818de12b7348c52c8361038c68160 -->

## RPC proxy — every method shaped, calls charged by weight, upstream answers capped (PR #3561)

The read-only RPC proxy checked the parameters of one method only, the
log scan. Every other method it serves now has a stated shape, and a call
outside it is refused in place with an invalid-params error instead of
going to the provider. The one that mattered most is the contract call and
gas estimate: they no longer accept a third "state override" parameter,
which would let anyone run arbitrary simulations on the platform's provider
plan. The connected app never sends one, so nothing it does changes.

The proxy's rate limit counted HTTP requests, and one request may carry
fifty calls, so a batch of fifty log scans cost the same as a single
block-number poll. A second per-caller budget now charges the calls a
request actually forwards, by weight: a plain read is one unit, a contract
call two, a gas estimate three, a block with all its transactions five and
a log scan ten. A request takes one slot per twenty-five units, at least
one, from a budget of two hundred slots a minute. Calls the proxy answers
itself (refusals and the chain id) cost nothing. A request over budget is
refused as a whole before the provider is asked, like every other refusal,
and the app falls back to the chain's public endpoint.

The proxy also read each upstream answer in full before looking at it. It
now reads at most 8 MiB and answers with a named "answer too large" error
past that, so one heavy answer cannot hold the Worker's memory.

Advances #1283. The agent's route limits and the signed lock requests from
the same issue land separately.

> Caveat: like the request budget, the new call budget is counted per Cloudflare location, so it bounds what one address spends at one location, not a crowd of addresses; the provider plan's own cap remains the outer bound.

_Committed 2026-11-11 08:04 UTC (6e2c84121)._
<!-- assembled-fragment: 1283-rpc-proxy-weighted-budget.md sha256=37d769f9befe5bba7bad5e103ce08bb4d04bfa9726981184350c149c16241439 -->

## Agent — Telegram links and LOCK requests move into the agent's own storage (PR #3571)

Which chat receives a wallet's alerts, the handshake codes that link a chat,
the pending removals of a chat under protected mode and the Telegram LOCK
requests used to sit in the shared database, which the indexer's and the
keeper's bindings can also write. A compromised sibling could have pointed an
owner's alerts at its own chat, cancelled a pending removal, or recorded a
LOCK the owner never sent. They now live in a Durable Object only the agent's
code reaches. Every chat change the agent decides is written in one guarded
step that applies only while the rows it read are unchanged.

The keeper reaches this state only through four new agent routes, behind a
token of its own (`KEEPER_AGENT_TOKEN`; without it the routes answer 503). It
collects a network's open LOCK requests, asks which wallets have one open,
reports how each ended, and asks for owner alerts to be sent. An alert travels
as typed data, never as text: the agent checks every value, writes the message
from the platform's own wording in the owner's language, and sends it to the
chat linked now. So the token cannot send arbitrary text to the chats owners
trust for alerts, and no value filled into a message can form a link. Each
request names the keeper's Diamond, and the agent refuses one that is not its
own, and LOCK requests are kept per Diamond, so a fresh deploy on a chain
never hands a keeper a request made against the retired one. A repeated
outcome report records and sends nothing. The wallet's alert settings row is
made when a link code is issued, and a code is refused if it cannot be, so the
"alerts will arrive" reply always has a row the watchers find.

A LOCK that no keeper answers within an hour now gets one message telling the
owner the vault may not be locked and to lock it from the app. The periodic
due-date reminder reads the linked chats once per batch, so it stays inside
the free plan's request budget.

The shared copies are emptied by a migration rather than copied across, so a
chat its owner removes can never keep receiving alerts from the old rows.
Testnet owners link Telegram again. The new state is not in the nightly
backup; it has the platform's own point-in-time recovery, and if it were ever
lost owners would link again.

Advances #1722. The keeper's move onto these routes is the next change, in the
keeper's own work; until it lands the keeper's Telegram messages are dark.

> Caveat: until the keeper uses the new routes, its Telegram messages (health-factor bands, pre-grace warnings, LOCK answers, protected-vault alerts) are not sent; Push is unaffected, and a LOCK is answered with "lock from the app".
> Caveat: the emptied shared tables and the `tg_chat_id` column stay until a follow-up drop.
> Caveat: owners on testnets must link Telegram again.

_Committed 2026-11-11 12:20 UTC (b3ba46e09)._
<!-- assembled-fragment: 1722-agent-telegram-state.md sha256=796527fecced1b70b228d4558f4ca9b36675048753de91da5230379690c7f6dd -->

## Keeper — the one-runner lease moves into the keeper's private database (PR #3549)

Every keeper tick first claims a single lease row, so that only one keeper
runner signs at a time. That row lived in the shared database, which the
indexer and the agent can also write: a compromised or faulty indexer or agent
could hold the lease with an expiry years away and stop every keeper action,
liquidations and defaults included, without ever touching the signing key.

The lease now lives in the keeper's private database, which only the keeper
binds. A new keeper migration creates it there, and both the tick and the
machine's renewal on a skipped minute claim it there. The claim also refuses
to honour a lease whose expiry lies further out than the longest term a keeper
ever writes (ten minutes): such a row cannot come from a keeper runner, so the
next claim takes it rather than waiting for it.

The old shared copy is no longer read by anything. It stays until a separate
drop-only shared migration, so that a machine still running the previous
release when the new schema lands keeps claiming where it did and is not
stopped mid-update. The restore procedure now clears the lease in the keeper's
database.

This advances #1722 (the shared-database trust problem). The other two parts
of that issue, the liquidity-confidence streak and unsigned Telegram lock
requests, are separate changes.

> Caveat: until the follow-up drop, the shared database still holds an unused `keeper_runner_lease` table.

_Committed 2026-11-11 05:14 UTC (a4d97fe51)._
<!-- assembled-fragment: 1722-keeper-runner-lease-private.md sha256=91c0e8873311ea76ac867dab1953220cab3cfc2c234f46e1bb94bd4f56093361 -->

## Keeper — Telegram alerts and LOCK requests go through the agent (PR #3576)

The keeper no longer holds the user-facing bot token or any chat id. Every
owner Telegram message it used to send itself (health-factor band warnings,
pre-grace warnings, protected-vault alerts) is now posted to the agent's
keeper routes as typed data, and the agent writes it in the owner's language
and sends it to the chat linked to the wallet then, or answers that no chat
is linked. Push is unchanged: the keeper still sends it, with the same
wording the agent renders. The keeper's own band memory remains the only
guard against a repeated warning, as the agent does not filter alerts. A
health-factor or pre-grace warning that no channel took, because the agent
or the Push rail could not be reached, is not recorded as sent, so the next
run sends it again rather than losing it.

The Telegram LOCK step works the agent's requests instead of the shared
table: it asks the agent for a chain's open requests (which is also how the
agent learns a keeper able to sign is working them), locks the vault as
before, and reports how each ended. The agent records the outcome and
answers in the chat, so the keeper sends no LOCK answer of its own. An
answer the agent recorded but could not deliver is not sent again, and the
run line says so; a report the agent already had is named as such. Releases
still wait on any account with an open request, now read from the agent.

Every request names the Diamond the keeper serves on that chain. An agent
serving another Diamond refuses it, and the keeper treats that refusal like
the epoch fence's own: the chain's run stops rather than act for a deployment
the two disagree on.

The Push text of a payout alert no longer suggests sending LOCK: only the
agent knows whether the owner linked a chat, so the suggestion travels in
the Telegram message alone. A token symbol is reduced to plain characters
before it is put in an alert, so an odd symbol cannot get the alert refused,
and an amount or NFT id too long to show whole keeps its first and last
digits around an ellipsis rather than being cut short unmarked.

Configuration: the keeper needs `AGENT_ORIGIN` (a plain var) and
`KEEPER_AGENT_TOKEN` (the same value the agent holds, written to both
together). Without them no Telegram alert is sent, the LOCK step does not
run, and each run says so. The keeper's `TG_BOT_TOKEN` binding and its
dead Telegram link helpers are removed. Advances #1722; follows the agent's
move of this state into its own storage.

> Caveat: the keeper machine needs `AGENT_ORIGIN` and `KEEPER_AGENT_TOKEN` set, and its old `TG_BOT_TOKEN` line deleted, before its Telegram messages resume.

_Committed 2026-11-11 13:26 UTC (c308346b9)._
<!-- assembled-fragment: 1722-keeper-telegram-through-agent.md sha256=606193d844181267102162cb5bf963bf9ae01eef41e270c0b275845d0deeb3df -->

## alpha05: the rate desk matches an overlapping pair (OFF-63)

The new app's rate desk now has a match band under a market's ladder. Where a lender's rate range meets a borrower's, anyone may match the lender's offer with the borrower's request. The protocol then opens the loan between the two who posted them, at the middle of the rates both accept. When the ladder's sides overlap, the band asks the protocol's own match preview about the best-priced pairs whose rate ranges meet, as the viewer would send the match. Where the best rates cross but no ranges meet, the band says nothing can be matched. It offers only a pair the protocol confirms. It names the pair, the loan amount, the rate, the collateral the borrower locks and the term.

Matching can be switched off for a network. When it is, the band says so instead of disappearing. When no pair can be matched, the band gives the protocol's reason for the best-priced pair. When a later pair is offered instead, it says why the best-priced pair was passed over.

The one who sends a match pays the gas and takes no side of the loan. A pair that holds an offer the viewer posted is never offered, and the band says so, because matching one's own offer would put one's own funds into the loan. They are paid a share of the loan initiation fee the borrower pays, but only if the match lands. The band states that share as an upper bound, because a borrower's fee discount is settled only at the match. It also says whether the match counts against the sender's matching capacity. The review says the loan belongs to the two who posted the offers and that someone else may match or take either offer first: if that uses an offer up, the match fails and moves nothing, and if part is left, the match can open a smaller loan and pay a smaller share. The finish card measures, from the transaction itself, the loan that opened and the share that arrived, counting only the vault's own record of the incentive payment, so a refund or the loan amount is never mistaken for the share.

_Committed 2026-11-11 11:18 UTC (97cbfd1aa)._
<!-- assembled-fragment: 3180-alpha05-desk-match-band.md sha256=60241d92c33ad50e00432f89d0fb07540383b4db6516a9d230d7dc70a7d9a89e -->

## Thread — alpha05 rate desk signs a new order from the ticket

The new app's order ticket can now sign an order instead of posting it. A signed order costs no gas and sets nothing aside: the wallet signs the order's terms, the offer book lists it, and when someone fills it the protocol draws the stake from the signer's own vault, checking then everything it would check of a posted offer. Until it lapses the order binds the signer, and only a cancel on the chain stops it, so the ticket refuses a signed order that never lapses.

The app signs only orders a fill can draw in one piece: token on both sides, one size, all or none, with no fee tariff and no price guard. A ranged or partial order could otherwise be filled in slices by the protocol's matcher. In signed mode the ticket says where the stake comes from and that the order fills whole, in place of the wallet balance and the fill choice.

The review shows exactly the order the wallet then signs, built once with its nonce when the review opens. It states the order, when it lapses, that it fills whole, that nothing is set aside now, what a fill would draw from the vault, and what the vault holds free of that token now, read from the protocol. If the vault holds too little, the review names the amount to add rather than blocking, since a fill draws on the vault as it stands then. It also says the protocol checks the order only when it is filled, and that the signature works only on this network and this deployment.

After one consent and one signature, the order goes to the offer book, and its answer is shown as it came: listed, refused with the book's reason, or not known. When the answer is not known, the signed order stays on this device with a button to send it again, because the book lists an order once. A listed order then appears under the wallet's signed orders on the desk. Advances #3180.

_Committed 2026-11-11 04:54 UTC (ee7faf708)._
<!-- assembled-fragment: 3180-alpha05-desk-sign.md sha256=1fb828e38452b07742f96676087459ad2355455e94b1f38787b08246222b90c0 -->

## alpha05: the rate desk lists every maker's signed orders (OFF-60, first slice)

The new app's rate desk now shows the gasless signed orders makers have placed on a market. They appear in their own section, apart from the ladder of offers posted on the chain. Lenders' orders run from the lowest rate and borrowers' from the highest. Each order names its maker and when it lapses, and shows where the chain stands on it: open, partly filled with what is left, filled or cancelled, stopped by its nonce, or lapsed. The offer book can lag the chain, so an order the chain has already cancelled is never shown as open.

A signed order sets nothing aside, so a fill draws the maker's side from the maker's own vault at that moment. For each order that can still be filled, the desk says what the maker's vault holds free now against what a fill would draw. That is either enough, short (a fill now would fail), or not readable. The desk also says that one maker's orders share one vault.

Filling a signed order is not offered yet. The protocol has no way to show a fill's figures before the taker pays, so the desk says this instead of offering a button. The fill follows once the contracts add that preview (#3552). The markets note and the ladder's count note now say where signed orders are listed.

_Committed 2026-11-11 06:58 UTC (9fedf398d)._
<!-- assembled-fragment: 3180-alpha05-desk-signed-book.md sha256=b80883fc8663fa283d4fa2a6eb516359a496852286a918528d3cb8eba4c78c2f -->

## alpha05: a signed order can be filled from the rate desk (OFF-60, second slice)

The new app's rate desk now lets a taker fill a gasless signed order that another wallet placed on the market. An open order someone else signed shows a "Review a fill" button. It opens the same acceptance review as an offer posted on the chain, so the taker sees the same receipt, consent and wallet steps.

The review's figures come from the protocol's own preview of the signed fill, not from the order as the offer book lists it. The review names the maker and the order's hash, what the fill would take from the maker's vault against what that vault holds free now, and that a fill takes the whole order in one transaction. If someone fills the order first or its maker cancels it, the fill fails, no loan opens and any approval the flow made is put back. Every refusal the preview reports is stated by name, a maker's vault that holds too little among them, and blocks the send.

The Terms the taker signs are keyed to the order's hash. The protocol cannot yet show its risk-access check for a signed order before the fill (#3577), so the review says that the dry run after signing makes it, and offers the step that clears a refusal for the order's pair. The finish card reads the new loan from the fill's own event.

A partly matched order is not offered, because a fill takes the whole order, and neither is the viewer's own. The fill needs the contracts' signed-fill preview, so it works on a chain once the next fresh deploy reaches it (#3552).

_Committed 2026-11-11 13:21 UTC (c147eb1d1)._
<!-- assembled-fragment: 3180-alpha05-desk-signed-fill.md sha256=caf3a8ee5222b235d912cdf35e0c70509eb36bfdf163464416243c1b964802eb -->

## Thread — alpha05 rate desk lists your signed orders and cancels them on the chain

The new app's rate desk now lists, on each market, the gasless orders the connected wallet has signed, and offers the only cancel that stops one: the cancel on the chain. A signed order is a signature over an offer's terms that the offer book keeps. Nothing is set aside for it, and anyone holding the signature can fill it until it lapses, so taking it off the book alone would not stop it. The panel says this before it offers anything.

The list is read from the offer book scoped to the wallet as signer, so other makers' orders can never push the wallet's own out of it. A row is kept only when its hash is the order's own and it names this wallet and this market; anything else is counted and said, and a list the book cut short is said too. Because the book can lag the chain, each order's standing is then read from the chain at one block: fully filled or cancelled (the protocol keeps one mark for both, at the order's ceiling), its nonce cancelled, lapsed on the chain's clock, partly filled by matches with the rest still fillable, or open. A cancel is offered on any order that can still be filled, and for a partly filled one the review states the share filled and only what the rest could still draw. Each order states both ends of any range it allows. If the latest standing read fails, the last good standings are shown as possibly out of date and no cancel is offered.

A wallet can cancel one order, or every order it signed with one nonce when the book lists two or more open orders under it. The review says what the cancel does, that it moves nothing and returns nothing because nothing was held, that a fill already sent can land first, and what a fill would have drawn from the wallet's own vault. A nonce cancel also says it stops orders under that nonce that the page does not list, on other markets or off this book. The protocol's own check runs before the wallet opens, a pause blocks the send, and the outcome is read from the transaction's own cancel event. The finish card stays on screen after the book drops the order.

Signing a new order from the desk comes next; until then the ticket still names signed orders as not available. Advances #3180.

_Committed 2026-11-11 03:29 UTC (f2d9dbfd7)._
<!-- assembled-fragment: 3180-alpha05-desk-signed.md sha256=c951177bf57787258252fc95ad0d1c9ec907b6d3ccace5b80047c295739c7a29 -->

## Thread — alpha05 rate desk order ticket

The new app's rate desk now has an order ticket below each market's ladder. A lender or a borrower can post an offer or request at one exact rate on the market the desk shows, in one compact form, without going through the guided steps.

The market fixes the two tokens and the term. The ticket adds the side, one amount, the collateral, the rate, how long the offer stays open and how matches may fill it. A partial or immediate-or-cancel ticket also asks for the smallest single fill. The protocol fills a match only between an offer's smallest and largest amount, so an offer of one size always fills whole, whatever its fill mode says. Every other term is the guided flows' default, and the ticket says each one in words: interest for the full term, no partial repayment, interest paid at repayment, no rate range, no collateral range, no fee tariff and no price guard.

Only the first thing in the way is shown, beneath the action, in a fixed order: the wallet, the network, the market, what the ticket still has to read, the term, then each field as it is typed. "Fill to balance" types the wallet's whole balance of the token the post locks, exactly. The fees are stated at today's list rates, and a figure that could not be read is said to be unread.

The ticket is always posted on the chain. Gasless signed orders are named as not available in this app yet, so the mode shown is the mode used. The review, the consent, the dry run and the risk warning are the same ones the guided flows use, and the Terms are accepted before the review opens. What a reader typed and agreed to is kept per market, so changing market never carries a consent across. Advances #3180.

_Committed 2026-11-11 01:50 UTC (7309eb770)._
<!-- assembled-fragment: 3180-alpha05-desk-ticket.md sha256=62d030f2f5a99481a7ca883db3c9d926a68991ab968f6f8e1886cef763cdf086 -->

## Thread — alpha05 sends every transaction with the shared gas margin

Every transaction the new app sends now carries a gas limit 30% above a fresh estimate. This is the same margin every other sender in the project uses, including the connected app and the keeper. Before, the app left the limit to the wallet, which sends at the node's bare estimate.

A bare estimate is the least gas the call needed in the latest block, and the transaction lands in a later one. A call whose cost grows with time, such as an oracle read or interest that accrues per second, can then run out of gas. When that happens it fails with no reason given. The connected app met exactly this on a loan acceptance mined one block after its estimate. Unused gas is not charged, so the margin costs nothing when it is not needed.

The estimate is asked of the wallet's own provider first, then of the app's own endpoints. When the call would be refused, or nothing can estimate it, the app sets no limit. The wallet then estimates and shows the refusal as before. The claim-everything batch keeps its stricter estimate and now takes the margin from the same shared rule.

All writes go through one sender, and a lint rule stops a new one from skipping it. Two protection screens that another change is reworking move onto it once that change lands. Advances #3180.

_Committed 2026-11-11 00:43 UTC (634e983f2)._
<!-- assembled-fragment: 3180-alpha05-gas-margin.md sha256=a366857506f30367928fc901be9a7848c0764ac257a207c92560371b5b63d103 -->

## Thread — alpha05 shows a lender the fee discount on each loan

A lender's loan page in the new app now has a section on the holding discount that applies to the protocol's share of that loan's interest. It shows the figure the protocol itself reports for this loan and this wallet. The app works nothing out on its own.

Since the contract change #3562, a lender's discount on a loan is the lower of two figures: the discount they held when they took the lender position, and the discount they hold when the share is charged. The page explains which of the two applies now. If the figure from when they took the position is the lower one, the page says the discount is capped and that VPFI added since does not raise it on this loan. If the discount now is the lower one, it says a later fall in tier would lower the discount at that settlement. If the protocol recorded no figure for this wallet, the page says no holding discount applies.

The holding discount only applies while the wallet's fee-discount setting is on. When the setting is off, the page says so and links to it. When the setting could not be read, the page says that too. The Advanced view also shows both figures and their tiers, when the first one was recorded, how this network delivers the discount, and whether a Full fee tariff paid for the loan adds to it. Each of these says it is unknown when it could not be read, and never shows a guess. The borrower sees no lender discount.

The testnets' current contracts do not report the per-loan figure yet. Until the next fresh deploy, the page says the figure is not reported by this network, never that the discount is zero. The fee-discount setting's own explanation now describes the lower-of-two rule as well. Advances #3180 and closes #3586.

_Committed 2026-11-11 19:04 UTC (5fc79ad6d)._
<!-- assembled-fragment: 3180-alpha05-lender-discount.md sha256=bc865a151c54327def5b24a6f39612d0e2e84ebdff93dd25b1393712b7a500b5 -->

## Thread — alpha05: is the reward programme running here?

The new app's Rewards page now opens with one sentence saying whether the reward programme runs on the wallet's network. It is called running only when the programme's start time has passed, the network holds a reward role that pays there, and VPFI is held to pay rewards now. Otherwise it says the programme runs with nothing held to pay rewards, has no start date, starts at a stated time, or that the network has left the reward network and nothing new becomes claimable there. On a network funded from VPFI's home network, a claim can also be paid from VPFI sent for a particular day; that VPFI is held day by day and has no network-wide figure, so there the sentence says no standing VPFI is held while that day's VPFI can still pay, and never that nothing can pay. If a fact that decides the sentence cannot be read, the page says so and never shows the programme as running.

A global pause is stated by name on the same card, with what stays open: reward claims and withdrawals stop, while full and partial repayment and adding collateral stay available. A pause that cannot be read is stated as well.

Advanced lists every fact behind the sentence, read from the protocol at one block: the network's reward role (home network, reporting network, no role set, or detached) and, for a network retired for good, where its leftover reward VPFI goes and how much went; the start time; the VPFI delivered for rewards and the VPFI recycled from fees that a claim can draw on now, net of what pending settlements reserved; whether reward VPFI sits in its own custody contract; and whether unclaimed rewards can be removed. A reading the network's contracts do not offer is named as such. Whether the daily close runs is not read here, and the card says so. Advances #3180.

_Committed 2026-11-11 23:32 UTC (bb24b2873)._
<!-- assembled-fragment: 3180-alpha05-reward-programme.md sha256=f6e7ce94333bdbff2d9414d2adbc9d04a9ad1733884ce0e29007a1f4138b3de7 -->

## alpha05: a signed fill's risk-access check shown before signing (#3577)

The fill review on the new app's rate desk now reads the protocol's own preview of the risk-access check for a signed order, which the contracts gained in #3582. Before, a signed order had no such preview, so the check was made only by the dry run after the taker had signed the terms.

The preview reports the maker's block and the taker's separately. When the maker's own risk setting no longer covers the pair, the review says so and nothing can be signed or sent, because no step of the taker's can clear it. When the taker's setting does not cover it, the review offers the step that clears it, for the exact pair the protocol names, before anything is signed, the same way a stored offer's review does.

Where the preview cannot be read, the review keeps the earlier behaviour and says so: the dry run after signing makes the check, and a refusal there offers a step only when the refusal names the taker. The test networks are in that state until their next contract refresh carries the new view.

_Committed 2026-11-11 18:22 UTC (4933e8dbf)._
<!-- assembled-fragment: 3180-alpha05-signed-fill-risk-preview.md sha256=112124ff280e9d72db69f32d43521ec128f177fec50d2b89afe8ac1f7fa8a053 -->

## alpha05 — signed orders held for a re-check after a reorganisation (PR #3583)

When the chain replaces some recent blocks, the indexer re-reads the fills and cancels of the signed orders it holds (#3411). Until it has, it leaves those orders out of the shared book and counts them, and it still lists them to their maker, flagged. The new app now shows both.

On a market's desk, the signed-order section says how many orders the book is holding back. A shorter list is therefore never read as the whole book, and an empty market with held orders does not say the book lists none. If the book's count cannot be read, the section says the list may be incomplete instead of assuming nothing is held.

In Your signed orders, a held order is marked on its row. The row says the shared book leaves it out until the re-check ends. Its standing is still read from the chain. Only while a fresh standing shows it can still be filled does the row add that anyone holding the signature can fill it and that you can still cancel it. The rate desk's user-guide sections in both editions and all ten languages describe this.

The rule for a risk refusal during a signed fill is also written into the rulebook. The step to clear a refusal is offered only when the refusal, decoded from its own bytes, names the taker's wallet. This shipped with the fill itself (#3578).

Advances #3180 (the new app) and follows the indexer's reorganisation guard (#3411, #3528).

_Committed 2026-11-11 17:32 UTC (b075d1827)._
<!-- assembled-fragment: 3180-alpha05-signed-replay.md sha256=59da9d54e435f4a0a84c8a7d537cb30e0b16a1b1be6e21cf547c72c62c3d904a -->

## Thread — alpha05: your fee-discount tier on other networks

The new app's Rewards page now shows the wallet's fee-discount tier on the protocol's other networks and lets the wallet send it there. Since the protocol's rule of #1277, the protocol pays for a cross-network message only when it lowers the discount another network grants. A higher tier, a first discount, or a tier under a new tier table reaches another network only when someone pays its message fee, so a user whose tier rose has to act, or their other networks keep the older copy.

On VPFI's home network the section reads the protocol's own status at one block: the tier recorded for sending, what each other network last received, whether that network is still owed the record, and who pays for that message. It says when the record is behind the tier the protocol applies now and offers to update it, for network gas only. Each network shows whether it is up to date, owed a lower tier the protocol sends at its own cost, or owed one that goes only with a paid send, with the fee the messenger quotes now.

The paid send is offered once the record matches the tier now and every owed network's fee is quoted. The wallet sends the sum of every owed network's quoted fee plus a 20% margin, because the protocol spends the value on owed networks in its own order, and whatever the messages do not use comes back in the same transaction. The receipt states that each fee pays one message and is not refunded once sent. The outcome is measured per network from the status at the receipt's block, together with the fees the wallet's value actually paid.

The section is shown in Basic as well as Advanced, a departure from the feature matrix, whose rows predate #1277, because acting on it is now the user's job. Away from VPFI's home network it says a higher tier is sent from there. Advances #3180 and closes #3579.

> Caveat: the tier table's version has no reader, so the app cannot tell a record that is behind only on the table version; the update stays offered and the copy says so.
> Caveat: the live testnets predate #1277 until the next fresh deploy, so there the section says this network's contracts predate the rule.

_Committed 2026-11-11 21:53 UTC (05673c5c6)._
<!-- assembled-fragment: 3180-alpha05-tier-elsewhere.md sha256=7f3450c148fab71585c2e415fc0c7fac92af79cb99a2e691f25bbfd8636f29e9 -->

## Thread — Range matches fill the largest amount both sides accept (PR #3591)

A permissionless range match used to lend the midpoint of the two offers' amount overlap. A lender offering up to 100 against a borrower wanting up to 100 got a loan of about 50 plus the minimum, and reaching the full amount took further matches, each its own loan paying its own gas and matcher share. The midpoint is a fair split for the rate, because neither side should take the whole surplus. For the amount it has no fairness reason: both parties said they accept anything in the window.

A match now lends the largest amount both offers accept. That is the smaller of the lender's remaining capacity and the borrower's remaining request, capped at what the borrower's available collateral covers at the lender's pro-rated requirement and at the most that collateral may back under the loan-initiation risk rule, and never below either offer's minimum fill. The collateral locked rises, where needed, to the least amount that passes that risk rule, within what the borrower's offer supplies, so the largest amount is never one the risk check would then refuse. Before, a pair whose collateral covered the midpoint but not the top of the window still matched at the midpoint. Now it matches at the most the collateral covers rather than being refused. The rate is still the midpoint of the rate overlap. All-or-nothing offers and refinance carry-over matches keep their own amount rules. The match preview, the signed-offer matcher and the lender-intent fill run the same rule, since they share one match core.

Owner decision 2026-11-08. Closes #3326.

The loan-initiation risk bounds (the collateral floor for an amount and the largest amount a collateral backs) now have one host, the offer-preview module, which the match, the preview, the signed-offer matcher and the intent fill all ask. Before, each carried its own copy, and the four match modules sat close to the contract size limit. A curated facet refresh refuses a Diamond that does not route that host yet.

_Committed 2026-11-11 20:17 UTC (51a394acf)._
<!-- assembled-fragment: 3326-range-match-largest-amount.md sha256=aee1b8f6e0cb670f11b3deaf6775dd74804d2fbfc49d34b2161bbee36d9f5967 -->

## Thread — The keeper returns a closed day's reward leftover from a mirror to Base (PR #3560)

A reward mirror pays each day's claims from the batch of VPFI Base delivered
for that day, and a claim takes only what it pays. What the loan-side reward
cap or the per-wallet daily cap trims, and any reward nobody claimed, stays in
the batch. Since PR #3555 a keeper may send that leftover home once the day is
proven closed. This change adds the keeper step that does it.

It is a new step of the return-transport pass, which already carries every
other return from a mirror to Base, and it has its own switch on top of that
pass's switch. On each run it reads the batches the indexer saw open on the
mirror, a page at a time, and for each one whose day is proven closed it sends
what the batch still holds back to the Base that delivered it. Each part is
sized to what the batch holds, to what its delivery still holds untyped, and to
the cross-chain lanes at both ends, exactly as the pass's other returns are.
The keeper pays the transport fee from its own wallet, and the pass's notices
in the ops channel announce each send with its amount.

It sends nothing whose destination it cannot confirm: Base must be a chain it
serves, the Base Diamond there must be the one that sent the delivery, and
Base's return receiver must deliver to it. It leaves a leftover the operator
has already acknowledged, because that releases it for classification on the
mirror, which is the operator's call; the run's line names any such leftover
still holding value. A batch a staging record still references, or whose
delivery has a live stranded-recovery record, waits until those settle.

The step ships switched off. Arming it is an owner decision, needs the
return-transport pass armed too, and needs the keeper role on each mirror.

Advances #3360.

> Caveat: until the step is armed, each closed day's leftover waits on its mirror, held and accounted.

_Committed 2026-11-11 07:32 UTC (4f4d858a9)._
<!-- assembled-fragment: 3360-keeper-closed-day-remainder-return.md sha256=e5277263cb38d10061d55efe54f3c1a4c14ef0532c24756c88dd6f66b763443e -->

## Thread — Mirror loans carry the fee-linked reward cap, and a keeper returns a settled day's leftover to Base (PR #3555)

Every token loan opened on a reward mirror chain now records its lifetime
reward ceiling when it opens, exactly as Base loans have since the first half
of this work. Before this change a mirror loan had no per-loan ceiling, so two
wallets of one person could lend to each other there and earn VPFI bounded
only by the per-wallet daily share, which more wallets get around. Recording
the ceiling charges nothing.

A mirror pays its users from the VPFI Base delivered for each reward day, and a
claim takes only what it pays. So the part the ceiling or the daily share cap
trims, and any reward nobody claimed, stays with that day's delivery. Once the
day is proven closed (every loan and claim covering it has ended and nothing
can draw on it again), a keeper can now send that whole leftover back to the
Base that delivered it, which adds what arrives to its recycle bucket. The
keeper can send it only home and only after closure, chooses the size of each
part so it fits the lane, and pays the transport fee itself; no operator step
is needed. The operator's existing route, which needs the operator's
acknowledgment, stays available. The keeper pass that makes this call ships
switched off, so until an owner arms it the leftover waits on the mirror, held
and accounted.

The launch check that the reward cap is armed before any loan now applies on a
mirror too. A mirror does not arm the cap itself: it learns the first armed day
from Base's broadcast. So a mirror launches only after Base has armed the cap
and that broadcast has reached it, and on or after that day; until then its
check says so by name.

The owner chose this design: the cap on every chain, with the
leftover returned by a keeper rather than by an operator step.

Advances #3360.

> Caveat: on the next fresh testnet deploy each mirror's launch waits for Base's broadcast of the first armed day.
> Caveat: the returned leftover moves only once the keeper pass is built and armed.

_Committed 2026-11-11 06:47 UTC (743063b36)._
<!-- assembled-fragment: 3360-mirror-reward-cap-and-keeper-return.md sha256=8193117c34665d3159dd848863ce959d08e104f0b9a3a93e863de8deaf03a507 -->

## Keeper — private route: several endpoints, a provider method, and a timed public fallback (PR #3529)

Advances #3408 (keeper side). On a public-mempool chain the keeper's protective transactions (the Telegram LOCK, forced sales, liquidations, every send its key makes on that chain) already went through a private submission endpoint (#3240). That route now matches the owner's 2026-11-09 decision.

A chain's private route can name several endpoints, tried in the order the operator wrote them, each with the same signed transaction and eight seconds to answer, so a later endpoint is the fallback for an earlier one. An endpoint may be called with a provider's private-transaction method instead of an ordinary raw submission. That is how the RPC provider the keeper already uses offers private submission on Ethereum mainnet, with free private endpoints behind it.

On a chain the operator allows a public fallback, a transaction a private endpoint accepted but that is still unmined after a stated time (a new setting, 24 to 180 seconds, default 60) is sent once through the chain's ordinary RPC as the same signed bytes. It goes out on the first tick after that time. Each accepted private send is recorded with its bytes in the keeper's private database (keeper migration 0008), so the copy survives a restart. No copy is sent in the last minute of the keeper's seven-minute nonce window, which counts from when the nonce was recorded before the first private attempt, because once the window has passed a later send may hold the nonce; such a send is reported with its outcome stated as unknown (and as possibly public, when an earlier public copy got no answer), and its record is kept until that report is made. Each chain is swept on its own, so one chain's failing RPC cannot use up the time another chain's copies need.

Every public fallback, whether every endpoint failed or the accepted send did not land, now posts an ops alert naming the transaction (one per chain per ten minutes, every one logged), because the transaction is public from then on. The per-tick route line names each chain's endpoints in order by provider domain only, and the method where it is not the ordinary one.

Nothing changes until an operator sets these values: no testnet chain has a private route today, so the change ships disarmed. Keeper migration 0008 must be applied before the machine runs this build (the keeper's deploy applies it).

Not in this change, and tracked on #3408: relaying users' signed lock and cancel messages waits for the signed-lock entry of #3423; the sanctions adder is a separate service with its own sender; the guardian and watcher pause transactions are not sent by the keeper; and Polygon PoS has no keeper chain entry yet.

> Caveat: the inclusion fallback runs on the minute tick, so a public copy can go out up to a minute after the stated time.

_Committed 2026-11-11 04:44 UTC (9dc3fab69)._
<!-- assembled-fragment: 3408-keeper-private-route-fallback.md sha256=031e0a4b39afbb12cb027c5f613c17bee122488c2fd2648404cd9e892b6122cc -->

## Thread — Two facets split to make room for the outage clock (#3410)

The work for #3410 (an L2 sequencer outage moves a loan's grace end) adds a
small read to every facet that checks a loan's grace end. Two facets had no
room left for it under the EIP-170 contract size limit: PrecloseFacet and
AutoLifecycleFacet. Each is split along a boundary that was already there,
before the #3410 change lands, so that change stays reviewable on its own.

PrecloseFacet keeps the direct early close and the obligation handover. The
borrower's offset route (posting a new lender offer that offsets the loan,
and closing the loan once someone accepts it) moves to a new
PrecloseOffsetFacet. The completion step was already reached across the
Diamond by its selector when a third party accepts the offset offer, so
nothing calls it differently. The steps both facets take (who may act, which
asset is paid, the lender's fee discount, the rental reset and the position
marking) now live once in a shared library instead of as private copies.

AutoLifecycleFacet keeps the in-place extension, its window and the
extension reserve. The consent and limits settings (auto-lend consent,
opt-in on new loans, refinance limits and extension limits, with their
readers) move to a new AutoLifecycleSettingsFacet.

Nothing changes for users or integrators that call the Diamond: the
selectors, arguments, events and errors are the same, and only the contract
that holds the code differs. Off-chain code that reads one facet's ABI file
instead of the combined Diamond ABI has to read the new file for the moved
functions; the keeper's auto-extension and pre-grace passes are updated in
the same change. The facet refresh scripts carry both halves of each split,
so a refresh never leaves half of a route on old code.

Advances #3410.

_Committed 2026-11-11 04:26 UTC (739f83c1a)._
<!-- assembled-fragment: 3410-facet-room-split.md sha256=2bd791f79ca242c826b4c1f5455845269f7f663fc947aa39ff3be150e05e7d51 -->

## Thread — Loan deadlines wait out an L2 sequencer outage (PR #3551)

On an L2, the sequencer can stop for a while. Nobody can send a transaction during that time, so a borrower whose grace period ended inside the outage could not repay and was defaultable the moment the chain came back. Liquidations already waited for one hour after the sequencer recovered; time-based deadlines did not.

Now a loan's grace end that falls inside an outage, or inside the hour after it, moves to the end of that hour. Until then the loan cannot be defaulted and the borrower can still repay in full or in part from their own funds. A partial repayment's health-factor check needs a price, which the window refuses, so it is skipped there: a partial lowers the debt and leaves the collateral, so it can only raise the health factor. Swapping collateral to repay needs a price for the sale itself, so like a liquidation it can run only once the recovery hour has passed, which is also when the loan becomes defaultable again. The loan's due date itself does not move: an outage changes when a deadline can be enforced, not the loan's term or its interest.

A periodic interest settlement deadline is not moved. Settling a missed period sells collateral, and that sale needs a price, which the price guard already refuses until the recovery hour has passed. So no settlement sale can happen inside the outage or its recovery hour, and moving the deadline as well would add nothing that is enforced.

No late fee runs for time inside the outage and its recovery hour, whether the outage covered the due date or came later. A grace-period auto-listing of NFT collateral also waits until the recovery hour has passed. The loan's published deadlines read (the one that already reports the pause credit) reports the moved grace end.

The outage is read from the same sequencer uptime feed the price guard uses for liquidations, through a new read on the price guard. Nothing is recorded on-chain, so only the latest outage is known: an earlier outage's time is not excluded from a late fee charged after a later one. Where no sequencer feed is configured (an L1), nothing changes.

This changes the loan-clock family that every deadline reader shares, and the price guard gains a function, so it reaches the testnets at the next fresh deploy.

> Caveat: a swap to repay cannot run inside the outage window, so a borrower relying on one has it only from the window's end, in competition with a default.

> Caveat: an off-chain surface that computes a grace end itself, instead of reading the loan's published deadlines, does not see the outage; such surfaces should read the moved deadline or say an outage is in progress (#3525).

Closes #3410.

_Committed 2026-11-11 06:03 UTC (e8410e0ca)._
<!-- assembled-fragment: 3410-sequencer-outage-loan-deadlines.md sha256=383195df7a02e921dec694dec5bf0019f648a74ccd45d3e75c5294329ce0ad9a -->

## Indexer and app — pending actions shown at once, marked not final (#3411 part 2)

The indexer records an event only once the chain reports its block as safe, which keeps anything the platform acts on away from a block that can still be replaced. The cost was a delay of several minutes before a fresh action showed up in the app.

Each indexer pass that has caught up to the safe block now also reads the blocks above it, up to the chain's newest block, and keeps what it finds as a separate pending list for that chain, replacing the previous one. Once the safe block passes a pending event, the normal scan records it and it leaves the pending list. If the chain replaces a pending block, its events are simply missing from the next read, so nothing has to be rolled back. The read is bounded, and the list records how far it reached, whether it kept every event, and when it was made.

The Activity feed can ask for the pending list alongside its first page. Pending events come back apart from the settled ones, marked as not final, with the block's hash and no time. A list that is missing, more than five minutes old or unreadable comes back as "not known", never as an empty list. An event the settled feed already holds is never repeated in the pending list. A change in the pending list also sends the "activity updated" push, so an open Activity page refreshes at once.

In the app, the Activity page shows the wallet's pending actions under "Not final yet", each marked "Pending, not final yet" in place of a time, with a note that the chain can still replace them. When the pending list is incomplete or not known, the page says that very recent actions may not be listed yet. Inbox notifications and alerts are still sent only for settled events.

_Committed 2026-11-11 07:11 UTC (faaef6958)._
<!-- assembled-fragment: 3411-pending-lane.md sha256=5a2c645afff140390321fda0ee3b5d1c43ce0414bb9948bb95cb322d9597df67 -->

## Indexer — catching a reorganisation below the settled block (PR #3528)

The indexer already reads each chain only up to the block the chain itself reports as "safe", so it uses no fixed confirmation counts. What it lacked was any way to notice a chain replacing a block below that point afterwards. Its cursor only moves forward, so rows written from a replaced block would have stayed wrong for good.

The indexer now records, with every cursor advance, the hash of the last block of the range it scanned, in the same database write as the cursor. That hash is read before the range's events, so a replacement that lands while the pass is reading is caught by the next pass instead of being remembered as correct. Every later pass reads that block again by number. If the chain reports a different hash there, it has replaced a block the indexer already wrote rows from. The pass then asks for the chain's rows to be rebuilt, and the next pass carries it out: every row the replay derives is cleared, and the scan replays from the deploy block against the chain as it now is. One remembered block per chain is enough, because replacing any earlier block changes the hash of every block after it.

A rebuild is narrower than the reset a new Diamond gets, because the Diamond is the same. It keeps every row born off chain, the same rows a restore from backup keeps: users' signed orders are kept, with their filled or cancelled state worked out again by the replay, and alert settings, alert dedupe records, Telegram links and support tickets are kept. A check in the build holds the list of kept tables equal to the table classification, so a new user-owned table cannot be wiped by a rebuild unnoticed.

A kept signed order is not offered on the book again until the replay has re-read the chain as far as it had been indexed before the rebuild. Until then an order that had in fact been filled or cancelled would look live, so the shared order book leaves these orders out and reports how many of the market's orders are waiting (`awaitingReplay`). The maker still sees each of their own waiting orders, marked as being re-checked, and can still cancel it: its signature stays valid on chain, so cancelling must remain possible. On the Rate Desk, the market note says the offer book is re-checking some signed offers, and an empty list does not claim the market has none. They return, and the market summary is recomputed, in the same write that moves the scan past that point.

A rebuild is the rollback because loan and offer rows are updated in place by later events, so a replaced block cannot be undone row by row. It is reserved for an event the chain said would not happen. To keep one bad provider answer from wiping a chain, a different hash must be seen on two reads in a row. A failed read, or two reads that disagree, holds the scan for that pass, in the same way a missing safe block does.

A chain already indexed before this change anchors its cursor where it stands on the first pass. The steady-state cost is one extra block read per pass and no extra database query, because the anchor is read in the same query as the cursor.

Advances #3411. A second part, showing recent events as pending until they are final, follows separately.

> Caveat: during a rebuild, that chain's offers, loans and activity are incomplete until the replay catches up.
> Caveat: the new app shows a maker's waiting orders in its own list as ordinary open orders, without the re-checking note the Rate Desk shows.
> Caveat: the chain's in-app notification inbox is derived from chain events, so a rebuild recreates it and its entries come back unread.
> Caveat: the remembered block can sit just above the cursor when a pass stops short of its range, so a replacement of blocks not yet indexed can also start a rebuild. That is the expensive direction, chosen over missing one.

_Committed 2026-11-11 05:43 UTC (26c79b122)._
<!-- assembled-fragment: 3411-reorg-guard.md sha256=097b8979f3e0b6606be1b5368c81008c9121d907e16b3f6f3897ff608295be2b -->

## Thread — Treasury conversions get an on-chain minimum output (PR #3518)

A treasury conversion used to take its minimum outputs from the admin caller, so a wrong or compromised call could set them near zero and let the swap be sandwiched at the treasury's expense. Every swapped leg is now held to a minimum the protocol works out itself: the oracle value of what the leg sells, read the way a liquidation prices its sale, less the same slippage floor a forced sale's market conditions give it (the tighter depth-tier figure when the pair is deep and calm, the full liquidation slippage cap otherwise). The caller can only ask for more, never less.

The forced-sale floor rule was split so its market half (depth, a current price, a calm pair) is shared: liquidations add the cushion test on top as before, and a conversion, which has no debt, uses the market half alone. So every swap the protocol starts follows one slippage rule rather than two.

A leg whose pair has no current price is now refused by name instead of swapped with no floor, and a price whose sources disagree refuses the conversion until they agree. Each leg records what it sold, what it got, its oracle value, the floor applied and the minimum enforced, so a conversion's price protection is on the record.

Governance can also cap, per input asset, how much one conversion call sells. A large balance is then converted in tranches, each priced and floored on its own, with the remainder left credited to the treasury.

Buybacks are unchanged: they already sell through intent auctions over a bounded window with a per-token tranche cap. VPFI has no protocol price source by design, so their minimum VPFI cannot be oracle-derived, and the specification now says so. The governance runbook records the multisig procedure the owner set: where the treasury is an external multisig, it converts only through batch or intent auctions or a time-weighted schedule, in tranches, never a plain public swap.

Closes #3414.

> Caveat: a treasury input asset with no oracle price can no longer be converted on-chain; it stays credited until it is priced.

_Committed 2026-11-11 01:32 UTC (0d153dc25)._
<!-- assembled-fragment: 3414-treasury-swap-floor.md sha256=40f44209316ee8e59689542f6ba2c556f455e6ffe5556990158ea2d2f6851ed2 -->

## Thread — Positive flows broadcast again, in stages (PR #3575)

Since the offer-age rule (#3412), an offer or a lender intent can be filled
only once its terms have stood a minimum age (5 seconds by default). Since the
transfer cooldown (#3413), a position NFT cannot move until a few seconds after
value last left its position, so a loan cannot be opened and handed on at once
either. One `forge script --broadcast` cannot wait between its own
transactions: forge simulates the whole run first and then sends every
transaction back to back, so the positive-flow scripts, which post an offer and
then fill it, stopped before sending anything. That left rehearsals with
nothing on chain.

The lifecycle, advanced-credit, lender-intent and position-holder modules now
run in stages. Each scenario is a list of steps, split wherever it fills terms
it posted or moves a position it opened. A new runner, `run-staged.sh`,
broadcasts one stage per `forge script` call and waits between stages for the
longer of the two rules: on a local Anvil it steps the clock, and on a live
chain it waits for the chain's own clock. A read-only finish then prints each
scenario's result and removes the run's record. Scenarios never interleave.
Each runs to its end before the next starts, so a price or an admin switch one
of them moves is never seen by another. A step that moves one puts it back
within the same step.

A stage runs only on top of a stage that landed whole. Forge writes files
before it sends anything, so the record also carries every actor's account
nonce as the stage's simulation left it. The next stage, and the finish,
refuse to continue when any account on the chain differs, and name the record
to remove for a fresh run. Without this check, a broadcast that stopped
part-way would let a later stage act on positions that do not exist. A
transaction that is mined and reverts still uses its nonce, so the next stage
and the finish also read forge's own log of the stage's broadcast, tied to the
record by those nonces, and refuse unless every transaction in it has a
receipt and every receipt is a success. A step that reverted on chain can no
longer be reported as passed.

Two things a broadcast does that a simulation does not are now allowed for.
Interest accrues by the second, so a repayment approves the simulated amount
plus an hour's interest. The runner also gives each stage twice the gas the
simulation measured, because a loan opened and repaid in one step accrues no
interest in the simulation but does on chain, and the fee legs cost more gas
(a measured repayment ran out of gas at forge's default margin).

`PositiveFlows.s.sol` is now documented as a simulation, which is all it can
be until every module is staged. A dry run needs `--skip-simulation`.
Otherwise forge replays the recorded transactions at the chain's own clock,
without the clock steps the scenarios took, and reports a failure after every
scenario has passed. The partial-refresh rehearsal drives its sale scenario
through the staged runner.

Several scenario checks had been failing on main since value began landing in
vaults (#3205 part 2), because they measured wallets. They now measure where
the value actually goes, through one shared vault-balance read:

- the range-match matcher's fee share, worked out from the borrower's vault;
- the treasury's initiation fee, from the borrower's vault plus the matcher's
  share that still returns to the borrower's wallet on a direct accept;
- the collateral and repayment a moved position's new holder receives, which
  arrive in that holder's vault at close-out;
- a full swap-to-repay's lender share, in the lender's vault, and the unsold
  collateral, which never leaves the borrower's vault.

A partial swap-to-repay still pays the lender's part to the lender's wallet,
and a full one pays the borrower's surplus to the borrower's wallet. The
scenarios assert those destinations as they are today; moving them into vaults
belongs to #3268.

The treasury scenario no longer points an external-treasury deployment at the
Diamond to try the withdrawal half. A vault pays treasury fees only to the
treasury fixed in its code (#3431), so after that switch the next accept was
refused. The withdrawal half now runs only on a deployment whose treasury is
the Diamond. #3569 tracks making the treasury setting say that a treasury move
is a vault code change.

Advances #3502. The partial and negative flow scripts, the remaining modules
and the Sepolia seeding scripts are not staged yet. The timed module (cancel
cooldown, periodic checkpoint) keeps its own stages for now, and its open stage
has also stopped since the offer-age rule, because it opens the periodic loan
by filling an offer it just posted. #3574 moves it onto the same runner, so the
tree has one staged pattern, and then stages the rest.

> Caveat: the timed run, the partial flows, the negative flows and the vault, keeper, operator and swap-to-repay modules still stop under `--broadcast` with `TermsAgeNeedsStagedRun`; run them as simulations until #3574 stages them.

_Committed 2026-11-11 12:46 UTC (2050a493f)._
<!-- assembled-fragment: 3502-staged-positive-flows.md sha256=679c51da11ba0a49d80084b22a8bdf4cd58e658998ae65d18da4454512081c21 -->

### alpha05: a one-size offer no longer promises to fill in parts (#3520)

The guided Borrow and Lend forms offered "Partial" and "Immediate or cancel" even when the amount had one size. The protocol fills a match only between an offer's smallest and largest amount, so an offer of one size only ever fills whole, whatever its fill mode says.

Now one rule in the posting model decides it for both forms. A fill mode that fills in parts needs a range. Without one, the form shows "All or none" as the mode, greys the other two with the reason, and posts the offer as all or none, which is what it does. With a range, the form carries the mode chosen for it, as before. The review states a fill mode only for a range, where it is a choice.

The desk order ticket already applied this rule through its smallest single fill. Offers posted before this change keep the mode they were posted with; they fill the same way.

Closes #3520

_Committed 2026-11-11 09:24 UTC (d79e50f10)._
<!-- assembled-fragment: 3520-alpha05-one-size-fill.md sha256=99f23c3329e432eedd281c0ef5d053fa0d9d5419598f8998e5bff516cf472f65 -->

## Thread — CCIP lanes born limited, NFT deposits checked on arrival (PR #3559)

Two hardening items from the external security review, filed together as one card because both close a window where the platform trusted something it had not checked.

CCIP token-pool lanes are now added with their inbound and outbound rate limits already switched on. Before, the configure step added each lane with both limits off and then set them through the rate governor in a later transaction, so for a short time a freshly added lane could move VPFI with no cap. The lane is now created at the run's capacity and refill figures, and the governor's call that follows only re-asserts them. The figures are checked against the governor's bounds before the script broadcasts anything, so a run with a capacity or rate the governor would refuse stops before it touches a chain. The deployment rehearsal test now adds its lanes with the script's own builder and checks that each lane is limited from the moment it exists.

NFT deposits that back an offer or a loan are now checked on arrival. Offer creation and offer acceptance each carried their own private copy of the code that moves an ERC-721 or ERC-1155 into a vault, and neither confirmed the transfer worked. Both copies are deleted. Those deposits now go through the vault's own deposit routes, the same ones a direct NFT deposit already used, which check after the transfer that the vault owns the ERC-721 token, or that its ERC-1155 balance rose by exactly the offered quantity. A token that reports success without moving the NFT, or moves fewer units, is refused, so no offer or loan records an NFT its vault does not hold. The two refusals now name the token, the token id and the vault (or the units asked for and received) instead of a generic "deposit failed" message. Removing the copies also returns a few hundred bytes to the offer-creation facet, which was close to the contract size limit.

Closes #3539.

_Committed 2026-11-11 08:08 UTC (d71742a09)._
<!-- assembled-fragment: 3539-lane-limits-and-nft-delivery.md sha256=cc7cbcd9f029d12cb832673c9e2290c664ba4ea932311c2d28a5aae475b983fd -->

## Contracts — the price-guard pointer waits at least the guard's own seven days (PR #3567)

The price guard refuses any delay under seven days for changes to its own
sources and settings. The protocol registry, which tells the Diamond which
guard to use, only required three days for any pointer change. So pointing
the registry at a brand-new guard was a faster way to change every price
than changing a setting on the guard itself, which undercut the guard's
seven-day review window.

The registry now holds a fixed minimum wait per entry. The price-guard
pointer's minimum is seven days, equal to the guard's own floor, and a
proposal for it waits the longer of that and the registry's current delay.
Every other entry keeps the registry's delay (three to thirty days), so the
treasury, backstop and adapter changes are not slowed. The minimum is a
constant in the registry's code rather than a figure read from the guard
being replaced, so the outgoing contract never decides how long its
replacement waits. A test keeps the two seven-day figures equal.

The registry is not upgradeable, so this reaches a chain only with a new
registry, at the next fresh deploy. Unlike the guard's own delay, which a
testnet may set to zero, the registry has no testnet exception: a testnet
guard swap through the registry waits seven days too. Testnets change
guards by fresh deploy, so nothing in current operation waits on it.

Closes #3540.

_Committed 2026-11-11 10:02 UTC (71dcaa7b7)._
<!-- assembled-fragment: 3540-price-guard-pointer-seven-days.md sha256=37f521a50a19cc3c17feb5ce6c39d709df106c80217021c340cdf642c25cdf81 -->

## Thread — CI secrets move to a main-only environment (PR #3558)

Every secret the CI workflows use, other than the built-in GitHub token, now
lives in a GitHub environment that only the main branch may use, instead of
at the repository level. Before this change any workflow that ran could read
those secrets, including a copy edited on a pushed branch, so anyone able to
push a branch could reach the project-board token, the backup archive and
ledger keys, the ops alert credentials, the Cloudflare read token and the
Claude token. Now a branch run receives none of them, whatever its workflow
says. Each job that reads a secret also checks that it runs from main, as a
readable statement of the same rule.

The Claude workflow no longer answers mentions in inline pull-request review
comments, because those events run the pull request's own copy of the
workflow and cannot be admitted to a main-only environment. Mentions in issues
and in the pull-request conversation still work.

The release workflow now checks the tag's shape once, before anything uses it,
and passes it to later steps as data rather than pasting it into a script. Its
checkout no longer keeps a GitHub credential.

The secrets themselves move in the repository settings, which an owner does;
the steps are in the pull request and in the project procedures (section 7.7).
A workflow linter and an offline docs link check follow in #3548.

Advances #3541.

> Caveat: until the owner moves the secrets into the environment and deletes the repository copies, branch runs can still read the repository copies.

_Committed 2026-11-11 07:05 UTC (0c2bcc4cd)._
<!-- assembled-fragment: 3541-ci-secrets-main-only.md sha256=e653461496ff943b2cee3e8928ef5d313c80af059b14cf24ff2d349ee7e32944 -->

## Thread — Keeper checks fees and chain before it signs (PR #3553)

The keeper lets its RPC fill in each transaction's chain id and fee fields, then signs. Until now nothing local checked those fields, so a faulty or hostile RPC could have had the keeper sign transactions that burn its gas money in fees, or one for a different chain. The keeper wallet holds only gas money, but it pays for liquidations, so draining it would stop them.

Every path on which the keeper's key signs now runs one check between preparation and signature, including a send whose transaction number the caller chose and the private route's public fallback, which rebroadcasts the bytes already checked. The transaction must be for the chain the keeper was configured to act on (its own chain list, never the RPC's answer), and that configured chain id is what is signed over: the key signs it directly, without asking the RPC for the chain again. Its fee per gas (or gas price on a legacy chain), its tip and the most its fee can cost (gas limit times fee per gas) must each be at or under the chain's ceiling. The last figure is what bounds an inflated gas limit, which no per-gas ceiling catches.

Every chain the keeper runs on has built-in ceilings well above what it charges in a busy hour: on Base and Arbitrum 20 gwei, a 2 gwei tip and 0.01 ETH per send; on BNB 30 gwei and 0.03 BNB; on Ethereum 300 gwei, a 20 gwei tip and 0.3 ETH. An operator may set others per chain with three plain variables in the same form as the CCIP fee ceilings.

A send outside the ceilings is not signed and not sent, and its transaction number is released for the next send. Operators get an ops alert naming the Diamond function and its loan or offer id and the figure that was over, at most once per chain every ten minutes (and never twice at once when many sends are held together), so a genuine fee spike is a decision to raise the ceiling rather than a silent stall of liquidations. A ceiling that cannot be read holds every send on that chain and says why.

Closes #3543.

> Caveat: the value a transaction carries is not in this bound (the keeper chooses it, and a paid CCIP fee has its own ceiling), and a rollup's L1 data fee is charged by the chain outside the transaction's fields.
> Caveat: the guard checks the RPC's figures against fixed ceilings only; it does not compare them with a second fee source.

_Committed 2026-11-11 06:00 UTC (275c9839f)._
<!-- assembled-fragment: 3543-keeper-signing-ceilings.md sha256=0ae060d7d0f8bbbe0992830d08c46cfd9e3ffdc61450aad3f17b72772f3e50b9 -->

## Thread — Accept preview for gasless signed offers (PR #3564)

An interface can now ask, read-only, whether filling a vault-backed signed offer would succeed and what loan it would produce, before the taker signs anything. Until now the accept preview needed an on-chain offer id, which a signed offer does not have until its fill creates one, so the app could only learn a signed offer was unfillable by a failed transaction.

The new preview runs the same body as the ordinary accept preview, over the offer the fill would create, so the projected principal, rate, collateral and initiation fee and every accept check are the ones an on-chain offer gets. The signed offer's own checks (a Full-tariff opt-in without its ceiling, the signature deadline, the offer's expiry, a cancelled nonce, an already filled or cancelled order) now live in one place that both the fill and the preview read, so the two cannot drift. After those come the signature, the supported shape (both legs ERC-20, no refinance target), the signer's sanctions screen and both assets' pause (live checks that can change after the offer was signed), the signer's free vault balance of the stake, and the offer-book minimum value, in the order the fill checks them. The preview also names the stake asset, the amount the fill draws and how much the signer has free, so a maker who has spent their backing can be shown as unfillable.

What it does not check is stated in its documentation: the creation bounds an app-authored signed offer already meets, the taker's risk-access standing (which has its own preview), and the wallet-backed fill, whose stake is a token transfer a read cannot perform.

Offer expiry is now one rule everywhere: an offer is expired at its expiry second and after. The signed fill's own check used "after" and left the exact second to a later refusal; it now refuses that second itself, as the matcher and on-chain offers already did.

Closes #3552.

_Committed 2026-11-11 10:29 UTC (54bde2299)._
<!-- assembled-fragment: 3552-signed-offer-accept-preview.md sha256=47bd566d4ab4003f003eb6f5925e9ddb2befa1e268fe7fdc308fed4e261390ac -->

## Thread — The lender's discount takes the lower of entry and settlement (PR #3585)

A lender's yield-fee hold discount used to be their discount at the moment
the fee was charged. The minimum holding period is 3 days by default, and the
look-back that guards against a quick top-up only covers the current holding.
So a lender could stake about 3 days before a year-long loan settled and get
the discount on the whole year's interest. The cost was a small loss to the
treasury, with no risk to users.

The discount is now the lower of two figures: the holder's discount when they
took the lender position, and their discount when the fee is charged. A
holder takes the position when the loan opens, when a sale of the position
completes, and when the position NFT is transferred to them. Opening and a
sale record the new holder's discount for that loan, replacing the previous
holder's record; a sale splits the interest, so the buyer's figure reaches
only interest from the sale on. A plain transfer splits no interest, so it
records the lower of the figure already there and the receiver's discount.
A transfer can keep or lower the figure but never raise it, so moving the
position to yourself, or away and back, cannot lift a stake taken late. A
lender token that a sale has retired records nothing when moved. A holder
with no record gets no hold discount. The entry
figure is the discount the holder qualified for then, so a later raise of the
tier table does not lift it, while a later cut does lower the figure at
settlement.

A seller's interest claim is unchanged: it already pays the loan's own fee,
without any holder's discount. The Full tariff's extra discount and the
consent gate are unchanged. Only the treasury's share of interest changes, and
it can only go up.

The record has one writer, beside the rule that reads it, and every way a
lender token gets a holder passes through it. Apps can read a lender's entry
figure, their figure now and the one that applies for any loan, so the
expected discount can be shown with the reason when the entry figure is lower.

On a chain other than the canonical VPFI chain, the discount is the tier the
canonical chain last pushed for the holder; where that is missing or stale
when they take the position, the entry figure for that loan is zero.

A Diamond refreshed in place has no records for loans already open, so their
lenders get no hold discount from then on. The position NFT facet and the
discount facet must be refreshed together. Testnets get this at the next
fresh deploy.

Closes #3562.

> Caveat: loans open before a facet refresh carry no entry record and pay the full yield fee from then on.

_Committed 2026-11-11 17:41 UTC (46d9cf9b6)._
<!-- assembled-fragment: 3562-lender-discount-entry-and-settlement.md sha256=b88084669e26472e0af705905f37cb885b7a3eab680054f9abac8fb7bb6de39c -->

## Thread — Risk-access preview for signed offers (PR #3582)

An app reviewing a fill of a signed offer can now ask, before the taker signs
or approves anything, whether the risk-access gate would let the fill through.
The gate's existing previews are keyed on an on-chain offer, and a signed offer
becomes one only inside the transaction that fills it, so until now the review
could only say the gate's answer was unknown. With the gate on across the
testnets, a refused taker found out from the dry run after signing the terms
and approving the collateral.

The new read takes the signed offer and the taker. It reports the signer's
block and the taker's block separately, with the gate's usual reasons, and the
asset pair both are judged on, so the app can tell the taker exactly which
consent or acknowledgement to record, and on which pair. It applies the gate's
own rule for an ordinary offer, from one shared pair builder, so the preview
and the fill cannot judge the same terms differently. With the gate off it
reports no block.

Closes #3577. It ships with the signed-offer accept preview (#3552), so the
app's signed-offer fill review can read both before the first prompt.

_Committed 2026-11-11 14:40 UTC (1e6f48da7)._
<!-- assembled-fragment: 3577-signed-offer-risk-preview.md sha256=0b3092a83266cf2c3e57212277060d5b0a207f1208663200ceff2926c79e970f -->

## Thread — Repayment-auction nonces are unique per vault, not across the platform (PR #3530)

A swap-to-repay auction order carries a nonce, and the 1inch order protocol tracks used nonces per seller. Since the borrower's own vault became each order's seller, the protocol still kept one platform-wide list of used nonces, so a nonce one borrower used refused every other borrower's order with that nonce. Anyone could make another borrower's commit fail by using the nonce first. No funds were at risk; the borrower had to retry with a new nonce.

Used nonces are now recorded per seller vault, matching 1inch. A vault still can never reuse a nonce (its two orders would void each other on the first fill); different borrowers may use the same one. The old platform-wide record stays in storage, retired and unused. No funds move differently.

Found by the 2026-11-11 external security review.

_Committed 2026-11-11 05:07 UTC (e8ba16531)._
<!-- assembled-fragment: intent-nonce-per-maker.md sha256=b71349ad5d647dea6c84ed55b16368d199b7494925d058f59bc58d0eb1d32628 -->
