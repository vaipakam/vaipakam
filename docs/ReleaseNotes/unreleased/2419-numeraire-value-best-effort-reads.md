## Thread — Metrics, fee log and option thresholds on the shared 1e18 valuation (PR #2779)

The last valuations outside the risk and KYC paths now read the same shared
rule the loan risk checks use (#2419): the protocol metrics views, the
treasury fee log, the periodic-interest cadence threshold an offer is checked
against, and the treasury conversion threshold. Each value is in the active
numeraire with eighteen decimal places, one unit being 1e18 whatever the
token's own decimals, rounded down. The two offer facets no longer carry their
own copy of the cadence-threshold conversion; create and modify read the one
rule.

These values inform or switch on an option, and none of them may block what
it is attached to, so each reads the rule best-effort through one shared
helper. Where the rule cannot value an amount (no price, a stale or distrusted
price, a token whose decimal count cannot be read, a value too large to
state), the metrics count that leg as zero, the fee log records the fee at
zero while the fee itself still lands, the cadence threshold treats the
principal as below it (which only ever narrows the cadences allowed), and a
treasury conversion falls back to its time condition. The fee log never
blocks the settlement it records: an entry too large for its field is stored
at the field's maximum, and the running total stops at its maximum rather than
overflowing.

Entries already in the fee log are not revalued; a Diamond refreshed in place
keeps its earlier entries as recorded. The reward-accounting valuations and the
Full fee-entitlement tariff quote (whose tariff funds the recycling bucket)
belong to the rewards and recycling work and are not part of this change. Closes #2419.
