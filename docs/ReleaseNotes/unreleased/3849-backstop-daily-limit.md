## Thread — The backstop's daily lending limit (PR #<n>)

The backstop (Role A, the protocol's lender of last resort) now lends at most a governed share of its lending capital in each lending asset per UTC day. The capital is the funded capital waiting across the asset's pairs plus the principal out on the backstop's open loans. The share starts at one fifth (2,000 basis points) and may be set between 500 and 5,000. A Diamond that never set it reads the default; there is no value that means "no limit".

Why: anyone may run a backstop fill, and every gate it had was a per-fill gate. A fault lasting some hours (a wrong price input, a gate that reads wrongly after a change) could have been paid for with the whole seed in a day. With the limit it costs at most the day's share, and the existing fill switch has a day to be used.

How it works: one running total per lending asset per UTC day. The check sits where every loan opened from the backstop's capital is recorded, the same seam the instant market's ledger already uses for every slot fill, so any route that ever opens a loan from the backstop's capital counts in the same total. A fill that would take the day's total over the limit is refused with an error naming the limit, the amount already used and when the day ends. Because the backstop fills whole offers only, a borrower's opt-in now refuses an offer larger than the whole daily limit and says why; the fill checks again, because the limit moves with the capital. A fill itself moves capital from waiting to out, so it never moves the limit; a new seed, a withdrawal to treasury, a repayment or a default does. The buyout and absorb (Role B) keep their own cap and are not counted.

The setting is held by the vault-admin role, which the governance handover gives to the timelock, so a change waits out the governance delay. The fast stop is still the fill switch (and the protocol pause). A new view returns, per lending asset, the limit, the amount used today, the room left, when the day ends, the capital it is a share of, and the share in force. The open-steps ledger's row for the fill now states what its caller chooses (which eligible offer uses the day's room) and what bounds it.

Closes #3849

> Caveat: the day is the UTC day, so a stretch that spans midnight can use two days' limits: up to twice the share in any 24 hours.
> Caveat: the day's room is first come, first served; any caller may fill any eligible offer, and the keeper's own order (oldest eligible first) is a keeper choice, not a contract rule.
> Caveat: a seed made during the day raises that day's limit at once (a seed is itself a governance step); a withdrawal or a repayment can leave the day's used total above a lowered limit, which reads as no room left.
> Caveat: the keeper's fill step and the app's display of the four figures are separate changes.
