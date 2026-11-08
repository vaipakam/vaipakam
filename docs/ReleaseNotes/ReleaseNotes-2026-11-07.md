# Release Notes — 2026-11-07

The day's largest change is to vault code. Every user vault now takes its code from one central, delayed registry (the VaultBeacon). A code change waits three days and then reaches every vault that has not pinned a version. An owner may still pin a version with their own signature, and governance can revoke a bad version. This replaced the mandatory-version rule that shipped earlier the same day, so the "vault below the mandatory version" entry below describes behaviour that the VaultBeacon entry retires. Both reach a chain only by a fresh deploy.

The rest of the day covers:
- **Security hardening:** recovering from a compromised app build, reproducible builds, a check on the build being served, and approval for site deploys.
- **Governance and keeper work:** a reader for queued governance changes, event alerts, sanctions-adder bounds, a private submission route for keeper transactions, fairer matching across wallets, and a keeper pass that applies due vault-beacon changes.
- **Offer-book bounds:** a $10 floor on an offer's value, and a cap on how many offers one wallet may keep open.
- **The new app:** a list of your loan positions, and one loan's own page.
- **Test tooling:** the mainnet operations baseline, and two fixes that bring the live refinance drive in line with the app's payoff-permit flow.

## Thread — End-to-end spec for seller claims; test markers for Repay all

The seller's claim on Claims (#1209) is driven through a real sale: a loan
runs ten days, the lender lists it, a third wallet buys it, the borrower
repays, and the seller withdraws from Claims. The spec requires one
withdrawal event for that loan and seller, the same amount in the seller's
wallet, and nothing left waiting.

To make those checks independent of wording, the batch card and the
seller-claims card now publish where they stand as page attributes: the
batch card's stage, each loan's plan and outcome; the seller-claims list's
discovery state and each row's withdrawal verdict. One thing a user sees
changes: "Withdrawn to your wallet" is now stated by the seller-claims card
for each loan withdrawn this session, rather than inside the loan's row.
A withdrawal that empties an ended loan's claim removes its row on the next
read, which took the confirmation with it; the card now keeps it. The test indexer now serves the seller-claim activity kinds from
the chain's own logs, filed by the indexer's own actor rule.

Advances #126 and #1209.

> Caveat: "Repay all" (#126) has no end-to-end spec yet. The only way a
> borrower gets two loans from one offer is a ranged request filled in
> slices, and that seed is held on a contract issue found while writing
> the spec; the spec lands with the fix. The live drive on Base Sepolia
> for seller claims is still to run.

_Committed 2026-11-07 23:04 UTC (ce7e189d0)._
<!-- assembled-fragment: 126-1209-batch-seller-e2e.md sha256=eabe98f649146076fe99cd2f7faf39efcfed1f38ae556b9c26925459d692045a -->

## A vault below the mandatory version receives every close-out, and sends nothing out until upgraded

When the protocol makes a newer vault version mandatory, a vault below it was refused for every loan step until it was upgraded, deliveries into it included. A renter's repayment or early close, and the default of an overdue rental, all deposit the lender's share into the lender's vault, so each of them reverted. Anyone may upgrade an ordinary vault, but only its owner may upgrade a PINNED one. A lender's pin could therefore stop the renter from closing early and getting back the unused prepay, leaving the rental to end only at full term and full rent. The mirror case was blocked too: a borrower whose own vault was behind could stop their loan's default or liquidation.

The owner decided on 2026-11-05 (#3178) that the version check guards what LEAVES a vault, never what a close-out pays into it:
- **Deliveries land whatever the vault's version.** Every close-out delivery resolves the recipient's vault as a receiver, so a counterparty's repayment, early close, refinance, sale settlement, default, liquidation, internal match or sanctions freeze completes and the share lands in the recipient's vault. The early close's two lender legs now resolve the lender's vault this way as well. For the ERC-20 leg this also means a flagged lender can no longer block the borrower's early close: the share is locked in the lender's vault and announced, as on every other close-out (part of #1124).
- **Nothing leaves on the owner's behalf until the upgrade, under one rule.** The owner's own steps on the vault are refused: their claim from their own vault, a withdrawal, the pause escape, a payout release, a deposit and a new position. A pinned vault has no exception any more; before, it could still withdraw and escape on its pinned code. An order the vault would sign for its owner reads as unsigned at fill time: the swap-to-repay order (the Diamond's own validator) and a parallel-sale listing (the collateral-listing executor asks the Diamond). Neither can be placed on such a vault, and both are refused again at the moment they would fill (the Diamond's fill-time hooks), because a marketplace may skip the signature check for an order it validated earlier.
- **Protocol close-outs paying the counterparty stay open by design.** A protocol move out of the vault to pay the other party is not stopped by that vault's own version: collateral on a default or liquidation, a repayment's settlement, a rental's prepayment at its close, a position holder's claim paid out of another party's vault, and a loan-keyed collateral-sale listing. So neither party's old vault can trap the other.

A lender below the mandatory version still cannot post a new offer, and an offer of theirs already on the book is refused at acceptance with a named reason that the pre-sign preview reports. To stay within the contract size limit, the rental early close's two prepay legs now run through one host function instead of inline.

Funds: no amount changes and nothing is held anywhere new. Each share goes where it always went, the recipient's own vault, and simply cannot leave it until that vault is upgraded. Deliveries keep their existing events and measured amounts.

This changes contract code, including the collateral-listing executor (its own upgradeable contract), so it reaches a chain through a fresh deploy, or through the all-facets refresh together with the executor's upgrade. Closes #3178.

_Committed 2026-11-07 01:15 UTC (18040b2c9)._
<!-- assembled-fragment: 3178-delivery-never-waits-on-recipient-vault-version.md sha256=1cb3a1234bb517273dda619c8424d0cf2f4e899b5a606a67f1cc6e2a038c12e5 -->

## Thread — the next app shows one loan on its own page (PR #3294)

Each loan in the next app now has its own page, opened from Home or Positions. It leads with the loan's status in words, then your role in it: the side your wallet holds now, read from the position tokens, or that you hold neither and are viewing. A deadline that needs you is worded for your side, and once the grace period is over the page says anyone may now start the default, only when the protocol says so.

The page lists the loan's dates from the protocol's loan clock (the due date it opened with, any time credited while the protocol was paused, the due date and the end of the grace period), its terms as they stand now (the protocol keeps no record of the amount first lent, so the principal is the amount still owed), its health, and where its collateral is held. A figure that could not be read is shown as unknown, never guessed or computed; a loan with an unpriced leg has no price-based health reading, and says so. Where periodic interest settlement is switched off, the page says no collateral is sold at a checkpoint. A loan whose collateral has no price carries a warning that a default hands the lender the collateral itself.

The page is read-only for now and says so; repaying, adding or taking back collateral and the other actions come in later updates.

One small fix rides along: when the Full fee tariff is chosen on a request or an offer, the suggested ceiling the form fills in is now shown in every digit, because the reader authorizes it exactly as written.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-VIEW. Epic #3180.

_Committed 2026-11-07 23:05 UTC (f8f88b099)._
<!-- assembled-fragment: 3180-alpha05-position-page.md sha256=cc8ee1810786bfede8a9eb702a3ab427b8c1717a9836d40f56d9c5fdbf649f49 -->

## Thread — the next app lists your loan positions (PR #3261)

The next app now has a Positions page. It lists the loans the connected wallet lent or borrowed in on its network, read from the position tokens the wallet holds, so a position that was transferred away leaves the list. Payouts ready to collect come first and point at Claims, then live loans with the most urgent deadline first (side, terms, due date, what happens if it is missed, and the health factor), then ended loans with their status in words: repaid, defaulted, settled or closed by a match.

A choice of All, Lent or Borrowed narrows the three lists at once. The page says "nothing yet" only when every read completed, and says so when a list could not be read in full. Each row opens its loan; the page itself signs nothing and offers no action, since whether an action is open is decided on the loan's own page from the protocol's verdict.

Home and Positions now read the same inventory through one shared reader, so the two pages never disagree about what the wallet holds.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITIONS-LIST. Epic #3180.

_Committed 2026-11-07 12:37 UTC (4b7664dfb)._
<!-- assembled-fragment: 3180-alpha05-positions-list.md sha256=45cb22e3be7b3cc06de40c70fe44471abb027ab0d3509b2b491190074d02a394 -->

## Vault code — one central, delayed version registry (VaultBeacon)

Every user vault now runs code chosen by one place, the new VaultBeacon contract, instead of each vault carrying its own upgradeable pointer. Each vault is a beacon proxy that asks the beacon which code to run on every call: the version its owner pinned while that version is not revoked, otherwise the current version. One governance change therefore reaches every unpinned vault at once, and no vault can be left on old code because nobody upgraded it. The per-vault upgrade, the mandatory vault version and every rule built on it (#3178) are removed.

The beacon is a separate contract, owned by the Timelock and not upgradeable, so no part of the Diamond can change which code a vault runs. Registering a version, making one current and revoking one are Timelock actions, and making a version current or revoking one also waits a three-day delay the beacon enforces itself, so owners can see a change coming and pin before it lands. The Pauser Safe may cancel a pending change, and, only while the protocol is paused, revoke a version onto code already registered. A contract that does not report the vault's storage-layout identity cannot be registered.

Pins moved to the beacon. Pinning, re-pinning and unpinning carry the vault owner's own signature, which the beacon checks against the owner wallet the vault recorded when it was created, and wait the vault's pin delay. Protected mode raises that delay through a path capped at two days, below the code delay, so a pin asked for as soon as a code change is proposed always lands first; a pending pin change can be cancelled, and none is accepted while the account is locked. Each vault call now pays a beacon lookup, about 17,000 gas cold.

Stated gaps: until #3205, an account whose primary wallet was replaced cannot change its pin (testnets only); the app's vault page for versions and pins is #3281; and the keeper pass that applies matured pin and code changes is #3282. Fresh deploy only. The design and its build notes are in `docs/DesignsAndPlans/VaultCentralImplementationDesign.md`.

Closes #3204.

> Caveat: a replaced protected account cannot change its vault pin until #3205 records replacements in the vault.
> Caveat: matured beacon changes wait for someone to execute them until the keeper pass (#3282) is armed.

_Committed 2026-11-07 12:30 UTC (24a4a6aa2)._
<!-- assembled-fragment: 3204-vault-beacon.md sha256=b7b91688a6ae7afe1f6889f414df5719550d0839de9a1fdb746b1fbe7e9c6fbd -->

## Thread — Recovering from a compromised app build (PR #3271)

A service worker keeps running in a visitor's browser after the page that installed it is gone. If a bad build of the connected app, or a script injected into a page, ever registered one, it could go on answering requests after the genuine build was restored. Every load of a production build of the app now removes any service-worker registration on its origin that is not the app's own worker, before it registers its own. One registration that refuses to go does not stop the others from being removed.

That only helps once the genuine page runs. A foreign worker that answers page loads itself would keep the genuine page from ever loading, so the incident runbook gains a section for the case where our own app or domain serves code we did not ship. It covers how to detect it, how to roll the Worker back and stop the bad commit redeploying, the emergency header that clears what a bad build left in browsers (and what that costs visitors), what to tell users about approvals and signatures, and how to confirm the clean build is back. Until now the runbook only covered clones on other domains.

The runbook's domain-hygiene item now records the measured state of the canonical domains: DNSSEC, CAA records and HSTS are not yet in place. Turning them on is an owner decision pending on #3236, as are the automatic served-build check and the mainnet deploy gate.

Advances #3236.

> Caveat: the removal runs only when the genuine page loads; the emergency header in the runbook is the lever for a worker that intercepts page loads, and whether every browser honours it on the worker's update fetch is to be checked during an incident, as the runbook says.

_Committed 2026-11-07 01:23 UTC (ed2324726)._
<!-- assembled-fragment: 3236-compromised-build-recovery.md sha256=ec49d50dc259080dbcf3595af215f5053a02c692e6c0a89122f75a730c71cd64 -->

### Rebuilding a commit now gives the same site files (#3236)

The connected app, the new app (alpha05) and the marketing site used to stamp the moment of the build into their files: the bundle, the service worker, the sitemap and robots.txt. Two builds of the same commit therefore never matched, so there was no way to check that the site being served is the site a commit produces.

Each build now stamps the time of the commit it was built from (or `SOURCE_DATE_EPOCH`, when set). Two builds of one commit with the same build variables now produce byte-identical files; this was checked by building each of the three sites twice (for the marketing site, without its prerender pass). A build that cannot read its commit falls back to the clock and says so in its log. One exception remains on the marketing site: its deploy reads the protocol configuration the indexer publishes while it builds, and writes those figures into its prerendered pages and its `llms` documents, so only its bundled code can be compared with a rebuild.

The Help page and diagnostics still show this time beside the commit, which now means when that commit was made, not when the bundle was assembled. The sitemap's last-modified date is the commit's date.

This is the first step of an automatic served-build check: a scheduled job can rebuild the deployed commit and compare it with what the custom domain serves. The incident runbook's Detect step says when a rebuild comparison is valid.

_Committed 2026-11-07 02:26 UTC (ea0c0d46a)._
<!-- assembled-fragment: 3236-reproducible-builds.md sha256=07c9c5f3a78123c546f9213a3ba771b810e0884d3b5930c8e012487864a0309a -->

### A scheduled check that each site serves what its commit builds (#3236)

Every six hours a new check rebuilds the commit that each site's live deployment is stamped with (the connected app, the new app alpha05 and the marketing site) and compares what visitors receive with that build. It fetches every file the build writes from the custom domain and from the `workers.dev` address and compares their digests, and it compares the security headers the site's `_headers` file sets for the home page (including the Content-Security-Policy) with the ones actually sent. For the marketing site it compares the bundled code only, because its deploy writes its pages from live data.

The build uses the public build variables recorded in `.github/served-build.json`, not the values read back from the Cloudflare dashboard. That is deliberate: a dashboard change, such as pointing the RPC or indexer address somewhere else, then shows up as a difference until someone records the new value in a reviewed commit. The build runs with no token in its environment.

A finding opens an assigned issue ("Served build differs from its commit") and pings the ops chat, through the same alert path as the deploy-lag check. It says what it found: a file or header that differs, a deployed commit that is not on `main`, a deployment it cannot verify (no stamp, a build with uncommitted changes, or traffic split between versions), or a commit that would not build. A difference names both possible causes, a changed build variable or an altered site, and the runbook says to treat it as altered until shown otherwise. A deploy that lands during the check is not judged that run.

A local run, against the deployments live on 2026-11-07, found all three sites serving exactly what their commits build. A run with one build variable changed reported the difference, so the check can see one. The deploy-lag check now reads deployments through the same shared reader.

The check's first scheduled run raised a false alarm. The app and alpha05 stamped their commit as git's short form, whose length depends on how much history the checkout holds: Cloudflare's shallow clone wrote seven characters, the check's full clone more, so every file carrying the stamp differed. Both builds now stamp the commit's first twelve characters, the same length the deploy stamp records, whatever the checkout. The Help page and the diagnostics show that longer form.

Advances #3236.

_Committed 2026-11-07 08:42 UTC (4c9ad261a)._
<!-- assembled-fragment: 3236-served-build-check.md sha256=ace43850b911203021ee4a0aaad37551a0a43800c7fdeef6f451d16346a486d8 -->

### A person approves each site deploy at mainnet: built now, switched off (#3236)

Every merge to `main` deploys the connected app, alpha05 and the marketing site by itself. That means one bad merge, one stolen token or one agent's mistake reaches the page users sign through. The owner decided to build a human approval step now, rehearse it on testnet and switch it on at mainnet. Until then nothing changes: testnet sites still deploy on merge.

When it is on, a site's build only uploads the new version, stamped with its commit and reachable on its own preview address, and that version takes no traffic. A new workflow waits for that version and rebuilds its commit. It compares the build with what the preview serves (the served-build check), and only then asks for approval in a protected GitHub environment. On approval it makes that version live and records the approving run in the deployment's message. It refuses a version older than the one live, so approving a stale run cannot roll a site back. The token that can deploy belongs to that environment alone, so no job can use it before a person approves.

The six-hourly served-build check reads that message back. With approval on, a live version that no approval run put there is reported as "unapproved". The gate cannot stop someone who holds a Cloudflare deploy token or can edit the build settings, but they can no longer deploy without anyone noticing.

The steps to switch it on, to switch it off and to rehearse it while it is off are in the incident runbook, section 9, under "Prevent". The runbook also records that DNSSEC, CAA records and HSTS are now on for the domain.

Advances #3236.

> Caveat: A version waiting for approval can be opened at its public preview address by anyone who knows that address.
> Caveat: An incident rollback by hand is itself unapproved, so the check reports it until the next approved deploy.

Which sites a merge rebuilds is now read from a `watch` list per site in `.github/served-build.json`, copied from each Workers Build trigger's watched paths. The first version assumed every site rebuilds on a shared-package change. The marketing site's trigger watches only its own folder, so with the gate on it would have waited for an upload that never came. The marketing site's trigger now also watches the shared packages and the lockfile, which its pages depend on, so a shared change rebuilds it like the other two sites.

The promote step reads the approved version by its id, because pull-request preview builds upload versions to the same Worker and can push it out of a recent-versions list by the time someone approves.

_Committed 2026-11-07 10:32 UTC (a4936b72c)._
<!-- assembled-fragment: 3236-site-deploy-approval.md sha256=ee6ac0d7707514463d6aa920de88fa2572f9063e21a8f3cec6fe21153c62cc99 -->

## Reading queued governance changes from the chain (#3237, part 1)

Every admin change waits out the governance timelock's delay before it can run. That wait is only useful if people can see what is waiting. This change adds the shared reader that the public "queued changes" page and the ops alert will both use.

The reader takes the list of queued operations from the timelock's own storage, and reads every value at one block. The timelock stores only each operation's id and the earliest time it can run, not the call itself. So the reader finds the block the operation was scheduled in and reads the schedule record from that block's logs. It then recomputes the operation's id from the calls it found. Only calls that hash to the id stored on chain are reported. A wrong index or a misbehaving endpoint can leave an operation's details unknown, but cannot make them wrong. An operation whose details could not be found is still listed, with its time and the reason its action is unknown.

A second step turns each call into data a page can put into words: the contract it targets, the function and its arguments, role names where a role is involved, and a recognised kind for the common changes (a code change to the Diamond, a role granted or revoked, a new delay, a pause, an ownership move or an upgrade). A call that cannot be decoded is reported as such, never guessed.

Advances #3237. Nothing user-facing changes yet: the page and the alert follow.

### The public page (#3237, part 2)

The new app has a page listing queued governance changes, reached from the footer and needing no wallet. For the network on screen it lists every change waiting in the governance timelock, soonest first. Each change shows when it can run, what it will do in plain words (a code change to the protocol contract, a role granted or removed, a new minimum wait, a pause), and its exact call. The page always states the block it read the queue at. A change whose action could not be proved is listed with its id and the reason. A network with no timelock, or a failed read, is stated as such and never shown as an empty list. The page also says that a queued change stays runnable until it is run or cancelled. All three testnets had nothing queued when this was built.

_Committed 2026-11-07 23:52 UTC (86bacb77d)._
<!-- assembled-fragment: 3237-governance-queue-reader.md sha256=d8a4bae32b2f8ecd72aa911c5461498ef14f067f2754be2901f173cc73b87277 -->

### Ops alerts for sanctions-list changes and queued governance changes (#3239, #3237)

The private mesh watcher can now page the operators' channel when the
sanctions list or a timelock changes. Every sanctions-list update pages with
the number of addresses added and removed, the list size, the source hash,
the publication date and who applied it. Changes of who may add or remove,
rollbacks of the recorded publication, delisting proposals (with the
addresses and the time they can execute, so the Safe can veto in time), and
every operation queued in the governance timelock (its target, the function
it calls and when it becomes executable) page too. Outcomes of something
already paged, such as an executed or cancelled operation, arrive silently.

Events are read only once they are final on their chain, and the watcher's
reading position moves only past alerts that reached the channel, so an
alert that could not be sent is sent again instead of being lost. The first
read of each contract states the block it started from, so nobody mistakes
silence about older history for "nothing happened".

The alerts ship turned off. An operator applies the watcher's new database
migration and then sets `EVENT_ALERTS_ENABLED` to `true`; the watcher's
status says whether they are on.

_Committed 2026-11-07 14:10 UTC (16494ddea)._
<!-- assembled-fragment: 3239-3237-event-alerts.md sha256=537a7bbca1625ce689372db13acee96b2482b1c57032e7f75415f2668dc8d322 -->

### The automated sanctions adder's reach is bounded (#3239)

The platform's own sanctions list lets an automated adder key apply updates that only list addresses. A stolen adder key was meant to be limited to nuisance. In practice it could do more: listing a wallet also blocks its claims, its partial and early withdrawals and its vault creation until the Safe delists it, and nothing limited how many wallets one key could list. It could also record a publication dated far in the future. That made every genuine later OFAC publication look older, so updates stalled until the owner authorized a rollback.

The list now limits an adder to a number of listings per UTC day across all its updates. The limit is 100 by default, and the owner can set it between 10 and 1,000; at mainnet, a change waits out the governance delay. The Safe, as remover, is not limited. A publication with more additions than the day allows lands in batches on later days and is stated as outstanding meanwhile, or the Safe applies it at once.

No update from any account may now record a publication dated after the chain's own UTC date. OFAC's dates are never ahead of UTC, so a genuine file always passes.

The adder service reads how many listings the day still allows and plans within it. It reports the rest of the publication as waiting for the next UTC day, not as an error or an overstated count. Against a list deployed before this change, which has no cap, it plans without one. The manual diff tool, which plans calls for both signers, gives the adder only what the day allows and puts the rest of the additions in calls for the Safe, which has no cap.

The functional spec and the sanctions runbook now say what a listing blocks, what stays open and how to recover.

Advances #3239. The remaining item, an operator alert on every listing, needs a watcher that runs apart from the adder's own host.

> Caveat: An adder can still record a false file under today's date. A genuine file with the same date then waits until the owner authorizes it or the next publication arrives.
> Caveat: The rehearsal lists already on Base Sepolia and Arbitrum Sepolia keep the old behaviour until they are redeployed.

_Committed 2026-11-07 13:29 UTC (f4abdda55)._
<!-- assembled-fragment: 3239-sanctions-adder-bounds.md sha256=0f85b7fb84b770560af3aa628cb5dc33fd6ebd515b9e166c1ef805c404b35972 -->

## Keeper — private submission route per chain (PR #3275)

On a chain with a public mempool, a liquidation or forced sale sent to the
ordinary RPC can be seen before it lands, then copied or sandwiched. The
keeper can now be given a private submission endpoint per chain, such as
Flashbots Protect on Ethereum. Its signed transactions are broadcast there
instead, while every read (nonces, gas estimates, receipts) stays on the
chain's ordinary RPC.

The route is set per chain, not per pass. Every transaction the keeper key
sends on a private chain goes through the endpoint. The key's sends share one
nonce sequence, and the ordinary RPC cannot see a private transaction until it
is mined. A public send on the same chain would read the wrong next nonce and
could replace the private one. For the same reason, the keeper trusts a
remembered nonce longer on a private chain: seven minutes, against the six
minutes Flashbots Protect keeps a transaction pending. A dropped private
transaction can therefore hold later sends on that chain for up to that long.
Each transaction's seven minutes run from its own broadcast, so later sends
accepted behind a dropped one neither extend its hold nor lose their own when
the dropped one is replaced.
The remembered nonce is also written to the keeper's own database before each
private broadcast, so a keeper restarted by an update or a crash still skips a
private transaction that has not landed yet. If that record cannot be read or
written, the keeper sends nothing on that chain rather than guessing.

Falling back to the ordinary RPC is opt-in per chain. When it is allowed and
the private endpoint refuses or does not answer, the same signed transaction
goes to the ordinary RPC, so a second transaction can never result. It does
become public, and the keeper logs that it fell back. When it is not allowed,
a failed private send is a failed send.

Settings the keeper cannot read stop every send on every chain, including a
secret that is set but fails to load, and the log
says why, rather than quietly sending publicly. Every tick logs a
`submission routes:` line naming each chain's route and the endpoint's
provider domain (such as `flashbots.net`), never its URL or a subdomain,
either of which can carry an access key. With nothing configured, every
chain sends publicly, as before.

This closes the keeper side of #3240. Which mainnet chains get a private route
is the owner's decision, to be recorded in the mainnet checklist (#3243).

> Caveat: the per-close-out hold (`keeperTxPending`) reads the ordinary RPC, which cannot see a pending private transaction. On a private chain, a second attempt at the same loan inside the pending window can still be sent; it queues behind the first and reverts once the first lands, costing gas but moving nothing.

_Committed 2026-11-07 03:23 UTC (b3e821a80)._
<!-- assembled-fragment: 3240-private-submission.md sha256=d536800c393efdebab89462527dd2075d3b9f59268e9e91e073eb2fa2e4963a0 -->

## Keeper — the matcher shares its previews across wallets, not offers (PR #3274)

The keeper's matcher previews a bounded number of candidate pairs per run.
Until now it spent that budget in listing order: each lender walked every
borrower offer in its bucket before the next lender was looked at, and each
standing intent walked the whole borrower book. One wallet that posted
thousands of offers could therefore use up a run's previews on its own offers,
and the genuine matches behind them waited until the spam was gone.

The walk now goes round by round across pairs of counterparties. For the offer
match, a pair is one lender wallet and one borrower wallet in one bucket; for
the standing-intent fill, one intent and one borrower wallet. Each pair gets
one preview per round, so every pair is looked at once before any pair is
looked at twice, and the number of offers a wallet holds buys it no larger
share. The buckets and the wallet order start at a point that moves with each
run, so when a run's budget reaches only part of the first round, a different
part is first the next time. A wallet is still never paired with itself.

The rules that end a pair's walk are unchanged: a fully filled lender, a
lender or intent backed off after an uncertain submission, an intent refused
for a reason that holds for all its borrowers, and the solver capacity and
priority-credit handling. A borrower left in flight by an uncertain offer
match is now also passed over by the other lenders in the same run, not only
by the intent fill, so it cannot be matched twice while the first transaction
may still land.

This advances #3242 (part 2, matcher fairness). Parts 1 and 3, a minimum offer
size and the same bound on the indexer's signed-offer intake, are separate.

> Caveat: fairness is per wallet. A spammer who splits offers across many wallets gets a share per wallet, like anyone else; the minimum offer size (#3242 part 1) is what bounds that.

_Committed 2026-11-07 02:12 UTC (d714c8d05)._
<!-- assembled-fragment: 3242-matcher-fairness.md sha256=6a9e92bd8f3977c9f0ba287d212900b4012ee18f34f7028022df20330ee44e58 -->

## Thread — Offer-book bounds: a $10 value floor and a per-wallet open-offer cap (PR #3283 and its app follow-up)

The offer book can no longer be flooded with offers too small to be worth
servicing. Two bounds now apply to every offer a wallet posts. An offer whose
principal is worth less than $10 (in the active numeraire, the same on every
chain) is refused, at creation and whenever its amount is changed. And a
wallet may have at most 25 offers open at once, every offer type counted;
cancelling one makes room. Both are bounded governance settings, so a chain
where a keeper's work costs more can raise the floor.

The floor binds only a principal the protocol values: a liquid ERC-20 with a
price. NFTs, illiquid tokens and a liquid token whose price cannot be read at
that moment are never refused for their value. Partial fills need no check of
their own, because no fill is smaller than the offer's amount and a remainder
below that closes the offer. Offers that come from an existing loan (sale and
offset offers the protocol creates, and refinance offers) are exempt from both
bounds so no way out of a loan is closed. A signed offer meets the floor when
it is filled and never counts against the cap. There is no cancellation fee:
the owner rejected one, along with a mandatory partial fill and a $100 floor.

Offer creation was too close to the contract size limit to carry the new
checks, so the step where a new offer enters the book now has its own facet:
it applies the two bounds, records the offer as open and emits the creation
events, whose signatures are unchanged. It also answers the amount re-check
for offer edits and reports a wallet's floor, cap and open count. It is
refreshed together with offer creation and offer editing.

The open count starts with this build, so on a Diamond refreshed in place
the offers opened before the refresh are not counted. Every chain reaches
this by the next fresh deploy.

In the app, the guided lend flow sets a lender's smallest fill to 10% of the
total, which on a small offer would fall under the floor; it now raises that
fill to the floor, read live from the protocol, and never above the total. An
amount under the floor is named under the field before anything is signed, and
both new refusals read as plain sentences. The standing-intent preview reports
a slice under the floor the same way the fill would refuse it.

The offer book now ranks offers largest first by default, so the market's
real depth leads and a run of tiny offers sinks instead of crowding the top;
newest first stays one choice away. A smallest-size filter (any, or at
least 10, 100, 1,000 or 10,000 in the reference currency, which is read live
rather than assumed) hides only an offer whose size it measured below the
choice. Size is what a lending offer can still lend, or what a request asks
for, at the protocol's price. An offer in a token with no reliable price has
no measured size, so it is never hidden and is listed after the sized ones,
and the page says so. Create offer, in both the current app and the new one,
names the wallet's open count once it is within five of the cap and stops
before any signature at the cap; the new app also names an amount, or a
lending offer's smallest part, below the floor. The signed-offer book refuses
an order whose smallest amount is below the floor, since no taker could fill
it directly, and the Rate Desk says why in a sentence. Closes #3242.

> Caveat: on a Diamond refreshed in place, offers opened before the refresh do not count against the cap.

_Committed 2026-11-07 07:02 UTC (bebb633dc)._
<!-- assembled-fragment: 3242-offer-book-bounds.md sha256=79130bb5926e3a65ede5c1cad36245f2bdc278f28a215a3a8110106b250eaf7a -->

## Operations — the mainnet operations baseline (PR #3277)

A new runbook, `docs/ops/MainnetOpsBaseline.md`, sets the bar the machines and
credentials must clear before mainnet. The mainnet readiness checklist now
includes it. Nothing changes on any testnet.

The keeper host gets its own section. It lists the hardening the keeper's
service already brings, then what a mainnet host adds:

- a dedicated machine with no automated session on it;
- unattended security updates;
- a deny-by-default firewall;
- key-only logins, one account per operator;
- root-only key files;
- a separate key per role, with the keeper key holding only gas;
- monitoring that alerts the operator chat when the keeper stops ticking or
  the host runs short.

It also records, per chain, the owner's decision on private submission
(#3240).

Production credentials are to be scoped to one service and one job each, and
kept off any machine an automated session can read. A rotation record lists
every bot token, signing key and service credential: who holds it, where it
is kept in general terms, when it was last rotated and how to rotate it. It
never records a value. Each one is rotated on schedule and at once after any
suspected exposure.

This addresses #3243. Its boxes are ticked when the mainnet host is set up.

_Committed 2026-11-07 02:18 UTC (e98ef6fea)._
<!-- assembled-fragment: 3243-mainnet-ops-baseline.md sha256=b677399a9aba5200f9c5ba7565c4b30a6fdd37f2d88b82df9d83a7c65afe249f -->

## Keeper — applying vault-beacon changes once due (PR #3297)

The vault beacon (#3204) holds three kinds of change that wait out a delay and
then may be applied by anyone: a Timelock proposal of a new current vault
version or a revoke, a vault owner's signed pin or unpin, and a vault owner's
signed lowering of its pin delay. Until now nothing applied them when nobody
did it by hand, and the permissionless-steps ledger recorded all four as a
gap. The new `vaultBeaconUpkeep` keeper pass is that backstop.

Every hour, on each chain whose Diamond names a beacon, the pass reads the
beacon's own request events up to the finalized block, keeps the vaults they
name in its work queue, and re-reads every queued vault's pending changes on
chain. A change is applied only once the beacon's own time for it has passed,
after a simulation shows it would succeed, at most one proposal, four pins and
four delay lowerings per chain per run. A change someone else applied or
cancelled first, and one the beacon says is still early, are reported apart
from a refusal. A vault leaves the queue only when nothing is pending for it
at both the latest and the finalized block.

The pass moves no value and pays only gas. It ships disarmed behind
`VAULT_BEACON_UPKEEP_ENABLED`; arming it is an owner decision. The four
ledger rows now name this pass and its flag.

Closes #3282.

_Committed 2026-11-07 13:43 UTC (e51ae5944)._
<!-- assembled-fragment: 3282-vault-beacon-upkeep.md sha256=f7458bfd0f684466b20cc1c4a2281074208c85802326e43ce64e86bd1301dd33 -->

## Thread — the live refinance drive follows the payoff permit (PR #3298)

The manual live refinance drive had not caught up with the refinance payoff permit (#1558, #3042). Its write plan still expected the borrower to approve the Diamond for the payoff, and its review check still expected the approval-route wording ("the approval you grant covers that too"). So the first live run against the deployed app stopped at the borrower's review, before anything was written. Closes #3295.

The drive now expects the borrower's steps in the order the app takes them: the guardrails if needed, the wallet's approval of Permit2 if needed (with a reset to zero first when a smaller approval is left over), the request, the signature on the payoff permit, and the transaction that attaches it. Each step is still one complete expected object, compared field by field, inside one ordered plan that stays closed until the borrower's confirmed submit and halts on any mismatch. The permit has to name this loan and the request the createOffer receipt created, be addressed to the Diamond, expire at the request's last fillable moment, and allow exactly the wallet share the contract reports for that moment. The attach call has to carry exactly the permit that was signed. Any approval of the Diamond from the borrower is now refused.

The amounts come from the contract's own payoff view, which is what the app reads, and no longer from a copy of the app's payoff formula. The borrower's review is compared against the same view: the payoff, how much it can grow, the permit's maximum, the wallet top-up, and the "up to five wallet steps" note. The retired approval-route wording counts as a mismatch. The drive keeps the borrower's phase open until the page reports the permit attached, then reads the attached permit back on chain before the lender is armed.

A Diamond that does not route the permit (one deployed before #1558) is now refused before any write. The drive does not model the old approval route. The payoff route is part of the watched configuration, so a change to it mid-run is caught like any other configuration race.

> Caveat: this was verified by unit tests against the app's own permit builders and viem's own signing request, not by a live run, because the drive writes on chain.
> Caveat: the app's copy says "up to five wallet steps", but when the Permit2 approval has to be reset to zero first the borrower sees six prompts. The drive allows both.

_Committed 2026-11-07 13:59 UTC (0cf9601f6)._
<!-- assembled-fragment: 3295-live-refinance-payoff-permit.md sha256=6950bde2c9ec258749b26b57c758325ed793247449d14baded2a97b7e67ee14d -->

## Thread — the live refinance drive brackets the borrower review in time (PR #3303)

The re-run of the live refinance drive on loan 3 stopped at the borrower's review, before anything was written. Two figures on the page, the payoff growth and the payoff permit maximum, were 3,805,175 wei lower than the drive expected. Closes #3302.

The page wasn't wrong. It computes the review from the chain time of its own last loan poll, which is block time refreshed about once a minute, and from a payoff view read at its own block. The page shows neither moment. The drive recomputed the figures at a later block, which put the request's last fillable moment a few seconds later, and compared the two exactly.

The drive now brackets each review figure in time. It reads one block before it opens the page and another after it has read the review rows. It evaluates the contract's payoff view at each of those blocks, using the deadline that block implies, and requires the page's figure to lie between the two results. The payoff and the wallet share never fall with time, so the page's true figure must lie between them. No tolerance is added.

The comparison that governs funds is unchanged. The payoff permit the borrower signs must still allow exactly the share the contract reports for the deadline actually signed.

> Caveat: verified by unit tests, not by a live run.

_Committed 2026-11-07 23:49 UTC (5a89ad439)._
<!-- assembled-fragment: 3302-live-refinance-review-bracket.md sha256=afb09eb42ddabaa98d4053dfabb6d9ff6c838c8139c0e956874522dfb78b4862 -->
