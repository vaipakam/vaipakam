# Release Notes — 2026-11-09

The day's largest contract change routes every movement out of a user's vault through one platform rule, which names the destination for each kind of movement (#3205 part 2, Stage A). Claims, the lender's share of a repayment and a new loan's principal now land in the payee's vault, and no vault holds a token allowance between transactions. Pricing also moves out of the Diamond: a standalone price guard built at deploy now gives every price the Diamond acts on, with its numeraire fixed when the guard is built and every later change waiting its delay on production chains (#3272). A discounted liquidation's discount is now fixed when the loan starts, so it cannot be moved within one block (#910). All of these reach a chain only by a fresh deploy.

The rest of the day covers:
- **The new app (alpha05):** an Alerts page with a header count, plus Telegram, push and health-warning setup. A Settings page shows approvals, keeper permissions and risk access. NFT rentals arrive: list, request and rent. The offer book is now wallet-gated, the app can be installed, and it warns on public-queue networks (now including Polygon) and on offer rates far from recent loans. Payouts credited to the vault are stated and measured.
- **Keepers:** a backup runner on Chainlink Automation covers permissionless upkeep, held payout releases and offers whose position moved. The keeper itself clears dead listings and offers and writes hourly price checkpoints for the forced-sale floor. Every new pass and step ships switched off.
- **Policy:** no bug bounty is offered.

## Thread — alpha05 sets up Telegram, push and health warnings (PR #3420)

The new app (alpha05) now sets up the alerts that reach a wallet outside the
app. The Alerts page has a section under the inbox for Telegram, push, health
warnings and payment reminders. Until now the page sent people to the current
app for this.

Every change is a free wallet signature over a plain message that names what
it does: link Telegram, unlink it, send a test alert, or save a setting. The
words come from the same shared source the alert service checks them
against, so what the wallet shows and what the service checks cannot differ.
A save carries only the setting it changes. The service accepts each signed
request once, and the page asks for a fresh signature when one is refused as
already used. A declined signature sends nothing.

Telegram is linked with a one-time code that lasts ten minutes. The link
counts as proven only after a test alert reaches the chat. Unlinking says
which networks it covered: every network for an ordinary wallet, or one
network for a smart-account wallet. It also says when protected mode keeps a
chat receiving alerts until the protection delay passes. Push is offered
only when the alert service says it can send right now, and the page says
when push would carry payment reminders but not health warnings. Health
warnings are always on once a channel is set up. Their three levels are
fixed in Basic and can be edited in Advanced. Payment reminders can be
switched off and on.

The alert service does not report back what it has stored, so each card
states what this browser has done and when, and says that a link or setting
made on another device may exist. Linking Telegram and switching push on ask
for the Terms first; switching anything off never does.

Advances #3180. The paid-push consent is the next part of Alerts.

_Committed 2026-11-09 09:04 UTC (aaf7559a3)._
<!-- assembled-fragment: 3180-alpha05-alert-channels.md sha256=cabd91d320fb442b3f064843e847f61f50a1c194fcf1108b54da30c51de81c84 -->

## Thread — alpha05 gets an Alerts page and a header count (PR #3400)

The next app now has an Alerts page. It lists the free alerts the protocol's index keeps for the connected wallet on its network, newest first: when a loan starts, is repaid in part or in full, defaults or is liquidated, nears its due date, enters or leaves its grace period, or its health falls below 1.5, 1.2 or 1.05, and when a reward entry nears or passes its claim deadline. Each alert is one short sentence with its time and a link to the loan, whose page reads it from the chain, or to Claims for a reward entry. Nothing to sign up for and nothing to pay.

A bell beside the wallet in the header counts the alerts that arrived since the Alerts page was last opened in this browser, and opening the page marks them as seen. The index does the counting over all of the wallet's alerts, so one written late with an older date is still counted, and when the count cannot be read the bell says so instead of showing an old number. Which alerts are new is remembered in this browser only.

The index's alerts route gains an optional count of the alerts written after a given one, with the wallet's newest alert id, which the bell reads.

The page states what it cannot do rather than hiding it. An alert of a kind the app has no words for yet is shown and named, an outcome the index found by its own check rather than from an event says when it was found and that when it happened is not known, alerts the app could not read are counted, and an index that does not answer is said so, never shown as an empty inbox. Telegram and push alerts are still set up in the current app, and the page links there; they come to the next app in a later change.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-INBOX. Part of epic #3180.

_Committed 2026-11-09 05:04 UTC (e58327d39)._
<!-- assembled-fragment: 3180-alpha05-alerts-inbox.md sha256=975e069a3a88d6f32f3060c63a317d2804d5caf805cfda58be7486452bdc9ffc -->

## Thread — alpha05 Settings lists and withdraws your approvals (PR #3457)

The new app's Settings page now has an Approvals section: the standing
approvals the connected wallet gives the protocol on its network. A token
allowance shows how much it lets the protocol move, or that it has no limit;
an allowance given through Permit2 shows its amount and expiry; an approval
over a whole NFT collection, or over one NFT, says so.

No chain read lists every approval a wallet has given, so the page checks
the suggested assets and every asset the wallet's deposits, loans, offers
and standing offers on this network name, plus any token or collection the reader adds. It says
how many assets it checked and that an approval for any other token is not
found there. A record it could not read to the end, or an asset that did
not answer, is stated, never shown as "no approval".

Each approval is withdrawn in one wallet confirmation with its own receipt:
what it lets the protocol move now, what still lets it move the asset
afterwards, and that no funds move. Another approval of the same asset (the
whole collection's approval when one NFT's is withdrawn, or the Permit2
allowance when a token's is) stays in place and is named; when it could not
be read, the receipt says so instead of saying nothing remains. The approval is read again right before the wallet opens, and the
outcome is read back from the chain. The receipt says that anything relying
on the approval, such as a step started in another app, refuses until it is
approved again; withdrawing a Permit2 allowance leaves the token's own
approval for Permit2, which other apps may use, unchanged.

Advances #3180.

_Committed 2026-11-09 16:24 UTC (1e261af1d)._
<!-- assembled-fragment: 3180-alpha05-approvals.md sha256=28a45f1d037bce4bf35e4e5cd87877e993d1cafc453837b055d8a664e76237a3 -->

## Thread — alpha05 can be installed as an app (PR #3465)

The new app can now be installed to a phone's home screen or a computer's
app list. It carries a manifest with its name, icons and four shortcuts:
Offers, Positions, Vault and Alerts.

In Advanced mode, Settings has an Install the app section. Where the
browser has offered to install the app, a button opens the browser's own
prompt and the page states its answer. Where it has not, the page says
which case this is: the app is already installed, the device is an iPhone or
iPad (install through Safari's Share menu), or the browser has not offered
it. It never shows a button that would do nothing.

A deployed build now keeps copies of its own code files on the device so it
opens faster, and only once the page has used each file, so a phone never
downloads parts of the app the reader does not visit. Page loads, prices,
balances, positions and every request to another service are never answered
from saved copies; they always go to the network, so a new deploy is seen
at once and its files replace the old ones. The section says so, and says
when a browser cannot keep files.

Your data in this browser now counts these saved files on their own, and
erasing removes them too; they come back as the app is used.

Advances #3180.

_Committed 2026-11-09 18:31 UTC (56a0853ad)._
<!-- assembled-fragment: 3180-alpha05-install.md sha256=f1798fd46e1fd9a2cf0fd0f06a04afcbc2b0356f04013e8eb4ee8b93cf086d23 -->

## Thread — alpha05 Settings shows and changes your keeper permissions (PR #3461)

The new app's Settings page now has a Keepers section: the connected
wallet's keeper settings on its network. It shows the master switch, each
keeper the wallet approved (at most five) and the actions each may take,
with whose side each action drives (the lender side, the borrower side,
either side, or the account) and where it reaches.

Everything starts off. The section says plainly that a keeper acts only
while access is on and it holds the action. A step on a loan also needs that
loan or offer to name the keeper; an account action (filling or rolling
standing offers, or locking a protected account) needs nothing more, and the
receipt of a grant that adds one says so. It also says that a keeper never receives
funds and cannot claim, withdraw or transfer anything; that each position
follows the settings of the wallet holding it now; and when the protocol has
paused every keeper. The app names its own keeper on a network only from the
deployment record, and says so where it runs none.

Turning access off and removing a keeper are offered in either mode.
Turning access on, approving a keeper and changing its actions are in
Advanced mode. A change that gives a keeper more asks for the Terms first
where a version is in force; taking a permission away never does. Each
change is one wallet confirmation with its own receipt, built from settings
read when the review opens, refused before the wallet where the protocol
would refuse it, read again right before the wallet opens, and read back
from the chain afterwards. While the protocol is paused no change can be
made, removing included, and the section says so instead of offering one.

Advances #3180.

_Committed 2026-11-09 17:26 UTC (d68f97f12)._
<!-- assembled-fragment: 3180-alpha05-keepers.md sha256=053c77975cf212d8ff301089560d2c448f42f324ea7881458f7bd4c44f3871de -->

## Thread — alpha05 reads the offer book only once a wallet connects (PR #3419)

The new app (alpha05) no longer reads any part of the offer book before a
wallet connects. This was an owner decision: the book, an offer's own page,
and the offers and requests Borrow and Lend list for a pair are read only
once a wallet is connected on a network the app serves.

Until then, Offers asks the visitor to connect a wallet to see the book and
their own offers, an offer's page asks for a wallet to see that offer, and
Borrow and Lend ask for a wallet to see what is open for a pair. The pair
picker also waits for a wallet. A wallet on a network the app does not
serve is told to switch, and nothing is read for it from another network.

The rule is recorded as RB-OFFER-GATE in the alpha05 rulebook, and the
offer book and offer page rules now point to it. The user guides, Basic and
Advanced in all ten languages, no longer say the book and offer pages can
be read without a wallet.

Advances #3180.

_Committed 2026-11-09 05:43 UTC (dda5fb793)._
<!-- assembled-fragment: 3180-alpha05-offer-book-wallet-gate.md sha256=9d40a449dbbc81c2036bf5a6e07eaf2ef2aba93a6c6cd8a863460c2daa3362f7 -->

## Thread — alpha05 asks before push alerts can cost anything (PR #3448)

The new app (alpha05) now shows and changes a wallet's agreement to pay for
push alerts. On some networks the alert service charges a small fee in VPFI
for push alerts about a loan. It can charge only a wallet that has agreed on
chain, and only up to the most that wallet agreed to pay.

The Alerts page has a Paid push alerts section. It states the fee per loan
side on this network, set by the protocol, and whether the alert service
charges here. The fee is taken from free VPFI in the wallet's own vault, at
most once per loan side, on the first paid push alert about that loan. A fee
already charged is not refunded, and Telegram alerts are free. The section
warns when the vault holds less free VPFI than the fee.

Agreeing records a cap: by default the fee now, or in Advanced any figure up
to the protocol's ceiling of 50 VPFI. The section says plainly that a fee
rise within the cap is charged without asking again, and that agreeing to
the ceiling accepts any fee governance can set. The agreement is checked and
dry-run before the wallet opens, and the fee is read again just before; if
it moved, nothing is sent. Agreeing asks for the Terms first.

Withdrawing is offered whenever an agreement is stored, whatever the Terms,
a pause or the alert service say. Where the alert service cannot be asked,
agreeing waits. On a deployment without the agreement record, the section
says whether that deployment can still charge the fee.

Advances #3180.

_Committed 2026-11-09 11:45 UTC (395bc8ab4)._
<!-- assembled-fragment: 3180-alpha05-paid-push.md sha256=4591fc0748373b39cb8e9932f439cc048bff1a17a5e6f27bd808cbe3142fec79 -->

## Thread — The next app warns before signing on networks with a public queue (PR #3397)

On Ethereum, BNB Chain and BNB Testnet, a sent transaction waits in a public queue before it is included, and anyone watching that queue, bots included, can see it and act first. Someone could take an offer before its cancel lands, or act on a loan before a repayment does.

In the next app, the review of posting, taking or cancelling an offer, repaying in full or in part, and adding collateral now says so on those networks, before the wallet opens. Its help explains that some wallets can send a transaction privately, that neither the protocol nor the app can choose that route, and that the usual route changes only who can see the transaction before it lands. The app names no private sending service. On Base, Arbitrum, Optimism and their test networks, which keep no public queue, nothing is shown.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-PUBLIC-QUEUE. Part of #3357; epic #3180.

_Committed 2026-11-09 01:49 UTC (5b2fd3e81)._
<!-- assembled-fragment: 3180-alpha05-public-queue.md sha256=8ddbdbdce64f009e000f837ffab4f9fc16a97ee95748eb9b974c20a29769c5c1 -->

## Thread — The next app warns when an offer's rate is far from recent loans (PR #3394)

Both posting forms in the next app, a lender's offer and a borrower's request, now show how the typed rate compares with recent loans. Under the rate field, the form reads from the index the loans that started on the same pair and term in the last 30 days and shows their middle rate and how many there were.

A rate more than five points away from that middle rate is a warning that says which way it cuts. A lender far under the market, or a borrower far over it, posts the offer that is taken first when rates move. The other way, the offer may sit untaken. Within five points the form shows a plain note.

Only agreed rates the index can back are counted, and loans opened by a lender's sale of a running loan are left out, since a sale is not a fresh rate. Loans on the pair whose terms the index has not yet confirmed cannot be placed in a term, so the form states how many there are beside the comparison. When there are no recent loans to compare with, when the collateral is an NFT, or when the index cannot be read, the form says so, so a missing comparison never looks like a clean one. The warning never blocks posting.

New offers still default to a 7-day expiry. Choosing to keep an offer open until it is taken or cancelled now shows a note that such an offer keeps its rate as the market moves.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RATE-CHECK. Part of #3357; epic #3180.

_Committed 2026-11-09 00:50 UTC (c68475e0d)._
<!-- assembled-fragment: 3180-alpha05-rate-check.md sha256=ffca07089ddf7a70faea52fda8a11efec74b013aa4de933e2a0842881fa65b75 -->

## Thread — alpha05 can list an NFT for rent (PR #3468)

An owner can now list an NFT for rent on the new app's Rent page. A short
form asks for the collection and the token's number (and a quantity for a
multi-token collection), the token renters pay in, the daily fee as one
figure, the term, the rent rule (pro-rata or full term) and how long the
listing stays open. It has no collateral or rate fields, because a rental
carries neither.

The review states that the NFT moves from the owner's wallet into the
owner's own vault and stays there while the listing is open and while it is
rented, what a renter would pay up front, the buffer share the listing
fixes at today's setting when it is posted, what the owner receives (the
rent due, less the protocol's share, which is fixed when a renter takes
the listing), the grace period and what a default does. A token the wallet
does not hold, or too few units, is said before any wallet step, and the
review reads again on its own once that changes.

The wallet is asked to let the protocol move that one token (for a
multi-token collection, the whole collection for this listing only, taken
back afterwards whatever happens), the listing is tried as a dry run, and
then posted. The outcome is measured from the transaction: the listing
recorded and the NFT in the owner's vault, with a link to the listing's
own page. Posting a renter's request still points to the current app.

Advances #3180.

_Committed 2026-11-09 21:50 UTC (1f2dce5d5)._
<!-- assembled-fragment: 3180-alpha05-rent-list.md sha256=d92dde76409bceb0adb88e24c79c8ec041444dbd39647fd4b6bc4c638fd4530b -->

## Thread — alpha05 can post a request to rent an NFT (PR #3469)

A renter can now ask to rent a named NFT on the new app's Rent page. The
form is the listing form worded for the renter: the collection and the
token's number (and a quantity for a multi-token collection), the token the
renter pays in, the daily fee as one figure, the term, the rent rule and how
long the request stays open. Only one of the two forms is open at a time,
and the rental book steps aside while either is.

The review states that the rent for the whole term and a buffer move from
the renter's wallet into the renter's own vault now and stay there while the
request is open, that the buffer share is fixed by the request at today's
setting, that the term runs from when an owner takes the request, and that
an owner who takes it starts the rental at once with no further step from
the renter. It also states what comes back on time, the grace period, the
late fee, what a default does, and that cancelling returns the rent and
buffer to the wallet.

A wallet short of the rent and buffer is told so before any wallet step, and
the review reads again on its own once that changes. A token that does not
exist yet is noted, and a token the wallet already holds is refused, since
nobody else could take the request. The wallet approves exactly the rent and
buffer, the request is tried as a dry run, and then posted; the approval is
put back if it does not go through. The outcome is measured from the
transaction: the request recorded and the rent and buffer in the renter's
vault, with a link to the request's own page. Taking a renter's request
still points to the current app.

Advances #3180.

_Committed 2026-11-09 23:02 UTC (78d9925fc)._
<!-- assembled-fragment: 3180-alpha05-rent-request.md sha256=0d26ede9fe4447fdd2884ae74bd4330847d5ac46e02e6bbdadbafe2c4ce219a9 -->

## Thread — alpha05 can rent an NFT (PR #3466)

The new app now has a Rent page. It shows the rental part of the offer
book on the wallet's network, owners' listings first. When nothing is
listed it says so, and on a test network it points to the faucet for a
test NFT and test tokens.

A rental row and an offer's page now say a rental has no collateral and no
ratio, instead of showing an empty collateral amount.

An owner's listing can now be rented from its page. The review states what
moves from the wallet into the renter's own vault: the daily fee for the
whole term plus the buffer, and whether the buffer share was fixed by the
listing or comes from today's setting. It also states that the renter gets
the right to use the NFT, never the NFT, which stays in the owner's vault;
the rent rule; what comes back on a timely close; the late fee taken from
the buffer; and that a rental never closes by itself and what a default
takes. A wallet short of rent plus buffer is told so before any wallet
step.

Renting signs the exact terms, approves exactly the payment and runs a dry
run before sending. The outcome is checked on the chain: the rental
started, the payment reached the renter's vault, and the owner's vault
names the renter as the NFT's user. Taking a renter's request and listing
an NFT for rent come next; the page says where they are done today.

Advances #3180.

_Committed 2026-11-09 20:40 UTC (fb4993f4b)._
<!-- assembled-fragment: 3180-alpha05-rent.md sha256=f96d68e050853685e085ac5fdb58aff6e9c0cafc8017d8c06ade368a966ecd23 -->

## Thread — alpha05 Settings shows and changes your risk access (PR #3456)

The new app's Settings page now has a Risk access section. It says, in
words, which risk level counts for the connected wallet on its network, and
why that can differ from the level the wallet chose: a raise still in the
protocol's waiting period, with the time it counts, or new risk terms, under
which the level counts as blue-chip only until it is confirmed again. It
says whether the network enforces risk levels at all, and whether strict
mode is on, off, or switched off but still applying until a stated time.

A level stopped by new risk terms can be confirmed in one wallet step in
either mode. In Advanced mode the reader can raise or lower the level and
turn strict mode on or off. Each change is one wallet confirmation with its
own receipt: the level now and after, which pairs it reaches, when it takes
effect, and that no funds move. A raise still waiting is never offered
again, because a second one would start the wait over. Lowering takes
effect at once and says that pairs above the new level close to new offers
and requests, the wallet's own open ones included, while loans already open
are not affected. Switching strict mode off says it removes a check and
when it stops applying. On a network that does not enforce risk levels, the
page and the receipt say a change is only saved, and counts if the check is
switched on.

A level change names the change counter and risk-terms version it was read
with, so a change made elsewhere, or new terms published in between, makes
the transaction refuse and change nothing. Agreements to a single pair stay
in the borrow and lend flows that need them.

Advances #3180.

_Committed 2026-11-09 14:58 UTC (416eaf10d)._
<!-- assembled-fragment: 3180-alpha05-risk-settings.md sha256=488e85809320c384e938b9f89f83a395568e662af8bff9a52d624f396e338c2a -->

## Thread — alpha05 gets a Settings page (PR #3451)

The new app (alpha05) now has a Settings page, reached from the foot of the
menu on every screen size.

Mode, theme and language need no wallet, apply at once and stay in this
browser. The theme follows the device until one is chosen, and the page says
which it is following. The language picker offers the ten languages; one not
translated yet is said to show English until it is.

With a wallet connected, the page shows the Terms of Service state on that
network: none in force, the version accepted with its fingerprint, or a
version in force and not accepted yet. Acceptance is asked at the first
action that needs it, never on this page, and repaying, claiming and
withdrawing never need it. A read that failed says it could not confirm,
which is not the same as not accepted. The fee-discount setting from Home is
here too.

The page says what this browser keeps for the app, that nothing secret is
stored, and that the app sends no error reports or diagnostics. It also
states how many items an erasure would remove, before anything is erased.
Download gives a file of the app's own records in this browser, naming the
wallet addresses they are kept under; the wallet connection's own session
items are counted in it but not copied out.

Erase ends the wallet connection first, then removes everything this site
keeps in the browser, including the language cookie shared with the other
Vaipakam sites. It writes back only the wallet libraries' markers that keep a
wallet disconnected, so the reload cannot reconnect one that still trusts
the site, and reloads so every preference visibly resets. The report of what
was removed, and of anything the browser refused with its reason, stays on
the page for that tab; if the browser will not keep it through the reload,
the page stays and shows it instead. Positions and history on chain, the alert
service's settings, the marketing site and the wallet app are not touched,
and the confirmation says so.

Advances #3180.

_Committed 2026-11-09 13:07 UTC (6c9df9e62)._
<!-- assembled-fragment: 3180-alpha05-settings.md sha256=b92863bb8d7dc1f1c8ca64d339f0ecd6eaaad0f7308188fcca596dd333d19e6c -->

## Thread — every movement out of a vault through one policy (#3205 part 2, Stage A)

Every movement out of a user's vault now passes one platform rule: a withdrawal, a claim, a fee, a settlement leg, a liquidation pull or an allowance. The rule names the movement's destination class (the owner, the position holder, the counterparty, the treasury, the backstop, a swap adapter, a listing escrow, a stored party's claim custody, and the rest), checks the destination against loan state, and emits one movement record with the vault, asset, amount sent and received, destination, class, reason and loan or offer. The vault then checks the destination again on its own knowledge: its recorded owner, the position-NFT contract's holder, a governance-owned registry, and the fact that every genuine vault runs the same code. The vault's old withdraw and approve entries are gone; it has one door out and one door for allowances.

Three behaviours change for users. An owner's own withdrawal pays only the owner's own wallet unless protected mode allows another address. Claims, the lender's share of an open loan's repayment and a new loan's principal are paid into the payee's vault, from which the payee withdraws. A discounted liquidation pays the seized collateral only to the liquidator that paid, and the backstop's warehoused collateral can be swept only to the treasury.

No vault holds an allowance between transactions any more. A swap-to-repay fill is granted exactly its lot inside the fill, and a collateral listing's ERC-721 is approved to the marketplace conduit only inside the fill. An ERC-1155 listing moves its lot into an escrow the vault creates for that listing, which is the marketplace order's seller; every teardown brings the rest back.

ForcedSaleFacet had reached 11 bytes under the contract size limit, so its two previews move to a new ForcedSalePreviewFacet, with the sizing rule both read in one shared library. A launch is now refused until the registry names the treasury and carries every route the platform sells or lists through. Design and every decided default: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage A build notes).

> Caveat: the backstop vault and the aggregator adapter, which hold lender positions, claim through one shared rule that withdraws the claim's vault credit to them. Both are their own upgradeable contracts and change with this release.
> Caveat: Stage A does not yet bound an amount by an owner-signed lien. That, the class budgets, the payee-receipt release and the seller-claim check are Stage B (#3379). No deployment happens before Stage B.
> Caveat: the launch check needs the protocol registry (#3383); until it lands, every launch refuses.
> Caveat: a share that cannot follow its holder yet is parked with the loan's stored party until the claim (#3381 makes it follow the holder).
> Caveat: AutoLifecycleFacet and EncumbranceMutateFacet are next to split for size (#3385).

_Committed 2026-11-09 09:54 UTC (836a0b0e4)._
<!-- assembled-fragment: 3205-part2-stage-a-vault-outflow-policy.md sha256=6fa5e21fafc456a9b46a01776cb27bd8d8b6a266184fe212c1e521670bf34db2 -->

## Thread — The Diamond prices through the price guard (#3272, part 2)

Every price the Diamond acts on now comes from the standalone price guard that part 1 built at deploy. The oracle facet keeps its price reads, with the same answers, and forwards each one to the guard the protocol registry points at. The pricing code and its settings have left the Diamond: the feed registry, the chain's WETH, the ETH price feed, the stable references, the per-feed overrides, the sequencer feed, the cross-check and secondary sources with their bounds, and the industrial fork's pivot settings are all the guard's own settings now. Each changes only through the guard's delayed, cancellable change. The Diamond's setters and getters for them are removed, and the storage they wrote is retired.

The numeraire is fixed with the guard (owner decision 2026-11-09). The live numeraire switch, its kill switch and the threshold resets it drove are removed. The Diamond records the guard's numeraire once, when the deploy records the protocol registry, and refuses every price from a guard quoted in another numeraire. It never compares a threshold in one unit with a price in another. A missing guard is treated as a deploy defect, not as "no price", so it can never hand a lender the whole collateral on a price nobody looked up.

The deploy and configure scripts now write the guard through its own delayed changes. On a testnet, whose delay is zero, a change applies in the same run; on a production chain it is left pending and reported, and the launch readiness check refuses the chain until it is executed. Every in-place refresh refuses a Diamond from before the guard, so that crossing is the next fresh deploy.

The protocol console reads the guard's settings beside the Diamond's, at the same block. It also shows the guard's address, owner, guardian and delay, and the registry the Diamond reads it through. The numeraire rows show the fixed numeraire and its feeds; the rotation and PAD-denominator rows are gone. The indexer hears only the Diamond's events, so a change on the guard reaches the console on the next periodic refresh. Design: docs/DesignsAndPlans/PriceGuardDesign.md. It advances #3272; the vaults read the guard in #3268.

_Committed 2026-11-09 18:41 UTC (69fdcfac0)._
<!-- assembled-fragment: 3272-price-guard-part2.md sha256=fb6eb221f34ee5b18f67c3a3e1be75108de0860b4a52a019e8817472e025c0ea -->

## Thread — A standalone price guard, built at deploy (#3272, part 1)

Every fresh deploy now builds a price guard: a standalone contract that prices assets by the same rules the Diamond's oracle uses today (the Chainlink feed through the chain's feed registry, the ETH fallback, the stale and stable-peg rules, the L2 sequencer check, the Pyth cross-check and the two-of-three secondary quorum). It is meant to become the one price source for both the Diamond and the user vaults, so that a faulty facet cannot influence the price a vault checks against. In this first part nothing reads it yet; the Diamond's oracle moves onto it in part 2, and the vaults read it in #3268, at an address fixed in the vault code, since a vault never reads a changeable registry (#3431).

The protocol registry points at the guard from construction, the one write that does not wait. The guard's numeraire is fixed when it is built (owner decision 2026-11-09): changing the currency prices are quoted in means a new guard, never a live switch. Its starting settings apply at once (owner decision 2026-11-09), so the deploy builds it with the chain's feed registry, WETH, ETH price feed, sequencer feed and stable references from the same deploy settings the oracle's configure step reads. A production chain's deploy refuses to build a guard that lacks its feed registry, WETH or ETH price feed. On a testnet a missing entry is left for the configure step, which the testnet's zero delay lets apply at once. Because the registry is built inside the Diamond deploy, the chain's feed registry is now created there too; the later feed registry step reuses it.

Every later change waits the guard's own delay: one to fourteen days on a production chain, three by default, and none on a testnet. The owner (the Timelock after handover) proposes, anyone executes once the delay has passed, and the owner or the guardian (the Pauser Safe) may cancel. One change waits per setting, and each keeps the wait it was proposed with. Raising the delay is instant; lowering it waits. The guardian may stop a secondary price source at once, which can only shrink the quorum; turning it back on waits. The guard cannot be upgraded and its ownership cannot be renounced.

A differential test runs the guard and the Diamond's oracle against the same fuzzed feeds, secondary sources, Pyth and sequencer states and checks that every price, status and refusal matches. The handover moves the guard's ownership to the Timelock and its guardian to the Pauser Safe. Design: docs/DesignsAndPlans/PriceGuardDesign.md. It advances #3272.

_Committed 2026-11-09 11:51 UTC (9fcdeb2a9)._
<!-- assembled-fragment: 3272-price-guard.md sha256=ff6cbae9696d506e9be78ccfdd25fab8fb3cf26c5044a9b14aad2b206a77a76a -->

## Thread — Keeper clears listings and offers whose position moved

The keeper's hourly teardown duty now also clears the flows a position change has made impossible to complete. A prepay listing or a swap-to-repay intent whose borrower position changed hands since it was posted is cleared at once, without waiting for its grace or cancel-grace window. A vehicle offer bound to a moved position is cancelled: a preclose offset, a lender-sale listing, or a refinance request (also when a later request replaced it). Its refund goes to whoever posted it. The protocol made each of these open to anyone in #3389; this is the keeper backing every permissionless step needs.

To find them without simulating every live flow on every run, the protocol gains two read-only answers that apply the same rule the teardowns apply. One says whether a position's route for a given flow is dead. The other says whether an offer's route is dead. The keeper reads them at one block, then still asks the protocol whether each teardown would succeed before sending it. A flow that is still live costs no simulation.

Cancelling an offer is refused while the protocol is paused, so those cancels run last, with the intents. A lender-sale listing that is both expired and moved is still torn down by the existing sale teardown, which also starts the seller's relist cooldown.

The duty stays switched off behind its existing flag and pays only gas. The two new reads reach the testnets at the next fresh deploy. Until then the duty's new reads fail on the older Diamonds and are reported as unread, and its other work goes on.

Advances #3336 (the app and indexer hiding of dead listings remains).

_Committed 2026-11-09 04:10 UTC (d54249e72)._
<!-- assembled-fragment: 3336-keeper-moved-position-sweep.md sha256=3099f9f17d659c26934d1027ff092760f997000f138b6971dfba864f3d0dcc4a -->

## Thread — Keeper backup on Chainlink Automation

A new standalone contract, the keeper backup runner, lets Chainlink Automation run a set of permissionless upkeep steps when our own keeper has left them undone too long. The keeper runs on one machine, so until now a step nobody else called stayed undone while that machine was down, out of gas or stuck.

The runner keeps no rule of its own about when a step is due. On each check it tries every candidate step in a call whose effects are always undone and keeps only whether it would succeed, so it cannot drift from the protocol. A due step is first noted, and is run only if it is still due after a delay set per step (an hour by default, 15 minutes for the grace auto-listing, which the protocol accepts only inside a grace that can be one hour); if our keeper runs it in the meantime, the runner does nothing.

It covers daily rental deductions, expired listing and intent teardowns, the grace auto-listing of NFT collateral, past-grace defaults and periodic-interest stamps that need no sale, the Base reward-day close, the lapses, skips and recycling of finished reward days, and the vault-code changes whose delay has passed. It does not cover liquidations or matching, anything needing a swap route, quote or cross-chain fee, steps found only from event history, the reward-day finalize, or backstop fills. The design note is docs/DesignsAndPlans/KeeperBackupAutomationDesign.md.

The runner holds no funds and attaches no value to any call. It accepts runs only from its Chainlink forwarder, and builds every call itself from a step id, so a compromised forwarder can call nothing but the listed steps. Tokens a step pays it go only to the treasury fixed at deployment.

Every step ships switched off. Deploying it, registering the upkeep with Chainlink and funding it with LINK, and switching on each step are owner decisions per chain. Delayed protected payouts and position releases can be added once the protected-account facets expose a read that lists them.

Closes #3361

> Caveat: a liquid loan past grace is not backed, because its default needs a sale and the runner passes no swap route.

_Committed 2026-11-09 00:11 UTC (a5cc7d308)._
<!-- assembled-fragment: 3361-keeper-backup-automation.md sha256=1a02471b223067f6269d3966c914a843f71c89240982dc919a6ce083696e8344 -->

## Thread — Keeper backup releases held payouts

The keeper backup runner on Chainlink Automation now also releases a protected account's held payouts once their delay is over, when our own keeper has left them waiting longer than the runner's lag. Releasing a held payout was already open to anyone; until now only our keeper could find the ones that were due, because they were listed per account and the runner has no list of accounts.

The protocol now keeps one list of every payout still waiting, across all accounts. A payout joins it when it is held back and leaves it when it is released or cancelled, in the same places the per-account list changes. Two new reads, a count and a page of that list, let any keeper find matured payouts. The runner pages through the list the way it pages through active loans.

The protocol still decides what is due. A payout still in its delay, on a locked account, waiting for a co-signer or addressed to a screened-out recipient is not due, so the runner leaves it. The owner can still cancel a held payout during its delay as before. The new step ships switched off, like every other step.

The list starts empty on a Diamond that is refreshed in place, so payouts held before such a refresh are not on it. It reaches the testnets at the next fresh deploy. Position-NFT holder unlocks follow once the position token lists its pending unlocks.

Refs #3361

_Committed 2026-11-09 01:59 UTC (2cf7d7f12)._
<!-- assembled-fragment: 3361-keeper-backup-payout-releases.md sha256=8826f6955fb7699b141652d912b0bfc4b6aeb5cfa7988ee2315bc64d2a0f0a48 -->

## Thread — No bug bounty is offered (PR #3452)

The public website overview (all ten languages), the English whitepaper,
SECURITY.md and the planning docs no longer mention or promise a bug bounty
programme. The owner decided on 2026-11-09 that none is offered: the code is
not frozen for review and features are still being added.

SECURITY.md now says plainly that no bounty exists, that no rewards are paid
for reports, and that any claim of a Vaipakam bounty or payout is not from
the project. The private disclosure channels are unchanged.

The functional specs record the decision: mainnet readiness needs an external
audit after the code freeze, and whether to run a bounty is decided after the
freeze. The website footer carries no bounty link.

Issue #3364 is closed as not planned and relabelled as internal, deferred
planning.

> Caveat: Terms of Service version 1 still says security reports go "via the bug bounty link in the footer". That text is frozen and pinned on-chain by hash, so changing it needs a Terms version 2 and an on-chain update. It is left for an owner decision.
> Caveat: The 2%-of-supply tokenomics allocation keeps its "Bug Bounty" label; the whitepaper now states it is a treasury reserve and not an offer.

_Committed 2026-11-09 12:34 UTC (3d21455fb)._
<!-- assembled-fragment: 3364-no-bug-bounty-offered.md sha256=5799fbb211b94711ffd8f63d8cfdc7c4c275d5ac296ce03116deadbfcf574e22 -->

## Thread — Hourly price checkpoints for the forced-sale floor

The keeper can now write the hourly price checkpoints that the tighter forced-sale floor (#3359) reads. That floor lets a forced sale of deep, calm collateral lose less than the full 6% to the market, and it counts a pair as calm only when its oracle rate now is close to its rate at both of the last two hourly checkpoints. Anyone may write a checkpoint, but until something does it every hour, every forced sale uses the full 6%.

Twice an hour, on each chain with a Diamond, the keeper takes the lending and collateral assets of the active loans whose two legs are both tokens. It checks at the latest block which of them have no checkpoint yet for that block's hour and have an oracle price that reads. It then records those, 25 to a transaction, simulated first. The second run in the hour is a retry: it sends only what the first run left, so a healthy hour costs one transaction per chain. An asset whose price does not read is not sent, because the contract would skip it too. A Diamond that does not carry the floor yet is skipped, and the run says so.

Each run line gives the hour, how many assets were already recorded, how many this run recorded, any filed under the next hour because the transaction landed after the hour turned, any another caller recorded first, and any left without a price. A missed hour can only send a sale back to the full 6% for the next two hours. It can never make a floor tighter. The checkpoint stores only the oracle's own reading and moves no value.

The pass ships disarmed behind its own flag, so it stays off until an owner arms it on the keeper machine.

Closes #3384

_Committed 2026-11-09 01:06 UTC (4354c4d62)._
<!-- assembled-fragment: 3384-price-checkpoint-pass.md sha256=b80930d5ac40a98246393fa9121854e6e6aafbb1cf1d2ee4ccf2e9c64e3699f7 -->

## Thread — alpha05 states and measures vault-credited payouts (with PR #3387)

With the vault outflow policy, a loan claim no longer pays the claimer's wallet: the protocol credits it to the current position holder's own vault, as that holder's free funds, whatever its protected mode. A new loan's net principal lands in the borrower's vault the same way. alpha05 described and measured the old behaviour, so its loan claim, Claim everything and borrow flows would have reported a correct claim or loan as only partly done.

Each of those flows now names the vault as the destination before signing, says that protected mode delays only the later withdrawal, and measures the credit from the protocol's own record of the movement into the reader's vault: one that stayed in the reader's own vault counts, one into another vault, for another loan, or of a class the protocol does not credit never does. When the vault cannot be read after the transaction, the credit is stated as unmeasured rather than as missing. The finish card offers the withdrawal from the vault page.

A borrower's acceptance now shows two figures where it showed one: the amount less the fee credited to the vault, and the small fee share the protocol pays back to the sender's wallet. Both, plus the rest of the fee, must add up to the principal the loan recorded, or the outcome says it is not substantiated. The borrow request's receipt and the borrow, lend and lending-offer explanations say the amount goes into the borrower's own vault.

Seller claims, extension reserves, standing-offer capital, free vault VPFI, payroll, cancellations and taking back collateral are unchanged: the protocol still pays those to the wallet, or where protected mode routes them. The withdrawal description now says the protocol pays an account without protected mode only to its own wallet.

Advances #3386 alongside #3205 part 2. The public guide's wording for claims and borrowing follows when these contracts reach the testnets.

_Committed 2026-11-09 09:54 UTC (836a0b0e4)._
<!-- assembled-fragment: 3386-alpha05-vault-credits.md sha256=e093b4a8e19f2a13685252f96d41f82027f44fe918642b12203bbc6d82c3251a -->

## Thread — Keeper backup clears offers whose position moved

The keeper backup runner on Chainlink Automation now also cancels a preclose offset, a lender-sale listing or a refinance request whose position has moved since it was posted, or, for a refinance request, that a later request replaced. It does this when our own keeper has left such an offer in place longer than the runner's lag. Such an offer can never complete. Until somebody cancels it, it stays in the book and holds its creator's locked assets, and the cancel refunds them to the creator.

The runner cancels an offer only while the protocol itself reports that the offer's route is dead. Our keeper reads the same thing, so the two follow one rule. The runner never cancels an offer that has merely expired. Anyone may clear one of those, and no keeper is owed that.

Collateral listings and swap-to-repay intents whose position moved needed no change. The protocol has allowed their teardown at once since the moved-position sweep, and the runner's existing listing and intent steps ask the protocol whether each teardown would succeed. So they already cover the moved case.

The new step ships switched off, like every other step. On a Diamond that does not yet have the dead-route read, the step finds nothing. The read reaches the testnets at the next fresh deploy.

Closes #3417

_Committed 2026-11-09 14:47 UTC (a03c55509)._
<!-- assembled-fragment: 3417-keeper-backup-moved-routes.md sha256=2df92a17fd4c21534e73653d8162fc220c055db64bbf10a825a91f07c5798c4a -->

## Thread — alpha05 names Polygon among the networks with a public queue (PR #3454)

Before signing a cancel, a repayment, added collateral or an offer, the new app (alpha05) warns on networks where a sent transaction waits in a public queue that anyone, bots included, can watch and act on first. The list named Ethereum, BNB Chain and BNB Testnet. Polygon PoS keeps a public queue too and is in the first mainnet set, so a user there would have signed with no notice.

Polygon PoS and its test network Amoy are now on the list. The app does not serve either yet, so nothing changes on screen today; the notice is there the day either network is added. The notice's wording is unchanged, and the user guide's list of networks with a public queue now names Polygon in every language.

Closes #3445.

_Committed 2026-11-09 14:00 UTC (19684be99)._
<!-- assembled-fragment: 3445-alpha05-polygon-public-queue.md sha256=888fb8ba9ce2809ac77fdce1ca678e5145c719a73b98df8d158005fdcd845255 -->

## Thread — The discounted liquidation's discount is fixed when the loan starts (PR #3467)

A discounted liquidation gives the liquidator the collateral at a discount that depends on how deep the collateral's market is: the thinner the market, the wider the discount. Until now the route measured that depth at the moment of the liquidation, with the same read new positions use. That read deliberately drops a pool whose current price disagrees with the oracle. So a liquidator could push one deep pool's price in the liquidation's own block, make the collateral look thinner, and take a wider discount out of the borrower's surplus. A keeper lowering the asset's tier later had the same effect on every open loan. The route is switched off on every chain, so nothing was exposed, but it had to be fixed before the route is ever switched on.

The tier and its discount are now recorded on the loan when it starts, and the route and its preview read only that record. The recorded tier is the lower of two readings. One is the collateral's close-out depth tier: its pools' average depth over the look-back window, valued at the oracle price, which nothing done in one block can move. The other is the keeper's tier for the asset. The discount is that tier's discount at that time. After the start, no later pool movement, keeper-tier change or change to the discount table alters it, so a borrower knows from the start what a liquidator on this route would receive.

The trade-off is stated, not hidden. If the collateral's market genuinely thins during the loan, the recorded discount does not widen to attract liquidators. The ordinary liquidation routes stay available for such a loan. A loan whose collateral had no tier at the start is refused by this route for its whole life, as an untiered loan already was.

Two fields are appended to the loan record, so the loan details read carries them. Existing loans on the testnets carry no record and are refused by the route until the next fresh deploy; the route is off there anyway.

Closes #910. Also answers the check #3351 asked for: a keeper-tier change no longer reaches an open loan's discount.

_Committed 2026-11-09 22:16 UTC (397f84b8e)._
<!-- assembled-fragment: 910-discount-stamped-at-loan-start.md sha256=6912754acbcd84eda29ff5ea38895e4932cbcb0b0da4c009b3c86ccd287070a9 -->
