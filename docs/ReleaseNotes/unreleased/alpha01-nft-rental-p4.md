# Alpha01 P4 — NFT rental wizards (N1 / N2)

## Summary

Replaces the `/rent` stub with full Basic-mode NFT rental flows inside `alpha01.vaipakam.com`, backed by new `defi-client` rental modules.

## User-visible changes

- **List NFT (N1):** Owners can post ERC-721 / ERC-1155 rental listings with daily fee, prepay token, and duration; review receipt explains vault custody and temporary renter rights.
- **Browse & rent (N2):** Renters browse indexer listings, see total prepay (fees + buffer), and accept with the shared eligibility + receipt pattern.
- **Post request (PF-044):** When no listing fits, renters can post a demand offer that locks prepay + buffer at create time.
- **Positions:** Rental rows and detail pages use rental vocabulary (renter / NFT owner, close rental, claim fees and NFT) instead of debt-loan copy.

## Technical

- `packages/defi-client`: rental prepay math, NFT rental offer payloads, NFT approval helper, accept/create flows, indexer filters.
- Daily fees scale with prepay-token `decimals()` (fixes the raw-integer footgun in legacy defi NFT rental forms).

## Verification

- `pnpm --filter @vaipakam/alpha01 test`
- `pnpm --filter @vaipakam/alpha01 exec tsc -b --noEmit`