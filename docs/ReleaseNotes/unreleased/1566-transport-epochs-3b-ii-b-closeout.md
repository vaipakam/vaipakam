## Thread — a past day is proven closed once every obligation on it has terminated, by anyone, once (#1566 transport epochs 3b-ii-B, the closure proof)

**Problem.** The release of an old-wire delivery's remainder must wait until no obligation on any day it listed could still draw from it — the machine check the design states and the owner chose (#2258). No per-day figure of outstanding obligations exists, and maintaining one would charge every settlement on every chain for a check only a mirror holding such a delivery ever runs.

**What changed.** Anyone may now prove a past day closed, in bounded pages, and the proof is paid once per day, ever. A walk is opened for the day under the starter's own nonce and advanced a page at a time per side: entry identifiers in ascending order past the side's cursor, each of that side and covering the day, each terminated on it — settled whole, or part-claimed past the day, with no staging record of its claimant-side standing on the day and no open legacy slice of the entry spanning it. The side is complete when the visited entries' per-day figures add up to the day's own folded total — the same conservation test the commitment report already uses, so an omitted entry leaves the sum short and the walk cannot complete. When both sides are complete the day is stamped closed, irreversibly; a day with no obligation on either side closes at the start. A sum beyond the total means the day's records disagree, and the proof refuses rather than completing on them.

**Why the stamp is safe.** A past day's covering set is fixed — no entry can begin or stop covering a day that has passed — so "every obligation on it has terminated" is a monotone fact of the day, provable once and true for ever, and shared by every delivery listing the day. Two conditions guard the irreversible stamp: the chain must have closed the day itself, since the totals the proof compares against are final only once the day is folded and reported; and the interest fold must have reached the day on both sides (the preceding thread), since otherwise an empty walk would pass conservation against two zero totals.

**A walk is the starter's, never a shared cursor.** A caller who omits a covering entry advances only their own cursor past it; their walk can never complete and is simply abandoned, a fresh walk by anyone closes the day, and nothing an author does can spoil another's proof. No reset entry, no administrator in the loop.

**Published.** Whether a day is proven closed, each walk's cursors, sums and completeness, a starter's nonce, and whether a given entry counts as terminated on a day are readable; a walk's opening, each page and the day's closure each emit an event. The entries live on their own facet.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the closure proof).

## Thread — an old-wire delivery's remainder is released only once every day it listed is proven closed (#1566 transport epochs 3b-ii-B, the release gate)

**Problem.** The first transport-epoch cut shipped the release shut to everyone: the rule — refuse a batch that still lists an outstanding obligation — could not be checked until obligations were tracked per day, and a release the chain cannot check is an earmark spent on the caller's word (#2258, the owner's Reading B).

**What changed.** Parking a batch's remainder is now the release gate, and it is open. The caller re-supplies the batch's whole day list, checked against the commitment recorded when the delivery arrived exactly as its indexing was, and from the batch's own cursor one page of listed days at a time must each be proven closed by the closure proof above; the first day still open refuses the page by name and nothing is applied. When the cursor reaches the end the remainder parks — still refused while any staging record references the batch or the batch is not fully indexed. Parking is mechanical and permissionless: the remainder moves into a holding of the same batch under the same membership, nothing becomes spendable, and what makes it valid is state, not the caller.

**The acknowledgment is the administrator's.** Releasing the parked remainder — after which the batch's delivery passes the classification gate — is the operator disposition the design names, gated accordingly; it is one-way and refused twice. The one-argument park entry that refused everyone is retired.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the release).

## Thread — a remainder that owes nothing payable can be retired by anyone, so its days can close (#1566 transport epochs 3b-ii-B, the zero-priced retirement)

**Problem.** A closed, non-forfeited reward entry whose remaining window prices to nothing payable was never marked settled: the expiry sweep returns before starting its clock when nothing is payable, and the owner has nothing to claim. The closure proof tests "settled, or part-claimed past the day", so such an entry would have refused its days — and every delivery listing them — for ever, over an obligation that owes nothing.

**What changed.** Anyone may now retire such remainders, through the same entry family as the expiry sweep and with the same budgets. Two shapes are distinguished, by two tests, never one: a window that is empty — closed before it began, or priced to no value at all — is marked settled with nothing moving; a remainder the loan-side reward ceiling trims to a zero payout while its raw entitlement still stands runs the expiry sweep's own terminal accounting for one day per call — the ceiling's truncate-and-consume, which retires the commitment behind the raw entitlement and persists the day — until the window is done. A retirement keyed on "unpriced" alone would have retired raw dust and left every cap-exhausted entry, its days and its deliveries unclosable; so a closed window that merely is not yet priceable is left alone, as is anything payable, open or forfeited. The proof's termination test is unchanged.

**One body for the terminal day.** The expiry sweep's single-day settle is now the one routine both the sweep and the retirement run, so the two cannot drift.

**Follow-ups recorded, not built.** Repatriation of an UNTYPED released remainder (the design names it as the exit for a remainder no evidence can classify) has no path today — the existing repatriation moves typed recycled value — and needs a canonical-side untyped return leg; recorded as an owner question (#2376). Batch-bound replacement funding has nothing to clear under the owner's reading, since the park already requires every listed day proven closed.

**Spec:** TokenomicsTechSpec, the transport-epoch bullets (fifth change: the retirement).
