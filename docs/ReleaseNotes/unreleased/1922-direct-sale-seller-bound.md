### A seller can now hold a direct position sale to the economics they reviewed

Selling a loan position straight into a standing buy offer settles in one
transaction, at figures the contract recomputes from live state at the moment it
mines. Between the seller reading a quote and their transaction landing, that
state can move — a borrower partial-repays, or parked interest is settled — and
the seller's actual receipt can come out lower, or their cost higher, than the
quote they acted on. The unbound sale takes whatever the live figures produce.

There is now a second, opt-in way to sell that carries the seller's reviewed
numbers: a minimum net receipt, a ceiling on how much already-accrued interest
would transfer to the buyer with the position, and a required deadline. The
sale is refused if execution would be worse for the seller than those figures —
a net below the floor, more accrued interest migrating to the buyer than the
ceiling allows, or a fill past the deadline — and passes when it is at least as
good. These are the same quantities the listed route's bound carries, read from
the same seller quote, and the check runs against the very figures the
settlement uses, so it cannot drift from what the seller actually receives.

The deadline is required, not optional, and that is deliberate. Selling the
position also forfeits the seller's pending usage reward, measured at the day
the sale settles — a loss that grows the longer the transaction is delayed and
that neither the net floor nor the held ceiling can see. A finite deadline caps
that forfeiture to the window the seller chose, exactly as the listed route's
mandatory finite expiry does. A seller who genuinely wants no cap on any of the
three costs still has the original unbound sale; the bound entry, by contrast,
must bound all three, so it requires the deadline.

This mirrors the bound entry the listed sale route already offers, and exists for
the same reason: the platform's two sale routes must let a seller bind their
economics identically, or the same position could be sold on different terms
depending on which route it left by. The original unbound sale is unchanged and
still available; the bound entry is a strictly additional, safer option.

Closes #1922 (#1503 item 6) — the last of the four remaining lender-sale items
(5, 9, 15 already closed) being closed in place rather than by a new sale
instrument.
