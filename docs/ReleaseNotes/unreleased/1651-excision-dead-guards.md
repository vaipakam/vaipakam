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
