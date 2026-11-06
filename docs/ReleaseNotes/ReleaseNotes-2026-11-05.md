# Release Notes — 2026-11-05

Interest now counts by the second on every repay, preclose, refinance and default path, instead of in whole days. A late NFT rental's fee is now sized on its whole agreed rent, and a fully prepaid rental can always settle within its grace period. The pause escape period is now an admin setting, defaulting to three days and bounded between 49 hours and 7 days. It applies only to pauses that start after a change. The auto-extend switch now stops only the keeper, so a borrower can still extend and fund the reserve directly. The keeper sends a reward close-out call only when the protocol says it would make progress, and its release and return loops start somewhere new each run. The docs now disclose that a pending Telegram LOCK request holds only the keeper's releases. The next connected app, apps/alpha05, was scaffolded and reached a working Home page: rewards, claims, faucet, fee-discount toggle and the Terms gate, laid out for phones. The website moved onto the same shared palette. The RL-3 claim-horizon safeguards are now proven end to end on Anvil before arming. The mesh watcher bundles only the contract views it reads.

Each section records its change as it was merged.

## Keeper — the reward close-out sends a call only when it would progress (PR #3162)

The reward heartbeat's close-out step retires closed reward entries whose
remaining window is worth nothing, and sweeps the loans of forfeited entries
into the recycle bucket. Both calls can make progress without moving any
value. A sweep may only prepare its records or advance its own cursor, and a
retirement may only advance the pricing cursor it depends on. Until now the
keeper could not see that progress. It swept every loan with an unfinished
forfeited entry once each round, whether or not anything would happen, which
cost a transaction each round for a loan still waiting. It also never sent a
retirement that only advanced the cursor, so an entry far enough behind
could wait on some other caller.

The protocol now reports, for each call, whether it changed any entry's
settlement state (#3012, #3026). The keeper simulates each call and sends it
only when the protocol says it would progress, then repeats it within the
run while it still does. A loan whose sweep cannot progress yet costs a
simulation each round and no transaction. A retirement that only advances
the cursor is now sent.

The temporary read of the older, shorter results is removed. This needs
every served chain to run the refreshed reward facets, so it is merged only
after Base Sepolia, BNB testnet and Arbitrum Sepolia are all refreshed.

Closes #3012. Closes #3026.

_Committed 2026-11-05 05:22 UTC (cd3e8cc54)._
<!-- assembled-fragment: 3012-3026-keeper-close-out-progress.md sha256=95efc17a3a5b743d04bb5396282881346badcc5a4f4c65808e36cc714824ece0 -->

## Keeper — release and return loops start somewhere new each run (PR #3194)

The keeper's reward close-out (the removed remit-destination releases on
Base) and its return transport (pending repatriation authorizations and
stranded quarantine returns on mirrors) walked their candidates from the
first one every run. Both passes cap how many transactions a run may send,
so under a long list the same leading candidates were retried run after run
while the later ones waited.

Each of those three loops now starts at a point that moves from run to run,
using the same rotation the protocol-upkeep pass already uses, seeded by the
run's position in the pass's schedule. Every candidate is still tried once a
run when the budget allows; only the starting point changes. The candidates
in each loop are independent of one another, so the order carried no
meaning. The day-by-day closure and prune steps of the close-out are not
changed by this PR.

This brings the code in line with the keeper spec's existing rule that long
lists rotate their starting point between runs. Both passes still ship
disarmed.

Closes #3155

_Committed 2026-11-05 12:01 UTC (60b6dc472)._
<!-- assembled-fragment: 3155-rotating-release-loops.md sha256=7124c3055bce35c48a228077e434696022fdfe0dfb1287d4c8c621c85b4dc092 -->

## Interest counts by the second on every path

An ERC-20 loan's interest now counts to the second wherever the protocol settles or values it: full and partial repayment, preclose, refinance, a sale, an extension, swap-to-repay, defaults, liquidations and the health-factor reading. Repayment, preclose, refinance and the partial paths used to count whole days, rounded down. So a pro-rata loan repaid within its first day paid no interest at all, while the same loan's liquidation debt and its extension charge already counted seconds. The owner chose per-second interest on 2026-11-05, rounded down once per settlement, which is how liquidation already rounded. The same loan now owes the same interest at the same second, whichever path settles it.

For a full-term-interest loan settled early nothing changes: a 365-day year in seconds and in days give exactly the same figure, so the borrower still owes the agreed term's interest to the wei. Past maturity, inside the grace period, a full-term loan accrues the time actually elapsed, to the second. The in-place extension's charge now follows the same rule; for a full-term loan it used to stop at the minimum even when more time had passed.

The full-term minimum after a partial repayment, partial swap-to-repay or partial liquidation now runs from the restarted interest clock to the loan's maturity, to the second. It was a whole-day counter decremented at each partial, which dropped the part day before maturity each time. The counter is retired. Its storage slot stays, renamed and no longer written, and the minimum is derived from the loan's start and term. A pause before the restart lengthens the minimum, because it moved the maturity. A pause after the restart moves only the deadlines.

Partial withdrawal now values a loan's debt exactly as the health-factor check does, net of interest already settled periodically. Before, it counted whole days and could differ from it.

Funds: borrowers pay interest for the time they actually held the principal, to the second. The extra interest goes to the lender, less the treasury's usual cut on interest. Nothing else moves. The app's own estimates follow the same rule, and so do the payoff figures the refinance and offset flows reserve. NFT rentals keep their own rule: a part day counts as a whole day.

This changes contract code and a storage field's name, so it reaches a chain only through a fresh deploy. Closes #3169.

_Committed 2026-11-05 10:51 UTC (b6063fce0)._
<!-- assembled-fragment: 3169-per-second-interest.md sha256=64cf78596933189fdcc6513f5615c638e450a74363a1d5c6759a0610c8c50535 -->

## A late rental's fee is sized on its whole agreed rent, and a fully prepaid rental can always settle (#3170) (PR #3193)

A borrower could prepay every remaining day of an NFT rental through a partial repayment. Two things then went wrong. Full repayment reverted, because it refused any rental with nothing left in its prepayment. And the late fee, which was sized on the rent still owed, read zero for the whole grace window, while the lender's NFT stayed locked.

The owner chose to size a rental's late fee on its whole agreed rent: the daily fee times the agreed number of days, whatever part of it has been paid and however. It still starts at 1% the day after maturity, rises 0.5% a day, is capped at 5%, and is clamped to the buffer the rental funded. So every late rental now pays the same rate on the same base, and prepaying the rent no longer avoids it. Full repayment of a fully prepaid rental now settles inside grace: it pays the late fee from the buffer and returns the rest of the buffer. The buffer still funds the late fee alone. Rent that the prepayment cannot cover is refused, never drawn from the buffer.

The repayment quote, the direct early close of a late rental, and the repayment itself all read the same fee rule.

Closes #3170

_Committed 2026-11-05 11:48 UTC (b2a1f33ae)._
<!-- assembled-fragment: 3170-rental-late-fee-whole-term.md sha256=7ed6bdb2df0427a08cf1fe5f8ddf415510fd293e539b69f03fc37c479e9b0b38 -->

## The pause escape period is an admin setting

When the protocol stays under an admin pause long enough, every user may take what is theirs out of their own vault to their own wallet. That period was fixed at three days in the code. It is now an admin setting: three days by default, and anywhere from 49 hours to seven days. The lower bound keeps the escape from opening before a governance fix, which waits 48 hours in the timelock, could land.

A change applies only to pauses that start afterwards. Each admin pause records the period in force when it began, so changing the setting during a pause neither opens the escape early nor closes one users were already promised. A second pause call during the same pause keeps the recorded period too. Setting it to zero restores the default.

Anyone can read the period the next pause will use, the period of the pause now running, and the exact time the running pause's escape opens. The app's banners no longer say "three days"; they say the pause has outlasted the emergency-exit period.

Funds: nothing moves differently. The escape route's rules (what may leave, and to whom) are unchanged; only how long a pause must last before it opens is now configurable.

This adds storage fields at the tail of the pause record and new selectors, so it reaches a chain through a fresh deploy or the all-facets refresh. Closes #3173.

_Committed 2026-11-05 12:53 UTC (e34da2fd1)._
<!-- assembled-fragment: 3173-escape-period-knob.md sha256=6470a53b0b019e4f381179e6f5e993551be73808b209d8f6355500040e66c7f0 -->

## Thread — The auto-extend switch stops only the keeper (PR #3195)

The protocol's automatic-extension switch used to stop every extension and
every reserve deposit. It now stops only the automated route: a keeper
acting under a granted extension permission is refused while the switch is
off, and is charged service capacity only when it acts. The borrower-position
holder (or the manager of that position) can still extend the loan in place
directly, within both sides' limits, and can still add to or withdraw an
extension reserve. A stranger is still refused, and a lender has no direct
extension route at all.

The reason is that the switch exists to stop the automation, not to take a
borrower's own agreed option away from them. Turning it off no longer
strands a reserve the borrower meant to use for their own extension.

The functional spec, the admin knob reference (operator copy and the
published www page) and the connected app's extension card now say this.
The card states that no keeper will extend the loan while the switch is
off, that the borrower can still extend directly on the contract (the app
does not offer that step yet), and keeps the reserve panel open.

Closes #3175

> Caveat: the app has no button for a borrower's direct extension; with the switch off, that step is reachable only on the contract.

_Committed 2026-11-05 13:03 UTC (a98855116)._
<!-- assembled-fragment: 3175-auto-extend-switch-keeper-only.md sha256=941fdd07f29c86ccc4eaa6ce733a41397b121601adf9735e956fcb5157d4e014 -->

## A pending Telegram LOCK request holds only the keeper's releases (#3177) (PR #3192)

The protected-vault spec said a pending Telegram LOCK request holds the account's payouts and NFT transfers. In practice the hold binds only the keeper: release stays permissionless, so anyone can release a payout or transfer that is already past its delay, in the short window before the keeper's lock lands on chain.

The owner chose to disclose this rather than add an on-chain "lock pending" marker. A marker would be a keeper transaction just like the lock itself (which needs no co-signature), sent in the same run, so it would close no window. The vault operations and keeper operations specs now say that protection starts when the lock lands. They also say that every payout past its delay was queued on chain and could have been cancelled throughout its delay, that the owner's alert of a queued payout is best effort rather than a guarantee, and that the owner's own lock from the app has no keeper delay.

No contract or keeper behaviour changes.

Closes #3177

_Committed 2026-11-05 10:49 UTC (362e498ee)._
<!-- assembled-fragment: 3177-lock-request-hold-disclosed.md sha256=71c6abe1aac314f83eeccada56fad792ed51c1f9fa045610c6db466af2ef6122 -->

## The next app's Home can sign: test assets, the fee discount, and the Terms (PR #3215)

Home in the next connected app gains its first actions, and with them the one signing flow every later page will use. Before the wallet opens, a receipt states what the action does, what stays unchanged, what the reader can lose and how many wallet prompts it takes. Right before the wallet opens, the inputs are read again and the call is tried against the chain: a change reopens the review, the protocol's own refusal is shown as given, and a check that cannot be made withholds signing. While the transaction runs, the wallet step and its progress are narrated; afterwards the outcome is read back from the chain and reported as done, not done, partly done or unknown, never inferred from the receipt alone. A transaction whose receipt cannot be read keeps its hash on screen and can be checked again; nothing new is offered until it is. A transaction outlives the page that sent it: leaving the page, disconnecting or switching wallet or network does not lose it, its page shows it again on return with the receipt and network it was confirmed for, and while no page shows it the app says on every page that it is still out. A review opened for one wallet and network is never signed under another.

On a test network whose deployment record publishes test assets, Home offers them: test tokens with a test price, test tokens with none, and rentable test NFTs, each badged as a test asset with no value. Each mint says that the test token contract mints it, not the protocol, and the result is measured from the balance or the NFT's owner. A finished mint offers the next jobs and, for a token, to show it in the wallet.

The fee-discount setting can now be turned on and off from Home, as the platform's one per-network flag. The review says what changes for borrowing and for lending, and how a lender's discount is delivered on that network (paid in VPFI from the vault where a price source is configured and the vault can pay at that settlement, otherwise a smaller fee with no VPFI moved), that the borrower discount applies only on a liquid lending asset, and that no discount exceeds half the fee. Turning it on asks for the Terms of Service in force first, when a version is in force: the prompt names the action that asked, shows the version, the whole fingerprint of its text, the version's permanent page and the privacy notice, and continues to the setting once accepted. Turning it off never asks. While the protocol is paused the setting cannot be changed in either direction, and Home says so with what stays open.

Every outcome is read back at the block the transaction was mined in, so a node that is behind cannot report a finished change as not made; when no source can serve that block, the outcome says it is unknown. If the reader switches wallet after confirming, the flow says which wallet it belongs to.

The rewards widget that was planned beside these moves to the next Home part, with the shared claim flow it needs. The user guide's Basic and Advanced editions gain sections on the test assets, the fee discount and the Terms prompt, in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CONFIDENCE, RB-REVIEW, RB-SWITCH, RB-FUNDS. Epic #3180.

_Committed 2026-11-05 20:53 UTC (dd45e7fb2)._
<!-- assembled-fragment: 3180-alpha05-home-actions.md sha256=18181745404f5cce4cefdaf03232dbc42a123be301bc494de9582592da4869d1 -->

## The next app's Home shows rewards and claims them (PR #3217)

Home in the next connected app gains a rewards and VPFI section. Its headline is what a reward claim made now would pay, worked out by running the claim itself as a preview, so the figure is exactly what the claim pays. When that preview cannot run, Home shows the protocol's own lower bound instead, labelled as a lower bound, and does not offer the claim until the exact figure can be worked out. When a claim would be refused, the reason is named: a reward day still waiting to be finalised across networks or for its funding to reach the network (with the day), the programme not started yet, the protocol paused, or the wallet flagged by the sanctions screen. "No rewards available to claim on this chain" is said only when the claim itself reports nothing to claim.

The claim runs through one shared claim flow that the Claims and Rewards pages will reuse: a receipt with the exact amount, the reward days it covers, where it is delivered (the vault, ready to use, for every kind of wallet including a contract wallet, or the wallet when the vault cannot take it; a claim never opens a vault) and that it is for this network only; the figure worked out again and the call tried right before the wallet opens; and the outcome measured from what the claim's logs record and the VPFI that the claim's own transaction delivered to the vault or the wallet, with the destination stated as unknown when those do not add up. A claim pays at most thirty reward days, so when more remain the finished claim offers to claim again. A claim that pays nothing but moves past reward days that paid nothing is still offered, and says so.

The section also shows the soonest estimated removal date among the wallet's unclaimed rewards, with a final notice within ninety days of it, a statement when not every reward could be checked, and no date at all where the network removes nothing. A balance held for a wallet the sanctions screen flags is shown with its state, held while flagged or ready once the wallet is no longer flagged, and a ready balance can be claimed on its own through the same flow. The fee-discount tier the wallet's fees get now is shown beside them. Lifetime claimed is left out until an index route for it exists, rather than estimated.

Rewards are described as usage rebates paid in VPFI, never as yield. The user guide's Basic and Advanced editions gain sections on Home's rewards, removal dates and held rewards, in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-CLAIM, RB-REVIEW, RB-CONFIDENCE. Epic #3180.

_Committed 2026-11-05 23:34 UTC (d58af1e8c)._
<!-- assembled-fragment: 3180-alpha05-home-rewards.md sha256=72c70bc18b0861296744ff7a69d620e08b76d08f98eb5332e17faf6bf7f93dc0 -->

## The next app has a Home page (PR #3213)

Home is the first page of the next connected app to be built. It reads; nothing on it signs.

With no wallet connected, it opens on a choice of job: borrow, lend, rent an NFT, rent out an NFT, or manage what you have. The choice comes before any protocol term, and each card opens the guided page for that job. With a wallet connected, three short cards introduce the app the first time (your own vault, a receipt before every signature, and help in place); each can be dismissed and stays dismissed in that browser.

Below them is the wallet's book on its network, read from the chain through the wallet's own connection. A position belongs to whoever holds its NFT, so the book is built from the position NFTs the wallet holds, not from the parties recorded when each loan began, and an offer counts as open only when the protocol's own state says so (not cancelled, expired, accepted or sold). An answer kept after a failed re-read is labelled with its age. Payouts ready to collect come first, named per loan and side, with their amounts left to the Claims page, which reads every way a payout is paid. Live loans follow, the most urgent deadline first: each states its side, terms, collateral, health factor and next date in plain words. A borrower close to the due date, in the grace period, or past it is told the consequence. A loan that pays interest periodically also answers to its current checkpoint, including one on the due date itself: interest still owed there puts the loan first once its checkpoint is near, and the borrower is told that collateral can be sold to pay it. Where the protocol has switched that settlement off, the loan says no collateral is sold at a checkpoint. An NFT rental shows no collateral, and its renter is told what a default does to the prepaid rent; an open rental offer shows its daily fee, not a yearly rate. Loans opened from one offer are shown together with the principal filled, the principal-weighted rate and the lowest health factor among them. A headline compares what the wallet has lent with what it has borrowed at today's prices, and names the larger side only when loans that cannot be valued could not change the answer. The wallet's open offers come last. Each loan's button opens the loan, where the shared eligibility rule decides which actions are open. A section that could not be read says so, and "nothing yet" is said only when every list was read in full.

The protocol's pause posture is stated on every visit. A paused protocol, or a paused keeper service, is stated at the top with what stays open; a running protocol is one quiet line at the end. A sync line says how long ago the wallet's book was read and through which source.

The user guide's Basic and Advanced editions gain a chapter on the next app in every language, which the page's "Why?" links open. It also covers the modes, where the app's own figures come from and how it reads what the deployment supports, whose "Why?" links had pointed at sections the guide did not have yet. The test-scenario harness can now drive a scenario as a suite's own per-run wallets, and its lender offer can be posted without being accepted.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-ACTION, RB-CLICKS, RB-CONFIDENCE, RB-SWITCH. Epic #3180.

_Committed 2026-11-05 18:04 UTC (30fa6ba6d)._
<!-- assembled-fragment: 3180-alpha05-home.md sha256=ef4cd5fa59b2d82099581e3fbd6bc2c893548218a9e717c0fc5aada3831c3c2a -->

## The next app is laid out for phones as well as desktops (PR #3212)

About half of the app's readers are on phones, so the next connected app now treats a phone as a first-class device rather than a narrow desktop. The first live review on a phone found three defects. The header spilled a few pixels sideways, so the page scrolled sideways. The wrapped navigation and controls covered more than a quarter of the screen. The wallet button read "Connecting…" while the wallet picker was merely open, before any wallet had been chosen.

On a phone the header is now one row: the brand mark and the wallet control. The wallet control is never folded away, because the address and network are the identity every figure on the page belongs to. A bar fixed to the bottom of the screen carries the first four destinations of the same navigation the desktop shows, which is still derived from the page map, and a More button. More opens every destination and the mode and theme controls as a sheet above the bar. The sheet closes when a page is chosen, and on Escape, which returns the keyboard to More. This is the bottom navigation the rulebook's accessibility rule already asked for on small screens. From 720 pixels up the bar goes and the whole navigation sits in the header as before.

The wallet button now says "Connecting…" only while the wallet itself is connecting, never while the picker is open and nothing has been chosen.

The app's verification tier now runs every scenario twice, once in a desktop window and once on a phone-sized touch device. A new phone scenario checks the one-row header, the bar and the sheet, and that the page's last line scrolls clear of the bar. Another checks, at the narrowest common phone width, that nothing scrolls sideways before or after connecting. The shared test-wallet package gained an option to open each session with the test run's device; the current app's suite does not use it and is unchanged.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-A11Y. Epic #3180.

_Committed 2026-11-05 16:01 UTC (5da713b18)._
<!-- assembled-fragment: 3180-alpha05-phone-layout.md sha256=37897953dc47502e12db702f4ae02cef631998663a9c9ee412784f16724f8626 -->

## The next app's rewards preview asks another source when a wallet drops the reason (PR #3219)

The live review of the next app's Home found the rewards section saying a claim "would be refused (Unrecognised)" for a wallet with nothing to claim. The claim preview had been answered by a wallet provider that reported the revert without its reason, and the page treated that as a refusal it could not name.

A revert reported without its reason is now not taken as an answer: the preview asks the next source (the app's read proxy, then the public endpoint), which reports the reason, and the page states what the protocol actually said, here that there are no rewards to claim. Only when no source can answer does the page fall back to the labelled lower bound, as before.

The live review driver now passes the node's revert data the way real wallets do, and can drop it on request to check this path. Epic #3180.

_Committed 2026-11-05 23:57 UTC (79b93d323)._
<!-- assembled-fragment: 3180-alpha05-rewards-unidentified-revert.md sha256=a4f99865ba16fe1103fdc6702af2cca53ed4d2b1d5e9d24cd9616b15543256bd -->

## Thread — Scaffold the next connected app, apps/alpha05 (PR #3179)

A new workspace package, `apps/alpha05`, starts the connected app rebuilt
from the functional specs under the rulebook in
`docs/DesignsAndPlans/Alpha05AppDesign.md`. It deploys to its own Worker,
`vaipakam-alpha05`, and nothing about `apps/app` or `app.vaipakam.com`
changes: the current app keeps serving until the new one reaches parity
under the rulebook's cutover conditions. Advances #3180.

The scaffold carries the same toolchain the other surfaces use, every route
of the page map rendering an honest "not built yet" page that names the
feature-matrix rows it will carry and links the current app, and the shared
modules the rulebook says ship before any route, as typed contracts with
minimal implementations: the capability service (which reads the Diamond's
routed functions from the loupe and reports everything else as unknown
until read), the eligibility verdict and switch classes, three-valued
transaction outcomes, identity-scoped read keys, the claim row model, copy
tiers with a typecheck-time word budget on inline status sentences, the
"Why?" help link, and the receipt and finish-card types. A connected user's
own state is read through the wallet's provider first, with the read-only
proxy as fallback.

Every response from the new Worker says it is not to be indexed until the
cutover, the content-security policy is completed from the build the same
way the current app's is (connect sources report-only first), and the
Worker is held in the deploy-lag check until a Workers Build exists for it.
CI typechecks and unit-tests the package.

> Caveat: the lockfile re-keys three of `apps/app`'s dependency variants (the
> wallet libraries' optional `zod` peer) because the package manager
> deduplicates peers across the workspace; the resolved versions are the same
> and neither app imports that optional entry, so the current app's bundle is
> unchanged.

The new app carries the website's brand set (the shield mark in both colourways, the wordmark, the home-screen icon) as its own files: the favicon follows the colour scheme, the header shows the mark on phones and the wordmark on wider screens, and the loading splash uses the same mark.

The brand palette is now one shared file in the shared library (navy and green, the logo's own colours, with a light theme led by navy and a dark theme led by green), which the new app reads first; the website moves onto the same file in a follow-up so the two cannot drift apart. Every text pair stays at AA contrast in both themes, checked by a test that reads the files.

_Committed 2026-11-05 12:10 UTC (d4a3c7a8d)._
<!-- assembled-fragment: 3180-alpha05-scaffold.md sha256=44f1dbb436de68048f26fd949b3d7659fa35aed5d3d67a629669bd296cd58ca7 -->

## The next app's shared modules and its own verification tier (PR #3210)

The next connected app now carries the modules every one of its pages is built on, before any page is. The shell shows a wallet control: connect, then the address and network every figure on the page belongs to, and a plain notice with a switch control when the wallet sits on a network the app does not serve. Every "Why?" opens the one help panel on the full explanation of the same line, with a link into the guide page for the reader's mode; the panel closes from its control, from Escape and from a click outside, and returns the keyboard to where it started.

The posture lines under the header now state where figures come from. The index's position is read from the indexer itself and stamped on the page as a block and an age; an index that has not advanced for half an hour is a notice, one that could not be read says figures are unavailable rather than showing nothing, and an index describing a different protocol contract than this build is reported as unknown, never as current. The push rail's own state is named beside it, so a quiet rail is told from a stalled one, and the app keeps polling while push is refused.

Underneath, the modules the pages will share are in place: a refresh policy for a reader's own state (once a minute while the tab is visible, at once on a signal from a transaction or another tab, per block for a figure that gates money), transaction tracking from review to a finish card that names each part's outcome, a mapping from a contract refusal to the reason and remedy a reader sees, and the receipt, finish card, action list and form pieces every route renders. Nothing signs or sends yet.

The app has its own automatic verification tier: a Playwright suite run on every pull request against the repository's current contracts deployed from source onto a local chain, with a stand-in for the indexer and the RPC proxy that is hydrated from that chain and can be put into the stale, unreadable and other-contract postures. The injected test wallet it drives was lifted out of the current app's suite into a shared package, which the current app's suite now binds to its own chain; its behaviour is unchanged. The indexer and agent now also admit the next app's two origins to the push rail and the agent's routes.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` §3.1 to §3.2 and §5. Epic #3180.

_Committed 2026-11-05 14:58 UTC (6a88f2103)._
<!-- assembled-fragment: 3180-alpha05-shared-modules.md sha256=3105aec113dffd9fbbeb70ff59ae8997144eebf1821ab6152614858649c7568f -->

## Website — the consent banner's icon takes its tint from the shared palette

The privacy-choices banner's shield icon sat on a tint of the retired indigo, left behind as a fallback colour when the website moved onto the shared navy/green palette (PR #3199). It now mixes its tint from the brand colour like every other soft surface on the site, so it reads navy in the light theme and green in the dark one.

The website's palette test now also refuses any stylesheet that names a fallback colour behind a brand token, or any of the retired indigo values, so a leftover of this kind fails the website's typecheck instead of shipping.

Advances #3180.

_Committed 2026-11-05 13:33 UTC (7b8caddfb)._
<!-- assembled-fragment: 3180-www-consent-icon-tint.md sha256=25b0aa6ce7fec70ebbc31e4abce84cf62cb7672fcd932d3647ba301b265edc8f -->

## Website — one brand palette shared with the connected app (PR #3199)

The website now draws every brand colour from the same file the new connected app uses, the shared palette in the lib package, instead of defining its own. The owner decided on 2026-11-05 that the website and the app should look like one product, and chose the website logo's navy and green over the indigo both surfaces had been painting their controls with. The app moved onto the shared palette with its scaffold; this change moves the website.

What a visitor sees: in the light theme the primary buttons, links, active tabs, the consent switch and the section eyebrows are navy, the colour of the logo mark; in the dark theme they are the logo's green, with navy text on filled controls. Tints and hover tones are mixed from the brand colour, so nothing in the website's stylesheets names an indigo value any more.

The palette keeps two tokens on purpose: the brand as text (which must read against the page) and the brand as a fill (which must carry its own text colour). The website's filled controls use the fill pair, so the dark theme's green button carries navy text rather than white, which would not have met the contrast floor.

A test on the website's side pins the shared palette against the website's own backgrounds: every rendered brand pair, and the primary and secondary text on the page and on a card, at or above 4.5:1 in both themes. The app has the same test against its surfaces. A brand token retuned for one surface set can fail on the other, which is why each side checks its own, and the test refuses a brand token redefined in the website's stylesheet so the two surfaces cannot drift apart again.

Advances #3180.

_Committed 2026-11-05 12:36 UTC (cf4d8e34f)._
<!-- assembled-fragment: 3180-www-shared-palette.md sha256=fe8a7fb5c5e235e1fb4d2565626914ec99dccb09e329531959b91b9c92e712d4 -->

## Thread — the RL-3 claim-horizon safeguards are proven on Anvil before arming (PR #3211)

The governance runbook required both ratified claim-horizon safeguards to be "verified live first", before the horizon knob is set: the free pre-expiry notice in the in-app notification centre, and the Claim Center countdown. Neither can appear on a chain while the knob is zero, so the step could not be met as written.

A new connected-app e2e spec now drives both on the suite's local Anvil chain. It uses the repository's current contracts, configured as a canonical reward deployment by the same script the keeper's Anvil scenarios use. A real loan produces real interaction-reward entries, and the admin sets a 180-day horizon. The keeper-style touch starts each entry's clock. The Claim Center then states the contract's earliest-removal estimate, and switches to its final-notice wording once the notice period begins. When a touch arms the final notice, the bell shows the final-notice row, and when removal begins it shows the removal row. The whole drive runs inside a chain snapshot that is reverted afterwards, so later specs see the chain and its clock as they were.

The bell rows in that drive are not written by the test. The e2e indexer stub derives them from the chain's real horizon logs with the indexer's own planner. That planner now lives in the shared library, and the indexer re-exports it unchanged, so the drive tests the rule the indexer runs rather than a copy of it. Every other wallet still gets the stub's fixed synthetic feed.

Runbook Step 6 now says what can be checked when. Before arming, the safeguards are proven by this spec, which must be green on the commit the deployed app was built from. Right after arming, in the same ceremony, the countdown is re-verified live on the first entry the keeper touches. The notice cannot be seen live then, because a fresh entry reaches its final notice only a full horizon later. So the ceremony confirms the indexer release and records a follow-up to check the bell when the first notice lands. The notice period is what makes checking after arming safe: nothing can be removed before the owner has had the whole 90 days, and a failed check is answered by resetting the knob to zero.

Closes #3207.

> Caveat: the live bell check is deferred until the first final notice actually lands on the deployed chain, at least one full horizon after arming; it is recorded as a ceremony follow-up rather than performed in the ceremony itself.

_Committed 2026-11-05 14:42 UTC (80ed01fa1)._
<!-- assembled-fragment: 3207-rl3-horizon-anvil-drive.md sha256=8d1501c7a159f58acdd02aabdc142c932647de7c03a1d260510b9ca5f2aee45f -->

## Mesh watcher — carry only the views it reads (PR #3168)

The VPFI recycling mesh watcher used to bundle five complete facet ABI files,
about 300 KB of its 1.1 MB Worker, almost all of it error and event
definitions it never decodes. It runs every five minutes on the Workers Free
plan, which allows 10 ms of CPU per run, and most runs start a fresh copy of
the Worker that has to load all of that again. Live runs were measured at
26 to 37 ms of CPU each.

The Worker now carries only the fourteen views it calls, each copied
unchanged from the compiled facet ABI by a small script. The bundle drops to
about 790 KB, and loading it costs about a fifth less CPU in a local
measurement. What the watcher reads, checks and alerts on is unchanged.

The copy cannot go stale silently. A check refuses any entry that differs
from the current compiled ABI, and it runs in the watcher's CI job (which any
facet ABI re-export triggers) and before every build and deploy of the
Worker. Before this change, a re-export that moved a watched view failed at
the first live run. Now it fails before the deploy. The per-run shape check
the readers rely on still runs as before.

> Caveat: whether Cloudflare counts start-up in the per-run CPU figure was not confirmed; the CPU figure in Workers Observability after the deploy is the measurement that settles how much this saves.

_Committed 2026-11-05 06:25 UTC (973ac5827)._
<!-- assembled-fragment: mesh-watcher-abi-subset.md sha256=c0aeb63e6374e331ec0c5ae99d79e8c547c75af86cd3dad27fab7bbfe5678284 -->
