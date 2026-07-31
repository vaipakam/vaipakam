## Thread — the day-finalisation notice now carries the emission figure (#1218 M5 step 3a)

When a reward day closes, the platform publishes a notice describing that day's pool: how much was budgeted from the fixed schedule, how much came from recycled value, and the absorption average that sized it. The notice now also carries **how much of the schedule was actually drawn** — the day's net emission, and the single number the transparency dashboard is built around.

**Why it belongs in the notice rather than being looked up afterwards** is worth explaining, because it is the kind of decision that is invisible once made and expensive to reverse.

The component that turns on-chain activity into the fast queryable history behind the dashboard reads *only* published notices. It never asks the contracts a question. That is deliberate: a process whose output depends solely on a replayable stream of notices can be re-run from scratch and produce the same answer, and it cannot race with itself. Everything it stores is reconstructible.

Six of the seven figures the transparency design calls for were already available that way. Absorption is announced per day as it happens, and each reward chain's contribution is announced as it is accepted, so both halves of the global figure fall out of the stream. The day's budget and its recycled share were already in the closing notice. Only the drawn figure was missing — and it was the headline one.

Closing that gap by having the history component ask the contracts would have ended the property that makes it trustworthy, for exactly one number. Fetching it later, when someone opens the dashboard, would mean one lookup per day displayed, or a cache that has to be written from the read path — and it would leave the most prominent number on the page as the only one that disappears when the network is slow, while everything beside it loads from the local store. Putting it in the notice removes both problems and costs a single extra field.

The figure was already being computed at that exact moment; it simply sat inside a branch that skipped it before the programme is switched on, so it was not visible where the notice is written. Moving that calculation outside the branch changes no behaviour — it is a read-only computation, and the branch still guards the only thing that writes state. On a day before the programme is armed it now runs one extra read during a once-a-day close.

**Two things are asserted so they cannot quietly come apart.** The value in the notice must equal what the on-chain view reports for the same day — they are computed independently, so nothing but a test would catch them diverging, and publishing two different answers to the same question is worse than publishing none. And a day before the programme is armed must still reserve nothing: had the moved calculation dragged the reservation out of the branch with it, unarmed days would have begun quietly consuming the programme's commitment headroom, which is a far worse fault than the one being fixed.

**Two limits, stated here rather than discovered later.**

Widening a notice changes its identifier, so days that closed *before* this change were announced in the old shape and cannot carry the new figure. The stream of notices therefore describes the series from this point forward, not for all history. That is not a hole: the on-chain view reconstructs earlier days on request, so the two surfaces cover different halves of the same question — the notice pins each day as it closes, the view rebuilds what predates the change. Anyone who wants the older days in their stored history fills them in once from the view.

And where the notice and the view ever disagree, **the notice is the one to trust**. The view recalculates from a stored input which, in one supported recovery scenario, a later message can overwrite for a day that already closed. The recalculation can move; the announcement cannot. That asymmetry is an argument for carrying the figure in the notice rather than a caveat against it.

Nothing outside the contracts was reading this notice yet, so widening it broke no consumer. The figure carries the same caveats as the view it mirrors — it is what the day *committed*, not what was ultimately paid, and those limits are documented on the view itself.
