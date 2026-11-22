# Release Notes — 2026-11-19

A large day: 68 changes reached main, most of them in the contract batch
that prepares the next fresh testnet deploy, with the apps, the indexer and
the keeper following it. The main themes:

- Protected accounts gained a recovery address and clawback, selling or
  handing over a locked position, a Ready balance, and events that name the
  account and report role changes. Vault code can no longer run brand-new
  code on its emergency route, and every move runs inside a guarded action.
- Lending and borrowing gained the rate reference with market-linked rate
  limits, the instant market's Available figure, Borrow now, lending with no
  end date, standing instructions from your own vault, and the Auto-lend
  pause for a moving price.
- Fees now follow the new levels: 10% of interest, an initiation fee that
  depends on the term, and integrator and referral shares of it.
- The Terms of Service are enforced by the contracts, and version 4 adds the
  lending risk line.
- Safety fixes cover position sales, collateral concentration, frozen
  addresses, failing swap lists, offers left open on a closed loan, and
  position tokens, which are approved one at a time and never pledged inside
  the platform.
- The deploy, backup and CI tooling closed the gaps the last fresh deploy hit.

## Thread — Early close with a sanctioned stored lender: confirmed fixed and now tested (branch, no PR yet)

#1124 recorded that a sanctions flag on a loan's stored lender would block the borrower's direct early close, because the lender's vault was looked up through the sanctions-screened route. The fix waited for room in the preclose facet.

Both legs have since been fixed without that wait. #3178 resolves the lender's vault as a receiver on the token-loan payoff, and the rental prepay shares go through a separate close-out host. The preclose facet was also split in #3410, so it now has room to spare. This change adds tests that close a token loan and an NFT rental early while the stored lender is flagged, and removes the code comments that still described the old gap. The payoff lands in the lender's own vault, behind the usual claim screen.

Closes #1124.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 1124-preclose-flagged-lender.md sha256=1aba3c077607b4f8f623b19a73b14682d62a00d6f20aeac67303563d4a87c25c -->

## What happens if, on every offer you take (#1208)

When you take an offer, as a borrower or as a lender, the review now has a short "What happens if" section. It is labelled as an illustration, not a forecast, and every figure in it is for this loan.

It covers three cases. The first is the collateral price falling 30%: the section shows what that does to the loan-to-value, compared with the liquidation threshold the loan would carry, and roughly how far the price can fall before liquidation starts. If one of the assets has no protocol price, it says that no price-based liquidation applies. If a figure could not be read, it says so instead of guessing. The second is repaying late: a late fee is added, and once the grace period for this term ends, anyone can start the default. The third is repaying early: either the whole term's interest is still owed, or, on a pro-rata loan, about half the interest is owed halfway through the term. The initiation fee is not returned.

The late fee's amount is not shown yet, because the protocol does not publish its schedule as a figure the app can read. Floating-rate loans and instant-market groups get their own cases when their reviews arrive.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 1208-what-happens-if.md sha256=d9f134e0ba8c3d8336ac7c07f0278d2300119bf4aab97542e095ffa415bdb899 -->

## Restore tool: stricter checks on the legal-hold record (#1489)

Before restoring the legal-hold register from a backup, the restore tool now
also checks that every timestamp and record number looks like one the live
service writes, that the action history is in the order it was written, and
that every past disclosure decision (not only the latest one) is in the
service's own format. A backup that fails any of these is refused with a
per-row explanation instead of being restored with a quietly altered history.

_Committed 2026-11-19 17:23 UTC (12f2f5d22)._
<!-- assembled-fragment: 1489-restore-legal-hold-validation.md sha256=cda7493f6f26ccc6d42d7a6ad34bc29befcf8b56c9de249e0bae60ad34301e45 -->

## Every deploy-side reader takes the settings file as data (#1939, part 1)

The in-place testnet redeploy carried its own reader for the contracts
settings file, and it exported every name it found, including the names other
programs treat as startup hooks. It now uses the same data reader as the other
deploy wrappers, which refuses those names and exports nothing unless the whole
file parses. Its existing rule is kept: a value the operator already exported
still wins over the file.

The mainnet multisig runbook and the interaction-days script told the operator
to load the file by executing it in their shell. They now use a new small
wrapper that reads the file as data and then runs the one quoted command it
is given. It has no interactive mode, because an interactive shell would run
prompt hooks taken from the file. A test covers the reader's two modes and the
wrapper, including that a refused line is never printed, and runs on every
pull request.

_Committed 2026-11-19 22:55 UTC (427ef6091)._
<!-- assembled-fragment: 1939-env-read-as-data-everywhere.md sha256=6bf3f5c3d9124b7e703dee7ce13a28273733f1b1955c09f701d78ad6931ab7a3 -->

## Thread — the recycling backing reading says whether its block was confirmed as settled

The recycling account publishes the platform's backing reading pinned to one block, and publishes that block number so a reader can check the figures against the chain at that block. The indexer asks the chain for a block it reports as settled. When no such answer comes back, the reading is still taken, at an estimate a fixed number of blocks behind the newest one, because withholding it would wrongly suggest the chain had gone quiet. Until now only the operator log said when that happened; the published figure and the page that shows it presented an estimated block exactly like a confirmed one.

Each stored reading now records whether its block was confirmed by the chain or estimated, through a new shared database migration (0104) that adds one nullable column. The indexer publishes that answer beside the block number on the recycling metrics response, and the analytics page answers "Block confirmed by the chain as settled" with one of three words under the reading's block: Yes; No, estimated (followed by a note on what a deeper chain reorganisation would mean for the figures); or Not recorded. Readings taken before the migration read as not recorded, never as confirmed. The app treats a response without the answer as malformed rather than guessing one. The page names no cause for an estimate, because the same fallback is taken whether the provider lacks the request or briefly failed; the provider's own reason stays in the operator log.

The migration is additive and the read route tolerates a database that has not applied it yet, serving every block as not recorded and warning the operator by name. The scheduled capture only runs once every migration is applied, and if it ever met the old table it refuses to store the reading rather than write a block with no record of whether it was settled. The copy is translated into every shipped language; the translations have not yet been reviewed by speakers. The functional spec is not changed by this work: its update is left to a separate, owner-reviewed change.

A fixed rule now decides whether a new reading replaces the stored one. A reading on a confirmed block replaces one on an estimated block even when its block is lower. Between two readings of the same kind the block only moves forward, as before. A reading on an estimated block never replaces a confirmed one that is still fresh enough to publish; once the confirmed one is past that point, a newer estimate may replace it, so the reading does not go dark. The rule uses only the stored reading's own block, its settled answer and when it was taken, so it needs no further database change.

Closes #2210

_Committed 2026-11-19 16:38 UTC (8cc82e6f9)._
<!-- assembled-fragment: 2210-backing-block-settled.md sha256=96ce4f20642d8e83d0030f80b3ba6809c0ce1fbc3cbdb6a644eba5cf8efc6274 -->

## Thread — reward and recycling ledgers check their one-time work once per pass

Since the indexer began scanning one block at a time, the reward loop-closure ledger and the recycling day series each re-read their "has the one-time replay already run" flags for every block that carried an event, even though the scan pass had already run those same checks once, at its start. In steady state that was three extra database reads per event block, and the platform's per-invocation query budget is what limits how many blocks one pass can finish.

The two per-block writers no longer repeat the checks. They rely on the pass's opening step, which already runs every one-time replay before any return and before the pass records any activity row, so the ordering rule the replays depend on is unchanged. A block with none of a ledger's events now costs that ledger no query at all.

No figure, row or published number changes: both ledgers stay exactly-once through their own dedup tables, and a pass that runs out of room still stops at a block boundary. A structural test now pins that each writer is called only after the pass's opening checks, and new tests confirm the writers read no one-time flag per block. The checks still run once in every pass, after the pass has confirmed which deployment it is indexing and before its first block, and nothing about them is remembered from one pass to the next: a test drives a pass, a deployment reset and the next pass, and the checks run again after the reset.

Closes #2835

_Committed 2026-11-19 16:38 UTC (8cc82e6f9)._
<!-- assembled-fragment: 2835-ledger-checks-once-per-pass.md sha256=c58f50427d2661f9d68cff14d05aea83b1ae3a2055390c61f9bff880ae1c9245 -->

## Backup retention: one recovery floor, derived against the daily watcher (#3158)

The minimum time a superseded backup stays recoverable after it is hidden was
worked out against the old weekly health check, which only fully inspected the
newest month. That left the monthly tier on a stricter floor of 31 days while
the daily tier sat at 8.

The daily backup watcher now lists every stored version of every tier, so an
overwrite of any retained month is caught on its next run. Both tiers now share
one floor of 8 days: up to three days to notice (one missed run plus the
scheduler's delay), four for someone to save the old copy, and one spare. The
bucket's actual retention rules are unchanged; the monthly tier still keeps 31
days, now above the floor instead of at it.

_Committed 2026-11-19 16:14 UTC (0a55c922f)._
<!-- assembled-fragment: 3158-backup-recovery-floor.md sha256=67140b95a069e808c0c900c75bfc336a30a71bb5ae3671d297939142a61be29b -->

## alpha05: the Terms come before the wallet, and the wallet records its acceptance (#3734)

Pressing Connect in the new app now shows the Terms of Service in force first: the version, the whole fingerprint of its text, the link pinned to that version, the privacy notice and the key risks, with a box to tick. It says plainly that connecting a wallet means agreeing, and that the agreement is recorded on-chain. The wallet list opens only from "Agree and connect". "Not now" connects nothing. Where no Terms are in force, the wallet list opens at once.

As soon as a wallet connects on a network whose Terms it has not accepted, the app asks it for its own acceptance transaction. That happens on a first connection, on another network, and when a new version is in force. The acceptance moves no funds, and the wallet pays only the network fee. Owner decision 2026-11-18: there is no free signature, and nobody records an acceptance for a wallet. Until the acceptance is read back from the chain, the app shows nothing of the wallet. A wallet short of gas is told the fee it needs and what it holds.

A wallet that does not accept can disconnect, or choose to only close out what it already has. That covers repaying, closing, adding collateral, claiming, withdrawing and cancelling, which the Terms never stand in the way of. A standing notice says so. Every action that takes on a position still asks for the Terms first, and the contracts refuse it as well.

The app follows the protocol's two numbers per network: the latest Terms version and the minimum one that still counts. After a small update, a wallet that is still current sees a quiet line and may accept the new text if it wants to. Before a material change, the wallet sees the date and what would stop on it, and can put the acceptance off until then. A wallet accepting during that window accepts both versions in one transaction. Settings names the version that counts and anything due by a date.

During such a notice, the app also lists the other networks where the wallet has an open offer or an active Auto-lend that would stop, and walks through them one network at a time. Each network is read on its own; an acceptance on one never counts for another. The list says that loans set to extend and standing instructions are not checked there yet.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3180-alpha05-terms-at-connect.md sha256=19ac9cdac55263847c0f3c99fa5aac78cd359e18eb08e47cf296dc84f2848bcb -->

## Backup tools — Backblaze API version 4, one shared client (PR #3794)

The off-chain backup tools now sign in and call Backblaze on its native API
version 4. A key made with today's Backblaze command line is refused by the
version 3 sign-in the tools used, which is what forced the 2026-11-06 restore
drill to mint its ledger read key by hand. Every older key still signs in on
version 4, so nothing needs to be re-issued.

Version 4 reports a key's bucket restriction as a list of buckets. The rule
every tool applies is unchanged in intent and now covers the new case too: a
key may run a job only when it is confined to that job's one bucket, holds no
capability outside the job's allowlist, and has no name prefix. A key
confined to several buckets is refused like an account-wide one.

The three older scripts (the archive bucket setup, the baseline finder and
the lifecycle tool) now use the same shared client as the watcher and the
decrypt tool, so host pinning, retries and the reading of a key's scope live
in one place. The two setup scripts reuse an existing key only by one shared
rule, and create keys with the version 4 bucket list.

The restore runbook now gives the command that creates the ledger read key,
with a one-day expiry, and says why the console's "Read Only" key is refused.

Closes #3222. Closes #3032.

> Caveat: the archive bucket setup script is checked by its shared helpers' tests only; it provisions a real account and was not run against one in this change.

_Committed 2026-11-19 15:53 UTC (9a537d544)._
<!-- assembled-fragment: 3222-backup-tools-b2-api-v4.md sha256=16aa3e56136d3c777aeec54f1962543fa30962e4426c4e4453d8f5ca8ae560d1 -->

## alpha05: a recovery address comes before protected mode (#3246 part 2)

The protocol now refuses to switch protected mode on until the account has a recovery address, set or waiting. That address is the one place a clawback of a locked account can pay. The new app's Vault page now shows the account's recovery address in its safety card: the one in force, one still waiting and the date it comes into force, or none. "Turn on protected mode" is offered only once one is set or waiting, and the card says why when it is not. An account with no vault creates it first, because the vault keeps the address.

Setting the address takes two wallets, because the vault needs both consents in one transaction: the owner asks, and the address proves that someone controls it. The owner types the address, and the card refuses the owner's own wallet, its vault, the protocol's contract and the current address. The card then gives a link. The recovery wallet opens it on the Protection page, sees which account asks and on which network, and signs a proof. Signing moves nothing and costs nothing. It gets a link back, valid for seven days. The owner opens that link, and the card reviews the request like any other safety action. The review states the address, when it comes into force (twice the delay for a first address, 30 days for a change), what it replaces, and that a clawback pays nowhere else. The request is sent only after the protocol's dry run passes.

The connected app gets the same step, with the same link format.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3246-alpha05-recovery-address.md sha256=00ca67d4b747f4a7c7f48e6363632cfd933e830ddf463412cd0ba1bc10662fea -->

## App — the recovery address step on Vault protection (#3246 part 2)

Protected mode now refuses to switch on until the account has a recovery
address, the one place a clawback pays. The connected app had no way to set
one, so "Turn on protection" failed for every account. The Vault protection
page now has a Recovery address step before it, and the switch-on button
stays unavailable, with a sentence saying why, until an address is set or
waiting.

The owner names the address and gets a signing link for it. The recovery
wallet opens the link and signs a proof that it is controlled. Signing sends
no transaction, so a cold or empty recovery wallet needs no gas. It then gets
a link back, and the owner opens that link and sends the request. Both links
use one parameter format, defined once in the shared library and used by
alpha05 too. Before sending, the page checks that the proof belongs to this
account, vault and network, that the named wallet signed it, and that it has
not expired or been used, and it states how long the address will wait. A
first setting waits twice the payout delay, and a change waits 30 days. The
card shows the address in force and any waiting one with the time it comes
into force, and the owner can cancel the waiting one.

Starting a clawback is not in the app yet, and the card says so.

The protocol console's matcher fee row now says what the rate applies to:
the initiation fee's part above the treasury floor, counted before any
referral cut.

The fork-tier spec for protection drives the whole hand-off with a second
test wallet. It does not seed the address on chain.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3246-app-recovery-address-step.md sha256=f6afc63cff564104dae4692ae806ac0fb88d7f32a884f07bdf278dac97274cb7 -->

## Protected accounts — recovery address and clawback (#3246 part 2)

A locked protected account now has one exit that no single key can block and
no single key can steer. The owner sets a recovery address, which proves it
is controlled when it is set, comes into force after twice the account's
delay, and can be changed only after a 30-day wait that the owner or any
signer may cancel and a lock drops. Protected mode cannot be switched on
without one, and a signer cannot be finalized until one is in force.

The owner or any recovery signer may then claw the account back, even while
it is locked: everything the owner could withdraw moves at once to the
recovery address, outside the payout queue and the delay. Nobody chooses
where it pays. The account becomes recovered for good: it stays locked,
opens nothing, its positions cannot leave it, and anything paid to it later
is swept on to the recovery address by any caller. Its open offers and
Auto-lend funding can be released by anyone and are swept on the same way.
While an address is in force, the paused-platform escape route pays it.

The recovery address and clawback rules run in their own code contract,
`VaultRecovery`, which the vault's protected-mode code reaches for those
writes and which shares its record and authorization rules. Together they
would have passed the contract size limit. The vault still has one entry
point for every protected-mode write, and the deployment records both
addresses.

Moving a replaced account's positions to its replacement wallet is now a
delayed change in the protected record, like any other. The replacing wallet
asks for the move; it can run only once the account's delay has passed and
before the request expires. A lock or a clawback ends a waiting move, so the
positions stay with the account and follow the recovery path instead. A
keeper pass applies an open move when it matures, and ships disarmed.

The trigger from the owner's linked chat is not part of this change: a
clawback cannot be undone, so it will get its own permission with the keeper
mandate work (#3353) instead of riding on the lock permission. The keeper
passes for the sweep and the release are still to be built, and ship
disarmed. The design and its reviewed defaults are in
`docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`.

> Caveat: on an account with no signer, someone holding the owner key can change the recovery address after 30 days; protected mode without a signer protects against a stolen owner key only for that wait.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3246-recovery-address-clawback.md sha256=8793a59ffa9349c826137db1b0e724e66b9bc7b58330b14624e71972c2968d96 -->

## Thread — position NFTs are read only from the standalone PositionNFT (#3321)

The position NFTs moved out of the Diamond into a standalone PositionNFT contract in #3205. Until now every off-chain reader carried two modes: the standalone contract where a chain's deployment record names one, and the old Diamond-hosted NFT otherwise. That second, legacy mode is gone. The app, alpha05, the indexer, the keeper, the shared library and the test drivers now read owners, approvals, transfers and holder locks only from the PositionNFT, and read a position's open route and retirement only from the Diamond.

A deployment record that names no PositionNFT is now refused with an error that names the chain and its Diamond. Nothing falls back to reading the Diamond as if it held the NFTs, because a Diamond that does not host them would answer with something misleading, or not at all. This change lands with the fresh deploy, which writes the PositionNFT address into every chain's record; until that deploy reaches a chain, position reads on it fail closed rather than guess.

The pieces that only existed for the old mode are removed with it. The keeper no longer runs a step that released queued position-NFT transfers for protected accounts, since the contracts no longer queue them. The Protection page no longer shows an NFT transfer queue or the old "protect my NFTs" setting; it shows the PositionNFT holder lock only. The copy that told users an open sale listing or offset blocks moving the NFT is gone, leaving only the current rule that moving the NFT cancels the listing or offset. The indexer watches only the ERC-721 events of the PositionNFT, and the activity feed no longer lists the retired transfer-queue events.

The Terms-of-service write gate drops the four retired NFT-queue functions, and the app's protected-account reader no longer reports the two retired NFT protection fields, which the contracts keep only as unused storage.

Closes #3321

> Caveat: until the fresh deploy adds a PositionNFT to a chain's deployment record, the app, indexer and keeper refuse position-NFT reads on that chain.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3321-position-nft-legacy-mode-removed.md sha256=3647221496f2f148ac6733f51c6da6c73f9a97dd0017ef337ad6bfd3a1e1e6f1 -->

### Matching now requires NFT offers to name the same token (#3328)

Matching two offers compared only the NFT collection, not the token, unless the borrower was refinancing. A loan opened by a match carries the borrower offer's token, so a lender who offered against one token could have been matched with a borrower holding a different token of the same collection. The same was true of the rented token in an NFT rental. A match is now admitted only when both offers name the same token, and for ERC-1155 the same quantity, on every NFT leg. Direct accepts, refinances and loan sales already checked this and are unchanged.

This was found while preparing collection offers (#3328). Those offers will let a lender state a set of tokens, rather than have the matcher choose one.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3328-match-nft-token-identity.md sha256=ce7f729dddfbb7c6fedfee5da40385f09d31103a13fed2c99c1378ee18fffec0 -->

### NFT collection offers (#3328)

A lender can now post one offer against many tokens of an NFT collection, instead of one offer per token. The offer names the set it accepts (the whole collection, a range of token ids, or a published list such as the tokens that share a trait) and how many loans it funds. The lender's wallet funds every loan when the offer is posted, and that principal stays reserved to it until each loan is filled, the offer is cancelled or it expires.

Each fill is its own ordinary loan against the one token the borrower locks. A borrower fills directly by naming their token and signing the usual acceptance for that exact token; a matcher can also pair the offer with a borrower offer already on the book whose token is in the set. Every check an ordinary accept or match makes still applies to each fill. For a listed set the contract checks only that the token is in the lender's list; the label is the lender's description, and the platform says so.

Collection offers carry a mandatory expiry (at most 30 days to start) and at most 50 loans to start, both governed. A lender can lower the number of loans left, and the released principal goes straight back to their wallet. The ordinary accept, match, edit and buy routes refuse a collection offer by name, so it is only ever filled one token at a time through its own entries.

Two supporting moves keep the contracts under the size limit: the match core that pairs a collection offer runs through the one copy on the offer-match facet, and the loan-initiation risk bounds the match core reads moved from the offer-preview facet to the risk-preview facet. Nothing changes for callers.

Advances #3328. Keeper matching of collection offers is #3688.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3328-nft-collection-offers.md sha256=bd9cff2eba59eaf27a0815ac620463d7a2ffcb315f71b102a1dff5eb6b47c769 -->

### Offer creation split so collection offers have room (#3328)

The offer-creation facet had about 300 bytes left under the contract size limit, and collection offers need the step that turns an off-book offer into an on-chain one to accept NFT collateral. That step now has its own facet, the offer materialize facet: it carries the two Diamond-only entries the signed-offer accept and match, and the standing-intent fill, call to put an offer on the book at the moment it fills. The plain creates stay where they were.

What an offer is (every check, the offer record, its position token and its book entry) is now one shared library that both facets run, so the rule exists once. Nothing changes for users: the function names, errors and events are the same, and only the facet that hosts the two internal entries moved. Each facet now has about 3.7 KB of room.

Advances #3328.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3328-offer-materialize-split.md sha256=a54b6082ef4531f2cf5e6077aa5858b52aa39dd4d535339a3ddf6ff047da1fcc -->

### Signed NFT collection offers (#3328)

A lender can now sign a collection offer instead of posting it on-chain. The signed order names the same things an on-chain collection offer does (the set of tokens, the terms of each loan and how many loans it funds), and costs nothing to make. Nothing is reserved when it is signed: each fill draws one loan's principal from the lender's vault balance at that moment, so a lender keeps the funds usable until a borrower actually takes a loan.

A borrower fills it one token at a time, signing the usual acceptance for their exact token. Every protection of an ordinary signed offer applies, and the order records when it was signed: its expiry and signature deadline can be no later than that time plus the governed maximum, so an order kept back for months cannot be used later. Excluded token ids are signed as a hash, and the fill must present the matching list. The ordinary signed-offer routes refuse a collection order by name, and the collection route refuses an ordinary order.

The off-chain tools that sign and check orders now share one field list and one conversion, so the next change to the order shape touches one place. The order book does not list signed collection offers yet.

An instant borrow now states each loan it opened in its own event, so the activity feed files each one under its loan.

Advances #3328.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3328-signed-collection-offers.md sha256=372eb6e9e6838411a1a359928cba87bc2f206e57ee774cb1e2bf3d8ddaecdad5 -->

## Thread — rate reference, market-linked rate limits and the warning band (PR #3782)

Each chain now has a standalone rate reference, found through the protocol
registry's new `RATE_REFERENCE` pointer, which carries the same 7-day minimum
delay as the price guard. For each asset it reads the variable borrowing rate
of three to five outside lending markets through small fixed readers, keeps
the median of the readings that agree, steps and caps it per its series, and
records an exact running sum, held time and hourly and daily checkpoints.
From those it answers the averaged rate over any window, whether the rate is
unusual (24-hour average more than 5 points from the 30-day one), the term
average for a loan's term, and the warning band around it. A read that cannot
be substantiated says why and is never a number. Series are immutable, open
only after the reference's own delay, and a source can be muted at once. The
design is `docs/DesignsAndPlans/RateReferenceDesign.md` and
`TermAverageAndLinkGuardsDesign.md`.

A maker may now link an offer's or an Auto-lend slot's rate limit to the
averaged reference or to the term average, plus a margin. The link only
tightens the typed limit, follows the loan's term, and is refused by name
while it cannot be used. Matches, direct accepts and instant-market fills all
read the effective limits through one new facet, `RateLinkFacet`, which also
holds the match rule on rate (the midpoint of the two effective limits), and a
loan whose rate a link set records it. The Auto-lend slot match and the
instant-market fill now run the match core through the one copy
`OfferMatchFacet` hosts instead of carrying their own, which keeps both under
the contract size limit; refresh the three together.

Every step that sets, changes or takes a fixed rate now runs one shared band
check: outside the band around the term average it needs the user's
acknowledgement, which is a new field on offer creation, both offer edits, the
intent setter, the signed offer, the accept terms and the instant borrow. The
offer-created, offer-modified, intent rate-terms and loan-opened events carry
the warnings mask the contract derives, and an integrator's count of warned
loans now moves.

A long average now continues back through several earlier series of an
asset, not only the one before, so a window that spans more than one series
change still reads. The accept preview quotes the rate a linked offer would
actually open at, and names a link refusal (reference unavailable, unusual, or
no acceptable rate left) instead of quoting the typed rate.

Breaking for integrators: `CreateOfferParams`, `OfferModifyParams`,
`setOfferRate`, `setLenderIntent`, `offsetWithNewOffer` (the borrower's band acknowledgement for the offset offer), the signed-offer and accept-terms typed
data, `MatchResult` and several events gained fields. The next fresh deploy
carries them; ABIs are re-exported in this change.

Advances #3337 (part 1) and #3635 (part A), with #3713 and #3719.

> Caveat: the reference opens with no series; each asset's series is proposed and opened by its owner after deploy, and the keeper's hourly `update` pass is still to be built (shipped disarmed, keeper thread).
> Caveat: previews return the fill's rate; its band is one read of `RateLinkFacet.rateWarnings`, not yet a field of each preview.

_Committed 2026-11-19 23:25 UTC (57f1f88a3)._
<!-- assembled-fragment: 3337-3635-rate-reference-and-linked-limits.md sha256=4e61bae466037bd6371c400d05d020cbca40056ffa7774ea8b63069cb4f34967 -->

## Protected mode: selling or handing over a locked position

Protected mode keeps an account's position tokens under the holder lock, and until now that lock also stopped every early exit: a protected lender could not sell a loan, and a protected borrower could not hand the obligation to a new borrower, without first unlocking and waiting the delay. Now a protected account that is not locked and not retired may sell or hand over while its positions stay locked. Everything that comes back, the sale proceeds or the returned collateral, lands in the account's own vault, where every payout to a wallet still waits the delay and the owner or any signer can cancel it.

A lender sale by such an account has a floor taken from the loan's own terms: it may not pay the buyer a rate shortfall out of the seller's principal. The seller therefore receives the whole principal into the vault and keeps the interest earned and not yet paid as the seller claim, whatever the collateral is. A listing above the loan's rate is refused when it is posted, and a sale that would carry a shortfall is refused when it fills. A borrower handover needs no floor, because the collateral returns to the borrower's own vault.

Nothing moves while the protected vault itself is locked, after the account was retired by a replacement, or when an account locked its positions without protected mode, because no payout delay would cover the proceeds. Unlocking still always waits the delay, and plain token transfers and outside-marketplace sales stay blocked while the lock is on. The pre-authorised sale the issue proposed was dropped by owner decision. Design: `docs/DesignsAndPlans/ProtectedAccountExitDesign.md`. Ships by fresh deploy.

Closes #3339

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3339-locked-position-exit.md sha256=f10ae148009ee15b296de7cbbb6c94fecf748c513c44c12063670414b679d524 -->

## Thread — Position receipts never read as live, and a refinance request stays dead after a handover (branch, no PR yet)

A position token whose position has closed stays with its holder as a receipt. Some paths retire a token without first marking it closed: one example is the borrower token of a matched loan that leaves nothing for the borrower. Such a receipt could still read "Governs Claim Rights: Yes" in its metadata, even though anyone can transfer it. Now every retired token reports a closed position, in its metadata and in the position summary the app reads. The loan's own state still shows what happened to the loan.

A borrower's refinance request lasts only while the borrower position has not moved since the request was recorded. The check compared the token's transfer count, but the count belongs to the token. An obligation handover gives the loan a new borrower token whose count starts at zero again, and that could make a dead request stand again. The request now also records which token it was made against, and a different token counts as moved.

Two other findings from the same review need no change. The position views already skip retired tokens and have paginated forms, which the apps use. The relist cooldown after a dead sale listing is cancelled stays as it is: dropping it when the position moved would let a seller move the token to a second wallet, cancel, and relist at once, which is exactly what the cooldown is there to stop. A genuine new holder waits at most one day to list, and can still sell directly at once.

Advances #3339.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3339-position-receipts-and-refinance-token.md sha256=090c61f1dfa90e1be9a8c08b196c3cdec991d40be2e07838e061c374d433b6d8 -->

## Thread — protected mode: the Ready balance

Protected mode delayed every payout to a wallet, but not a protocol use of the vault's own balance: a protected account could sign a vault-backed offer, or borrow on the instant market against collateral already in its vault, at once. A stolen key could therefore move a protected vault's money into a bad position without waiting. Protected accounts now have a Ready balance, and only Ready can be spent that way at once. The rest of the vault, the Protected balance, reaches a protocol step only after it is moved into Ready, which waits the account's delay and can be cancelled by the owner or any signer.

Three spends are covered, the only places an owner's own action spends existing vault balance: a vault-backed signed offer (signed accept, signed match, signed collection fill), the instant-market borrower's collateral that is already in the vault, and an auto-extension charge beyond the loan's reserve. Every entry that takes money from the wallet in the same call is unchanged, because new money is instant. A wallet deposit straight into Ready is instant too, Ready back to Protected is instant, and Ready never pays a wallet: the depository withdraw does not reach it.

A lock, a switch-off of protected mode or an account replacement empties Ready and cancels any pending top-up for good. The issue asked for a freeze; voiding is stricter, because a lock usually means a key is suspected and Ready is exactly what such a key could spend. An optional idle period of one to thirty days makes untouched Ready count as Protected again at the deadline, read lazily with no settle step and no keeper. Turning it on or shortening it is instant; lengthening it or turning it off waits the delay. The owner may keep a token's Ready counting for up to thirty days at once.

Intent fills and instant-market slices now materialize through a separate committed-capital entry that draws neither the depository ledger nor Ready. Before this, an intent fill debited the lender's depository holding for capital that had never been credited to it, which could leave money in the vault that the depository withdraw would no longer release; the instant-market borrower's wallet part was debited the same way.

The rules, entries and views live in a new ReadyBalanceFacet, which the three spend sites reach through one self-call; it refreshes together with OfferMaterializeFacet, InstantFillFacet, AutoLifecycleFacet, VaultDepositoryFacet and the vault template (which gains a protection-epoch read). Design: `docs/DesignsAndPlans/ReadyBalanceDesign.md`. Ships by fresh deploy. The presets (Basic, Strong, Maximum) and the app screens are #3345.

Closes #3344

> Caveat: returned principal is not rolled back into Ready (minimal v1, owner decision); returns go to the Protected balance only.
> Caveat: the idle expiry emits no event at the deadline; every ReadyUntilSet event carries the deadline so an indexer can derive it.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3344-ready-balance.md sha256=ae36c699675fa74066b5bb6d8355b0c93ab82ff360eb1c5dc212a45325e398b3 -->

## Thread — vaults: one caller, and every move inside a guarded action

A user's vault now answers to exactly one caller, the protocol contract that created it. The leftover owner record from the old upgradeable design is gone, along with its unused "transfer ownership" and "renounce ownership" functions, and the vault no longer treats calls from itself as trusted. Nothing in the vault ever made such a call, so this removes a door rather than closing a used one.

Moving an asset out of a vault can hand control to someone else: an NFT recipient's receiving hook runs during the transfer, and an approved spender acts on the allowance. The vault has no reentrancy guard of its own. Before this change the safety rested on every protocol path that moves vault assets happening to hold the protocol's guard. Now the single place every vault move passes checks it: a move runs only while the protocol's reentrancy guard is held, or while a limit-order fill holds its fill lock (during which the protocol admits only its own calls and the order protocol). Anything else is refused with a named error.

The check found one route that moved vault assets without the guard: the marketplace executor's callbacks for a collateral sale (opening and closing the listing's approval, and the sale's settlement). A buyer can start that fill directly, so nothing held the guard. Those callbacks now take the guard when nothing holds it, and run inside the Diamond's own guarded action when the Diamond started the fill itself.

Tests show an NFT withdrawal whose recipient hook tries to call back into the protocol reverts whole with the token still in the vault, that every move and allowance entry refuses to run outside a guarded action, and that the vault refuses a call from itself. A stale collateral-sale test that still expected the borrower's remainder in their wallet now checks the borrower's vault, where #3629 sends it. The vault's code comments no longer describe it as a UUPS proxy or claim asset moves are atomic.

Ships with the next fresh deploy (the vault code and the outflow facet change together). Closes #3432.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3432-vault-cleanup.md sha256=13f6174011dc4ddee3419f92d90f805d5746c83451daf5a654f5d4716c6be61d -->

## Vault code: the emergency route can no longer run brand-new code (#3436)

The guardian's emergency revoke on the vault beacon could make any registered vault version current at once. A version registered a minute earlier counted. So governance registering new code and the guardian revoking the current version onto it could put that code in every unpinned vault without the seven-day notice that the ordinary route gives. That notice is what lets an owner pin before a change reaches their vault.

Now each version records when it was registered, and no version can become current until seven days after that, on any route. The constructor's first version is the only exception, because a fresh deploy has no vaults yet. The guardian can still revoke at once onto an older version, and `versionUsableAt` tells operators when a newer one becomes eligible. The incident runbook and upgrade safety notes say to keep a known-good earlier version registered.

The six beacon properties that #3436 lists now run as a stateful invariant suite. Every role (the owner, the guardian, the Diamond, the vault owner and a stranger) calls every entry in random order. They are also proved with the Halmos prover, which checks every possible single call from chosen starting states rather than random samples. Without the fix, Halmos finds the guardian route immediately. A design note records what the proofs cover and what they do not. The issue's second property described successor chains, which the design removed; the suite checks the design's rule instead: pinned and live, otherwise current.

Closes #3436.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3436-vault-beacon-invariants.md sha256=a06548b063136e1ec8fa77eb48995cf940507e3abee449c9a073755946d4743c -->

## Thread — Price versions and collateral priced by an exchange rate

The price guard now names every price by a version: its own settings epoch, raised by each executed price-setting change, and the feed registry's epoch, raised by each executed proposal. Any read can be made at an earlier version the guard still answers, using the feeds, bindings and settings that version had. The owner may retire old versions by raising a floor, through the guard's delay and only to the current version; a floor change that comes due after the version moved on lapses and says so. The hourly price checkpoints now record the guard and version they were read at, and the calm test compares each one with the price now read at the same version, so a settings change alone is never read as a market move. This is step 1 of #3437; loans carrying their own settings set build on it.

The guard also prices collateral by an exchange rate (#3683): a vault share or staked token is valued as its underlying's price times its accepted rate, and never above its own market feed where one exists. The rate may rise by at most a binding's daily bound, a single large fall stops trust until the owner or guardian confirms the lowest rate seen since, on one rule and choosing no number, and the guardian may mute a token's rate source at once. A binding's first rate is measured when it is proposed, a correction while it waits lowers that rate without distrust, and execution caps it again. A rate-priced token may be collateral but never the asset lent; offers, loans and lender intents that would lend one are refused. No token is bound by this change: each is a later governance proposal.

The guard grew past the contract size limit, so its pricing path moved to a separate reader contract that shares the guard's storage layout and runs only inside a static call from the guard. The reader cannot write, log, create or delegate (a deploy-sanity test walks its code), and the deploy checks its runtime code against this tree's build before deploying the guard. The design is in PriceGuardDesign.md and RatePricedCollateralDesign.md.

Advances #3437 and #3683.

> Caveat: the keeper's hourly checkpoint pass does not yet record rates for bound tokens; until it does, the accepted rate follows honest growth only when someone records it, which undervalues and never overvalues the collateral.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3437-price-versions-rate-collateral.md sha256=f9c2ce7cf3d8c8edc773f1a16b6a5282c244f4525d5c4f1c4e421ab0388853a7 -->

## Vault code accepts earlier price guards and listing conduits (#3437 step 5, PR #3743)

A vault's code names the price guard and the listing conduit new loans use. It now also lists up to two earlier price guards and two earlier listing conduits, each conduit with its key, that open loans or their listings may still use. A listing may name any conduit the code lists, and a vault or its listing escrow may approve any of them. So when new vault code moves new listings to another conduit, an open loan's listing is not stranded. Any other guard or conduit is still refused.

Vault code cannot be built if its earlier lists are out of order, name an entry twice, repeat the current entry, or leave a conduit without its key. A fresh deploy lists nothing earlier.

The vault does not yet check prices itself, so for now the guard list is only read through `isAcceptedPriceGuard`. The vault's price checks on close-outs come with #3268 and will use a guard only when the vault code accepts it.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3437-vault-accepted-guards-conduits.md sha256=41f2bf5f0a9fe71c85619ced8f5f7a7d8406d01193fadd74e1a9e89d5cfb9692 -->

## Thread — The escape route after a long pause now opens after seven days (branch, no PR yet)

When an admin pause runs long enough, every owner may take what is free in their vault straight to their own wallet. That escape period was three days by default, and the admin could set it between 49 hours and seven days.

A vault code fix needs seven days in public before it can go live. With a three-day escape period, the escape route opened on day three, before any fix could land, so a bug on the withdraw path itself would have become reachable through the escape. The escape period is now seven days by default and can never be set shorter than the vault code delay. The admin may raise it to ten days, which stays well under the fourteen-day vault-side exit planned in #3424 (owner decision 2026-11-15).

Each pause still keeps the period in force when it started. The incident runbook now says to register a vault fix on the first day of a pause, so its seven-day window ends no later than the escape opens. The app's pause notice says seven days.

Closes #3441.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3441-escape-period-seven-days.md sha256=4027be533c097a8a14eda68869cdadf57604a38683867973a0f11d2b84b51746 -->

## Thread — Authority after a protected-account replacement

When a protected account's primary wallet is replaced, the old wallet now loses every right over the account's positions, and the new wallet gains them. Before this change the old wallet still passed several holder checks, and it could ask the position NFT contract to lift its lock, wait out the delay and then move the positions away.

The position NFT contract now refuses an unlock request from a replaced wallet. It also offers a recovery move that anyone may call: it sends the replaced account's position NFTs to the new wallet, even while they are locked. The contract confirms the replacement from the account's own vault, which it finds at the address the vault factory must have created it at, so the platform cannot direct that move anywhere else and still cannot move any token itself. The Diamond hands the vault beacon this lookup needs to the NFT contract once, at deploy, in the same step that records it on the Diamond, so the two records cannot differ. The Diamond's transfer check also refuses any move out of a replaced account except to the new wallet.

Every action on a position now follows one rule: the caller must be the manager of the position's holder, which is the holder itself, or the new wallet once the holder was replaced. That covers claims, collateral withdrawal and top-ups, swap-to-repay, consolidation, the listing cancel and auto-list switch, the per-loan keeper toggle, the stored-borrower checks on rental repayment and partial repayment, refinance consent and the lender's backstop opt-in, which now records the manager and lapses when the holder is replaced. The account stays the position's accounting identity, the caller pays with its own funds, and proceeds still go to the account under the protected payout rules. The self-dealing exclusion on repayment compares managers, so the new wallet of a replaced lender cannot repay that lender's loan.

A replaced account's open offers can never be accepted, so the only action left on them is cancelling, which the new wallet may do. Changing their terms or amount, staging them for a parallel sale or the backstop, setting their keeper, tariff or price-move guard options and attaching a refinance payoff permit are refused to both wallets. Posting a collateral-sale listing stays with the holder itself, as does funding a loan's extension reserve, because the listing pays the holder and the reserve is keyed to that wallet; a replaced wallet is refused both, and the new wallet recovers the position first.

Advances #3526.

> Caveat: ERC-1271 adoption signatures (#3349) and the new wallet adopting stray assets into the replaced account (#3094) are not part of this change.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3526-retired-account-authority.md sha256=f29f9002e543788ad7f0778829df58329a3928bd30801d2dfc0c1fcd61cd8598 -->

## Thread — One failing swap list can no longer push a loan into in-kind custody (branch, no PR yet)

Health-factor liquidations and time-based defaults can be started by anyone, and the caller writes the list of swap routes to try. An empty list was already refused, but a single route given broken data on purpose still counted as a real attempt. When it failed, the loan went straight into the in-kind fallback, even though the market could have sold the collateral. The lender lost a sale at market price, and the borrower's surplus stayed unsold.

Now a forced sale whose listed routes all fail moves the loan into the fallback only if an earlier failed sale of the same loan, from any caller, is at least 10 minutes old. Before that, the failed sale is undone. No collateral leaves the borrower's vault, the loan stays active, and the protocol records the failure. It also announces the earliest time a failed sale would open the fallback. During that window anyone with a working route can liquidate at market. A record whose last failure is more than a day old is ignored, so a loan that recovered and later becomes liquidatable again starts afresh.

A new view gives the app and the keeper the loan's standing: how many failed sales are recorded, when the first one happened, and when the fallback opens. Other refusals of a sale, such as a quote out of range, revert exactly as before and record nothing. Periodic-interest sales and split-route liquidations are unchanged, because neither ever enters the fallback.

Design: `docs/DesignsAndPlans/FallbackEntryGateDesign.md`. The liquidation spec states the rule. Advances #3538.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3538-fallback-needs-time.md sha256=ea2482a5907e03b82e20c5c3a8d65e2b8be104487bc267a2d4ea9195f12d08d5 -->

## CI: workflow lint and a wider docs link check (#3548)

The CI workflows are now checked on every pull request:
- for syntax and shell mistakes in their scripts;
- for common security weaknesses: credentials left behind by checkouts, permissions wider than a job needs, a release check reusing a cache another run wrote, and risky triggers;
- for any template expression written straight into a shell script.

Every workflow was brought to a clean result first:
- Values now reach scripts through environment variables.
- Checkouts no longer keep the repository token on disk.
- The Pages deploy grants write access only to the job that publishes.
- The mainnet release gate compiles from scratch instead of restoring a shared build cache.

The docs path check now also covers links in every living document, not only the operator runbooks; history (shipped release notes and older docs) and the owner's to-do list are left as written. The dead links it found are fixed. Links that had the wrong depth now point at the right file. Links to files that no longer exist are kept as plain text.

_Committed 2026-11-19 20:10 UTC (eb9c62ea0)._
<!-- assembled-fragment: 3548-workflow-lint-and-doc-links.md sha256=69f5f3fac7a0e2d7f7e575b350191f1d9d539bd9f28b9328a99d5d8a40350887 -->

## Thread — The two live testnet fixtures post each offer one stage before filling it (branch, no PR yet)

The seller-claim fixture and the internal-match fixture set up real positions on a testnet Diamond for checking the app by hand. Each opened a loan by posting an offer and accepting it in the same broadcast. Since the offer-age rule, an offer can be filled only once its terms have stood a few seconds, and one broadcast cannot wait between its own transactions, so on a Diamond carrying that rule both fixtures stopped before sending anything.

Each offer is now posted in one stage and filled in the next. The seller-claim fixture runs five stages: post the loan offer, accept it, post the buyer's offer, sell into it, repay. The internal-match fixture runs six: post and accept loan A, post and accept loan B, match, and restore. Every filling stage takes the offer id from the previous stage's receipt and refuses unless the offer is this run's, on the expected assets, with nothing of it filled by anyone else.

The extra stage boundary adds no new window for the internal-match run's price move beyond a few seconds: loan A already sat past its liquidation level at the second price while loan B was opened, and it still does, now across one more stage. The fixture's header states that window and says to run the accept as soon as the offer is old enough.

Both fixtures ran end to end against a local Anvil chain: the seller-claim fixture's five stages, and the internal-match fixture's six with the mocks deployed there first. The match stage needed a larger gas allowance than forge estimates, because the trigger's price reads ran short of gas and the transaction reverted after matching had been switched on; the fixture now says to broadcast that stage with a larger allowance and to run its disable stage if it fails. The app's live-review notes describe the new stages. Advances #3574.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3574-live-fixtures-staged.md sha256=59fca4868a8ecb8c900bd5df97a17cae890c9305a7c7611165229a57ba48b828 -->

## Thread — Midpoint states move onto the staged runner (branch, no PR yet)

The scripts that leave a rehearsal chain in UI-testable midpoint states are now one staged module, PositiveFlowsMidpoints, on the same fixture and runner as the positive flows. The three scripts it replaces posted an offer and filled it in one broadcast, so since the offer-age rule they stopped before sending anything. Now each state that fills an offer posts it in one stage and fills it in the next, once its terms have stood the minimum age.

The module leaves 14 states: an open lender offer and an open borrower offer, a varied offer book of three lender and two borrower offers on different terms, an active liquid loan, a repaid loan neither side has claimed, an active loan on NFT collateral, an active NFT rental, a fully filled offer beside a partly filled range offer, a loan with one partial repayment, a loan whose collateral was doubled, a loan with a keeper approved to start a preclose, a loan with a refinance request posted and no lender, a loan whose lender listed the position with no buyer, and a stray token sitting in a vault. The listing state was only logged before, because posting a listing used to fail; it now posts the listing.

The two testnet seeders, one for an offer book and one for a single active loan, are retired into the same module. Each deployed its own tokens and price feeds on every run, so a second run left the first run's offers and loans without a price. The offer book is now one of the midpoint states and the active loan was one already, both on the shared fixture.

The states are left on purpose, so none is recorded as a setting to put back, and the module changes no protocol setting. Each state sits on the run's own mock tokens, so other modules neither see nor disturb it. The one exception is the keeper approval, which belongs to the wallet; the keeper module already clears an approval it finds before granting its own.

All 14 states were set up by a staged run on a local Anvil chain. The runbook, the test matrix and the coverage list now point at the module. Advances #3574.

> Caveat: a defaulted loan, a loan in the health-factor warning band, overdue periodic interest and a borrower offset offer are still not among the midpoint states; unit tests and the timed module cover those flows.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3574-midpoints-staged.md sha256=753124dbfa22334aced0ea0a89a320892b9ea387f992bded7a76a0d867e91d50 -->

## Thread — Refusal checks move onto the staged runner (branch, no PR yet)

The on-chain checks that the Diamond refuses what its rules forbid are now one staged module, PositiveFlowsRefusals, on the same fixture and runner as the positive flows. It replaces the old negative-flow script and its wrapper, which opened a loan and probed it in one broadcast and so stopped before sending anything once the offer-age rule arrived.

The module also checks more strictly. The old script counted any revert as a pass, so a call refused for an unrelated reason, such as a missing allowance or a range checked earlier, passed the check it was meant to prove. Each refusal is now required by its own error: an amount range or rate range out of order, a rate above 100%, a missing risk and terms consent, a loan lending and collateralising the same asset, a zero-day duration, collateral below the floor, a lender claim on an active loan, and a partial repayment the loan did not allow.

Every refusal is asked in the simulation only, so it is never sent. The two that need a live loan post the offer in one stage and open the loan and probe it in the next. Nothing here changes a protocol setting.

All nine refusals passed a staged run on a local Anvil chain. The coverage list also stopped pointing at a sanctions check the old script never had; the sanctions unit tests are what cover the other entry points. Advances #3574.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3574-refusals-staged.md sha256=13e104b55598ca1c9572778ff21da2c9aa362046a46e911295dd8becfb571f14 -->

## Thread — Auto-extend stays inside an Auto-lend end date

An Auto-lend intent's lend-until time now also bounds an automatic extension of
a loan the intent made. Before, the lender's own auto-extend caps could carry
such a loan past the date the money was lent until, because the extension read
only those caps.

While the intent's owner still holds the lender position, an in-place extension
whose new end would fall after the intent's current lend-until time is refused
with a named reason that states both times. An extension ending exactly at the
time is taken. The intent is read as it stands now, so moving or clearing the
date moves or lifts the bound. Once the position is sold the buyer agreed to no
date, so the bound no longer applies. A new view reports each loan's bound, so
the keeper can size an extension inside it or skip the loan when none fits.

No funds move differently: the rule only refuses an extension. In-place
extension is the only route that lengthens a loan. This reaches a chain with the
next fresh deploy. Design: `docs/DesignsAndPlans/AutoLendLendUntilDesign.md`,
section 3, item 5.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3618-auto-extend-lend-until.md sha256=e4ee9f4e00db9a33fcae80ec2fae07df37c64daa7d8437ca7b0f758068e28fc9 -->

### A lender may take partial repayment and the prepay listing either way (#3621)

A match pairs two offers only when they chose the same lifecycle terms. Until now that meant a lender who did not mind whether a loan allowed partial repayment, or a prepay listing of the collateral, still missed every request that chose differently, and the book split into small pools that never met.

A lender offer can now say "either" for partial repayment, for the prepay listing, or for both. Such an offer matches a request whichever way the request chose, and the loan takes the request's choice, exactly as it already takes every lifecycle term from the borrower's offer. For an option the lender did not mark, the two offers must still agree. The interest mode, the periodic-interest cadence and the rental-fee asset always have to agree.

Only the lender gets this choice, and only on an offer it posts or signs itself. A borrower offer, an NFT rental and the offers the protocol creates on a user's behalf (a loan sale, the offset offer, a standing-intent slice) are refused if they carry it, and so is any setting the protocol does not define. The choice is fixed when the offer is posted. A signed offer carries it in the signed data, so the maker's signature covers it. Accepting such an offer directly takes its stated values unchanged.

The offer-created details state the choice, the signed-offer book refuses it on a borrower order, and the new app's "why isn't my offer matching?" no longer names an option the lender takes either way. Neither app lets a lender set it yet; that form work, with the disclosure the lender signs, follows.

This changes the offer layout and the signed-offer type, so it reaches a chain only through a fresh deploy. Design: `docs/DesignsAndPlans/IdleLiquidityMatchingDesign.md` §2.

Closes #3621

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3621-lender-either-options.md sha256=6693583c538e621217ee587da4e4d1662b51cec362c0b30353e5c38377aacdfe -->

### Several standing intents per asset pair (#3626)

A lender can now hold up to eight standing intents on the same lending and collateral pair, numbered 0 to 7. Before, one wallet had exactly one intent per pair, so a lender who wanted some capital at a low rate floor and some at a higher one, or two amounts with different end dates, had to fall back to separate offers.

Each intent is fully independent: its own funded capital, exposure cap, rate floor, loan-to-value ceiling, longest term, smallest fill, lend-until time, pro-rata choice and priority-routing opt-in. A fill draws from the one intent the filler names, and the loan remembers which it was, so the exposure it holds is released from that intent and an auto-roll sends its proceeds back to it. The protocol never chooses between a lender's intents. The reference keeper tries the lowest floor first, so a ladder fills from its cheapest rung up, and a lender with several intents gets no more turns in the keeper's walk than a lender with one.

Every intent action, read and event now names the intent it concerns. The backstop vault and the yield-aggregator adapters keep using intent 0. In the new app, Claim everything labels each standing offer's un-lent capital by its number, and the "lenders ready" figure counts a lender with several intents on a pair once.

This changes the storage layout, so it reaches a chain only through a fresh deploy. Design: `docs/DesignsAndPlans/IdleLiquidityMatchingDesign.md` §4b.

Closes #3626

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3626-several-intents-per-pair.md sha256=6f078fdd4912a64eea39f97c9ddc843202ffaf149b6f9f0fe9fd450819d86d97 -->

### Every payout goes through a claim (#3629)

No loan step pays a wallet any more. Before, several steps paid the current lender-position holder's wallet straight away while the loan stayed open: a partial repayment, a rental day's fee, a periodic-interest settlement or its forced sale, a partial liquidation's lender share and a swap-to-repay partial repayment. Some borrower steps did the same: what a forced or listed collateral sale raised above the debt, and what a swap-to-repay left over. A payment that skipped the vault also skipped the vault's outflow rules, so an account in protected mode lost its delay on exactly those payouts.

Now every such payment lands in a vault and leaves only through a claim. A lender payment on an open loan pays any past seller's interest claim first, as before, and the rest is held for the lender position in the recorded lender's vault, reserved so the recorded lender cannot spend it. A sanctions-flagged holder is handled the same way and simply cannot claim until cleared. The current holder can take what is held at any time while the loan runs (`claimHeldForLender`), and whatever is still held is paid with the final lender claim. Borrower extras are held on the loan's borrower surplus record; on an open loan the borrower-position holder can take them early (`claimHeldForBorrower`), otherwise the borrower claim pays them. A lender who sells the position receives the net in their own vault, and the least net they agreed to is checked against what actually arrived there.

For Auto-lend, payments held on an open intent loan can go back behind the intent the loan came from while the loan runs (`recommitHeldToIntent`), callable by the owner or a keeper the owner allowed to roll, under the roll's checks. The roll at full repayment now re-commits the final proceeds together with anything still held, instead of refusing a loan that had a held amount. A partial repayment on a pro-rata intent loan can therefore be lent again rather than leaving Auto-lend. The reference keeper's roll pass runs the re-commit step only when `HELD_RECOMMIT_ENABLED` is set; it ships unset.

Several events changed shape: the periodic forced sale's settlement, the periodic auto-liquidation and the collateral sale's split no longer carry a "paid to the wallet or held" flag, because the extra is always held. New events record a held lender payment, a mid-loan lender claim and a re-commit. The keeper's roll candidates now include open loans with held payments, marked as such.

This changes facet code and events only, not the storage layout, but it ships with the fresh deploy like the rest of the batch. Design: `docs/DesignsAndPlans/LenderPayoutsThroughClaimDesign.md`.

Closes #3629

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3629-payouts-through-the-claim.md sha256=251b166064fd7e6f50a33b84a1e610e5d721dadf9a74c6cf560d8635d1b89550 -->

## Fee levels: 10% of interest, initiation fee by term (#3649)

The treasury's share of the interest lenders earn is now 10% by default, up from 2%. It is fixed on each loan when the loan opens, as before, so a later change never reprices an open loan.

The borrower's loan initiation fee now depends on the loan's agreed term. A term of 30 days or less pays 0.2%. Between 30 days and one year the rate rises in a straight line to 1%. Beyond one year it is 1% for each year of term, in proportion to the days, so two years pay 2%. There is no step anywhere on the curve, so a day more of term never costs more than a day's share of the yearly rate. Early repayment returns no part of the fee.

Every figure derived from the fee reads the same term rate: the acceptance charge, every preview, the matcher's share, the refinance payoff sizing and the fee discount. A signed order's cap on the fee is compared with the rate for that order's own term, rounded up. The one exception is the paid fee tariff, which already scales with the term and keeps the base rate. The loan record stores the term rate it opened at.

A new settings facet holds the base term, the yearly rate and the one-year point, all bounded: the base term is 1 to 90 days, the one-year point 180 to 730 days, the yearly rate may not be below the base rate, and the fee at the longest term the platform admits may not exceed the 50% fee ceiling. The base-rate setter now refuses a base rate above the yearly rate. The facet also quotes the fee and rate for any principal and term, which the app's term picker can read.

An extension now pays the initiation fee for the term it adds: the fee at the new total term less the fee already paid for, on the principal outstanding, drawn from the borrower holder's vault after their hold-tier discount. Any chain of extensions pays what one loan of the same total term would. The borrower's automatic-extension limits gain the largest added fee they allow, and the app's auto-extend card quotes the fee for the chosen latest end date and saves it as that limit. An obligation handover cannot end a loan later than it ends now, so it never adds term and never pays.

The treasury now keeps a floor of the two fees that will fund the shortfall reserve, and the part above it is the reserve's. The floor is 0.1% of the principal on the initiation fee, taken once at acceptance, and 1% of the interest on the treasury's share of an ERC-20 loan's interest. An extension's added fee takes no floor and is the reserve's whole; every other fee, rental shares included, stays the treasury's whole. A fee discount therefore comes out of the reserve's part first, and the matcher's share of the initiation fee is now sized on the part above the floor. No reserve exists yet, so both parts still go to the treasury: each such fee emits the two parts separately, and a per-asset counter records the reserve's part the treasury holds. The two floors are bounded settings on the fee settings facet: a floor may never exceed half of the rate it is taken from, and the fee setter keeps each rate at least twice its floor, so the part above the floor never closes. Because a loan keeps the share it opened with, the fee host applies the same limit again per loan: the treasury's part of an interest fee is the lesser of the floor in force and half of that loan's own share, so an older loan opened at a lower share still sends at least half its fee to the reserve. Design: `docs/DesignsAndPlans/FeeLevelsDesign.md` section 11 and `ShortfallReserveDesign.md` section 8.

> Caveat: the keeper's funding check does not yet add the extension's fee to the interest charge, so an automatic extension with funds for the interest alone is refused when it lands rather than skipped beforehand.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3649-fee-levels.md sha256=3572e8a8cf4b8a8f99ed3636d5d44a187721bef98c8dcd905d8f78cdf6b08a5a -->

## Thread — the apps, the indexer and the keeper follow the merged contract batch

The batch that raised the lender yield fee to 10%, added extension fees, collection offers, the Ready balance, held lender payments and the instant market left the off-chain surfaces describing the older contracts. This change brings them back in line. The contracts are the source of truth; nothing here changes what the protocol does.

The public website now states the 10% yield fee wherever it named the old 2% figure: the fee constant it mirrors, the "how it works" fee line and the fee FAQ in all ten languages, the whitepaper's constant list and the admin settings reference. The connected app's fallback figure, shown only while the live fee read is in flight, is 10% as well. The figures the site computes from the fee (the worked repayment example) follow automatically.

In the connected app, the review before taking an offer now names a collection offer's refusal in its own words: such an offer is taken only through the protocol's collection-offer fill, which the app does not offer yet, never by a direct accept. The automatic-extension limits explain the added initiation fee an extension charges in every translated language, and the Activity page gives every new event kind a plain label in all ten languages instead of a generated English name. The alpha app gets the same refusal wording and activity descriptions.

The shared activity rules now name the wallet each new event concerns: the payer of an extension's added fee and the owner of a Ready balance. The indexer files a collection-offer fill on the collection offer's own timeline, and treats the extension fee as a companion of the extension, which already carries the notification. The keeper's machine settings template lists the held-payment re-commit switch the keeper already reads, so it no longer reaches a machine unset by omission.

The loan initiation fee is no longer described or computed as one flat rate anywhere off-chain. Since the same batch it depends on the loan's term: 0.2% up to 30 days, rising evenly to 1% at 365 days, then 1% a year, pro rata (the defaults; all four settings are adjustable). The website's fee line, fee FAQ, overview, user guide and whitepaper state that rule in all ten languages, its worked example computes the fee by it, and the admin settings reference documents the settings and their limits. The indexer's published configuration snapshot now carries the three term settings beside the base rate, published only when the code that answered is the facet the deployment records, so the site shows them live; where a network's snapshot does not carry them yet, they show as defaults, labelled so. No database change was needed.

Both apps read the four settings from the protocol and apply the rule at each loan's or order's own term: review fee figures, the refinance payoff split, the matcher's share and the fee-discount table. Before this, a gasless order signed the base rate as its initiation-fee cap, which the protocol would have refused for any term past 30 days; it now signs the rate at its own term. The connected app no longer falls back to a built-in 0.2% while the read is in flight, and both protocol consoles list the term settings with the base rate labelled as such. The operator's live review drives use the same rule at the new loan's term, through a copy of it checked against the app's on every test run.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3649-offchain-follow-the-contracts.md sha256=3ecdf54620383828ce0c23a9c955bed27af0d5632ff220844e3dca8faa9272b5 -->

### Instant market: the instant borrow (#3656, part 7b)

A borrower can now borrow from several lenders in one transaction. They name the pair, the amount, the collateral, the term, the highest rate they accept and a list of sources, cheapest first, and set the least they must receive. Each fill is its own loan with one lender, at that lender's own price, and passes every check a new loan passes. A source that cannot fill is skipped and reported with its reason, so a stale or changed source never fails the whole request; only receiving less than the stated least does.

A source is either an Auto-lend intent whose owner has given the new instant-market consent, or a standing lender offer whose interest runs by time. Intent owners give three consents separately from their terms: fills from a borrower's direct request, renewal of these loans in place, and takeover of another lender's loan at face value. Setting new terms clears them, and a fill waits the usual minimum age after they are given.

Collateral is shared across the loans in proportion to what each lends. It is taken from free collateral already in the borrower's vault first and from the wallet for the rest, and the share of anything not filled is never taken. The principal arrives in the borrower's vault less the initiation fee, and no part of that fee is paid back to the borrower as a match share; it goes to the treasury.

The loans carry one group number and are stated together in one summary event, but each keeps its own collateral, health factor and liquidation. The common ledger now also counts the principal opened through the instant market. The feature is off by default, serves only pairs of blue-chip assets, and offers fixed-rate loans until floating rates exist. Takeover follows next; renewal waits for the per-loan reserve (#3681). This changes the storage layout, so it reaches a chain only through a fresh deploy.

The Auto-lend figure in the common ledger now follows each loan's current intent: a loan sold out of an intent leaves it, so "how full" counts only what intents hold now.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3656-instant-borrow.md sha256=18799f622fb2228b677a9d6cc4322d6b5c77bbaf75719e2635f7a456a33fb1a5 -->

### Instant market: the common ledger (#3656, part 7a)

The platform now keeps running totals for every lending asset and every lending and collateral pair, which anyone can read. Declared is the sum of the largest exposure of every active Auto-lend intent that can still fill: the limit lenders set. Lent is the open principal of every active loan in that asset, together with the part of it that Auto-lend intents opened. How full the market is, and how much can still be lent, come from the Available figure added in part 7b (#3714), not from Declared.

An intent with a lend-until time stops filling one day before that time. It leaves Declared at the end of that UTC day with no transaction needed, because each day's expiring amount is kept aside and every read subtracts the days that have passed. The figures are therefore exact as of the start of the current UTC day. A permissionless roll step moves the stored totals forward after a long quiet period; no figure depends on anyone calling it.

The totals cannot drift. Each intent and each loan remembers what it last added, and every change moves the totals by the difference, so a step cannot count twice or be missed. Funding or withdrawing an intent's capital does not move Declared, because Declared is the limit a lender set, not money held. It does move Available (#3714), which is the part of that limit the slot's capital can actually lend now.

The figure for loans made through the instant market itself comes with the instant borrow step. This changes the storage layout, so it reaches a chain only through a fresh deploy.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3656-instant-market-ledger.md sha256=3ecb0d001fdb732962063a208deacb8213cd562a2e867d68fb59877c4da12c2b -->

### Instant market: takeover at face value (#3656, part 7b)

A lender can now leave an instant-market loan by handing it to another lender's Auto-lend intent that offers takeovers. The incoming intent pays exactly the principal outstanding into the outgoing lender's vault, and the loan moves to the new lender on the same record. The borrower signs nothing and none of the loan's terms change. The outgoing lender's earned interest stays theirs as a seller claim, paid first from the borrower's next interest payment. No fee is charged, because no loan is opened.

The takeover opens only where a direct sale would: the loan is active and before its due date, outside the claim cooldown, and no other sale route is open. Nothing may be held for the lender position. The incoming intent must accept the loan as if it were new: the rate, the repayment terms, the remaining term, today's loan-to-value and health factor, and room in its exposure. The incoming lender passes the same screens as any new lender, and cannot be the borrower.

It is its own facet beside the instant borrow, because moving a position reaches code that the borrow's transaction size cannot carry alongside. Renewal in place waits for the per-loan reserve (#3681); until then an instant-market loan ends at its due date. This reaches a chain only through a fresh deploy.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3656-instant-takeover.md sha256=a96dd71c148925b832982dadd7a695542cc1cba57c6efd31ec4a2c0bca953cae -->

## Why an Auto-lend is not lending

An active Auto-lend with money waiting now offers "Why isn't it lending?" on its card in Positions. Opened, it finds the open borrow requests on the Auto-lend's pair that sit closest to its terms, and asks the protocol whether it would fill each one from this Auto-lend now.

It then states one thing: the closest request's first refusal, in the protocol's own terms (with both rates, or both terms, where the gap is one of those), or that the protocol would fill a request now and is waiting for a matching service to send it, or that no borrow request stands on the pair. It never promises a fill.

The index serves the closest requests through a new route that ranks them by the same rule as the existing "why isn't my offer matching?" panel, so the two panels choose counterparties the same way. If the index does not answer, the panel says the closest requests are unknown rather than that there are none.

Closes #3660.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 3660-why-auto-lend-not-lending.md sha256=8e19c18dfb25134a389a15cb9fb135e14aaa3641ca20e1a6dfe4a84f9fa53394 -->

## Thread — A frozen address no longer holds a loan hostage

A token whose issuer can freeze an address could stop a loan from settling.
If the lending asset froze the lender's vault, the borrower's repayment
reverted, so the loan ran past grace and defaulted on the borrower's
collateral through no fault of theirs. If the collateral asset froze the
borrower's vault, the in-kind default reverted and the loan never closed.

Now, when the token refuses to move a repayment or a defaulted loan's
collateral to the lender side, that leg stays in the payer's own vault,
liened for the lender side, and the loan still becomes Repaid or Defaulted.
The lender's claim moves the leg into the lender's vault once the token
allows it; while the token still refuses, the claim fails and stays open
for a later try. Nothing waits in the protocol's own contract.

A leg is held this way only when the payer holds all of it, so a token that
has rebased below the tracked amount still fails visibly. Each attempt is
given a fixed amount of gas, and the step refuses when less is available, so
a caller cannot starve a deliverable payment into the held path.

This covers full repayment, the in-kind default, and the lender's share of a
forced sale (the liquid default and liquidations), which waits in the
borrower's vault. Partial repayment, preclose, swap-to-repay and periodic
interest still refuse, because a refusal there holds no one else hostage:
the borrower can still repay in full.

A frozen treasury no longer stops a repayment or default either: the
treasury's share waits in the payer's vault, and anyone can send it on to
the treasury once the token allows it. A keeper pass for that release is
planned and will ship switched off. The design is in
`docs/DesignsAndPlans/RefusedSettlementLegDesign.md`.

Advances #3669.

> Caveat: the indexer records the loan's terminal state as before but does not yet show the held leg; the app reads it from the contract.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3669-refused-settlement-leg.md sha256=eaa00008f854804398cf6aa90895c53655f164147eb65daed2da8c4dea602e98 -->

## Thread — Standing instructions from your own vault (#3681)

A borrower can now set up a loan reserve in their own vault and switch on up to three standing instructions for a loan: keep my loan healthy (move collateral from the reserve into the loan when the health factor falls below a chosen trigger, back up to a chosen target), pay my interest (pay a periodic interest payment from the reserve when it falls due), and repay at the due date (repay the whole loan from the reserve shortly before the due date). Anyone may run an instruction, but nobody chooses an amount or earns anything by it: every figure comes from the loan, the borrower's setting and the reserve, which is the most an instruction can ever spend.

The reserve has two parts, the payment reserve in the lending asset and the collateral reserve in the collateral asset. The payment reserve is the former extension reserve under a new name, and an automatic extension still draws its charge from it first. Funding and withdrawal moved to the new instructions facet and take the reserve kind. The collateral reserve is not collateral: liquidation and default cannot take it, and it counts for nothing in the health factor until the top-up moves it. The reserve belongs to whoever deposited it and stays withdrawable whatever happens to the loan.

Interest paid in the middle of a loan is now booked by one shared function, whichever way it is paid. The periodic settlement's forced sale and the pay-my-interest instruction both go through it: the treasury takes its share at the loan's stamped rate, the lender side receives the rest (sellers' claims first), and the whole amount counts as settled on the loan. This changes the forced sale. Before, it paid the lender the whole recovered interest and the treasury took no share of it, while the same interest paid by a partial repayment or at the final repayment did bear the share. The lender's payout from a periodic sale is now the interest less the treasury share, and on a sale that recovers less than is owed the lender is paid first. The divergence is recorded in the code-versus-docs audit as resolved toward intent (design decision 2026-11-16).

Full repayment from the reserve runs through the ordinary repayment, with the reserve as the payer: the same amounts, splits and events as a manual repayment. A loan's due date has one plan: the repay instruction cannot stand together with automatic-extension or automatic-refinance limits.

Each executor needs a keeper pass; those passes ship unarmed and come with the keeper work. Design: `docs/DesignsAndPlans/StandingInstructionsDesign.md`. Advances #3681.

> Caveat: funding a reserve from an existing protected-mode balance (which would wait the account's delay) is not built; funding is from the wallet only.
> Caveat: the app and indexer still show the former extension-reserve names until their consumer update lands.

The loan's reserve view also states, per instruction, the reason a run would be skipped right now (holder changed, paused, account locked, loan busy) and whether the position must first be consolidated, so the keeper never pays gas for a run that would only be skipped and the app can show the reason in advance.

A full repayment from the reserve now ends exactly as a manual one does when a payee's token refuses the delivery (a frozen lender vault or treasury): that leg parks in the holder's own vault under a lien for the payee, through the same host as a manual repayment, and the loan closes. The reserve is reduced by the full amount, so the parked part is no longer reserve its depositor could withdraw, and the lender's later claim pays it. Before, the reserve repayment reverted in that case while a manual repayment parked. The pay-my-interest instruction, whose manual counterpart refuses a refused delivery, is now skipped by name with nothing moved, and a keeper can learn that before sending from the executor's preview.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3681-standing-instructions.md sha256=2e105573de6c9ab31257b2373373084a7c4c35c00cd90edd551acbadcf49bd46 -->

## Thread — Integrator share of the initiation fee

A front end, wallet or aggregator that brings a borrower to the platform can now be registered as an integrator and paid a part of the loan initiation fee. The borrower pays the same fee either way, and the treasury keeps the same floor: the share comes out of the part of the fee above the floor, which was otherwise the reserve's. The default rate is 10% of that part, at most 50%, and one per-loan ceiling (60% by default, settable from 40% to 70%) bounds the matcher's, the integrator's and, later, the inviter's shares together.

Only the borrower's own action names an integrator: its own offer, its signed acceptance of a lender's offer, or a signed offer. A match, a fill or an Auto-lend fill of a borrower's offer reads that offer's integrator. The share is delivered into the integrator's own platform vault as one isolated step, so a token that refuses the transfer cannot stop the loan from opening; a share that is not delivered, or an integrator that is unregistered, suspended or is the borrower itself, goes to the reserve. One event states each named integrator's outcome.

The registry is a new facet. Adding, changing and removing an entry wait the administrator's delay; the guardian can suspend one at once. Each entry carries a public record of loans brought and loans that defaulted within a week of opening, and anyone can read the whole list together with the platform's own contracts on the chain. The offer and loan records now name the integrator, and a lender can attribute a standing intent to the integrator it came through, which earns nothing.

The signed acceptance terms, the signed offer and the offer-creation parameters each gained an integrator field, so front ends and the indexer need the new ABIs. Design and build notes: `docs/DesignsAndPlans/IntegratorFeeShareDesign.md`. Closes #3682; advances #3719 and #3720.

A borrow preview can now point to one standing lender offer and have the platform check it against the borrower's quote: not checked, not comparable, refused by name, or checked with the rate and amount and whether it beats the quote. A borrower with a posted request is checked through the match preview; one without, through the accept preview, which can take only an offer of exactly the borrower's amount. The check never claims an offer is the best available.

> Caveat: the loans-opened-with-a-warning counter stays at zero until the loan warnings mask (#3685) exists; a test fails as soon as the mask appears, so the counter is connected in that change.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3682-integrator-fee-share.md sha256=0098db0c9cf2c1b724d44bef1405a8475e0ae0347a2d40fb86cff172417fcade -->

## Collateral concentration: a graded response per asset (#3685)

The platform now keeps one running total per collateral asset: how much of it is pledged under open loans, written by the one library that writes collateral liens, beside every lien change. Dividing that total's value by the sale size the asset's liquidity tier is measured at gives its concentration ratio. Each loan was already judged alone when it opened; nothing looked at how much of one asset all loans together would need to sell in the same fall.

Two governed thresholds act on the ratio, for new loans only and without ever refusing one. At Caution (5 times the tier's measured size to start) the app warns and the loan records that its collateral was at Caution when it opened, which is what the shortfall reserve will read to exclude it. At High (10 times) the loan-opening loan-to-value cap is the next lower tier's cap, or for the lowest liquid tier that tier's cap less a governed step (10 percentage points to start). This applies in both loan-to-value regimes: at High the cap is the lower of the regime's own cap and the lowered tier cap. Where the lowered cap is not below what the regime already allows (a tier-3 asset in the untiered regime, for example), nothing is lowered, and the views say so explicitly, so the app never claims a lower cap that does not apply.

There is now one host for the loan-opening cap. Loan creation, the match and accept previews, the offer-creation bounds and the offer book's logical amount ceiling all read it, so a preview and the loan it describes always agree, and a loan the lowered cap refuses is refused by the existing check with the existing reason. Open loans are never changed by a later rise in the ratio.

The thresholds are stored in hundredths of a multiple, bounded, and changeable only by the admin role (the Timelock after handover). Governance may give a single asset tighter thresholds, never looser. A per-asset view reports the pledged amount, its value, the depth reference, the ratio, the thresholds in force, the level, the cap a new loan would get, and whether the lowered cap binds; when the price cannot be read it reports the value as unknown instead of zero.

The four collateral-lien entries (release, decrease, increase, re-create) moved to their own facet, split off the encumbrance facet, which went over the contract size limit once the pledged total joined each lien change. Nothing about how a lien behaves changed. Because a lien created before this change is not in the total, the in-place refreshes refuse to cross it while any loan is open, and the curated refreshes refuse an older Diamond. The next deploy is fresh, which is how this reaches every chain.

Design: `docs/DesignsAndPlans/CollateralConcentrationDesign.md`. Advances #3685. Not built here: the shortfall reserve that reads the recorded level (#3641), a rate-priced token's tighter start (#3683), and the per-loan settings stamp (#3437).

> Caution: a refinance's carried-over collateral is still counted when the replacement loan is judged, so the replacement sees its own collateral once in the total. This errs toward caution and is left as is.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3685-collateral-concentration.md sha256=45915667ec91b44cdb3a7488be59ce7ac66e82b172bd32f47153053b06a38981 -->

## Position sale state guard (#3710)

A buyer of a loan position can no longer be sold a position that changed under them. Every position token now carries a state number that rises each time value leaves its position (a payout, any fall in a loan's collateral, a rate or term change, a change to an offer, or the end of a side). Anyone can read it, and anyone can ask the platform to confirm a token is still at a given number. A price for a position is a price for one state number, so an order that carries the number can be refused when it moved.

The wait before a token can move after a value-out now has two lengths. When the holder takes value out of their own position (a collateral withdrawal, a claim, a change to their own offer), their token waits 15 minutes by default, settable from 1 minute to 1 hour. Any other value-out (a repayment, a liquidation, a keeper step) holds the token 60 seconds by default, settable from 1 second to 10 minutes, so the other side cannot keep a token unsellable with small payments. A new wait never shortens a running one, and the token still cannot move in the same block.

The position token contract now sends the standard metadata-update signal whenever a figure a token shows changes, so marketplaces, wallets and explorers refresh the position before showing or filling it.

The marks are placed at the few places every such change must pass rather than route by route: the payout rules, one writer for a loan's collateral amount (with a build check that refuses any other write), the loan-terms writer and the taker of funds held for a lender. A partial liquidation, the matched liquidation legs, the fallback split and the periodic forced sale, which lowered collateral without a mark of their own, are now marked.

A collateral withdrawal now releases the amount into the vault of whoever holds the borrower token, as their free balance, read from the token by the payout rules, never a payee chosen by the withdrawal itself. Nothing a loan or an open offer owes a party is paid to a wallet; the holder moves it out with their own vault withdrawal, under protected mode's delay and lock (owner decision 2026-11-19). A second build check refuses any token or native transfer in the platform's code outside the payout rules and the delivery helper unless it is listed with its reason, so no new route can skip protected mode's delay.

The token contract, the vault code and several facets change, so this reaches a chain by fresh deploy. Design: `PositionSaleStateGuardDesign.md` (card #3710).

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3710-position-sale-state-guard.md sha256=564443021f1c4024b2a593a932b77204494a1e55ce242b84600a6ce603bf9527 -->

## Thread — Instant market: Available, exact live principal, and room for the term-average acknowledgement

The common ledger now keeps a third slot-side figure beside Declared and Lent: **Available**, per lending asset and per pair. It is the sum, over every active Auto-lend slot whose fill window is still open, of what that slot could lend now: the lesser of the capital reserved under the slot (liened in the lender's own vault) and the slot's unused exposure, counted as nothing when that is below the slot's smallest fill. "How full" a market is now reads as the principal lent out of slots divided by that principal plus Available, so it can never pass 100% and a fully lent slot keeps its whole weight. Declared stays, labelled as the limit lenders set. Advances #3714 (TermAverageAndLinkGuardsDesign §7, InstantMarketDesign §8).

A slot's live principal, which also bounds its largest exposure, is now exactly the outstanding principal of the open loans it holds. It falls by the principal a partial repayment clears, drops to nothing when a loan is fully repaid, defaults or is written off (not later, at the lender's claim), leaves the slot when the loan is sold, consolidated to a new holder or taken over out of it, and joins the incoming slot at the principal outstanding on a takeover. Before this change a slot kept counting a loan's original amount until the lender claimed it. The sum of every slot's live principal is the "lent from slots" figure.

Every step that changes a slot's terms, its reserved capital or its live principal moves Available in the same transaction, through the one ledger host. A slot whose window closes leaves Available at the end of its closing UTC day with no transaction, the same way it leaves Declared, so both are stated as of the start of today (UTC). A slot counts from the moment it is set, although a fill waits the minimum age (at most 60 seconds). Available is a figure of liened capital, not a reading of vault balances: a fill that finds the vault short refuses and never lends more than is there. The borrow preview remains the binding answer for one borrow.

The ledger views now return Available too, a per-slot view states a slot's limit, fillable amount, live principal and reserved capital, and the permissionless housekeeping roll is renamed to cover both totals. The unfunded mark proposed first was withdrawn by the design owner before it shipped: there is no mark, no permissionless step for it and no keeper pass.

The instant borrow request also gains the borrower's own acknowledgement that a fixed rate is far from the term average (#3713). It is carried in the request but not enforced: the shared term-average check (#3635 part A) will require it outside the band. No other write path carries it yet; that belongs to the thread building the check.

This changes the storage layout and the ledger views, so it reaches a chain only by fresh deploy.

> Caveat: Available counts a slot from the moment its terms are set; the minimum terms age (1 to 60 seconds, #3443) before a fill is not held out.
> Caveat: A cancelled slot or one whose window has closed counts nothing available while its open loans still count as lent from slots.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3714-instant-market-available.md sha256=19987545f24210a71f75bce9365958f4a2849f17b883734cce5bad38c4a3cb74 -->

## Security — Risk access wait before first use; keeper listing rate bound

When a wallet raises its own asset access, or consents to an illiquid asset pair, the platform makes it wait a set time before the first deal can use the change. That wait is what stops a website from walking a new user through "raise your access, then take this deal" in one sitting. Its setting started at zero and no deploy set it. Now a mainnet deploy sets it to 48 hours, governance cannot lower it below one hour on a mainnet, and the launch check refuses to open a mainnet whose wait is zero. Public test networks start at ten minutes and a local test chain at none, so test flows stay quick. Lowering access stays immediate.

The record of each change now names what an alert needs: an access change states the level before it and when the new level takes effect, and a pair consent states both assets and when it can first be used. A keeper permission switched on a loan or offer names the owner it is for, and a change to a keeper's allowed actions states the actions it had before.

A keeper a lender allowed to start an early exit may now list the loan only at the loan's own rate or below. A higher listing rate makes the seller pay the difference to the buyer out of the sale, so that price is the lender's own decision, never a keeper's.

An automatic extension always ends by a date both sides stated. Each side's extension consent already had to carry a future latest date, but the extension step itself read a missing date as "no limit"; it now refuses instead, and the keeper should treat a missing date the same way.

Closes #3717

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3717-risk-access-wait-and-keeper-listing-rate.md sha256=5655fffc3cfae343317201fa64bb8244bee80f3b2c7b43593fc48d4f1ecdafc0 -->

## Protection events name the account and report role changes (#3719)

Every protection event an account's vault emits now names the account first: switching protection on or off, a setting change, a payout destination, a secondary signer, a lock, and each step of a replacement. An alert service can follow one account's protection without first working out which vault belongs to it.

A new event reports every change to who holds a role on the account, in one common form: the role (the owner wallet, a secondary signer, or the wallet a replacement nominates), the old wallet and the new one. It fires when a signer is added or removed, when a replacement is proposed, cancelled or completed, and when the owner wallet changes. Alerts can then warn the holder as soon as a replacement is proposed, not only when it completes.

The vault's protection code changes, so this reaches a chain by fresh deploy.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3719-protection-events.md sha256=a9b175bc5523f79d1f8642e7a12d14da89e1aa1face6412c9ea79f477c07ec88 -->

## Position tokens are approved one at a time (#3721)

A position token can no longer be approved together with all of a holder's other position tokens. The approve-everything prompt that marketplaces and dishonest websites both use is refused for position tokens, so one careless signature cannot hand over every loan and offer position a holder has. Revoking such an approval still succeeds, so wallet clean-up tools keep working.

Approving a single token works as before. The approval is cleared when the token moves, refused while the holder's tokens are locked, and retired by a later lock. Marketplaces list a single position with that per-token approval.

Nothing in the platform needed the wider approval: its loan sales, offsets and obligation handovers retire the old token and mint a new one, and the platform's own listings approve the collateral, never a position token.

The position token contract changes, so this reaches a chain by fresh deploy. Design: `PositionSaleStateGuardDesign.md` section 3.9.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3721-position-approval-per-token.md sha256=4d1d79de511c5b2fcceb1d78a5075837fa547632acb041f0bae48b2d3d9ca1a3 -->

## Thread — Referral share of the initiation fee

A user can now invite a new user with a link carrying the inviter's wallet address. A wallet that has never borrowed binds that inviter on the chain, once and by its own call. For the first 180 days after binding, every loan it opens as borrower pays a lower initiation fee, and its inviter is paid part of the platform's fee on that loan, straight to the inviter's wallet. Both amounts come out of that loan's own fee, above the treasury floor, so opening loans to collect the share always costs more than it returns.

At the default rates the new user's cut and the inviter's share are each 10% of the part of the fee above the treasury floor after the borrower's hold discount. Both are settings from 0 to 30%. The cut never takes the borrower's total discount past the fee-discount ceiling of half the full fee. The per-loan ceiling the matcher's and integrator's shares already share now bounds the cut and the inviter's share too: the inviter's share is reduced first, then the integrator's, and the cut and the matcher's share never are. To keep that true at every setting, the matcher's rate plus the cut rate may not exceed the ceiling: a change to the matcher's rate, the referral rates or the ceiling that would break this is refused by name. The treasury always keeps its whole floor, and the reserve at least the part the ceiling leaves.

The payment can never stop a loan from opening. If the inviter is flagged by the sanctions list, or the payment fails or arrives short, the share goes to the reserve in the same transaction, and the loan's referral record says which. Nothing is ever held for an inviter. The binding's record carries the end time fixed for that wallet, so the inviter's page can be built from the two records alone. Public counters per asset show what the programme costs.

The binding, the settings, the views and a fee quote for any borrow route are on a new facet. The accept preview now reports the cut beside the fee, and front ends and the indexer need the new ABIs. A takeover of another borrower's obligation counts as the incoming wallet's first loan as borrower. Design and build notes: `docs/DesignsAndPlans/ReferralFeeShareDesign.md`. Closes #3722.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3722-referral-fee-share.md sha256=02250ad06eb50a28587043c1c506f767e4074fda53f8fd910b81ca9ac014c891 -->

## Thread — The app follows the Terms rule the contracts enforce

The connected app now speaks the contracts' Terms rule. Its gate still decides whether a wallet may use the app, and it already reads the contracts' own answer. A wallet that passes the gate is now also told about a coming change. When a material change is announced and the wallet has not accepted it, a notice above the page names the new version, the date and time it takes effect, and what stops from then until the wallet accepts: new positions on that network, including its posted offers and automatic lending. Repaying, claiming and withdrawing never stop. The wallet can read that exact version, accept it early to carry on with no gap, or be reminded later; a reminder put off comes back in the last week before the date. A small change shows one quiet line with the link and an optional accept. If the app cannot read the Terms, it shows no notice rather than guess.

When an offer cannot be taken because one side has not accepted the Terms in force, the app now says so in plain words and that nothing was sent. The gate's own text explains that small changes never ask again and a material change comes with a date.

The loan reserve follows the contracts' rename: the app funds and withdraws the payment reserve through the new reserve entries, and the activity feed names the reserve events and the new standing-instruction and reserve-payment events. The website's Terms scripts and the governance runbook now describe publishing a small change and announcing a material one in place of the retired single setter.

Refs #3734, #3681.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3734-terms-app-notice.md sha256=4528c8407864ad2f7302d5f09524c689fc9ff55eb94b5c493e8cdcfe955c2e54 -->

## Thread — Terms of Service acceptance enforced by the contracts

The Terms of Service rule now lives in the contracts, so a wallet meets it whatever interface it uses. A wallet that takes on a new position must be current on the Terms: both parties to a new loan (only the buyer on a lender's sale), the incoming wallet on any takeover, the wallet posting an offer that gives a new position, a lender setting or funding a standing lending intent, a borrower setting standing instructions, and both position holders when a loan is extended in place. Anything that reduces or ends a position is never asked: repaying, claiming, withdrawing, cancelling, defaults, liquidations, and a lender listing its position for sale. The platform's own backstop vault is exempt. An aggregator adapter never accepts and is never exempt: it answers with its principal's standing, so it is created, funded and filled only while its principal has accepted with its own wallet, and its claims never wait on the Terms (a claim skips re-lending the proceeds instead). The refusal is one error that names the wallet and the version to accept, and every preview reports it before a transaction is sent.

A wallet accepts only by a transaction of its own that it pays for. There is no signature route and nothing records an acceptance for another wallet, by owner decision, for legal clarity. Acceptance works while the protocol is paused, is per network, and can be combined with the wallet's first new position in one transaction of its own.

Each network keeps two values: the latest version and the minimum version. A wallet is current when it accepted a version that came into force, numbered from the minimum to the latest. A small change publishes a new latest version at once and leaves the minimum alone, so nobody loses standing. A material change raises the minimum after at least seven days' notice, either to a new version or to the version already latest; until then standing stays on the old minimum, and a wallet may accept a new version early to carry over with no gap. A small change may put the latest at most sixteen versions above the minimum, which bounds the read every opening step makes; past that, the minimum is raised first. A fresh network can start at any version in one step. Only one change is open at a time. A withdrawn new version's number is spent and never counts; a withdrawn raise of the minimum changes nothing. The old single-step version setter is gone.

Two smaller changes came with it. The borrower's offset now passes the real refusal through instead of a generic creation failure. A new pre-deploy check (step 1d4) fails if anything other than origination, the in-place extension or the obligation handover writes a loan's start or term, so no new way to extend a loan can ship without the Terms check. The combined origination preview (used by the match and intent previews) moved to the price-guard facet to keep the preview facet under the size limit.

Design: [TermsAcceptanceEnforcementDesign.md](../DesignsAndPlans/TermsAcceptanceEnforcementDesign.md). Closes #3734.

> Caveat: an aggregator adapter whose principal is a contract that cannot call the Terms acceptance cannot be created while a version is in force.
> Caveat: a lender's listed sale is covered for the buyer by the loan-creation check, but no test drives a listed sale's fill end to end (the harness cannot run that fill; the direct sale is driven end to end).

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 3734-terms-enforced-by-contracts.md sha256=9713415788f75504a6cce11cfdb0df79e9fad54ed0eab0ac130a4705eb4dfebf -->

## Thread — Observed rates page in the new app (#3751)

The new app has an Observed rates page, reached from Analytics and open with no wallet. For one asset on one network it shows the two halves of the index's rate curve side by side and labelled apart: the term average from the outside rate source, and the figures built from the platform's own repaid loans. They are never blended into one number.

The outside half says it is not available yet, because the protocol's term-average view does not exist on any deployment; no figure is shown in its place. The own-loans half labels each point by the loan lengths it covers ("up to 14 days", "15–60 days", "over 270 days"), never as one term, and shows the median and middle half with how many loans, lenders and borrowers it rests on. A withheld point says "not enough loans yet", or names the other reason (the index could not read the whole look-back); a point the index has not computed says that.

"How this is computed" lists the rule from the index's own answer, every setting, exclusion, interest source and point look-back, so the page cannot drift from what the index did. A daily history for one loan length lists only the days the index filled and says a missing day is not a zero. The page states when the index computed the figures, and a refusal (the request limit, an unavailable chain) or a build with no index shows no figure.

Every figure is described as an average of what was observed, never advice, a forecast or an offer. Advances #3751; the index side is on its own branch.

> Caveat: the page goes live only once the index publishes the rate curve routes; until then it states the read failure.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 3751-observed-rates-page.md sha256=2ccb0096c2de42873dd4d1e694902ad4c885b70d21bd73a8ec65486dba39adb6 -->

## Offers left open on a closed loan can be cleared by anyone (#3753)

A preclose offset offer or a refinance request is tied to one loan. If the loan then closed by another route (full repayment, default, liquidation or a forced sale), the offer stayed on the book. Tests confirmed that accepting it was always refused by name before any value moved, so no funds were at risk. But only its creator could cancel it, or anyone after its expiry, and an offset posted with no practical deadline never expires. Its escrow (the offset's new principal, or a request's fresh collateral) stayed held until then.

Such an offer now counts as a dead route, the same rule a moved position already used. Anyone may cancel it at once, and the existing keeper sweep of dead-route offers picks it up with no keeper change. The refund goes to the offer's creator, as every cancel's does. A loan waiting on the fallback is not treated as closed, because a cure can return it to open.

A lender sale listing on a closed loan keeps its own teardown, which clears more than a cancel does.

Closes #3753.

_Committed 2026-11-19 18:16 UTC (2687a4cbf)._
<!-- assembled-fragment: 3753-closed-loan-vehicle-cancel.md sha256=708c991b58a6f970390bbe949393b40d22cfb3c74b9f4891d0e39809699cb78f -->

## Thread — Interest paid stated per loan (PR #3768)

Every interest payment on a loan now emits one record naming the loan, the asset and the amount. Before this, the protocol counted interest paid only as a per-asset total, and the amount a payment carried could be read only from the record of the route that made it. Several routes name no interest figure at all: a partial repayment, a refinance payoff, and repayment with collateral (full and partial). So a loan's history could not say how much interest it had paid, and the rate-curve work (#3751) could not weight loans by interest paid.

The record is emitted at the one step every interest payment already passes through, the step that grows the lifetime interest counter. Every route is covered at once, and a route added later is covered without anyone having to remember it. The amount is the same figure the counter grows by: the interest the settlement charged, late fee included where the route charges one, before the treasury's share. A forced sale states what it recovered, not what was owed. The record states what the loan paid, not who received it; on a sold loan the seller-claim records already state the split.

A second record is the take-back. When a payment parked for the lender side arrives short and leaves interest still owed, it names the loan and the interest taken back. A later payment that settles that interest states it again. So the interest a loan has paid is the sum of its payment records less its take-back records, which is how the counter itself moves. A recovery in kind (the default and liquidation fallbacks) states no record, for the same reason the counter does not count it: it settles principal, interest and any bonus as one amount.

We chose one record at that step over adding an interest field to each route's own record. The per-route option would change several record shapes the indexer already reads, and the next route could forget it.

The indexer does not read the two records yet. Its event-coverage check lists them as deliberately not handled, with the reason, until the indexer change that stores interest per loan and moves the #3751 band onto it. Each facet that carries the step grew by 63 to 127 bytes; the closest to the size limit, RepayFacet, keeps 452 bytes of headroom.

Closes #3755

_Committed 2026-11-19 12:35 UTC (f2465530c)._
<!-- assembled-fragment: 3755-loan-interest-paid-event.md sha256=a734c966a353b43f231c03550459092bd3ea964d0f8ba2296163bb606f5e2890 -->

## Thread — Borrow now, and lending with no end date (#3761, #3763)

The new app's Borrow page now opens on "Borrow now". The borrower states the amount, the most collateral to lock, the term and the highest rate they accept; no rate is suggested. The app lists the lenders standing ready on the pair (Auto-lends that gave the instant market's fill consent, and lender offers that charge interest by time), cheapest first, and asks the protocol itself what borrowing from them would give in this block, from the borrower's wallet. The review shows that figure, labelled as what this block gives, with each loan, its lender, its rate and the collateral it locks.

Collateral comes from the vault's free balance first and then from the wallet, which approves exactly its part, with the contract the approval is given to named on the review. So that the figure can be shown before that approval exists, the question is asked with the approval in place for the question only; where the token's records cannot be read that way, the review says the figure is not known until the approval is given. Signing asks the protocol again right before the wallet prompt, and the transaction carries the figure shown as the least it borrows, so it never borrows less. Any approval left unused is put back.

Where the lenders ready cover only part, the borrower can borrow that part and then post a request for exactly the rest, read from the transaction's own record. Where they cover none, or the instant market is off on the network, the review says nothing is borrowed now and offers a request. Every loan ends on its due date; renewal is not built yet.

On the Lend side, Auto-lend now has no end date unless the lender asks for one ("Lend for a set period"). Re-lending a repayment is pre-selected only where the platform's keeper reports that step running on the network, and the form says when it is not running or cannot be read. Renewal is shown as not available yet. The review says what no end date means and how funds in a loan come back, without promising a date.

An Auto-lend that already exists gains no instant-market choice by itself. Where the market can take its pair, its card now offers one line, "This Auto-lend can also fill instant borrows", which opens a review of just those choices (each pre-selected and able to be switched off, renewal not available yet), checked by the protocol before and right before signing. It moves no money and changes no limit.

Advances #3761 and #3763.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 3761-3763-borrow-now-and-no-end-date.md sha256=290fb0d25a9c61658a10b5729f4faaa83ee805d3532e23bdd08ddf30b769cba5 -->

## Previews the app can read before a takeover, a direct sale or an instant borrow (#3761)

The new app needed to tell a user what an action would do before asking
for a signature, and three actions had no way to say it except by trying
them. They now each have a read.

A lender handing an instant-market loan to another lender's Auto-lend
intent can see whether the takeover would be accepted now and the
principal the incoming intent would pay. The read runs the takeover's own
admission, so it and the takeover cannot disagree, and a refusal comes
back as the takeover's own reason. The takeover now also checks that the
incoming intent holds enough funded capital for the principal before
anything else runs, so the read refuses an underfunded intent too.

A lender selling a loan into a standing buy offer can see whether the
sale would be accepted, what they would net, the rate shortfall left for
the buyer, and the funds already held for the lender that move with the
position. Before, the app learned the net from the sale's own refusal.
The read runs every check the sale runs before money moves; the app binds
the sale to the figures it showed.

A borrower can see what an instant borrow would take from each source,
which sources would be refused and why, and how much collateral would come
from the vault and how much from the wallet, without approving a token
first. It sizes each source by the fill's own rule but does not run the
loan checks a fill runs when it opens its loan, and says so: a simulation
of the borrow stays the binding answer. A request that names the same
source twice is now refused, by the borrow and by the read alike: a source
can only ever be filled once, and counting it twice made the read overstate
what it could lend.

The late-fee schedule (1% on the first day past due, 0.5% more each
further day, capped at 5%) is now readable, from the same fixed figures
the fee is charged by, so an offer review can state it.

_Committed 2026-11-19 17:08 UTC (b6ad5f6c9)._
<!-- assembled-fragment: 3761-app-preview-reads.md sha256=014fdf510cd0605a0a2fba716ebae5ab90f2c801114bbe8db76b5ea2a133cca6 -->

## Thread — Lend opens on lending continuously, with its choices pre-selected (#3761)

The new app's Lend form now opens on Auto-lend as the pre-selected choice, with one link, "Make a one-time offer instead". A deployment can switch the form to ask instead: "Lend continuously (recommended)" and "Lend once" side by side, neither selected until the lender taps one. The device remembers the lender's last choice for that wallet and network.

The form carries each pre-selected choice as its own switch: re-lend repayments for me (the platform's keeper gets the roll action only, added to what it already holds), interest by time, and the instant market's three consents (fill instant borrows, renew loans this slot made, take over other lenders' loans at face value). A choice the contracts would refuse is off and greyed with its reason: the instant consents need interest by time, the market switched on for the network and an eligible pair, and an answer the app cannot name reads as "not known". Re-lending is never offered for the platform token, and where keeper access is off with other keepers approved it is not pre-selected; switching it on lists every keeper and the actions it would regain, and needs that list confirmed. Rate auction bids, advances and buying existing loans stay visible and off.

The slot's terms, its funding and every chosen consent are sent as one transaction through the batch entry, every step required, so nothing is left half set. The review states each choice as sent, what a slot fills (not a request with a prepay listing or an interest cadence), and that the instant choices are ready a few seconds after landing. Changing an Auto-lend's terms clears its instant consents in the contracts, so the change sends them again in the same transaction, or says they are cleared when the new terms cannot carry them. Nothing is lent from free vault balance.

Until the contracts carry a pair-eligibility view, the app learns whether the instant market takes a pair from a dry run that names its two refusals.

Advances #3761. The Borrow form's "Borrow now" and the card for existing Auto-lends follow.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 3761-default-paths-lend.md sha256=c078c98abbf47de37b15bdd88e7af00d5e0f3ecedad6bc92564e3c908a69a704 -->

## Thread — Instant-market pair eligibility read (PR #3768)

Anyone can now ask the contracts whether the instant market serves a pair. The answer states two things separately: whether the market's switch is on, and whether the pair qualifies (two different assets, both blue-chip). The lend form that opens on Auto-lend with instant-market consents pre-selected (#3761) needs this answer before it shows the consents. Until now the app could get it only by trying the consent write and reading which refusal came back.

The read uses the one pair rule that the consents and the instant borrow already enforce; it is not a second copy, so the read cannot disagree with them. A pair that qualifies reads as qualifying even while the market is switched off, so the app can tell "not offered here" apart from "switched off for now".

Advances #3761.

_Committed 2026-11-19 12:35 UTC (f2465530c)._
<!-- assembled-fragment: 3761-instant-pair-eligible-view.md sha256=47e8ea2eac6d1a364a0eae54d1e5a350dcb3d599141edcd8d9064fcad30d0ae1 -->

## #3763 — Get cash from this loan, and what each loan is

Every live loan's page now says what the loan is, to the side the reader holds. A lender reads that it is a fixed-rate loan to one borrower for its term, that it does not renew, that funds in a loan cannot be withdrawn, and how to get them back sooner. A borrower reads that it is a fixed-rate loan from one lender that does not renew, and whether repaying early pays interest only for the days used. Renewal is not built yet, so no loan says it renews and there is no "Stop renewals" button. The date row is now labelled as the date the loan falls due, never as the date funds come back.

The lender holder of a live loan gets one door, "Get cash from this loan". It lists "Leave it" first, with the date the loan falls due. "Sell now" hands the loan to another lender's Auto-lend at face value where the instant market's takeover takes it (only for a loan opened through the instant market, with interest by time, where the takeover is deployed), or sells it into a standing buy offer. Each states what the lender receives into their vault, as the protocol states it: the handover pays the principal outstanding with no fee, and a sale's figure is the one the sale itself checks. Interest earned and not yet paid stays the seller's and is paid first from the borrower's later interest. "Sell at my price" lists the loan at a rate the lender states, for one to thirty days, and quotes the least they receive as they type.

Whether each route is open is the protocol's own sale-exit verdict. A route that is not open names every reason in the protocol's words and says from when it can open, or that no time is set. Each route is one reviewed transaction, checked again by a dry run from the wallet right before it opens, and its outcome is read from the transaction's own log.

The Vault page now shows each token's balance on three lines: the free balance, which is all Withdraw offers; capital waiting in Auto-lend, which comes out by taking it out of the Auto-lend first; and principal in loans, labelled as not withdrawable because it is with the borrowers.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: 3763-get-cash-and-loan-statement.md sha256=a5ff0d9e68d12dd0cbb89dbcca52e29731bef60fb380806995a57d03a1cab73c -->

## Thread — Terms of Service version 4: the lending risk line (PR #3784)

The Terms of Service are published as version 4. One entry in the list of
key risks changed and nothing else. The lending entry now opens by saying
that lent funds stay in the loan until the borrower repays and cannot be
withdrawn before that, and that the loan may be sold to another lender, but
only if one accepts. The rest of the entry, about what happens when a
borrower does not repay, is unchanged.

The owner chose to put the statement inside the lending entry and to keep
the list at six. A seventh entry was considered and rejected: the statement
concerns lenders only, and a longer list is read less. Stating it only on
the Key risks page was rejected because a lender should meet it before
accepting the Terms, not after. The reasoning is in section 6.1 of the
default paths design (`docs/DesignsAndPlans/DefaultPathsDesign.md`).

Version 3 stays frozen and readable at its own address, as every published
version does. The unversioned Terms address now serves version 4. The
connected app's key-risk list, shown with the Terms before a first
acceptance and on the Key risks page, carries the same sentences.

Publishing on the website does not change what a wallet is asked to accept.
A version becomes the one a network asks for only when the owner configures
it there, and that step is separate and has not been taken by this change.

> Caveat: until version 4 is configured on a network, that network still asks for an earlier version, whose pinned text has the shorter lending entry, while the app's key-risk list already shows the new one.

_Committed 2026-11-19 13:27 UTC (c7fc613b0)._
<!-- assembled-fragment: 3784-terms-v4-lending-line.md sha256=f00a9099b67468ac54a11f69c55a8f8e3b7bcbd3b6bde1abcb77bd383d70c6f5 -->

## Thread: send the tier-table version to each mirror (branch, contract batch)

When governance changes the discount tier thresholds or the per-tier discounts, Base raises its tier-table version, and every mirror should stop honouring tier caches stamped with the old table. A message for that existed on the reward messenger, but nothing ever sent it. In practice a mirror only learned the new version from the next user who acted on Base, so until then it could keep granting discounts under a table governance had already replaced.

There is now a step on the Diamond that sends Base's current version to one mirror. Anyone may call it. The caller pays that lane's fee and gets the rest back, so the protocol budget never pays for repeats. The version is always read from Base's own storage, and a mirror never lowers a version it already holds, so a repeated or late send changes nothing. A chain off the broadcast list is refused. A quote and a read of Base's version come with it.

It sends to one mirror per call by design, the owner's choice over the old loop to every mirror. That loop would have had to be paid for in the governance call, and a single lane that could not be routed would have failed the whole send. The loop and its quote are deleted from the messenger.

The keeper pass that compares each mirror's version with Base's and sends where a mirror is behind ships disarmed. It lands with the contract batch, and until then the step is recorded as a gap in the permissionless-steps ledger.

Advances #912.

> Caveat: until a mirror receives the version, it keeps honouring caches stamped with the old table. The send invalidates old caches, but it does not give dormant users fresh ones; they read as no discount on that mirror until their own next tier push.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: 912-tier-table-version-send.md sha256=28c5ea95d0812ac8cee0a3a4c35b9552445fd3eda8b522e17f416e44383dc9d8 -->

## Auto-lend: the pause for a moving price, in the app

Every Auto-lend now shows its pause for a moving price on its card in Positions. The card reads the protocol's own answer for that Auto-lend and says plainly where it stands: the price is steady and fills can go ahead, fills are paused and why (the price moved fast, the pair does not yet have its last two hourly price checks, or no price can be read), or the owner switched the pause off.

A paused Auto-lend therefore says why it is not lending, instead of looking as if nothing matched. A new pair says fills start after two hourly price checks.

The owner can switch the pause off, or back on, for one Auto-lend. The change goes through the usual review: it is checked against the protocol from the wallet before and again right before signing, moves no money, and its outcome is read from the transaction's own record.

The setup review states that the pause starts on, what switching it off means, and, when the pair's price checks or price would hold fills back now, that too.

_Committed 2026-11-19 17:29 UTC (d5fd7edec)._
<!-- assembled-fragment: autolend-price-pause-app.md sha256=f30864c4fb047e577a979d3aea80d03d7974911441da3b173bb4fbe7710561ee -->

## Notification billing and backstop recovery run under the vault guard

The vault outflow guard refuses any vault movement made outside a guarded action. Three admin and service entry points reached a vault movement without holding the guard, so each would have been refused every time once the guard and they met on one branch: billing a paid notification, returning backstop cash to the treasury, and sweeping warehoused backstop collateral to the treasury. All three now hold the guard. For notification billing, the payer's tier update now goes out when the guard is released, after the bill is recorded, instead of before it; a failed tier push still never undoes the bill.

## A settlement leg gets enough gas for a VPFI move

Each attempt to move a settlement leg is given a fixed gas budget, and an attempt that runs out is treated as if the token refused delivery, so the leg is parked. A VPFI move refreshes both owners' tier records, and after a long quiet period that refresh alone could exhaust the budget, parking a leg that would have delivered. The attempt now does only the token move: the tier refreshes it would trigger are noted and run in the settling step right after the move succeeds, outside the attempt's budget. A refused or parked move notes nothing, so no refresh runs for a balance that did not change. The budget stays at its original size; the funds were never at risk, but the leg no longer parks without cause.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: batch-regression-guard-fixes.md sha256=dcf8ad3344b1411a40f6add53a6b7cc4c8ada49acf57c37ba083a0eca4e921ca -->

## Thread — the testnet deploy script closes the gaps the last fresh deploy hit

The fresh deploy of 3–4 November ran into several script gaps, recorded in `docs/DesignsAndPlans/FreshDeployHardeningPlan.md`. Each one cost a manual repair mid-deploy. Before the next fresh testnet deploy, `deploy-testnet.sh` and the scripts it runs now close the cheapest and most expensive of them.

Every broadcast is now followed by a check of its receipts. A run that lands a failed transaction stops there and names it, instead of letting later steps build on a half-built Diamond (lesson 1: a diamond cut that ran out of gas on Arbitrum Sepolia).

A fresh deploy now keeps the records that do not belong to the Diamond. These are the keeper wallet the app reads, and the standalone sanctions contracts the sanctions services read: the rehearsal list, its delisting timelock, the oracle stand-in and the clearance attestor. They are carried into the new artifact, and the run prints what it carried. The old Diamond's reward-custody activation record is archived with the rest of its state, so the new Diamond is never described as already activated (lesson 3).

A mirror chain's reward-custody activation reads the mirror's own VPFI token from its artifact, instead of stopping for a hand-passed address (lesson 5).

On BNB testnet a pinned gas price now pins the priority tip as well. The node's 0.1 gwei minimum tip had made the first cross-chain wiring run send nothing. WETH also has one variable name on every chain, the same one the oracle reads (lesson 8).

> Caveat: the explicit diamond-cut gas limits, a recovery phase for an interrupted run, the committed topology and settings file, and reusing the pre-deploy gate across chains are still to build; the operating settings are still restored by hand.
> Caveat: an operator `.env` that still sets the old bare WETH names (`BNB_TESTNET_WETH` and similar) must use `<PREFIX>_WETH_ADDRESS` instead; BNB testnet has no default and refuses to run without it.

_Committed 2026-11-19 07:58 UTC (b378474ed)._
<!-- assembled-fragment: fresh-deploy-script-gaps.md sha256=df67e78797c2c32f4b1e2e274422336bc3552f97ca768ccc2b4ee75064626c53 -->

## Security — Position NFTs are not pledged or lent inside the platform

An offer may no longer name the Vaipakam position-NFT contract as its collateral or as the asset it lends. The rule sits in the one offer-creation step every route shares, so it covers ordinary, signed, standing-intent and collection offers alike. The collection offer's own check used to name the platform contract rather than the position-NFT contract, so it never fired; it now names the right one.

A position NFT also can no longer be moved into a user's Vaipakam vault. A vault cannot claim, so a position held by one would leave its payouts with no one able to take them.

Whether positions may ever be pledged inside the platform is an open owner decision. Until it is made, the refusal is the safe state.

_Committed 2026-11-19 09:23 UTC (5de3a7e1d)._
<!-- assembled-fragment: position-token-not-pledged.md sha256=aebb8a0f1b8dd08a4ce898ff524439fd13dfdb9bbd0952cf0e504615a4897927 -->
