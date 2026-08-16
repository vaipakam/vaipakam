# Release Notes — 2026-08-13

Two threads of work dominate the day, and they are unrelated to each other.

The larger is the connected app's render-correctness sweep (#1520), which
accounts for eight of the seventeen entries. Each one is the same underlying
fault seen from a different screen: a value read at the wrong moment, so the
interface describes the thing you were looking at a moment ago rather than
the thing in front of you now. The phone "More" sheet stayed open across a
navigation, the desk order ticket could post a fill mode other than the one
selected, the offer review carried a previous offer's tariff choice, and three
screens showed a stale first frame. The consent surfaces are the sharp end of
it — an acknowledgement that fails to clear when the figures beneath it change
is a signature collected against something the user did not see. The day
closes that group out: the last of the four React hook rules becomes enforced
rather than advisory, so these cannot silently return.

The other is the rewards programme's recovery ceremony (#1434 P2-w6), which
gives stranded compensation value a settlement path. Value whose delivery
could verifiably never execute previously ended at "released", which left the
one-compensation-at-a-time gate held open forever, waiting on a fate nothing
could decide.

The remainder are corrections to things that described the system inaccurately
— a facet table calling five live settlement facets unbuilt, two protocol
console guards for a contract that no longer exists, six dead lint
suppressions, and two duplicate definitions of the hook-order guard.

## P2-w6 — stranded compensation value gets a settlement, and rotations carry open compensations (#1434 R6d/R6e)

A compensation whose message could verifiably never execute used to end at
"released": the day re-opened for funding, but the chain's
one-compensation-at-a-time gate stayed held, waiting for the stranded
tokens' fate to be settled. Nothing existed to settle it. That settlement
now exists.

### Recovering stranded value

When governance physically brings stranded value home, an evidenced
ceremony records it. The recycled portion re-enters the platform's
recycled custody under its own provenance label; the fresh portion lands
in the same recovery position that stranded returns feed, from which a
replacement compensation can be funded without charging the lifetime
reward budget a second time. Where part of the value is genuinely gone,
governance records that as explicit terminal loss, split by provenance the
same way.

The gate releases only when recovered value plus recorded loss account for
everything the original dispatch sent. Partial recoveries keep it held,
recording more than was ever dispatched is refused, each component is
bounded by what that delivery actually sent of that kind, and a ceremony
claiming tokens arrived without them actually being present rolls back.

Recovery is tracked **per original delivery**, not as one undifferentiated
pool. This matters when a delivery is later contradicted: only the value
still unspent from that particular delivery is frozen, so one contradicted
delivery can never consume recovery capacity belonging to another — which
that other delivery could not re-earn, its own entitlement being spent.
When a contradiction does occur, the whole of that delivery's remaining
entitlement is voided, not merely the part reclaimable at that instant, so
it cannot quietly become spendable again out of value belonging to someone
else.

Value written off as permanently lost is recorded with the same care as
value recovered: both stop counting as still in transit, so a written-off
balance cannot go on appearing to back live obligations. Value that
returns late is credited only up to what has not already been recovered or
written off, so what is recovered plus what was written off can never
exceed what was originally sent.

*Replacing an earlier intent:* recovery no longer "restores" spent budget
headroom. Keeping the lifetime figure permanently monotone and running
replacements uncharged from the recovery position is economically
identical, with one recovery pattern instead of two.

### Rotations

A deployment rotation can no longer silently forget an open compensation.
The outstanding-chain inventory is enumerable, and the rotation ceremony
carries any still-open chain's gate onto the new deployment, keyed to the
old deployment's receipt. Each open delivery can be carried across exactly
once.

The carried gate blocks new compensation for that chain until the old
delivery's fate is proven, and only the operator's evidenced settlement
proves it. There is deliberately no permissionless release. The record the
gate is keyed to is one the operator typed in by hand, and nothing on the
new deployment can check that it names the delivery genuinely outstanding
rather than some unrelated, already-settled one — so an attestation
"verified" against it would prove only that the operator was consistent,
while the real delivery stayed live and both it and its replacement backed
the same claims. Stating the release as the governance act it actually is
keeps a mistyped import to a liveness problem, recoverable by correcting
the entry, instead of a funding one.

**A carried-over settlement creates no spending capacity of its own.** It
releases the block, and recycled value that physically came home re-enters
platform custody; anything else remains ordinary custody. A replacement
compensation is then funded through the normal charged path, which
correctly counts against *this* deployment's lifetime budget rather than
assuming an earlier deployment's accounting carries across — it does not.
The consequence is that a mistaken carry-over costs only availability on
the one chain it names, and never value.

### Late confirmations

If a released delivery turns out to have been consumed after all, that
settles the chain by itself: the compensation funded what it was sent for,
so the gate opens and the chain can be compensated again, and the funding
accounting the release had unwound is re-closed — otherwise a replacement
could be funded against a quota the original already met.

Where a mirror's own reports contradict each other, nothing is taken on
trust. The gate stays shut until governance settles it with evidence, and
any recovery credit the contradiction calls into question is frozen rather
than left spendable.

## The phone "More" sheet closes as you navigate away from it

If the phone More sheet was open and you navigated without tapping one of its
links — using the browser's back or forward gesture, or following a link elsewhere
in the app that moves you programmatically — the sheet stayed on screen over the
first frame of the page you arrived at. It now closes in the same update as the
navigation.

Tapping a link inside the sheet was already unaffected: those links close the
sheet as they are tapped.

Nothing about when the sheet opens, what it contains, or which tab is highlighted
has changed.

## Desk order ticket — the fill mode you picked is the one that gets posted

The rate desk's order ticket shows the fill mode in force, and posts it.

A gasless lend order can only ever fill as one whole loan, so the ticket
switches the default "Partial" to "AON" and disables the Partial chip in that
mode. Previously the ticket stored one mode and corrected it a beat later,
which left a moment where the ticket claimed partial fill in a mode that cannot
serve it — and everything read off that claim during the moment, including the
order preview and the fee estimate, described an order that could not be
posted. The mode shown is now derived from the terms rather than corrected
after the fact, so the chip and the order always agree.

While making that change we introduced, and then fixed before release, a worse
version of the same problem: the correction was applied to every mode instead of
only to Partial. A lender who chose "IOC" — immediate-or-cancel, which the
ticket still offers in this mode — would have seen AON highlighted and signed an
AON order, and the rule that an IOC order needs an expiry would have stopped
applying to it. Only Partial is converted now, matching what the posting path
itself does, and the automated desk test drives the IOC case so the same
substitution cannot return unnoticed.

Separately, switching between lending and borrowing, or between posting on-chain
and posting by signature, now clears the risk-and-terms tick immediately rather
than a moment afterwards. Those switches change what is being agreed to, and the
tick has to fall with them. For a signature-only post this matters more than it
looks: there is no second checkpoint after the signature, so the terms on screen
when the box was ticked are the only record of what the user agreed to.

## Offer review: the tariff choice resets with the offer, and consent clearing has one owner

Two changes to the offer flow, both about a value being right in the frame it is
shown rather than a moment later.

Choosing a different offer to accept now clears the Full-tariff opt-in
immediately, in the same update that selects the new offer. Previously the
choice was cleared a beat afterwards, which left one moment where the previous
offer's opt-in was still in force against the newly selected one. Because that
opt-in changes what the borrower pays, the receipt in that moment could show a
price that did not belong to either offer. Nothing was submitted from that
state — the moment is shorter than a click — but the figure on screen was wrong
while it lasted, and the reset is now part of selecting the offer rather than a
consequence of it.

Separately, the rule that a changed disclosure withdraws consent is now enforced
in exactly one place. Four older, per-disclosure rules were doing the same work
as the general rule introduced with the consent-and-disclosure gate, each one
acting a moment later than the general rule already had. They agreed with it in
every case, so removing them changes nothing a user can observe; what it removes
is the possibility of them drifting apart in future, where a disclosure added to
one and not the other would be silently unguarded.

## The offset form's acknowledgement now clears in step with the figures

The borrower's offset form voids a ticked acknowledgement whenever the loan's live
figures refresh, so nobody can consent to one set of numbers and submit another. That
clearing used to happen a moment after the refreshed numbers were already on screen,
which left a brief window where the new figures were displayed with the box still
ticked — and a submit in that window would have carried an acknowledgement the person
never gave for those numbers. The clearing now happens as part of the same update that
brings the new figures in, so the window is gone.

No change to what the form does, what it charges, or what it asks for.

## Offset: say why the acknowledgement cleared

Posting an offset asks the borrower to tick an acknowledgement that they
have reviewed the funding figures. Those figures refresh on a timer, and
when they move the tick is cleared so consent can never cover numbers the
borrower did not see.

Until now that clearing happened silently. The box the borrower had just
ticked would untick itself with no stated reason — and because the figures
refresh on a timer, it could happen more than once while they were still
reading. The likely reading is a broken checkbox, so the borrower re-ticks
without understanding that the numbers underneath changed.

The offset card now shows a short notice when this happens, saying the
figures moved while they were reviewing and asking them to tick again
against the current numbers. The notice appears only if an
acknowledgement was actually ticked, so an untouched card stays quiet, and
it goes away as soon as the borrower re-ticks or the post completes.

This matches how the early-exit review already handles its own drifting
payout, so the two borrower surfaces now explain the same event the same
way instead of one of them doing it silently.

## Position page: the listing-hold confirmation keeps up with the position it describes

Three moments on the position page where the screen briefly described the
previous state of something rather than the current one.

Switching chains while the position page is open now clears the listing-hold
confirmation as part of the switch, rather than just after it. Previously one
frame could show the confirmation earned on the chain you left, attached to the
loan of the same number on the chain you arrived at — and the confirmation is
one click from sending a cleanup, so it mattered that it belonged to the right
listing. The same applies to an open review: it closes with the switch.

When a listing's lifecycle ends and a new one begins, the confirmation now
un-latches in the same update that observes the new lifecycle. And when a
listing ends off-page — a buyer accepted it, or it was cancelled elsewhere —
the notice is consumed as the page renders rather than a beat later.

None of this changes which confirmations are shown or when they are earned. It
changes only whether a frame can be painted showing one that has just stopped
being true.

## Three screens stop showing a stale first frame

Three places where the page painted one frame of the previous state before
correcting itself.

The NFT verifier's search box now follows the token you navigated to in the same
update as the verdict. Using back/forward or an in-page link previously left the
box holding the old token id beside the new token's result, which read as the
page having mismatched the two.

The activity feed's "show more" depth now resets as the wallet or network
changes, rather than one frame later. Switching accounts previously rendered the
new account's feed once at whatever depth the old one had been expanded to —
a visible jump, and briefly more of the new account's rows than the first page
is meant to reveal.

The trading desk's default market is now chosen as the market list arrives,
instead of a frame later. Previously the order book area still showed its "pick a
market" placeholder for one frame after the list had landed, even though the
default was about to be filled in. Nothing about which market is chosen has
changed — only that the placeholder no longer appears once the answer is known.

None of these change what the screens end up showing. They remove the moment
where the screen showed something else first.

## Connected app — the last of the four React hook rules becomes enforced (PR #TBD)

The connected app's lint configuration keeps React's hook rules visible as
advisories and promotes each one to a hard error only once the existing code
is clean against it, so the standard is raised deliberately rather than
declared and then ignored. This is the fourth and final group: the rule that
objects when a component sets its own state directly inside an effect,
because doing so makes React render a second time to take the change.

This group is unlike the three before it. In each of those, the rule was
pointing at real defects — a frozen clock read during render, a ref written
where state belonged, effects reading values they did not declare — and the
work was to fix them. Here, having gone through all nine reports one at a
time, none of them is a defect. Every one is an effect doing the job effects
are for, reacting to something outside the component that changed:

- Three close a review the page had open — an instant-exit quote, an
  obligation transfer, a rate-ladder fill — because a background refresh
  showed the thing under review had moved or gone. Leaving a confirmed
  review standing against figures that have since changed is the hazard;
  closing it is the fix, and it cannot be decided while rendering because
  the news arrives afterwards.
- Two reload local state when the connected wallet or network changes: the
  notification bell's read-position, and the tariff card's ceiling field.
- One seeds an editable field from the first price quote that arrives, and
  then leaves it alone, because the moment the user types in it the value is
  theirs and a later quote must not overwrite it.
- One records that notifications have been seen, which is a write to
  browser storage first and a state update second.
- One resolves a shared link into a selected offer.

Each now carries a note saying which of those it is, so the next reader can
tell a considered exception from an oversight without re-deriving the
argument. No behaviour changed anywhere: these are explanations, not edits.

The ninth is different and is marked as such. The rental flow clears a
ticked acknowledgement when a security warning about the asset changes, and
that clear is deliberately the *second* line of defence — the first is a
check performed at signing time, which is what actually prevents signing
against a warning the user has not read. Whether the clear should instead
happen while rendering, as the offset flow now does, is an open question
tracked separately; if it is answered that way, this effect disappears and
its note goes with it. It is the only one of the nine that should ever come
back.

With the group at zero the rule is now enforced, which is what makes the
distinction stick: a new violation has to be argued for in the diff rather
than added to a list nobody reads. That closes the inventory #1520 was
opened against — the four rules that were actually being violated.

It does not mean every hook rule is now enforced. Eleven more remain
advisory, and all eleven are at zero, so by the same principle each could be
promoted. They are left as they are on purpose: those eleven have never
found anything here, so promoting them would be asserting a standard this
codebase has not yet been tested against, which is the opposite of how the
other four were earned.

No user-visible behaviour changes.

## Six dead lint suppressions removed from the live UX sweep

The committed live-UX sweep driver carried six suppression comments for a lint rule
that is not switched on for it, so each one was reported as dead on every lint run.
Removing them takes the app's lint output down to only the genuine remaining
warnings, with no change to what the sweep does or prints.

## Developer tooling — one definition for the hook-order guard (PR #TBD)

Five packages — the DeFi app, the marketing site, two earlier app versions,
and the shared component library — each carry a deliberately narrow lint
check that enforces one thing: React's rule that hooks are called in the same
order every time. Each has that narrow check rather than a full lint setup for
its own reason, and each of those reasons is recorded where it applies.

The check itself was copied into all five. The copies were identical apart
from one line, and the duplication had already started to rot: three of them
carried an explanatory comment written about a different package.

That matters more for a guard than for ordinary duplication. Five copies are
five places to update when the check changes, and five places where the check
can be weakened for one package without it being obvious to a reviewer. A
guard whose definition is scattered is a guard that drifts.

The check now lives in one place and is consumed by all five. What stays local
is the part that genuinely differs: why that package has a narrow guard at all,
and what would let it be deleted. Those explanations were kept intact rather
than condensed, and are also collected into a single table for whoever picks up
the underlying cleanup.

Two things about the check look like oversights and are not: it loads two
plugins without switching any of their rules on, and it does not report
unused suppression comments. Both exist so the check reports hook-order
problems and nothing else — the packages' lint had been going unrun precisely
because it drowned real findings in noise. Both are now documented next to the
code rather than rediscovered.

Every one of the five was verified by breaking it on purpose — a conditional
hook was introduced into each package and the check confirmed to catch it,
then removed. A green run alone would not have shown the difference between
"still guarded" and "silently stopped linting this package", which is the one
failure this change could plausibly have introduced.

One deliberate asymmetry: two of the packages keep their own copies of the
lint plugin dependencies, because they also have a fuller lint setup that
imports them and that nothing currently runs. Removing those would have
broken that setup without failing anything today.

No user-visible behaviour changes.

## Protocol console — two guards for a contract that no longer exists (PR #TBD)

When the cross-chain VPFI purchase surface was removed to reduce legal exposure, two
guards in the admin console were left behind, each written to handle settings
that pointed at the removed contract.

Neither can do anything any more, because no setting has named that contract
since it was removed. One skipped such settings when matching pending timelock
changes; the other hid their cards on chains where the contract had no address.
The second is the more misleading of the two: its condition was always true, so
it passed every setting through unchanged while reading as though the console
still had chain-specific settings to hide.

Both are removed, each replaced by a one-line note saying what stood there and
why it cannot come back — so the next reader does not re-derive the question, and
does not mistake the removal for an oversight.

This was checked before it was cut, not assumed: the settings list contains no
entry naming the removed contract, which is what makes both guards provably
dead rather than merely unused-looking. Had the list still contained such
entries, the guards would have been hiding real rows and deleting them would
have exposed broken cards.

No user-visible behaviour changes — the console renders exactly the same
settings as before.

## Project instructions — five live settlement facets were described as unbuilt (PR #TBD)

`CLAUDE.md` is loaded as project instructions: it is the first thing an agent
or a new contributor reads, and it is read as fact. Its architecture section
ended by naming five facets as "placeholders (Phase 2)" — the treasury, both
borrower early-close routes, the lender-exit routes, and partial collateral
release.

None of them is a placeholder, and none had been for some time. Every one is
cut into the production Diamond, every one moves funds, and each has a real
surface: borrower close-out including handing the obligation to a replacement
borrower, lender exit by instant sale or by listing, releasing surplus
collateral on an open loan, and the treasury's claim, conversion and buyback
operations.

Two details in the new descriptions were corrected in review, and both are the
kind of thing this change exists to prevent. Refinancing does **not** edit a
loan's terms in place: it closes the original and replaces it with a separate
loan record, which matters to anything tracking loan identity. The original's
two position certificates are also kept rather than destroyed — marked as
settled, so the former borrower keeps a redeemable claim on the position they
left. And the
treasury's custody role depends on how the protocol is deployed — on the
documented mainnet setup, fees leave for an external multisig immediately, so
the claim and conversion paths have nothing held at the protocol to act on.

The document also contradicted itself twice over, which is what makes this
worth more than a typo fix: its own settlement rules name two of these facets
as the paths a loan properly closes through, and its retail-deploy section
lists the same two among the entry points that must reject sanctioned callers.
A reader who trusted the facet table and a reader who trusted either of those
sections would have come away with opposite beliefs about whether the code
exists.

"Placeholder — Phase 2" reads as *do not expect behaviour here*, which is the
opposite of true on a path that moves money. It has already cost real time
once, during earlier work on the sale routes, where the table gave no hint
that those were live surfaces with their own invariants.

The five now appear in a table of their own with what each actually does. Two
of them genuinely do carry future-scope notes in their source — the treasury
expects governance distributions later, and partial withdrawal expects
multi-collateral support — and that is probably where the retired line came
from; those describe work stacked on top of shipped behaviour rather than
absent behaviour, and are recorded as such. Also noted: the phrase "Phase 2"
appears inside several of these facets as internal task numbering, which is
unrelated to whether anything ships.

No code or user-visible behaviour changes.

## Connected app — signing now requires consent given against every disclosure on screen (PR #TBD)

Before signing an offer, the review screen can raise several different
warnings, and some of them only appear once the app has fetched the answer:
the token-security verdicts, an illiquid-collateral warning, notice that the
offer being accepted is a position sale rather than a fresh loan, and changes
to that sale's terms. The rule has always been that consent must be given
against what is actually shown — if a warning appears after the box was
ticked, that tick predates the disclosure and has to be given again.

That rule was fully enforced for the token-security warnings only. For those,
signing checks that the consent on file was given against the warnings
currently displayed. The other three disclosures relied on a follow-up pass
that unticks the box after the fact, and signing merely waited for the answer
to be *known* rather than for consent to *postdate* it. On the moment a late
disclosure arrived, that left a single frame in which the warning was on
screen, the box was still ticked, and signing was still offered.

The window is one frame wide, and the sign button had been disabled until the
answer arrived, so reaching it required a click landing in exactly that
instant. It has not been observed happening. It is nonetheless the same defect
the security check was added to prevent, so all four disclosures are now
covered by one check: the tick records everything that was on screen when it
was given, and signing requires that record to match what is on screen now.
Anything disclosed later invalidates it immediately rather than a beat later.

Practical effect: unchanged for anyone reviewing an offer whose warnings have
already loaded. If a warning arrives while you are looking at the screen, the
consent box clears and signing is unavailable until you tick it again —
which is what the previous behaviour intended, a fraction of a second sooner.

Review of the first attempt found four more ways the same gap could open, and
the check is broader as a result. It now covers the fee percentages and the
grace period shown on the receipt — those arrive from the network too, and a
tick can predate them just as easily as it can predate a warning — along with
the notice shown when a token cannot be security-screened at all, and the
outcome of the dry run performed before signing. Consent is given against the
whole receipt, so the terms belong in the check and not only the warnings.

It also no longer asks whether the screen *looks* the same as when you ticked,
but whether anything has changed since. Those differ when a warning goes away
and comes back: the screen matches what was acknowledged, yet the review has
changed twice, and the older acknowledgement should not carry.

One visible change: the dry run that checks whether an offer would be rejected
now runs before the consent box is ticked rather than after. Previously its
warning could only ever appear once consent had been given — meaning that
warning always arrived too late by construction. It is now disclosed alongside
the other terms, before you agree to them.

Two later rounds tightened the same rule further. Signing on a newly posted
offer now waits for that dry run to actually finish, not merely to have
started: while the check was in flight the button was already available, so a
rejection warning could arrive after submission was under way, at which point
nothing on the review screen can call it back. And the dry run's result is now
tied to the wallet and network it was performed for. Switching accounts
mid-review previously left the previous account's "this would go through"
verdict on screen for an instant, attributed to the new one — a verdict about
a different party's balances and approvals entirely. Switching accounts or
networks now clears the consent box outright, on the same reasoning that
governs every other case here: the receipt describes what a particular account
is about to sign, and changing that account changes what was agreed to.

One further case is tracked separately and is not fixed here: the Full-tariff
control paints its own "unavailable" warning a moment before it tells the
review screen, so the screen's own check cannot see it in time. That needs the
two to read the same source rather than one telling the other, and is filed on
its own.

## Recovery: the sanctions-oracle check always describes the chain you are on

The recovery page checks whether the network you are connected to has its
sanctions oracle configured, and only opens the recovery flow once that check
comes back positive. The result of that check was not tied to the network it was
read for, so for a moment after switching chains the page could still be showing
the previous network's answer.

That mattered more than a stale label usually does, because this particular
answer is what unlocks signing. Arriving on a network whose oracle is not
configured, from one where it is, could briefly leave the flow open when it
should have been closed.

The check is now tied to the network, the contract address and the connection it
was made against, and reverts to "checking" the instant any of those change —
which closes the flow, the safe direction. Pressing retry likewise returns the
page to "checking" rather than leaving the previous answer on screen while the
new one is fetched.

The mid-submit re-check that runs immediately before signing is tied to the same
identity, so the state you are left looking at after an aborted submit matches
what was actually just read.

## Full tariff: say when your ceiling has been overtaken

Opting into the Full VPFI tariff asks you to authorize a ceiling — the most
tariff you are willing to pay. The card seeds that ceiling from the first
quote it sees, with a little headroom, and then leaves it alone so a
background refresh can never overwrite a number you typed.

The quote itself keeps refreshing while you read. If it climbs past your
ceiling, you are no longer going to get the Full tariff you asked for: the
protocol refuses a tariff above the amount you authorized, or — if you ticked
the box allowing it — opens the loan without Full instead. Until now the card
said nothing about either outcome, even though both numbers it needed were
already on screen. The first you would learn of it was a rejected wallet
confirmation, or a loan that quietly opened without the discount.

The card now notices, states both figures plainly, and offers a single
action to raise your ceiling to fit the current quote. If you have NOT ticked
the box that permits opening without Full, signing is held while the mismatch
stands, so most attempts that would fail never leave the app at all — see the
limit at the end, which is real and not a formality. If you have ticked
it, signing proceeds — that box says to open the loan without Full in exactly
this situation, and the notice is there so the choice is an informed one
rather than a surprise. Your typed ceiling is still never changed behind your
back: raising it stays your decision, made with the two numbers in front of
you.

Unticking the option to open the loan without the Full tariff remains
available throughout, and the notice names that as the other way forward.

### Two refinements that came out of review

Signing is held only when you have *not* ticked the box that says to open the
loan without the Full tariff if it cannot be charged. That box already promises
the loan will still open in exactly this situation, so refusing to sign would
have broken a promise you relied on — and the protocol itself is happy to open
the loan that way. You are still told the figures have moved either way.

The check is also repeated at the moment of signing, against a freshly read
quote, rather than trusting what the screen knew when you clicked. A quote that
moves during the few seconds of pre-flight checks would otherwise slip through
to your wallet, which is the whole thing this change exists to stop.

### What this cannot promise

The check is repeated before each transaction is sent, but your wallet's
confirmation is your own step and can sit open for as long as you like. A
quote that moves while it is open will still reach the network and be
refused there, costing the gas of a failed attempt. Nothing in the app can
prevent that — only the protocol has the final word on the price at the
moment your transaction lands. What these checks do is make that outcome
much rarer, and explain it when it is still coming.

## Standing offers: warn when your tariff ceiling is already below the quote

A lender or borrower who arms a standing offer with the Full VPFI tariff
authorizes a ceiling — the most tariff they are willing to pay when the offer
is eventually filled. Until now the form checked only that the number was
well formed. It did not check it against the live quote sitting next to it.

So it was possible to save a strict authorization whose ceiling the quote had
already passed. Nothing looked wrong. Any fill whose own price sat above that
ceiling would then be rejected — and the rejection landed on the person trying
to accept it, someone who had done nothing wrong, could not fix it, and had no
way to see why. The offer's creator, meanwhile, was not there to notice.

The form now says so, naming both the live quote and the ceiling about to be
authorized, and states what actually follows: a fill priced above the ceiling
cannot charge the tariff, so it is rejected — or opened without the Full tariff,
if that is the fallback you chose. The quote shown is for the largest fill this offer can still
receive — already-filled amounts are excluded — and smaller partial fills may
still price under your ceiling.

It does not stop you saving. What the protocol judges is the quote at the
moment of the fill, and that may fall back below your ceiling before anyone
accepts — so the form treats this the same way it already treats a vault
balance below the quote: it tells you, and leaves the decision with you.
