# Release Notes — 2026-10-19

Today the arming-fee and priority-routing changes reached the three testnets, and service capacity was switched on there. A new in-place refresh brought each testnet Diamond up to date by measuring which facets' code differed from the build and replacing only those. Each Diamond then had its capacity deposit escrow bound and published, the channel switched on with a 2% arming fee, and its first Solver and Keeper capacity curves set. The priority-routing perk stays unpriced until its delivery is verified. Separately, the keeper now keeps scanning past a spent fill capacity for intents a priority credit can carry, and every keeper pass honours its run deadline. The sanctions work recorded the testnet delisting timelocks, and its services now run when started through their release link.

## Thread — service capacity is switched on across the testnets, with the 2% arming fee (PR #2581)

On 2026-10-19 the three testnet Diamonds, Base Sepolia, Arbitrum Sepolia and BNB testnet, received the arming-fee bounds and the priority-routing perk through an in-place refresh of only the facets whose code had changed. Each Diamond then had its capacity deposit escrow bound, the service-capacity channel switched on, and the arming fee set to 2% of newly armed principal, the intended starting rate inside the fixed 0.5% to 10% bounds. The owner approved each of these steps.

Each Diamond also received its first capacity curves, at testnet starting values the owner approved. A solver's free allowance holds at most twenty fills and refills at twenty an hour. A keeper's holds at most sixty actions and refills at one a minute, matching the keeper's one-minute passes. An operator seen for the first time starts with a single action, not a full allowance, and its allowance then builds toward that ceiling at the refill rate. On both roles, a refundable deposit of 10,000 VPFI raises the ceiling and the refill rate to four times the free tier, continuously and in proportion below that. These are starting values: a later change resets each operator's allowance at its next use rather than re-crediting it, so they can be retuned once real traffic shows how they fit.

The priority-routing perk stays unpriced, so it cannot be bought. Its starting price is decided at 2 VPFI per credit, to be set only after the keeper change that delivers it ships and a fork check confirms that a credit is spent exactly when a fill would otherwise be refused. The deployment artifacts, the per-chain deployment records and the consolidated deployments file record the refreshed facet addresses, the bound escrows and every activation transaction. Refs #1219, #2559, #2576.
<!-- assembled-fragment: 1219-testnet-service-capacity-on.md sha256=dbae9a224a9b1bf5567e82e5a02fc6a8032ec3dea41aabfcb15e29fa22fc1955 -->

## Thread — Delisting timelocks recorded on the testnets (PR #2584)

The sanctions delisting timelock is now deployed on Base Sepolia and on Arbitrum Sepolia, one for each chain's rehearsal sanctions list, and both are recorded in their deployment artifacts and the exported deployments bundle. The delister service installed from this commit therefore finds them without any hand-configured address. On both chains the admin owns the timelock, the delister bot's own key is its only proposer, and proposals wait the default 48 hours. The timelock was made a remover of the list in addition to the existing remover (the testnet Safe on Base Sepolia, the admin on Arbitrum Sepolia), and the existing remover keeps its direct delist.

Neither timelock has a RedStone check yet, so every execution refuses until the cross-chain clearance wiring is done. Until then the delister proposes nothing and reports that the delistings await the existing remover. The Diamond screens against neither list, and nothing a user sees changes.

Refs #2443.
<!-- assembled-fragment: 2443-rehearsal-delisting-timelocks.md sha256=6d2f2a5b37d7d7c588193e758b1d6b2ac09c7ebf3b2bb84d23cc8b4e1b2b9cca -->

## Thread — Sanctions services run when started through their release link (PR #2586)

The first install of the two sanctions services on the keeper machine found that neither would have done any work. The machine starts each service through a link to the installed release, and each script checked whether it was the program being run by comparing two paths as written: one through the link, one to the link's target. They never matched, so every run skipped its work, exited cleanly and reported success, with no alert and nothing in the failed-units list. The services and the offline diff tool now ask Node itself whether they were started directly, which compares no paths, so neither a link nor the installer repointing it while a run is loading can stop a run. Node gives that answer from 22.18, which the installer now requires. On an earlier Node, importing the scripts still works, as the tests do, and starting one fails loudly instead of skipping its work. No run had sent anything, and no timer had been enabled.

The installer also left each new release folder readable only by root, so the services' own user could not load anything from it. It now opens the release on every install, which also repairs a release kept from an earlier install. Its check used to run as root from the real folder and only when a release was first built, which is why it caught neither problem. It now runs on every install, a rollback included, and runs each service's check the way the machine runs that service: as a throwaway user, with an empty environment, through a link and without network. It also requires the check's success line. A release with either problem stops the install and leaves the running release in place, and that includes a rollback to a commit from before this fix, whose services could not run. The runbook now also says that a run which writes no report has failed, whatever the service manager says.

Refs #2443.
<!-- assembled-fragment: 2443-sanctions-services-entry-point.md sha256=37bef515211ef93bc61e757b792150282df4f9dd2f8b3ce2395b01d21ebeaeb0 -->

## Keeper: a spent fill capacity no longer ends the intent pass for credit-backed intents (#2564)

**What changed.** When the keeper's own fill capacity was spent, its auto-lend intent pass used to stop at the first refusal, so it never reached a later intent that a priority-routing credit (#2550) could still fill. Now a capacity refusal ends only the ordinary intents for the rest of that pass. For each remaining intent, the keeper asks the contract whether a credit unlocks it. That is the same check the fill itself makes. The keeper previews and fills only those intents. The shared per-tick limits on previews, submissions and time still apply. A capacity refusal found during offer matching carries over too, because both draw on the same solver capacity.

**On chains without the perk.** None of the testnet Diamonds carries priority routing yet. On those chains the keeper treats the missing check as "no credit unlocks this", says so once in its log, and fills nothing more that round. So the change is safe to ship ahead of the contract.

**Why.** This is the keeper precondition for arming the perk (design: "Pricing and arming", precondition 3). Without it the perk's benefit would never be delivered, so it must not be sold.
<!-- assembled-fragment: 2564-keeper-priority-scan.md sha256=a0804e94dc9b9f460e5e6f9593728fafa41d22f048e098164d8b1e2178a8be58 -->

## Keeper — every pass's sends honour its run deadline (#2572)

Every keeper pass now hands its run deadline to the send queue, and the queue
will not build a signing wallet without one. Before this change only the
delivery-proof, remit-acknowledgement and sanctions-hold passes stated a
deadline. The liquidator, the matcher, grace-default, auto-extend, the
reward-budget remit, the commitment report, the liquidity-tier relay and the
daily oracle snapshot did not, so a send from any of them could wait behind
another pass on the same key and then be signed after its own run was over.

A run's deadline is its scheduled minute plus its cadence, less a thirty-second
margin. A send whose turn in the queue comes after that point is refused, and so
is one whose preparation runs past it, at the last moment before broadcast. No
nonce is spent and nothing reaches the network, and the work is picked up by the
next run from fresh reads. (A send refused at that last moment may already have
been signed locally; the bytes are discarded, never sent.) For the liquidator and the
matcher this is a deliberate behaviour change, chosen by the owner: a
liquidation or match that would have been signed late, priced from old state,
now waits for the next one-minute run instead. Passes that loop over loans,
days or mirrors also stop asking for more work once the deadline has passed,
and say so in the log, rather than queueing sends that would be refused.

The check lives in one place: the submission slot every keeper transaction
passes through, whether it goes out through the queued wallet or through the
keeper's own prepared sends (the internal-match liquidation and the in-kind and
grace-default close-outs). The slot needs a deadline to run at all. The type
system makes every pass state it, and the slot refuses at run time a missing,
non-numeric or infinite deadline, so a caller outside the typechecked sources
cannot switch the check off by leaving it out. A refusal is recognised however
the signing library wraps it, and the liquidation routes that catch their own
send failures hand it on rather than reporting it as their own failure. Every
pass logs such a refusal the same way, as "deferred to the next run: the run
deadline passed before broadcast, so nothing was sent", never as a
failed broadcast, so an operator reading the log is not sent looking for a
transaction that was never made. Real failures keep each pass's existing
wording. The fallback deadlines three passes used when no tick was supplied are
gone. Closes #2572.

Two passes needed more than the send check. The liquidity-tier relay now also
stops starting new assets and chains once its deadline passes, so a slow quote
source cannot hold back the next run's fail-safe demotions. When a tier change
it decided on is not sent, for any reason, it keeps the evidence that qualified
the change, so a promotion is retried next run instead of starting a new
qualifying window. The daily price snapshot is the one pass whose sends carry a
later deadline: an hour before the end of the UTC day being captured. The pass
acts only in the first ten minutes of the day, so a capture refused at its last
run's deadline could never be retried and the day's price would be missing for
good. Nothing in a capture goes stale within its day, because the Diamond reads
the prices when the transaction executes. The hour is left for inclusion: the
Diamond files a capture under the day of the block that mines it, so one mined
after midnight would fill the next day's slot. The keeper now records the day
the mined block actually filed it under, not the day it meant to capture, says
so in the log when the two differ, and records nothing for a capture that
reverted.

A deadline only defers work if the next run can reach it, so every pass that
works under one follows three rules. Chains now run side by side rather than one
after another, so a slow chain cannot use up the window of the chains after it.
A list walked in a fixed order (the liquidator's loans, auto-extend's loans,
the tier relay's assets, the reward-budget remit's mirrors) starts at a point
that moves each run, so the deadline never cuts off the same tail every time.
Every scan that reads a list in pages (the liquidator's and auto-extend's
loans, the tier relay's asset discovery, and the matcher's offers, lender
intents and repaid intent loans) moves its start by item, not by page, spread
evenly over the list from run to run, so a run that stops partway through its
first page does not leave the rest of that page unreached. For the tier relay
this also changes which assets its per-run cap admits, which before always came
from the start of the book. And a pass that reads before it sends (the
liquidator's scan, the commitment report's entry scan, the reward-budget
remit's planning, the tier relay's asset discovery, the matcher's listings and
offer reads) stops reading early enough to leave its sends ten seconds, and
acts on what it read. The tier relay and the matcher read each page's details
before listing the next page, so a run stopped partway always has something to
act on.
The commitment report also records how far it got when a batch is not sent, so
the next run continues from there instead of repeating the same scan. A scan stopped that way acts on what it read and is not
reported as complete. Auto-extend now acts on each page of loans as it reads it,
rather than reading the whole book first. When a tier change is sent, its
transaction is logged before any bookkeeping, and a bookkeeping failure no
longer stops the other assets. Evidence gathered toward a promotion now counts
only while the chain is still at the tier it was gathered at. The grace-default summary
now counts the loans it actually attempted separately from the loans it picked,
so a run the deadline stops early does not report an attempt it never made.
<!-- assembled-fragment: 2572-keeper-send-deadline-every-pass.md sha256=76926dd706d5ff374e494e66350defa80a068f1c677e76d9d30f327ceadd1347 -->

## Thread — a testnet refresh that touches only the facets whose code changed (PR #2578)

Testnets could already be brought up to date in place, but only by redeploying every one of the Diamond's facets. That was deliberate: a shared library is compiled into many facets, so a change to it reaches facets nobody edited, and a subset picked by reading the diff would leave the Diamond running two versions of one rule. The new refresh keeps that safety and drops the waste. It builds every facet of the current tree locally, compares each one's executable code with the code the Diamond actually runs for it, and redeploys and re-cuts only the facets that differ. A facet that compiles in a changed library therefore differs and is refreshed, while a facet whose code is byte-identical keeps its address. The comparison ignores the compiler's metadata, which changes with any edit to any imported file, even a comment, while the code that runs does not.

The run follows the same discipline as the complete refresh. It refuses outside the testnets and for a key that does not own the Diamond, pauses first, cuts each changed facet whole in a single transaction, cuts the reward-transport facets that must change together in one transaction first, removes any route the new code no longer installs, and restores service only if its own pause was the only change. It then checks that every selector of every facet reaches this tree's code. That check is what lets it carry the custody activation record forward: the record is re-stamped only when it was current before the run, because the Diamond was then a complete cut before and is proven complete after. A live broadcast must name the measured set in advance, using the list the dry run prints, so what is broadcast is exactly what the operator reviewed. It does not run the complete refresh's migrations or proxy upgrades; a change that needs one is rolled out by the complete refresh.

The first use, on 2026-10-19, refreshed ten facets on each of Base Sepolia, Arbitrum Sepolia and BNB testnet: the five touched by the arming-fee and priority-routing changes, three that compile in the service-capacity library, and two reward views. Every other facet matched and kept its address, and the retired arming-fee floor setter was removed. The two reward views are worth noting. In the dry run on the feature branch they matched the live code; built again on main, with a different build cache, they did not. Under the compiler's optimizing pipeline, a contract's bytes can depend on what else was compiled in the same run. The script handled this the way it was designed to. The live broadcast's stated set no longer matched what it measured, so it refused before sending anything. It ran once the stated set was updated to the ten it measured on main. Redeploying a facet whose logic is unchanged is harmless; missing a facet whose logic changed is what the measurement rules out. Closes #2576.
<!-- assembled-fragment: 2576-refresh-changed-facets.md sha256=20ad4356925a3e7b8fe3614a4141b6051f57fc59e8602c594518ba2695550013 -->

## Thread — each chain's service-capacity deposit escrow is published with its deployment (PR #2585)

Binding a chain's service-capacity escrow creates a dedicated holder contract that will custody operators' refundable capacity deposits. Until now its address could be found only by asking the Diamond. It now appears in each chain's deployment artifact and in the consolidated deployments bundle, alongside the reward custody holder, so monitoring and explorer tooling can find it the same way.

Binding and publishing are separate steps, as they are for the reward custody holder. The operator binds directly while the admin key holds the role, or stages the call for the Timelock after governance handover. Only once the bind has confirmed is the address published, from the address the Diamond itself reports. An address that existed only in a pre-broadcast simulation can therefore never reach the artifact, and a chain that is already bound can be published without sending anything. The escrows bound on Base Sepolia, Arbitrum Sepolia and BNB testnet on 2026-10-19 are published this way. Closes #2583.
<!-- assembled-fragment: 2583-record-capacity-escrow.md sha256=580b83466ec8bd86b66ee632a942e287725241e8dded98ec8a04009c4a1b1d8a -->
