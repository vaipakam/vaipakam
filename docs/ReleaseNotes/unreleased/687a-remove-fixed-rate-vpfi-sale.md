## Thread — Remove the fixed-rate VPFI sale (legal-surface reduction) (PR #<n>)

The protocol no longer sells VPFI to users at a fixed ETH rate. The
on-chain issuer sale — buying VPFI directly from the protocol with ETH on
the canonical chain, plus the cross-chain "buy on a mirror chain" round
trip — has been removed in full. This is the first step of the VPFI
legal-program excision (#687): an issuer-operated token sale is the single
largest securities-law surface the platform carried, and removing it keeps
VPFI a purely consumptive utility token that users acquire on the open
market or bridge in themselves.

What was removed: the `buyVPFIWithETH` entry point, the bridged-buy ingress
(`processBridgedBuy`), the fixed-rate quote view, the per-wallet / global
sale caps and the sale kill-switch, the "amount sold" tallies, and the two
cross-chain contracts that carried the buy round trip
(`VpfiBuyAdapter` on mirror chains, `VpfiBuyReceiver` on the canonical
chain) together with their CCIP "vpfi-buy" channel, deploy steps, and
handover legs.

What was kept: the consumptive VPFI fee-discount utility is unchanged —
staking VPFI into a vault (`depositVPFIToVault` / `withdrawVPFIFromVault`),
the time-weighted discount tiers, the borrower Loan-Initiation-Fee rebate,
and the lender yield-fee discount all continue to work exactly as before.
The discount quote still needs a VPFI price anchor, so the price field the
sale used to share was renamed (not deleted) into a dedicated discount
config: `setVPFIDiscountRate` / `getVPFIDiscountConfig`, alongside the
existing `setVPFIDiscountETHPriceAsset`. Because the platform is pre-live,
the removed storage fields are dropped outright (a fresh deploy, not an
in-place upgrade).

Part of #687. Follow-ups: #687-B removes the 5% staking yield (keeping the
discount tiers); #687-C confirms the treasury buyback stays dormant; the
frontend buy page, agent buy-watchdog, and marketing / user-guide / i18n
copy that still reference the sale are migrated in a dedicated follow-up.
