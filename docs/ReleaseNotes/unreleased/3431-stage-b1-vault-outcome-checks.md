## Thread — vaults check outcomes, not identities (#3431, Stage B1 of #3379)

A vault no longer reads any registry or platform setting to decide where value may go. The treasury, the backstop vault, Seaport, the 1inch order protocol, the listing conduit and its key, and the price guard's address are fixed in the vault code when it is built. A treasury or backstop payout reaches only those, a listing approval only that conduit, and an order-taker approval only that order protocol. Changing any of them is new vault code, which waits the vault-code delay. The launch check now compares these with the platform's own settings and names any mismatch.

A vault now signs only orders it hashed itself. The platform hands the vault a listing's or a swap-to-repay order's terms, not a hash. The vault checks it is the seller or maker (or that the seller is its own listing escrow), checks the conduit key, and asks Seaport or the 1inch order protocol for the hash. Its contract signature then answers only that protocol, and the listing escrow answers only Seaport. Every teardown still withdraws the order.

A new `swapOut` lets a vault sell at most a stated amount through a swap adapter in one call and requires the recipient to receive at least a floor. The vault measures both balances around the call and closes the adapter's allowance before it returns. The plain transfer to a swap adapter is retired.

The backstop vault is now provisioned by the deploy itself, before the vault code, because the vault code fixes its address. The deploy records it as `backstopVault`. Design: `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` (Stage B1 build notes).

> Caveat: a listing's payment legs are not yet checked by the vault. They are bound to the owner's signed terms in Stage B3; until then the platform builds them and the marketplace zone checks them at fill.
> Caveat: a forced sale still moves the lot through the platform within the transaction; it moves onto `swapOut` once the vault reads the price guard (#3268).
> Caveat: the price guard address is zero in the vault code until the price guard (#3447) is built by the deploy.
