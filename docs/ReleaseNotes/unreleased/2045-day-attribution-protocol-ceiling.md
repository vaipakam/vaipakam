## Rewards mesh — one chain's absurd report can no longer stop the day (PR #<n>)

Every chain's daily report carries two recycled figures: its lifetime total and the credit it names for the closing day. The canonical chain caps a day's accepted credit at whatever that lifetime total has not yet attributed. That cap is only as strong as the lifetime total, and the total comes from the reporting chain itself. A faulty or compromised chain that reported a near-maximum total together with a near-maximum day credit therefore had the whole day credit accepted. The day's finalization then overflowed while summing the credit of the chains it counts, and stopped. That left the day unfinalized for every chain, not just the one that misreported.

A day's attribution now has a protocol ceiling that no chain's own figures can raise: one chain's accepted credit for one day never exceeds the VPFI hard supply cap (every VPFI that can ever exist). It applies whether or not the canonical chain has set a tighter per-chain ceiling, and a per-chain ceiling above it is refused. No honest day comes near it. Anything a day names above the ceiling joins that chain's backlog and is attributed on later days, the same as anything a per-chain ceiling trims, so nothing is lost.

The supply cap is now stated once, in the token's interface. The token and the reward mesh both read it from there, and the token's code is unchanged.

The lifetime total still ratchets to whatever a chain reports. That figure measures availability, and funding is already re-bounded against it, so a huge total does not stop the day.

Closes #2045
