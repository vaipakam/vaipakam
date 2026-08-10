# P2-w5 — the stranded-compensation return and the recovery position (#1434 R4)

A compensation that a mirror had to quarantine (wrong era, expired
window, conflicting arrival) is no longer a dead end. Anyone can now
send the quarantined value home to Base over the shared return channel —
the record on the mirror is the evidence, the caller only pays the
message fee, and the exact recorded amount travels; nothing about the
return can be redirected or resized by the caller.

On Base, the returned value lands in a new **recovery position**. The
credit is strictly bounded: it must arrive from the chain the original
remittance was sent to, and it can never exceed what that remittance
dispatched — anything above that entitlement is parked in an
operator-visible overage ledger rather than credited (or bounced).
Receiving a return also settles the "one compensation in flight per
chain" gate for that chain, so a replacement can be funded.

The position exists to be re-spent, without double-charging the reward
budget: a replacement compensation (manual or supplemental) can be
funded **from the recovery position**, bounded by the position's
balance, and the lifetime reward-budget cap is not charged a second
time — the returned parcel already paid its charge at the original
dispatch. Reservations funded this way are marked, so no later
bookkeeping can "restore" budget headroom that was never consumed.

Returned tokens sitting on Base are earmarked away from ordinary reward
claims (the same protection quarantined arrivals already had on
mirrors), the transparency snapshot publishes the new earmark, and the
mesh watcher alarms if the Diamond's balance ever stops covering it.
