# Release Notes — 2026-11-22

A large day. The first batch wave landed: reward fixes so that a reward's expiry always ends with its signal, a mirror tier can be renewed and a loan's rewards never exceed the fee the platform kept, together with three facet splits for contract size room, the backstop's daily lending limit, the network closing switch and the per-network node capability check. The indexer gained a public data feed, a repayment record, one counting rule for public figures and the rental-rights feed. The deploy rehearsal gained its mode, a CCIP relay between forks, its indexer and keeper runners, and a readback. A set of troubleshooting tools arrived: one error catalogue, a transaction explainer, the failed-transaction record and pass, a build history per service, the indexer's event history, and rows that name the event that last changed them. Refactor and review tooling, a gas budget for every user action, a check of the canonical specification's folder, the alert phrase and chat-change notices, stored issuer-power results and start and target dates on the board's Roadmap complete the day.

## Thread — a reward's expiry always ends with its terminal signal

When the expiry sweep starts removing a reward, it announces the removal,
and it announces the reward's expiry as complete when it finishes. Three
routes ended such a reward without that second announcement. The
accounting was right in each case; what was missing was the record that
the reward had ended.

The first route is a forfeit after removal began. If the loan forfeited
after the sweep's first pass, the forfeit settled the rest correctly but
nothing announced that the expiry had ended. The forfeit's last step now
also emits the expiry's completion signal once, carrying what the earlier
expiry passes actually moved to the recycle bucket. The forfeited
remainder keeps its own forfeit signal, so each destination is still
reported once.

The second and third are empty remainders. A reward whose removal had
begun but whose remaining window turned out to price to nothing, and a
forfeited reward whose remaining window on the post-arming path was
empty, both returned without being marked finished. They moved no value,
but they stayed in the owner's list of unsettled rewards and were scanned
again by every later sweep.

The expiry sweep now retires any reward whose remaining window the
pricing step reports as empty, whether or not its removal had begun,
through the same empty-window retirement the claim path uses, with its
retirement signal. A reward whose removal had begun also gets the
expiry's completion signal. A reward that simply cannot be priced yet,
because its days are not final, is left untouched for a later sweep: only
an empty window is final. The forfeit path's empty remainder is retired
the same way. As on the claim path, a reward's earlier-era slice is first
brought to its settled state before the empty window is retired, so no
half-prepared slice is left behind a retired reward; until it is, the
sweep retries.

No value moves differently. Indexers that treat the completion signal as
the end of an expiry now see every begun expiry end.

Closes #1789

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 1789-reward-expiry-terminal-signal.md sha256=d11ad477026b91c0051d80b22c1a6a2b72a786ffbb07402d728e284c9aaf1ae6 -->

## Thread — a steady tier can be renewed on a mirror

A mirror chain stops honouring a cached tier once it is older than the
mirror's maximum age (sixty days by default, thirty at the least). The
canonical chain, though, only sent a new tier push when the tier changed.
A user who staked once and held steadily therefore lost the discount on
every mirror after the maximum age, and nothing they could do would send
the push again: a poke resolved the same tier and was treated as no news.

The canonical chain now renews an unchanged, non-zero tier once its last
commit is fifteen days old, half the shortest maximum age a mirror may
use. The user's next tier-pushing action, or a tier poke, commits the same
tier again, and each mirror lane whose last delivery is that old is owed
it. A lane last delivered before that commit is owed it too, however
recent the delivery: otherwise a lane paid for late could let a renewal
pass it by and go unrenewed until close to its mirror's maximum age. Before that age an unchanged tier still sends nothing, and tier zero
is never renewed, because a mirror already treats a stale entry as no
discount.

A renewal keeps a discount alive, so it is paid like a raise: the caller
pays the lane fee, never the protocol broadcast budget. A holder who wants
the discount kept on a mirror pokes and pays once every fifteen days or
so; the budget cannot be drained by renewals.

The tier poke's own description was also wrong: it claimed a consent gate
that does not exist. It now says what the poke does, including the
renewal and who pays for it.

Closes #1856

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 1856-mirror-tier-renewal.md sha256=ba25621f0ae327111fff7a7a0bbd58f3c4418aa8fd5488057fbcd94372d46693 -->

## Thread — repatriation returns and ceremony inflows recorded as packets

Every value-bearing reward arrival on the canonical chain is now recorded
as an ingress packet before it is credited. Deliveries, compensations and
stranded returns already were. Two arrivals were not: the planned-surplus
repatriation return, and the value a recovery ceremony brings back. Both
credited the books with no packet record, so they had neither the audit
trail the other arrivals carry nor the guard that refuses a second
landing under the same identity.

A repatriation return is now recorded under its transport identity: the
return receiver passes on the cross-chain message id it already had, and
the canonical chain records the arrival as a new packet kind before
crediting it to the recycle bucket. The whole arrival is recorded as
recycled value, as it was absorbed on the mirror. A second landing under
the same identity is refused whole and can be re-executed. The receiver's
wire generation goes up by one because its call into the Diamond changed.

A recovery-ceremony inflow is recorded as its own packet kind every time,
whether fresh, recycled or both, and whether it settles a local
reservation or one imported from a retired deployment. No transport
carries a ceremony, so its record is keyed by the platform's own sequence
and names the reservation it settles. Before this change the recycled half
of a ceremony, and a fresh inflow for an already-attributed receipt, left
no record at all.

These records are for audit and replay protection only. They hold nothing
in the unclassified row. Every step that reads the packet record now names
each kind it accepts: the reconciliation classification refuses the two new
kinds by name, the return of an untyped remainder accepts only a budget
delivery (so a ceremony record, which has no source chain, can never be
sent anywhere), and a kind the record does not know is refused rather than
read as a default.

Closes #2204

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 2204-repatriation-and-ceremony-packets.md sha256=5e6834b986e1b54579d61c9533d94c1d2d7275b67ca89e3edf6612f1033496b2 -->

## Agent and app — the alert phrase, and notices when an alert chat changes

An owner can now set an alert phrase: a short phrase only they know. Every Telegram message the alert service sends to the owner's private chat about that wallet leads with it, so a message that lacks it, or shows another one, is visibly not from the platform. It appears on Telegram only; Push notifications never show it. Group chats are never shown it, and the app says so when a group is linked. A chat shows a phrase only after it has been told it: setting or changing the phrase sends each linked private chat a notice stating the phrase now in force (led by the phrase that chat knew before), and the chat moves to the new phrase only once Telegram accepted that notice. A chat linked later shows no phrase until the phrase is set again; the same chat linked on another network shows it at once. A manager's chat shows the manager's phrase.

Setting and removing the phrase are signed alert requests with their own texts. The text for setting names a fingerprint of the phrase bound to the request key, never the phrase, so the approval of a multi-signature wallet does not show it. The service recomputes the fingerprint from the request and refuses a mismatch. A phrase is accepted only as typed: 3 to 32 characters from the same plain set as other free fields in alerts (no links, no "/", ":" or "@"), with no surrounding spaces; anything else is refused by name, never cleaned. A phrase can be set only while a private chat is linked. Phrase requests have their own newest-first order.

Where a phrase applies follows how the wallet signed, the same rule unlinking uses. A wallet signing with its own key sets the phrase for every network, replacing any network's own phrase. A contract wallet's approval proves control only on the network the signed text names, so it sets that network's own phrase, which takes precedence there and leaves the other networks and their chats alone. Such a phrase needs a private chat linked on that network, only the private chats linked there are told, and the notice names that network. A request is checked against the newest one that set the phrase on the networks it covers, of either kind. A message about a wallet on a network leads with the phrase that chat was last told for that network. The service reports which scope applied and the app confirms it. For a contract wallet, the card says the phrase applies on this network and offers each other network where Telegram is linked, one approval each, with the phrase typed again. The status read is per network and says only whether a phrase is set there, since when, and whether it is that network's own or the wallet's on every network. While a contract wallet's approval is pending, the browser keeps the request without the phrase, and finishing it asks the owner to type the phrase again, checked against what was signed.

When a wallet's alert chat changes on an account without protected mode, the chat that stops getting the alerts is told at once, and when another chat is added beside a linked one, the linked chats are told. These notices lead with the phrase each chat knew, are tried at once and retried for up to an hour, and the old chat's id is kept only for that notice. A wallet that opted in to Push also gets a Push notice naming only the network. Protected accounts keep the delayed change, and its notices now carry the phrase too.

The agent's Telegram state object gains the phrase, the phrase each chat was last told, each chat's type (recorded at the link handshake) and the notice queues; no shared database migration is needed.

Advances #3346.

_Committed 2026-11-22 03:22 UTC (1e3825547)._
<!-- assembled-fragment: 3346-alert-phrase-and-chat-change-notices.md sha256=ff096d18ef6010f559187a1ff7d83286564cd60271e3971c30f7745d7fc7783c -->

## Thread — a loan's rewards never exceed the initiation fee the platform kept

Once the reward cutover is armed, a loan's interaction rewards are
bounded by the initiation fee the platform actually kept from that loan. Each side's lifetime reward cap is
half of the lower of two figures, after the reward haircut recorded when
the loan opened: the notional tariff the cap already used, and the kept
fee. So on the days the cap binds, both sides together can never earn
more than the kept fee less the haircut, whatever hold discount the
borrower had and whoever collected a share of the fee.

The kept fee is the fee actually charged after the borrower's hold
discount, less every share actually paid to someone else (the matcher, an
integrator, an inviter). The parts that go to the treasury and to the
reserve both count as kept. It is not recalculated: the loan records what
the fee host measured as received for this loan's initiation fee, in the
same acceptance (never more than the amount handed to it), and prices it to the numeraire with the same conversion
the notional tariff uses. The record is stamped once and never re-read
from live settings; early-close proration of the cap is unchanged.

A loan whose kept fee is zero has a reward cap of zero. There is no floor.
The same stamp runs on the canonical chain and on mirrors.

Where the bound applies, stated plainly: the cap binds only on reward
days after the reward cutover is armed, and only for a loan whose fee
record was stamped when it opened. The cutover is not armed on any
deploy, so today the cap is recorded but binds on no day. Reward days
before the cutover keep the old rules, and a loan with no stamp (a rental
or a sale vehicle, for example) carries no loan-side cap at all. Arming
the cutover requires every reward-eligible open loan to be stamped first.

The loan's fee record now carries the kept fee in the lending asset and in
the numeraire, the stamping event carries the numeraire figure, and a new
read reports the notional tariff, the kept fee, each side's cap and which
of the two figures binds. A fallback that rebuilt a missing cap from the
notional tariff alone was removed, since it would lift the new bound; the
platform is deployed fresh, so no record needs it.

Closes #3360

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3360-reward-cap-kept-fee.md sha256=8cb721c1ca9734937e401fb886ea021e503261d771023a2358b4e16900a7bb55 -->

## Issuer-power check results are stored and served (#3433)

A vault can lose an asset, or be unable to move it, without any protocol call: some token contracts have functions that claw tokens back, force or freeze transfers, pause the token or replace its code, and some collections consult a transfer validator that can block the platform's transfers. The contracts stay uncurated, so these powers are looked for off-chain and disclosed in the apps.

This change adds the place those results live. Two new shared tables hold, per token or collection on a chain, the last run of the checker: what it took the contract to be, when it looked and at which block, which list of checks it applied, whether every check ran, and each check's result with the public evidence behind it. The indexer serves them read-only at `/assets/issuer-powers`, beside the market-cap rankings.

The shared list of checks (version 2) covers an upgradeable proxy, forced transfers, freezing, pausing and whether the token is paused now, a transfer validator, non-transferable tokens, and a simulated transfer from one vault to another. A found function means the code has it, never that anyone can use it today. For a simulated transfer, "found" means the transfer was refused, with the revert name as evidence, and "not found" means it went through. Each check names the asset kinds it applies to: the transfer validator and non-transferable checks apply to NFTs only, and a run is complete when every check that applies to its kind has an answer. A simulated transfer through the collateral sale's marketplace conduit is on the list but not run by version 2, so the route names it as not checked for NFTs.

The route states facts, never a verdict. "Not found" means the checker looked and did not find that power, never that an asset is safe. A check that could not run is reported as unknown, an asset that was never checked is named as such, and a check this build does not recognise is still returned rather than dropped. Before the tables exist the route answers "unavailable" rather than an empty list.

The keeper pass that runs the checks and writes the rows is separate work; until it ships, the route returns no results.

Part of #3433.

_Committed 2026-11-22 00:50 UTC (61e86d89d)._
<!-- assembled-fragment: 3433-issuer-powers-store.md sha256=8849a7c5dbb4452d08b191a2388261b7fdb81eaa27116233cd9c2294a513a6e5 -->

## Thread — A gas-starved price read in the offer floor is no longer read as "no price"

Posting an offer checks a small value floor, and that check reads the lending
asset's liquidity and value. Both reads were best-effort: if either failed, the
offer was admitted without the floor. A read that failed only because the
transaction had too little gas counted as a failure too, so a wallet's gas
estimate could settle on the limit at which the floor was skipped. The offer
then ran out of gas a few steps later. This is the same class of fault #3504
closed for the other best-effort price reads, and it is what made the
fork-tier end-to-end desk scenarios fail intermittently.

The floor's two reads, the shared best-effort valuation used by analytics, the
fee log and the cadence and treasury thresholds, and the seller claim's
in-kind cover check now tell the two cases apart. A read the price rule
refuses is still treated as before. A read that ran short of gas stops the
transaction with the named out-of-gas error, so a gas estimate always covers
the reads. The price guard and its gas budget are unchanged.

The same fault sat one layer lower, in the liquidity test's reads of the
trading venues: the pool lookup, the pool's price, depth and price history,
and a token's decimals. Each was given all the gas the transaction had left.
A starved read made an asset look illiquid or unpriced, and the cheaper path
that followed succeeded, so gas estimates still landed short now and then.
Every such read, and the reads of peer lending markets' collateral settings,
now runs with a fixed budget of its own. Too little gas stops the transaction
with the same named error. A venue that needs more than the budget fails the
test the same way for every caller. The collateral concentration view's
valuation also passes a starved read on by name, instead of reading it as
"unpriced".

Advances #3504.

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3504-offer-floor-gas-starvation.md sha256=eb69baa15e4e92ebc7465a473275ea489da548ab0ecc5fbe4f8da40acd91361e -->

## Indexer — public data feed, v1

The indexer now serves a public, versioned, read-only data feed under `/public/v1`, with its documentation in `docs/PublicDataFeed.md`. It is a fixed list of nine existing reads: the open offer book, recent offers, offer totals, one offer, active and recent loans, loan totals, rate candles and one loan. Each is answered by the same handler the app uses, so there is one copy of every read.

Each answer is wrapped in an envelope stating the feed version and the chain. It also states the block the indexer had reached when the read began, which is read before the data so it is a floor. It says where the figures come from and what they leave out, and carries a notice that no figure is the platform's rate, a benchmark, advice or an offer. A request to the bare prefix returns the feed's own catalogue.

The open offer book always leaves out offers past their expiry, which can still read as open because expiry is enforced lazily on-chain; the feed sets this itself and a caller cannot turn it off. Open offers by pair and term are held back from v1: the app's aggregate also counts gasless signed offers and is refreshed after the block the feed states, so it cannot yet back what the feed would say about it (#3889).

Nothing kept privately for a wallet is served. The per-wallet convenience reads (claimables, notifications, loans by participant) are left out of the feed, and any path outside the list answers 404.

Each route lists the parameters it takes; only those and the chain reach the handler, and any other is refused with a 400 naming it. Tests pin each route's parameters and field names (a field may be added, never removed or renamed) and record the tables each route reads, each one the indexer rebuilds from the chain alone.

A new per-IP limiter, `PUBLIC_FEED_RATELIMIT` (120 a minute, one budget across every feed route), is taken before any read. Cloudflare counts it per location, so the figure is approximate. A refusal states the limit and the period and carries Retry-After. Like every limiter here it fails closed.

Advances #3774. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` section 8.

> Caveat: the new rate-limit binding is declared in `wrangler.jsonc`; it takes effect with the indexer's next deploy.

_Committed 2026-11-22 02:59 UTC (eecb39e90)._
<!-- assembled-fragment: 3774-public-data-feed.md sha256=df43fcc97da9f3ffb3a727cfec19dadde5fd7ab350991063839cba9124c7d9f7 -->

## Indexer — the repayment record

The indexer now answers `GET /repayment-record/{address}`. It gives a count of what one address did on this platform as a borrower or renter, taken from the platform's own events. The count covers:

- loans held to the end, and how each closed: repaid on time, repaid after the due date, repaid by a sale of collateral on the holder's own route, refinanced, liquidated or defaulted;
- loans the rules cannot place, counted as unclassified rather than guessed;
- loans open now;
- interest periods closed without a sale, those paid by a sale of collateral the holder or a partial liquidation made, and those collected by a sale after the grace;
- interest paid, per token;
- rentals;
- the first loan;
- how many of the closed loans the address opened, and how many it took over.

It is not a score. No figure is combined with another, ranked or coloured. Every answer carries the block it is true as of, the version of its rules, where its history begins, the four statements every view must show, and what it leaves out.

Timing comes from time, not from the late fee alone. A full repayment counts as on time when it is not after the late-fee start that the repayment event states. Until that event carries the late-fee start, a repayment with a late fee counts as late. One made no later than the due date stated at the loan's start counts as on time. Any other repayment is unclassified. A preclose is read the same way, since it may land in the grace after the due date. A fallback cured by added collateral does not decide a later close.

A loan counts for the address that held the borrower position when the loan closed. A payment by someone else counts for the holder. The vehicle loan a lender's sale creates is left out. So is a loan whose opening named the same address as lender and borrower, and a loan whose opening parties the index cannot establish; the record counts each of those on its own line instead, by the same rule every public figure follows. When a change of the borrower position falls in the same block as another change or as the event being counted, the index cannot tell their order, so the record does not guess the holder and counts that loan on its own line too.

The fees paid to the platform are not stated yet, because the events do not state each loan's fees. The answer says so instead of showing a partial sum.

The record is also the public data feed's tenth route, `/public/v1/repayment-record/{address}`, in the feed's envelope. It is the only feed route that takes an address, and it answers for one address at a time: no feed route lists, ranks, searches or filters addresses by their record. The feed's table test now asks a sharper question than before. Every table a feed route reads must be one the indexer rebuilds from the chain alone, never one born off chain or mixed.

The rules are in `docs/RepaymentRecordDerivation.md`. The app's views are separate work.

Part of #3778. Design: `docs/DesignsAndPlans/RepaymentRecordDesign.md`.

_Committed 2026-11-22 04:35 UTC (82c0f7c77)._
<!-- assembled-fragment: 3778-repayment-record.md sha256=30a76f79a8c145fc0bd86cb4929d95e5f1bae6b1805b4f69a724bc562c540fa0 -->

## Thread — three facet splits for contract size room (PR #3842)

Two facets had come close to the 24 KB size limit every contract on the
chain must stay under, which left no room for the next change to either.
Self-contained parts of them have moved into three new facets. Nothing a
user, keeper or app does changes: every function keeps its name, its inputs
and its answers, every event and error keeps its identity, and no stored data
moves.

The sale reads move from the risk preview facet to a new sale admission
facet: the check of whether a loan may take a new lender by sale, the quote
of the bounds a sale listing would record for the seller, and the read of
the bounds a standing listing did record. The preview of a standing-intent
fill (the read a keeper makes before filling an Auto-lend slot, which says
whether the fill would succeed and, if not, the first reason it would fail)
moves from the same facet to a new intent preview facet, taking the shared
matching rules it runs with it. The rule for who is checked when two offers
are matched, which that preview shares with the match check and the match
preview that stay behind, is now written once and used by both facets. The
backstop's second role, where treasury capital buys a defaulted position as
liquidator of last resort, moves its governance (the per-pair cap, seeding
and withdrawing the cash it uses, sweeping the collateral it holds,
releasing its exposure, its own switch and its per-pair read) from the
backstop facet to a new backstop absorb facet.

Each group must be refreshed together: the sale paths reach the admission
check across a facet boundary, the intent preview reaches the risk bounds on
the risk preview facet the same way the other matching facets do, and both
backstop facets govern the same backstop vault. The curated refresh scripts
that already carried the risk preview facet now carry the sale admission and
intent preview facets too, and move their functions onto them on a Diamond
cut before the split.

Apps and services that read the three sale functions or the intent preview
through the risk preview facet's own ABI file must use the new facets' files
or the combined Diamond ABI.

Closes #3843

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3843-facet-split.md sha256=c9b86ae5c029314de0f36d92f927fe48c1faea21a70c69ceb24df52dc9837135 -->

## Thread — The backstop's daily lending limit (PR #3842)

The backstop (Role A, the protocol's lender of last resort) now lends at most a governed share of its lending capital in each lending asset per UTC day. The capital is the funded capital waiting across the asset's pairs plus the principal out on the backstop's open loans. The share starts at one fifth (2,000 basis points) and may be set between 500 and 5,000. A Diamond that never set it reads the default; there is no value that means "no limit".

Why: anyone may run a backstop fill, and every gate it had was a per-fill gate. A fault lasting some hours (a wrong price input, a gate that reads wrongly after a change) could have been paid for with the whole seed in a day. With the limit it costs at most the day's share, and the existing fill switch has a day to be used.

How it works: one running total per lending asset per UTC day. The check sits where every loan opened from the backstop's capital is recorded, the same seam the instant market's ledger already uses for every slot fill, so any route that ever opens a loan from the backstop's capital counts in the same total. A fill that would take the day's total over the limit is refused with an error naming the limit, the amount already used and when the day ends. Because the backstop fills whole offers only, a borrower's opt-in now refuses an offer larger than the whole daily limit and says why; the fill checks again, because the limit moves with the capital. A fill itself moves capital from waiting to out, so it never moves the limit; a new seed, a withdrawal to treasury, a repayment or a default does. The buyout and absorb (Role B) keep their own cap and are not counted.

The setting is held by the vault-admin role, which the governance handover gives to the timelock, so a change waits out the governance delay. The fast stop is still the fill switch (and the protocol pause). A new view returns, per lending asset, the limit, the amount used today, the room left, when the day ends, the capital it is a share of, and the share in force. The open-steps ledger's row for the fill now states what its caller chooses (which eligible offer uses the day's room) and what bounds it.

Closes #3849

> Caveat: the day is the UTC day, so a stretch that spans midnight can use two days' limits: up to twice the share in any 24 hours.
> Caveat: the day's room is first come, first served; any caller may fill any eligible offer, and the keeper's own order (oldest eligible first) is a keeper choice, not a contract rule.
> Caveat: a seed made during the day raises that day's limit at once (a seed is itself a governance step); a withdrawal or a repayment can leave the day's used total above a lowered limit, which reads as no room left.
> Caveat: the keeper's fill step and the app's display of the four figures are separate changes.

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3849-backstop-daily-limit.md sha256=3313e3b9eb69c79194474381f9589195040fa631254d6cf6567bc31a98d16590 -->

## Thread — The network closing switch (PR #3842)

A network can now be put into a Closing state by one on-chain switch. While it is closing, no step may commit a wallet's money or its standing consent to a new position there, whatever the wallet's Terms standing, and every position already open runs to its own end on its own terms. The Pauser or governance may switch it on at once; only governance or the Unpauser may switch it off, the same split the per-asset pause uses. Switching it on twice keeps the first time it started. One view says whether the network is closing and since when, and one event is emitted each way. It gives the platform a second incident tool beside the global pause: it stops growth without stopping a repayment, a claim, a liquidation or a default, and it moves no deadline.

The switch is asked where the Terms of Service rule is already asked, through the same host, as one question with two parts: the network is open, then the wallet is current on the Terms. So posting an offer, accepting or matching one (every route that opens a loan, the instant market and refinance included), setting or funding an Auto-lend slot, the in-place extension, a lender's sale or takeover and an obligation handover are all refused on a closing network, and no opening step gained a second call. The backstop vault, which the Terms rule exempts, is refused like any wallet, because the closing part is asked before that exemption. Posting a loan-sale listing, which the Terms rule exempts, is refused too: it can only fill as a new position.

Two steps are named exceptions. Setting standing instructions on a loan keeps asking the Terms part alone and stays open while closing, because a collateral top-up, an interest payment and a repayment at the due date all help a loan end. And the Auto-lend slot's re-commit of held payments and its roll of a repaid loan ask the closing part alone: each commits money to the slot's future lending, so both are refused while closing (the lender claims normally instead), and neither gained a Terms check it did not have before.

Everything that helps a position end stays open: repaying, adding collateral, the loan reserves, cancelling an offer, withdrawing slot capital, depositing into and withdrawing from the vault, claiming, liquidation, the time-based default, the backstop's absorb of a loan in the fallback state, and releasing a slot's exposure. A plain transfer of a position token passes no opening site and is not refused.

The previews say why before anyone signs. The accept, match and standing-intent previews report a new reason, "the network is closing", ahead of the Terms reason. It is appended to each preview's list of reasons, so earlier numbers do not move. The previews' combined read was renamed to say what it now answers, and the Terms-only and two-part checks each have their own name; the platform is prelive, so no old names were kept.

Advances #3864. The sale-exit verdict's own closing refusal, the app and keeper surfaces that disarm opening passes at the switch, and the earliest-closed-day read are separate changes.

> Caveat: the keeper's matcher still schedules the slot re-commit and the roll on a closing network; each attempt is refused on-chain until the matcher is taught to read the switch.

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3864-network-closing-switch.md sha256=a0a5deab5f0686f1a4fdb964cc7f3196ada2a269aa7b402bf0e44ec3610b1935 -->

## Indexer — one counting rule for public figures

Every figure the indexer publishes now follows one written rule, kept in one module so later figures (the rental figures among them) state it in the same words.

No value total is formed. The index reads no price, so it never adds amounts of different assets together: each amount stays in its own asset's smallest units, on its own line. The loan totals say so in a new `counting` statement.

No figure is a mean across assets or terms. The loan totals no longer carry an average interest rate: it averaged rates of different assets and terms together, and nothing used it.

A loan whose opening event names the same address as lender and borrower is left out of the rate candles and counted on its own line, and the loan totals count such loans too. The test reads the two parties of the opening event, now kept with the loan row, so a later sale or handover moves a loan neither in nor out. Each figure that applies the rule says that it cannot see two addresses that belong to one person.

A new migration adds the two opening-party columns and fills them for existing loans from the activity ledger, and each indexer pass fills any still unknown the same way. A loan whose opening parties cannot be established is left out of the rate candles as well and counted on its own line, as opening parties unknown: it is never assumed to have two parties.

Part of #3879. Design: `docs/DesignsAndPlans/ProjectKitDesign.md` section 8.

_Committed 2026-11-22 02:59 UTC (eecb39e90)._
<!-- assembled-fragment: 3879-public-figure-rules.md sha256=ebcb89f48c6199087ee6cfa4adf040b5b107a41eaea956c537755b6e94a76f64 -->

## Indexer — who may use a rented item, on the public feed

The indexer now keeps a table of rental rights, rebuilt from the platform's own `VaultRentalUpdated` events: one row per rental, with the collection, the token, the owner of the vault holding it, the recorded user, the expiry and the quantity. A later update replaces a row and an older one never does, so a re-scan cannot put a past state back. A clearing keeps the row with no units, and a rental past its expiry stops counting by time alone. Two rentals of one ERC-1155 token stay apart, one row each.

Two routes in the public data feed answer from that table, reading only the latest recorded block time beside it. `/public/v1/rentals/by-collection` lists each active rental of one collection, optionally for one token, a page at a time. `/public/v1/rentals/may-use` lists the active rentals in one collection that name one address as user, which is the answer a game or service needs to decide who may use an item. Each takes exactly one collection, and `may-use` exactly one address; a list, a repeated parameter or a wildcard is refused.

Both routes are public because they return only what the chain already publishes: every row restates one event, and an ERC-721 renter can also be read from the owner's vault. They do not hide who rents. They never join anything the platform keeps for a wallet, and a test holds that they read only the rental table, the scan cursor and that one block time, all rebuilt from chain events.

"Active" uses the vault's own rule: a rental counts while its expiry is not before the moment judged. That moment is the later of the server's clock and the latest block time the index holds, so a server clock running behind the chain cannot show an ended rental as a right. Each answer states the block the clearings are known through, its chain time and the moment judged. The feed can say "ended" a few seconds before the chain's newest block does, which is the safe side. On a network the indexer has already scanned, the table is filled from the rental events already indexed before either route answers, a bounded step per indexer pass that resumes where the last one stopped; until the last step both answer that the table is still being filled, never an incomplete list. When the indexer finds that a loan it recorded never existed on chain and withdraws it, the rental row goes with the loan's other records, so neither route names a renter for it.

Closes #3882. Design: `docs/DesignsAndPlans/ProjectKitDesign.md` §6 and §12.

_Committed 2026-11-22 06:20 UTC (b3f653778)._
<!-- assembled-fragment: 3882-rental-rights-feed.md sha256=aba0890d8752abad34a8c50246656c815181008d7cbdde6763bbe6e20cec2862 -->

## Deploy rehearsal — the mode, the signer seam and the plan (PR #3911)

A deploy can now be rehearsed end to end before it touches a real chain. `contracts/script/rehearse.sh` forks every target chain locally, a little behind its head, and runs the real deploy plan against the forks with no key. Each on-chain step is the deploy script's own phase, run with `--rehearse`. The run ends with a report and a verdict. The verdict records the commit, a digest of the tracked tree, a digest of the deploy's inputs and a digest of the plan, so a later gate can tell whether the real deploy is the one that was rehearsed. The design is `docs/DesignsAndPlans/DeployRehearsalDesign.md`.

Rehearsal mode is entered only on purpose. It needs the rehearsal flag, a scratch output folder, a node on this machine and the marker the fork launcher places. A marked node reached without the flag is refused, and the flag without the marker is refused, so a rehearsal can never write the committed records and a real run can never land on a fork. While the mode is on, every record, broadcast journal and cache goes under the run's scratch folder. A snapshot of the whole working tree is taken before and after the run, and any change outside that folder fails it.

Every operator script now chooses its signer through one library. In a real run it signs with the role's key and requires the role's stated address to match. In a rehearsal it sends as the stated address, which the fork impersonates. A guard in the pre-deploy check refuses any script that reads a key outside the library, and any deploy script that passes a key on the command line. Operator change: a real deploy now needs `DEPLOYER_ADDRESS` (and the `_ADDRESS` of every other keyed role) in `.env`, next to the key.

The testnet deploy is stated once, in `contracts/deployments/testnets.desired.json`: the chains and their roles, the bot roles, the Terms version, the reward pool and where its funding comes from, the settings profile, the sanctions clearance route and the keeper passes to arm on each chain. `contracts/script/deploy-plan.mjs` turns it into the plan. Every phase runs in order. Each step the scripts do not take is written as its exact command, followed by a read-back. CCIP lanes and the canonical chain's expected reward sources are derived from the chain set, and the plan refuses an `.env` that disagrees with them. A step that has no command yet is listed as not covered, and the verdict cannot be green while one remains.

Closes #3891. Advances #3111. The readback (#3893), the relay between forks (#3892), the local off-chain stack and smoke flows, and the gate on the real deploy (#3896) follow in their own PRs.

After a clock step, every price feed the chain's guard holds is brought to the new time. The list is read from the fork. A feed is moved only in its time, and this is proven after the step. A real feed is replaced on the fork by a stand-in that carries the same round, answer and decimals, and the report lists it as replaced. The sequencer status feed is left alone. A Pyth or secondary query source fails the run by name, because neither can be re-stamped.

> Caveat: a deploy that binds a Pyth cross-check or a secondary query oracle cannot be rehearsed past a clock step until that source has a mechanism of its own.
> Caveat: cross-chain messages are not delivered until the relay is wired in; until then, relay steps are reported as not covered.

On a fresh redeploy the reward identities each chain trusts (the canonical Diamond a mirror accepts broadcasts from, and each mirror Diamond the canonical chain accepts quotes from) now come from the chains' own records, which the contracts phase just wrote. A value left in `.env` from the deployment being replaced is refused rather than installed, and the operator no longer copies the new addresses into `.env` by hand. On mainnet the records are the only source: configure refuses by name when a record is missing (every chain's contracts phase must run before any configure), and the mainnet preflight no longer asks for the two values. After the spell, both deploy scripts read the identities back from the Diamond and refuse to mark configure done unless they match the records. A rehearsal also never seeds the real indexer database, and the plan reads `.env` through the deploy's own loader.

_Committed 2026-11-22 11:14 UTC (2ecebb8ec)._
<!-- assembled-fragment: 3891-deploy-rehearsal-mode.md sha256=e3b671a3967d3f8475e25b33ded65e4722bf5f514d0b1c41ca159b6580204c35 -->

## Deploy rehearsal — the CCIP relay between forks (PR #3903)

The deploy rehearsal can now carry a cross-chain message between its local
forks of the testnets. On the sending fork nothing is replaced: the
protocol's messenger sends through the real CCIP router and on-ramp, which
charge their real fee. On the receiving fork the code at the real off-ramp's
address is replaced with a harness stand-in, so the real router and the real
token pools still check who may deliver, and a pool still releases or mints
under its own rate limit. Like the real off-ramp, the stand-in refuses a
message from a source chain the risk network has cursed.

The relay reads the messages the sending on-ramp emitted and hands each one
to the stand-in exactly as emitted; it never composes one. The receiving
contract is called with the message's own gas limit, so a receiver that would
run out of gas on the real lane fails in the rehearsal too, and a failed
delivery fails the step. A plan step that waits for a message names the
transaction that sent it, and the relay delivers that message before the step
continues; a transaction mined before the fork point is refused, since the
real network carries it. Each delivery is recorded with its id, fee, gas limit and gas used.

The testnet lanes run the 2.0.0 version of the CCIP ramps, so the stand-in and
the relay speak that message format. Before installing, the relay reads each
lane's ramps from the routers on the forks and refuses any ramp of another
version by name; the older off-ramps a router still lists are reported, not
used.

The report states what this does not rehearse: the messaging network's own
verification, its delays, manual execution, and the gas-limit override a
manual execution may carry.

Advances the deploy rehearsal (design docs PR #3898). Closes #3892.

> Caveat: the relay refuses any node that is not on this machine; the check that a node is a marked rehearsal fork arrives with the rehearsal mode itself (#3891).

_Committed 2026-11-22 03:51 UTC (9fe44ad5e)._
<!-- assembled-fragment: 3892-rehearsal-ccip-relay.md sha256=e9db7bad24a68f0d12a9875d1a271e83354dcebcfac948933ac8bb4385300b7a -->

## Local testing — the deploy readback (PR #4015)

A deployment can now be checked against its desired-state file, row by row. The new readback script compares each chain with `deployments/testnets.desired.json` and with the run's own records. Each row reports what the file expects, what the chain or the records say, the result (met, not met, unreadable or info) and which comparison produced it. Any row that is not met or cannot be read fails the run. The same script runs on the rehearsal's forks and, after the real deploy, on the live chains.

It checks:
- The settings and switches: the Diamond is unpaused after launch, the Terms version and hash, and every setting the file names.
- The roles: the admin holds every grantable role and owns the Diamond, the deployer holds none, and each bot holds its roles. An admin or deployer address that is not given is a row that cannot be read, never a pass. The treasury is the one the vault code names.
- The rewards: role, custody activation, the pool funded with the stated amount, the anchor equal on every chain, the first capped day armed, and Base's expected sources.
- The cross-chain lanes: the destination chain's own CCIP selector, the right peer messenger in each direction, and the peer on each business channel (reward, buyback, reward budget and return), since a channel refuses a message from any other sender.
- The sources: a sanctions source that has code and answers a screen, the swap routes, and the service capacity escrow bound to the recorded one wherever the file asks for it.
- The deployment getters: every Diamond getter that names another contract must answer an address, unless the file lists it as not deployed on that chain, with a reason.
- The code: the routed selector set equals this commit's facets.
- The records: every address the broadcast journals created is recorded, listed by name with a reason (today only the one-shot initializer that writes the Diamond's interface table), the code behind a recorded proxy (the chain names it in the proxy's implementation slot), or registered as one of the Diamond's swap routes. Only journals from this run count: the rehearsal keeps its own, and a run against the shared journal folder must give its start time, or those rows cannot be read. The storage-layout record is written, the archive manifest names the retired Diamond, no carried key was dropped, and only the planned chains received transactions.

The rehearsal driver runs the readback as its own stage, after the plan's steps and before anything else touches the forks. It reads the desired file named on the plan's first line, and refuses it if the file changed after the plan was made. A plan that names no desired file is reported as not covered, so its verdict cannot be green. The desired file also switches the instant market on with at most two fills per borrow, and records SushiSwap v3 as absent on the testnets with Sushi's own deployment map as evidence. The plan check now also validates the two new lists in the desired file and refuses an entry without a reason.

A getter may answer zero only when the desired file says why, as a recorded fact and never a default. A "by design" entry covers a zero the design explains: the five the canonical/mirror split explains (including the reward remittance keeper, set on Base only), and the rate model, which nothing reads (rate-reference ruling of 2026-11-22). A "venue" entry covers an outside contract missing from the chain. It must cite the venue's own published deployment list and the date it was read, and the row shows that evidence. On mainnet every such entry also needs the owner's recorded acceptance. A getter that reverts always fails. A getter whose rule design has not given yet shows as "awaiting ruling": neither met nor failed, and refused outright on mainnet. None is awaiting today. The listing executor that NFT collateral prepay listings need is expected to answer an address: the deploy step that creates it arrives with the current batch, so until that batch lands, a readback of main's deploy fails on that row (#4019).

Run against today's live testnets, the readback shows where they differ from the next deploy's desired state. That is expected, since the next deploy sets those values.

> Caveat: not yet covered are the token pools' rate limits and their admin, the token's CCIP registration, the delisting route's clearance source and the feed bindings. The keeper's arming flags live on the keeper machine, not on a chain, so the readback does not read them either. The script's header says so.

Closes #3893

_Committed 2026-11-22 16:06 UTC (9efac0325)._
<!-- assembled-fragment: 3893-deploy-readback.md sha256=3db0ae5b6124916bfbc59872eafc14363594179d4947a5f13ba20bdec07777fb -->

## Thread — The deploy rehearsal's indexer and keeper runners (PR #3907)

The deploy rehearsal now has its off-chain stage. After the readback, the rehearsal driver builds a local shared database with the indexer's own deploy path, then runs one step per forked chain. That step runs the real indexer pass on the fork from the deploy block, and requires the indexer's own health route to report the new Diamond adopted on that chain. It then runs the keeper's real tick setup and one run of every pass in the keeper's schedule, armed exactly as the desired-state file's arming list says for that chain. A pass that throws fails the stage. A pass that tried to reach a service other than the fork is reported by name as not rehearsed, because outbound requests are narrowed to the fork for the whole stage.

The local database comes from a new, separately named entry in the indexer's deploy script. It applies and verifies every shared migration and seeds the retired Diamonds from the run's archive manifest, exactly as a real deploy does, into a folder under the run's scratch root, and it publishes nothing. It refuses any root outside the rehearsal's scratch prefix and a database folder that is not empty.

The keeper signs with keys made for the run. The stage funds them on the fork and grants the keeper, watcher and notification-biller roles, as the fresh-deploy guide's bot-role step does with the real wallets. Each grant is sent as whichever of the run's own admin accounts holds that role's admin role, impersonated for that one transaction. The report lists every key address, each grant with its transaction and mined block, and how many blocks the stage mined, so what the stage changed on the fork is stated.

A second step runs every Worker's existing dry-run publish. It finds them from the packages that carry one, rather than from a list. The report says what that proves and what it does not: each Worker builds, from the committed deployments bundle, and nothing is published.

To check the arming list against the flags the keeper actually reads, the keeper's list of arming flags is now a value as well as a type. A flag in the desired-state file that no pass reads is refused by name instead of arming nothing.

Closes #3894. Part of the deploy rehearsal (`docs/DesignsAndPlans/DeployRehearsalDesign.md`, sections 7 and 16).

> Caveat: the keeper's private database is built in memory from its migrations for each step, because a rehearsal has no deployed private database to stand in for.
> Caveat: the stage reads `keeper.armed` from the desired-state file, which #3111 adds; until that lands the driver cannot run it.

_Committed 2026-11-22 04:09 UTC (df5ee9744)._
<!-- assembled-fragment: 3894-rehearsal-offchain-runners.md sha256=3a5f202f43c44b3c1380c7d9f08843622149379e67b131f6f0d8b6b55c9d1b61 -->

## Thread — Node capability check per network (PR #3842)

A new read-only operator command asks the node behind each network what it can answer. It checks a trace of one transaction, a trace of a call that was never sent, a trace filter over the platform's contracts, a call at a past block, and every receipt of a block in one request. For each, it records how far back the node reaches, and it measures what a full block scan would cost per day.

The result is committed per network under `ops/node-capability/results/`. The failed transaction record reads it to choose between a trace filter and a block scan, and the transaction explainer reads how far back a replay can reach. Nothing is assumed: a network whose node answers no trace filter is marked for block-scan mode, with the measured daily cost.

The command sends no transaction, holds no key, and never prints or writes a node endpoint, host or key. It runs on the always-on machine against the nodes the services use.

Closes #3913

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 3913-node-capability-check.md sha256=0064336f46f122d1d6ceb7b456c03ffecba6189e0e75a17fc6ae48662697a794 -->

## Local testing — refactor reports and the event-category lint (PR #4004)

The refactor pass (RefactorRulesDesign) now has four of its five reports, built from the compiler's own syntax tree in the pre-deploy gate's existing one-job build. Nothing is recompiled for them. The four are:

- **Silent functions.** State-changing entry points whose reachable code emits no event.
- **Swallowed failures.** A failed call, caught, low-level or a plain send of native currency, whose handling neither reverts nor emits, including a failure tested inside a compound condition such as "failed or returned too little", or by comparing the result with true or false.
- **Ambiguous errors.** An entry that can raise one parameterless error from more than one place, plus every text revert and every error missing from the coming catalogue.
- **Write-only storage.** Fields that contract code writes and that only views read, or nothing does.

The fifth report, the gas suite, is card #3915.

The old event-category lint never ran. It now reads tags from the syntax tree, not the source text, and is wired in as a sixth result.

"Reachable" follows internal and library calls, modifiers (including calls in their arguments), and self-calls through the Diamond. A shared helper reached from two facets is read once for each, so each facet's own override of a hook it calls is seen. A call a standalone contract makes on itself, direct or encoded, is followed into its own code (a selector it does not answer is one it can only send on to the Diamond); only a facet's goes through the Diamond. A self-call counts when the code names its selector, whether as a function's selector, a selector constant (a hex value or a hashed signature) or an encoded signature string. Where the code names no selector, as in multicall, the report says it is unknown rather than guessing. The tests say what the reports cannot prove: they are bounded checks ("does reachable code contain an emit"), not proofs about every path.

Every tool that reads the compiler's syntax trees (these reports, the entry-gate check, the review coverage tool, the permissionless-step ledger, the error map and the delivery check) now reads its build through one loader, which refuses artifacts from more than one compilation job: syntax-tree ids are numbered per job, so a mixed build would resolve calls against unrelated declarations.

Each report's current findings are committed under contracts/refactor-reports/, with a ledger for accepted findings that requires a reason of at least twenty characters. The gate compares the tree against them. Until the refactor pass ends, a new finding is a warning and only a malformed ledger fails; the config file holds that switch. The baseline is large: 1,763 ambiguous-error entries (raise sites grouped by what the caller receives, so two declarations of one parameterless error count together, and each call to the typed revert wrapper naming an error counts as a raise of it) and 19 text reverts (every shipped error is in the error catalogue, compared by its ABI signature), and 467 event-category entries, most of them tags whose leaf the lint's stale allow-list does not know. Every report reads receive() and fallback() as entry points too, the Diamond proxy's included. A counter whose new value is used (a fresh id taken from it) counts as read. These are the input to the refactor pass's interface document (#3925), not things to fix here.

Closes #3914.

_Committed 2026-11-22 14:35 UTC (c65d2d141)._
<!-- assembled-fragment: 3914-refactor-reports.md sha256=c4f963324f0c01a5a00fae717f04317938a3240b623773dee812f2b76a2882ae -->

## Local testing — a gas budget for every user action

A new gas suite measures one transaction for each user action. It covers 32 actions plus instant borrow at one, two, four and eight sources. The actions run from posting, changing and cancelling an offer, through accept, match, repay, collateral, claims, both liquidation routes, the in-kind fallback, the two lender sales (the listing route both when listed and when a buyer accepts it), preclose, refinance, NFT rental, vault deposit and withdrawal, Auto-lend slots and standing instructions. Each action runs as its own isolated transaction, so it starts cold the way a network transaction does. For each one the suite records the gas, the storage slots written and read, the calls the Diamond makes to itself, and the events.

`contracts/gas-suite/budgets.json` holds a budget and a stated reason for each action. The pre-deploy gate's full run now checks every measurement against its budget. An action over budget is a warning until the refactor pass ends, and a failure after it. A budget raised without a changed reason is always refused: every pull request checks this against its base, and the pre-deploy gate against the base branch. An action well under its budget gets a note asking for a lower budget, so the budgets follow the code.

The suite also checks the instant market's source rule from the design ruling on the instant borrow source cap. For a fill bound and the longest list of sources a borrow may carry, the rule adds three costs: the first fill, each further fill up to the bound, and a skip for every other source. The total must stay within 80% of the smallest per-transaction gas cap among the networks listed. It is checked for the bound the deploy sets, the code's default and the top of the range governance may set, with each guard read that prices an asset counted at its mainnet-shaped cost. The first measurement breaks it everywhere.

- One fill makes 72 calls to the price guard, 28 of which price an asset.
- Each of those reads is counted once, at the cost of a mainnet-shaped read: about 304 thousand gas on the most expensive path, through a pivot asset. The suite's own guard already charged about 19 thousand of that, so only the rest is added. One fill then needs about 14.9 million gas and each further fill about 15.1 million.
- A skipped source costs about 3.3 million gas.
- With the deploy's bound of two fills and one skip, a borrow can need about 33.8 million gas. That is over the 13.4 million allowed, which is 80% of Ethereum's cap of 2^24.

These are findings, which warn until the refactor pass ends. The deploy settings set the bound to 2.

The figures are for comparing one build with the next, not a network gas quote. Every price read runs the price guard's own code, from feeds the suite sets up, and each action records the guard calls it makes. Liquidity tiers and the swap venue are answered by test mocks. The health factor and the loan-to-value ratio are computed for real.

The suite needed one root fix to compile: a deploy library's frame was too deep once the gas tests pulled it in. Unchanged behaviour.

Closes #3915

_Committed 2026-11-22 18:53 UTC (b942bb587)._
<!-- assembled-fragment: 3915-gas-suite.md sha256=a288d1a94e92c59718702a1e2af60b2ad6bf4f6db530b3f0a5aff474b9d3e112 -->

## Troubleshooting — one error catalogue every reader uses (PR #3943)

Every error the platform's contracts can raise now has one catalogue entry, generated from the compiled interfaces: its name, its 4-byte selector and the values it carries. About 1,500 errors are listed, including a handful raised only by contracts the platform deploys without exporting their interface (the swap adapters, the reward custody holder), which the compiler's syntax tree supplies. Beside each entry, a second generated file lists every entry function whose reachable code can raise it, following internal calls, self-calls through the Diamond (so an error raised inside a host such as the fallback custody facet is listed under the liquidation and default that self-call it), and calls to the platform's own contracts, the price guard and its reader included. The list is a place to look, not a proof that some input reaches the raise; inline assembly and calls to outside contracts are not followed, and the file says so.

The plain meaning, who can act on an error (the user, an operator, nobody) and whether it should be impossible are written by hand in one file, `packages/contracts/errors/meanings.json`. The two hand-kept tables of friendly messages in the shared library, and its hand-copied selector list with its drift test, moved there: the apps, the keeper and support now read one answer. The 163 messages users already saw are unchanged, with three deliberate exceptions: the self-collateralized offer now shows the same plain message whichever way its error arrives; a step only the Diamond itself may take, called from outside, is now shown as a fault of the platform rather than as a technical note; and a Solidity panic (an overflow, a division by zero) is shown the same way. Nine messages for errors no current contract can raise were removed. Two paths that used to miss written messages now find them: in the app, a refusal the pre-sign simulation names (by name, not by selector) showed its name in words for every message that was keyed by selector; and alpha05's refusal wording looked messages up by name in a table keyed by selector, so it never found one.

A check refuses a meaning that names no shipped error, and the number of errors with no meaning may not rise: today 1,372 have none, and the count must be lowered whenever a meaning is written. The catalogue is rebuilt by the ABI export (which now also builds the syntax tree once, about five minutes cold), a stale catalogue fails the contracts package test, and stale "raised by" lists fail the pre-deploy gate (step 1f).

Closes #3916.

> Caveat: "raised by" is presence, not path feasibility: a raise behind a `catch` that swallows it is still listed, and a revert written in inline assembly is not seen.
> Caveat: meanings for the 1,372 errors without one are filled in over the refactor pass; until then those errors show their name turned into words.

_Committed 2026-11-22 09:29 UTC (90dc36671)._
<!-- assembled-fragment: 3916-error-catalogue.md sha256=39e9aa74df40233c51d3268f9c5d02c141570500cd9abd63fca6d6eeb8316cac -->

## Troubleshooting — a transaction explainer for operators

An operator can now ask what a transaction did, or what an attempt that was never sent would do, and get the answer in plain words and as data. The explainer lists each function entered, in order and by depth, with its arguments and the gas it used; each event emitted, in the order it was emitted, with the events a failed inner call undid marked as undone; and where the transaction stopped: the error, its values, and the error catalogue's meaning and who can act on it. When a caller turned one error into another, both are shown, with the place the first was raised.

The trace comes from the node when it offers one. When it does not, the command rebuilds the moment on a local copy of the chain: the state at the end of the parent block, the block's earlier transactions applied in their order, then this one. The rebuilt run is compared with the chain's receipt (success, gas used and every event). When they agree the output says it matched; when they do not, it is headed "approximate replay: what happened on chain is not shown here" and lists what differed. With neither a trace nor a rebuild, it shows the receipt's events and says that the functions and the code that ran are not known, giving the Diamond's route for the called function at the start and the end of the block instead.

Which code ran is read from the trace itself, from the address each Diamond call was forwarded to, so a refresh later in the same block cannot change the answer. An address the deployment record does not know is shown as an address and said to be unknown (the facet history, a later card, will name code a refresh replaced). Calls and events that match none of the checkout's ABIs are counted and said to come from a different build or from outside code.

The explainer is a pure function in the shared library, so the case file and the failed transaction record can reuse it; the command around it reads the node endpoint from the environment, never prints it, sends nothing and holds no key.

Closes #3917.

_Committed 2026-11-22 10:29 UTC (cced292d6)._
<!-- assembled-fragment: 3917-transaction-explainer.md sha256=6ff11a9076ab1603c96beeae5225f2c15ac26dbb1127edfc753fb6f9f6e36a4d -->

## Troubleshooting — the failed transaction record (PR #3988)

The indexer now keeps a record of every failed transaction sent to a contract in a network's deployment record, with the error decoded at the time, while the node still holds the state. It is the stored half of the troubleshooting picture: a failure seen days later can be read from the record instead of being rebuilt from a node that may no longer have the block.

The record is written only through a new internal route, under a token of its own. The writer is a separate service on the keeper machine (#3919), with its own user and no database binding, so the most it can do is add records, move its own cursor and mark ranges the chain replaced. It can touch no other table. Each write is bounded (twenty records, a size bound on each explanation) and refused whole if any part of it does not fit the rules. Every write names the Diamond it was made under, and it must be the one the indexer's deployment record names: across a fresh deploy, a writer and an indexer on different records are refused rather than filing one deployment's failures under the other, and so is a record from a block before the Diamond was deployed.

Each record says which source found it (the keeper's own sends, the explorer's list of transactions to a contract, the daily sampled audit, a trace filter, or a block scan), the pass's mode for that network at the time, and where its decoding came from (a node trace, a local rebuild, a plain replay, or none). It says what it cannot hold rather than leaving a blank: a replay has no call path, and a record whose block state was no longer reachable says so. A better source later replaces a weaker one; a weaker one never overwrites a better one.

A block the chain replaced is marked with the time it was found replaced, never deleted, and a transaction re-mined in the replacement block is a second record. Nothing in the record can be replayed from the chain, so it is kept across a fresh Diamond and is part of the nightly backup and the restore. A record too large for one database statement is restored in pieces that each fit, so a full-size explanation comes back whole. Records and their range rows are kept for 400 days; the indexer's scheduled pass removes anything older.

A new health route reports, per network, the pass's mode and how far behind its cursor is, the newest checkpoint, the last replacement, the gaps it could not scan, and for networks without a trace filter the audit's miss rate: how many failures a full scan found in the sampled windows that the other sources had missed.

Closes #3918

> Caveat: the record is for operators. Sender addresses are as public as the transactions, but the public data feed's address rules apply before any of it is shared outside.

_Committed 2026-11-22 12:34 UTC (78bd4903e)._
<!-- assembled-fragment: 3918-failed-transaction-record.md sha256=15abf300de2a40f36c5e8af7bfd436fbaaf989ccc6524052d2e905a08357ea48 -->

## Troubleshooting — the failed transaction pass (PR #4011)

A new service finds every failed transaction sent to a contract in a network's deployment record. It decodes each one while the node still holds the state, and stores it in the failed transaction record (#3918). Failures by anyone, from any front end, are now kept with their error decoded at the time. Before this, they were found only if someone happened to look while a node still had the block.

It runs on the keeper machine as a separate service, not as a Cloudflare Worker. On the free plan a Worker gets 10 ms of CPU per run, and decoding one transaction against the platform's full interface takes several times that. The service holds no signing key and has no database. It writes only through the indexer's failed-transaction route under a token of its own, and reads its own position back the same way. It runs under its own user, cannot read the keeper's settings or state, and is deployed by its own install script from a named commit on main.

How it finds failures depends on what each network's node offers, as measured by the node capability check (#3913). On BNB testnet the node offers a trace filter, which covers direct calls and calls made through other contracts. On Base Sepolia and Arbitrum Sepolia it reads the explorer's list of transactions sent to each contract and keeps the failed ones. The contracts users call directly are read every five minutes and the rest hourly. On those networks, a random 30 minutes of each day is also audited by reading every block in full. A failure the list missed is recorded and alerted, so completeness there is a measured miss rate on the health route, not a claim.

Each record uses the best source the node offers: the node's own trace (the full explanation), else a replay of the call at the block before (the error only, with what it cannot hold listed), else "state no longer reachable". A node that does not answer never downgrades a record: the service waits and tries again. A block the chain later replaced is detected by reading the last checkpoint twice. Its records are marked rather than deleted, and the range is scanned again. A range that cannot be scanned is recorded as a gap and alerted.

Closes #3919

> Caveat: on a network without an explorer key the keeper's own sends would be the continuous source, and they arrive with the keeper decision record (§4.4). Until then such a network is watched only during its audit window, and the health route states that share of the day.
> Caveat: a local rebuild of a transaction is not run by the service; an operator adds one with the explainer through the same route.
> Caveat: installing the service and setting the writer token on the indexer are operator steps.

_Committed 2026-11-22 14:24 UTC (d296a6f79)._
<!-- assembled-fragment: 3919-failed-transaction-pass.md sha256=025bf759500a9984564e6c4dc796ee934578ecb1b84e1ef401ec73870a6f8c01 -->

## Troubleshooting — which build each service was running, from when

The indexer now keeps a build history, so a past problem can be matched to the code that was serving at the time. Advances #3921. The second half of that card, where every derived row names the event that last changed it, follows in its own pull requests.

A row is added each time a service is seen running a build other than the one its latest row names, so a rollback to an earlier build is recorded as its own period. Each build is the commit stamp every deploy already records. A dirty build is marked as such, and a build that cannot be named is recorded as "unstamped" rather than left out.

How each service is seen:
- The indexer and the agent note their own version on their scheduled runs.
- The failed transaction pass names the commit its bundle was built from with each write it already sends.
- The app, the public site and alpha05 now serve a small `build.json` naming their commit, never cached. The indexer reads these files from their public addresses once an hour.

The indexer's reads run after a tick's chain work, and only with what that work left of the tick's allowance.

The history names no user. It cannot be rebuilt from the chain, so it is kept for the life of the deployment, archived nightly, and restored from the archive.

> Caveat: the keeper machine's own build is not yet in the history; the keeper's switch history and decision record cover it with the keeper's part of the design.

_Committed 2026-11-22 17:48 UTC (db7381d58)._
<!-- assembled-fragment: 3921-build-history.md sha256=33e28b6fd114d94fc4b28d1a1fc5dc2b4bc81885af2915c159e69c9ea56d32d4 -->

## Troubleshooting — the indexer's event history and the state at a block (PR #4016)

The indexer now keeps a full record of what the platform's contracts said on each network, so a past transaction can be explained from what was true at that moment. Advances #3921 (the build history and each row's last event follow in a second PR).

Every log from every platform contract in the deployment record is kept: the Diamond, the position token, and each standalone contract such as the VPFI token and the price guard. The testnet's mock assets, outside contracts such as the network's wrapped native token, and addresses on another chain are left out; every address in the deployment record is classified as a platform contract or not, and a new one must be classified before the shared package's tests pass. A log is decoded with the platform's own ABIs where one describes it, and kept raw (its topics and data) where none does, so an event no handler reads, or one this build cannot decode, is still on record. The users' activity feed is unchanged; this is a separate, complete table beside it.

Each change to the protocol's settings is recorded with the event, the values it carries and the transaction that made it. A reader applies the events' own values in order, so the answer is exact even for a transaction between two changes in one block. The full settings are also read at the end of each such block, for the values no event carries, including the list or table behind each event that records only a count or a version (the swap adapters, the treasury conversion targets, the asset list, the grace periods and the fee tier table version): a few blocks are read per pass, within the pass's allowance, and the record says these are end-of-block values. Where one block holds more than one change, every change except the last is marked as not knowing, from that read, what was in force between them. A block whose state the node can no longer answer for is marked unreadable after three tries, with the reason; the events' own values still stand.

Each change to the Diamond's routing is recorded from its cut event, one row per function, with the function's final routing in the cut: which code served which function from which point, and which functions were removed.

All three are written by the scan in the same pass as the block they come from, before that block's handlers, as one batch of a few statements per block however many logs it holds. A reader is told the first block on record, so an indexer that took this build on mid-chain says its history begins there rather than showing an empty past as a quiet one. They are cleared and rebuilt with the chain's other rows on a reorg rebuild or a new Diamond, and they are on the off-chain restore's clear list. The list of a deployment's contracts is now one shared rule, used by both the failed transaction pass and the indexer.

> Caveat: the price guard's own settings changes are kept in the event record but do not yet start a settings history row; that is a follow-up.
> Caveat: on a busy mainnet the extra contracts add their logs to each scan, which the pass's allowance already bounds.
> Caveat: history below the first block an existing indexer records is not backfilled; a fresh deploy covers its whole chain.

_Committed 2026-11-22 16:26 UTC (c76ae2f33)._
<!-- assembled-fragment: 3921-event-and-state-history.md sha256=d539a9709d987239e90589a9f8f533a12a23c6a7809e9c61a702198308ba1d73 -->

## Troubleshooting — the loan side tables name the event that last changed them

The rows the indexer keeps beside each loan now record the event that last
changed them, as offer and loan rows already do: the block, the transaction's
position in it, and the log's position. That covers the loan's lifecycle record,
NFT rental rights, swap-to-repay intents, prepay sale listings and the list of a
loan's position holders. A wrong rental, a listing with the wrong grace end or a
holder missing from a loan's history can each be followed back to the
transaction that produced it.

The three columns say what they know, by the same rule as the offer and loan
rows. A listing's grace end is read from the chain at its event's block, so a
listing row names that block rather than the event. When that pinned read fails
and the indexer falls back to the chain's head, it now says so. That read's
block cannot be named, so the row records unknown rather than keep naming
whatever it named before. The same now holds for every derived row: a write
whose figures came from an unnamed source makes the row unknown, while a
stored unknown still gives way to any later known position.

A holder the reconciliation repair confirmed on chain records the block it was
read at. Every other holder row names the event that made the wallet a holder.

Advances #3921. The signed offer book and the reward and recycling ledgers
follow, one group each, until every event-derived table carries the columns.

_Committed 2026-11-22 21:22 UTC (494c16ffd)._
<!-- assembled-fragment: 3921-row-last-event-loan-side.md sha256=3ab50534b2d5c51599e87f1c884058066b75ade0bb6cd24f332ff54b9b0844c7 -->

## Troubleshooting — offer and loan rows name the event that last changed them (PR #4025)

Every offer and loan row the indexer keeps now records the event that last
changed it: the block, the transaction's position in that block, and the log's
position. A wrong figure on an offer or a loan can be followed back to the one
transaction that produced it, and the transaction explainer then shows what that
transaction did. This is the first handler group of the troubleshooting design's
"a row back to its events" (TroubleshootingPictureDesign §4.6); the other
event-derived tables follow one group at a time.

The three columns say what they know. A row set from a read of the chain's state
(a heal of a stub, the settlement heal, the reconciliation repair, and every
handler that reads a loan or offer back at its event's block, since that read
returns the end of the block) records the block it was read at with no event position, which means "reflects every event
up to the end of that block". A row whose figures came from a read at the
chain's head, whose block cannot be named (the offer and loan detail reads made
as a row is first written), and a row last written before this change, record
nothing: unknown, never an event that did not produce the figures. The columns only ever move forward, by one shared
rule, because the handlers apply some events grouped by kind within a block: the
row names the latest event that wrote it in chain order, whatever order the
handlers ran in, and replaying an older block cannot move it back.

A static check now holds every write to these tables to the rule. It classifies
every table of the shared database (event-derived or not, with the reason),
keeps a list of event-derived tables still to be done that can only shrink, and
refuses any write to a finished table that neither sets the columns nor states,
in the statement itself, why it changes no figure an event produced (a review
flag cleared, a reminder's own stamp). The statements are found by parsing the
sources, so a write built outside the usual call is still found.

One cost: a match that consumes part of a borrower offer now marks that offer
with its own match's position, so a block with several such matches writes one
statement per match instead of one for the whole block.

Advances #3921. Still to do: the loan side tables (lifecycle state, rental
rights, swap-to-repay intents, prepay listings, participants), the signed offer
book, and the reward and recycling ledgers, one change each, until the pending
list is empty.

> Caveat: rows written before this change carry no last event until an event or a read next writes them; a fresh deploy's replay fills every row.

_Committed 2026-11-22 19:30 UTC (4ce59b35a)._
<!-- assembled-fragment: 3921-row-last-event-offers-loans.md sha256=53bc93c413051d24d14063af3d2a2617f1e4143e64eccfc30ec3108e9347b29f -->

## Troubleshooting — signed offers name the event that last changed them

Each signed offer in the book now records the chain event that last changed it
(the block, the transaction's position in it and the log's position), as offer,
loan and loan-side rows already do. A cancel, a nonce burn or a full fill names
its own event. A partial match's filled amount is read from the chain at the
match's block, so the row names that block rather than the event.

A signed offer is born off chain, from the maker's signature. Until an event
changes it, the columns stay empty: no event has touched it yet, and a filled
amount taken when the offer was posted comes from a read whose block is not
named. The posting route writes nothing new, so it keeps working while the
database migration is still being applied.

A rebuild after a chain reorganisation, and a restore from the off-chain
archive, set the columns back to empty with the rest of the order's chain
state, and the replay names the event that changes it next.

Advances #3921. The reward and recycling ledgers follow, and then every
event-derived table carries the columns.

_Committed 2026-11-22 22:47 UTC (647935644)._
<!-- assembled-fragment: 3921-row-last-event-signed-offers.md sha256=2e298325f213c324034701368a72f562e9c09c08c8a15dedb17e11cd6e600e10 -->

## Local testing — tooling for the review coverage pass (PR #4004)

The review coverage pass (ReviewCoveragePassDesign) now has its tooling. Every declaration under contracts/src gets a hash of its text with comments and spacing removed. A function moved to another file keeps its coverage, a comment-only edit keeps it, and one changed operator loses it. The ledger (contracts/review-coverage/ledger.json) records, per hash, four marks as opaque review numbers: the reader pass, the reviewer loop, the specification mark and the cross review. A declaration counts as covered only with all four. The ledger holds no findings.

One command prints the coverage report: the share of declaration code with all four marks and the share carrying each mark, per area and per file, and each uncovered declaration by name. Vendor code, the storage-layout probes and interfaces are excluded, each with its reason. The governance launch check reads the same report as JSON.

The entry check refuses a ledger entry whose hash is not a declaration at the commit it names. It also refuses a reader mark recorded by the thread that wrote the fix under review, a cross review made by the thread that made the first reader pass, and a new reviewer mark while the latest planted-fault run has a miss. In a shallow checkout it fetches the one commit an entry names before checking it. It runs in the pre-deploy gate and fails it. The report prints beside it as a warning until the audit freeze.

The unit tool lists, for a facet or a standalone contract, the declarations it owns plus the library functions its code reaches. It leaves out what is already covered and the shared libraries, which are reviewed in their own slices. Over the size limit it splits into slices of whole declarations, and it describes each one with its lines, what it calls outside the unit (including calls in modifier arguments and calls through the Diamond) and who calls it. The size ladder steps the limit down after a planted-fault miss. It steps up only on planted-fault runs at the next size that are caught in full and include a missing-rule fault. The first such run makes the new size provisional. A second confirms it once the two runs between them cover all five lenses and all three depths. Each run counts once: recording the same run again is refused.

The rest connects to the private review repository. The tool makes the two branches of a review-only pull request, finding each declaration again in the head when a fix has been merged on top (a fix from this repository is carried across as a change against the commit the copy was made from, the workflow files left out), checking that the head restores exactly the reviewed tree, and holding the size limit on that tree, and refuses one whose head or base differs from the pinned commit by more than the unit. A file's file-level declarations (types, constants, free functions) are reviewed with the first non-interface contract in the file, or as a unit of their own, named by the file's path, when the file has none. A re-cut slice replaces its pushed branches only over the tips it saw. A slice larger than one review unit is refused by name, since a single struct or function cannot yet be split (#4008). The head's commit records exactly which declarations the slice holds, and the tool writes the pull request's description itself from that record (never from a slice worked out again, which a fix that adds or removes declarations would change), in a workspace whose sources it first checks are the head's byte for byte: the slice plus the cross-cutting rules checklist, and refuses a hand-written one that differs. It never opens one against main, and it cleans up branches. The one-way copy to the review repository refuses while that repository's workflows are enabled. It leaves out the workflow files and the dependency-update config, and checks that the copy differs from the pinned commit by exactly those paths. The review repository itself is an owner step that is not done yet.

The reports tool (#3914) and this one now follow self-calls through the Diamond by one shared rule, and resolve a virtual call in inherited code to the reviewed contract's override. Before it posts, the open step checks that the base and head are the pair cut for the slice and that their difference is exactly the slice's files.

Closes #3936.

_Committed 2026-11-22 14:35 UTC (c65d2d141)._
<!-- assembled-fragment: 3936-review-coverage.md sha256=4296c97ac4f18f3f0e744cb4900a2df3b7d94bc97dd86e3a2f79b5f19a196d73 -->

## Local testing — the mechanical entry gate check (PR #4004)

Some rules belong to no one facet: every entry point of a certain kind must carry a certain check. Examples are refusing a flagged wallet, refusing under a pause, holding the re-entry guard, asking the Terms rule, or being callable only by the Diamond. Those rules are now written down once, in one rules file the Security thread keeps, and a new check compares every entry point with it.

The check reads the compiler's syntax tree. For each state-changing entry point of every shipped contract, it lists the modifiers on the entry and the checks the code reaches before it first changes state. It follows internal and library calls in place and reads a modifier up to its placeholder; a call out made inside a modifier before the placeholder counts like one in the body, and a modifier is read as Solidity runs it, for the entry and for every helper: its code before the placeholder, then what it wraps (conditional if the placeholder may be skipped), then its code after the placeholder before the caller resumes. A check under a condition does not count, nor one reached after a helper that may already have returned, and neither does one placed after a storage write, an external call that changes state, or a call back into the Diamond that changes state. An entry that a rule applies to, with none of its checks and no exemption, is reported with the rule and the reason. An exemption needs a reason, and one that names no entry, names an entry the rule does not cover, or covers an entry that already carries the check is refused.

The same file produces the checklist each review-only pull request carries in the review coverage pass, with the unit's entry points listed against each rule.

Every path a caller can reach is an entry, including a contract's receive and fallback functions and the Diamond proxy's own. An early return counts too: when a modifier still runs code after the function body that may change state (a call out after its placeholder), a check placed after the return holds only on some paths, and the check says so. An early return that reaches only the re-entry lock's release weakens nothing. A storage write in a modifier's argument runs before the body, so it counts as a state change; only a modifier's own code is exempt for its writes.

The check is bounded and says so. It does not see a check reached only through a function pointer, an assembly block or a call deeper than eight levels. Any call it cannot read counts as a possible state change, so no check after it is credited: a helper deeper than that, a call through a function pointer (held in a variable, a struct field or an array), and a contract creation, whose constructor runs. Only calls it can name as harmless are passed: conversions, pure built-ins such as hashing and encoding, and public getters on other contracts. It does not judge whether a check is correct. The review does that.

Until the check reports nothing, the rules file and its output stay in the private review repository, and the tool takes the file as an argument. After that the file moves into this repository and the pre-deploy gate blocks on it, so a new entry point is refused until it carries each check its kind requires. Until then the gate step says no rules file is present and passes.

Closes #3944.

_Committed 2026-11-22 14:35 UTC (c65d2d141)._
<!-- assembled-fragment: 3944-entry-gate-check.md sha256=d76c45ce9ece3b06110ddefc19d701d2b69aa8a8997da3401e65f5e46f196e22 -->

## Local testing — the canonical specification's folder check

The new canonical specification folder, `docs/CanonicalSpec`, now has a check that reads every block in it. It refuses anything the folder's rules forbid. The rules are in CanonicalSpecDesign §3 and §4, and the block grammar is in the README of `packages/canonical-spec`. A statement may not carry a figure, a date, an issue reference, a word of history or anything shaped like code. Each statement needs the parts its kind requires, exactly one record entry, and an approval that matches its current text. Each mistake needs exactly one answering statement. Each lifecycle model must refuse every step out of state, must not hold two rows the check cannot tell apart, and must reach every state from its start.

The check fails closed. If it cannot read a line under a statement or a model, it reports the file and the line instead of skipping the block, so a statement can never silently owe no tests. It runs in two modes. Draft mode is for a domain under review: a new record entry may name what raised it. Folder mode is for the committed folder and needs the owner's approval hash on every entry. The check also prints the approval hashes for the record, and a neighbours report of the statements on each model step.

The wording list holds only salted hashes, so the refused words never appear in the public tree. CI runs the check's own tests, and runs the check over the folder whenever the folder exists.

A follow-up makes three things stricter or clearer. Every table the check keys on has one row shape: a malformed id or an empty required cell is refused by name, not read as a missing entry. A mistake list names each answer on an "Answered by" line, which must agree with the answering statement both ways and never stands beside "Waits for". And a promise owed to another domain that has since entered the checked set prints a notice, which never fails the check, so a stale promise is seen.

Closes #3948, #4032

_Committed 2026-11-22 21:06 UTC (c45bb5db4)._
<!-- assembled-fragment: 3948-canonical-spec-folder-check.md sha256=c4d6b998a1d08ca2ea0e6cc0bb00c46ccf85ab3763cbdb7a7576b6571387ef8c -->

## Thread — reward broadcasts and tier pushes accepted only from Base

A mirror chain now checks which chain a reward message came from before
acting on it. A day's finalized broadcast, a user's tier push and a
tier-table version bump are each accepted only when the source chain the
messenger reports is the canonical chain the mirror is configured
against. Before this change the tier receivers checked the source but
the broadcast receiver did not: any peer the messenger authenticated,
another mirror included, could have delivered a day's global figures.

The rule now lives in one place and both paths use it, with the kind of
traffic as part of the rule. A mirror accepts both kinds from its
configured canonical chain. A chain that has detached accepts a day's
broadcast only from the canonical chain it detached from, so a day
already in flight when it detached still lands; it accepts no tier push
or tier-table bump at all, and such a message stays a failed message
that can be re-executed. A canonical chain and a chain with no reward
role accept none of these messages.

The broadcast receiver's interface now carries the source chain, which
the reward messenger already knew and now passes on. A new public read
reports, for tier traffic and for the day broadcast separately, the
chain a Diamond accepts it from, or zero when it accepts none.

Because the messenger now calls its Diamond through a different entry,
the reward messenger's published wire generation goes up by one. The
all-facets refresh upgrades a messenger whose generation is below the
build's, so a refresh installs the new messenger alongside the new
receiver; otherwise every day broadcast on a refreshed mirror would be
refused as an unknown function.

The next deploy is fresh, so no running chain has to cross this change
in place.

Closes #903

_Committed 2026-11-22 21:30 UTC (f2dc4105d)._
<!-- assembled-fragment: 903-reward-ingress-source-chain.md sha256=d6df4777864fd640792d8176e00f23961a589b0586e8f9ce910fb4249adc39f9 -->

## The board's Roadmap gets start and target dates

The hourly label sync now also fills two issue fields that the owner created for the Roadmap view: Start Date and Target Date.

Start Date is when work began. For a pull request it is the day it was opened. For an issue it is the earlier of the day its first linked pull request was opened and the day it was first labelled `stage:building`, or the day the issue was opened when neither exists. Target Date is the day an issue or pull request closed. Open items get no invented target date, a value set by hand on an open issue stays, and a reopened item loses only the close date the job wrote.

The job uses the workflow's own token over REST only, writes only values that differ, and caps its reads and writes per run, so the first fill of the whole board spreads over about a dozen hourly runs.

_Committed 2026-11-22 03:04 UTC (956b11edf)._
<!-- assembled-fragment: board-dates-sync.md sha256=6ae3d88636a9c80b8fa4bb51cfe27133182f096cf5ba27619a87081b3ae574a7 -->
