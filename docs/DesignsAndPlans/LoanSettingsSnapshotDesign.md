# Loan settings snapshot (#3437)

Each loan keeps the price sources, swap routes and marketplace it opened
with. A later change by governance reaches new loans only.

Status: design. The platform is prelive and every chain gets a fresh deploy,
so this design carries no migration and no storage-compatibility work.

## 1. Why

Owner decision of 2026-11-09: a lender and a borrower agree to a loan under
the price sources, the quorum rule, the swap routes and the marketplace that
exist at that moment. Those settings decide when the loan can be liquidated,
at what price, and through which venue the collateral is sold. Changing them
under an open loan changes the deal after it was struck.

What the code does today (scouted 2026-11-15):

- **Prices.** `PriceGuard` holds one chain-wide config: the feed registry,
  the ETH anchor feeds, the Pyth cross-check, the three secondary sources and
  their tolerances, per-feed overrides, stable references and per-asset direct
  feeds. One quorum rule serves every asset. Every change waits the guard's
  delay (7 to 14 days on a production chain) and then applies to every loan,
  open or new. The feed registry's bindings behave the same way.
- **Swap routes.** The Diamond keeps one adapter list (`swapAdapters`).
  Callers name adapters by index, and a removal or reorder shifts every
  index. A per-address disable flag stops an adapter at once.
- **Marketplace.** The vault code names one Seaport, one conduit and one
  conduit key as constants of the vault version. The Diamond keeps the
  auto-list conduit key as a setting, and each loan already records its
  listing executor.

Nothing is versioned, so nothing can be read "as it was when this loan
opened".

## 2. The rule

1. A loan records one **settings set** when it opens. The set is immutable.
2. Every read made on behalf of a loan uses that loan's set: health factor,
   loan-to-value, liquidation sizing, the default route, the fallback split,
   the forced-sale plan, swap-to-repay, every collateral sale route and every
   collateral listing.
3. A governance change makes a new set. New loans take it. Open loans do not.
4. Three things can still reach an open loan, and nothing else:
   - **Stop.** A source, an adapter or a marketplace can be stopped at once.
     A stop removes; it never adds. This exists today (muting or removing a
     secondary source, disabling an adapter) and stays as it is.
   - **Announced replacement.** When a stop leaves a set unable to work, or a
     security fault needs a source replaced, governance may name a successor
     for a set. It waits at least 7 days, the guardian can cancel it, and both
     parties of every loan on the set are told when it is proposed.
   - **Consent.** Both parties of a loan may move it to the current set.

A read that has no loan (an offer preview, the offer book's value floor, a
compliance value, a treasury conversion, a buyback) uses the current set.

## 3. What a settings set holds

A set is a small record in Diamond storage, numbered from 1:

| Part | What it names |
| --- | --- |
| Price guard | The guard contract's address |
| Price epoch | The guard's config version (section 4) |
| Route set | An immutable ordered adapter list (section 5) |
| Marketplace | Seaport, conduit key and the listing executor (section 6) |

A loan stores only the set's number. The set is minted lazily: at loan
creation the Diamond compares the live values with the newest set and mints a
new one only when they differ. Most loans therefore cost one comparison and
one small write.

The set number is assigned in `LoanFacet` at origination, the one place a
loan record is created. A refinance creates a new loan and so takes the
current set. A sale of the lender position, a part sale and an obligation
handover keep the loan and so keep its set; the buyer's preview states the
set. An in-place extension or renewal is a fresh agreement by both parties,
so it moves the loan to the current set, and a pre-authorised rollover says
so when it is authorised.

## 4. Prices

The guard gains a **config epoch**: a counter that goes up by one each time
a delayed change is executed. Every setting that affects a price is readable
as of an epoch:

- the guard's own entries (feed registry pointer, WETH, the ETH anchor feeds,
  the sequencer feed, the Pyth entries, the secondary source addresses and
  tolerances, per-feed staleness and minimum answer, stable references,
  per-asset direct feeds);
- the feed registry's bindings, which get the same epoch treatment in the
  registry. The guard reports both counters in one view.

The guard keeps every price entry point it has today and adds an "as of
epoch" form of each. The current form is the "as of the newest epoch" form,
so there is one pricing path, not two.

The guard has limited room under the contract size limit. If the epoch
forms and the history do not fit, the history reads move to a separate
reader contract the guard calls, split along the read and write seam, not
trimmed to fit.

How history is stored is the builder's choice within one requirement: a read
at the newest epoch must cost about what it costs today. Changes are rare, so
a short per-entry history (epoch, value) with a fast path for "one entry" is
enough. Whole-config copies per epoch are fine for the unkeyed numbers.

What is not versioned, on purpose:

- **The stop state of a secondary source** (counted, muted, removed). A stop
  applies to every epoch at once. Re-enabling a source waits the delay, as
  today, and only restores a source the epoch already named.
  The two stops differ, and the difference is stated here on purpose. A mute
  only refuses more: the source's agreement stops counting and its
  disagreement still refuses. A removal also drops the source's refusals, so
  it loosens the quorum, and it waits 48 hours (#3537), not the guard's full
  delay. A removal still reaches every open loan: it is the cure for a dead
  source, and a dead source that keeps refusing would block every close-out
  that needs a price. The removal proposal is announced to both parties of
  every open loan the same way a succession is (section 7).
- **The sequencer check and the peg constants.** They are code, not config.

A source that an epoch did not name is never consulted for a loan on that
epoch, whatever happens later. That is the "never add" half of the rule.

**A new guard contract.** The guard is not upgradeable; a new version is a
new deploy behind the registry pointer. The pointer swap reaches new loans
only, because open loans carry the old guard's address in their set. The old
guard stays on chain and keeps answering.

**When a loan's price cannot be read.** The existing rule stands: a missing
price takes the lender-first in-kind path, and a distrusted price refuses.
The cure for a set whose source has died is an announced replacement
(section 7).

### The vault's own check

A vault names the price guard as a constant of its code and checks outcomes
itself (#3431, #3268). To keep that check on the same footing as the loan,
the vault stamps the guard address and the guard's current epoch into the
lien row when the lien is created, reading both itself. A later check for
that lien accepts a price read either at the stamp or at the vault's current
constant and newest epoch. Both were announced under a 7-day delay, so a
faulty Diamond can choose only between two legitimate readings. The vault
does not check prices yet, so this lands on top of the vault's price checks
(#3268) and the lien checks (#3379), in the same lien-creation path those
checks read, and shares one lien row shape with the payee lien of #3669.

## 5. Swap routes

A **route set** is an immutable ordered list of adapter addresses with a
number. Adding, removing or reordering adapters creates a new route set and
makes it current. The old list is never edited.

- A caller's try-list indexes refer to the loan's route set, so an index
  means the same adapter for the whole life of the loan. This removes the
  index shift that exists today.
- The disable flag stays keyed by adapter address and applies to every route
  set. Disabling is instant. Re-enabling waits the same delay as a route
  change, so an approval given before a stop cannot undo it.
- The vault outflow check for "is this a swap adapter" asks the loan's route
  set when the outflow belongs to a loan, and the current route set
  otherwise.
- A loan whose route set has no enabled adapter keeps today's behaviour
  (`NoEnabledSwapRoute`). The cure is an announced replacement.

## 6. Marketplace

The set records Seaport, the conduit key and the listing executor. Every
listing made for a loan (the borrower's own listing, the auto-list at the
floor, the Dutch listing, the atomic sale) resolves the conduit from the
loan's set, not from the live setting. The per-loan executor record that
exists today folds into the set.

The vault refuses a conduit other than its constant. As with prices, the
vault stamps its marketplace constants into the lien row at lien creation
and accepts the stamp or its current constants. A vault version that names a
new conduit therefore does not strand a listing on an open loan, and does
not move an open loan either.

## 7. Announced replacement and consent

**Succession.** Governance (the Timelock) may propose that set A is
succeeded by set B.

- It waits at least 7 days. The guardian or the owner can cancel it. Anyone
  can execute it once due, and a keeper pass backs that step (shipped
  disarmed, with its row in the permissionless-steps ledger).
- B must be a set that already exists or is minted by the proposal. For the
  route set and the marketplace, B may differ from A in that one part only.
  For prices, B's price part is always the guard's newest epoch (or a new
  guard's first epoch): epochs are a single line of history, so a price
  replacement brings the loan to the current price settings in full. The
  proposal event lists every difference between A's price settings and B's,
  and the app shows that list.
- When it executes, every loan on A reads B. A loan follows at most a short
  chain of successions; anyone can repoint a loan to the end of its chain.
- The proposal event is the announcement. The indexer knows which loans sit
  on A and notifies both parties of each, and the app shows the pending
  change on the loan page with its date. A party who does not accept it has
  the 7 days to repay, sell or close.

Succession is the only way an addition can reach an open loan, and it is
never silent.

**Consent.** `moveLoanToCurrentSettings` moves one loan to the current set
when the borrower-position holder and every lender-position holder have each
approved that exact set number. An approval names the set, so it cannot be
replayed for a later one. A loan in fallback custody or past default cannot
be moved.

## 8. One rule, enforced

- `LibLoanSettings` is the one reader: given a loan it returns the guard,
  the price epoch, the route set and the marketplace, after following any
  succession. A new `LoanSettingsFacet` hosts the mint, the views, succession
  and consent, so no facet near the size limit grows.
- `LibNumeraireValue` gains loan forms of its entries. The no-loan entries
  are renamed so their name says "current".
- A pre-deploy check lists every caller of a "current" price or route entry
  with the reason it has no loan, in the style of the permissionless-steps
  ledger. A new caller without a row fails the gate. This is what stops a
  loan path from quietly reading live settings.
- Refresh family: every facet that prices or sells on behalf of a loan,
  `OracleFacet`, `NumeraireValueFacet`, `LoanFacet` and `LoanSettingsFacet`
  move together. It reaches a chain by fresh deploy.

## 9. What stays live, and why

- **Liquidity tier and pool depth.** They describe today's market, not a
  governance choice. A loan's sale must respect the depth that exists now.
- **Hourly and daily price checkpoints.** One series per asset, written at
  the newest epoch. The calm test compares market movement, which does not
  depend on the loan.
- **Numeric risk thresholds already stamped per loan** (the treasury fee at
  origination, for example) are unchanged by this design.

## 10. App, indexer and keeper

- **App.** The loan page shows the set in plain words: which price sources
  and how many must agree, which sale routes, which marketplace, and the date
  they were fixed. A pending replacement shows with its date and the list of
  differences. The consent move is a two-party action on the loan page.
- **Indexer.** New events: set minted, set assigned to a loan, succession
  proposed, cancelled and executed, consent given, loan moved. Loans are
  indexed by set so a proposal can be fanned out to both parties.
- **Keeper.** Try-lists are built against the loan's route set, read from
  `getLoanSettings`. One new pass executes due successions.

## 11. Tests

- A price config change, a feed rebinding, an adapter add, remove and
  reorder, a conduit change and a guard swap each leave an open loan's
  health factor, liquidation, default route, forced sale and listing reading
  the old settings, while a loan opened afterwards reads the new ones.
- A stop reaches every set at once; a re-enable waits the delay.
- A source added after a loan opened is never consulted for it.
- Succession: not before 7 days, cancellable, lists differences, moves every
  loan on the set, chain following is bounded.
- Consent: both sides, exact set number, refused in fallback custody and
  after default; every holder on a divided loan.
- Try-list indexes stay stable for a loan across a reorder.
- The vault accepts the stamp or its current constants and nothing else.
- The pre-deploy check fails on an unlisted "current" caller.

## 12. Alternatives considered

1. **Copy every setting into the loan.** Simple to read, but a dozen or more
   storage slots per loan and a second copy of the quorum rule's inputs.
   Rejected for cost.
2. **An immutable guard per config, loans keep the guard address only.**
   Every tolerance change becomes a redeploy, live guards multiply, and a
   vault's single guard constant stops matching older loans. Rejected.
3. **Keep settings live and rely on the 7-day delay.** This is today's
   behaviour and the one the owner decided against: a delay warns the
   parties, it does not keep their deal.
4. **Let a replacement patch one price entry on an old epoch.** It would
   need branching history in the guard. Rejected for complexity; a price
   replacement moves the loan to the current price settings and says so.

## 13. Recommendation

Build the settings set as described: epochs in the guard and the feed
registry, immutable route sets, the marketplace in the set, one reader
library, succession and consent as the only ways a change reaches an open
loan.

Build order:

1. Guard and feed registry epochs with "as of epoch" reads (security thread,
   with #3272 and #3268).
2. Route sets and the marketplace part; `LibLoanSettings`,
   `LoanSettingsFacet`, the set number on the loan.
3. Loan forms of the numeraire value entries and the switch of every loan
   path; the pre-deploy check.
4. Succession, consent, the keeper pass.
5. Vault lien stamps.
6. Indexer and app.

## 14. Open items

- Whether the registry pointer delay for the price guard should rise from 3
  days to 7 now that a swap reaches new loans only. Recommendation: leave it.
- Whether tightening a tolerance should be allowed to reach open loans
  without succession. Recommendation: no; one rule is easier to trust.
