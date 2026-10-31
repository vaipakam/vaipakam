# Release Notes — 2026-10-28

Today a lender who sells their position keeps the interest they earned, as a claim the loan pays before the new holder, and the app gains one-click Repay all, Close all early, Refinance all and List all for sale for loans that came from one offer. Most of the keeper work closes the gap where a permissionless step had no keeper behind it: the keeper now backs removed remit destinations, grace listings, prepay-sale sanctions commits, expired buyback intents, finished reward days and entries, returns of reward VPFI to Base and owed tier pushes, and every pass stops reading in time to send. A mirror can now skip a reward day whose delivery parts disagree, remit parts are sized by both ends of the lane, and keeper sends carry the shared gas-limit margin. The contracts now build for one EVM target, the cadence admission rule is checked again when a loan opens, and the off-chain backups gain a watcher, a monthly archive and retries for transient storage faults. On the app and website side, liquidation prices, interest schedules, forced-close wording and the user guide were brought in line with what ships. The contract changes reach the testnets only with the all-waves fresh deploy.

## Thread — a lender who sells keeps the interest they earned (PR #3068)

A lender who sold their position used to forfeit all the interest they had
earned and not yet been paid, and that interest went to the treasury. Now the
seller keeps it, as a claim on the loan. The buyer still pays only the
outstanding principal, so no buyer funds more than their offer says. The
seller's only cost at the sale is the rate shortfall, when the buyer takes a
higher rate than the loan pays, and that goes to the buyer as before. The
treasury takes nothing at the sale.

The seller is paid when the borrower pays. Every later interest payment to the
lender side, of any kind, pays the open seller claims first, oldest first, and
then the current holder. That includes the interest paid when a borrower hands
the loan to a new borrower and the payoff of an offset close. The yield fee is
taken once, when interest is paid, whoever receives it, and a seller's share
pays the loan's own fee: the current holder's VPFI fee discount applies only
to the interest the holder is paid. A seller's share lands in their own vault,
set aside for them, and they withdraw it when they choose; a share for a
sanctions-flagged seller waits there until they are clear, and a seller seen
flagged when a share is credited stays frozen even through an outage of the
sanctions source. When a loan ends in a short recovery, the holder's principal
is paid first, then the seller claims oldest first. A recovery the platform
cannot value pays the holder only. Whatever a claim is not paid is stated in
its closing event.

Interest the borrower paid while the seller's share was frozen for sanctions
was set aside for the lender and never reached the seller. At the sale that
interest is paid to the seller, into their own vault, and the rest of the
set-aside money moves to the buyer as before. A seller who is still flagged
is paid into their own vault, locked until they are clear. If the party the
loan records as frozen is an earlier holder who is still flagged, the sale is
refused and the sale verdict names that party. Interest
accrues on the ledger while a loan is active or waiting in a pending fallback,
and a change of principal during the fallback first settles the stretch at the
old principal. It stops when the loan ends, so a closed loan reports
nothing earned and no principal owed there; the lender side's claim on the
closed loan is what it is owed.

Repaid principal counts as paid to the holder only once it reaches them, so
principal that waits in the holder's claim on a closed loan (an internal match
that closes it) is paid to the holder before any seller claim. A payment that
carries no yield fee, such as a periodic settlement made by selling
collateral, pays a seller gross. The seller's vault is opened at the sale, so a
seller flagged later cannot block another party's repayment or claim. Wherever
the platform shows the holder their claim on a closed loan, it shows what they
will be paid, after the sellers' part. An automatic renewal into the owner's
standing offer is refused for a position with open seller claims; it settles
through the ordinary claim instead.

Underneath, each loan now keeps an exact interest ledger: every stretch of time
is priced at the principal and rate in force over it, and interest counts as
paid only when it reaches the payee. This replaces the old "paid through" mark
and its long list of special cases (#1808). The principal and rate are written
through one library that checkpoints the ledger first, and a guard test fails
if anything else writes them. A loan carries at most four open seller claims;
a sale that would open a fifth is refused, and the sale verdict names that
reason.

The new host is `SellerClaimFacet`. It refreshes together with the payout,
sale and claim facets. Because the ledger opens lazily at the loan's start, an
in-place refresh across this change is refused while any ERC-20 loan is open,
and the curated refresh scripts refuse a Diamond that predates the ledger.
Testnets get it with the all-waves fresh deploy.

The connected app's sale screens still show the old forfeiture figure and need
to show the claim instead; that is handed to the app thread. The sale path's
interaction-reward forfeiture is unchanged.

Closes #1209. Closes #1808.

> Caveat: a recovery that cannot be valued (no trusted price, an illiquid asset, an NFT) pays the holder in full and closes the seller claims unpaid.
> Caveat: no in-place upgrade path; a chain with open ERC-20 loans reaches this only by fresh deploy.

_Committed 2026-10-28 23:31 UTC (c4e59dd8e)._
<!-- assembled-fragment: 1209-seller-keeps-interest-claim.md sha256=87a2d8b6e2fcec5d4a64389040c073e81bc61d24d7ca44639bb5804c33c0971a -->

## Thread — Repay all and Close all early on loans from one offer (PR #3060)

When one of a borrower's offers filled into two or more loans that are
still open, the Positions page now shows a card for that offer with
"Repay all" and, in Advanced mode, "Close all early". The borrower
approves the total once and then signs one transaction for up to 30
loans, instead of one approval and one transaction per loan.

The checks the loan page runs before a repayment or early close (live
status, position still held, grace on the live term, accepted sale,
refinance request, offset offer, sanctions) now live in one per-loan
plan that the loan page and the batch both use, so the two cannot
drift. Two small page changes come with that move: the allowance pad is
worked out from the loan's live principal and rate, and early close
checks the offset lock live before signing.

A loan with anything the borrower should see first (a sale waiting to
complete, a refinance request, an offset offer, a loan in its fallback
period, a rental) is left out of the batch and named, with a pointer to
its own page. The batch goes through the Diamond's existing multicall
(the owner's choice over a wallet batch, so every wallet gets one
prompt) with each loan allowed to fail on its own, so one loan that fails never
undoes the others. Afterwards every loan is read back from the chain at
the block the transaction mined in: repaid, still open with the reason,
changed another way, or unreadable. Every loan is checked again in full
right before its transaction is sent, including that the wallet still
holds its position. The approval is set back only when it is established
that nothing closed, and the approval left standing is always read from
the chain and stated. The card stays with its results until dismissed, also while the
positions lists cannot be read.
A transaction that is sent but not yet confirmed is reported as such,
never as a failure. The review is the usual six-row review and repeats,
under each loan, what its own page says before an early close: the
interest rule, the late fee when past due, and a paid tariff that is not
refunded.

Advances #126 (slice 1 of 3; the lender's "List all for sale" and the
borrower's "Refinance all" follow). Design:
`docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one offer into two loans.

_Committed 2026-10-28 17:34 UTC (9a68540da)._
<!-- assembled-fragment: 126-batch-close-out.md sha256=79cc6d3a72773f3c8980bd9b44cf62c357a7daeca2e3a0c44eeab97429b5dfdb -->

## Thread — Refinance all on loans from one offer (PR #3067)

A borrower whose offer filled into two or more open loans can now post a
refinance request for all of them at once from the Positions page. In
Advanced mode, the borrower's card for that offer has "Refinance all" next
to "Repay all" and "Close all early". The borrower picks one highest rate
and one duration, reviews every loan, approves once, and signs one
transaction for up to 15 requests instead of up to three wallet steps per
loan.

The checks the loan page's refinance form runs before a request is posted
(sanctions, the borrower position still held by its original borrower, both
assets unpaused, the loan active and within its grace window, the fee terms
reviewed, no request already on record) now live in one per-loan plan that
the form and the batch both use, so the two cannot drift.

The review shows, for each loan, today's payoff, how much more it can grow
after the due date, the spare balance an acceptance needs, and what the
loan's own page says before a request. It states the total spare balance,
which the wallet must hold now, and the one approval for the sum of the
largest payoffs, and says that this approval also serves any other open
refinance request on the same token. Where a loan's guardrails need
writing, the write goes in the same transaction right before its request,
so a request is never posted without them. Every loan is checked again in
full right before its transaction is sent, and one whose largest payoff
or spare amount grew is left out, so no request is posted needing more
than the balance that was checked.

Which loans got a request is taken from the transaction's own record: a
request posted (with its offer number, which the loan's page then shows and
can cancel), no request with the reason, no longer active, not confirmed
yet, or unreadable. The approval is set back only when it is certain that no
request was posted.

Advances #126 (slice 3 of 3).
Design: `docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one borrower offer into two loans.

_Committed 2026-10-28 19:17 UTC (26f5935c4)._
<!-- assembled-fragment: 126-batch-refinance.md sha256=a3bc97a8cb8b3030f5046c35d1ae2623c1b5ace0735ce22e19972ec7290c1bac -->

## Thread — List all for sale on lender positions from one offer (PR #3066)

When one of a lender's offers filled into two or more loans whose lender
positions the wallet still holds, the Positions page now shows a card for
that offer, in Advanced mode, with "List all for sale". On a network
where listing is not available yet, the card says so instead of
disappearing. The lender picks one rate and one
listing window, reviews every loan, and signs one transaction for up to
30 listings instead of one per loan. Listing draws nothing from the
wallet and asks for no approval.

The checks the loan page's listing form runs before a listing is signed
(sanctions, the position still held, both assets unpaused, the loan
active and far enough from its due date, and a simulation of the exact
listing) now live in one per-loan plan that the form and the batch both
use, so the two cannot drift.

The review shows, for each loan, the minimum the lender is guaranteed if
a buyer takes the listing, anything already set aside for the lender
that goes to the buyer, today's settlement, and what that loan's own
page says before a listing (a Full fee mode travels to the buyer; a rate
above the loan's own costs the difference). It discloses the lock on
each listed position, and one consent covers exactly what the review
shows. Each listing is bound to the figures reviewed, and is skipped
rather than made if it would record worse ones. A loan the platform
would refuse is left out and named with the reason; every loan is
checked again in full right before its transaction is sent.

Which loans were listed is taken from the transaction's own record, not
assumed: listed (with its sale offer, which its loan page then shows and
can cancel), not listed with the reason, no longer active, not confirmed
yet, or unreadable.

Advances #126 (slice 2 of 3; the borrower's "Refinance all" follows).
Design: `docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one lender offer into two loans.

_Committed 2026-10-28 18:32 UTC (cec836415)._
<!-- assembled-fragment: 126-batch-sale-listing.md sha256=19775c459f1507817d0a6b44669a5d0aaaa3b4e0cdb944e65c0e1e68f8ca321d -->

## Thread — Search engines index only the language copies that are translated (PR #3036)

Every page on the marketing site still has a copy under each language's
address, so a visitor who picks Spanish keeps Spanish navigation everywhere.
What changes is what the site tells search engines. A copy whose body fell
back to English, which today is the Terms, the Privacy Policy and the
whitepaper in every language other than English, now names the English page
as its canonical and is left out of the sitemap and of the language
alternates. Before, those copies were advertised as Spanish, French and so on
while their text was English, which offered search engines English duplicates
as localized pages.

One declaration says where each page's body comes from: a per-language file
(the guides, the overview, the whitepaper, the protocol console reference), a
text written in English only (the legal pages), or the page's translated
interface strings (everything else). A copy is indexed when its body exists
in its language, so a translated whitepaper or legal text joins the index by
itself the moment its file is added, with no list to update. The pages read
that declaration at runtime and the sitemap reads it at build time, and the
prerender step now checks every page it snapshots against the sitemap's
answer, so a deploy stops if the two ever disagree. Each help page also picks
the text it shows by that same rule, so a translation that is indexed is the
one served, and the prerender checks the language of the body each page
actually rendered as well as its head. The protocol console reference used
to sit on a separate English-only list in the sitemap and prerender steps,
where a translation could never have been advertised; it now goes through the
same pass as every other page, so its language addresses get prerendered
copies too, canonical to English until a translation exists. The language alternates
moved into the same per-page step that sets the canonical and the robots
directive, since all three are one decision about the page. Closes #1314.

_Committed 2026-10-28 11:05 UTC (ba70e6db9)._
<!-- assembled-fragment: 1314-index-translated-bodies.md sha256=0e928e7b0916c3d055666e8af3366289990cac9babd04ff219560ccc8aa62ff9 -->

## Backups — a watcher and a ledger the backup job cannot write (PR #3033)

The nightly off-chain archive Worker checked its own archives, with keys it
also held, so nothing it checked could survive the Worker being compromised.
This adds the first slice of the backup security design: a daily watcher that
runs on GitHub instead of Cloudflare, and a ledger bucket under Object Lock
that the Worker holds no key to.

Each run records every archive version it has not seen before: it downloads
the archive, computes its SHA-256 and length from the bytes, compares them with
the archive's manifest, and writes one ledger entry under a compliance-mode
retention that nobody, the account master key included, can delete or shorten.
Entries for daily and monthly archives are kept 400 days, longer than the
archives themselves; entries for yearly archives are kept ten years and
lengthened every run while the archive still exists.

It then pages, through one alert issue and the ops chat, on a missing period,
a period holding more than one archive, a copy of an older archive in a newer
period, an archive that disagrees with its manifest (checked again whenever
the manifest beside a recorded archive changes), a ledger entry with a second
version or a hide marker (the ledger key can add, never remove, so any
addition the watcher did not make is visible), an archive hidden or deleted
before its lifecycle could do it, and a yearly entry whose retention could not be
lengthened. A run that cannot reach a verdict opens a separate "not running"
issue, so an unknown state is never reported as a broken backup. Nothing it
prints names an archive, because the random part of an archive's name is what
keeps a leaked write key from replacing it.

A one-time setup script creates the ledger bucket and the watcher's two
narrowly scoped keys and stores them straight into the repository's secrets
without printing them. Until the owner runs it, the workflow reports that it
is not running.

Advances #1469 and #1473 (slice 1 of three in
docs/DesignsAndPlans/BackupSecurityDesign.md). Slice 2 moves the Worker to
encryption for offline public keys and removes its read key and healthcheck.

> Caveat: archives already in the bucket on the ledger's first run are recorded as found then; their entries prove they have not changed since, not that they were genuine before.
> Caveat: the original account setup script and the baseline finder still carry their own copies of the B2 authorize helper; moving them onto the shared module is #3032.

_Committed 2026-10-28 11:11 UTC (470cc5170)._
<!-- assembled-fragment: 1473-backup-ledger-watcher.md sha256=42529ae785b910913e7737a175bfebd4cdf2c6cd93c15704e5760f202e979505 -->

## Thread — the docs path gate checks that every cited path exists (PR #3023)

The blocking docs path gate on the operator runbooks used to catch one thing: a citation of a directory that had been removed or renamed. It now also catches a runbook that links to, or shows as code, a repository path the tracked tree does not have, such as a wrong spec path, a script that was deleted, or a file name with a typo.

That second rule waited for a real markdown parser. The gate used to find links and code spans with patterns, and every pattern mistake would have turned into a false alarm under a rule that reports anything it cannot find. Links and code spans now come from the same CommonMark parser the excision gate already uses. The words taken out of command text stay a loose guess on purpose, and only the removed-directory rule reads them. A code span counts as a path only when it starts at a top-level entry of the repository, a span starting with ./ or ../ is relative to a working directory and is not judged, and a path the committed ignore files cover (such as the contracts .env file an operator is told to create) is not a finding. A new set of fixtures pins each case the original review found wrong.

Fifteen stale citations in the runbooks were fixed in the same change: two moved spec and release-note paths, a publish step that pointed at a file that never existed, a future mainnet artifact now written with its slug placeholder, and mentions of deleted scripts and the removed lz-watcher written as prose rather than as paths.

Closes #1486.

> Caveat: the gate still covers docs/ops/ only. Widening it to the design docs is #1462.

_Committed 2026-10-28 09:52 UTC (50b56770a)._
<!-- assembled-fragment: 1486-docs-cited-path-exists.md sha256=9140ac0e3be393a820e85be9b63d5094242657d2e4f6b1505a6fe5777b81504e -->

## Thread — The VPFI discounts chapter is current and in all ten guide languages (PR #3037)

The Advanced user guide's "How VPFI Discounts Work" chapter existed only in
English, and the English itself had fallen behind the protocol. It described
the old cross-chain tier push, which made a user's own deposit or withdrawal
fail when the protocol's broadcast budget ran dry, a Dashboard "Push my tier
to mirrors now" button the app no longer has, and a requirement to hold VPFI
on every other chain that the fee path does not apply. Translating it as it
stood would have put those claims into nine more languages.

The chapter is rewritten from the tokenomics specification and then
translated. It now says what the discount reduces (the lender's yield fee at
each interest settlement, the borrower's initiation fee once at acceptance on
a liquid loan), that it comes off the fee in the loan's own asset, that the
switch is per chain and must also be on for Base, how the tier is worked out
(the minimum holding period, the recency-weighted average and the lowest tier
touched, written as three separate checks), and how the tier reaches other
chains: each chain delivered on its own, never failing the user's action, a
lower tier sent at once and a higher one paid for at most once a day. It says
plainly what the app does not offer yet (paying to deliver a tier sooner, or
refreshing a tier that rose with time alone), and that a copy whose tier has
not changed is not resent. The operator notes name today's configuration.

The chapter also says plainly that an update held back by the once-a-day
limit, or one the budget could not pay, is not resent by itself when the
wait ends: it goes with the next update to the tier record on Base, or when
someone makes the delivery call, which the app does not offer yet.

The short "How your VPFI tier travels across chains" section under Buy VPFI,
which repeated the stale claims, now summarises the chapter in all ten
languages and points to it. The anchor-parity check no longer records any
missing chapter.

Closes #1593. Anchoring the chapter's cards in all ten editions is #1597.

_Committed 2026-10-28 11:13 UTC (5a705b66b)._
<!-- assembled-fragment: 1593-vpfi-discounts-chapter.md sha256=44d9f7e186bc12fd8b567c17a0a09cf4e3b1e4432939c052ac1fb2882a597f42 -->

## Thread — Every user-guide chapter has a stable anchor (PR #3043)

Each chapter of the Basic and Advanced user guides, in all ten languages, now
carries its own anchor, named after the English title (for example
`chapter.how-vpfi-discounts-work`) and identical in every edition. A link can
therefore name a chapter and land on it in the reader's own language, as it
already could for the sections inside a chapter.

The four sections of "How VPFI Discounts Work" also get anchors in every
edition. They had none while that chapter existed only in English, so the
contents list could offer only the chapter itself; now each section is
listed and linkable like the rest of the guide.

The guide's anchor-parity check now requires every chapter to carry one.
Before, a chapter heading had no identity beyond its translated title, so an
edition that dropped one chapter and gained a different one passed both the
anchor comparison and the chapter count. With every chapter anchored, the
anchor comparison catches that directly, and the count is a backstop.

Closes #1597.

_Committed 2026-10-28 11:25 UTC (dc520e352)._
<!-- assembled-fragment: 1597-guide-chapter-anchors.md sha256=455a8577b6baaa57db9200451e031ab10553910a73a7011b42a9d9ad0d07dcfa -->

## Thread — One consent rule for every signing review (PR #3041)

Every review in the connected app that asks the user to tick "I understand and agree to the Risk Disclosures and Vaipakam Terms" now follows one rule, held in one shared hook. Before, the offer review, the desk order ticket, the signed-order fill, the rental listing and accept, the refinance, the offset and the loan-sale listing each guarded the tick their own way: some cleared it from an effect a render late, some stamped a counter and refused at submit while the box stayed ticked, and the rental accept kept a temporary lint suppression waiting on this decision. The owner chose to untick, keyed on the data (Closes #1696).

The tick is now tied to the values the review shows rather than their printed text, it clears in the same update that shows a change, and a review that changes and changes back does not get the consent back. When a change the user did not make clears their tick, a line beneath the box says so, in every supported language (the desk ticket and the offset card keep their own wording). A Full-tariff quote refresh that only marks Full as unable to complete for now no longer clears consent, since nothing that would be signed changed and signing stays refused while it holds. The offer form now holds its terms apart from the consent, and every payload it builds states the consent it carries, so a terms edit can never carry an old tick along with it.

> Caveat: no end-to-end spec stages a change landing on a ticked review for each surface, so the explanatory line is covered by the hook's own tests and not per page.

_Committed 2026-10-28 11:41 UTC (cb0e1999a)._
<!-- assembled-fragment: 1696-one-consent-rule.md sha256=6f1558bc2cc18b60fa104f024dd69ef7953b6f54cfd47441c6bb29953ec29145 -->

## Thread — one chain env-prefix map, and four runbook fixes (PR #2989)

The configure scripts now read every per-chain setting under one
chain-to-prefix map, the one the deploy library already used for its
artifact fallback and that matches the deploy wrappers' chain slugs.
Before this, the oracle configure script, the VPFI discount-price script
and the swap-router deploy script each kept their own map, and they did
not agree. The oracle script had no entry for Arbitrum, Optimism or
Polygon mainnet, so the configure step of a mainnet deploy on those
chains would have stopped with "unsupported chainId". The discount-price
script had no BNB testnet entry. On Ethereum mainnet the oracle and
discount-price scripts read `MAINNET_` keys while the wrappers and the
swap-router script used `ETHEREUM_`. Every script now reads `ETHEREUM_`
on chain 1, and Polygon zkEVM is no longer mapped: it is out of scope,
and the mainnet wrapper already refuses it.

The pre-mainnet runbook's chain scope now matches the specification:
Ethereum, Base, Polygon (PoS), Arbitrum and Optimism, with BNB Chain
testnet-only and zk-rollups out of scope. Its note that the discount
step could not be completed on a Phase-1 chain is replaced. The CCIP
cutover runbook now lists the four receiver and sender contracts the
cross-chain deploy actually creates, and it names both Diamond
repatriation calls, the registry and the endpoints, with how to verify
each. It used to name only the registry, so a mainnet Safe batch built
from it would have left repatriation dark. The deployment runbook drops
a stale "do not follow" banner over a section that had already been
rewritten for the current Workers, and the last live references to the
retired watcher Worker now name the current Workers. The docs index
states that older design docs and release notes keep paths from before
the source-tree split and are not rewritten.

Closes #1455, #1462, #1668 and #1721.

> Caveat: an operator `.env` that set Ethereum mainnet oracle keys with the `MAINNET_` prefix must rename them to `ETHEREUM_`. No mainnet is deployed, so no live configuration is affected.

_Committed 2026-10-28 04:15 UTC (3e6b3a0c8)._
<!-- assembled-fragment: 1721-one-env-prefix-and-runbook-fixes.md sha256=22f01bf5a2800809e33f54e39ef5f4bb14a81b132783254e1ecebcccd2a955c8 -->

## Thread — A read-only RPC proxy keeps provider keys out of the app bundle (PR #3019)

The connected app reads chain state from the visitor's browser, and a build that wanted a keyed provider endpoint used to put its URL in a `VITE_*` variable. Vite compiles the whole build environment into the bundle, so that key was public to anyone who opened the page, whether or not the app ever used it. A new Worker, the read-only RPC proxy, holds each chain's provider URL as a secret instead. A build that names the proxy's origin ships that origin and no key.

The proxy forwards reads only: contract calls, gas estimates, block, transaction, receipt, balance, code, storage, nonce and fee reads, and event-log queries that name their contracts and cover at most 2,000 blocks. It never forwards a transaction, a signature or a subscription. It serves only the app's origins, takes a per-caller rate-limit slot for every request, answers a disallowed call with its own error while the rest of the batch goes through, and never puts the key in a response or a log, including inside an upstream's error message. Its keys are dedicated to it, so browser traffic cannot spend the quota the keeper needs to act on a loan in time. The first request per chain also confirms that the upstream answers for that chain, so a mis-pointed secret is refused rather than served.

In the app, a build with `VITE_RPC_PROXY_ORIGIN` set reads each chain through the proxy and falls back to the chain's public endpoint when the proxy is down, over budget or refuses a call. Its batches stay within the proxy's cap. It opens no WebSocket, because the proxy forwards none, so new blocks are found by polling. The build now refuses two configurations: a per-chain RPC or WebSocket URL left set beside the proxy (it would ship unused, key and all), and a build serving a mainnet chain without the proxy. A build that sets neither the proxy nor a mainnet chain behaves exactly as before. Whether a chain carries real value is now stated once, beside its RPC configuration, and the chain list reads it from there.

The proxy is off by default. Nothing deploys it on merge and no build points at it yet. It runs on Workers Paid at mainnet (owner decision on #1724), and that is now a line in the mainnet readiness checklist. Until then, a keyed testnet endpoint should be restricted to the app's origins in the provider's dashboard. The proxy's README covers turning it on and what it does and does not protect: the Origin check stops other sites' pages, not scripts, and the rate limit is counted per Cloudflare location.

Closes #1724.

> Caveat: a proxied build has no WebSocket, so on-page updates after a transaction arrive on the next block poll rather than at once.
> Caveat: the proxy is not deployed; a live drive against it is owed when it first is.

_Committed 2026-10-28 08:57 UTC (d46e4d023)._
<!-- assembled-fragment: 1724-read-only-rpc-proxy.md sha256=107e81db071962168a198f3ca31b373c1638ac9b8c70fc406d41b410efdc52a4 -->

## Thread — The lender exit chooser asks the contract (PR #3024)

The lender's "your options" card in the app now takes its answer from the
contract's own sale verdict (PR #3008) instead of working it out. Each sale row
asks the contract whether this wallet may start that sale on this loan, and if
not, states the reason the contract gives. Before this the card rebuilt that
answer from the loan's status, its due date, any standing listing, the final-hour
listing window and the collateral type, each a copy of a rule the contract owns.
Those copies had drifted, and two refusals (a VPFI balance still held on the
position, a borrower's pending offset) were never shown at all. Both are now
reported.

Three states that are not an answer stay distinct and close both sale rows: the
check is still running, the check failed, or this network's contracts are older
than the verdict and cannot say. A reason the app has no wording for is still
shown as a refusal, by name, never as an open exit. Where the contract names the
earliest moment a refusal can lift, the row gives it as the earliest by time
alone, not a promise, and says a step someone chooses to take, such as
cancelling a listing, can lift it sooner. When the loan is past its due date the row says so ahead of any
narrower reason, as the spec asks, because nothing else can reopen a sale then.

What the card still decides for itself is only what the contract does not know:
the wait row, whether this deployment publishes the listing tool or has it
switched off, and whether the tools on this page have finished loading and can
be shown. A row stays closed while any condition the tools themselves render
behind still holds: another status read still showing the loan in its fallback
state, the listing read still showing a cancelled listing, or the loan reaching
its end by chain time. The rows and the tools read one shared answer for this,
so they cannot disagree about whether the tools are on the page. The
canonical spec now states that availability is the protocol's answer, not the
app's.

Completes #1841, whose contract half was PR #3008. The verdict facet
reaches the testnets only with the all-waves fresh deploy, so until then those
networks show the "contracts can't yet say" line, and the live drive is owed
after that deploy.

> Caveat: the verdict is re-read every 30 seconds, so right at the due date the Advanced rows can say the sale details are still loading for up to one poll before the verdict's refusal arrives. They never offer a sale the tools have already withdrawn, and the tools' own checks still refuse.
> Caveat: a clear verdict does not cover the buy offer a direct sale would spend, the listing's own inputs, or a keeper's capacity charge; the tools check those.

_Committed 2026-10-28 11:30 UTC (526c9185b)._
<!-- assembled-fragment: 1841-app-lender-exit-verdict.md sha256=d859c8098853a2e287a00253074fab1de5ac66452c271b37b6ce80ffcd30d0d4 -->

## Thread — One answer to "can this lender sell now?" (PR #3008)

A lender can leave a loan early in two ways: sell straight into a standing buy
offer, or list the position for sale. Until now the app had to guess, route by
route, whether the contract would accept either one, by reading a dozen pieces
of state and re-implementing each entry's checks. Those guesses could drift
from what the contract actually does, so the app could offer an exit that
failed on submission or hide one that would have worked.

The contract now answers the question itself. A new read, keyed by loan and by
the wallet that would act, returns for each route every reason it is refused
right now and, for each reason, the earliest moment it can lift by time alone
or by a step anyone may take (for example an expired listing or offset being
cleared away), or no time when a decision is needed. Each reason is the exact
error the route raises, so the app decodes it with the contract's own error
list rather than a second table. Both sale entries now run their opening checks
through this same rule and raise the first reason it reports, so the answer and
the entries cannot disagree: the global and per-asset pauses, sanctions
screening, who may act, an active ERC-20 loan, a live listing or borrower
offset, the loan's term, the final-hour listing window, the relist cooldown,
consolidation, the offer-duration cap, outdated vaults, and sale admission.

The answer states what it does not cover: anything about the buy offer a direct
sale would consume, the listing's own inputs, and a keeper's service capacity.
Overdue periodic interest does not close either route. Three refusals now read
more precisely than before: listing a loan past its due date reports that the
loan is past maturity, listing from an outdated vault reports that the vault
needs an upgrade, and selling a loan that has no live lender position reports
that the loan is not active. The new host must be refreshed together with both
sale facets. Closes #1841.

> Caveat: a relist cooldown runs from when an expired listing is cleared away, so the listing route's reopening time assumes it is cleared at the earliest moment anyone may do so; if nobody clears it then, the route reopens later.

_Committed 2026-10-28 07:40 UTC (cd691cce2)._
<!-- assembled-fragment: 1841-sale-exit-verdict.md sha256=24e84effda44904a9cee08b94f2ad1126510336d32569a90d368eb9493b13517 -->

## Thread — The lender's exit chooser reads the sale tool's offer list (PR #3046)

A lender holding an open position sees an exit chooser that names each way out, and in Advanced mode a sale tool below it that lists the standing lending offers the position can be sold into right away. The tool already worked out which offers qualify, but the chooser was never told: it kept its "sell now" option open and offered a jump to the tool even when the tool had just found nothing. The lender scrolled down to read that there was no match.

The page now works out the list once and gives the same list to both. With no matching offer, the chooser says so on the "sell now" option and offers no jump. It suggests listing the position instead only while the listing option is itself open; when the contract or this app refuses a listing too, it says only to check back later. While the search is still running the chooser waits, as it already did for its other readings. When the search could not be completed, the chooser makes no claim and leaves it to the tool, which says it could not load offers. An unreadable loan figure the payout depends on is treated the same way, never as an empty market.

The rules that decide whether an offer can buy the position now live in one place. The chooser carries no copy of them, so the two surfaces cannot drift apart.

Basic mode is unchanged on purpose. Finding the list means walking every open offer, which is not worth doing for every lender who opens a position page, so the Basic chooser still makes no claim either way and runs no offer search.

One small fix came with it: an offer search that failed outright used to leave the sale tool saying it was still looking. It now says the offers could not be loaded.

Closes #1849.

_Committed 2026-10-28 12:28 UTC (1e2a9c621)._
<!-- assembled-fragment: 1849-lender-chooser-sale-candidates.md sha256=885eebff80e9ab996aa59c8377c050188833b5b8d9595e055a5290e37524bdf0 -->

## Thread — Foundry pinned on every CI job, and three recorded owner decisions (PR #2998)

The release gate and the three end-to-end workflows installed whatever
Foundry release was current upstream, so the compiler that gates a
mainnet release could change without any commit in this repository. They
are now pinned to Foundry v1.8.6, the version that ran the last green
sharded full regression and every recent end-to-end run. No CI job floats
any more: the fast contracts lane and the static-analysis job stay on
v1.8.3 for the compile-reuse reason already recorded, the docs jobs stay
on v1.7.1, and a toolchain bump is now a reviewed commit that moves the
release gate and the end-to-end workflows together.

Release-note fragments now have a stated length that matches practice:
at most about six short paragraphs, with longer reasoning in a linked
design doc, and "Closes" written only when a pull request closes an issue.
The template, the procedures handbook and the agent guide say the same
thing.

The spec audit's NFT-rental daily-fee row is recorded as satisfied: the
app that mis-scaled the fee was deleted, and the remaining app scales it by
the token's decimals. The procedures handbook gains the two sweep habits
for retiring a claim across every document that states it.

Closes #1984, #1799, #2533 and #2189.

> Caveat: the pinned Foundry versions do not update themselves; a newer release reaches CI only through a pull request that changes the pins.

_Committed 2026-10-28 05:43 UTC (50ec3ec01)._
<!-- assembled-fragment: 1984-pinned-foundry-and-decision-records.md sha256=0567eece08b0180da2df6b3098b3a6e44c6d75d12d3043582c4e9ed05fb86706 -->

## Thread — the user guide describes the Analytics page that actually ships (PR #3045)

The user guide's Public Analytics chapter, in both the Basic and the Advanced guide and in all ten languages, described the retired dashboard: a cross-chain total, a per-chain table, total value locked and loan volumes, an export, and a claim that no database sat behind any number. None of that is true of the page the site links to. The chapter now describes the real page: one network at a time, no wallet needed, two public sources named wherever they are used (the public indexer for loan, offer, recycling and loop-closure figures, and the platform contract itself for the VPFI token and fee figures), and the rules the page follows, such as stating the block and age of every reading and never showing an unread figure as zero.

The two retired sections (all-chains total and per-chain breakdown) are gone, and three new ones cover loans and offers, the recycling account and loop closure, and fees and treasury. The anchors are the same in every edition. This follows the owner's decision to rewrite the guide and build the missing contract figures on the page (#2437). Closes #2072.

> Caveat: the guide's VPFI token and fees sections describe the page as #2437 (merged as PR #3038) builds it; they match the live app from its next deploy.

_Committed 2026-10-28 11:48 UTC (73a4f7c36)._
<!-- assembled-fragment: 2072-guide-analytics-chapter.md sha256=ec017784378960b4e59f584f764fc87a05bab653d3827f0941cb1a0c7ece15aa -->

## Thread — every retired app link has a destination (PR #3004)

The connected app now answers every address the retired app served, not only the ones reviewers happened to name. The retired router was enumerated and each path is routed, aliased or mapped. An old offer page reads the offer and opens the flow that takes it. Because the old address never said which network the offer was on, a miss names the network it looked on and the other reasons it can miss. The old loan action pages land on that loan, scrolled to the card that lists the same action: the lender's exit chooser, or the borrower's early-repay chooser for both the old preclose and the old refinance page. The refinance form itself shows only in Advanced mode and only while the loan can take a request, so landing on it would have left a Basic-mode borrower nowhere; the chooser shows in both modes, says whether refinancing is open now, and offers the switch to Advanced. The scroll waits for the card, which appears only after the loan's data arrives.

The old allowances, alerts and keepers pages land on their card in Settings. A link that names a card shows it even in Basic mode, because the approvals card holds the one-click way to withdraw a spending permission and a bookmark to it must reach the button. The old create page goes to the form its side names, back to the loan for a refinance or offset link, or to Home. The old automatic-lending page says the feature is not in this app yet and that intents set up there cannot be viewed here, instead of showing page-not-found. The removed VPFI purchase page stays not-found on purpose.

The settings addresses are exempt from the Terms gate like Settings itself; the addresses leading to new exposure stay held. The five new single-segment addresses are excluded from search indexing in the response headers, like every other alias. The deployment runbook's caveat about unmapped paths is now resolved for this host. Closes #2076.

> Caveat: an old offer address is resolved only on the network the app is reading; a visitor whose offer was on another network must switch networks and open it from the Offer Book.

_Committed 2026-10-28 07:44 UTC (4d03fcc70)._
<!-- assembled-fragment: 2076-retired-app-links.md sha256=211cb1b2630df5c7f954315b74607cf42d9319d6e7b4cb52b086cc135e0b285f -->

## Thread — Forced close-out says when internal matching is switched off (PR #2996)

The lender's forced close-out card warns, on every state a match could
overtake, that the protocol looks for an opposing position at the moment the
transaction runs and may settle the loan that way instead. On a deployment
with internal matching switched off, that cannot happen: the protocol never
looks. The card used to say it anyway, because the only read it had was "is
there a candidate", which answers no in both cases.

The card now reads the deployment's internal-matching setting in the same
block as every other fact behind it. When the setting is off, the warning is
replaced by a plain statement that internal matching is switched off on this
deployment, so the outcome described is the one that happens unless that
setting changes before the transaction runs, and the matcher-incentive line
(paid only by a match) is withheld. When the setting is on, or cannot be read
(for example on a Diamond built before the setting had a read), the card is
unchanged. The routing decision itself does not change: the candidate read
already accounted for the setting. Closes #2082.

> Caveat: a Diamond without the setting's read keeps the "a match may appear" warning, which is true whichever way the setting stands.

_Committed 2026-10-28 05:50 UTC (02a5dbb67)._
<!-- assembled-fragment: 2082-forced-close-matching-switched-off.md sha256=ad3b609aa14939b3b8cbc296699163214507ed72dd35ac19d6153a20d20f7083 -->

## Thread — Time-based default: lender KYC check, its value and a view (PR #3059)

The time-based default keeps its check of the lender's KYC tier. KYC is off on the retail deploy, so the check never blocks a retail default, but the code keeps it for a fork that turns KYC on. That is the owner's decision. The spec now states it: the default checks the loan's lender, never the caller who triggers it.

The check now values the loan the way the KYC thresholds say to: the liquid principal plus the liquid collateral as it stands at the default, through the same helper every other KYC comparison uses. Before, it counted the principal alone, so with enforcement on, a lender whose tier covered only the principal could pass. An NFT rental is valued at its rent, the daily rate times the duration, as before.

A new view, `defaultKycAdmission`, tells an app before anyone signs whether a default would pass this check. It gives the same answer as the default, and the same revert data when it would refuse. The app thread asked for it so the connected app can name this reason instead of a generic failure.

Part of #2083. The accept path values an NFT rental at zero for KYC, because a rental has no collateral; that is tracked separately in #3044.

> Caveat: nothing changes on any current deployment, since KYC enforcement is off everywhere.

_Committed 2026-10-28 14:19 UTC (88891b886)._
<!-- assembled-fragment: 2083-default-kyc-admission.md sha256=f6c9acac70163502cdc5a1b3ffe9368479bc2bd9e5bd7ae8161364c6a65dbf97 -->

## Thread — Forced close-out reconciles a replaced transaction after a reload (PR #3040)

The forced close-out card watches a submitted close-out with a wait that
notices when the wallet speeds it up or cancels it. Closing the page lost
that wait. On return the card had only the transaction's hash, and once the
original left the mempool it could never say what had happened, so the
lender had to tell the card their wallet no longer showed it.

The card's device record now also keeps the sending account and the nonce,
read back from the chain once the node has the transaction. After a reload,
when the hash has no receipt and the account has since mined past that
nonce, the card knows something else from the wallet took the close-out's
place. It cannot tell a Speed Up of the same close-out (which may have gone
through) from a cancel or another transaction (which moved nothing), so it
says that, waits until the position has been re-read, and then shows the
loan as it stands. The issue proposed calling this case "replaced", which
would have told a lender whose sped-up close-out succeeded that nothing
happened; the new "superseded" outcome avoids that.

This check runs alongside the wait rather than after it, because a wait on
a hash the node no longer knows does not give up: it keeps watching. While
the node still has the transaction, the wait's own answer (cancelled, or the
sped-up copy's outcome) is used instead, since it is the more exact one. A
second tab open on the same loan picks up the sending account and nonce
from the shared record, so it can make the same check even when its own
node no longer has the transaction.

A record written before this change still works, without the nonce check.
The check, and the restart of a wait that failed, back off from one second
to thirty, instead of asking every second for as long as the page is open.

Closes #2086.

> Caveat: a reload cannot reconcile a transaction whose nonce was never read
> (the page closed within seconds of sending, before the node had it); that
> case keeps the earlier behaviour, where the lender answers for their wallet.

_Committed 2026-10-28 11:49 UTC (77fe013af)._
<!-- assembled-fragment: 2086-forced-close-reload-reconcile.md sha256=8254d421b4ed6b937350a6eefc8ea59acf66eeac008c915982abdbe47dacd305 -->

## Thread — The coverage matrix becomes a matrix again (PR #3054)

The connected app's verification coverage matrix had grown long-form narrative inside its table cells, one of them past 60,000 characters, which no renderer can show as a table. Each row now carries a sentence or two per cell, at most 600 characters, and the full record behind a row (how each rule was arrived at, what a driver refuses to claim, and the review history) moved verbatim into a new notes file, linked from the cell. The app's typecheck now refuses a cell over the cap, a link to a notes section that does not exist, and a notes section nothing links to, a row with more cells than its table has columns, and a row cut off from its table. The cells are read the way the renderer reads them, outer pipes optional. Several rows had never rendered as written: pipes inside code split three of them, one carried a fifth column, one dropped its trailing pipe, and a paragraph in the middle of the table turned every row after it into plain text. Their full text is now in the notes and the table is whole again, so the per-PR habit of appending to the matrix cannot regrow it (Closes #2143).

> Caveat: a cell that had to be cut mid-sentence ends in an ellipsis; its full text is in the linked notes section, unchanged.

_Committed 2026-10-28 15:00 UTC (a80912ede)._
<!-- assembled-fragment: 2143-coverage-matrix-notes.md sha256=8c11842c76632c15a35691bd8de0197f5be64b7567e30db09e78ae23f8788302 -->

## Thread — A Worker left behind main now opens an issue (PR #3007)

Merged code that never reached its Worker used to be silent. The connected app once served a build from before a merged fix for days, and nothing said so: the live review that follows a deploy never happened, because the deploy never happened. Closes #2242.

Every deploy the repository runs now records the commit it was built from on the Worker version it uploads. That covers the app, the marketing site, the indexer, agent and keeper (through their shared deploy script), and the two operator Workers. Cloudflare already recorded when a version was uploaded, but not what it was built from. A deploy from a working copy with uncommitted changes is marked as such. If no commit can be named, the deploy still goes ahead and says it recorded nothing.

An hourly check compares each Worker's live deployment with main. It finds the Workers from the tracked Worker configs, so a new Worker is watched with no edit. A Worker's code is its own directory plus the shared packages its build reaches. Changes to tests, end-to-end drivers and Markdown are not counted, and neither is a shared package's build tooling. Once a merged change to a Worker's code has waited six hours undeployed, the check opens one "Workers behind main" issue naming each Worker, the changes it is missing and the oldest of them. It comments again only when the set of Workers changes, and closes the issue once nothing is overdue. A Worker whose deployments cannot be read is reported as unknown, never as current.

A deployment from before this change carries no record, so the check places it by the time its version was uploaded and marks the result as inferred. A Worker whose lag is a decision can be listed with its reason in a reviewed commit. It is then still reported, with that reason, but no longer opens the issue. The one listed today is the recycling-mesh watcher, which is complete but deliberately undeployed because it has no free Cloudflare cron slot.

The issue-and-chat alert the indexer health probe built is now one shared workflow, and both checks use it. The probe's behaviour, titles and wording are unchanged.

> Caveat: a change that alters a bundle through a path no package declares (a build reading a file outside the Worker's directory and its shared packages) is not seen. The check under-reports rather than false-alarms there.
> Caveat: Workers Builds runs whatever deploy command its dashboard holds. A Worker whose dashboard command bypasses the package deploy script deploys without the record, and the check marks it inferred.

_Committed 2026-10-28 07:17 UTC (54b50f295)._
<!-- assembled-fragment: 2242-deploy-lag-check.md sha256=ddaefab98e3352f85b33772f20a862c13a9aa6bd1f393384e4cf34216c2c779e -->

## Thread — One writer for the deployment artifact's facet addresses (PR #3016)

Each chain's deployment artifact keeps the address of every Diamond facet
under one section, and the deploy and refresh scripts are meant to record a
facet there only through the dedicated facet writer. Until now the general
purpose writers could reach the same section too, so a script could record a
facet name that matches no facet, use a key the facet writer would never
produce, or overwrite a correctly recorded facet address later in the run.
Nothing checked for any of those.

The general purpose writers now accept a key only in the one plain spelling
the scripts use (dot-separated names of letters, digits and underscores), so a
bracketed or otherwise re-spelled path cannot name the facet section by another
route. They refuse any key inside the facet section and name the facet writer
in the refusal. The facet writer refuses a facet name that is empty or carries
anything but letters, digits and underscores. Every existing
script was checked: none wrote the facet section through a general writer,
so no deploy or refresh changes what it records. A new test writes into a
scratch artifact on both sides of the boundary. Closes #2263.

_Committed 2026-10-28 08:41 UTC (68afbf849)._
<!-- assembled-fragment: 2263-facets-namespace-one-writer.md sha256=55625c56e3fed5f453ac4c0a9c4dfcb959d84f5856cfdf6957a8dd2c141ea824 -->

## Thread — the indexer checks every loan-status change, and the reference subgraph is retired (PR #3003)

The platform lets a loan's status move only along a fixed diagram, and the contracts refuse every other move. An independent check from outside the contracts used to live in a reference subgraph that counted any move outside the diagram. Four of the five events it listened to no longer matched the contracts, its diagram was out of date, and nothing ever paged on its counter. The indexer now does that check itself, from the one event every status change announces.

As it scans, the indexer compares each announced move with the diagram, which the functional spec now states in full. It records three kinds of disagreement: a move the diagram does not allow, a move that does not start from the status last announced for that loan, and a second initiation of a loan it is already tracking. It keeps its own two tables (a new additive migration) and never corrects the loan records it serves, because correcting them is what would hide the drift. A replayed scan neither re-applies nor re-records anything. A loan whose initiation predates the indexer's records has its first move checked against the diagram only. The health route reports this, and how many loans were seen from initiation, alongside the violation counts.

The scheduled indexer health probe now pages on any recorded violation, on any chain, through the same alert issue and ops-chat post it uses for a stalled ingest, renamed "Indexer not healthy" to cover both. A violation stays recorded. Once an operator has investigated it, they acknowledge it by listing it in the probe workflow in a reviewed commit. The probe also fails if the health route stops reporting the check.

The reference subgraph, its export script and the deploy-script steps that ran it are removed. The security policy and the website's integrator FAQ now describe the indexer's check, and the deployment and restore runbooks are updated. The FAQ now leads with the status-change event and corrects three event descriptions that were wrong: full versus partial repayment, an event the contracts never emit, and what the fallback does with the collateral.

Closes #2337. Refs #2968 (item 7; that issue's other monitors stay open).

> Caveat: on the live testnets, loans initiated before this indexer ships are checked against the diagram only for their first move after it ships; after the all-waves fresh deploy every loan is checked from initiation.

_Committed 2026-10-28 06:15 UTC (35177bf21)._
<!-- assembled-fragment: 2337-indexer-loan-status-check.md sha256=d5a1743298edf4105963e95ace724e1df51425f0fce60ec8bca8db4056f4d6b7 -->

## Thread — stable ABI stamp, build-generated Tenderly ABIs, tested D1 shape rule, Discussions forms (PR #2995)

The frontend ABI export no longer writes the contracts commit and the
export time into the package's provenance file. Those two lines changed on
every export, so every open branch that touched an ABI conflicted with
every other one there, while the facet JSONs themselves merged cleanly.
The file now lists only the exported facets, which changes only when the
facet set does. The pre-deploy gate already compares every committed ABI
with the compiled one, so a stale export is still refused; it just no
longer carries a timestamp that says when it was made. The keeper-bot
export keeps its commit stamp, because a bot release is correlated with a
contracts state through it.

The hand-captured Tenderly paste copies of the Diamond and timelock ABIs
are removed. The timelock's ABI is now exported from the build with the
other standalone contracts, and the Tenderly alert preset check reads
each preset against the ABI of the contract it watches: Diamond presets
against the combined Diamond ABI, timelock presets against the timelock's
own. Before, timelock presets were not checked at all, and the pasted
copies could drift from the contracts without anything noticing. The
Tenderly README says which generated file to paste.

The indexer's D1 binding check keeps its shape rule (all consumers on one
database, or the cutover barrier with every writer unbound, and nothing
in between) in a small module that unit tests now cover, including the
half-applied barrier that should never occur in production and so was
never exercised. The Base Sepolia internal-match script's second loan now
defaults its price to the one where both mirrored legs have equal LTV, so
the two sides are symmetric unless an operator overrides it, in which case
the script logs the override. Its restore stage no longer looks up the
mUSDC token it does not use.

Discussions now has form templates for Q&A and Ideas, the new-issue page
links to Discussions for questions, and the contributing guide points
questions there instead of at a question-labelled Issue.

Closes #2343, #2650, #2272, #2458 and #131. It also settles item 6 of
#2968: the timelock alert preset is now checked.

> Caveat: the ABI package's provenance file no longer names the contracts commit an export came from; the pre-deploy gate's comparison with the build is what proves the ABIs current.

_Committed 2026-10-28 05:00 UTC (278758c58)._
<!-- assembled-fragment: 2343-abi-stamp-tenderly-abis-d1-shape-tests.md sha256=563c715e9b03bfefa157555c6688ea3ed926e4a6af0ffac771fb7c2e99bd89b3 -->

## Thread — Testnet faucet NFTs can only be burned by their owner (PR #3016)

The two faucet NFT collections deployed on the testnets for rental demos
(vRENT and vART) let any wallet burn any token, including one another user
held or one escrowed for a demo loan. Burning now needs the token's owner or
an operator it approved, the same rule a transfer follows. This is testnet
tooling only: these contracts are never deployed on a mainnet. The change
reaches the testnets on their next mock deploy. Closes #2359.

_Committed 2026-10-28 08:41 UTC (68afbf849)._
<!-- assembled-fragment: 2359-faucet-nft-burn-gated.md sha256=83e4c9ce450b82d6d5c3de2bc543226be5d830778f86e4bca61b7b70aef5f7bb -->

## Thread — Additive D1 migrations enforced; guide anchors, Worker inventories and the redeploy purge note corrected (PR #2988)

A shared D1 migration lands while the previous Workers are still serving, so it has to be additive. That rule was written down but not enforced. A new check in the indexer's typecheck now reads every migration in the shared and keeper-private directories, through a lexer rather than as raw text. It refuses dropping a table or column, renaming either, or adding a not-null column without a default. The exception is a migration listed as the second step of a two-step release, with its issue and the reason the deployed code no longer needs what it removes. The four existing removals are listed that way (Closes #2412).

The Japanese user guide had a section anchor with no heading after it, so a link to "initiate the sale" landed at the top of the page. The heading is restored. The guide check now uses the page's own anchor-placement logic and fails on any anchor that does not land on a heading, so a missing heading can no longer go unnoticed (Closes #382).

Three Worker component docs had drifted from their code (Closes #1725). The agent README now says which credentials are account-level Secrets Store bindings and which are per-Worker secrets; the two need different commands, and using the wrong one leaves the binding empty. It also lists the OpenSea and diagnostics-hash credentials it had omitted, and its D1 writes as the code performs them; it never writes the alert-state table. The keeper README lists the keeper's real shared-database writes. The indexer and agent entry headers now name every scheduled pass, including the OpenSea listing retry and the support-ticket retention prune. The indexer's open-CORS claim is limited to its public read routes.

The deployment runbook said the redeploy purge scripts had no replacement and told operators to delete rows by hand. The indexer's deployment epochs have replaced them: a new Diamond resets that chain's rows automatically. The runbook now says so and warns against a manual delete (Closes #1491).

_Committed 2026-10-28 04:19 UTC (fa6e26f5c)._
<!-- assembled-fragment: 2412-small-ops-and-guide-fixes.md sha256=8db99a3f799921a87f36ce9199d2d08a1021ae02bf4faf99ef8c7184b3f06a40 -->

## Thread — Analytics shows the VPFI token and fee figures again (PR #3038)

The public analytics page has a new section, "Read from the contract", which brings back the two parts of the old dashboard that were lost when the previous app was removed: the VPFI token's figures and the protocol's fee figures. Unlike the rest of the page, these do not come from the indexer. They are read straight from the protocol contract's own public view functions, all at one block, and the section names those functions, states the block and says how old the reading is, so a visitor can check every figure against the chain themselves.

On the chain where VPFI is issued the section shows the token address, the supply, the supply cap, how much can still be minted under it, and the address allowed to mint. On a chain VPFI reaches by bridge it shows that chain's supply only and says the cap and minter belong to the issuing chain, instead of showing zeros. The fee figures (since recording began, last 24 hours, last 7 days) are shown in the reference currency, with every reason they can understate the truth stated beside them. The treasury address is named and linked; a held balance is shown only when the contract itself is the treasury, with what that figure leaves out. A figure that could not be read says so and is never shown as zero.

The shared multicall reader can now pin a read to a given block, which is what lets the section state the block its figures describe. The page header and the transparency note now say which figures come from the indexer and which from the contract. Closes #2437.

_Committed 2026-10-28 11:28 UTC (95835d044)._
<!-- assembled-fragment: 2437-analytics-contract-figures.md sha256=d3466dcbbb8718df69acc8afcd5b95f76796e211c0e0ce855a90cccc0805208d -->

## Thread — Interest schedules on the offer form and the loan page (PR #3030)

A loan on a periodic interest schedule now shows its current period on the loan page, in both modes and to anyone viewing it: the schedule, the period's deadline and grace end, the interest the period expects, what has been paid toward it and what is still owed. Until now the page said nothing about periods at all, so a borrower could reach a collateral sale without the app ever having named the deadline.

Every figure and date is the contract's own settlement preview, read in one call together with the block and its time, so the page judges "still in grace" against chain time rather than the device clock and states the block it read. The expected interest is described as worked out at the loan's current amount and rate, because it falls when part of the loan is repaid during the period.

Once a period's grace is over the page says what can happen and offers an action only where it can finish one. A fully paid period can be recorded from the page; that moves no funds, starts the next period and is re-checked at the moment of signing. A period with something still owed is settled by selling collateral through a swap route quoted when the sale runs, which this page does not build, so it says anyone, a keeper service included, may settle it, and tells the borrower that paying what is owed first closes the period without a sale. Where the deployment has periodic settlement switched off, or the protocol is paused, the page says so instead of offering anything, and a setting it could not read is stated as unread. It says so in every phase of the period, not only once the grace is over: while settlement is switched off the page does not warn the borrower of a collateral sale that cannot happen. The card refreshes with every new block, when a hidden tab returns, after the user's own repayment in any tab, and on the first interaction after an idle stretch, like the page's other action gates. Every read that slows its polling while the live rails are healthy is now declared in one list that each rail is built from; that also puts the offset-offer card's read, which had been missed, on those rails.

The offer form now lets a poster choose when interest is paid: once at repayment, or monthly, quarterly, every six months or yearly. Until now every offer the app created was paid once at repayment, with no way to choose. Which schedules are open comes from the protocol's own admission rule for the terms being entered (the view added in #3009), so the form offers only what offer creation will accept and, for each closed schedule, says why: periodic payment switched off on the network, an asset the protocol cannot price, a loan over a year that must pay at least yearly, a smallest loan worth less than finer schedules need (both figures stated), or a period not shorter than the loan. When the whole offer can only be paid at repayment the form says so in one line. While the answer is being read, if the read fails, or on a network whose contracts predate the view, the form says which and only payment at repayment can be chosen. A schedule that later terms close is flagged and blocks continuing rather than being swapped silently. The review's consent text now names the schedule, the default included. The desk order ticket still posts offers paid at repayment; giving it the same choice needs the order book to show takers each offer's schedule first, which is #3028. Closes #2524.

> Caveat: the protocol's view reaches the testnets with the all-waves fresh deploy; until then the form says those networks' contracts can't say which schedules they allow, and offers are paid at repayment as before.
> Caveat: an offer of over a year posted while periodic payment is switched off is paid at repayment, and keeps that if the switch is later turned on before it is accepted; whether accepting should re-check the rule is #3025.

_Committed 2026-10-28 10:47 UTC (481833da1)._
<!-- assembled-fragment: 2524-interest-schedules.md sha256=2f8fa8e03ec689506dbf0b03779b0100693782d4c14f34b8569defeed6b23740 -->

## Thread — The NFT verifier tells a retired token from a never-minted one (PR #3029)

When a position NFT id does not exist, the verifier used to say only that it
was either retired or never minted, because the chain gave the same answer for
both. The contracts now publish the highest position-NFT id they have ever
allocated (PR #2994), and ids are never reused, so the verifier can tell the two
apart. An absent id at or below that number was retired by the protocol and is
shown as a warning; an id above it was never minted on this network, and the
page suggests switching to the network where the position was opened.

Both answers come from the same block, so a position opened a moment after the
check is never reported as retired. On a network whose contracts predate the
new view the page keeps the old two-way wording, and if the second read fails
it says it could not check which and that reloading retries; the absence itself
is never in doubt in either case.

The page still does not name why a token was retired, and it does not yet show
the loan a retired token belonged to; that history panel needs an indexer
lookup by token id and is tracked in #3021.

Closes #2529.

_Committed 2026-10-28 10:36 UTC (3c6d66372)._
<!-- assembled-fragment: 2529-nft-verifier-retired-vs-never-minted.md sha256=a7bbc23e69cfa6691957d005d8ce4f29716925d1f4b427b20b78213825a48af1 -->

## Thread — Liquidation price next to the health factor (PR #2996)

The loan page's advanced health detail now states the liquidation price: the
collateral price at which the health factor reaches 1.00, in the protocol's
reference currency per whole collateral token. It is derived from the
protocol's own two answers, the health factor and the collateral's price,
read together in one block, so the app keeps no second copy of the threshold
or the interest rules. The figure is rounded up, both when it is computed and
at the precision it is shown, so it never sits below the real line, and the row says what it assumes: the borrowed asset's price and the
amount owed held where they are, with accruing interest moving it up.

Every case without a figure says why instead of showing zero: a loan whose
assets the protocol does not price has no liquidation price, a loan whose
collateral price or token details could not be read shows "unknown", and a
loan whose debt is too small to reach the line says no price brings it there.

The loan risk reads (health factor and loan-to-value, on the loan page and in
the positions lists) now go through one multicall, so they share a block and
an on-chain refusal is told from a provider failure by the call's own status.
That multicall is read as a single request, which the app's other
failure-tolerant batched reads (the forced close-out readiness and the Offer
Book's pricing) now share: the stock multicall reported an unreachable
provider as every call failing, so a liquid loan could have been shown as one
the protocol does not price. A provider failure is now an error that says the
reads failed, and a lint rule keeps the stock form out of the app. A risk
read whose latest refresh failed no longer keeps showing its last health
factor or liquidation price: the loan page says the read failed and the lists
show the health as unknown, since interest and prices move the line between
reads.
The numeraire symbol decoder the protocol console used is now shared. Closes
#2531.

> Caveat: the figure assumes the borrowed asset's price holds; if both legs move, the real line moves with the ratio of the two.

_Committed 2026-10-28 05:50 UTC (02a5dbb67)._
<!-- assembled-fragment: 2531-liquidation-price.md sha256=919f0aceb2007c9172cdf275c4fc61281d22df2de995d929e3f397bd713bc741 -->

## Thread — One review footer and done card for the offer and rental flows (PR #3047)

The last step of the offer flow and of both rental flows (posting a listing, and renting an NFT) carried its own copy of the same pieces: the consent box, the error banner, the back and submit buttons with their "prompt 2 of 3" wording, and the done card with its transaction link. A fix to one copy had to be repeated in the other two, and could be missed. They are now one shared footer and one shared done card. The shared footer takes the review's consent from the one consent rule (#1696), so its box unticks itself when what the review shows changes and says why, in every flow that uses it. Each flow still decides what its review covers, what going back resets, and which actions the done card offers.

The step indicator at the top of these flows now finds the current step from the flow's own list of steps, rather than from a separate hand-written mapping kept beside the list.

Nothing a user sees changes.

Closes #2532.

_Committed 2026-10-28 12:16 UTC (d43d318d1)._
<!-- assembled-fragment: 2532-shared-flow-finish.md sha256=94c9eb5f1a32ca427f3afbb4dc5b8da22c9aac0a4f5456e8d461bf1b2de0e547 -->

## Thread — Protocol console shows the settings read as one part of a larger answer (PR #3017)

The protocol console now reports the protocol-wide settings it had been leaving out because the contracts answer them only as one part of a larger reply: the partial-liquidation sizing (the health-factor ceiling, the deep-underwater threshold and the dust floor), the liquidator discount for each liquidity tier of the collateral's market, the price-feed registry and the keys it is asked under, the wrapped-ether token, the pricing anchor and its two feeds, the notification fee, the PancakeSwap and SushiSwap venues, and the loan-default grace schedule. With these, every protocol-wide setting in the parameter reference is either shown or has no read in the contracts at all (the 0x proxy, the Uniswap V3 factory and the reference currency's own registry key), and the page now says that instead of "not yet".

The rule that keeps a value under its right name carries over. A reply is published only when the code that gave it, checked at the same block in the same request, is the code whose part names this build holds; otherwise every part of it is reported as not reported, never some of them. The fees-billed running total that rides along with the notification fee is not a setting and is never shown as one. The indexer's snapshot carries the new values and refreshes on the events that change them, and the page reads them straight from the contracts when the snapshot does not have them yet.

Some rows say what an empty value means: an unset dust floor turns dust handling off, an unset venue is off, an unset pricing anchor means prices are looked up in the reference currency directly, and an unset grace schedule shows the documented default schedule, marked as the default. The liquidator discount is labelled by liquidity tier so it cannot be read as a VPFI holding tier, and the pricing anchor's symbol says that no price path reads it today. The reference-currency rows moved into a section of their own beside the pricing anchor.

Closes #2680.

_Committed 2026-10-28 08:15 UTC (a7d90c80c)._
<!-- assembled-fragment: 2680-console-multi-part-settings.md sha256=06d02fcc55c182abb21902eeba3ba6e988b6830fd7102390609a19b7b38ce01f -->

## Thread — A wallet's risk-access choices appear on its Activity page (PR #3035)

The Activity page shows a wallet the events it took part in, by a shared participants rule. Four events record a wallet's own risk-access choices: its risk level, strict mode, and its consents and acknowledgements for asset pairings. None of them ever reached the wallet's page.

The rule treated the address these events carry as a vault contract, because the contract names it `vault`. It is not one. The risk-access contract keys this state by the account that made the choice: the account itself when it calls directly, or the account that signed when a relayer submits it. So the address is the wallet, and the rule now lists it as the wallet's own row. Each of the four gets a plain-language label in all ten languages.

The name `vault` still means a vault contract in other events, so it is no longer treated as "never a person" across the board. Each of those events is now classified on its own: the swap-to-repay lot pull keeps the borrower as its party and the vault contract out; the backstop vault being set up stays with the treasury records; and an admin exempting an account from the risk-access checks stays with the administrative records, off the account's page.

Closes #2707.

_Committed 2026-10-28 10:57 UTC (4b2a8d8d8)._
<!-- assembled-fragment: 2707-activity-risk-access-choices.md sha256=b785b706ce27ba338126ff331d50617ab4ce9b80b79463f018347e8600af7683 -->

## Reward remittance — parts sized by both lane ends, no dust parts, no forgotten days (PR #2986)

Since #918 a mirror's reward budget for a day can go in several parts. Three gaps in how the keeper sized and continued those parts are closed. First, a part is now sized by both ends of the cross-chain lane: what Base can send right now, and the most the mirror's side can ever receive in one transfer. A part above the mirror's inbound capacity could never be delivered and would sit in the lane until someone re-executed it by hand. Each chain now reports its inbound lane bucket publicly, and the keeper reads the mirror's on the mirror itself. The mirror's end is bounded by its capacity rather than its momentary balance, because that balance is drawn only when a part arrives, after any part still in flight.

Second, the keeper no longer sends dust. A part that would leave its day still owing waits, below a configurable minimum (1,000 VPFI by default, never more than the lane could ever carry), for the lane to refill. A part that completes its day is always sent. Each part costs a cross-chain fee, a reservation and a mirror transport epoch, so dust parts spent money to move almost nothing.

Third, a partly sent day is never forgotten. Base now keeps a public list of the days it has sent a mirror in part and still owes. A day joins the list when a part leaves it owing or a release reopens it, and leaves when it becomes whole or is abandoned with its chain. The keeper continues every listed day, oldest first, whatever its age. Before this, a day older than the keeper's scan window dropped out of it while the mirror held every later day behind it.

The two new views reach a chain only with the next fresh deploy. On a Diamond deployed before them the keeper says, every tick, which end or list it could not read, and sizes and scans as before. Closes #2960.

> Caveat: on a Diamond deployed before this change, a partly sent day older than the keeper's lookback is still continued only by widening the window or by hand, and the mirror's inbound capacity is not read.

_Committed 2026-10-28 03:43 UTC (d44374188)._
<!-- assembled-fragment: 2960-remit-part-sizing.md sha256=862bea1e3653059651596bddbfc612648f8ea5ebd44280fbf2b72ba2664ef1e7 -->

## Rewards — a mirror can skip a day whose delivery parts disagree (#2961)

A mirror can receive one reward day in several parts, and every part states the day's whole. If two parts state different wholes, the mirror refuses to open that day. Base locks the whole at the first part, so this happens only through a fault: a faulty or compromised Base, a replaced Base deployment, or a wire defect. Nothing could repair it, and because the reward cursor cannot pass an unopened day, it also held every later day's claims and sweeps on that chain for good.

Such a day can now be skipped (owner decision, option B). One day after the first disagreeing part, anyone may close it unpaid, and the keeper will do so if nobody else does. The skip uses neither disagreeing figure.
- The day's rewards end unpaid on that chain.
- The recycled commitment held for it is released.
- Every later day resumes.
- The figures given up are recorded.

The value that landed for the day is then moved, again by anyone, into that mirror's recycling pool. There it funds later days for the same chain's users. On a mirror whose reward custody is not yet activated, nothing needs to move: that value already counts toward the chain's later funding.

The skip refuses a day that opened before the conflict (it pays normally) and a day the broadcast has not stamped yet. It also refuses a day where a side the delivery gate does not hold carries recycled funding, because that side's claims may already have paid from it. That last case stays held and is an incident for the runbook.

Also in this change:
- A disposed delivery's part no longer counts toward its day on either route. The rule now lives in the one place parts are counted.
- A new test covers a day delivered in 65 parts, more than one claim scan window.

Fresh deploy only, like the rest of the current reward work.

> Caveat: a day skipped this way is lost to claims on that chain. Its rewards are not paid later, even if the fault is found.

Closes #2961.

_Committed 2026-10-28 12:26 UTC (1dcf7b02d)._
<!-- assembled-fragment: 2961-skip-conflicted-delivery-day.md sha256=66af53043673e4ae3ecb4aac6612eb100838eb2dbe0b5432c8038ea23a4dbf63 -->

## Thread — Removing a chain from Base's list releases its held pool room (PR #2983)

Taking a mirror off Base's expected-source list now ends Base's remittances to it for every day up to and including the day of the removal, and in the same write releases the pool room Base was holding for those days. Before this, a day sent in parts held the rest of its fresh in the 69M pool, and a day under the commitment regime held its commitments, for as long as the mirror might still be sent them. A mirror removed from the list would never be sent them, so that room stayed held for good. The owner chose to release it at the removal (2026-10-27, "On removal"): only Base releases, each day that releases anything is announced with its figures, and the removed mirror's users lose those days.

What a day releases depends on its state. A partly sent day frees the rest of its fresh hold and, under the commitment regime, the unsent rest of its recycled commitment. A day under the commitment regime with nothing sent frees the fresh and recycled commitments its finalization booked toward the mirror, the same amounts a whole send would have retired. A whole day, a day of which nothing was sent before the regime, and a day the mirror was zeroed out of hold nothing. An abandoned day is refused by the ordinary send, by every quote (which reports a new "Abandoned" status, which the keeper reads as settled) and by the manual-budget path. A remittance still pending on a released day, and released later as undeliverable, restores none of the commitment it retired, since nothing would ever retire it again. What was already sent stays counted, and a part that already reached the mirror stays there.

The release walks the days in order and stops at the first day not yet finalized, which at a removal is at least that day itself. Anyone may continue the walk afterwards. The mirror cannot be put back on the list until the walk is complete, and is then paid from the day after the removal only. Fresh deploy only, like the rest of the reward transport work. Closes #2963.

> Caveat: a day that no listed chain ever reported never finalizes by itself, and holds the walk (and so the mirror's re-listing) until the operator force-finalizes it.

_Committed 2026-10-28 01:26 UTC (293776364)._
<!-- assembled-fragment: 2963-remit-destination-removal.md sha256=206260b5583ae3a82b602fbd4a8fecfe7d83a63f588035645ff2877025e01544 -->

## Thread — Contracts build for one EVM target, whatever forge builds them (PR #2985)

The contracts' build settings named a compiler version but no EVM target, so
forge chose the target itself, and different forge releases choose different
ones: the version some contributors run built for Prague, the version CI pins
built for Osaka, and the release-gate and end-to-end jobs built for whatever
forge was current that day. The deployed bytecode, its metadata hash and the
deterministic address of the launch gate therefore depended on who built the
code rather than on the commit, which an audited code freeze cannot allow.

Every build profile now targets Prague, the newest EVM fork that every chain
Vaipakam deploys to has activated: Ethereum, Base, Optimism, Arbitrum, Polygon,
BNB Chain and their testnets. The compiler version in use emits nothing that
needs Osaka, so the contracts lose no feature by the pin. The target is raised
only once every chain in the deploy set runs the newer fork.

Closes #2973.

> Caveat: the committed gas snapshot is recorded by hand and is not re-recorded
> here, because recording it runs the whole suite; it refreshes with the
> pre-deploy regression.

_Committed 2026-10-28 02:59 UTC (41dfde054)._
<!-- assembled-fragment: 2973-pin-evm-version.md sha256=253ccdbf0b3acb5122b283def64592687dc1ee6b212d66b46563439249fd0987 -->

## Thread — keeper backstop for removed remit destinations and the reconciliation queues

Two more permissionless steps had nothing calling them on a schedule. When Base takes a remit destination off its expected-source list, the same transaction releases the pool room Base held for that chain's abandoned days, but only up to 128 days, and only up to the first abandoned day that has not finalized. Any days left after that kept their room out of the pool, and the chain could not be listed again, until someone continued the release by hand. Separately, when a reward pool pays out, its own bookkeeping walk is bounded and leaves the rest of its reconciliation writes pending. While any are pending, the administrator's corrections on that side refuse.

The keeper's reward close-out duty now does both. On Base, before it works the days, it continues every unfinished release, 128 days a call. It finds the removed chains in the indexer's record of removals, but every decision comes from the chain's own record of each release. A call goes out only when its simulation shows it would move the release forward. A release that is waiting for an abandoned day to finalize therefore costs nothing, and the run's line names the day it is waiting on. Last, on every chain, it writes each reconciliation queue's pending takes into their records while any remain, 128 records a call, repeating while a call still moves the queue. This moves no value and changes no total. Both steps share the close-out duty's arming flag and its budget of twelve sends per chain per run. The queue step gets whatever the other steps leave. Refs #2984.

> Caveat: ships disarmed with the rest of the close-out duty. Arming it on any chain is a separate owner decision.
> Caveat: the removals are read two hundred a run, resuming where the previous run stopped, above a floor of removals whose release is done. That floor moves only on what the chain's finalized block shows, and past a removal only once the removal itself is finalized, so a release that a reorg undoes is walked again.
> Caveat: when a day backlog uses the whole send budget, the queue step waits for a later run. Only the administrator's corrections wait on it.
> Caveat: for each queue the run's line gives the calls that landed and the pending figure read before and after them. The change between the two is net: another payout can add pending takes, and anyone can write them, in between. When the read after the last call fails, the line says the figure is unread instead of repeating the earlier one.

_Committed 2026-10-28 12:22 UTC (a0119f6aa)._
<!-- assembled-fragment: 2984-close-out-release-and-queues.md sha256=7df2e89cbff8a8472eed2fccb8ec974e91471dcb1a61b0101c5ab6d0c77a85cb -->

## Thread — keeper backstop for listing NFT collateral during grace

While a loan backed by an NFT is in its grace window, anyone other than the borrower-position holder may put the collateral up for sale at the protocol floor. The floor is the asking price that pays the lender and the treasury what they are owed, plus the configured buffer. Nothing made that call on a schedule. So a grace window could pass with the NFT never offered, and the lender took it in kind at default even when a buyer at the floor existed.

A new keeper duty, grace auto-list, now makes the call every minute on every chain it serves. It ships switched off, behind its own arming flag. Every minute because the shortest grace window is one hour.

The keeper decides whether a loan is in grace from the loan's own deadlines, pause credit included, against the chain's clock. It works only loans whose terms allow a prepay listing, whose collateral is an NFT and whose principal is a token, and whose borrower has not opted out of auto-listing. With no listing up it posts one at the floor. A listing above the floor, or one built on amounts that have since grown, is moved down to it.

The price is always the protocol's floor at the moment the call lands; the keeper never chooses one. The run's report names each listing with its asking price, and each loan the protocol declines with the protocol's own reason. The keeper pays only gas and moves no value to itself. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: at most six loans per chain are tried each run, and a large book of active loans is read a window per run, so on a busy chain a loan can wait a few runs before it is listed.
> Caveat: it does not withdraw a listing once grace ends. Whether the keeper should cancel expired listings is an open question on #2984.

_Committed 2026-10-28 14:23 UTC (bcb1ff8e1)._
<!-- assembled-fragment: 2984-grace-auto-list.md sha256=e8c0913d9224ed2891c8b2aa8e3bf663a50cda03b0a360a3b845dd2b83a2cb89 -->

## Thread — Read the parties a prepay-sale sanctions sync screens (PR #3049)

The two prepay-sale sanctions syncs (the loan-keyed listing sync and the
offer-keyed parallel-sale sync) now each have a read-only twin that returns
whether a listing is live and the exact recipients the sync would screen
for it: the live borrower-position holder and the recorded fee-leg
recipients for a loan's listing; the fee-leg recipients and either the
offer's creator (before acceptance) or the live borrower-position holder
(after it) for an offer's listing.

The sync and its read build that set through one shared rule inside each
facet, so the two cannot drift. The sync's behaviour is unchanged: it
screens the same parties in the same order and cancels on the same
condition.

Why: the keeper's sanctions backstop (#2984) needs to know whether a sync
is due. Without these reads it would have had to rebuild the party set from
indexed events, and the pinned executor and the offer listing's order hash
had no public read at all. With them every input to that decision is an
on-chain read.

Advances #2984. Fresh-deploy only, like the rest of the all-waves set.

_Committed 2026-10-28 13:05 UTC (07fcbc418)._
<!-- assembled-fragment: 2984-prepay-sale-parties.md sha256=528fc337a53e3610ca87f11f8447e62168bfbd04917a726b44a48b67a557e70f -->

## Thread — keeper backstop for committing flagged prepay-sale recipients

A prepay sale listing, and a parallel-sale offer, carries the parties it would pay: the borrower-position holder and each fee-leg recipient. When one of those addresses becomes sanctioned after the listing went up, the protocol's sync call commits that fact on-chain so the sale can no longer pay the flagged party. Anyone may make that call, and nothing made it on a schedule, so a listing could stay live with a flagged recipient until someone happened to notice.

The keeper's protocol upkeep pass now carries a third step, the prepay-sale sanctions sync, behind its own arming flag. It ships switched off. While it is off the run report says so by name rather than leaving the step out.

The keeper asks the protocol which parties each listing would pay, through the two new party views, so it screens exactly the set the sync call itself checks rather than a copy of that rule. It screens those addresses through a new Diamond view, `sanctionsStatus`, which gives the same three-way answer the sync acts on: clean, flagged, or unavailable when the oracle cannot answer. The older yes-or-no screen reads an oracle outage as clean, so a run during an outage would have reported nothing flagged. Now a listing the oracle could not screen is named in the report as unscreened. The keeper sends the sync only for a listing that names a flagged party. With no oracle configured the step does nothing and says why. Every read the step makes stops at its stage's cutoff, so a slow read cannot use the time its sends need.

Loan listings are read a window of active loans per run. Parallel-sale offers are nominated from the indexed listing events and read back on-chain before anything is sent. The offer cursor moves only past rows that have settled on finalized state, so a reorg cannot make it skip one. The report names each listing synced, each one the sync left live, and each one that disappeared between the read and the send. The keeper pays only gas and moves no value. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: needs the party views from #3049 and the `sanctionsStatus` view from this change; it cannot run against a Diamond that lacks them, so on the testnets it waits for the fresh deploy.
> Caveat: on a large book a listing can wait several runs before its window comes round.

_Committed 2026-10-28 17:12 UTC (cee93cb24)._
<!-- assembled-fragment: 2984-prepay-sale-sanctions-sync.md sha256=e92ba00186af71d69ca32be81276a3023c59d364b69afe953da7eb045dd8e1dc -->

## Thread — keeper backstop for expired buyback intents and the tier LTV cache

Two permissionless housekeeping steps outside the reward system had nothing calling them on a schedule.

The first is a buyback intent that passes its expiry unfilled. It stays pending until someone rolls it back. Until then, the unfilled part of its reservation is kept out of the spendable buyback budget, its allowance to the limit-order protocol stays live, and it keeps one of the intent dispatcher's commitment slots.

The second is the per-tier loan-to-value cache. It only refreshes when someone calls for it, and a cached tier stops counting fourteen days after its last refresh. Loan initiation then falls back to the governance tier caps.

A new keeper duty, protocol upkeep, now makes both calls every hour on every chain it serves. It ships switched off, behind its own arming flag.

For buybacks, the keeper finds intents in the indexer's record of commitments. It decides each one from the intent's own on-chain record, using the chain's own clock, and rolls back only an intent that is past expiry and still pending.

For the tier cache, the keeper first previews the refresh and reads what it would write. It sends the refresh only when a tier's value would change, or when a tier was cached a week or more ago, which leaves a week of margin before the cache lapses. A chain whose peers give no reading therefore costs nothing. The run's report names each tier the refresh rejects, with the protocol's own reason. Nothing is refreshed while peer readings are paused.

Neither step pays a fee or moves value to the keeper. The keeper works a chain only when its connection answers for that chain. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: the commitments are read two hundred a run. Each run resumes where the previous run stopped, above a floor of intents that are no longer pending. That floor moves only on what the chain's finalized block shows, and past an intent only once its commit is itself finalized and its order shows it ended, so a rollback that a reorg undoes is sent again.
> Caveat: the tier cache preview needs an RPC that supports `eth_simulateV1`. Without it the refresh is reported as unread and is not sent.
> Caveat: the week before an unchanged tier is refreshed is the default of a plain variable, `TIER_LTV_REFRESH_AFTER_SEC`.

_Committed 2026-10-28 12:51 UTC (c84cf138b)._
<!-- assembled-fragment: 2984-protocol-upkeep.md sha256=8649e7686544b338f5cd3399d73b0753d6d032c899d28b2911fca433be169f80 -->

## Thread — keeper backstop for closing out finished reward days (PR #2993)

Several steps that finish a reward day are permissionless on purpose, but nothing called them on a schedule. A day that had ended stayed open on paper, the transport epochs that listed it kept their remainders, and a retired custody era kept its row until someone made each call by hand. The keeper now has a close-out duty that makes those calls on every chain it serves, every fifteen minutes. It ships switched off, behind its own arming flag.

On each run it finalizes any retired custody era whose whole span is proven closed and whose row carries no staging hold. On a chain with an active reward role it drains pending surplus into the live baseline. On a detached chain it leaves that surplus for the return transport and says how much is waiting. It then proves elapsed days closed, oldest first, sixty days a run by default. Before opening a proof it checks its own reading of the chain: the entries covering the day must sum exactly to the day's recorded totals, and every one of them must have ended. A day that fails the first check is reported as a shortfall and nothing is sent, because a proof started on an incomplete reading could never finish. A day with an entry still running is counted as waiting. The keeper's own unfinished proof for a day is continued, not replaced. Next it parks the remainder of every transport epoch whose listed days are all proven closed, whose day membership is complete and which no staging record references. Releasing a parked remainder is still the administrator's acknowledgment: the keeper never makes that call, and its report names each epoch it parked. Finally it moves a still-open day's transport cursor past an epoch that is plainly exhausted.

None of these calls pays a fee or moves value to the keeper. Each call is simulated against the current state first and waits for its receipt before the next, so one run can open and finish a proof. A paused protocol, a missing signing key, an unread value, or a Diamond that names a different chain stops the affected step, and the run's report says so. The single-transaction send helper that the day-close duty used is now shared, so both duties send the same way. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: each run reads at most ten thousand reward entries, starting at a stored floor below which every entry ended before the oldest day still open. The bound therefore applies to the entries live across the open days, not to the chain's whole history. A day whose entries the run does not reach is reported as not walked, and a later run reaches it once the days before it close. A contract-side index of the entries covering each day would remove the bound altogether.
> Caveat: each closed day's transport epochs are discovered fifty a run, from where the previous run stopped, so a day listing more is covered over several runs.
> Caveat: the days not yet proven closed, the days read for parking, and the retired eras not yet finalized are each read a bounded number a run (sixty days by default, and thirty-two eras), resuming where the previous run stopped and wrapping round above a floor of what is already finished. A day or era that stays open therefore never holds back the ones after it, but when many are open each is revisited every few runs rather than every run.
> Caveat: the floor of finished eras and the floor of closed days move only on what the chain's finalized block shows, so an era finalization or a day closure that a reorg undoes stays above its floor and is done again. A day or era finished at the chain head therefore lifts its floor a run or two later, and on an RPC that gives no finalized block the floors do not move at all (the rotation still covers every day and era, just without the shortcut).
> Caveat: an epoch exhausted only by its caps, with value still on its books, is not detected. The day's next draw passes it.
> Caveat: it does not send the return transport, the zeroed-day lapse, or the other permissionless steps listed on #2984. Those are separate duties still to come.

_Committed 2026-10-28 06:34 UTC (f4e212636)._
<!-- assembled-fragment: 2984-reward-close-out.md sha256=921a5da4781994d6142d9450a415d473229ebeb129c54b063cbe3e385a7de3c1 -->

## Thread — keeper backstop for closing out finished reward entries

Two permissionless steps finish a reward entry, and nothing called either of them on a schedule. A closed entry whose remaining window is worth nothing payable (an empty window, or one the loan-side cap trims to nothing) kept its capped-off commitments counted as outstanding until someone retired it by hand. A forfeited entry's reward stayed in custody instead of reaching the recycle bucket until someone swept its loan. The keeper's reward heartbeat, which already reads every live entry about every twelve hours, now closes out the entries it reads. This step ships switched off, behind its own arming flag, and needs the heartbeat armed too.

On each run the heartbeat retires every closed entry it read whose remainder prices to nothing. A retirement moves no value: it only releases the commitments the entry still carried. An entry capped over several days retires a day at a time, so the keeper repeats the call while it still retires something. For each forfeited entry it read, the keeper sweeps that entry's loan, once for all the loan's entries, and the forfeited reward goes to the recycle bucket. A sweep can make progress while moving nothing, for example by preparing what the next sweep pays, so its returned amount is not taken as a sign that nothing happened. The keeper sweeps such a loan once each round, and again within the run while the last sweep moved value or reported progress and the loan's entries are not yet finished. Every call is simulated first. A retirement is sent only when the simulation says it will retire something, so an entry with nothing to retire costs no transaction. Each run states whether this step is switched on and, when it is not, the form of the value it found, never the value itself. A forfeited entry's paused-clock and touch reports are cleared, since a forfeited entry has no expiry clock. The run's log line states how many entries were retired and the commitments released, and how much the sweeps moved, as each call's simulation reported just before it was sent. A refused call raises an operator alert for each entry it covers, naming the call and the reason, and the alert clears once the entry runs clean or settles. A call that reverts on chain keeps it open.

A forfeited entry now stays in the heartbeat's queue until its loan's sweep has processed it, whether or not this step is armed. Before, it left the queue as soon as it was forfeited. So arming the step later reaches every forfeited entry already discovered, rather than only those forfeited afterwards. None of these calls pays a fee or moves value to the keeper. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: the step works only on the entries the heartbeat read that run, at most three hundred an hour per chain, and sends at most ten close-out transactions per chain per run, on top of the touches' thirty. A larger backlog is worked through over several runs.
> Caveat: a loan whose sweep is deferred, waiting on funding, costs one transaction each round until it can settle, because no view says in advance whether a zero-value sweep will make progress (#3012 proposes one).
> Caveat: the amounts on the log line are what each call's simulation reported just before it was sent, not figures read back from the transaction afterwards.
> Caveat: on a Diamond the heartbeat already ran against, an entry forfeited before this change has already left the queue and is not found again. Every chain gets a fresh deployment before this step can be armed, and on a fresh Diamond the queue starts empty.

_Committed 2026-10-28 11:35 UTC (1e0c412c6)._
<!-- assembled-fragment: 2984-reward-entry-close-out.md sha256=1ba20cd5ca407cd2b3b091fb61263c78dbc068d487f5c505971924cde11c92c3 -->

## Thread — keeper backstop for returning reward VPFI to Base (PR #3002)

Reward VPFI that a mirror holds for Base moves home only when someone makes a permissionless call and pays its cross-chain fee. The same is true of the messages that let Base release what it reserved. Nothing made those calls on a schedule, so an issued repatriation could sit untravelled, a cancelled one could keep Base's availability reserved, and quarantined compensation or a retired mirror's pending surplus could stay on the mirror until someone acted by hand. The keeper now has a return-transport duty. It runs hourly and ships switched off, behind its own arming flag.

For each repatriation authorization that Base holds pending, the keeper sends the instruction to the mirror. On the mirror it executes a recorded instruction once the outbound lane can carry the whole amount, which sends the VPFI home. For an instruction the administrator cancelled, it sends the cancellation acknowledgement so Base can release the amount. The keeper never issues or cancels an authorization; those stay with the administrator. Each instruction and acknowledgement is sent once. The keeper records the send before it goes out, and keeps that record until the chain's finalized state shows the authorization finished, so a send whose receipt it did not see still counts as made, even across a reorg; only one that reverted, or that the node refused, is sent again. One that has not landed within a day is announced to operators rather than paid for again, because a failed cross-chain message stays on its destination for manual re-execution.

The mirror sends the VPFI, and the acknowledgement, toward its current Base. If that is no longer the Base that issued the authorization, for example after the mirror was detached and reattached elsewhere, the keeper sends nothing for that authorization and alerts operators. Otherwise the VPFI would reach the other chain and leave the issuing Base's authorization unsettled.

Every return names the Base Diamond that should credit it, and Base refuses a return naming any other Diamond. So before sending a return, the keeper confirms where it will land: it must serve that Base chain, its Diamond there must be the one the return names, and Base's return receiver must deliver to that Diamond. If any check fails, for example after a Base Diamond was replaced, the keeper sends nothing and alerts operators. The VPFI stays on the mirror, where an operator can recover it, rather than sitting in a failed cross-chain delivery.

On a mirror the keeper also returns each quarantined compensation, and on a retired chain the pending surplus, in parts. Quarantined compensation includes a provisional credit that its day's broadcast later demoted. The demotion event now names the receipt whose record it makes, as the quarantine event already did, so the keeper can find that record from the event alone. Before this change the demotion event named only the day, and its record could only be returned by hand. Each part is bounded by the sending chain's outbound lane and by the receiving chain's inbound capacity. A part too small to be worth its fee waits, unless it is the last. Every send that moves VPFI is announced to operators with its amount and transaction, whoever made it. The announcements come from the chain's own record of each send, as the indexer recorded it, so a send whose confirmation the keeper did not see is still announced. One that does not go out is posted again on later runs until it is delivered. Fees are held to the duty's own ceiling, `REWARD_RETURN_TRANSPORT_MAX_FEE_WEI`, and the smallest part is set by `REWARD_RETURN_MIN_PART`. The return-sender contract's ABI is now exported with the rest, so off-chain code can quote its fees. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: authorizations are read from Base's own count, fifty a run, and quarantines from the indexer's event record, two hundred rows a run, each resuming where the previous run stopped above a floor of finished ones. As with the other close-out duties, each floor moves only on what the chain's finalized block shows, so a send that a reorg undoes is made again. An item counts as finished there only when the finalized block shows it finished, not merely absent. Nothing is left out for good, but when many are open each is revisited every few runs. A quarantine the indexer has not recorded yet is not seen until it is.

_Committed 2026-10-28 10:41 UTC (09f5b818f)._
<!-- assembled-fragment: 2984-reward-return-transport.md sha256=7da5b4ceedecf5d111de1195e65dd16cd654ce3eb95b91d09ff685fb6d12c17c -->

## Thread — keeper backstop for deliberately zeroed reward days (PR #3000)

When a mirror chain deliberately zeroes a reward day, its users are owed compensation from Base, and a day that is never compensated is retired as a recorded loss once its window closes. Each step of that process is permissionless, but nothing called the steps on a schedule. A zeroed day could therefore sit unquoted and unfunded, or never be retired, until someone made the calls by hand. The keeper now has a zeroed-day duty on every mirror it serves. It runs every fifteen minutes and reads sixty elapsed days a run by default, resuming where the previous run stopped above a floor of days already settled, so a zeroed day of any age is reached. It ships switched off, behind its own arming flag.

For each zeroed day whose own interest close has run and whose pool stamp is installed, the keeper submits the covering reward entries in pages, in ascending order. Once both sides add up exactly to the day's recorded totals, it dispatches the quote toward Base and pays the lane fee. That fee is held to the duty's own ceiling, `REWARD_ZEROED_DAY_MAX_FEE_WEI`, so raising another duty's ceiling never raises this one. A day that is never compensated is lapsed once its frozen window has passed, even if no quote was sent. After a lapse the keeper goes on accumulating, so the recorded loss becomes exact rather than partial. A day that was compensated below its quote is short-lapsed past its deadline. Each lapse the chain records, by the keeper or anyone else, is announced to operators with the loss it recorded, in VPFI, and announced again once a partial figure becomes exact. An announcement that does not go out is retried on the next run until it is delivered.

Accumulation is open to anyone, so a third party can move a side's cursor past entries it never submitted. Once that happens, only the administrator's reset frees the side. The keeper detects this case, raises an operator alert, and leaves the reset to the administrator. None of these calls refuses on its own while the protocol is paused, so the keeper reads the pause itself and makes none of them while it is set. A provisional credit, a missing lapse clock, a paused protocol, a missing key, an unread value, or a Diamond that names another chain each stops the affected step, and the run's report says why. The fee-ceiling helper is now shared by every duty that pays a fee, with one variable per duty. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: a quote already dispatched is not re-sent. If a dispatched quote never reaches Base, the day lapses at the end of its window.
> Caveat: the floor of settled days moves only on what the chain's finalized block shows, as the close-out duty's floors do, so a lapse or quote that a reorg undoes stays above the floor and is sent again.
> Caveat: the entry reads are bounded per run like the close-out duty's, and start from their own stored floor. Since #3014 they also resume across runs, so a day covered by more entries than one run reads is quoted over several runs (see the #3014 fragment).

_Committed 2026-10-28 08:10 UTC (60b106de8)._
<!-- assembled-fragment: 2984-reward-zeroed-day.md sha256=2b6403ab1aa6d717ba8931a094d5cdb6e0647324a3b5416a0d2aac964c7a0fba -->

## Thread — reward step passes stop reading in time to send

The keeper's operating rule says every pass stops reading early enough to leave time for the actions those reads feed. Three of the reward step passes did not do this: the reward-day close-out, zeroed-day recovery and the return transport. Their reads ran right up to the run's send deadline. So a slow node could use the whole run on reads, the sends were then refused at the deadline, and the next run would repeat it.

All three now read through one shared reader. It stops every read at the run's read cutoff, which is the send deadline less the send reserve. A read not yet started is refused there, and a read still in flight is abandoned there. Either way the pass treats the value as unread and picks it up next run. Each pass used to carry its own copy of that reader; there is now one. Nothing else about the passes changes. Refs #2984.

> Caveat: the protocol upkeep pass moves onto the same reader once its own PR (#3011) merges.

_Committed 2026-10-28 13:01 UTC (016ec3494)._
<!-- assembled-fragment: 2984-step-pass-read-cutoff.md sha256=eb6910497e64eeea0bd5dec8e2596b60fb91eb7e115c1c0cfc6b0533d7964caf -->

## Thread — keeper backstop for owed tier pushes, and one ledger rotation rule

Base sends a user's new discount tier to each mirror chain inside the user's own action. A lane that cannot be paid or reached then stays owed, and the protocol records a deferral for it. Anyone may deliver an owed push later, and nothing did, so a mirror could keep a user's old tier until that user's tier changed again.

The keeper's protocol upkeep pass now carries a fourth step, the tier-push retry, behind its own arming flag. It ships switched off; while it is off the run report says so by name.

The indexer's record of deferrals nominates the users. For each one the keeper reads the protocol's own account of which lanes are owed and when the broadcast budget may next pay each. The keeper attaches no value, so it calls the delivery only for a user with a lane the budget may pay now and whose quoted fee still fits the budget, counting what earlier deliveries in the same run actually spent, so a delivery that sends nothing holds back no one after it. Users are tried from a point that moves each run. A user waiting on spacing or on budget costs no transaction and is reported as waiting, with the reason.

This step spends the protocol broadcast budget: each delivered lane's cross-chain fee comes from it, under the protocol's own rule. The report names each lane delivered and each lane left owed, from the transaction's own records, and says so when a delivery found every lane already delivered by someone else. A user whose status lists no lane is reported as not known rather than as owed nothing. The keeper receives nothing.

The same change moves the four passes that already read the indexer's event ledger onto one shared rotation rule: buyback expiry, prepay-sale offers, removed-destination releases and stranded returns. The rule reads a page a run above a stored floor, and moves the floor only past rows finished at the head and at the finalized block, with each row's own event finalized. Each pass used to carry its own copy, and each copy had been corrected separately for the same review findings. The shared rule also stops each of its index and cursor waits at the stage cutoff of the pass using it, so a slow index can no longer hold a pass past the time its sends need. A cursor write not finished by then is left for the next run, which reads the same page again or leaves the floor where it is. Otherwise their behaviour is unchanged. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision, and arming it lets the keeper spend the protocol broadcast budget.
> Caveat: a deferral row on a chain whose destination list cannot be read holds the floor until the list reads again; the rotation still reaches every later row.
> Caveat: the fee is quoted before the send; if it rises in between, the delivery lands and leaves the lane owed, and the report says so.

_Committed 2026-10-28 18:01 UTC (01063bcf7)._
<!-- assembled-fragment: 2984-tier-push-retry.md sha256=058484acf0c28ac298e6f83623d8c87948d9759c436aa7683bff19a23b786f12 -->

## Thread — every upkeep read stops in time to send

The keeper's rule is that a pass stops reading early enough to leave its sends their time. Protocol upkeep and the grace auto-list followed it for their batched reads but not for their single calls. Protocol upkeep read the chain id, the chain's clock and the tier-cache refresh preview right up to the send deadline. The tier-push step read its gate under a cutoff that refused a new read but let one already waiting run on. Every pass that moves a stored floor read the chain's finalized block with no cutoff at all. The grace auto-list's chain id, gate, window and block time behaved the same way.

These calls now go through one bounded call in the shared reader, and the shared reader's finalized-block read is bounded the same way: one that does not come back in time leaves the floor where it is until a later run. It is refused once the stage's cutoff has passed, and abandoned there while still waiting. Protocol upkeep's reader is now the shared one. Each step keeps its staged cutoffs, so a slow gate read can no longer take the time the reads and sends after it need. Nothing else about the passes changes, and all of them still ship disarmed. Refs #2984.

_Committed 2026-10-28 18:58 UTC (575c93560)._
<!-- assembled-fragment: 2984-upkeep-bounded-calls.md sha256=e48fb6b353b8cff54861cbbc1d046a3a218de482551e8bff0e659aa0658c3e26 -->

## Thread — keeper sends carry the shared gas-limit margin

The repository has one rule for the gas limit a transaction is sent with: the node's estimate plus a fixed 30% margin (#2997). A node estimates against the latest block with no margin at all, and the transaction mines in a later block. So a call whose cost moves with time, like the reward-budget remittance #2997 found, can run out of gas at the bare estimate and revert. The app and the Anvil harness already followed the rule. The keeper sent every transaction at the bare estimate.

Every keeper send now follows the same rule, applied where the keeper prepares a transaction. That covers the queued wallet every pass sends through and the raw submission slot used for prepared sends. A send whose nonce the caller chose follows it too. A call that names its own gas limit keeps it.

Unused gas is not charged, so the margin costs nothing when it is not needed. The one visible effect: a node accepts a transaction only when the account holds the fee for its whole limit, so a keeper wallet running very low on gas tokens hits that refusal slightly sooner. Refs #2997.

_Committed 2026-10-28 13:13 UTC (e15a719fc)._
<!-- assembled-fragment: 2997-keeper-gas-limit.md sha256=1bcbfa45acfe6cbafe8eb650033ce9ebaec3de62d50346798350fcdc24785049 -->

## Thread — One cadence admission rule, and a preview of it (PR #3020)

Offer creation refused every offer longer than a year that asked for no
periodic interest, even where the specification accepts one: with periodic
interest switched off (when no cadence at all would have been admitted, since
the switch also refuses the annual one) and when either leg is illiquid (when
only "none" is allowed). The mandatory annual checkpoint on multi-year loans
now binds only while the feature is on and both legs are liquid ERC-20, which
is what the specification says. Nothing reached this before, because the
offer-duration cap still defaults to one year.

The fix is a single admission rule that offer creation, the amount re-check
on offer modification and a new preview all read, instead of a copy in each
facet. Modification now applies the whole rule to a changed amount, against
the liquidity classes the offer recorded at creation: so with the switch
turned off after an offer was posted with a finer cadence, a change to that
offer's amount is refused, as a fresh offer on the same terms would be. The
offer can still be cancelled and posted again.

The preview takes proposed offer terms and returns, for every cadence,
whether creation would admit it and, if not, the exact error creation would
raise, along with what the rule read: the feature switch, both legs'
liquidity classes, whether the annual floor binds, the principal's value and
the threshold it is compared with. It covers the cadence rule only; an offer
refused for another reason is refused whatever the preview says. Closes #3009
and gives the app's cadence picker (#2524) its source.

> Caveat: liquidity is classified live, so a preview can differ from the
> answer creation gives if the oracle, the switch or the threshold changes in
> between.

_Committed 2026-10-28 09:35 UTC (7c7c8e94e)._
<!-- assembled-fragment: 3009-cadence-admission-rule.md sha256=e4db86b76b3a9b84ab1477e7a5d40a2c18efaf3785abd98fcac4b7be6135354c -->

## Thread — busy reward days are no longer out of the keeper's reach (PR #3022)

Two keeper duties walk a day's reward entries: the close-out duty, which proves an elapsed day closed, and the zeroed-day duty, which builds a zeroed day's compensation quote. Both read a bounded number of entry pages per run. Before this change neither kept what it read: a day covered by more entries than one run's pages (more than ten thousand) was read from the same place every run, came up short every time, and was never proven or quoted. That is a stall, the case the keeper's own rules forbid ("a partial scan retains its progress").

Every entry read now resumes. For each day the keeper keeps a running sum of the entries it has read, per side, and carries it on from where the previous run stopped, until it knows whether the entries add up to the day's recorded totals. The walk that follows (the closure proof, or the quote's accumulation) is fed from the chain's own record of what it has already taken, so no list of entries is ever stored, and a run that runs out of pages loses nothing. A small mark carries the reading past long stretches of entries that cover nothing on that day. The floor below which every entry has ended moves forward a few pages a run. Within a run, the days share the pages any of them read, so the page budget bounds the run's reads rather than the number of days it can look at.

For a closure proof, the keeper still opens a walk only once every covering entry has been seen ended, and it checks each page again just before sending it, sending only the entries up to the first that is still held open. For a quote, a side is reported as wedged only once every covering entry past its cursor has been submitted and it still does not add up, which is the case only the administrator's reset can free. A day whose reading carries on to the next run is named on the run's line (`days-reading-on`). Closes #3014.

> Caveat: both duties still ship disarmed; this changes how far they can reach once armed, not whether they run.
> Caveat: a day's running sum is read again from the start when, once complete, it does not match the day's recorded totals, so a reading that went wrong is never carried forward.

_Committed 2026-10-28 13:59 UTC (e6dcd12f4)._
<!-- assembled-fragment: 3014-resumable-entry-reads.md sha256=62333d42904cfc88dd592fb248633afc1afcd5df75d706d1fff2ac5935d667b0 -->

## Thread — The cadence rule runs again when a loan opens (#3025)

The cadence admission rule from #3009 ran only when an offer was posted and
when its amount changed. An offer could therefore wait in the book while the
rule's inputs moved underneath it, and then open a loan the rule would now
refuse. The plainest case: a lender posts a two-year offer with no periodic
interest while the feature is switched off, which is allowed, and the feature
is then switched on. A fresh two-year offer on those terms would be refused,
because the annual checkpoint is mandatory on multi-year loans while the
feature is on, but the old offer could still be accepted.

Now every loan that opens from an offer is admitted by the same rule at the
moment it opens: a direct accept, every match and intent fill, and the
acceptance of a refinance or offset offer all pass through the one place a
loan is created, and the rule runs there on the loan's own terms. Those terms
are the principal actually funded, both legs' liquidity as it reads in that
transaction, and the current switch and threshold. An offer the rule would
now refuse is refused with the rule's own error until its creator cancels it
and posts it again. Owner decision 2026-10-28, "Re-check at accept".

The lender's early-exit sale listing is exempt, as it is at posting: it
carries the live loan's cadence and opens no new position.

The accept preview and the match preview now report this refusal too, as a
new "cadence not admitted" reason, so the app and matching bots learn it
before anyone signs or approves a token. They ask the same check loan
creation runs, with the same principal, so the preview and the transaction
cannot disagree. A lender-intent fill needs no new reason: it only ever opens
a loan of a year or less with no periodic interest, which the rule always
admits.

> Caveat: liquidity is classified live, so a cadence offer whose collateral
> turns illiquid after posting is refused at accept for as long as it reads
> illiquid.

_Committed 2026-10-28 13:18 UTC (265499e62)._
<!-- assembled-fragment: 3025-cadence-recheck-at-accept.md sha256=2b3e81fda440116011fa2ce3adbb1ef8a5ca6b8b6422a568b312201121d65a13 -->

## Thread — Off-chain backups: declare the first monthly archive, acknowledge the October gaps (PR #3058)

The backup watcher and the Worker's weekly healthcheck now both know that
September 2026 is the first monthly archive this deployment wrote. Until now
neither had that fact, so each judged the monthly tier only from the archives
it could still see. Judged that way, a deleted oldest monthly simply moves the
baseline forward and is never reported. With the first month declared, every
month from September 2026 onward is required, and a missing one raises an
alert.

The value comes from the bucket's history, not just from what survives in it.
The current bucket was created empty when the backup service was renamed from
"archive" to "warm" in early August 2026. A monthly is cut on the first of the
month, so September was the first month the bucket could hold. It is also the
earliest monthly the watcher's first run found.

The workflow and the Worker each carry the value and must stay equal. The
Worker's copy takes effect the next time it is deployed. The yearly tier stays
unset until the first January cut exists.

The same change acknowledges, by owner decision, the three gaps the watcher's
first run reported, none of which can be recreated: no October 2026 monthly
(the October 1 nightly did not run), and the October 18 and 25 dailies, which
have no manifest beside them (the October 25 manifest upload hit a storage
fault that the nightly now retries). Acknowledging a gap stops only that
gap's alert; any new gap still pages.

Closes #3048.

> Caveat: the Worker is deployed by hand, so its weekly healthcheck keeps reporting the monthly tier as "coverage degraded" until the next deploy.

_Committed 2026-10-28 13:04 UTC (bbabc5d95)._
<!-- assembled-fragment: 3048-backup-monthly-baseline.md sha256=f1d669365944635053490d06337af9a56578e52fff51bfc3fadb59016c3952b1 -->

## Off-chain backups — transient storage faults are retried (PR #3052)

The backup watcher's first runs found three gaps in the nightly backups: no
backup at all on October 1 (so no October monthly either), and two Sunday
dailies, October 18 and 25, written without their manifest. The October 25
log shows the cause: Backblaze answered the manifest upload with a one-off
"internal incident" error, and the nightly gave up on the first failure. The
watcher's own first real run hit the same kind of error part-way through.

The nightly now retries such faults. It tries each upload up to three times,
with a short pause, when the failure is a network error, throttling or a
server-side fault, and stops at once on a refusal. The watcher retries its
reads the same way, but never repeats a ledger upload within a run: a failed
upload is indeterminate (it may have been stored, or may still land), and a
second one could leave a second locked version that the watcher itself would
read as tampering. Instead the run still judges that archive from what it
computed, says in its summary that it was left to the next run, and the next
day's run, once the first request has long settled, records it if its own
listing shows it did not land. An archive that stays out of the ledger for
more than two days after the ledger could first have recorded it pages.
That age is counted from the ledger's first entry, so a ledger that holds
nothing yet has no clock: if a run cannot write to an empty ledger, that
pages at once, because until the ledger holds an entry it protects nothing.

The nightly's key cannot list the bucket, so it cannot make that same check.
If Backblaze ever stores an upload and still reports an error, the retry
leaves a second copy of that name; the watcher then reports the name as
ambiguous rather than letting it pass unnoticed.

Advances #1473. The three gaps already recorded stay in issue #3048 until
they are acknowledged: the missing October 1 backup and the two missing
manifests cannot be recreated after the fact.

> Caveat: the October 1 and October 18 logs are past their retention, so their cause is inferred from October 25's, not observed.

_Committed 2026-10-28 12:52 UTC (aad32c507)._
<!-- assembled-fragment: 3048-backup-transient-retries.md sha256=8a10aa9980862c6ce3728dd9f09e9ae993130056c99e41d5b44aae4824b39e72 -->

## Keeper — the default and periodic-settlement passes stop reading in time (PR #3070)

The keeper's rule is that every read a pass makes stops at the run's read
cutoff, which leaves the sends their time. The grace-default pass, the
periodic-interest settler and the liquidator's in-kind close-out did not
follow it. A slow node or a slow quote API could hold one of them past its
deadline, so later chains in the same run, and the sends already planned,
lost their time.

Each attempt now reads first and sends second. Its checks, from the loan and
the forced-sale plan to the route quotes and the final preview, have to
finish by the read cutoff. If they do not, the attempt sends nothing, is
reported as skipped because the reads ran past the cutoff, and is tried again
on a later run. An attempt given up at the cutoff also starts no further
request of any kind, RPC or quote, even if a late answer lets its checks go
on. The send itself keeps its own deadline rule and is never cut off once it
starts.

The active-loan window that four passes scan now has its own cutoff ahead of
the reads that follow it. That covers grace default, periodic settlement,
prepay auto-listing and the prepay-sale sanctions sync. The default and
settlement scans now keep every chunk of eligibility answers that came back
in time and report only the rest as unread. Before, a hung chunk lost the
whole window.

One latent fault is fixed along the way. A cutoff meaning "no deadline" was
handed to a timer that cannot count that far, so it would have fired at
once. Such a cutoff now never cuts.

Closes #3069. Advances #2984.

_Committed 2026-10-28 19:50 UTC (f1ef5c948)._
<!-- assembled-fragment: 3069-bounded-pass-reads.md sha256=7aa79d61543d763c23f7f2481b3ab2c961658daddfd4f7d07347ea96f11417dd -->

## Thread — small contract fixes from the open-issues sweep (PR #2994)

A fresh offer can no longer be cancelled during its first five minutes,
whatever the partial-fill setting says. The cooldown used to apply only
while partial-fill matching was switched on, so a creator could watch an
accept arrive and cancel ahead of it on a direct-accept book. An expired
offer can still be cancelled at any time, and a partly filled offer still
cancels its unfilled part straight away. Past the cooldown, a cancel and an
accept are an ordinary race and whichever lands first wins; the spec now
says so. Closes #664.

The dashboard's claim list and its claim counts now list exactly what a
claim call would pay. The claim facet and the dashboard read one shared
rule for which loan statuses can be claimed and whether each side still has
something to pay. So an NFT return, which carries an amount of zero, now
shows up as a claim, and a row on a loan the claim would refuse is not
listed. Closes #941.

Operators can now read back every setting they can change. AdminFacet has
getters for the aggregator-adapter pause and the peer-protocol LTV read
pause (#1637). Each of the eight chain-level oracle setters (Chainlink
registry, the USD and ETH denominators, WETH, the ETH price feed, the stable
peg feeds, the v3 factory and the sequencer uptime feed) and the four
backstop switches now emits an event carrying the previous and new value,
and the indexer's configuration snapshot listens for them, so no published
setting changes silently any more (#2685). The notification-fee event's
argument is renamed to say it is a VPFI quantity (#1934).

Two new read-only views. One returns the seller floor, held ceiling and
expiry a standing sale listing recorded, plus what is held for the lender
now, so a seller can see what they agreed to (#2672). The other returns the
highest position-NFT id ever allocated, so the NFT verifier can tell a
burned token from one that was never minted (#2529, used by the app).

Housekeeping: the active-loans page view now documents that it can skip a
loan if the list changes between pages (#942), and leftover wording about
the removed VPFI buy flow is gone from the deploy scripts, the cross-chain
NatSpec and the gas snapshot (#2804).

> Caveat: these are contract changes for the all-waves fresh deploy; they reach the testnets only then.

_Committed 2026-10-28 05:51 UTC (275f9b12e)._
<!-- assembled-fragment: 664-941-small-fixes-batch.md sha256=4845e80a0ea88914e8227afc2e589b5c35add12ccecb6b18aec22672ca28a1a0 -->

## Website — supported chains match the Phase 1 set (PR #3031)

The website's overview, in all ten languages, listed Polygon zkEVM and BNB Chain among the chains Vaipakam runs on. Neither is in the Phase 1 production set, which is Ethereum, Base, Polygon, Arbitrum and Optimism: zk-rollup chains are out of scope, and BNB Chain is used only as a testnet rehearsal network. The list now names those five chains, with Polygon meaning the Polygon PoS network the specification targets.

The English advanced user guide gave Sepolia and BNB as examples of chains a fee-discount tier reaches. It now names the other Phase 1 chains instead.

The whitepaper already stated the set correctly and is unchanged.

_Committed 2026-10-28 10:36 UTC (549dfefaa)._
<!-- assembled-fragment: www-overview-supported-chains.md sha256=e10e57693f2ee00e0e4f7054e6098c818351016e5b62ca4767facda8994ce264 -->
