## Keeper — one ops alert when the signing key cannot sign (PR #3154)

When the keeper machine's `KEEPER_PRIVATE_KEY` is unset or unusable, the pass
gate disarms every pass that sends a transaction: the liquidations and
defaults, the reward passes, and the on-chain observers such as the sanctions
hold, the horizon heartbeat and the testnet stand-in refresh. The two senders
outside that gate check the key themselves, so the keeper sends nothing at
all. The watchers that sign nothing (the health-factor and pre-grace user
notices, and the liquidity-confidence counter) keep running. Until now each
disarmed pass said so only in its own journal line, so operators found out
late.

Each tick now checks the key once for the whole machine. While
`KEEPER_ENABLED` is on and the key cannot sign, it posts one ops-channel
alert, repeated every six hours until the key signs again. The alert names
the kind of problem (unset, wrong length, not hexadecimal, not a valid key),
never the value. It reads the same answer the pass gate does, so a pass that
reads as armed can always sign, and the passes stay in one mode rather than
each gaining a key-less fallback.

Nothing is posted while `KEEPER_ENABLED` is off, since the keeper is then
switched off on purpose. Once the key signs again, or the keeper is switched off, the
alert's record is cleared, so a recurrence alerts at once.

Closes #3119.
