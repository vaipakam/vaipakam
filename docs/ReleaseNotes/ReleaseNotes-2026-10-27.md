# Release Notes — 2026-10-27

Today's work tightens what an accept and a match may agree to, and reshapes how reward VPFI moves between chains. Every accept now signs only the terms its review showed and runs the token screen, signed-offer fills included, and a match pairs only offers that chose the same loan terms. A day's reward budget may now reach a mirror in several sends, and a retired mirror can send its leftover reward VPFI back to Base. On the fee side, the borrower fee's old VPFI-custody path is removed, collateral sales pay one proceeds leg to the platform, and a rental carries no collateral. Several reward shims kept only for in-place upgrades are retired, since every chain gets a fresh deploy, and feed bindings for bridged tokens are now proved from the canonical bridge. None of the contract changes has reached the testnets yet.

## Pre-deploy gate tells keeper-bot call drift from error-list drift (PR #2940)

The pre-deploy gate's ABI step compares the public keeper bot's committed ABIs with the compiled contracts. It used to compare each file as a whole. Every facet carries the whole shared custom-error list, so adding or removing a single error marked most of the bot's ABIs stale, even though none of the bot's calls had changed. The warning was on after nearly every contract change, so nobody read it, and it would have hidden the drift that does break the bot.

The gate now sorts the difference into two kinds. If a function's selector, arguments, result or mutability differs, the gate prints the same warning as before, because the bot's calls may no longer match the Diamond. If only the error or event list differs, it prints a lower-level note instead: every call still works, and only some reverts and events decode as raw bytes until the next bot ABI sync. An ABI that does not parse, or that holds an entry of an unrecognised type, is treated as function drift, never as the milder kind. The frontend ABIs are unchanged: any drift there still fails the gate. The classifier has its own test cases, which run in CI on every pull request.

Run against the bot's current ABIs, the new gate reports error-list drift only, in seven of its twelve files. Function drift in any of the bot's files still produces the warning.

Closes #1564.

_Committed 2026-10-27 04:07 UTC (d093d6d6f)._
<!-- assembled-fragment: 1564-keeper-abi-drift-classes.md sha256=fbd7e9285790d9e4ea2dd949da7fee85dee5c09c9c0e533977df7e6a3df788b4 -->

## Release notes — the assembler names fragments to read together (PR #2946)

Release-note fragments are written one at a time, against the code as it stood
when each change merged. Two can each be true and still contradict each other
once they sit in the same dated file, and the assembler deletes the sources as
it folds them in, so nobody reads them side by side afterwards.

When a run folds two or more fragments into one file, the assembler now lists
them by name and asks for one read-through of their limits against each other
before the commit. A fragment can mark a limit or known gap with a line starting
"> Caveat:", and the list shows those lines under the fragment's name. This is a
prompt, not a checker: the assembler does not judge whether the fragments agree.

Closes #1831.

_Committed 2026-10-27 08:05 UTC (460505398)._
<!-- assembled-fragment: 1831-assembler-read-through-prompt.md sha256=26f099a75e7fc3785cc20a913317f7084507819fcf89ef63f59d0172bb8f24c1 -->

## Fees — the borrower fee's old VPFI-custody path is removed (PR #2954)

An early design charged the borrower's Loan Initiation Fee in full, up front, in VPFI. That VPFI sat in protocol custody for the life of the loan. At the end it was split: a rebate went back to the borrower on a proper close, and the whole amount was forfeited on a default or liquidation. Since #1352 the fee has been charged in the lending asset at acceptance, and no new loan could reach the old path. The platform is pre-live and every chain gets a fresh deploy, so no loan was ever left on it either. The code that remained only served loans that do not exist, and every reader of it had to work out that it was dead. The owner decided to retire it (#1980).

The path is now gone from the platform. The up-front VPFI charge, the settle-or-forfeit step that every close-out used to call, the payout of the rebate into the borrower's vault, the borrower half of the hold-tier discount helper, and the view that reported a loan's held VPFI and rebate have all been removed. Two events went with them: the rebate-claimed event and the old discount-applied event. The position summary no longer carries held-VPFI or pending-rebate fields. The close-out freeze no longer has a third claim lane for the rebate, so a borrower's claim pays remaining collateral and held proceeds only. The per-loan storage record that held the custody keeps its storage position under a retired name, so the layout of everything after it is unchanged, and nothing writes or reads it. The two recycle-source labels that classified a forfeited or treasury-bound fee stay in their list, because that list only grows, but nothing produces them.

What a borrower sees does not change. The fee is charged in the lending asset at acceptance, and the borrower's hold-tier discount reduces it then. Where the per-party Full tariff is enabled, a party's tariff is charged in VPFI and credited to the recycle bucket. No VPFI is held for a loan, no close pays a borrower rebate, and a default or liquidation forfeits nothing VPFI-related on the borrower side. The lender's yield-fee discount is unaffected. The docs say the same thing throughout: the tokenomics and project specs, the project guide and security scope, the glossary, the two discount ADRs (each with a dated supersession note), the operator knobs guide and token-rotation runbook, the whitepaper, and the Basic and Advanced user guides in all ten languages. The guides also lose two stale lines that said a prepay sale's rebate "cannot currently be collected", and the Japanese and Korean create-offer risk lines now match English. In the code-versus-docs audit, the consent-off rebate finding (#1255) is resolved as moot and the two-mode row is marked resolved for the borrower half.

Closes #1980.

_Committed 2026-10-27 10:48 UTC (0c72d6251)._
<!-- assembled-fragment: 1980-retire-borrower-lif-vpfi-custody.md sha256=2c525f1f5a29aa579906b23c9391e50b099a40b6c1cb9e75206aa234cba93505 -->

## Thread — An accept signs only what its review showed (PR #2936)

Accepting an offer means signing a typed statement of the deal, and the
contract refuses the accept if any signed term differs from the stored offer.
That protects against a cloned interface, but only for the terms the user
actually saw. The app's reviews showed the amounts, rate, duration and
interest mode, and compared those few before opening the wallet. The rest of
what the signature binds was signed without being shown: the interest-payment
schedule, whether the borrower may repay in parts, whether the collateral may
be listed for sale during the loan or before acceptance, a collateral listing
already live, a refinance target and a linked loan.

Every accept review now lists those lifecycle terms, read live from the offer
and stated even when they are the defaults: the direct accept, the NFT rental
and the signed-offer fill. All three signers now share one model of the signed
terms. Each signed field is classified as a term of the deal, the acceptor's
own choice, or bookkeeping. Every term of the deal is compared with what the
review showed, and the wallet is not asked to sign if any differs. A field
added to the signed terms later fails the typecheck until someone classifies
it, so it cannot slip past the comparison. A change to the listed terms while
the review is open clears the consent tick.

The illiquid acknowledgements are narrowed the same way (#2728). The direct
accept and the rental used to name both legs in every signature, relying on
the review having warned about whichever leg was illiquid. Now a leg is named
only when the review showed that leg as illiquid. A leg that turns illiquid after
the review is refused before signing (and by the contract, if it turns during
the transaction), so the user is shown the warning and asked again. The rental
names only the rented NFT, whose own model the rental review discloses; a
signed-offer fill names neither, and refuses an illiquid pair outright as
before.

Closes #2725. Closes #2728.

_Committed 2026-10-27 03:45 UTC (76bd23523)._
<!-- assembled-fragment: 2725-accept-binds-every-term.md sha256=c46477611be4e3a8e84399cc6a63b8c0a08344ddd4d5a7141d1f05dbd1d1df97 -->

## Thread — Every accept runs the token screen, signed-offer fills included (PR #2936)

The independent token-security screen (honeypots, sell restrictions,
fee-on-transfer tokens and similar) is meant to stand between a user and any
deal carrying a token outside the curated list. The direct accept and the NFT
rental ran it, each with its own copy of the check, but the Rate Desk's fill
of a gasless signed offer did not run it at all. Signed offers are admitted
for any ERC-20 pair, so a maker could post one on a hostile token and a taker
could fill it with no warning.

The screen now lives in one place and is enforced where every acceptance is
signed. Both accept signers (the one behind the direct accept and the rental,
and the one behind signed-offer fills) re-screen every ERC-20 leg of the terms
they are about to sign and take the verdicts the review showed as a required
input. A blocked token refuses, a check that cannot run refuses, and a warning
passes only when the review showed that exact warning. A new accept surface
cannot reach a wallet prompt without the screen, because it cannot reach
either signer without it.

The reviews share the same screen too. The signed-fill card now shows the same
block, warning or not-screened notice as the other reviews, holds its accept
button while a verdict is pending, failed or blocking, and clears the consent
tick when a verdict arrives or changes. The rental now screens a collateral
token as well as the prepayment token when a listing carries one. Posting an
offer re-checks at signing time through the same shared check.

The indexer still admits signed offers on any ERC-20 pair; screening at
admission would need the indexer to call the screening service and is not part
of this change. The browsing badges and the fill-time screen cover it.

Closes #2726.

_Committed 2026-10-27 03:45 UTC (76bd23523)._
<!-- assembled-fragment: 2726-signed-fill-token-screen.md sha256=8e209634a9b4ef475b5b4d84fd399570ef22d68bbfc127401c3590f497040f43 -->

## Thread — a match admits only offers that chose the same loan terms (PR #2933)

A permissionless match pairs a lender offer with a borrower offer and opens
one loan binding both of them. Until now the match compared assets, duration,
amount, rate and collateral, but not the lifecycle terms each party chose: the
interest mode (full-term or pro-rata), whether partial repayment is allowed,
whether a prepay listing is allowed and the periodic-interest cadence. The
loan took those terms from the borrower offer alone, so a lender who had offered
full-term interest and no prepay listing could find
themselves in a loan on the other side's terms without having agreed to them.

A match now admits only a pair that agrees on every one of those terms, and,
for an NFT rental, on the asset the rental fee is paid in. A pair that differs
is refused with a new lifecycle-terms reason, by the match and by the bot-facing
match preview alike, so matching bots skip the pair instead of spending gas on
it. Whether the borrower allows a parallel sale of their open offer is not a
loan term and is not compared: only a borrower offer can carry it, and it
governs the open offer, never the loan, so comparing it would make every such
offer unmatchable. A standing lender intent stands for full-term
interest with no partial repay, no prepay listing and no periodic cadence, and
the intent fill now records full-term interest on its slice, so the same rule
holds on that path. Direct acceptance is unchanged: the accepting party takes
the offer's terms as written.

The new refusal reason is appended after every existing one, so prior reason
codes keep their meaning. Closes #2727.

_Committed 2026-10-27 03:53 UTC (a4a039d9e)._
<!-- assembled-fragment: 2727-match-lifecycle-terms.md sha256=b433e383b897b21e830349d11f118ca9c263e3a2bbe857fa47c293992d3d4745 -->

## Thread — Secondary oracles ask about an asset under its registered feed name (PR #2929)

Tellor, API3 and DIA cross-check each Chainlink price. They used to be asked
about an asset under its own `symbol()`, read live from the token. A token
controls its symbol, and an upgradeable one can change it, so a token could
point its own cross-check at another asset's price. A malformed `symbol()`
reply also reverted the whole price read instead of reading the secondary
as unavailable (#2745).

The asset's identity for the secondary sources is now the name of the
Chainlink pair registered for it in the chain's feed registry: "LINK" for
"LINK / USD". The registry publishes it through a new read, and the oracle
asks it under the same quotes, in the same order, as the primary price read.
That name was checked against the feed's own description when governance
registered it, behind the registry's delay and the guardian's veto, so it
comes with no new per-asset setting. Wrapped ether is asked about as ETH.
The oracle never reads a token's symbol any more, and a registry reply that
is not exactly one word reads as no identity rather than a failure.

An asset with no registered pair, such as one priced by an industrial-fork
direct-feed override, now gets no secondary check: its price stands on
Chainlink alone, exactly as when no secondary source answers. The per-token
override first sketched for this was not built, because a name the
secondary sources do not recognise only reads as unavailable. OracleFacet
is about 1.1 KB smaller, since the symbol decoder is gone.

Closes #2745.

_Committed 2026-10-27 00:32 UTC (d25bf116f)._
<!-- assembled-fragment: 2745-secondary-oracle-identity.md sha256=4acda081140aee07b5c16c92e199ea554e9ffa0d4b00f0ba0e390e7e752c9177 -->

## Rate-model band: points cap, share of the market rate, points floor (PR #2942)

A registered rate model's quote was clamped to a fixed band of plus or minus
5 percentage points around the market rate the caller supplies. That is loose
on a low market rate (around a 1% market it let a quote fall to 0% or rise to
6%) and fixed regardless of the rate it surrounds. The band is now set by
three governance limits: each side is the tighter of a cap in percentage
points (default 5 points) and a share of the market rate (default 50% of it),
and never narrower than a floor in percentage points (default 1 point). The
band never goes below 0%. With the defaults, a 1% market allows 0% to 2%, a
4% market 2% to 6%, a 12% market 7% to 17%, and a 0% market 0% to 1%.

The three limits are set in one admin call, each with its own bounded range
and a reset-to-default value, and a floor wider than the cap is refused.
The floor in effect is also never above the cap in effect, so a cap set
under the old single-value setter is not widened by the new floor's default
when a Diamond is refreshed in place. The
single-value setter for the old cap is retired (the platform is prelive, so
no compatibility route is kept); the getter for the points cap is unchanged
and two getters are added. The Protocol Console shows all three limits and
labels which two are percentage points and which one is a share of the market
rate. The quote stays a dormant opt-in: no offer path calls it today, so this
changes no live rate. The two new limits are appended storage fields that read
as their defaults until set.

The rate model, its band and the quote now live together in one new facet
(RateModelFacet), moved off AdminFacet and OfferCreateFacet with their
function selectors unchanged. The move was needed because the wider clamp
took OfferCreateFacet over the contract size limit; it also puts the setter
and the clamp it governs in one place, so they can no longer be refreshed
apart. The curated stale-facet refresh refuses a Diamond that does not yet
have the new facet. The change reaches the testnets with the all-waves
deploy.

Closes #2748.

_Committed 2026-10-27 12:49 UTC (0fea0a994)._
<!-- assembled-fragment: 2748-rate-model-band.md sha256=d5487ceb621497595e6ab1bf68fe125e2ccf3a57e64248aa53723f574543e4db -->

## Thread — Two read views bounded by the rows they read (PR #2932)

Two views could grow past what a node will serve in one call (#2751). The per-pair offer ranking the Rate Desk reads returned the whole bucket for a pair, so enough cheap offers in one pair could push the read past an RPC's gas or payload limit and blank the book. It now takes an offset and a limit, and still reports the bucket's full size in the same call. The Rate Desk reads one page up to its existing 600-offer cap and falls back to the indexer when the bucket is larger, as before; it no longer needs a separate size probe that the bucket could outgrow between the two reads.

The match-eligible loan view, which the internal-match keeper pages through, stopped only once it had filled a page. With a band few loans fall in, one call walked the whole active-loan list with an oracle-backed loan-to-value read per row. Its page size now bounds the rows it reads, so a page can come back empty with the scan unfinished; the end is when the returned cursor stops advancing. The reference keeper bot is updated to stop on that, not on an empty page.

Both views compare before they add, so a caller asking for "everything" with the largest possible limit reads to the end instead of failing. The other filtered views that skip an offset of matching rows by walking the list (by asset, by status, the dashboard pages) have the same shape and are tracked in #2930; the id-range loan views are #1832. Closes #2751.

_Committed 2026-10-27 01:43 UTC (198107977)._
<!-- assembled-fragment: 2751-bounded-views.md sha256=9075a5080f079f3c812b068243674a8d23a79557a22cd0cc057151859cb9647f -->

## Thread — Security hygiene batch: interface discovery, dust impact, metadata text, listing release (PR #2964)

The platform contract now answers the standard interface query (ERC-165) truthfully and completely. Until now it recorded only the position NFT's interfaces, so it denied supporting the interface query itself, the Diamond's cut and inspection interfaces, ownership, and the ERC-1155 receiver it hosts; an integration that checks before a safe transfer could refuse it. One list now names every interface, a fresh deploy records it right after the facets are cut, and a deploy test checks every claim against the functions the Diamond actually routes. Advertising the ERC-1155 receiver does not open the Diamond as a sink: it still accepts an incoming NFT only as one step of its own collateral moves. A test that expected a bare revert from the offer matcher now expects the matcher's own error, so it can no longer pass on an unrouted function. Closes #2752.

The liquidity probe's price impact now counts the swap fee as the pool actually takes it, in whole units of the token sold. For a normal trade nothing changes. For a trade so small that the fee's rounding is a visible share of it, the impact now reports that share, and a trade whose fee leaves nothing to swap reads as a total loss instead of as just the fee. Because this makes a tiny trade read worse than a slightly larger one, the tiering no longer assumes impact grows with size: an asset earns a tier only by clearing every probe size up to that tier's own. Neither change affects any asset at the probe's real sizes, which are thousands of dollars.

Position NFT metadata now cleans the token symbols it shows (#2750). A symbol is chosen by the token's own contract, and one holding a quote or a backslash could end its text field early and add its own fields (a misleading name, image or link) to what marketplaces render. Symbols are now limited to printable characters other than quotes and backslashes, with every other character shown as a single question mark, and cut to 32 bytes. Closes #2750.

Releasing a parallel-sale listing no longer depends on moving the collateral (#2735). After a release the platform still tries to move the borrower side to the current holder's vault, but if that move fails the release stands and an event reports the failure; before, the failure rolled the release back and left the collateral listed against a stale fill. The holder can run the same move later on its own. Closes #2735.


Fresh deploy only: a Diamond deployed before this change keeps its old interface answers until it is redeployed.

_Committed 2026-10-27 17:36 UTC (ff11594cd)._
<!-- assembled-fragment: 2752-2735-2750-security-hygiene.md sha256=1f73ad28f6224d320685eba100ff249ad26510a7577c92888c3cefcb7a69b788 -->

## Thread — Tenderly: retire the broken actions, and refuse an alert preset that can never fire (PR #2979)

The Tenderly actions manifest named three retired Diamonds, and the four Web3 Actions it deployed had never worked: the folder had no package file to build them, the health-factor watcher called a function the Diamond does not have, the large-loan action decoded an old event and loan shape, and each action read one project-wide Diamond address, so none could serve more than one chain. The owner chose to retire them (2026-10-27) rather than rebuild them. The four actions and their manifest are gone, and so are the four alert presets that pointed at them. The signals they were meant to give (a pre-liquidation health-factor page, a feed-heartbeat warning, L2 sequencer transitions and a large-loan flag) now have no confirmed home; #2968 lists each one, so the gap is stated rather than hidden behind code that did nothing.

The remaining alert presets had drifted too. The default alert named an old shape of the default event, the fallback alert an old shape of the fallback event, and the health-factor liquidation alert an event the platform declares but never emits. Tenderly accepts such a preset and it simply never fires. The presets now name the events the platform emits today, and the export script that expands them per chain checks every Diamond preset against the Diamond's compiled interface and refuses the whole run, writing nothing, when a preset names a signature the Diamond does not carry. The check proves the signature exists, not that something emits it; the timelock preset is reported as unchecked because no timelock interface is committed.

Closes #2869.

> Caveat: discounted, partial and matched liquidations have no alert preset (tracked in #2968).

_Committed 2026-10-27 21:47 UTC (423426dd2)._
<!-- assembled-fragment: 2869-retire-tenderly-actions.md sha256=2b6bc2fa73785ebeae2c6bad6dfa50cbde0a65ba06378b859a99042988497dc6 -->

## Thread — Activity shows what a collateral sale paid, and each party's part (PR #2962)

A collateral sale now appears in Activity with the amount the buyer paid, in the loan's lending asset. Below that, each party sees their own part. The lender's part is held until they claim it. The borrower's remainder is shown as either sent to their wallet or held until they claim it, matching what the sale did. Before this, the row named the split but stated no amounts, so neither party could tell from Activity what they were owed or where it had gone.

The indexer records the paid amount when it reads the sale event. The asset type comes from the loan record, and when the event's asset is not the loan's lending asset, or the record is missing, the row says no amount was recorded rather than guessing. Each party's part comes from the amounts the sale event names for that party, and is shown only when the indexer has established the paid amount as a token amount. Refs #2876.

_Committed 2026-10-27 12:33 UTC (9acd2387c)._
<!-- assembled-fragment: 2876-activity-sale-split.md sha256=aad1659c702da4e7246bf93be2a595f7611b763ac6e89d8d435d308c9d7b39ff -->

## Thread — Collateral sales pay one proceeds leg to the platform (PR #2916)

A loan's own collateral listing used to ask the marketplace to pay three
parties directly: the lender-position holder, the treasury, and the
borrower-position holder, each a fixed amount written into the order when
it was posted. A borrow-or-sell listing carried into a loan was shaped
differently: it paid the whole price to the platform, which split it. The
two could pay the same sale differently, the loan's listing could not give
the lender the yield-fee discount a repayment gives, and its signed amounts
went stale as interest accrued or a position changed hands.

Both listing types now pay the platform one proceeds leg (the sale price
net of the marketplace fee legs), and the platform settles the loan in the
same transaction by one rule, as a repayment funded by the collateral, at
what a full repayment at the moment of the fill would owe. The loan becomes
repaid, exactly as after a repayment: the lender's due, plus any yield-fee
discount the current lender-position holder qualifies for, waits in the
lender's vault for the ordinary lender claim; the treasury receives its
share net of that discount; and the current borrower-position holder
receives everything above that in their wallet. When that holder is flagged,
or their wallet refuses the payment, the remainder is held for them and paid
by the ordinary borrower claim, using the same pay-or-hold rule the periodic
forced sale already used. The loan settles when the lender claims, as after
any repayment.

The sale is neutral between the two sides. Before, the whole sale was
refused when either position holder was flagged, or when the lender's wallet
refused the token, so one side could stop the other's payout. Now a flagged
lender holder, or a lender wallet that would refuse the token, cannot stop
the borrower's sale or get a standing listing cancelled, because the lender is paid through the claim, which
decides on its own screen when the money may leave. A refusing borrower
wallet cannot stop it either. The one refusal left is the borrower's own: a
borrower-position holder flagged by the time of the fill cannot sell their
collateral, and the loan simply stays open with all of the lender's rights.

The loan is marked repaid before any payment moves, so nothing a payment
reaches can repay or sell it again. A fill that pays less than the lender's
due plus the treasury's share is refused, both by the listing's zone and
again by the platform, and so is a fill after the grace boundary. One event,
CollateralSaleProceedsSplit, names every amount and says whether the
borrower's remainder was paid or held, for either listing type; it replaces
the parallel-sale-only split event. The indexer now records a sold loan as
repaid (claimable) instead of settled, and the inbox tells both sides about
the sale. A Dutch listing's posting floor is still
priced at its auction's end; its payout is what is owed at the fill, with
the excess going to the borrower side. The grace-period auto-list now
decides that an old order can no longer fill by reading its proceeds leg at
the current block against the live floor, and the executor no longer keeps
a per-order copy of the signed lender and treasury amounts.

Closes #2876 (owner decision 2026-10-26, "One proceeds leg"; neutrality per
owner direction 2026-10-27). This changes the executor's storage, the order
shape and the sale's close, so it reaches a chain only by fresh deploy; the storage-layout break is acknowledged. The off-chain order
builder the indexer uses to publish a listing to OpenSea builds the same
one-leg shape in the same change, so a published listing's reconstructed
order still matches the one the platform signed.

_Committed 2026-10-27 11:55 UTC (cb8e79d8a)._
<!-- assembled-fragment: 2876-one-proceeds-leg.md sha256=c84886db5489a24e29e0245753fa7b6c160222da35ce159dddeaa7004dd068f1 -->

## Feed bindings: bridged tokens proved from the canonical bridge (PR #2965)

The feed-bindings drafting tool resolves which token a price feed means from
three independent lists, and drafts a binding only where all three name the
same address. On Arbitrum, Polygon, Base and Optimism most of the tokens are
bridged from Ethereum, and many review entries were a token that one list
simply omitted. The tool now also asks each chain's canonical bridge which
token stands for the Ethereum token that Ethereum's own reviewed file already
settled for the same symbol. Arbitrum's gateway router and Polygon's child
chain manager answer that directly. On Base and Optimism a bridged token's
own report could be forged by anyone deploying a token. There, the proof is
the standard bridge's ledger on Ethereum: the token holding more than half of
what the bridge has locked for the Ethereum token.

The proof is evidence beside the lists, never a replacement for them. It
confirms a drafted binding. It sends one back to review when the bridge names
a different deployed token, as with Polygon's native USDC against bridged
USDC.e, where choosing between native and bridged stays a person's call. It
settles a review entry only where at least two lists name the bridge's token
and no list names another. Run against the current files, it settles 23
review entries (Arbitrum 5, Polygon 5, Base 7, Optimism 6) and sends
Polygon's two USDC bindings to review. The bindings files themselves change
only when the drafting run is repeated with the source keys, which happens on
the owner's machine.

Refs #2880.

_Committed 2026-10-27 13:28 UTC (f95408dab)._
<!-- assembled-fragment: 2880-bridge-provenance.md sha256=c66c41036dd7c7ea44455c62c5b925da31f880860a938a6c92b0c1388a3c794d -->

## Feed bindings — redrafted with bridge proofs (PR #2971)

The reviewed feed-bindings files for Ethereum, Base, Optimism, Arbitrum and Polygon were redrafted with the bridge-provenance check from #2965, against the price-feed directory as it stood on the day of the run. On each L2, an entry the market-data sources and token lists had left for review is now drafted when the chain's canonical bridge names the same token those sources name and no source names a different one. The bridge's evidence (method, the Ethereum original and the bridged address) is recorded beside each such binding, so a reviewer can check it.

Drafted bindings rose from 18 to 25 on Base, 15 to 21 on Optimism, 18 to 23 on Arbitrum and 20 to 26 on Polygon; Ethereum is unchanged at 69. The rest stay in review, including natively issued stablecoins, which no bridge can prove. Refs #2880.

> Caveat: these files are drafting inputs. A binding reaches a chain only through the feed registry's delayed, guardian-vetoable change, so nothing here changes what any deployed Diamond prices today.

_Committed 2026-10-27 17:10 UTC (b15aa0394)._
<!-- assembled-fragment: 2880-feed-bindings-rerun.md sha256=795e5507b9c5b32a854d2e815c51abe7589d756936c6e3ae90bf537be5402b90 -->

## Rewards — the legacy envelope import is retired, and every reward delivery must add up (PR #2945)

A mirror chain keeps an "uncounted" tally of reward value that arrived without
a split saying how much of it was fresh funding and how much was recycled.
Until now there were two ways value could enter that tally and stay there with
nothing to classify it:

- a Diamond upgraded in place carried value that arrived before deliveries were
  stamped with an identity. An administrator imported that inventory once, as
  one aggregate, through a dedicated "envelope" entry with a preview and a
  read-back view;
- a delivery on the older, non-epoch path whose fresh and recycled figures
  added up to less than what arrived left the difference in the tally, where
  no packet record could ever classify it.

Every chain reaches this build by a fresh deploy, so there is no pre-stamp
inventory. The ingress now refuses any delivery whose fresh and recycled
figures do not add up to exactly what arrived, on both the epoch and the
non-epoch path, before anything else is recorded. The refusal is
re-executable, so a delivery is never lost to it. With both sources closed,
the tally on a fresh deploy only ever rises by an amount it also records
elsewhere: value held aside for a return, which the returned-value total
explains once it goes back.

Removed together:

- the envelope import, its preview and its read-back view, its event and the
  three refusals it could raise;
- the custody helper only that import used.

The administrator's per-packet classification and its correction are
unchanged. The envelope's storage keeps its place, renamed retired, so the
storage layout only grows.

Refs #2910.

_Committed 2026-10-27 07:49 UTC (fd8f640f7)._
<!-- assembled-fragment: 2910-retire-envelope-import.md sha256=08acea25c34c04f9e75cb92ee40529a0bc812514b32812ea6b8f74f0dfa33e54 -->

## Rewards — the paid-side seed and rebase are retired (PR #2944)

Every chain that runs delivered reward accounting keeps two running totals:
how much reward funding has been delivered to it and how much it has paid
out. Two one-time administrative calls existed for a Diamond upgraded in
place from a build that did not keep the paid total. They wrote a
reconstructed paid figure into it, and on the canonical chain they set the
delivered total to match. Each had a one-shot guard. Until the second one had
run, the custody activation refused, every pre-activation funding, relocation
and release refused too, and the all-facets refresh had a bootstrap mode that
asked the operator for the reconstructed figure.

Every chain reaches this build by a fresh deploy, and a fresh deploy starts
with both totals at zero: there is no paid history to import. The deploy only
ever called both writers with zero, to close them. They are removed together
with everything that served them:

- the two administrative writers, their events, the two "has it run" views
  and the seven refusals they could raise;
- the activation's and the pre-activation custody writers' requirement that
  the rebase had run, and its two refusals. The activation still verifies, on
  the canonical chain, that delivered equals paid, which a fresh deploy
  starts at;
- in the deploy, the step that closed both guards;
- in the all-facets refresh and its testnet wrapper, the bootstrap mode: the
  pause-epoch and reconstructed-figure answers, the preflight checks on them,
  the seed and rebase calls and the "bootstrap complete" exit. The wrapper now
  exports only the reward-role answer the role backfill needs;
- in the activation script, the check that the rebase had run.

What an operator sees: the refresh no longer takes the paid-total answers and
has no bootstrap mode, and activation no longer waits for a rebase. A mirror
that ends up paying out more than it was delivered (a deficit) still gets the
same restitution split when it is next funded. The two storage flags keep
their places, marked retired, so the storage layout is unchanged.

Refs #2910.

_Committed 2026-10-27 05:50 UTC (7d6d093cc)._
<!-- assembled-fragment: 2910-retire-paid-side-seed-and-rebase.md sha256=398ada2e15104def218bc089a89112e52ea861dc4ded7007966ccfa83fb43384 -->

## Rewards — the recovery-attribution watermark is retired (PR #2931)

The recovery position on the canonical reward chain was guarded by a
watermark. It was a one-shot arming step that froze every recovery receipt
created before per-receipt attribution existed, so a Diamond refreshed in
place could not let an old receipt, whose spends had been tracked only as a
total, draw on a newer receipt's backing. A fresh canonical deploy armed that
watermark at zero before its first receipt existed, so on this build it never
held anything back. Every chain reaches this build by a fresh deploy, so the
watermark is removed, together with everything that read it:

- the administrator's arming call and the arming step in the in-place refresh;
- the custody activation's requirement that the watermark be armed, and the
  matching check in the activation script;
- the rule that kept an old receipt's late return or recovery ceremony out of
  the recovery position. Every stranded return and recovery-ceremony inflow
  now credits its receipt's recovery position;
- the separate "returned" figure the unclassified custody row kept for such
  returns. The unclassified row now holds only deliveries' unattributed
  remainders and quarantined compensation; its read-out reports what the
  row holds and how much of the stranded-recovery reservation it backs.

Nothing changes for an operator of a fresh deploy: the arming was automatic
when the chain was made canonical. The two watermark storage slots and the
returned figure's slot keep their places, marked retired, so the storage
layout is unchanged.

The same change drops the generation-1 wording around the remit
acknowledgement's classification. The wire still offsets the classification
by one, so a zero word is never read as a classification, but no
generation-1 messenger can deliver on this build.

Refs #2910.

_Committed 2026-10-27 02:47 UTC (5959a6461)._
<!-- assembled-fragment: 2910-retire-recovery-attribution-watermark.md sha256=498d9ae106679c5164aa55d1422035551a3bea4f66d3af398edb8e20daa3fd12 -->

## Rewards — the remittance history rule is retired (PR #2941)

Two facts on a reward remittance's record were added after remittances had
already been released and finalized on Diamonds upgraded in place: how much of
a released remittance's recycled share is stranded in transit, and whether a
consumed remittance's recycled share has been booked against its destination.
A history rule filled both in for those older records, lazily where they were
read and through a public walk anyone could run, and the mesh watcher held back
its relocated-custody check until the walk had covered every record.

On this build a release writes its stranded share in the same transaction that
marks the remittance released, and every attested consumption books its share
in the transaction that records it. Every chain reaches this build by a fresh
deploy, so no record can be missing either fact, and the history rule is
removed together with everything that served it:

- the public history walk and its event, and the lazy stamping a recovery
  ceremony or a terminal-loss record performed first;
- the separate "booked from history" figure on the canonical chain and the
  three read-outs that reported it, the rows behind it and how much history
  was still unbooked;
- in the keeper, the "not stamped yet" state of a released remittance and its
  alert wording. A released remittance whose read shows nothing stranded and no
  compensation gate is finished; one whose read lacks the figure stays open;
- in the mesh watcher, the history-pending gap, the history reconstruction from
  the mirror's receipts and the advisory that compared declared history shares.
  The relocated-custody check compares the acknowledged share with the mirror's
  relocated custody directly, every tick.

Nothing changes for an operator of a fresh deploy: the walk had nothing to do
there. The governance runbook's post-refresh walk step is removed. The two
storage fields keep their places, marked retired, so the storage layout is
unchanged.

Refs #2910.

_Committed 2026-10-27 05:08 UTC (184fb268c)._
<!-- assembled-fragment: 2910-retire-remit-history-rule.md sha256=3f105156dd055b1db72d9fa66e4681fedbb7104e7f7e40310c89c4650eb87838 -->

## Keeper roll pass leaves VPFI intent loans to their owners' claim (#2914)

Lender intents can now lend VPFI (#2914), but auto-roll still refuses a VPFI
loan, because its repayment proceeds stay reserved until the position holder
claims them. The keeper's roll pass now reads the VPFI token once per chain per
run and skips those loans without asking the chain to estimate each roll.

Any other loan the roll refuses because it settles through the normal claim (a
transferred position, held proceeds, a reservation, nothing left to roll) is
now counted as left to its owner, not reported as a failed fee estimate. The
pass's summary line states how many loans were left that way.

_Committed 2026-10-27 03:39 UTC (dc168b8ce)._
<!-- assembled-fragment: 2914-keeper-roll-vpfi.md sha256=eb81d7e1a187d378306b6bf6d2348beb5c2feb7d21b160989f62aace4d88e57b -->

## Launch — readiness now checks that a chain runs the reward role meant for it

Launch readiness had no check on the reward role. The reward configure step
decides it from the chain (Base is the canonical reward chain, every other
chain that runs rewards is a mirror), but if that step never ran or stopped
partway, nothing at launch noticed. A Base Diamond left unconfigured would
launch, and the zeroed-day lapse schedule check added for #2909 would report
"does not apply", which was true of the stored role and hid that the role
itself was wrong.

Readiness, which the launch script, the post-deploy verify phases and the
on-chain launch gate all read, now has a tenth check. The launch declares the
role it expects, and the check compares the chain against that:

- Canonical on Base and Base Sepolia.
- Mirror on any other chain whose deployment records a reward messenger.
- No reward stack (the Diamond stays unconfigured) when the deployment records
  no reward messenger, as on a deploy that skips the VPFI and cross-chain
  stack.

A detached role is never the intent, so it is always NOT MET. A launch that
declares no role reports the check as NOT CHECKED, never met, so a production
launch refuses it. On a production chain the expected role travels in the
Timelock proposal with the other declared values, and the proposal printout
names it for the Governance Safe to review.

The rule for which chain is Base now lives in one place, used by both the
reward configure step and the launch, so the two cannot disagree.

Nothing moves funds. The launch gate's input gains one field, so a launch gate
deployed from this build has a new address; every chain reaches this build by
fresh deploy.

Closes #2920.

_Committed 2026-10-27 04:08 UTC (c5f62885c)._
<!-- assembled-fragment: 2920-launch-readiness-reward-role.md sha256=642708d2d2da3a2cc3729d8040b77cb365805a58d612e9b63cdf329f438a2a15 -->

## Thread — Every filtered list view is bounded by the rows it reads (PR #2972)

The platform's filtered list views now all follow one paging rule, the one the
match-eligible loan view already used: a call reads at most the number of rows
the caller asks for, starting from a cursor, and returns the matching rows
among them together with the cursor to resume from. A page can come back empty
while the walk is unfinished; the end is the cursor reaching the end of the
list, never an empty page.

Before, these views took an offset counted in matching rows and walked their
list until a page filled. When few rows matched, one call read the whole list,
and a deep page re-read every row before it. That covered the active offers
by lending asset, the offers compatible with a user's country, a user's loans
by status and offers by state, the four dashboard lists (loans per side, loans
on both sides, offers, claimables), and the whole-history lists of loans and
offers, overall and by status. The per-status and per-user views also reported
a count of all matches, which needed the whole list read on every call; they
no longer report it. The whole-history lists of loans and offers still report
their totals, which cost nothing to read.

The dashboard lists keep their cap of 100 rows per call, now on rows read. The
chain-reading test stub pages with the new cursor. The custody census no longer
reads a list view at all: it walks the loan id range itself, so it reads a
retired Diamond, which keeps the old view shape, the same way as a new one. No
app, indexer, keeper or agent code read any of these views.

This is an interface change, deployed fresh. Closes #2930. Part of #1832 (the
whole-history lists); the lifetime totals that walk every loan remain open
there.

_Committed 2026-10-27 18:50 UTC (d3245040f)._
<!-- assembled-fragment: 2930-bounded-filtered-views.md sha256=1615c08f6021ee61e225a8488d3ec97a9aa3b671b56f19e023de40ecc8de2d7d -->

## Thread — the accept-time token screen is now proven on Anvil (PR #2955)

The signed-fill card's token screen, added in #2726, was covered only by unit tests of its rules. A new end-to-end scenario now drives the card itself against one signed order on the local Anvil chain, with the token-security service mocked to answer each case. It shows that a blocking verdict holds the Fill button even with consent ticked; that a check which cannot run holds the button, offers "Check again", and voids any consent given while it was held; and that a warning which changes after the user consented is refused before the wallet is asked to sign anything, after which the card shows the new warning and the order fills once the user consents to what is now shown.

The GoPlus-screened test server and its mock now live in one shared helper, used by both this scenario and the existing token-badge scenario, so the two cannot drift apart. No app behaviour changed. Closes #2934.

_Committed 2026-10-27 11:40 UTC (f103f1a5e)._
<!-- assembled-fragment: 2934-accept-token-screen-spec.md sha256=0dc762144a5bdf9079bd40e17088477af6dd0b9a9b719079c50402821267d658 -->

## Recycling analytics — Drop the retired recycle-day backfill table (PR #2948)

The second and last step of retiring the pre-cutover recycling day backfill. A new shared-database migration drops the `recycle_day_backfill` table, and the schema gate now requires it. The first step had already removed every reader of the table: the indexer's recycling series, the nightly off-chain backup and the restore import. Nothing has ever written it. The column the same earlier migration added to the per-chain reported-recycling record is still in use and is not touched.

Ordering matters for this one. Apply it only after the first step's off-chain backup Worker is deployed. The backup Worker from before the first step treats the table as required once its creating migration has applied, so it would read the drop as a lost table and abort the nightly. The indexer from before the first step already tolerates the table's absence. A fresh environment creates the table in the earlier migration and drops it in this one. Restore archives written before the first step still carry the table, empty, and the converter keeps skipping it. Closes #2937.

_Committed 2026-10-27 09:47 UTC (e13676ba0)._
<!-- assembled-fragment: 2937-drop-recycle-day-backfill-table.md sha256=1723ddadedc80a3739e1ba7e41be5a5dc3d5f9c2be5c2e037f931cc845dadfb8 -->

## Recycling analytics — Recycling day series reads the announced days only; the recomputed backfill is retired (PR #2947)

The recycling transparency series no longer has a second source of days. It used to be able to merge in "pre-cutover" days: days closed before the day-close announcement was widened, whose figures would have been recomputed later from the contracts by an operator pass and stored in a table of their own. That pass never shipped, nothing ever wrote the table, and every chain reaches the current build by a fresh deploy, so there is no such day to recover. The indexer now serves the day series, its lifetime totals and the runway figure from the announced days alone. The runway can no longer be withheld for the reason that cross-chain absorption on a recomputed day cannot be attributed per chain. That reason only ever applied to recomputed days, and every announced day's cross-chain absorption is attributed to the chain it came from. The connected app drops the "recomputed" day badge, its footnote and that runway reason's sentence, in every language. A reason code the app does not recognise is still shown with its code, as before.

The nightly off-chain backup stops archiving the table, and a restore stops importing it. Archives written before this change still carry it, always empty. The restore converter recognises it in those archives and skips it with a printed note, emitting nothing for it. It does not refuse the archive: refusing would make every archive of that era unrestorable, including the older known-good copy an incident restore may need. An archive that carries rows for the table is refused, because no writer ever produced one. The restore runbook, the table-classification guard and the backup Worker's list are updated together.

This is the first of two steps. The table itself stays in the database for now, because the backup Worker still serving while this change rolls out exports it, and treats the table's absence as data loss that aborts the nightly. A follow-up migration drops it once this change, the backup Worker included, is live everywhere. (The indexer that serves during the rollout already tolerates the table being absent.) Refs #2937.

_Committed 2026-10-27 08:49 UTC (1e455038a)._
<!-- assembled-fragment: 2937-retire-recycle-day-backfill.md sha256=01b17170a1fef0f0cf1eca2fc9d020de6bbaaf7121d0b36f8671b0a58f74d642 -->

## Thread — The rental review refuses a listing that names collateral, and says why (PR #2950)

A rental takes no collateral. Accepting one pulls only the renter's
prepayment, and a rental default pays the prepayment out and returns the NFT
without ever reading the listing's collateral fields. Nothing stops a listing
from being created with those fields set, though, and the contract then asks
the renter to acknowledge the named asset if it is unpriced. Since #2936 the
app acknowledges only what its review showed. Such a listing was therefore
refused before signing, with the generic "terms changed" message, and a fresh
review showed the same thing again with no reason given.

The rental review now recognises a listing that names a collateral asset,
amount, token id or quantity, whether the indexer row or the offer read live
from the chain names it. It says plainly that a rental takes no collateral
and that the app does not accept a listing in this shape. The accept button
stays disabled, and the same refusal applies at submit. The app's own rental
create never sets these fields. The contract-side rule that refuses such a
listing at creation is tracked separately (#2949), so after the all-waves
deploy no such listing can exist. Until then the app refuses it openly, where
before #2936 it would have acknowledged the unused asset silently.

Closes #2938.

> Caveat: there is no end-to-end test of the refusal, because no such listing exists on any testnet and the app cannot create one; the rule is unit-tested.

_Committed 2026-10-27 10:08 UTC (7311be5b5)._
<!-- assembled-fragment: 2938-rental-names-collateral.md sha256=f558d33a07f7754cfa86d2c3fae29947d9a57408c8139e20458f8268cceb4f97 -->

## Thread — Docs and user guide state the live fee and the current sale and refinance outcomes (PR #2967)

The functional spec still described the loan initiation fee as 0.1%, with a worked example of 1000 USDC becoming 999 USDC. The fee has been 0.2% since the rev-8 fee freeze, which is the rate the tokenomics spec and the admin knobs page already state. Every statement of the live rate and both worked examples now say 0.2% (1000 USDC becomes 998 USDC when the borrower has no fee discount).

The advanced user guide, in all ten languages, said a refinance burns the old loan's position NFTs. It does not: the old loan is marked repaid and both of its position NFTs stay with their holders, marked Loan Repaid. The old lender claims the repayment with theirs, and the old borrower NFT stays as a receipt. The guide now says so.

The same guide still described the collateral sale as it worked before the neutral-sale change (#2916): the lender paid inside the sale and the borrower's remainder deposited into their vault with no claim. A sale now closes the loan as a repayment. The lender's due waits in the lender's vault for the ordinary lender claim, the treasury takes its share net of any lender discount, and the rest goes to the borrower-position holder's wallet, or is held for the borrower claim if it cannot be paid to that wallet. The sale section, the borrower actions list and the note on a repay that loses the race to a sale now say this; the translated editions carry the sale section and the atomic-match outcome, which are the parts they already had.

Closes #2943.

_Committed 2026-10-27 21:07 UTC (f1f6446ee)._
<!-- assembled-fragment: 2943-stale-fee-and-sale-copy.md sha256=5b78f3b2a9be291a7a303e31c84262c781cf5e01bc90661f8f468e5fe11002cd -->

## Thread — A rental carries no collateral (PR #2964)

An NFT-rental offer can no longer name a collateral. The platform refuses one
whose collateral asset, amount, upper amount, token id or quantity is set, and
it refuses an edit that would give an existing rental offer one. A rental is
secured by its prepayment in the rental's payment token and by the rented NFT
staying in the lender's vault, so a collateral on a rental moved nothing.
Before this change it still had effects: the renter could be asked to
acknowledge it as an illiquid collateral, the risk-access check classified it,
and interfaces showed a "collateral" that was not one.

With no collateral there is nothing to price on that side, and every path that
can reach a rental now treats it that way. Creating or accepting a rental no
longer reads a collateral price; the rental records its collateral side as
illiquid, the class a rental is already in. The renter is never asked to
acknowledge a collateral asset. The risk-access check judges a rental on its
prepayment token alone. A transaction value used for a KYC comparison counts
an empty side as worth nothing, without a price read. Handing a rental over
to a replacement renter returns and checks no collateral. Range matching runs
no loan-to-value check on a rental, as a direct acceptance never did. Adding
collateral to a rental is refused, by name.

This is a fresh-deploy-only shape change. Closes #2949. Two older display and
preview gaps found during the audit are tracked separately: #2956 (range
matching refuses a consented illiquid token pair when depth-tiered limits are
on) and #2957 (position NFT metadata misstates a rental's kind and claim
scale).

_Committed 2026-10-27 17:36 UTC (ff11594cd)._
<!-- assembled-fragment: 2949-rental-carries-no-collateral.md sha256=e781192adf9cd0d70e89d7cf366b5d6e0daecac658fd76802725d77f5d1f8016 -->

## Thread — One rule for the initiation risk gate (PR #2976)

The range-match preview now decides whether a matched pair carries the
initiation risk gate (the loan-to-value cap and the health-factor floor) by
the same rule the binding accept uses: only a loan whose two legs are both
liquid carries it. Before, the preview ran its loan-to-value check on every
ERC-20 pair, so with depth-tiered loan-to-value switched on it refused a
consented pair with an illiquid leg (its collateral measures at tier 0) that
the accept would have admitted. A matching bot filtering on the preview would
never submit such a pair, so it could not be matched at all.

The rule now lives in one place and every path reads it: the binding accept,
the refinance re-check, the create-time offer bounds, the range-match preview
and the lender-intent slice check. Both parties' consent to illiquid terms is
mandatory on every loan, so it is not part of the rule. A rental never
carries the gate. A both-liquid pair is gated exactly as before.

Closes #2956.

_Committed 2026-10-27 19:56 UTC (e4ee41195)._
<!-- assembled-fragment: 2956-one-init-risk-gate-rule.md sha256=a5e1ef2af8f484f8a5f8f888d247b360ebc7e2482a410374a5b3387d868322a7 -->

## Thread — Position NFT metadata states each figure in its own asset (PR #2977)

A position NFT's metadata now states every figure in the asset it is
actually in. The claimable amount used to be scaled by a guess from the
holder's role (the lent asset's decimals for a lender, the collateral's for a
borrower). That was wrong for every rental, whose claims are in the prepay
token, and for a lender whose claim is the collateral after an in-kind
default; a 6-decimal stablecoin refund displayed a million million times too
small. The claim is now read from the position's own claim row: an ERC-20
amount at that token's decimals with its symbol, or an NFT named by its
collection and token.

The "Asset Kind" trait showed the collateral's type, which reads "ERC20" on
every rental because a rental has no collateral. It is replaced by two
traits, "Lent Asset Kind" and "Collateral Kind" (None for a rental). A
rental's metadata now shows the rented NFT by its token, the daily rental fee
and the prepaid rent and buffer in the prepay token, and no collateral
fields.

The position summary view behind the metadata carries the new facts (the
lent asset's kind and token, the rental's prepay asset and amounts, and the
claim's kind, symbol, decimals, token and quantity), so the app and other
readers can render the same thing.

The metadata rendering moved to its own facet, VaipakamNFTMetadataFacet,
because the position NFT facet had reached 24 bytes under the contract size
limit. The NFT's token URI, its collection metadata and the admin settings
for its images and external link now live there; the token itself (minting,
transfers, approvals, locks, royalties, name and symbol) stays where it was.
The Diamond's address and every function's signature are unchanged, so a
reader calling through the Diamond sees no difference. The two facets are
refreshed together: the curated redeploy script refuses a Diamond that still
serves the token URI from the old facet, so the split arrives by the
all-facets refresh or a fresh deploy.

Closes #2957.

_Committed 2026-10-27 20:44 UTC (5a449268a)._
<!-- assembled-fragment: 2957-position-nft-metadata-units.md sha256=09ffe309cd5d5d60cfbe1c16b78ed17b5731de56519854ea0e32641cdc1f5b49 -->

## Thread — The launch gate fits the contract size limit again (PR #2978)

The launch gate, the contract a production Diamond's first unpause runs
through to re-check every launch requirement, had grown past the 24,576-byte
contract size limit when the reward-role check was added, so it could not be
deployed. Its two cross-chain checks (the VPFI pool and that pool's CCIP
lanes) now live in a companion contract, LaunchCrossChainChecks, which the
gate creates in its own constructor. The gate is now about 14.8 KB and the
companion about 12.4 KB.

Nothing about what the gate checks has changed: the same ten requirements,
in the same order, put together by the same shared list the launch script
prints. The gate is still deployed at one deterministic address from its
code alone, and because the companion's code is part of the gate's creation
code, that address commits to both. A reviewer finds the companion's address
from the gate's `crossChainChecks()`.

The deploy-sanity suite now size-checks the gate and its companion, so a
future check that grows them past the limit fails a normal test run instead
of a deploy.

Closes #2975.

_Committed 2026-10-27 21:41 UTC (98dacb258)._
<!-- assembled-fragment: 2975-launch-gate-size.md sha256=496b9561b51a4a1e93a2668e4cf45c32997f16f15f49f51f5a44f4c261434a6c -->

## Thread — a retired mirror sends its leftover reward VPFI back to Base (PR #2969)

A mirror that stops being part of the reward mesh used to keep whatever reward VPFI its closed custody eras released after it detached. That value sat in the chain's pending-surplus row, owed to nobody, with no way out unless the chain re-attached. An operator can now **retire** such a chain, and the value goes home to the base chain the mirror detached from.

Retiring is a one-way admin step, and it works only on a mirror that has already detached. When a mirror detaches, it records the base chain and the Base Diamond it left, so the destination is never an admin argument. The message names that Diamond, and a Base Diamond that replaced it refuses the return instead of crediting it. Plain detaching never opens an exit, because every move to a new base passes through the detached state. After retirement, both role setters refuse every write, so the destination cannot change. The chain otherwise stays detached: nothing new is claimable on it.

After retirement, anyone can send the pending surplus to Base over the existing VPFI return channel, using a new message kind. The caller pays only the CCIP fee. They cannot choose the destination or send more than the row holds. Sends can be split into parts to fit the lane's rate limit. Outbound lane capacity is checked before anything moves, and a failed send changes nothing. Base credits exactly what arrives to the recycle bucket as relocated custody, attributed to the source chain. It is not counted as new absorption: it feeds neither the day series behind the trailing average nor the first-time absorption figure, and it never reopens fresh headroom. Both sides keep public totals (the mirror's sent cumulative and Base's per-chain received figure), and every send and arrival emits an event.

The return channel's receiver now forwards all three value-carrying kinds through one shared, measured rule. The sender moves to wire generation 3 and the receiver to generation 4. Closes #917.

> Caveat: fresh deploy only, like the rest of this wave. No live testnet chain is retired.
> Caveat: retiring does not remove the chain from Base's expected-source list. That is a separate admin write, described in the Deployment Runbook.
> Caveat: no keeper pass sends the surplus on its own yet. The send is a manual, permissionless call.
> Caveat: nothing closes out a detached chain's custody eras on its own, so the value reaches the pending-surplus row only after the permissionless frontier, day-closure and finalize calls the Deployment Runbook lists.
> Caveat: each chunk is bounded by the mirror's own outbound lane capacity, because the mirror cannot read Base's inbound one. That is safe while a mirror's outbound toward Base never exceeds Base's inbound from it, the pairing rule the CCIP Cutover Runbook now states for every lane-limit change. If governance breaks that rule, an oversized chunk waits in the lane until Base's inbound is raised back.

_Committed 2026-10-27 22:25 UTC (2f3b54a3a)._
<!-- assembled-fragment: 917-retired-mirror-surplus-return.md sha256=d23039198c01585bb5d7e208069e2efc221f2a87581743b30d56445adcd36cbf -->

## Thread — Reward remittance destination gas raised to 1,100,000 (PR #2974)

A reward remittance now asks the mirror to run its receiver with 1,100,000 gas, up from 1,050,000. The figure is derived from the mirror's rooted ingress, the call every remittance makes on arrival, with the receiver's own reserve and a quarter's margin added. After #918 that call measures 750,163 gas, so under the margin rule the old limit was 12,704 gas short. The call itself still fitted under the old limit; what it lacked was the margin, which absorbs the transport's own receive overhead and the gas lost at each forwarding hop.

#918 had recorded 735,327 gas and kept the old limit. That figure came from an older forge (1.5.1). On the same bytecode it reads 24,708 gas lower than the version CI pins (1.8.3), and it is not established which of the two matches a chain. The derivation therefore takes the higher figure. It also came from a window that counted the test helper's own work along with the Diamond call. The check now measures the Diamond call alone, and the figure is recorded with the forge version CI pins. That check runs only in the pre-deploy full regression, which is why the shortfall did not show on #918's own CI.

The only cost of the higher limit is the destination-execution part of each remittance's CCIP fee, which the sender quotes on-chain from the same constant. Fresh deploy only, like the rest of #918.

_Committed 2026-10-27 18:50 UTC (6d2f2efa8)._
<!-- assembled-fragment: 918-dest-gas-limit.md sha256=98a120088275f4c681410ddd23c752aa214eeb5280a71971c0b15940a433ba21 -->

## Rewards — A day's reward budget may be sent to a mirror in parts (PR #2959)

Until now a day's reward budget left Base for a mirror in one transfer, so a
day whose slice was larger than the cross-chain lane could carry could never be
sent: the keeper skipped it with a warning, and the only remedy was to raise the
lane. Following the owner's "send in parts" decision, Base now sends such a day
in several parts. It fixes the day's whole slice, fresh and recycled, when the
first part goes, records every later part against that same whole, and marks the
day remitted only once the parts add up to it. Each part reserves and records
exactly its own value; the amount a day's commitments clamp away is retired
once, with the first part. Every part is checked against what the day still
owes, not against the part alone, so a part goes only when the rest of the day
sent at once would, and no day is started on room it does not fit. Once a
day's first part has gone, the rest of its fresh is held for it in the 69M
pool, so another mirror's send or a claim on Base cannot use up the room its
later parts need; the pool counts the day as used exactly as a single send
would, and the held figure is published. This applies to committed days too:
their fresh commitment becomes the hold when the first part goes, since a claim
on Base respects the hold but not a commitment. Releasing
an undeliverable part restores exactly that part and leaves the day owing it
again. The quotes and planning views now take the same
part size the send uses, so the quote always matches the send, and a new status
reports a day whose part leaves it still owing. The manual-budget path refuses a
day that has already been partly sent.

On the mirror, a day now opens for claims only when every part has landed: each
delivery states the day's whole, and the mirror adds up the parts it receives,
fresh and recycled separately, opening the day only when both reach the whole.
Parts may land in any order and a part delivered twice counts once. The rooted
remittance wire moves to a new generation that carries these figures; the old
shape is refused, and the ingress entry point was renamed accordingly. This is
fresh-deploy only (owner decision O1 = A): no migration, and the retired
one-packet proof record keeps its storage place unused.

The keeper sizes each part to the smaller of its configured ceiling and the
lane's live capacity, sends one part per tick, and keeps reporting the mirror as
not yet covered until the day is whole. `ConfigureCcip` refuses a lane smaller
than the largest fresh day slice the schedule can owe, and the launch-readiness
lane check now says when a lane is below it. A day with only a recycled portion
is still not held on the mirror. Closes #918.

_Committed 2026-10-27 16:17 UTC (caf354de4)._
<!-- assembled-fragment: 918-remit-day-in-parts.md sha256=1c4818e3cae8f392e36ea4cef45d9e09ed784d25c95365143a147186248f55d8 -->
