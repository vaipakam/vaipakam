# Release Notes — 2026-11-04

The all-waves fresh deploy landed on all three testnets: Base Sepolia and Arbitrum Sepolia first, then BNB testnet the same morning, with rewards relaunched from 2026-11-04 00:00 UTC. Around it, the mesh watcher went live and now reads one chain per tick, in one batched read per Diamond, on the cron's own cadence. Backups are now encrypted to offline public keys, so the backup Worker can no longer read what it writes. The app's reads go through the RPC proxy on the testnets. The keeper lost three bridges the fresh deploy made unnecessary and gained several protocol-upkeep duties, each of which ships disarmed until an owner arms it. On the contract side, reward close-outs now report their progress, a repatriation is paid only to the chain that issued it, a released transport remainder goes home to Base to be recycled, and a daily rental deduction charges only an agreed day. In the app, the auto-extend card and extension reserves arrived.

Each section below records its change as it was merged, so a caveat can be overtaken by a later section of the same day. The first deploy section's note that BNB still ran the October build was resolved by the BNB section after it. The mesh watcher's leftover dashboard setting was deleted after these notes were written.

## Mesh watcher — one request per Diamond, fewer alert messages

The mesh watcher now reads every view it needs from a Diamond in a single
call, through the standard Multicall3 contract, at the block the tick has
pinned. Before, each view was its own request. On the live testnets a tick
went from 17–18 requests to 6–7, and the figures it observed were identical
on all three chains. The free Workers plan allows 50 requests per run, so
the watcher now has wide headroom: even reading the whole mesh in one tick
would take about 15. The one-chain-per-tick rotation stays, because it keeps
each tick's cost flat as mirrors are added.

Each view still fails on its own. A view that reverts, which is how a
selector missing from a Diamond's current cut shows, or one whose answer
does not decode, costs only the checks that need it, as before. Only a
failure of the whole call makes the chain unreadable for that tick, and it
is reported as a coverage gap, never as a pass. That includes a chain where
Multicall3 is not deployed. It is deployed on every chain the mesh runs on
today.

Alerts are packed too. One Telegram message now carries as many findings as
fit, instead of one message per finding, so a burst of alerts cannot use up
a tick's requests. Critical and advisory findings are never mixed in one
message, so a critical still notifies and an advisory stays silent.

CPU per tick also fell, from about 40–50 ms to about 15 ms when run in
Node. That is a guide, not a Workers measurement, and it is still above the
free plan's nominal 10 ms, which Cloudflare has so far allowed. The Workers
Paid plan remains the fix if ticks start being cut off for CPU.

Advances #1222 (M3 B4-c) and #1956.

> Caveat: a chain added to the mesh needs Multicall3 at its canonical address; without it that chain is reported unreadable on every tick.
> Caveat: the CPU figures are Node measurements, not Workers ones.

_Committed 2026-11-04 11:32 UTC (3a80e37ff)._
<!-- assembled-fragment: 1222-mesh-watcher-batched-reads.md sha256=2059aecb92aa9271e3ad1267b7488a01ce3a90746a9360aa925ecf34adbd10e4 -->

## Thread — Mesh watcher deployed, credentials from the Secrets Store (PR #3141)

The recycling-mesh ledger watcher is now deployed as its own Worker with its
own alerts database. It no longer keeps private copies of the ops Telegram bot
token, the ops chat id or the per-chain RPC URLs. It binds to the same account
Secrets Store entries the keeper, indexer and agent read, and resolves them once
at the start of each run. A store read that fails is treated as an unset value,
so it shows up as a coverage gap or as unconfigured delivery rather than as a
silently skipped chain, and the failure log names the binding but never its
value. The manual run endpoint keeps its own per-Worker bearer token and stays
closed while that token is unset.

The shared deploy wrapper now finds wrangler through the bin entry its package
declares. The newest wrangler stopped exporting the file path the wrapper used,
which made every wrapped deploy fail before it started.

The cron-slot ledger, the deploy-lag check and the operator runbooks now
record the watcher as the live occupant of its slot.

Advances #1222 (Step 3f of the recycling activation ceremony).

> Caveat: At three chains a run that read the whole mesh did not fit the free
> Workers plan: it made more than the 50 outbound requests allowed per
> invocation and used about 93 ms of CPU against a 10 ms allowance. The
> one-chain-per-tick rotation (PR #3142) addresses the request limit.

_Committed 2026-11-04 09:44 UTC (81d0659db)._
<!-- assembled-fragment: 1222-mesh-watcher-deployed.md sha256=51f20cc8c6d619f3b515f1b119b69691a2a148bbc82b9e715b1425df3cf40eed -->

## Thread — Mesh watcher reads one chain per tick (PR #3142)

The mesh watcher now runs every five minutes, and each run reads the canonical
chain plus one chain of the mesh, in rotation. Reading the whole mesh in one
run went past the free Workers plan's limit on outbound requests per
invocation, so the last chain's reads and every alert send were refused. Every
check the watcher runs compares Base's record for one chain with that chain's
own books, and none adds up across chains, so splitting the reads loses no
check. Each run still reads Base's figures and the chain's figures together,
from the same moment.

The rotation is the canonical chain first, then the expected source chains in
ascending order. It comes from the canonical chain's own list on every run, so
a newly wired chain joins it without a redeploy. The slot is taken from the
scheduled time, so a late or doubled run cannot shift the order. With three
chains each chain is still read every fifteen minutes, which is what the two
alert windows were sized for.

A run now clears stored alert records only for the chain it read. Before, any
record not seen on a run was forgotten, which under a rotation would have
re-sent every other chain's open alerts each cycle.

The manual run takes a chain id, and verifying a deploy means one run per
chain.

Advances #1222 (Step 3f of the recycling activation ceremony).

> Caveat: The alert windows count observations of one chain. A fourth chain
> stretches each chain's cycle to twenty minutes and lengthens both windows by
> a third, so they need retuning then.
> Caveat: A one-chain run still uses more CPU than the free plan's nominal
> 10 ms. The first all-chain run used 93 ms and was allowed to finish, but
> nothing guarantees that. If runs start being cut off for CPU, the remedy is
> the paid Workers plan.

_Committed 2026-11-04 09:57 UTC (f3f36389e)._
<!-- assembled-fragment: 1222-mesh-watcher-rotation.md sha256=0d4563815c490a67d1f4dbabb6951f2a86cdac1e71f3ed0c43b3835ca9c7f645 -->

## Thread — Backups the archive Worker cannot read (PR #3152)

Slice 2 of the backup security design. The nightly archive Worker now
encrypts each archive to offline public keys: a fresh data key per archive,
wrapped to each of two committed recipient keys (a primary and an escrow, held
apart), so nothing the Worker holds can decrypt what it wrote. The recipient
public keys are a reviewed, append-only file in the repository, bundled at
build time; the private keys never reach Cloudflare, GitHub or any server.
Each archive carries an authenticated header naming its tier, period, creation
time and recipients, and each tier is encrypted on its own, so the January
monthly and the yearly are no longer the same bytes.

In the same change the Worker lost its reader. The weekly healthcheck, the
B2 read key it used and the symmetric decryption key are gone, so the Worker
holds one write-only key and cannot list, read or find an existing archive.
Its nightly report names each archive's tier, period, size and SHA-256, and no
longer the object's name, whose random part is what keeps a leaked write key
from overwriting it. Archives written before this change keep the exposure of
names already posted.

The backup watcher, which already ran outside Cloudflare, learned the header
check: an archive in the new format must be well formed, name its own tier
and period and a creation time within the run that uploaded it, and name
exactly the recipient set in force then; a manifest must declare the format
its archive is actually in; and once the first new-format archive is
recorded, an old-format one uploaded later pages. Nobody online holds a
private key, so a passing header is not proof that an archive decrypts; only
the offline restore drill shows that.

A new offline tool decrypts an archive for a restore, in either format, only
when the ledger vouches for it: it refuses tampered ledger entries, an archive
whose bytes are not the recorded ones, and a period with more than one entry,
until the operator names the one to trust, and it checks the decrypted
creation time against the header and the period. The restore runbook's
decrypt step and its key-rotation section were rewritten, because the old
rotation re-encrypted every archive and destroyed the old key, which every
pre-change archive still needs.

After deploy the owner deletes the three retired secrets and the monthly
baseline var from the Worker, keeps the old AES key offline indefinitely,
deletes old ops-channel messages that name archive keys, and runs a restore
drill. Closes #1463.

> Caveat: the rest of the restore runbook and the resilience design's §3.3–§3.6 still describe the deployment before this change; they are the design's docs slice.

_Committed 2026-11-04 14:26 UTC (80b3014af)._
<!-- assembled-fragment: 1463-backup-public-key-encryption.md sha256=1eb9e0a16c33dbddaf8885dc312ec8211a04708d66aa235fe10db1be18e3abee -->

### The app reads testnet chains through the RPC proxy (#1724)

The connected app now reads Base Sepolia, Arbitrum Sepolia and BNB Testnet through Vaipakam's own read-only RPC proxy at rpc.vaipakam.com, instead of calling a provider directly from the browser. Before this, the app's build carried a provider URL with its key, so anyone opening the page could read the key and spend its quota. The proxy keeps the provider keys on the server, accepts only read calls from the app's own origins, and limits each caller.

If the proxy is down or over its daily allowance, the app falls back to each chain's public endpoint and keeps working. Ethereum and Base mainnet, which the app reads only for ENS names and display, use public endpoints until the proxy has keys for them. The proxy's hostname is now declared in its own configuration, so a deploy keeps it bound.

_Committed 2026-11-04 08:02 UTC (a20b2d73b)._
<!-- assembled-fragment: 1724-app-reads-through-rpc-proxy.md sha256=33dc910f786765898c7418de807d58e998a0732050e3877dad5deda5f7156004 -->

## The RPC proxy runs on the testnets first (#1724)

The read-only RPC proxy now binds only the three testnet keys (Base Sepolia,
Arbitrum Sepolia, BNB Testnet), which are the keys that exist today. Cloudflare
refuses a deploy that names a key the store does not hold, so the five mainnet
entries are added back with their keys at mainnet. Until then a request for a
mainnet chain is refused as not configured, and the app falls back to that
chain's public endpoint, as it does whenever the proxy cannot answer. The app
does not use the proxy yet; that is a separate build setting.

_Committed 2026-11-04 07:28 UTC (72327f234)._
<!-- assembled-fragment: 1724-rpc-proxy-testnets.md sha256=2ac342141c883a7e8615a402c3a4c2c8a3d443cc07644f20b671150db585ee4f -->

## Thread — Forced close-out card names the lender-KYC refusal (PR #3063)

The lender's close-out card now asks the protocol whether a time-based default would pass its lender-KYC check, using the view the contract side added for exactly this question. Before, the card left that check out on the reasoning that KYC is off on the retail deploy, so on a deployment that turns KYC on it could show a ready close-out the chain would refuse, with only a failed simulation to say so.

The verdict is one more read in the batch the card already makes, so it is dated by the same block as every other fact the card shows. It sits in the protocol's own order: after the pause check and before the repayment window. Where it refuses, the card offers no action and says that this deployment has identity verification switched on, that it is the lender recorded on the loan who must meet the tier, that nobody can close the loan out until then, and that the answer can change as the loan's value moves. Where KYC is off, which is every current deployment, the verdict always passes and the card is unchanged.

The app asks the contract rather than valuing the loan itself, so there is no second copy of the oracle-priced rule to drift. The live review driver's mirror of the card's rule carries the same gate, and its test checks the mirror against the app over every combination of facts.

Closes #2083.

> Caveat: the view exists only on Diamonds built from current source, so on the testnets it arrives with the all-waves fresh deploy. Until then the card reads that fact as unread and shows its still-checking state rather than a verdict, and this app change ships with that deploy.

_Committed 2026-11-04 03:45 UTC (8cdaf1b1e)._
<!-- assembled-fragment: 2083-forced-close-kyc-verdict.md sha256=db200ec5d0b8c03b760f3fef542e0c4c43b026eb0f449b0c2baffcd4fb50c225 -->

## Thread — Storage-layout record stops anchoring the chain's own WETH (PR #3161)

An in-place facet refresh first checks each chain's storage-layout anchor, a fingerprint of all the code the chain's layout record governs. That set was built from every address in the chain's deployment file, which also records the chain's own WETH. On Arbitrum Sepolia (as on Arbitrum One) that WETH is an upgradeable proxy run by Arbitrum, so it counted as code the record governs. The testnet rig writes the WETH entry after the deploy has anchored, so the first refresh after the 2026-11-03 deploy was refused for a proxy the anchor did not list. A live readback showed every Vaipakam address on Arbitrum unchanged.

The record now governs every proxy the walk finds except the chain's own WETH, the deployment file's top-level `weth` entry. Vaipakam neither deploys nor upgrades that contract. The same name deeper in the file, such as a rig's own entry, is still governed. Base and BNB testnet anchors are unaffected, because their WETH is not a proxy. Arbitrum's existing anchor matches the chain again with no re-anchoring.

The exclusion is one named entry, not a general rule, so it fails closed. Another chain-provided proxy would still be refused loudly. A rule that guessed ownership could instead drop one of our own proxies from the guard without saying so. The governance handover is unchanged and still reports any third-party contract that answers `owner()`.

Advances #2092.

_Committed 2026-11-04 16:24 UTC (0b9d3a470)._
<!-- assembled-fragment: 2092-layout-record-skips-chain-weth.md sha256=c9301de0268d0876888a095d74ce21a9c0c319fa6d8ae96364c507d158a9b7f5 -->

## Keeper — announce the untyped return of a transport remainder (PR #3149)

#2376 added an administrator-only mirror call that sends a released transport
remainder home to its issuing Base, untyped, where Base books it recycled on
arrival. It moves VPFI off the mirror, so the return-transport pass now
announces it to operators the same way it announces every other return: from
the chain's own `UntypedRemainderReturnDispatched` record in the indexer's
event ledger, with the amount, the budget packet, the destination, what stays
in the remainder, and the transaction. The keeper never makes this call
itself, because it is admin-gated.

The keeper README also stated the old rule for a mirror bound to another
Base, which #3147 changed. It now says the current rule: a recorded
instruction is driven toward its issuing Base, and only a new instruction is
withheld.

Nothing is armed: `REWARD_RETURN_TRANSPORT_ENABLED` is unset on the keeper
machine, and #2376 reaches chains only at the next fresh deploy. Advances
#2376.

_Committed 2026-11-04 12:53 UTC (9a2ac1141)._
<!-- assembled-fragment: 2376-keeper-untyped-return-notice.md sha256=ef62b7a78402604e95f1921f7d856741511a2c4c5b54f79423c2376a78232f9f -->

## Thread — a released transport remainder goes home to Base and is recycled there automatically (PR #3148)

A reward delivery to a mirror is held in a transport epoch until every day it funds is proven closed. What is still in the epoch then is parked, and once an operator acknowledges the parking it is released. Until now a released remainder had one way out: an administrator classifying it, on the mirror, as fresh or recycled. Where no one can say which it was, the remainder had nowhere to go.

It can now go home. On the mirror an administrator sends part or all of a released remainder back to Base over the existing return channel, in parts no larger than the mirror's side of the lane can carry. Each part reduces the parked balance and the delivery's untyped remainder by exactly what it sends, and is recorded as a disposal rather than a classification. Its tokens leave reward custody measured at both ends, and the message names the delivery and the Base Diamond that sent it. It goes to the chain that delivered the packet, even if the mirror has since detached or bound to another Base, the same rule #3015 set for repatriation instructions. A remainder not yet acknowledged, a delivery with no epoch, a zero amount and an amount past what is parked are all refused, with nothing moved. A failed send changes nothing.

On Base, what arrives is credited straight into the recycle bucket, with no operator step (owner decision, refining an earlier "reconcile on Base" plan). As with a retired chain's surplus, it is relocated custody rather than new absorption: it does not feed the day series behind the trailing absorption average and does not reopen fresh headroom. A Base Diamond that replaced the one that sent the delivery refuses the return, which leaves the cross-chain message retryable. Each arrival is announced with its source chain and the mirror delivery it came from, and each side publishes its running total.

The trade-off is stated, not hidden: a remainder that began as fresh budget is booked as recycled when it comes home. That is a labelling cost, not a loss, and it follows from the design rule that value is never typed in passage.

This is a new message kind on the return channel, so a receiver that predates it refuses the message and keeps it retryable. It reaches a chain only at its next fresh deploy.

Closes #2376.

_Committed 2026-11-04 12:23 UTC (10b09747a)._
<!-- assembled-fragment: 2376-untyped-remainder-return.md sha256=2dfadf8099efef94232dae7d655d9fb3079f18eb4834e007a2d10560ab10632c -->

## Thread — Reward metrics answer an unserved chain as unavailable (PR #3128)

The indexer's two reward-metric reads, the loop-closure ratios and the recycling account, now follow the same rule as its loan, offer, signed-offer and protocol-config reads. A chain the indexer is not serving gets a "chain not configured" unavailable answer, never its stored figures. Before this, a chain whose RPC was removed or failed still had its stored figures served with a normal answer. After a chain was retired, those historical figures could read as current.

The loop-closure read asks the same question as the other reads: is this chain deployed, and does its RPC resolve. The recycling read is answered before the indexer resolves its secrets, deliberately, so a slow secret store cannot push it past the browser's time limit. So it asks a narrower question that needs no secret: is the chain deployed, and is its RPC configured. That refuses a retired chain or one never set up. A configured chain whose secret fails still answers from its stored series. In that case the series' own day coverage says where its record ends, and the indexer's ingest health check reports the stall.

The app already shows both surfaces as unavailable when the indexer gives no usable answer, so nothing a user sees changes for a served chain.

Closes #2654.

_Committed 2026-11-04 06:58 UTC (564caf2a9)._
<!-- assembled-fragment: 2654-reward-metrics-unserved-chain.md sha256=a08a9d0624a09c56e764d783ed9d5713918cb9f6556064ce2ddc6c65ff4f8bc7 -->

## Thread — Automatic extension and extension reserves in the app (PR #3102)

The contracts for the extension reserve (#3071) gave the borrower an explicit way to fund automatic extensions, but the app had no automatic-extension surface at all: neither side could set their consent, and nobody could see whether an extension would be funded. The loan page now has an automatic-extension card for both parties to an active loan.

The card states the protocol's switch and pause, the loan's extension window, and both sides' limits as the protocol holds them, including that limits an earlier holder of a position set no longer count. From the two sets of limits it states the terms an extension may use, or that they leave no rate both accept, or that both sides must have limits in force first, and it says that whoever sends the extension picks the exact terms within them. Each party can set or clear their own side; turning consent off stays open even while the feature is switched off and before the current Terms are accepted.

The borrower-position holder also sees the extension reserve: what is reserved, their other free balance of the loan's asset, what an extension would charge now and at the end of the window, and whether that is covered, with the shortfall named. They can add to the reserve (the loan is re-checked before any approval, and an approval left behind by a failed deposit is put back) and withdraw what is unused (read again just before signing, never held behind the Terms gate, with a protected account's payout route stated). The card also says whether a keeper they allow can send the extension, and what to change if not.

The reserve belongs to the depositor, so a wallet holding one on a loan that has ended, or on a borrower position it has since passed on, sees it on the loan page with its withdrawal. The Claims page lists every reserve a wallet holds, found from the indexer, which now files the reserve's funding, withdrawal and draw rows under the depositor. A one-time indexer migration files the rows stored before that change the same way, so a reserve funded earlier is listed too. When the page cannot read which positions a wallet holds, it still offers the reserve's withdrawal, which needs none. A change of network or wallet clears any typed amount or open review, and a wallet whose account was replaced is told that the keeper permissions it gave no longer count.

Advances #2814 (the app half; the contract half closed it).

> Caveat: there is no end-to-end test of this surface yet; it needs a Diamond carrying the #3071 facets, which no testnet has until the all-waves fresh deploy.
> Caveat: a protected account's controller cannot yet withdraw the reserve of an account it took over from this card; the contract allows it, and the card offers only the connected wallet's own reserve.

_Committed 2026-11-04 03:10 UTC (a68b4baa8)._
<!-- assembled-fragment: 2814-auto-extend-app.md sha256=03a74aee0db53d525418e98c4836571fcc7bfa6faba87add0f796c601729747b -->

## Thread — Auto-extend card: honest cover line and one reserve result (PR #3122)

The live run of the auto-extend card on Base Sepolia turned up two places where the loan page said more than it knew. Both are fixed here. This advances #2814.

Before the extension window opened, the reserve panel said the reserve "does not cover an extension now", although no extension can run before the window. The panel now speaks of an extension "now", in its charge figure and in its cover line, only while the window is open. Before the window opens, or while the window has not been read, it states only the charge and the cover at the end of the window. That end-of-window charge is the most an extension of the current term can charge, so covering it covers the whole window. Once the window has closed, or the loan has none, the panel makes no cover claim at all.

After a withdrawal on the loan page, the deposit's "Added to your reserve." stayed next to "Your unused reserve was withdrawn.", so the page showed two results that contradicted each other. Now only the latest reserve action's result is shown. A withdrawal hides an earlier deposit's result, and a later deposit clears the withdrawal's result.

> Caveat: the position page's owed interest still shows every digit the token carries ("~0.000000821917808219 WETH"). That follows the exact-amount rule #2662 set for the page's figures, and it is left for a separate decision.

_Committed 2026-11-04 05:39 UTC (6cf7da90c)._
<!-- assembled-fragment: 2814-auto-extend-live-polish.md sha256=e53f712b5e0f28a7ca9caa38d9703853d313285959db197a1b36c79d29467c8f -->

## Thread — Live driver for the auto-extend card and extension reserves (PR #3124)

A new manual-only live driver, `live-auto-extend.mjs`, drives the loan page's automatic-extension card and the extension reserve through the deployed app with two dev wallets on Base Sepolia. The borrower and the lender each save their limits through the six-row review receipt, and the chain must then hold exactly those limits. The borrower reads the overlap as limits, not as a promise. The borrower then adds a small reserve, withdraws it from the loan page, adds it again, and withdraws it from Claims. Every signature goes through one ordered write plan in the wallet, with each request's full expected payload. Every fund movement is checked against its own event and a read pinned to its block.

Funds moved: setting limits moves nothing but gas. Each deposit moves the reserve from the borrower's wallet into the borrower's own vault, reserved for that loan (ExtendReserveFunded). The only approval is exactly the deposit amount. Each withdrawal returns it from the vault to the borrower's wallet (ExtendReserveWithdrawn). Nothing reaches the lender or the treasury, and the drive fails if a reserve or an approval is left standing.

The Claims page's reserve card now publishes where its discovery stands (loading, nothing found, unavailable, or listed, with any loan it could not read), so the drive judges a missing row only once the list has actually answered, and only after the indexer has filed the loan's deposit. Each reserve row also publishes whether its amount has loaded, so an amount the page could not read is never taken for a wrong one. The loan page's automatic-extension card publishes whether its extension state has loaded, and the reserve panel likewise publishes whether the extension state and the token's units have loaded, so its figures are judged only once they are final. Nothing a user sees changes.

The drive refuses a borrower wallet in protected account mode before any write, because such an account's withdrawals can be queued or kept in its vault rather than paid to the wallet. If one is queued or kept anyway, the run reports it as not returned instead of passing.

The first run passed on Base Sepolia loan 1. Its tx hashes and per-step evidence are on the PR. Advances #2814.

> Caveat: an extension itself is not driven, because the window opens near maturity. Both sides' limits are left in force on the fixture loan on purpose.
> Caveat: the forced close-out KYC check had nothing to observe, because the new Base Diamond has no past-grace loan.

_Committed 2026-11-04 06:46 UTC (5c7fc654c)._
<!-- assembled-fragment: 2814-live-auto-extend-driver.md sha256=5c1f1ebd2c1d0e8c4ec8bd62cd88b63dd261aeb731d94ae709e8bfe325f4d897 -->

## Keeper — the B4 day-report path is removed (#2866)

The keeper's day-close pass carried a second report path for the live testnets, whose reward messengers and Diamonds were deployed before PR #2790 and send the older B4 day report (PR #2867). At the all-waves fresh deploy every served chain runs the one report shape (#2621), so that path is gone.

The pass now checks one thing about each end's reward messenger: whether its code carries the day-report quote. A messenger that does not, on the mirror or on Base, holds every close with the report-channel alert and says which end lacks it. An unreadable messenger also holds the close, as before. The fee is always quoted along the route `closeDay` names.

This merges with the all-waves fresh deploy. Merged earlier, the keeper would stop closing mirror days on the testnets that still run pre-#2790 messengers.

_Committed 2026-11-04 01:22 UTC (2007d248a)._
<!-- assembled-fragment: 2866-keeper-b4-removal.md sha256=37002ae56983c09c3a960483dfa37724efd2a3499f485465f623854d1bcca2ca -->

## Thread — www deploys prerender again on Workers Builds (PR #3130)

The automatic marketing-site deploy was red. The earlier cause (the config
gate could not read the live bundle) went away with the all-waves refresh,
and the deploy then stopped at the prerender step. Workers Builds runs an
Ubuntu image without the shared libraries Chromium needs, so the browser
Playwright downloads could not start. Until 2026-11-02 the dashboard deploy
command skipped prerendering altogether, so this was the first time the
step had run there.

The prerender step now asks the dynamic loader which libraries the browser
is missing. It maps each one to the Ubuntu package that ships it, fetches
those packages with the host's own apt into a private folder (no root, no
system files written), and launches the browser with that folder on its
library path. Each step is announced in the build log. A library with no
known package, a host without apt, or a library still missing afterwards
fails the deploy and names what is wrong.

The launcher also stops hiding its own failures. It used to report only
its first error, so the Workers build said the browser "doesn't exist"
right after installing it. It now lists every attempt and why each failed.

Closes #2903.

> Caveat: the library-to-package table is measured against Ubuntu 24.04 and Chromium 149. A Playwright upgrade that needs a new library fails the deploy by name until the table is extended.

_Committed 2026-11-04 07:34 UTC (f65188028)._
<!-- assembled-fragment: 2903-www-prerender-browser-libs.md sha256=db8afdc4b9ed82b084b9326c1ff49bf8c3c055193d0c7f33e379db32787dd52c -->

## Thread — www prerender waits for each page to declare itself (PR #3138)

With the browser libraries in place, the first real Workers Builds run
of the prerender step snapshotted 118 of 120 pages. The two translated
advanced guides failed the indexing check with no canonical link at all.
The step waited a fixed tenth of a second after the site shell mounted,
but the shell mounts before a lazily loaded page renders. The guides are
the heaviest pages, and on a slow build machine they had not rendered in
that time. Pinned to one CPU locally, the old wait failed 11 of 120 pages.

The step now waits until the page writes its own canonical link, which
every route declares and the shell never carries. Then it reads the page.
A page that never declares one fails by name after 30 seconds. On one
CPU, every page now snapshots.

Advances #2903.

_Committed 2026-11-04 07:53 UTC (3769eba19)._
<!-- assembled-fragment: 2903-www-prerender-wait-for-page.md sha256=df3a5e8ca9801c9819914a3f1f89bb86ed292543d110906fa8b3c74d43fc9947 -->

## Keeper — the whole-collateral forced-sale bridge is removed (#2907)

The keeper carried a second form of the grace default, the health-factor liquidation, the internal-match close and the periodic settlement for the live testnets, whose Diamonds were deployed before the sell-to-need change (#2796) and route only the older whole-collateral calls (PR #2908, PR #2912). At the all-waves fresh deploy every served Diamond carries the sized surface, so that branch is gone.

The keeper no longer reads each Diamond's routing before a close. It always sends the sized call: the sale amount the Diamond's own preview names, with a simulated preview of that exact call still required before anything is sent. The shared route builder previews the sized default directly. A Diamond that lacks the sized calls now fails the preview, and the keeper sends nothing, the same outcome as any other failed preview. The permissionless-steps ledger now names the keeper files that send the default and the liquidation as their evidence, since the shared route builder no longer encodes them.

This merges with the all-waves fresh deploy. Merged earlier, the keeper would stop defaulting and liquidating loans on the testnets that still run pre-#2796 Diamonds.

_Committed 2026-11-04 01:22 UTC (d579879ab)._
<!-- assembled-fragment: 2907-keeper-whole-collateral-removal.md sha256=41ba02e9a3b2dadc26a38db076892defaf0802dcd2ff3c3f8ee0c3a92063251e -->

## Keeper — the interim auto-extend window is removed (#2921)

Until now, the auto-extend pass checked each chain's Diamond for the contract's extension-window view (#2738, contract half #2918). On a Diamond that predated the view, the keeper applied its own interim copy of the window and term rules on the loan clock.

At the all-waves fresh deploy every served Diamond states the window and enforces the term rules itself, so the interim copy and the per-chain loupe read are gone. For each consenting loan the pass reads `getAutoExtendWindow` directly. A window it cannot read leaves that loan for the next run. A term the contract refuses fails at the gas estimate, so nothing is broadcast.

This merges with the all-waves fresh deploy. Merged earlier, a pre-#2918 testnet Diamond would answer the window read with `FunctionDoesNotExist`, and no loan would be extended there.

_Committed 2026-11-04 01:22 UTC (4cd94bdda)._
<!-- assembled-fragment: 2921-keeper-interim-extend-window-removal.md sha256=cf0bee49e4a99e39b9710df4a911e1b82e8182b6f9c47e8a072bea4ba77c8bfa -->

## Keeper — auto-extend always checks funding (PR #3117)

The auto-extend pass now checks, for every loan, that the extension is funded before sending it. It used to ask each Diamond's loupe first whether the funding view existed and skipped the check on a Diamond deployed before it. Every testnet now runs a fresh Diamond that has the view, so that check and its fallback are gone. A loan whose funding cannot be read waits for the next run, as before. The keeper spec also states the funding rule, and drops the note about older testnets without the extension window read, which no longer exist.

Follows PR #2952.

_Committed 2026-11-04 04:42 UTC (bd5c2688c)._
<!-- assembled-fragment: 2952-keeper-extend-funding-always.md sha256=ee56b64db36077ded5cbd58a027bad73c3e4c58bcc995967d9ba5144f490ec4a -->

## Keeper — skips a mirror day whose delivery parts disagree, and recycles what landed (#2961)

A new keeper pass, the delivery-conflict pass, carries out the skip the contracts added for a mirror day whose delivered parts disagree on the day's whole. It runs every 15 minutes on mirror chains, behind its own switch (`REWARD_DELIVERY_CONFLICT_ENABLED`), and ships switched off.

- The keeper finds such days in the indexer's record of the delivery events, and looks at a day again whenever a later part lands on it, since that part may add value to move.
- Operators are alerted as soon as such a day is recorded. The alert says what landed against what the first part stated, and when the skip becomes allowed, which the keeper reads from the contract itself. If the skip waits for Base's broadcast for the day instead, the alert says so. If the keeper could not send the skip (no key, or its sends stopped), the alert says why.
- Once the contract allows it, the keeper skips the day. The day closes unpaid on that mirror, and every later day there moves again. It then moves the value that landed for the day into that mirror's recycling pool, call after call, until nothing is left. An empty draw does not end the work by itself: a draw sees only part of the day's list at a time, so the keeper moves the day's cursor past value already spent and draws again, and value still waiting for its packet's attestation keeps the day in the keeper's work until it moves.
- What was given up (each half the day would have priced, and the recycled commitment released) and what was moved are posted from the transactions' own events, not from the keeper's estimate.
- A day where a side whose claims may already have paid carries recycled funding cannot be skipped. That is reported as an incident for a person and the skip is never retried. The day stays in the keeper's work until that report has been delivered, so a failed post goes out again on the next run. The same holds for a day that opened before its parts disagreed, which stays paid and is reported as the source fault it is.
- Every call is simulated first, at most four a chain a run, and pays no fee. Every read stops at its stage cutoff, so the sends keep their time.

> Caveat: ships disarmed. Arming it is a separate owner decision.
> Caveat: it needs the contract change, so it reaches a chain with the fresh deploy, together with #2828.

(PR #2999)

_Committed 2026-11-04 02:04 UTC (ee30d8d54)._
<!-- assembled-fragment: 2961-keeper-skip-conflicted-days.md sha256=2c1e0102ccb6696ec8a61a85c5e00c3a18c3fbf80178365b2a165ff4e18ba742 -->

## Contracts — reward close-out progress and the grace window in force (PR #3136)

The two permissionless reward close-out calls now say whether they made progress, not only how much VPFI they moved. The forfeited-reward sweep of a loan returns the amount it swept and a progress flag, and the retirement of zero-priced remainders returns its retired count, the commitments it released and a progress flag. A call can move nothing and still advance the settlement (it prepares a legacy slice, stamps or advances an entry's settlement cursor, retires a commitment, or advances its side's cumulative pricing cursor), so the amount alone could not tell a funding wait from real work. A keeper that sent only on value could stall a backlog whose cursor was more than 730 days behind; one that sent every round paid for no-ops. Advances #3012 and #3026 (contracts half; their keeper halves follow).

The flag is measured by the protocol itself, before and after the call, over one set of fields: whether each entry is settled or forfeited, its settlement cursor, its side's pricing cursor, and its legacy-slice domain's phase and cursors. A legacy-slice step can also work inside one day record without moving those cursors. So the step measures that record before and after each page it runs, and the call counts the page only when the record changed. A page that runs and changes nothing (one the record's restoration window still blocks), a step that stops at once, and one a deferred settlement never reaches all count nothing. The same fields are published through a new lens read, `getRewardEntrySettlementProgress`, and a record's mark through `getStagingRecordMark`, the one place that measure is computed. So anyone can see where a forfeited entry's settlement stands. No value moves differently: both calls settle exactly as before.

The reward day-close grace getter now returns the window in force. While governance never set one, `getRewardGraceSeconds` reports the default four hours instead of zero, the same figure the finalization rule and the reporter configuration snapshot already used. The default is now applied in one place. Closes #2681.

These are contract changes, and they reach a chain only through the next fresh deploy. Until then, the live testnet Diamonds keep the old return shapes. So the keeper's reward heartbeat now reads the two close-out results through a narrower shape that decodes both the old and the new result. Its behaviour is unchanged. Reading the new progress flag (simulate, and send only on progress) is the keeper's own follow-up, and it replaces that bridge after the fresh deploy. The protocol console's "not set, so the default applies" wording for the grace row can go once every chain runs this code.


_Committed 2026-11-04 09:47 UTC (d2a860af6)._
<!-- assembled-fragment: 3012-3026-2681-reward-progress-views.md sha256=35608726e7bac966376c44516a4914a4da66d1d6d06427877af60e0c81ce4389 -->

## Keeper — repatriations already on a mirror go home after it moves (PR #3147)

The return-transport pass used to stop driving an authorization as soon as
its mirror was no longer bound to the Base that issued it. That stall was
the keeper's own caution from before #3015. Since #3015, a mirror executes a
recorded instruction, and acknowledges a cancelled one, only toward the
issuing Base. Nothing the mirror's current binding says can redirect it.

The keeper now follows that rule. An instruction the mirror has already
recorded is executed, or its cancellation acknowledged, toward the issuing
Base even after the mirror detached or reattached elsewhere. The same checks
as before still run first: Base must be served, the named Base Diamond must
be the one there, and its return receiver must deliver to it.

A new instruction is still not sent to such a mirror. The mirror records an
instruction only from the Base it is bound to now, so the delivery would be
refused and its CCIP fee spent. The keeper alerts operators instead, since
cancelling the authorization is then their decision. A chain that has become
Canonical holds no instruction to act on and is alerted the same way.

The pass ships unarmed on the keeper machine (`REWARD_RETURN_TRANSPORT_ENABLED`
unset), and the #3015 contract change reaches chains only at the next fresh
deploy. Advances #3015.

_Committed 2026-11-04 12:01 UTC (6888b9d5d)._
<!-- assembled-fragment: 3015-keeper-repatriation-recorded-instructions.md sha256=4fd40784865c86400158aeba2b5ef03ac71c944da6dd3b6171d8053db6365a0b -->

## Thread — a repatriation instruction is paid out only to the chain that issued it (PR #3143)

A mirror chain records each Base-issued repatriation instruction under the full identity of its issuer: the chain the cross-chain transport authenticated it from, and the Base Diamond there. Executing the instruction, which sends the mirror's surplus VPFI home, and acknowledging its cancellation now both go to that issuing chain. Before this change they went to whichever Base the mirror followed at the moment the step ran. A mirror that detached and then bound to a different Base would therefore send an earlier instruction's VPFI to a chain that never authorized it, and leave the issuing Base's authorization charged. Both steps are permissionless, so anyone could trigger that.

The mirror takes on a new instruction only from the Base it is bound to when the instruction arrives. A cancellation is accepted from any Base that issued one, because it can only stop a payment in that Base's own records, and that is how a Base the mirror has left still releases what it reserved. Two Bases at the same address on different chains are now different issuers. Under the old key, the second Base's first instruction would have been dropped as a re-delivery of the first Base's.

The mirror's execute, cancellation-acknowledgment and instruction-read entry points take the issuing chain as a new first argument. The four instruction events carry it as a new indexed field. The keeper's return-transport pass passes it, and it still sends nothing for an authorization whose mirror now follows another Base. That caution is now the keeper's own choice, no longer the only guard. This reaches a chain only at its next fresh deploy.

Closes #3015.

_Committed 2026-11-04 11:29 UTC (dd5dd1014)._
<!-- assembled-fragment: 3015-repatriation-bound-to-issuer.md sha256=230a8c9491e8fe956616deeacb905f1e79688cb914c4d9a445f091a54dc86db7 -->

## Thread — keeper backstop for protected account mode

Protected account mode holds a payout from a vault, and a transfer of a position NFT, for the delay the owner chose, and makes the settings that loosen protection wait the same delay. Releasing a held item and applying a matured change are open to anyone, but nothing made those calls on a schedule. So a payout the owner had waited out could sit in the vault until someone made the call by hand.

A new keeper duty, the protected account pass, now makes them every minute on every chain it serves. It ships switched off, behind its own arming flag. Every minute because each item is due the second its delay ends.

A held payout or transfer goes only when the protocol's own record says it can: still held, past its release time by the chain's clock, the account not locked, and co-signed while the account requires a co-sign. A payout whose destination has left the account's allowed destinations is cancelled by the release itself, and the asset stays in the vault; the report says so apart from a paid one. A payout to a recipient the sanctions screen flags is refused and stays held, and the keeper tries again later. Each paid payout is reported with what the recipient actually received.

A matured change is applied only while the protocol still holds the change its announcement named, at the time it named. That covers a lowered delay, NFT protection or the co-sign requirement switched off, an unlock, an unpin, switching the mode off (which waits while the account still has open payouts or transfers), a new allowed destination that has not expired, an accepted signer addition that has not expired, a signer removal, and a scheduled replacement of the primary wallet that still has its approvals. Every change left waiting is reported with the protocol's reason. The keeper pays only gas and moves no value to itself. Refs #3088, #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision, and the protected account contracts reach a testnet only with the fresh deploy.
> Caveat: at most four calls per kind of work (releases, position transfers, applied changes) per chain are sent each run, so on a busy chain a due item can wait a few runs; each kind keeps its own share, so a long queue of payouts never holds back an unlock or a signer addition; the kinds also take turns going first each run, so on a slow chain none can use the whole run's time every run.
> Caveat: the Telegram lock command and the owner alerts on a lock, a queued payout and a proposed replacement have their own note.

_Committed 2026-11-04 02:41 UTC (c2ca3aad6)._
<!-- assembled-fragment: 3088-keeper-protected-account.md sha256=0d7032e2cd761cd52dd6a077951f8430ad2884d288dc2b18b8ee369d3774531b -->

## Thread — lock a protected vault from Telegram, and owner alerts

An owner whose wallet is linked to the user bot can now lock their protected vault by sending `LOCK` in their private chat with the bot. The bot records the request and the keeper makes the lock, then answers in the same chat: locked; locked again, when the vault was locked before the request (a lock also cancels any unlock or other loosening change asked for since); already locked, when a lock set since the request already did it; protected mode off, no lock permission, or refused with the reason. The lock is made only for an owner who has granted the keeper permission to lock their vault, and it works while the protocol is paused. An owner who sends `LOCK` several times before the answer gets one lock for all of them, so repeated requests cannot hold back another owner's lock. A request's age counts from when the owner sent it, not from when it reached the bot, so a `LOCK` delivered late after an outage is not taken as fresh: one that arrives already more than an hour old is not recorded, and the owner is told to send it again or lock from the app. A request the keeper reaches more than an hour late is answered as expired instead of acted on. The bot takes a `LOCK` only on a chain where a keeper able to make it is working the requests right now; anywhere else it says so and points the owner to the app. While a request waits for the keeper, that account's payouts and position transfers wait too, so a payout never goes out ahead of the lock its owner asked for. The keeper starts locks only in the first half of a run's remaining time, so a stream of lock requests with slow confirmations cannot hold back other owners' releases. A request stores no chat: the answer goes to the chat the wallet is linked to when the keeper answers, so an owner who unlinks Telegram gets no further message, while the lock they asked for is still made.

The keeper also tells the owner of a protected account, on Telegram and Push, when their vault is locked, when a payout from it is queued and when a replacement of the primary wallet is proposed. The replacement alert also says that while one of the owner's signers holds a lock on the vault, only a signer can cancel the replacement, because the owner's own cancel is refused then. A payout alert carries the payout's request code, the same code the app shows, so an owner can spot a payout they did not ask for while there is still time to lock. Once a replacement has retired a vault's original wallet, its alerts go to the wallet that replaced it, never to the retired one, and the payout alert then points to the app rather than to `LOCK`, which locks only the wallets linked to the chat. A payout alert also suggests `LOCK` only where it would work: the keeper is working LOCK requests on that chain, the owner's wallet is linked to a Telegram chat, and the protocol would take the lock from the keeper now (the keeper checks this by simulating the lock, so the owner's grant is read from the contract itself); otherwise it points to the app. Alerts about events more than an hour old are skipped. An alert Telegram or Push could not take for now is sent again on the next run rather than counted as sent, and the alerts run before anything else in the pass so no transaction wait holds them back, taking at most a third of the run's time so a slow channel cannot hold back a lock. Refs #3088, #2984.

> Caveat: both ship disarmed, each behind its own flag, and each runs only while the protected account duty is armed. Arming is a separate owner decision, and the protected account contracts reach a testnet only with the fresh deploy.
> Caveat: a lock from Telegram reaches the chain on the keeper's next run, so it is not instant; an owner who sees the app can lock there directly.

_Committed 2026-11-04 04:13 UTC (3be0782b5)._
<!-- assembled-fragment: 3088-keeper-protected-lock-alerts.md sha256=d89f6e1f7177768cd932210c0de5f639da8fb23f5374d0a69b3274d5c81d318e -->

## Keeper — each protocol upkeep step gets its own send share (PR #3156)

The keeper's protocol upkeep pass runs seven steps on every chain it serves
(expiring buybacks, the loan-to-value tier refresh, the prepay-sale
sanctions sync, the tier push retry, the tier exclusion refresh, the reward
index compaction and the sanctions flag refresh). Until now they shared one
budget of ten sends per chain per run, taken in that order, so a long
backlog in an early step could use all ten and leave the later steps
nothing to send with, run after run.

Each step now has its own share of the run's sends, and the shares add up
to the run's bound. A step that reaches its share stops for this run, the
run's report names it ("step-budget-reached"), and its remaining work waits
for the next run. The other steps keep their sends whatever the first one
found.

The steps that work through a list of candidates (expiring buybacks, the
prepay-sale recipients still to commit, the reward index users to compact)
now start at a different place in that list each run, so a candidate at the
end of a long list is reached instead of being skipped every time.

Nothing about what a step sends, or when it decides a send is due, has
changed; only how many sends each step may make in one run and where it
starts.

Closes #3093. The close-out and return-transport release loops have the
same start-of-list bias; that is tracked in #3155.

_Committed 2026-11-04 14:42 UTC (3a6f8a444)._
<!-- assembled-fragment: 3093-protocol-upkeep-step-shares.md sha256=72252eabc0ddb1f6825a4ccf0eeeb31a6a99e014a4d31735da1a461157002062 -->

## Keeper — tears down expired listings and intents (PR #3134)

Three permissionless teardowns had nothing driving them, so each waited for someone to make the call by hand. A prepay listing nobody filled keeps the borrower position locked, and the vault's approval to the listing conduit live, after its loan's grace window has ended. A lender's sale listing that has expired on a live loan, or still stands after the loan closed, keeps holding the borrower's partial repayment and collateral withdrawal and keeps the seller's position locked. A swap-to-repay intent past its order deadline and the borrower's cancel grace keeps the position locked, keeps the loan out of internal liquidation matching and auto-refinance, and leaves the vault's allowance to the limit-order protocol raised.

A new keeper duty, the expired teardown, backs all three, as the owner decided on #3097: every permissionless step gets a keeper backstop, and each ships switched off. Every hour, on every chain, it reads one window of the active-loan list for prepay listings and intents, and a bounded walk of the open-offer book, starting somewhere new each run, for sale listings. Each is judged at one pinned block against that block's time, from the loan's own deadlines, the chain's intent cancel grace and the sale offer's own expiry. Each due item is simulated on the current state and sent only when the simulation succeeds, at most four per kind per chain per run. Prepay and sale teardowns go first because the protocol allows them while paused; the intent teardown is refused while paused and goes last.

The run line names each teardown from the protocol's own event in its receipt, and reports apart a call that landed without its event being read, an item someone else removed first, and an item the protocol says is not yet due at the current block.

A prepay listing is never touched during its loan's grace window: that window belongs to the grace auto-list duty, which moves a dead or overpriced listing to the floor, so the two never act on one listing. The duty also does not look for a Dutch prepay listing whose auction ended before grace began. The protocol allows that teardown, but the auction's end is recorded only on the listing's executor, which the Diamond does not expose, and the listing frees only the lister's own position, which the lister can cancel at any time.

The duty moves no value and pays only gas. It is armed by its own flag in addition to the master keeper switch, and ships unset. The record of what backs each permissionless step now names this duty for all three teardowns.

Advances #3097: this is the group of its three expired-listing and intent teardowns.

> Caveat: a sale listing whose offer has left the open-offer book while its link to the loan remains is not found by this duty.
> Caveat: a Dutch prepay listing whose auction ended before its loan's grace is left to its lister until grace begins.

_Committed 2026-11-04 08:17 UTC (999573346)._
<!-- assembled-fragment: 3097-expired-teardown.md sha256=53007391df7b25caf17fd3c54cb2862de80e579e1d160d057de380da0f51ba38 -->

## Keeper — position upkeep: daily rental deductions and backstop fills (#3097)

Two permissionless steps on a single position had nothing calling them. The daily NFT-rental deduction moves one elapsed day's fee from the renter's prepayment to the lender and the treasury, and its last day closes a fully used rental as repaid. The backstop fill lends from the treasury-seeded backstop vault to a borrower offer that opted in, once its eligibility time has passed. Without a caller, a lender was paid rent only when the renter repaid, a used-up rental stayed open, and an opted-in offer could expire unfilled. The owner has decided that every such step gets a keeper backstop.

A new hourly keeper duty, position upkeep, takes both. For rentals it reads one window of the active-loan list a run and deducts a day only where the loan's own record shows one due. It never charges past the agreed term, and it never touches a loan whose deduction clock is behind its start. That is a legacy-record case where the protocol would charge a day without counting it. For the backstop it finds opted-in offers from the indexer's record of opt-ins and decides each from the offer's own on-chain record. The protocol decides the rest: its switches, the collateral's liquidity and oracle coverage, the borrower's sanctions screen, and the backstop's caps.

Every call is simulated first and sent only if the simulation succeeds. Each step has its own share of the run's sends. The run's report names every deduction with the fee the chain recorded and, from the loan's status afterwards, whether it closed the rental, and every fill with the loan it opened and the amount lent. The keeper pays only gas and receives nothing in either step.

Both steps ship switched off. The rental deduction arms with the pass's own flag. The backstop fill needs a second flag of its own, because each fill commits treasury capital to a new loan and counts against the keeper's free-tier service capacity. Whether the keeper key should do that is a separate owner decision.

The two holder consolidations on #3097 are not covered, by owner decision. The protocol accepts them only from the current position holder, so a keeper call could never succeed, and the owner chose to keep them the holder's own step rather than change the contract. They are now recorded as user-driven, not as gaps. The connected app does not offer either call today, so a holder who wants one makes it directly.

Advances #3097.

> Caveat: the holder consolidations (`consolidateCollateralToHolder`, `consolidatePrincipalToHolder`) are user-driven by owner decision (2026-11-04) and have no app button yet.
> Caveat: the deduction itself checks neither the agreed term nor that the loan's deduction clock is at or after its start; the keeper declines both cases, but nothing stops another caller.

_Committed 2026-11-04 09:21 UTC (64e56bbb0)._
<!-- assembled-fragment: 3097-position-upkeep.md sha256=8dc1000340da1f05a881039e9bdb35c6d5be451869e781241204a4f6ab5ba164 -->

## Keeper — moves held reward claim days on to payment

A reward claim day that one call could not settle is held in a staging record, alone or inside a claimant's claim domain, and from then on only permissionless calls move it: preparing it, reserving what it pays once its day is covered, resolving it page by page, and stepping a legacy slice until it is consumed. Nothing made those calls, so a claimant waited for whoever happened to make them, a record that had started resolving (which has no deadline) never paid out, and a contested batch's priority window lapsed with nobody registered. The record of what backs each permissionless step listed these seven steps as gaps.

A new keeper duty, the reward staging upkeep, backs them, as the owner decided on #3097: every permissionless step gets a keeper backstop, and each ships switched off. Every hour, on every chain, it finds the open records, domains and legacy slices from the indexer's record of staging events and decides each from its own state on chain. It takes at most three pages per subject and a bounded number of subjects per run. A page that changes nothing the keeper reads leaves that subject alone for a day, since coverage depends on sources outside the record. It registers a record for a contested batch's priority window only when that makes it the oldest registrant, and uses the priority only when the next preparation would stage something.

Unwinding a record or domain that is past its deadline and cannot be covered, or that the protocol finds stale, has its own switch. An unwind returns exactly what the record held to where it came from; it is never a payout, and a record that has started resolving is never unwound. While the unwind switch is off, the duty names each unwind it left.

The keeper moves nothing of its own and receives nothing: every payout is the record's own, made by the protocol from storage. A claim payout the sanctions screen would hold is left to the sanctions-hold duty. Both switches ship unset.

Advances #3097: this is the group of its seven reward-staging steps.

> Caveat: the duty measures progress by re-reading each subject's state, because the staging entries return no progress flag on the live Diamonds.

_Committed 2026-11-04 11:21 UTC (2d9739a62)._
<!-- assembled-fragment: 3097-reward-staging-upkeep.md sha256=0e3b521a40408f3369493e36b8e54d6c826695f6b442b4cefdd35f410850bc91 -->

## Thread — Three more protocol upkeep steps: tier exclusion, reward index, sanctions registry

The keeper's hourly protocol upkeep pass gains three steps, one for each of
three permissionless calls that nothing made on a schedule. Each ships
disarmed behind its own flag, needs the upkeep pass armed as well, and has no
cadence of its own. Each sends only when the chain's own reads show the call
would change something and a simulation shows it would succeed. None pays a
fee or moves value to the keeper. This advances #3097.

The tier-exclusion refresh pages through every loan the protocol has created,
of any status. It previews the refresh for a whole page and sends it only for
the loans whose fee-tier exclusion the preview shows would change. This is
what brings into line a loan that was already closed when the exclusion rule
was installed, since such a loan passes none of the events that re-derive it.

The reward-entry index compaction goes through the chain's loan parties a
slice at a time. For each party with reward entries it previews the
compaction and sends it only where the preview would retire a settled entry.
Entries settled by an expiry, a forfeit or a zero-value retirement otherwise
stay in a wallet's index until its own claim, which keeps that wallet's claim
and Claim Center countdown walking them.

For the sanctions-registry refresh, the issue had assumed the work was
already done by the reward sanctions observer and the prepay-sale sync. It
is only partly done. The observer writes the same registry entry, but only
for loan parties, only while its own flag arms it, and never while the
protocol is paused. The sale sync records a flagged recipient of a live
listing and never clears one. So the step re-screens every vault owner,
position recipient, protected-payout recipient, rewarded keeper and refreshed
wallet the chain's events name. It calls the refresh only where the oracle's
authoritative answer and the registry disagree. An address the oracle cannot
answer for is counted as not screened, never as clean.

The three ledger rows for these calls now name the upkeep pass and their
flags in place of the open gap.

> Caveat: a wallet the protocol has never dealt with, such as a first-time payee chosen by a vault owner, cannot be screened in advance; through an oracle outage it passes unless an earlier read recorded it, as the protocol's outage rule states.
> Caveat: a reward-entry index longer than one compaction examines, whose examined positions hold nothing settled, cannot be compacted by any bounded call; the run's line names such a wallet instead of reporting it clean.
> Caveat: the three steps share the pass's ten sends per chain per run and its one run window with the four steps before them.

_Committed 2026-11-04 07:46 UTC (9a538ee73)._
<!-- assembled-fragment: 3097-upkeep-steps.md sha256=6ac290d247469e0c56ab5d693a49dd0a22d5ba49e357353edc42254f877bb129 -->

## Remit acknowledgements get their own keeper switch (PR #3129)

The keeper's acknowledgement pass, which completes each reward-budget
remittance on Base once its delivery lands on the mirror, used to share its
switch with the pass that sends new remittances. Turning remittances off
therefore stopped the acknowledgements too. That broke the pre-redeploy
drain in the deployment runbook, which needs exactly that combination: stop
new remittances, and keep acknowledging the ones already in flight until
none is pending.

The acknowledgement pass now has its own switch, `REWARD_REMIT_ACK_ENABLED`.
Like every keeper switch it ships off. A keeper that already sends
remittances must have it turned on in the same change, or its remittances
stay pending. The runbook's drain step now names the switch it leaves on,
and the incident and restore procedures name both switches.

_Committed 2026-11-04 08:46 UTC (7addb2a2b)._
<!-- assembled-fragment: 3100-remit-ack-own-flag.md sha256=e2dd64d94bff5e650426809c19c6c482b0f7c719f62a0639060a2e81ffebd9d1 -->

## Keeper — keeps the testnet sanctions stand-in fresh (PR #3118)

On test networks, the delisting timelocks check a clearance answer from a stand-in for RedStone's Sanctions Oracle on BNB testnet. They refuse an answer whose list is older than seven days. Until now only the admin could refresh the stand-in, by hand, and on the 2026-11-04 deploy it had been stale for about fifteen days without anyone noticing. Automated delisting on the testnets had been closed the whole time.

The stand-in now has a refresher role. The admin names one address, the keeper, which may re-publish the admin's list unchanged and do nothing else. It can never flag or clear an address. Every publication now says on-chain who made it, the admin or the refresher.

A new hourly keeper duty reads the stand-in the attestor actually reads, and the smallest age limit among the timelocks that take their answers from it. A day before that limit, it refreshes the stand-in. The operators' chat is told when the stand-in is past the limit, when the keeper is not its named refresher, when a refresh is refused, and when a due refresh could not be sent for a reason that will recur, which it says before delisting closes. The duty refuses every mainnet and ships switched off.

The wiring script now names the keeper as the refresher when it is given one. It no longer reuses a stand-in built before the role. The stand-in already on BNB testnet predates the role, so it still has to be replaced, along with the attestor that reads it, before the keeper can take over. Until then it is refreshed by hand.

Closes #3113.

> Caveat: the current BNB testnet stand-in has no refresher role; the keeper can refresh only a stand-in deployed from this change.

_Committed 2026-11-04 05:26 UTC (a3d56479b)._
<!-- assembled-fragment: 3113-keeper-standin-refresh.md sha256=543ad2a446db5447d2f0e262abcdef956901332c72a1b24597d635a33c109ed5 -->

## Sanctions — replacing the testnet stand-in carries its flags over (PR #3125)

The keeper can refresh only a stand-in that names it as refresher, and the one on BNB testnet was built before that role existed. An attestor reads one oracle for good, so replacing the stand-in also means a new attestor, and the clearance route on BNB, Base Sepolia and Arbitrum Sepolia has to move to it.

The clearance wiring script can now make that move when it is told which attestor it replaces. It re-points only a channel handler or peer that is that attestor, and anything else still stops the run. Before the new attestor answers anything, the script copies every account the old stand-in flags onto the new one. It rebuilds the list from the old stand-in's own records, refuses if those records don't reach back to its deployment, and checks each account against the old stand-in. Until each timelock's own chain is re-pointed, that timelock gets no new answers, but answers it already holds still count. Those were read from the old stand-in, which keeps the same flags. Re-pointing voids them, and the delister asks again. Running the script again after the rotation carries nothing, so it never re-flags an account the admin has cleared since.

Refs #3113.

_Committed 2026-11-04 06:03 UTC (2712313a3)._
<!-- assembled-fragment: 3113-standin-rotation.md sha256=7e847b43879ea50dd2ade42298e0f4d78773f1eeb9fa539d9aaa87b532e3bbe8 -->

## Thread — Keeper and agent deploys no longer wait for the indexer's migrations

The keeper's and agent's deploys used to check that the shared database
had every migration their build was written against, wait up to ten
minutes for the indexer's deploy to apply any that were missing, and
refuse to publish if the wait ran out. On this account Cloudflare Workers
Builds runs one build at a time. So on any merge that added a migration,
the waiting agent or keeper build held the only build slot while the
indexer build that would apply the migration sat queued behind it. The
wait timed out every time and the Worker stayed on its previous version.
That is what happened to the agent build for a68b4baa8. A longer wait
would only have blocked the indexer for longer.

Those two deploys now read the migration record once, log a warning that
names any migration still pending (or says the record could not be read,
so the state is unknown), and publish anyway. Safety does not come from
the deploy order. It comes from three guards that were already in place.
Every scheduled runner of the shared database declines its ticks by name
until every migration in its build is recorded, and resumes by itself
once the indexer's deploy applies them. Every migration must be additive,
which CI enforces. Every HTTP route must tolerate the previous schema.

The indexer is still the only deploy that applies migrations, and it
still refuses to publish until it has verified them, so the old race
between three appliers does not come back. A manual release that carries
a migration should still deploy the indexer first, so that the window in
which the agent's scheduled work declines stays empty.

Closes #3115.

> Caveat: between a keeper or agent publish and the indexer's apply, that Worker's scheduled work is paused, not run. The deploy log says so by name.

_Committed 2026-11-04 07:55 UTC (e86a40517)._
<!-- assembled-fragment: 3115-shared-d1-verify-no-wait.md sha256=6571ca9cc0f3279dd65b4e969603ff20eaeceb72098a23f7a41a1004e7bc906b -->

## Keeper — one ops alert when the signing key cannot sign (PR #3154)

When the keeper machine's `KEEPER_PRIVATE_KEY` is unset or unusable, the pass
gate disarms every pass that sends a transaction: the liquidations and
defaults, the reward passes, and the on-chain observers such as the sanctions
hold, the horizon heartbeat and the testnet stand-in refresh. The two senders
outside that gate check the key themselves, so the keeper sends nothing at
all. The watchers that sign nothing (the health-factor and pre-grace user
notices, and the liquidity-confidence counter) keep running. Until now each
disarmed pass said so only in its own journal line, so operators found out
late.

Each tick now checks the key once for the whole machine. While
`KEEPER_ENABLED` is on and the key cannot sign, it posts one ops-channel
alert, repeated every six hours until the key signs again. The alert names
the kind of problem (unset, wrong length, not hexadecimal, not a valid key),
never the value. It reads the same answer the pass gate does, so a pass that
reads as armed can always sign, and the passes stay in one mode rather than
each gaining a key-less fallback.

Nothing is posted while `KEEPER_ENABLED` is off, since the keeper is then
switched off on purpose. Once the key signs again, or the keeper is switched off, the
alert's record is cleared, so a recurrence alerts at once.

Closes #3119.

_Committed 2026-11-04 14:44 UTC (9be2b8ae0)._
<!-- assembled-fragment: 3119-keeper-signing-key-alert.md sha256=f2194a99948eb8984ec2f52be3eacbd363001cc13bf68a261652349b9919dda2 -->

## Contracts — the daily rental deduction charges only an agreed day (PR #3160)

The daily rental deduction is permissionless: anyone may call it once a day
has passed since the last deduction, and it moves one day's fee from the
renter's prepayment to the lender and the treasury. It did not check that the
day was one the rental's terms provide. A renter who prepaid the whole term
with a rental partial, and then closed after maturity, could be charged extra
rental days by any caller in the meantime, although the platform's rule is
that time past maturity is the late fee, drawn from the buffer at close, and
never an extra rental day.

It now refuses once every agreed day is paid, with an error naming the loan.
It also refuses a rental whose deduction clock reads earlier than the
rental's start. On such a record the days-used count stays at zero however
many days are charged, so each call would charge again; the refusal names
the clock and the start it was compared with. Neither case arises from a
loan opened by the current code, which sets the clock to the start, but the
deduction no longer relies on that.

Both checks read the platform's one rule for counting rental days used, the
same rule repayment and the obligation handover settle by. The last agreed
day is still charged and still closes the rental.

The keeper already declined both cases before sending (#3097) and keeps
those checks as a free pre-filter. This reaches a chain at the next fresh
deploy or facet refresh of RepayPeriodicFacet.

Before this change, a rental prepaid for its whole term by a rental partial
was closed by the first deduction after maturity, at the cost of that extra
day. That accidental close is gone: such a rental now closes when its
borrower repays, or defaults after grace like any other open loan. The owner
decided to keep it that way rather than add a permissionless close at
maturity (#3159).

Closes #3132.

_Committed 2026-11-04 15:48 UTC (4d48e6c41)._
<!-- assembled-fragment: 3132-auto-deduct-agreed-days.md sha256=a4a74faef7c0c1bd3f28b7970c8ee554c1e4e8a0f2814a8adee443b74933c259 -->

## Thread — The mesh watcher takes its cadence from its schedule alone (#3144)

The mesh watcher reads one chain per run, in rotation. Which chain a run reads
used to depend on two numbers that had to agree: the schedule, and a separate
"seconds between runs" setting. If they ever disagreed, the rotation could stop
moving without any error. With the schedule at every fifteen minutes and the
setting still at five, every run landed on the same chain, and the other two
went unwatched. This was seen once on 2026-11-04, when one run fired on the old
fifteen-minute schedule while the new one was taking effect. It was harmless
then because it happened only once.

The separate setting is gone. Each run now works out its step from its own
schedule, so there is only one number. The rotation accepts schedules of every
minute, or every N minutes where N divides an hour evenly, because only those
fire at even spacing. Any other schedule makes the run fail and raise an alert
naming the schedule, instead of quietly watching some chains and never others.

A manual run without a chain id still picks a chain from the clock, in
five-minute slots. It only chooses which chain to show and never moves the
alert windows.

> Caveat: The live Worker still carries the retired setting as a dashboard
> variable, because deploys keep dashboard variables. Nothing reads it any
> more. Delete it from the dashboard when convenient.

Closes #3144.

_Committed 2026-11-04 13:03 UTC (876c2e4ee)._
<!-- assembled-fragment: 3144-mesh-watcher-cron-cadence.md sha256=73f2a5d733de464d34a5a25ea48682224ef7c404ebe969a59c08aac036a11498 -->

## Thread — Fresh all-waves deploy of Base Sepolia and Arbitrum Sepolia

Base Sepolia and Arbitrum Sepolia now run fresh Diamonds built from main at #3105, the first deploy that carries every wave merged since the October testnet deploys. Base Sepolia's Diamond is 0x63816B149266C9dBFB7683dfd02D851915238049 from block 54072444. Arbitrum Sepolia's is 0x0ae80D88a867597CfB69A158f8f5b06b090ECE14 from block 325782709. Each has 109 facets on its loupe plus the diamond-cut facet. Both went through every deploy phase in order: contracts, CCIP wiring, the testnet mock swap rig, configure, the first unpause (launch, every readiness check met) and verify. Both remain owned by the admin key; there was no governance handover, as on every testnet. The previous Diamonds are archived in the committed manifest and stay on-chain, settleable directly.

Each chain carries exactly one CCIP lane, to the other. Both VPFI pools rate-limit that lane in both directions at a capacity of 50,000 VPFI refilling at 5.8 VPFI a second. Base expects reward reports from itself and Arbitrum Sepolia only. The reward custody holder is activated on both chains, with every ledger row at zero because the Diamonds are new, so no VPFI was moved or funded to activate it. The keeper wallet 0xD9257B636E17D5714DD54F260c9F7EB81349E49B holds the keeper role on both.

The owner asked for the old testnet settings back and for rewards to be relaunched. Each setting was read from the archived Diamond and written onto the new one: service capacity on with its deposit escrow bound, the 2% arming fee, the solver and keeper capacity curves, auto-extend, lender intents, and the priority-routing perk priced at 2 VPFI a credit. Base also gets fee entitlement, a 12-hour reward grace and the keeper wallet as remittance keeper. A read of every argument-free setting afterwards matched the old Diamonds. The one deliberate difference is the interaction-rewards day-zero anchor: midnight UTC on 4 November 2026, the same on both chains, so the relaunch starts at day zero instead of resuming the old schedule. The anchor can be set only once. The interaction pool is the 69 million VPFI allocation on each chain; nothing was transferred to fund it.

BNB testnet was not redeployed; the owner chose to deploy it later. Its live Diamond is still 0xfa7685Eb0160f8998f70F196d64Be223ce120bC2, and its lanes still point at the retired Base stack. An interrupted attempt left an unpublished Diamond on BNB testnet at 0x38b0604875E7BdA2eBff8fC1FC7247681313a5f2. It holds nothing, is in no artifact, and is not in the archive manifest because it was never live. Base's lane list in the operator environment was narrowed to Arbitrum Sepolia for this deploy; restore BNB testnet to it when BNB is deployed.

The first Arbitrum attempt failed on-chain partway through building the Diamond. Forge sent one diamond-cut transaction with the simulation's gas figure of about 46,000 instead of a fresh estimate near 1.9 million, and it ran out of gas. That half-built Diamond, 0xA6106C6399De12936CB6ca1A1A11fE346CEA21E6, holds nothing; it is recorded in the archive manifest because it is on-chain. The deployment source stamps read "dirty" only because the archived artifact moves were uncommitted at deploy time; the contract source was main at #3105.

> Caveat: BNB testnet still runs the October build and has no lane to the new Base Diamond, so cross-chain rewards and VPFI transfers reach Arbitrum Sepolia only until BNB is redeployed.
> Caveat: the sibling keeper-bot repository received regenerated ABIs from this sync and has not been committed there.

_Committed 2026-11-04 01:05 UTC (3165bbc85)._
<!-- assembled-fragment: deploy-allwaves-base-arb-testnets.md sha256=a826e0cb1f50be16dfa4bcc425fd1a1e046b34f1439b538b3561b440cca69061 -->

## Thread — Fresh all-waves deploy of BNB testnet, and the sanctions clearance route

BNB testnet now runs a fresh Diamond built from the same main as the Base Sepolia and Arbitrum Sepolia deploys: 0xfe2A3DE4DBa8F7f20ce52a0b28A56df31771341E from block 140668803, with 109 facets on its loupe plus the diamond-cut facet. It went through every phase: contracts, CCIP wiring to Base, the PancakeSwap adapter, the testnet mock rig, configure, reward custody activation (every ledger row zero, so no VPFI moved), the first unpause and verify. The previous BNB Diamond is archived in the manifest and stays on-chain. It stays owned by the admin key, with no handover.

Base Sepolia now carries lanes to both mirrors again. Its expected reward sources are Base, Arbitrum Sepolia and BNB testnet, and its mirror map names the new BNB Diamond. BNB testnet was added after the rewards relaunch anchor (midnight UTC on 4 November 2026), so BNB's reward days count from when it was listed. Every VPFI pool lane (Base to Arbitrum, Base to BNB, and back) is rate-limited both ways at a capacity of 50,000 VPFI refilling at 5.8 VPFI a second.

BNB's operating settings were read from its archived Diamond and restored, as on the other two chains: service capacity with its escrow, the 2% arming fee, both capacity curves, auto-extend, lender intents, the priority-routing perk at 2 VPFI a credit, and the same rewards anchor. The keeper wallet holds the keeper role. A read of every argument-free setting afterwards matched the old BNB Diamond except the anchor, which is new by design.

The sanctions delisting route was rewired onto the new messengers. BNB testnet hosts a new clearance attestor, 0x4A0B221D53592D0cB350e8428DD92835f07cD386, reading the same testnet stand-in as before, so its flags carry over. The existing delisting timelocks on Base Sepolia and Arbitrum Sepolia now name that attestor as their clearance source. No list, proposer, delay or Safe power changed. The stand-in had last been marked updated on 20 October 2026, past the timelocks' seven-day maximum age, so the admin marked it updated after the rewiring. It must be marked again within every seven days, or the timelocks treat it as stale and close the automated delisting route.

The Base Sepolia artifact's reward grace now reads 43,200 seconds, the value on-chain. The first record carried 14,400 because it was written before the setting was restored. The interrupted October-build attempt left an unpublished, empty Diamond on BNB testnet at 0x38b0604875E7BdA2eBff8fC1FC7247681313a5f2, which is in no artifact. The lessons from all three deploys, and a plan to fold them into the scripts, are in the fresh-deploy hardening plan under docs/DesignsAndPlans.

> Caveat: the testnet stand-in is fresh only for seven days after each update; the automated delisting route closes whenever the admin lets it lapse.

_Committed 2026-11-04 01:55 UTC (72dbd3bca)._
<!-- assembled-fragment: deploy-allwaves-bnb-testnet.md sha256=51fde0e419688c78cea032028f47b4c654c9e8b90e37176cd97dc22748e3e23e -->
