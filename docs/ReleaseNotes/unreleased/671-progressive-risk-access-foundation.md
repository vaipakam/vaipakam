## Thread — Progressive risk access: per-vault tiers + create-time gate (PR #<n>)

Foundation for #671. Every vault now carries a **risk-access tier** — a
self-chosen ceiling on how risky the assets it transacts may be. There are
three tiers: **BlueChipOnly** (the zero-init default for every vault),
**BroadLiquid**, and **IlliquidCustom**. A vault opts UP a tier itself — never
by accident and never by an admin allow-list — either directly from its own
wallet or via a gasless EIP-712 signature a relayer can forward (so a
smart-contract wallet can opt up too). Lowering a tier is always immediate;
raising one is subject to an optional opt-up cooldown (default zero).

The tier a given offer requires is **derived entirely on-chain** from the same
liquidity-depth machinery the LTV/health-factor system already uses — there is
no governance list of "approved assets". An asset is treated as blue-chip if it
is the numeraire basket (WETH or one of the configured quote assets) or if it
independently earns the deepest on-chain liquidity tier; a merely-liquid asset
just needs the vault opted up to BroadLiquid (no per-pair step — the quantitative
LTV/health-factor check still applies); an illiquid or unpriced asset needs
explicit per-pair consent. The riskier of an offer's two legs governs, and an
NFT rental is classified off the value-bearing prepayment token rather than the
rented NFT. The whole surface re-locks itself with zero writes when governance
bumps a global terms version: a tier or consent only counts while its
per-vault version anchor is still current.

The gate is enforced at the **offer-creation chokepoint** that every create
path shares, so an under-tiered creator's offer is refused before it is posted.
The protocol-authored lender-sale-vehicle offer is exempt, since its risk belongs
to the exiting lender and was already gated at the original loan. An
offset/obligation-transfer offer is NOT exempt — it forms a new position for the
initiating user, so it is gated on that user's tier like any other create. The entire feature is behind an off-by-default
master kill-switch (`setRiskAccessGateEnabled`), exactly like the depth-tiered-LTV
rollout: a fresh deploy behaves identically to before, and each chain flips the
gate on only after its own liquidity census.

This is the first of several #671 PRs. Still to come: re-asserting the tier at the
accept / keeper-match / refinance / obligation-transfer paths (self-imposed strict
mode), and the frontend wiring. Part of #671 (does not close it).
