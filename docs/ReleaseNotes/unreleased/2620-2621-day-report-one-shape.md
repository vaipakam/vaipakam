## Rewards — the day-close safety rules move into the contract (PR #TBD)

Closing a reward day and finalizing it are both open to anyone. Until now, three of the rules that make those calls safe were enforced only by the platform's own keeper, so anyone else could still make an unsafe call. They are now enforced by the contracts for every caller.

**One report shape.** Mirrors used to send their day report to Base in one of four generations, with fallbacks between them, and only the newest could arrive after Base had finalized the day without being refused once its fee was paid. There is now a single report. It carries the reporting chain's reward-clock start time alongside its figures. The older shapes and every fallback are gone. The platform is pre-live, so this ships by fresh deploy of every reward chain, with no compatibility path.

**The route is checked at the moment of the close.** A mirror's close now tells its messenger which chain the Diamond calls Base. If the messenger is set to send anywhere else, it refuses, so the close fails and the day stays unsent rather than being marked as sent to a chain that will never receive it. A messenger without the report shape refuses the same way. This closes the race where governance rotates the messenger between the keeper's checks and its close.

**Base counts a report's day figures only on its own reward clock (#2620).** A day number covers the same hours on every chain only if every chain's clock started at the same moment. Base now compares the reporter's clock with its own. When they differ, Base still applies what the report says about the chain as a whole (custody era, recycled and commitment totals), announces the mismatch with both times, and leaves the chain unreported for that day, so the day completes or zeroes as if the report had never arrived. A report that lands after its day is finalized is handled the same way and is announced as late. Neither is refused, because a refusal would also throw away the chain-wide figures.

The fourth rule, that Base's expected-source list can never be empty or leave Base out, was already enforced by #2645. The keeper now prices the one report along the route the close names, and no longer holds days on account of the report's shape. Its clock and channel checks stay in place as a second line of defence, and so does its alert for a close that left through a rotated messenger.

Closes #2620, closes #2621.
