## VPFI recycling governor — bounded configuration knobs (Phase A1a)

The first slice of the VPFI recycling balance governor (design
`VpfiRecyclingBalanceGovernorDesign.md`) lands as pure configuration
plumbing: two new admin-tunable, bounded knobs that later phases read,
with no behaviour change yet.

- **Recycling margin** (`setRecycleMarginBps`): the slight platform-favouring
  share the governor will retain from absorption before sizing the
  usage-reward budget. Default 5%, bounded to at most 25%; setting it to zero
  resets to the default, so an (almost) zero margin is expressed as the
  smallest non-zero step. This is the single lever that keeps VPFI absorption
  and distribution in balance with a small edge to the protocol.
- **Discount-entitlement tariff `k`** (`setRecycleTariffKPer1e18EthDay`): the
  quantity of VPFI a borrower/lender will pay at loan initiation to buy a
  loan's fee-discount entitlement, sized purely by the loan's ETH volume and
  duration — never by converting a fee value at a token price. Bounded to a
  wide governance range with a conservative default.

Both follow the house pattern for governed parameters (ADMIN-role setters
behind the timelock, compile-time bounds, a zero-sentinel that resolves to a
library default, and a one-call `getRecycleConfig` read). They ship dormant:
nothing consumes them until the governor and the tariff mechanism land in the
following phases. Storage was appended at the end of the layout, so an
in-place facet refresh needs no migration.

Part of #1217 (Phase A of #1222). No user-facing behaviour changes in this
slice.
