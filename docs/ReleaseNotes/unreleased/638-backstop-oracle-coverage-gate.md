## Thread — Backstop-only minimum oracle-coverage gate (PR #<n>)

The general, permissionless Vaipakam protocol does not gate which assets can
be used as collateral, and that stays true: an asset whose secondary oracles
are unset still rides the Soft-2-of-N quorum's single-feed soft fallback, and
the general liquidation / liquid-classification path is unchanged. Asset
eligibility on the general path remains ungated (owner direction, 2026-06-19).

Where protocol money is at stake, though, gating is legitimate. The
treasury-seeded backstop puts *protocol* funds on the line when it becomes a
loan's counterparty (Role A) or absorbs a defaulted loan's collateral with
treasury cash (Role B). This change adds an **opt-in, governance-set,
backstop-scoped** minimum-oracle-coverage requirement: governance can configure
the backstop to refuse collateral priced by fewer than N live secondary feeds
(Tellor / API3 / DIA), so the treasury is never left holding single-feed-priced
collateral. A feed counts as "live" when it is configured, fresh, and reporting
a non-zero value — independent of whether it currently agrees with Chainlink.

The knob defaults to 0 (no requirement), so an unconfigured backstop behaves
exactly as before. It is read **only** by the two backstop paths; it never
touches `getAssetPrice`, `checkLiquidity`, or any general liquidation entry
point. The setter is admin/governance-gated and range-bounded to the three
available secondaries. Closes #638.
