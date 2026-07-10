## Thread — Rate Desk phase 1: the trading-terminal page (PR TBD)

The alpha02 connected app gains its first pro surface: the **Rate Desk** at
`/desk`, an Advanced-mode page that presents one lending market — a lending
asset / collateral asset pair at a chosen duration — the way a trading
terminal presents an order book. Lender offers appear as asks (each lender's
minimum rate), borrower requests as bids (each borrower's maximum rate),
aggregated into a rate ladder with remaining sizes and cumulative depth,
with the quoted mid and spread in the header. An order ticket beside the
ladder posts limit-rate offers without leaving the page, with the
good-till-cancel / good-till-time expiry presets and the Partial / AON / IOC
fill modes the contracts already supported but no UI exposed. Tapping a
ladder row pre-fills the ticket; hitting the top of the book deep-links into
the existing guided accept flow. A tape panel shows the market's recent
executed fills (secondary-sale bookkeeping loans are excluded — a loan-sale
is not a fresh rate print), and bottom tabs show the wallet's open orders
and live positions with health-factor badges.

The open-orders tab ships the **first amend-in-place UI**: an unaccepted
offer's creator can change its rate, size, or collateral in a single
transaction (the contracts' offer-modification surface from issue #193,
until now reachable only by cancelling and re-creating). Amends that grow
the escrowed amount surface an approval precheck first, since that path has
no signature-approval variant. Held-but-not-created offer positions render
read-only, matching what the contracts authorize.

The indexer gains the small read surface the desk needs: a market-discovery
endpoint listing every pair-and-duration market with live offers (the
desk's pair chips derive from it), market filters on the recent-loans and
active-offers feeds so a market's tape and book fallback never depend on a
capped global page, and sale-vehicle markers recorded at ingest. Markets are
deliberately ERC-20-on-both-legs only — NFT and rental offers stay on the
Offers page, since token identity cannot be merged into a fungible ladder.

Design source: `docs/DesignsAndPlans/ProRateTerminalDesign.md` (ratified,
PR #1128). Closes #1129. Follow-ups: phase 2 (executed-rate chart + History
tab, #1130) and phase 3 (push-invalidation keys, crossable-band preview,
signed-offer book, #1131); the desk's live-review driver lands with the
post-deploy review per the DoD.
