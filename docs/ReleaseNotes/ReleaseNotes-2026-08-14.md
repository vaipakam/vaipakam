# Release Notes — 2026-08-14

Three entries. Two correct documents that described the system inaccurately,
but in opposite directions, and the difference is worth keeping separate.

One removes references to a security vendor the product no longer uses — a
surface that is genuinely gone, so the prose was describing something that had
ceased to exist. The other corrects a staging plan that understated what the
indexer Worker actually does. That Worker is live, and the document claimed
narrower access than it holds; nothing was removed. An understated
least-privilege claim is the more consequential of the two, because it is
exactly the kind of statement a reader leans on when reasoning about blast
radius, and it fails quietly in the direction of false comfort.

Neither changes behaviour, and that is precisely why they are worth recording:
prose has no compiler, so a document that misdescribes a live system stays
wrong indefinitely and costs the next reader real time. The pattern is common
enough by this point that a blocking gate for one instance of it lands the
following day.

The third entry clears the unused lint-suppression backlog in the other app,
which turned up two live errors the suppressions had been hiding.

## The staging plan described the indexer Worker as doing less than it does (#1715)

The Cloudflare staging plan's architecture section explains why the three
Workers have different deploy cadences and different reviewer requirements. It
does that by describing what each one can reach. The entry for the indexer said
it was read-only, handled no HTTP-level credentials, and therefore sat at the
bottom of the risk ordering.

Both of those statements were wrong. That Worker holds fifteen stored
credentials, not the three the document listed: four are the kind an auditor
pictures — one marketplace key and three shared secrets used to authenticate incoming webhooks — shared, so holding one lets you *forge* a delivery as well as check one — and the
other eleven are network endpoints it binds for chain reads, each of which
carries a provider key inside the address itself and is therefore just as
leakable and just as billable. Counting only the first four reproduces the
undercount this change exists to correct. Those four credentials are used
over HTTP — one marketplace API key and those three shared webhook secrets — and
it makes authenticated calls out to a third-party marketplace to publish
listings on users' behalf. It is not read-only and it is not credential-free.

The ordering those statements were used to justify does not survive scrutiny
either, and that is the more serious half. All three Workers share one
database, and access to it is granted per-database, not per-table — so any of
them can write anything in it, whatever its own code happens to do. The
signing Worker reads a counter from that shared store and, once it crosses a
threshold, submits a privileged risk-parameter transaction. An attacker who
holds a non-signing Worker can write that counter and have the signing Worker
send the transaction.

The bound on that is worth stating precisely, because overstating it would
misdirect the fix. The transaction cannot be conjured from the shared store
alone — the signing Worker independently re-checks live market data each cycle
and does nothing when that check fails. What an attacker gains is the removal
of the *waiting period*: the requirement that the favourable reading persist
across many checks over several days, which exists so that one momentary
reading cannot move a risk setting. So the attack is "act on a single lucky
moment instead of a sustained trend", not "invent a result".

The corrected position is therefore narrower than the old one: the indexer
cannot move funds directly, but it can publish listings under the project's
marketplace credentials, and it can strip the time-based safety margin from a
change the signing Worker makes. Whether the fix is separate databases,
per-table isolation, or having the signing Worker validate state it did not
itself produce is an architectural decision, filed separately rather than
resolved by adjusting a deploy cadence.

The same reasoning applies to the other non-signing Worker, which holds the
same database access — so the deploy-cadence rationale that section states is
now marked as suspended for both, rather than corrected for one and left
standing for the other.

The specific phrase that was removed is the kind an auditor relies on to decide
a component does not need looking at. That is what makes it worth correcting
rather than leaving as an imprecision.

Two sibling descriptions of the same Worker are now corrected as well, rather
than excused. An earlier draft left them alone on the grounds that they pair
the shorthand with "no signing keys". That defence fails twice over. It is
not even true of this component — three of its stored secrets are shared
secrets used to authenticate incoming webhooks, and a shared secret lets the
holder produce a valid signature as readily as check one. And were it true, it
still would not help: this very change establishes that holding no signing key
does **not** make a component fund-safe, because it can still alter state the
signing component acts on.
Using that phrase to justify a "read-only" label the same document proves
false would have been the argument refuting itself. The labels said "Reads
only" on a component with three endpoints that write to the shared database
and one that publishes orders to an outside marketplace on a borrower's behalf — orders the borrower authorised on-chain, which the Worker can re-expose but cannot invent.
An earlier draft of this note also cited the Worker's entry point as
documenting its single write path — that was itself wrong. There are three
write-accepting endpoints, not one, and using a false claim to justify leaving
other descriptions alone would have propagated the same error sideways.

Review turned up six further corrections that the same section was carrying,
each of the same kind — a summary that had aged past the thing it summarised:

- **A third way a compromised component can cause harm, which the write-up had
  missed.** The two already described were publishing to the marketplace and
  removing a waiting period from a risk change. The third is the opposite
  shape: writing a row that claims a piece of scheduled work is *already
  finished*, so the component that would have done it skips the day without
  checking anything on-chain. The report it skips is the one another chain
  waits for before releasing rewards, so the result is a stalled pipeline
  rather than a bad value — quieter, and correspondingly easier to miss. The
  section now says to audit every scheduled pass that treats a stored row as a
  completion record, not only the ones that treat it as an input.

- **"Holds no signing key" was wrong about the notifications component.** It
  holds a real Ethereum key, used to sign the notifications it sends. It has no
  authority over protocol funds — which is the claim worth making — though it is
  not fund-safe either: the channel-owner wallet holds a staking deposit and a
  small amount of gas, so possession of the key reaches those. Describing it as
  keyless would lead a reviewer auditing secrets to skip genuine key material.

- **The inventory of what the signing component can do was roughly a quarter of
  the real list**, and one entry was described as future work while it had been
  running on every scheduled tick. It is now presented as a floor, with a note
  on the two ways the previous attempts to enumerate it went wrong, so the next
  person re-derives it instead of trusting the list.

- **Authentication differs per endpoint and the note first said otherwise in
  both directions.** The original claimed every write was backed by a wallet
  signature; the first correction claimed none were. In fact the link, unlink
  and test-send endpoints each verify an ownership proof over their own
  message, and the administration endpoints are gated, while
  five others take no wallet identity on their ordinary path — the support-ticket,
  diagnostics-record and threshold-update endpoints, plus the two publication
  routes that write to a resolver network and a public marketplace under the
  project's own credentials. Nor are those five alike: four are rate-limited
  and one — the threshold-update endpoint — is protected
  only by an origin check, so an earlier draft claiming the unsigned routes
  rely on "origin checks and rate limits" credited it with a control it does
  not have. The document now lists every route individually, because a single
  answer is wrong whichever way it points.

  That accounting was still one route short, and the missing one belongs to
  none of the groups above. The Telegram webhook is reached before the origin
  check and carries no wallet signature, yet it is not open either: it is
  admitted by a one-time six-digit code, issued only after an ownership proof
  on the link endpoint and consumed on first use. It is the completion half of
  a signed handshake, and it writes the chat identifier supplied by whoever
  presents the code — so a guessed live code redirects that wallet's alerts.
  Counting it as unsigned would have understated its control; leaving it out
  altogether, which is what happened, hid the one route whose protection is
  unlike every other route's.

  One of the five also has an exception the note had flattened away. The
  threshold-update endpoint is signature-free for an ordinary settings change,
  but not when the change switches off the maturity-approaching alert: that
  one path requires and verifies an ownership proof scoped to muting it,
  because silencing a due-date warning is the kind of change an attacker
  benefits from and the owner does not. Classifying the endpoint as
  identity-free full stop erased a control that exists precisely where it
  matters most.

- **The per-route table left out two of the routes it exists to disambiguate.**
  Unlinking a chat and sending a test alert are both user-facing writes, and
  both do verify an ownership proof — but a table whose whole purpose is
  "do not assume one answer covers them" cannot be silently partial. The
  unlink route is worth naming for a second reason: it is an alert-suppression
  surface, so a gap there costs a user the warnings rather than costing them a
  write.

- **The conclusion drawn from the withdrawn claim outlived it in two more
  places.** Correcting "holds no signing key" does not by itself correct
  "therefore a compromise only produces stale notifications" — that sentence
  survives on its own wherever it was written out. It was still standing in the
  notifications component's entry point and in the Worker-split plan, where it
  appeared as a quotation of the older version of the very paragraph this
  change rewrote. Both now carry the same qualification as everywhere else: no
  transaction key rules out moving funds *directly*, and nothing further. The
  quoted paragraph also asserted that the notifications component holds no
  network endpoints, which is not true — it binds more of them than the signing
  component does.

  The distinction between *binding* a network endpoint and *reading* the chain
  behind it matters, and an earlier draft of this very bullet got it wrong in
  the more alarming direction. The extra endpoints the notifications component
  binds are all for one network that has no deployment record, so the startup
  path discards them and both components reach the same set. What the extra
  bindings widen is the surface a credential leak would expose, not the set of
  chains anything actually talks to. Every count in this note is of secrets
  bound, on the same basis.

One behaviour change, and it came out of writing the inventory rather than
being planned. Describing the Telegram webhook's protection required stating
that its one-time code is spent the first time it is used — and checking that
showed the code was looked up and deleted as two separate steps, so two
requests arriving together could both be accepted, with the second one's
destination winning. Since that code is the only thing standing between a
caller and redirecting someone's alerts to their own chat, the claim was made
true rather than softened: the code is now claimed in a single indivisible
step, and whichever request loses the race is rejected. An expired code is now
also spent when presented, instead of being left behind.

Nothing else in this change alters behaviour.

## Removed references to a security vendor the product no longer uses (#1717)

The pre-sign transaction preview — the panel that checks, before you approve,
whether a transaction would succeed or fail — was originally built on a
third-party scanning service, briefly moved to a second one, and now uses
neither. It runs the check directly against the chain from the browser and
reports the outcome. It does not itemise what the transaction would change;
that richer view was the departed vendor's, and describing the current panel
as showing "what a transaction will do" overstates it. That change shipped some time
ago, but references to the original vendor were left behind in several places.

Most of them were harmless bookkeeping. One was not.

A completed security due-diligence questionnaire prepared for a partner
described the product as routing transaction previews through a server-side
proxy for that vendor, and stated that the associated API keys were held
server-side. Neither is true: there is no such proxy, and there is no key. The
questionnaire's own covering text notes that access to that partner's service
can be suspended depending on the answers given, which makes an inaccurate
answer in it a different kind of problem from a stale comment.

The original wording has been struck through rather than rewritten, with a
correction recorded alongside it. That preserves what was written in case the
document was actually sent — quietly editing a compliance answer to match
reality afterwards would destroy the only record of what a partner was told.
**Whether it was sent, and therefore whether a proactive correction is owed,
needs a human decision and is flagged in the document rather than assumed
either way.**

The rest:

- The design document defining how the background services were split apart
  contains a table recording where each module of the old combined service was
  routed. It named two modules that have since been deleted, and placed a third
  against a service other than the one it now lives in. Rather than rewrite the
  rows, the table is now explicitly labelled for what it is — a record of the
  split as it happened, not a description of any service as it stands today —
  with every original row kept and each later change noted beside it. It also
  now says plainly that it cannot be used to work out what a service is capable
  of, and points at where to look instead.

  That last point turned out to matter more than the deletions: three
  notification modules the table assigns to one service also exist in the
  transaction-signing one, which a single-destination column cannot express.
  Anyone using the table to bound what the signing service can do would have
  concluded it cannot send notifications, which is the opposite of true. The
  sizing inventory earlier in the same document names the two deleted modules
  as well, and is deliberately left unedited: it is the evidence the split
  decision rested on, and is marked as a snapshot of that moment.
- Twenty translated user-facing strings across ten languages named the vendor
  in warnings that are never displayed. Removed — they were dead weight that
  translators would keep maintaining, naming a company the project has no
  relationship with.
- A handful of code comments and one glossary entry.

Their unused siblings in the same translation block were left in place; whether
that whole block is dead is a separate question from this one.

No behaviour changes — no rendered text, and no runtime code path, was
affected.

## apps/defi: cleared the unused lint-suppression backlog, and found two live errors hiding in it

The lending app carried sixteen lint suppressions that no longer suppressed
anything. Clearing them was meant to be routine tidying — the smallest slice of
the wider effort to get the app's full lint run to zero — but two of them turned
out to be covering genuine errors that the app's lint run had been carrying
unnoticed.

Fourteen were simply inert: they suppressed a console-output rule the app has
never actually switched on, so they could not have been suppressing anything.
The sibling app that has already reached a clean lint run had removed exactly
this class of leftover, so these follow it.

The other two were the interesting ones, and they failed the same way. A
suppression of this kind applies only to the single line immediately after it.
Both had been written above a statement that spans several lines, so each came
to rest on the opening line while the thing it was meant to excuse sat further
down — outside its reach. In both cases the rule had been firing for real, and
the app's lint run had been carrying those errors unnoticed, camouflaged among
the warnings about the suppressions themselves.

The first documented a deliberate, correct exception: a
pricing hook reads chain data for a chain the caller names explicitly, rather
than whichever chain the wallet happens to be on, so it is allowed to bypass a
rule that otherwise steers every read through a shared wrapper. That reasoning
still holds. Here the explanation written above the import had grown to five
lines, so the suppression came to rest on a line of prose and stopped covering
the import entirely. The explanation now sits above the suppression rather than
between it and the import.

The second sits at a marketplace-publishing call, where a value is deliberately
cast loosely at the boundary to an external contract's typed interface because
only the encoded content matters to the hash being recomputed. That reasoning
also still holds, but the suppression had been written above the opening line of
a multi-line call while the cast itself is four lines further in. It now sits
directly above the cast.

Both notes record why the placement matters, so the next person to expand either
explanation doesn't silently push the suppression off its target again. No
behaviour changes: the same code runs, against the same chain, as before.

Worth noting for whoever picks up the rest of this cleanup: because the app has
never enabled the console-output rule, the fourteen deliberate console calls
those directives described are now unremarked. Turning that rule on is a
separate decision, not part of this change.
