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
4. Four things can still reach an open loan, and nothing else:
   - **Stop.** A secondary source can be muted, an adapter disabled and a
     conduit's approval on a listing executor revoked at once. A stop only refuses more; it never adds and never accepts a price
     that was refused. This exists today and stays as it is.
   - **Dead-source removal.** Removing a secondary source also drops its
     refusals, so it is not a stop. It keeps its own cancellable 48-hour
     wait (#3537) and is announced to both parties of open loans.
   - **Announced retirement.** When a part of a set can no longer work, or a
     security fault needs a source replaced, governance may retire that part.
     It waits at least 7 days, the guardian can cancel it, and both parties
     of every loan holding the part are told when it is proposed. A loan
     holding a retired part moves to the current value of that part.
   - **Consent.** Both parties of a loan may move it to the current set.

5. **What sits behind an address in a set follows the same rule.** A set
   names contracts (a guard, adapters, an executor). Any setting inside such
   a contract that governance can change and that a loan's price or sale
   depends on is either versioned like the guard's config, or changeable
   only as a stop. Anything else is a new contract and so a new set. The
   build checks each named contract for owner-settable state against this
   rule.

A read that has no loan (an offer preview, the offer book's value floor, a
compliance value, a treasury conversion, a buyback) uses the current set.

## 3. What a settings set holds

A set is a small record in Diamond storage, numbered from 1:

| Part | What it names |
| --- | --- |
| Price | The guard contract's address together with a price version on that guard: its config epoch and the feed registry's epoch (section 4). One part, never split |
| Route set | An immutable ordered adapter list (section 5) |
| Marketplace | A numbered, immutable binding of Seaport, the conduit key and the listing executor built for them (section 6) |

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
  registry. The two counters move independently, so a price version is the
  pair (guard epoch, registry epoch). The guard reports the pair in one
  view, every "as of" read takes the pair, and the settings set carries the pair. A feed rebinding alone therefore
  makes a new set.

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
  every open loan the same way a retirement is (section 7).
- **The sequencer check and the peg constants.** They are code, not config.

A source that an epoch did not name is never consulted for a loan on that
epoch, whatever happens later. That is the "never add" half of the rule.

**A new guard contract.** The guard is not upgradeable; a new version is a
new deploy behind the registry pointer. The pointer swap reaches new loans
only, because open loans carry the old guard's address in their set. The old
guard stays on chain and keeps answering.

**When a loan's price cannot be read.** The existing rule stands: a missing
price takes the lender-first in-kind path, and a distrusted price refuses.
The cure for a price version whose source has died is an announced
retirement (section 7).

### Retired price versions are refused by the guard itself

Retiring a price version (section 7) is an act on the guard: the guard keeps
a floor, raised only through its delayed change path, and refuses every "as
of" read below it. The Diamond reads that floor; it keeps no second record
of which versions are retired. A new guard has its own versions and its own
floor, so versions are never compared across guards.

### The vault's own check

A vault names the price guard in its code and checks outcomes itself (#3431,
#3268). The vault keeps no copy of a loan's settings. For each check the
Diamond names the guard and the price version the loan is on, and the vault
accepts them only when:

- the guard is one its own code lists as accepted. The vault code carries
  the guard new loans use and, beside it, any earlier guard still in use by
  open loans; every vault version is announced under the code delay;
- the guard answers the read, which it does only for a version that exists
  and is not below its floor.

The vault does not order versions and holds no per-lien stamp. An earlier
draft had the vault stamp settings into the lien row and restamp on a move;
that needed a rule for every way a lien is created or a loan moves (a
handover recreates a lien, a new guard starts its versions again), and a
stamp the Diamond may move is no stronger than a named value the vault
validates. With this rule a faulty Diamond can choose only among settings
that are still live on a guard the vault's own code accepts, each announced
under a 7-day delay, and a retired version is refused by the guard whoever
asks.

A vault whose owner has pinned older code keeps that code's accepted list.
If the loan's guard is not on it, the vault's check refuses, as a pinned
vault does today (#3431).

The vault does not check prices yet, so this lands with the vault's price
checks (#3268) and the lien checks (#3379).

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
- **Targets inside an adapter.** An aggregator adapter keeps a list of the
  swap targets it may call. Removing a target is a stop: instant, and it
  only refuses. Adding a target is not allowed on a deployed adapter; a new
  target is a new adapter and therefore a new route set, which reaches new
  loans only.
- A loan whose route set has no enabled adapter keeps today's behaviour
  (`NoEnabledSwapRoute`). The cure is an announced retirement of that route
  set.

## 6. Marketplace

The set records a marketplace: a numbered, immutable binding of Seaport,
the conduit key and the listing executor built for that Seaport. A new
executor or conduit is a new marketplace with a new number; an existing
binding is never edited. Every listing made for a loan (the borrower's own
listing, the auto-list at the floor, the Dutch listing, the atomic sale)
takes the executor and the conduit from the loan's marketplace, not from the
live setting, so a new listing on an older loan still goes through the
executor that matches its Seaport.

**A live listing keeps the settings it was made with.** Each listing already
records its executor and its order context (Seaport, conduit, zone). That
per-listing record stays as it is, separate from the loan's set: a listing
is cancelled, filled and cleaned up through the executor and the conduit it
was created on, whatever the loan's set says by then. A marketplace move
therefore changes only listings created afterwards. The retirement of a
marketplace takes effect for a loan with a live listing once that listing
has ended; `syncLoanSettings` cancels a live auto-listing first, through its
original executor, and a borrower's own listing is left to run or be
cancelled by the borrower.

**Conduit approvals on an executor.** An executor keeps its own list of
approved conduits. Revoking one is a stop (section 2): it is instant, it
blocks new listings through that conduit and invalidates live orders on it,
and it adds nothing. Approving a conduit again waits the same delay as a
marketplace change. A marketplace whose conduit has been revoked can no
longer list, and the cure is an announced retirement of that marketplace.
Nothing else on an executor that a listing depends on may change in place;
a different setting is a new executor and so a new marketplace.

The vault refuses a conduit its code does not list as accepted. The code
carries the conduit new listings use and, beside it, any earlier one still in
use by open loans. The vault holds no marketplace record per loan. A vault
version that names a new conduit therefore does not strand a listing on an
open loan, and does not move an open loan either.

## 7. Announced retirement and consent

**Retirement.** Governance (the Timelock) may propose to retire one part:
a price version (which retires every older one on that guard with it, by
raising the guard's floor), a whole guard with every version on it, a route
set, or a marketplace. The guard and the price version are one part: the
replacement named for a price retirement is always a guard together with a
version on that guard, so a loan moved off a retired guard lands on the new
guard at a version the new guard can answer.

- It waits at least 7 days. The guardian or the owner can cancel it. Anyone
  can execute it once due, and a keeper pass backs that step (shipped
  disarmed, with its row in the permissionless-steps ledger).
- The current value of a part cannot be retired. Governance first makes the
  new value current through the ordinary delayed change, then retires the
  old one.
- A retirement **names its replacement**, and the replacement must be the
  current value both when it is proposed and when it is executed. If the
  current value changes in between, the retirement lapses and needs a fresh
  proposal and a fresh wait.
- A loan holding a retired part is **moved** to the named replacement, not
  to whatever is current when the move happens, and its other parts stay. If
  the named replacement has itself been retired by then, the loan moves on
  to that retirement's named replacement. Each such retirement is announced
  to the holders of loans that would land on it, so a loan never receives
  settings its parties were not told about at least 7 days ahead.
- The move is one step, `syncLoanSettings`, which writes the loan onto the
  matching set. Nothing is written to a vault (sections 4 and 6). Anyone may call
  it, the keeper pass does, and every loan action runs it first, so no action
  ever reads a retired part. A view of a loan not yet moved answers as if it
  had been.
- After the move the loan is frozen again on what it moved to. Later changes
  for new loans do not reach it.
- A retired price version moves the loan to the named price version in
  full. The proposal event lists every difference between the retired
  version and the named one, and the app shows that list.
- The proposal event is the announcement. The indexer knows which loans hold
  the part and notifies both parties of each, and the app shows the pending
  change on the loan page with its date. A party who does not accept it has
  the 7 days to repay, sell or close.

Retirement is the only way an addition can reach an open loan without its
parties' consent, and it is never silent.

**Consent.** `moveLoanToCurrentSettings` moves one loan to the current set
when the borrower-position holder and every lender-position holder have each
approved that exact set number. An approval names the set, so it cannot be
replayed for a later one, and the move is refused if that set is no longer
current. A loan in
fallback custody or past default cannot be moved.

## 8. One rule, enforced

- `LibLoanSettings` is the one reader: given a loan it returns the guard,
  the price version, the route set and the marketplace, with any retired
  part already resolved. A new `LoanSettingsFacet` hosts the mint, the views,
  retirement, the sync step and consent, so no facet near the size limit grows.
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
- **Hourly and daily price checkpoints, and the calm test.** One series per
  asset, written at the price version that is newest when the slot is
  written, and each slot records that version. The calm test measures market
  movement, so each comparison has both ends on the same settings: the "now"
  price is read at the version the checkpoint was written under, for every
  loan. In the hours after a price version changes, the earlier slots are
  therefore still compared at their own version, which the guard keeps
  answering. A slot whose version the guard has since retired counts as not
  calm. A settings change by itself therefore never reads as a price move.
  The coverage test beside it (collateral against debt) and the sale's
  minimum output use the loan's own set.
- **Numeric risk thresholds already stamped per loan** (the treasury fee at
  origination, for example) are unchanged by this design.

## 10. App, indexer and keeper

- **App.** The loan page shows the set in plain words: which price sources
  and how many must agree, which sale routes, which marketplace, and the date
  they were fixed. A pending retirement shows with its date and the list of
  differences. The consent move is a two-party action on the loan page.
- **Indexer.** New events: set minted, set assigned to a loan, retirement
  proposed, cancelled and executed, consent given, loan moved. Loans are
  indexed by set so a proposal can be fanned out to both parties.
- **Keeper.** Try-lists are built against the loan's route set, read from
  `getLoanSettings`. One new pass executes due retirements and moves the
  loans that hold a retired part.

## 11. Tests

- A price config change, a feed rebinding, an adapter add, remove and
  reorder, a conduit change and a guard swap each leave an open loan's
  health factor, liquidation, default route, forced sale and listing reading
  the old settings, while a loan opened afterwards reads the new ones.
- A mute or a disable reaches every set at once; a re-enable waits the
  delay. A removal's refusals count until its 48 hours have passed.
- A feed rebinding alone gives the next loan a new set.
- The calm test reads "now" at each checkpoint's own price version, also in
  the hours after a version change; a slot on a retired version is not calm.
- Revoking a conduit on an executor stops listings at once; approving it
  again waits the delay.
- A source added after a loan opened is never consulted for it.
- Retirement: not before 7 days, cancellable, lists differences, never the
  current value; a loan holding the part moves on its next action or by
  sync, changes that one part only, and is frozen again afterwards.
- After a move and a later change for new loans, the vault still validates
  the loan at the settings it moved to.
- A retired price version is refused by the guard for every caller; versions
  on two guards are never compared.
- A loan moved off a retired guard lands on the named guard and a version of
  that guard, and prices there.
- A new listing on a loan opened before an executor change uses the loan's
  marketplace executor.
- An obligation handover keeps the loan's set, and the incoming borrower's
  vault validates the same named settings.
- A live listing is cancelled and cleaned up through its original executor
  and conduit after a marketplace move.
- A retirement whose named replacement stops being current before execution
  lapses; a loan moved late lands on the named replacement, not a newer one.
- Consent: both sides, exact set number, refused in fallback custody and
  after default; every holder on a divided loan.
- Try-list indexes stay stable for a loan across a reorder.
- A deployed adapter accepts no new swap target; removing one is instant.
- The vault refuses a guard or a conduit outside its code's accepted list
  and holds no per-loan settings.
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
4. **Let a retirement patch one price entry on an old epoch.** It would
   need branching history in the guard. Rejected for complexity; a price
   retirement moves the loan to the current price settings and says so.

## 13. Recommendation

Build the settings set as described: epochs in the guard and the feed
registry, immutable route sets, the marketplace in the set, one reader
library, and the four exceptions of section 2 as the only ways a change
reaches an open loan.

Build order:

1. Guard and feed registry epochs with "as of epoch" reads (security thread,
   with #3272 and #3268).
2. Route sets and the marketplace part; `LibLoanSettings`,
   `LoanSettingsFacet`, the set number on the loan.
3. Loan forms of the numeraire value entries and the switch of every loan
   path; the pre-deploy check.
4. Retirement, the sync step, consent, the keeper pass.
5. The vault's accepted lists and named-settings check, with #3268.
6. Indexer and app.

## 14. Open items

- Whether the registry pointer delay for the price guard should rise from 3
  days to 7 now that a swap reaches new loans only. Recommendation: leave it.
- Whether tightening a tolerance should be allowed to reach open loans
  without retirement. Recommendation: no; one rule is easier to trust.
