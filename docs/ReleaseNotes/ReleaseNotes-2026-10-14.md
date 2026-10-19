# Release Notes — 2026-10-14

Most of the day's changes concern loans whose grace period has ended. Both parties now get an inbox alert when a grace window ends, and the Positions page marks such loans "Past grace". A lender can now close one out when its collateral must be sold, and the lender's notice no longer promises an automatic close. The keeper gained a pass that closes these loans itself, including collapsed ones that no venue will quote. It also sends its transactions on each network one at a time, reads its liquidation routes and the swap-venue list from the protocol, and can now run on an always-on machine. Elsewhere, the loan page states that a loan is settled only once it is, the desk's History shows the terms a fill actually executed at, and the indexer has a health route that says whether ingest is advancing.

## Thread — Grace-ended inbox alert (PR #2479)

The inbox now tells both parties when an open loan's grace window has
closed. Until now the calendar reminders stopped at "a loan went past its
due date": nothing told a lender that the loan had become theirs to close
out, or told a borrower that the ordinary repay window was over. The new
entry fires once per due date, during the first week after grace ends, for
both the borrower and the current holder of the lender position.

It is timed by the protocol's own rule rather than an approximation of it:
strictly after the due date plus the loan's grace length, measured on the
chain's own clock rather than the indexer's, which follows the
protocol's configured grace schedule (the default unless governance has set
custom tiers). So the inbox never announces that grace has ended before the contract
considers it ended. Grace ending is a time fact only: a close-out can
still be refused for other reasons (a pause, for one), which is why the
entry defers to the position page. Like the other reminders it
is worded as a fact as of the notice and points at the position page, which
is the authority for whether the loan was later repaid or closed out. It
covers loans whose collateral has no price feed, because it is computed
from the loan's dates alone.

The reminder sweep's look-back widened by that one week, and an
already-announced past-grace loan is dropped from each tick's working set
the same way the earlier reminders are, so it cannot crowd out loans that
still have something to say.

Inbox rows are now written in a few database statements per tick rather
than one per row. A busy tick (many loans crossing a two-sided milestone
together) could previously exceed the database's per-run statement limit,
have the whole write refused, and retry it — and be refused — every tick
after. This applies to event-driven inbox rows as well as reminders.

A follow-up to #2463 (the lender close-out);
no schema change.
<!-- assembled-fragment: 2463-grace-ended-alert.md sha256=d19f51a71eff865af933767cfb0307b1f6a2b1d18cb28b8e01d7ee6a39420d1d -->

## Thread — A lender can close out an overdue loan whose collateral must be sold (PR #2471)

A lender whose borrower missed repayment and the grace period after it could already close the loan out from the position page — except in the commonest case, where the collateral is a liquid token that has not collapsed in value. The protocol only closes those with a list of exchange routes to sell the collateral through, and the app had no way to build one, so the overdue card told the lender the position was eligible and that an operator was needed. Loan 21 on Base Sepolia sat in that state for about 85 days.

The card now builds the route itself. When the lender confirms, the app reads which swap adapters the protocol has registered, asks each one it can reach for a price — the aggregators through the agent's existing key-holding quote proxy, Uniswap V3 through its on-chain quoter, and on testnets the declared mock adapter, which is used only after reading that it would actually pay — and sends the ranked list with the close-out. The adapter positions come from the protocol at that moment rather than from a table the app keeps, which lowers the chance that governance adding, disabling or reordering an adapter misdirects a route; it does not remove it, since the list can still change after the app reads it. The protocol's own oracle-based minimum still binds every sale. The card and its confirmation now say what that route can lead to: sale proceeds in the lent asset, or, if no exchange can meet the minimum, the protocol's fallback, where the lender claims collateral and the borrower can still cure. They also say whether the caller incentive applies to the viewer's wallet. Where the protocol has enabled exchanges on that network but none the app can ask, the card keeps saying an operator is needed; where it has no exchange enabled at all, the card says nobody can close the position by sale until governance enables one, since the protocol then refuses every caller. A confirmation that gets no usable price sends nothing. The aggregators are asked for a price on behalf of their own adapter contract, which is the address that actually performs the swap, and the app checks again for an accepted loan sale after the route is found, just before sending. The agent's quote proxy now answers each allowed app origin with that origin, so a quote request from any of the configured app addresses can be read by the browser.

The rules for building a route — reading the adapter list, each venue's data format, parsing aggregator responses and ranking — now live in one shared library module. The keeper's liquidation quoting uses the same formats and parsers instead of its own copies. Its hand-kept adapter indexes, its missing Base Sepolia entry and its Balancer data source remain open in #2468, along with a keeper pass that closes past-grace loans itself, as follow-ups. Closes #2463.

Before anything is sent, the app now runs the close-out against the chain as it stands and, where the network's node supports the kind of simulation that reports events, reads whether it would end in a sale or in the protocol's fallback. On such a node every way a route can go wrong, such as a quote made for the wrong caller, a router the adapter does not accept, an adapter list that changed while prices were being fetched, or a price under the minimum, shows up the same way, and when the run would fall back the card says so and sends nothing. On a node that cannot run that check, the app sends as before and the card's disclosure that the close-out may end in the fallback is the whole of what is known. The check also cannot catch a route that fails only between the check and the moment the transaction runs. Uniswap V3 now contributes every pool that quotes, not just the best one, so a second pool can act as a back-up. Quotes naming a router the adapter does not accept are dropped, the lowest Uniswap V3 fee tier is now asked too, a deployment with no aggregator keys says so instead of suggesting a retry, an adapter list the app could not fully read is reported as unread rather than as having no exchange, and the caller-incentive note no longer appears when the app cannot offer the action. On the rows where a settlement against an opposing position may happen instead, the card now also says that route pays its submitter a matcher incentive straight away, for the viewer's own wallet. The app no longer asks 0x for a price at all, because 0x prices can be tied to the account that sends the transaction, and for a Safe or a relayed smart account the app cannot know which account that is. The final sale and collateral checks before sending are now read at the same block. The aggregators are now asked for prices with the protocol's own liquidation slippage limit rather than a fixed 6%, the matcher-incentive notes say the incentive can round down to nothing, and the card no longer offers a sale button after a failed refresh of the exchange list. The sale disclosure now also says that if the collateral turns illiquid or its value collapses before the transaction runs, the collateral is handed over directly and the loan ends, and a quote-service answer that carries an error is treated as no answer rather than as a refusal. The card now asks the agent's quote service which aggregators it holds a key for, so a deployment whose service lacks the 1inch key says an operator is needed instead of offering a sale that would be refused, and a route sent without an answer from every exchange asked says it has fewer back-ups before the wallet opens.
<!-- assembled-fragment: 2463-lender-close-out-with-sale-route.md sha256=25ccf2fbcf60d1fc700c6adc12d32ffbea96c14573fc7ed4d7ecb6935d1ba625 -->

## Positions — "Past grace" badge (#2463 follow-up)

A loan on the Positions page whose grace period has ended now shows a "Past grace" badge instead of the generic "Past due", so a lender can see which positions have reached the point where they may be closed out and a borrower can see which loans are past their ordinary repay window. The answer comes from the protocol itself, read for each open loan, because the grace length is set by governance and judged by the chain's clock; a device clock that runs behind cannot hide the badge, and until the protocol's answer arrives the row keeps its ordinary time-based label, and every open row carries a line saying the protocol is being asked whether grace has ended (or that it could not be asked, when the read fails or the device is offline; an earlier answer is not repeated in either case, nor after returning to the page or the tab, or reconnecting, until a fresh read sent since then completes), so that label is not taken as the whole story whatever it says, since the device clock may be behind. That line sits under the row rather than inside the badge, so a health warning in the badge cannot hide it. The answer is re-read every minute while the page is in use (less often once the session goes idle, with a catch-up on the first interaction back, and not at all while the tab is hidden), including after it says grace has ended, because governance can lengthen the grace schedule and reopen repayment. A line under the row explains what it means for the viewer's side, visible on touch screens and to keyboard users rather than only on hover; it says a close-out MAY now be possible and points at the position page, because grace ending is a time fact and a close-out can still be refused for reasons the row does not read (a pause, for one). It never implies only the lender may close the loan out. Follow-up to #2463.
<!-- assembled-fragment: 2463-past-grace-badge.md sha256=1ddee3d2be843dd8359cfbd5bd2e8a8e3dbca2dba362abbfed0fc7f92bf19113 -->

## Loan page — settlement is stated only when it has happened (#2466, #2470)

On an internally matched loan whose claims had not been collected, the "Owed" line read "Nothing — this loan is closed and settled", directly above the button to collect those claims. The protocol settles such a loan only once its claims are collected. The line now says the internal match closed the loan and that it settles once its claims are collected. Translated in the nine translated languages.

Separately, the loan page could briefly show an out-of-date status. It checks the chain directly while a loan is open. Once the indexer recorded the loan as closed, that check stopped, but its last answer was still used. A loan the indexer already knew was settled could therefore show as merely repaid until the page was reloaded. The page now uses a live answer only while the check is running and has not failed, and the status badge, the actions and the claim lines all use that same answer.

Closes #2466. Closes #2470.
<!-- assembled-fragment: 2466-2470-loan-page-status.md sha256=b8096a35843f7fa9cdc0d9102129944c3c89d3b246acd7117be530914ca318ea -->

## Desk History — the terms a fill executed at (#2467)

The desk's History panel showed each past loan's current interest rate and term. Extending a loan rewrites both, so an extended 30-day fill at 5% could appear in History as a 60-day fill at 9%, a market it never traded in. The indexer has kept the executed rate and term since its rate-desk work. It now serves them, and History shows them.

As with the starting principal (#2461), they are served only where the protocol's own initiation event backs both values. A value copied from a loan's current terms, or read from the chain after an extension, is kept for the market charts, which need a frozen figure, but is not shown as history. Each indexer pass re-checks unconfirmed values against the initiation events. Where the terms cannot be confirmed, the row says the starting terms are not available.

Closes #2467.
<!-- assembled-fragment: 2467-executed-terms.md sha256=f70afecc8b69adb954805de825076b066c7650cbc573d0ec5932d41b9791d6c6 -->

## Keeper liquidation routes read from the protocol (#2468)

The keeper's liquidation passes now build their swap routes the same way
the app's lender close-out does, from one shared set of rules. Before,
the keeper kept its own table of which swap venue sat at which position
in the protocol's adapter list. That table was correct only until
governance changed the list, and had no entry at all for Base Sepolia,
so the keeper could not build a liquidation route on the only live
testnet.

Now the keeper reads the adapter list from the protocol at build time.
On Base Sepolia that means it can route through the testnet mock adapter,
once it has checked that the mock would actually pay. Each aggregator is
also now quoted for the adapter that executes the swap. The old code
quoted for the protocol contract itself, which is calldata for a caller
that never makes the call. Aggregator quotes use the protocol's own
slippage ceiling.

A split liquidation now uses only aggregator routes as its legs. The
protocol checks a split's legs only in total, so each leg has to carry
its own price limit, which aggregator routes do and direct pool routes
do not. When an enabled adapter has a name the keeper does not
recognise, the keeper now says so in its log instead of leaving it out
silently.

Balancer V2 is no longer asked. Its only quote source was a hosted
subgraph service whose availability could not be confirmed, so the venue
is left out rather than sent on a guess. Using it again needs a decision
on a reliable source. The liquidity-confidence pass, which only measures
prices, uses the same builder.

The keeper's log now names two conditions it used to fold into "no
route". When 0x quotes through a swap target its adapter has not been
allowed to call, the log says so, even when a back-up venue closes the
loan; that is the signal to rotate the adapter's allowlist. And an
aggregator reply that is neither a quote nor an explicit "no liquidity"
answer is recorded as unanswered rather than as a decline, in the app
and the keeper alike. The deploy scripts no longer require the UniV3
adapter to sit at a fixed position in the adapter list.

No contract change.
<!-- assembled-fragment: 2468-keeper-adapter-roster.md sha256=a1794d3570b0d131c2ad08f0673f6f10c49282a961c32520a08e963302330ef5 -->

## Indexer — a health route that says whether ingest is advancing, and why not (#2469)

When the indexer was published ahead of a database migration, its schema gate correctly paused all scheduled ingest until the migration was applied. The gate said so only in the Worker's logs, so the stall went unnoticed until stale screens did the reporting.

The indexer now answers a read-only health route. For each chain it scans, the route reports the last block it reached and how long ago it got there. It also reports whether this build's migrations are all applied and, if not, names the missing ones. It states facts, not a verdict: what counts as stale depends on the caller, and a chain the indexer no longer scans keeps its last position forever. The route reads only the database, so it still answers when the secrets service, one of the things that can stall ingest, is degraded. Responses are never cached.

A scheduled GitHub check now reads that route every 15 minutes and fails when the Base Sepolia, Arbitrum Sepolia or BNB testnet ingest has not advanced for 15 minutes, or a cursor's timestamp is ahead of the indexer's clock, when the indexer is waiting on a migration (it names the migration and the command that applies it), or when the route can't be read. On the first failing run it opens an issue titled "Indexer ingest stalled", assigned to the operator. While the same condition lasts it adds nothing. If the condition changes (another chain stalls, a migration becomes pending, or one chain recovers while another stays stale), it comments the new problems on the issue and notifies again. It closes the issue with a comment on the first healthy run. A run that fails before it can judge anything opens a separate "Indexer ingest probe not running" issue instead, and that issue closes as soon as the probe produces a verdict again, even an unhealthy one. A failed run alone is not a dependable alert: GitHub notifies only the account that last edited the schedule, and only if that account has Actions notifications turned on. If the ops Telegram secrets are added to the repository, it also posts to the ops chat whenever the issue opens or its condition changes, and as a fallback whenever the issue step itself fails. An undelivered Telegram message fails the run visibly. The check runs on GitHub rather than as a Cloudflare Worker because every Cloudflare scheduled trigger on the account is already taken, and because a watcher inside the indexer could not report the indexer's own crash. Sepolia is not watched: the indexer no longer scans it, so its position stands still for good.

Separately, the indexer's automatic deploy on merge was switched in the Cloudflare dashboard to the package deploy, which applies migrations before publishing. The first merge after that change applied its migration that way. That setting lives outside the repository and could be changed back unnoticed, so the schema gate stays, and this check is the alarm for that cause and any other. The keeper's and agent's automatic deploys have not been checked.
<!-- assembled-fragment: 2469-ingest-health.md sha256=53462b59572c7da82b712b9f899e74616f431e448bbc3e83108876a6266ae060 -->

## Thread — The keeper closes out loans past their grace period (PR #2485)

The keeper has a new pass, `graceDefault`, that calls the permissionless time-based default on loans whose grace period has ended. Until now only health-factor liquidations ran automatically, so a past-grace loan stayed open until the lender pressed the close-out button on its page. With the pass armed, a lender who never opens the app is closed out and only has to claim. The pass runs every five minutes. Each run looks at one network and a bounded slice of its open loans, and attempts one loan, because every attempt costs a quote round, a simulation and a send against a per-run request allowance the keeper's other duties share. Networks take turns and the selection rotates, so a loan which cannot be closed does not hold up the rest, and a backlog of past-grace loans is worked through one run at a time. Each run also has a hard cap of 40 outbound requests, counting reads, quotes and the send. A run that reaches the cap stops before sending and logs that it did. The pass's own cost therefore cannot grow with the length of governance's swap-venue list. The cap bounds this pass's share only. A budget shared by all of the keeper's passes is #2490. A very long list stops the pass from completing an attempt until #2488 makes that read cheaper. A loan that is also below the health-factor line is left wholly to the health-factor liquidation, so no loan has two automatic closers; a collapsed one that no venue will quote is therefore still closed by the lender's card for now (#2487).

It follows the same rules as the lender's close-out card. It skips a loan whose lender position has an accepted sale, or whose sale state the chain does not establish, because closing it would strand the buyer's payment. For liquid collateral it sends a quoted swap route built by the same route builder the app uses. It previews the call and does not send a route that the chain shows would fall into the full-collateral fallback. It does not send while an earlier keeper transaction on that network is still unconfirmed, so a slow close-out is not sent twice. If the network's answer to a send is lost, the log says the outcome is unknown and gives the transaction's hash. It does not record a skip it cannot establish. Just before sending it checks, at one fresh block, that the loan is still above the health-factor line, that the sale state still allows the close, that the collateral amount still matches the quote, and that the previewed route still ends in a sale rather than the fallback. Every loan it passes over is logged with the reason. The sale check now lives in the shared library and is used by both the app and the keeper, so the two cannot drift.

The pass ships dark. It needs its own `GRACE_DEFAULT_ENABLED` secret on top of `KEEPER_ENABLED`, and arming it on the live Worker is a separate owner decision. A loan with no working swap venue still stays open, and the lender's grace-over banner still has to be corrected to say what actually happens (#2484). Closes #2483.
<!-- assembled-fragment: 2483-keeper-grace-default.md sha256=99803ed5b214fcae5c22c3c3fa5a50dd273aeb8491bb9e0b6c7032a0669768a5 -->

## Thread — The grace-over notice stops promising an automatic close (PR #2494)

The lender's notice on a loan whose grace period has ended used to say the default "normally happens automatically shortly after". Nothing guaranteed that. The keeper's automatic close-out is switched on per deployment by a setting the app cannot read, and even where it runs it deliberately leaves some loans open: those with no working swap venue, an accepted loan sale, or collateral that moved after quoting.

The notice now says what is true everywhere. Automatic close-out may be switched off on the deployment, and the app cannot tell, so the lender should not wait for it. The overdue-loan card on the same page, when shown, says whether the lender can close the loan out now and what stands in the way if not; the notice does not promise self-service, because the card has blocked states with no action. Anyone else may close the loan first. Once a close-out has run, the page shows what the lender can claim and when; it no longer says the loan closes before the claim, which is backwards on the fallback route, where claiming is what ends the loan. The comment above the string, which still said the app had no close-out action, now matches the card that exists. All nine translated locales carry the new wording.

Closes #2484.
<!-- assembled-fragment: 2484-grace-over-lender-copy.md sha256=6ec3429a478fa42edb66ce25ab488b8875a140eeea5726f810a293ff5a8cc16d -->

## Thread — The keeper's transactions on one network go out one at a time (PR #2495)

Every signing duty of the keeper (matching, liquidation, lifecycle upkeep, the grace-period close-out, reward remittance and acknowledgement, commitment reports, the liquidity-confidence write and the daily oracle snapshot) signs with the same key, and each runs as its own task. Two of them sending on the same network in the same tick could both read the same pending transaction number, so one was refused or replaced the other even when they acted on different loans.

Every send now goes through one queue per network and key. A send waits for the previous one to be broadcast or to fail, then reads the pending number fresh. The queue also remembers the number after the last broadcast the network accepted, for one minute, so a load-balanced RPC that has not yet seen that broadcast cannot hand out the same number again. A send that fails before it is broadcast, such as one whose gas estimate reverts because someone else already closed the loan, records nothing. So does a send the network explicitly refuses, for example for lack of gas funds. A send whose answer never came back, or that the network refused because the number is already taken, keeps its number reserved for that minute instead, because the network may have relayed it and reusing the number could replace a keeper action already in flight. That is why viem's built-in nonce manager was not used: it reserves a number before estimating, so a reverted estimate would leave a gap that stalls every later keeper transaction on the network.

The queue lives in one running copy of the keeper. Two copies overlapping, which at a one-minute schedule needs a run still sending a minute after it started, are not ordered by it. A send from one can then take the same number as a send from the other, and if it pays a higher fee it replaces the earlier one on the network. The replaced action is delayed, not lost: its duty finds the work still undone and sends it again on a later run, but until then the keeper's log says it was sent. Ordering across copies needs a reservation shared between them, which the keeper does not have yet. The queue covers both the keeper's plain sends and its contract calls. The grace-period close-out keeps the same request cap: the nonce read replaces the one viem would otherwise have made.

Closes #2486.
<!-- assembled-fragment: 2486-keeper-submission-queue.md sha256=47aa2e9f15612d0087473c3db19e88df1bf59ef5d457938c43f299d2b1369ea3 -->

## Thread — The keeper closes collapsed past-grace loans that no venue will quote (PR #2499)

A past-grace loan that is also below the health-factor line belongs to the keeper's health-factor liquidation, and the grace-default pass leaves it alone so the two never race. That left one case closed by nobody automatically: a loan whose collateral no swap venue will quote at any size. The liquidation needs a route, and the grace-default pass would not touch it, so only the lender's close-out card could close it.

The liquidation now closes that loan itself. When every listed venue was asked about the full, half and partial sizes and every one declined, and the chain reports the loan as past grace, it sends the time-based default with an empty swap list, which lets the contract take its in-kind branch and hand the collateral to the lender. It uses the same attempt the grace-default pass uses, with the same sale interlock, unconfirmed-transaction hold, health-factor re-check, collateral re-check and preview at one fresh block. It sends only when the preview shows the call ends this loan as a default with no swap and no internal match. An empty quote list alone is not enough: if any venue gave no answer, could not be identified, or could not be asked by the keeper, the loan is left open, because a route might exist there and an in-kind close cannot be undone. A loan whose collateral is liquid but unquotable makes the contract refuse an empty list, so the preview fails and nothing is sent; that loan still waits for a venue or for the lender's card. The shared preview now also reports whether the call ends the loan and whether an internal match ran, so the keeper can tell a no-swap default apart from other endings.

This behaviour is part of the liquidation duty and so is armed by the keeper-wide switch, which is off on the live deployment. Closes #2487.
<!-- assembled-fragment: 2487-keeper-in-kind-close-out.md sha256=82b58fdc904066ab06a0db2dfb9187acb51a2a877ff24b8013102e900aeee6dc -->

### Keeper reads the swap-venue list in one request (#2488)

When the keeper builds a close-out route, it reads the Diamond's list of swap venues and, for each venue, its name and whether it is switched off. It used to read each name and each switch separately: two requests per venue on every route build, for both the liquidation and grace-default passes. With a long venue list, those reads alone could use up the request allowance a keeper run shares with its other duties.

The keeper now reads every venue's name and switch in one batched request. A route build's cost no longer grows with the number of venues. If that batched read fails, the keeper does not fall back to one request per venue. It treats the list as incomplete, which is what it is, and reports it that way. The app is unchanged.
<!-- assembled-fragment: 2488-adapter-roster-one-read.md sha256=f4586dee3acef1fd6d667892fae458d86c35ea4f829a31c97c61f8ddb8147674 -->

## Thread — The keeper can run on an always-on machine (PR #2502)

The keeper is too expensive to run every minute on the Cloudflare Workers Free plan, so it will move to a separate always-on machine. This change makes that move a configuration step rather than a rewrite. What a tick does now lives in one module that both hosts run. The Worker's scheduled handler uses it, and so does a new Node process under `apps/keeper/host`. That process fires on each UTC minute boundary and passes that boundary as the tick's scheduled time, so every duty runs on the same minutes it would on the Worker. The duties, cadences, arming switches and safety gates are therefore identical on both hosts.

The machine uses the same shared database as before, reached over Cloudflare's D1 HTTP API. The adapter supports the operations the keeper uses, sends a batch as one request, never retries a write whose answer was lost, and never puts the API token in an error. Configuration is environment variables under the same names the Worker uses, plus three database settings. Because a machine has no deploy step, each tick first checks the database for every migration the code was written for, using the indexer's own gate. It declines the tick by name until they are all there. Ticks on the machine never overlap, and the log names any duty still running from the previous minute. Stopping the process waits for the tick in flight to finish.

Nothing is armed or moved by this change. The Worker stays unscheduled, and running the keeper on a machine needs the machine itself and the owner's decision on arming. The setup guide states that only one copy may run per signing key. It also states that the database token Cloudflare issues can reach every database in the account, so it must be kept like the signing key. Closes #2500.
<!-- assembled-fragment: 2500-keeper-machine-host.md sha256=00975e4551b4537c6b26a87697f5c7edd53227a09468d17dbec358117767d333 -->
