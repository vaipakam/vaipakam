## Thread — A rental carries no collateral (PR #2964)

An NFT-rental offer can no longer name a collateral. The platform refuses one
whose collateral asset, amount, upper amount, token id or quantity is set, and
it refuses an edit that would give an existing rental offer one. A rental is
secured by its prepayment in the rental's payment token and by the rented NFT
staying in the lender's vault, so a collateral on a rental moved nothing.
Before this change it still had effects: the renter could be asked to
acknowledge it as an illiquid collateral, the risk-access check classified it,
and interfaces showed a "collateral" that was not one.

With no collateral there is nothing to price on that side, and every path that
can reach a rental now treats it that way. Creating or accepting a rental no
longer reads a collateral price; the rental records its collateral side as
illiquid, the class a rental is already in. The renter is never asked to
acknowledge a collateral asset. The risk-access check judges a rental on its
prepayment token alone. A transaction value used for a KYC comparison counts
an empty side as worth nothing, without a price read. Handing a rental over
to a replacement renter returns and checks no collateral. Range matching runs
no loan-to-value check on a rental, as a direct acceptance never did. Adding
collateral to a rental is refused, by name.

This is a fresh-deploy-only shape change. Closes #2949. Two older display and
preview gaps found during the audit are tracked separately: #2956 (range
matching refuses a consented illiquid token pair when depth-tiered limits are
on) and #2957 (position NFT metadata misstates a rental's kind and claim
scale).
