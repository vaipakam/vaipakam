## Thread — RiskFacet split to clear the EIP-170 contract-size limit (PR #68)

A deploy attempt against a local anvil node surfaced a blocker: the
`RiskFacet` contract had grown 541 bytes past the 24,576-byte limit the
EVM enforces on any contract's deployed code. Past that limit a contract
simply cannot be deployed — so the protocol's diamond could not be stood
up on anvil, a testnet, or mainnet. The breach had gone unnoticed
because the test runner does not enforce the deploy-size rule the way a
real deployment does; only an actual broadcast deploy reveals it.

`RiskFacet` was carrying three loosely-related bodies of work — risk
maths, the regular health-factor liquidation path, and the newer
"internal match" liquidation path that settles two opposing loans
against each other. The internal-match path was self-contained, so it
was lifted out wholesale into a new `RiskMatchLiquidationFacet`. This is
a pure relocation — no behaviour changed; the same functions run the
same way, just hosted by a second facet of the same diamond. With that
weight removed, `RiskFacet` dropped to a comfortable margin under the
limit, and the new facet sits well within it too.

To stop this class of problem from recurring silently, the change also
adds a guardrail test that measures every facet's compiled size and
fails if any one is over the limit — so a future over-size facet is
caught in the normal test run instead of at deploy time.

A proactive follow-up — the `OfferFacet` contract is close to the same
limit though not yet over it — is tracked separately so it can get its
own focused review.

Closes #66.
