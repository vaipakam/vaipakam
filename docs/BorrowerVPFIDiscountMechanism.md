# Vaipakam - Technical Specification: Borrower VPFI Discount Mechanism

## 1. Objective

Allow borrowers to purchase VPFI directly from the protocol at a fixed early-stage rate and later move it into their personal escrow on their chosen lending chain. During loan acceptance, if the borrower has sufficient VPFI in escrow, the lending asset is liquid, and the user's platform-level consent is enabled, the borrower pays the full `0.1%` `Loan Initiation Fee` equivalent in VPFI up front. That VPFI is held by the protocol for the life of the loan. On a proper close, the borrower earns a time-weighted VPFI rebate based on how long they actually held each discount tier during the loan window; the unrewarded remainder goes to Treasury. On default or HF-based liquidation, the held VPFI is forfeited to Treasury with no rebate.

Under the current tokenomics model, the borrower-side `Loan Initiation Fee` discount is tiered based on the borrower's escrowed VPFI balance on the relevant lending chain:

| Tier   | Escrowed VPFI Balance      | Discount | Borrower Effective Initiation Fee |
| ------ | -------------------------- | -------: | --------------------------------: |
| Tier 1 | `>= 100` and `< 1,000`     |    `10%` |                           `0.09%` |
| Tier 2 | `>= 1,000` and `< 5,000`   |    `15%` |                          `0.085%` |
| Tier 3 | `>= 5,000` and `<= 20,000` |    `20%` |                           `0.08%` |
| Tier 4 | `> 20,000`                 |    `24%` |                          `0.076%` |

This creates strong on-chain utility for VPFI, simplifies early acquisition, and removes the old point-in-time gaming vector where a borrower could briefly top up VPFI only at acceptance time to capture a full discount.

## 2. Scope and Assumptions

- Fixed conversion rate: `1 VPFI = 0.001 ETH` (configurable later by admin).
- Fixed conversion rate for the early fixed-rate purchase program: `1 VPFI = 0.001 ETH` (configurable later by admin).
- VPFI held in escrow is treated as a special non-collateral asset for lending calculations. It does not count toward collateral value or liquidation calculations.
- Any VPFI held in the user's escrow is also considered staked for the escrow-based staking model described in `docs/TokenomicsTechSpec.md`.
- The discount is opt-in through a single platform-level user setting that allows escrowed VPFI to be used for fee discounts.
- In the frontend, that shared fee-discount consent should live in the connected app on `Dashboard`, not as a separate offer-level, loan-level, or `Buy VPFI`-page-only control.
- Offer-level or loan-level consent is not required once that shared platform-level setting is enabled.
- The discount applies only to liquid assets, determined by the existing `RiskFacet` / `OracleFacet` logic.
- For illiquid assets, the normal `0.1%` `Loan Initiation Fee` is charged in the loan asset with no discount.
- The borrower discount is tiered by escrowed VPFI balance on the relevant lending chain rather than being a single flat percentage.
- Under Phase 5, the tier table defines the rebate rate earned over time, not a reduced up-front fee. The full LIF is charged up front in VPFI when the VPFI path is used.
- VPFI purchase should be available from the borrower's preferred supported chain through a single user-facing `Buy VPFI` flow.
- Purchased VPFI should be delivered to the borrower's wallet on the same chain where the borrower chose to buy, not transferred automatically into escrow.
- If cross-chain routing, canonical-chain settlement, or bridge infrastructure is needed under the hood, that complexity should be abstracted by the purchase flow rather than requiring the user to manually switch chains before buying.
- If the purchase path settles through a Base-chain receiver, VPFI must be minted or released only after that receiver has actually received ETH. The minted/released VPFI amount must be based on actual received ETH, not a quoted or requested amount.
- After purchase, the borrower must explicitly initiate the transfer or deposit of VPFI from wallet to personal escrow, with the system facilitating that step in the UI.
- All existing Phase 1 lending, escrow, and treasury flows remain unchanged.
- The mechanism reuses the existing `EscrowFactory`, `Loan`, `VPFITokenFacet`, and `TreasuryFacet` logic.

## 3. User Flow

1. Borrower opens a dedicated `Buy VPFI` page from their preferred supported chain.
2. Borrower sends ETH to the protocol to buy VPFI at the fixed rate.
3. The purchased VPFI is delivered to the borrower's wallet on that same preferred chain.
4. The borrower explicitly transfers or deposits VPFI from wallet to personal escrow on that chain, with the system guiding and facilitating that action.
5. Borrower creates or accepts a loan offer.
6. At the moment of loan acceptance:
   - the system first checks whether the lending asset is marked as liquid
   - if liquid, the user's platform-level VPFI-discount consent is active, and sufficient VPFI exists in the borrower's escrow, the system sends `100%` of the requested lending asset to the borrower and deducts the full `0.1%` `Loan Initiation Fee` equivalent in VPFI from escrow into protocol custody
   - if the asset is illiquid or insufficient VPFI is present, the normal `0.1%` `Loan Initiation Fee` is charged in the loan asset
7. When the loan closes properly through normal repayment, borrower preclose, or refinance, the protocol computes the borrower's time-weighted average discount across the loan window and credits the borrower a VPFI rebate.
8. The borrower receives the rebate alongside the normal borrower claim. On default or HF-based liquidation, no rebate is credited.

## 4. Smart Contract Instructions

- Add logic to allow users to buy VPFI with ETH at the fixed rate from their preferred supported chain.
- Ensure the fixed-rate purchase delivers VPFI to the buyer's wallet on the same chain where the user chose to buy, not directly into escrow.
- If the implementation routes the purchase through canonical-chain liquidity, treasury, or OFT infrastructure, the user-facing flow should still remain a preferred-chain purchase flow rather than a manual chain-switch flow.
- Add global and per-wallet limits on the fixed-rate purchase to prevent abuse.
  - Required initial values under the current tokenomics model:
    - total cap of `2,300,000 VPFI`
    - per-wallet cap configurable by admin
  - Initial recommended per-wallet limit: `30,000 VPFI`
- Modify the loan acceptance flow to:
  - first determine if the lending asset is liquid using the existing `RiskFacet` / `OracleFacet`
  - verify that the borrower's platform-level VPFI-discount consent setting is enabled
  - snapshot the borrower's discount-accrual state at acceptance
  - if liquid, convert the loan amount to ETH equivalent using the Chainlink price feed
  - calculate the full `0.1%` `Loan Initiation Fee`
  - convert that full ETH-equivalent fee amount into the exact number of VPFI required at the fixed rate
  - check the borrower's escrow balance and, if sufficient, deduct the required VPFI into protocol custody for later rebate / treasury settlement
- Keep loan-funding semantics unchanged apart from the fee source: when the VPFI path succeeds, 100% of the requested lending asset is sent to the borrower and the fee is satisfied entirely in VPFI from escrow.
- Extend the escrow implementation to recognise VPFI as a supported token type for fee deduction, without treating it as collateral.
- Ensure escrow-held VPFI remains compatible with the unified escrow-based staking model and reward accounting.
- Add a function in `TreasuryFacet` to receive and record the incoming VPFI fee.

## 5. Storage Requirements

- Track the total VPFI already sold at the fixed rate, append-only in `LibVaipakam`.
- Store the global fixed-rate cap and per-wallet limit.
  - Initial values:
    - `2,300,000 VPFI` total
    - per-wallet cap configurable by admin
- Store or derive the borrower fee-discount tier from the escrowed VPFI balance on the relevant lending chain.
- Each loan using the VPFI LIF path must snapshot the borrower's discount-accrual state at loan acceptance.
- Track the VPFI held for the loan while it is live and the VPFI rebate claimable after proper settlement, keyed by loan ID.
- All storage changes must follow the existing append-only library pattern to maintain Diamond compatibility.

## 6. Events to Emit

- Emit an event when VPFI is purchased with ETH.
  - Include:
    - buyer address
    - VPFI amount
    - ETH amount
- Emit an event when the VPFI LIF path is selected and the full up-front VPFI amount is custody-held.
  - Include:
    - loan ID
    - borrower address
    - lending asset
    - VPFI amount held
- Emit an event when a borrower VPFI rebate is credited or forfeited.

## 7. Discount Calculation Logic

- Determine if the lending asset is liquid via `RiskFacet` / `OracleFacet`.
- If liquid:
  - use the Chainlink price feed to convert the loan amount into its ETH equivalent
  - calculate the full `0.1%` `Loan Initiation Fee`
  - convert that full ETH amount into the exact number of VPFI required using the fixed rate: `1 VPFI = 0.001 ETH`
- If the borrower's escrow holds at least this amount of VPFI, deduct it into protocol custody and apply the VPFI fee path.
- When this path succeeds, the borrower receives `100%` of the requested lending asset and pays the full up-front fee in VPFI from escrow.
- On proper close, compute `rebate = held VPFI * time-weighted average discount bps / 10000`.
- The borrower rebate is claimable by the borrower-side Vaipakam NFT holder with the ordinary borrower claim; the remainder is Treasury's share.
- On default or HF-based liquidation, `rebate = 0` and the full held VPFI goes to Treasury.
- If the asset is illiquid or the borrower has insufficient VPFI, fall back to the normal `0.1%` `Loan Initiation Fee` in the loan asset.

## 8. Security and Best Practices

- All new functions must be protected by reentrancy guards and the global pausable mechanism.
- Every public and external function must include complete NatSpec documentation.
- Reuse existing libraries such as `LibLoan`, `LibVaipakam`, `LibSettlement`, and `OracleFacet` wherever possible.
- Add comprehensive test coverage including new scenarios for:
  - fixed-rate buying from a user's preferred supported chain
  - delivery of purchased VPFI back to the user's wallet on that same preferred chain
  - receipt-based mint/release when the Base receiver receives ETH, including failed and partial receipt cases
  - liquid-asset borrower rebate application across every tier
  - time-weighted borrower rebate behavior for long-hold, partial-hold, last-minute top-up, and unstake-down cases
  - illiquid-asset fallback
  - default and HF-liquidation rebate forfeiture
  - normal repayment, preclose, and refinance rebate crediting
  - cap enforcement
- Ensure the fixed-rate buy can be disabled by the admin after the cap is reached or after a set time period.
- Do not introduce storage layout changes that could break existing Diamond storage.

## 9. Frontend Integration Instructions

- Add a dedicated `Buy VPFI` page that works from the user's preferred supported chain.
- Do not require the user to manually switch to the canonical chain in order to buy VPFI.
- If bridge or canonical-chain infrastructure is used behind the scenes, keep it abstracted from the primary user flow.
- Clearly guide the user to transfer or deposit VPFI from wallet into escrow on the relevant chain, and facilitate that transfer as an explicit user action rather than doing it automatically.
- Surface the shared platform-level fee-discount consent control in the connected app `Dashboard`, so users can enable or disable escrowed-VPFI fee usage independently of the purchase flow.
- Add clear entry points from the `Create Offer` and `Loan Details` pages to this dedicated purchase page.
- Show the exact amount of ETH required and the resulting VPFI that will be purchased.
- Display the borrower's current VPFI balance in escrow, the active discount tier implied by that balance, and whether they qualify for a discount, only for liquid assets.
- Explain clearly that escrow-held VPFI also counts as staked under the unified escrow-staking model.
- Provide user-friendly messaging explaining the fixed rate, the bridge step, the escrow-funding step, the tiered discount table, that a single platform-level VPFI-discount consent setting governs fee-discount usage, that this setting is managed from `Dashboard`, and that the VPFI path results in full lending-asset delivery to the borrower, full up-front VPFI LIF custody, and a time-weighted VPFI rebate on proper close.
- The `Offer Book` accept-review modal should explain that the borrower pays the full `0.1%` LIF up front in VPFI and earns the discount over the loan lifetime as a rebate.
- The `Create Offer` borrower-tip copy should frame the benefit as earning up to a `24%` VPFI rebate rather than paying a reduced up-front fee.
- The `Claim Center` should show a rebate line whenever a borrower claim includes a pending VPFI rebate.

## 10. Acceptance Criteria

- Borrowers can successfully purchase VPFI with ETH from the dedicated preferred-chain purchase page and receive it in wallet on that same chain.
- Borrowers can then explicitly move or deposit that VPFI from wallet into their personal escrow on that same chain.
- During loan acceptance, the system automatically checks liquidity status via the existing `RiskFacet` / `OracleFacet` logic, verifies the user's platform-level VPFI-discount consent, snapshots the user's discount-accrual state, uses the Chainlink price feed for ETH conversion, and when eligible deducts the exact VPFI amount corresponding to the full `0.1%` `Loan Initiation Fee` while sending `100%` of the requested lending asset to the borrower.
- Properly closed loans credit the borrower a time-weighted VPFI rebate; defaulted or HF-liquidated loans forfeit the held VPFI to Treasury.
- All global and per-wallet caps are enforced.
- The entire flow is atomic, gas-efficient, and fully transparent via events.
- Full test coverage and NatSpec compliance is achieved.

This specification is complete and incorporates the requirement that the VPFI fee path applies only to liquid assets, uses Chainlink price feeds for ETH conversion, applies the time-weighted borrower `Loan Initiation Fee` rebate model defined in `docs/TokenomicsTechSpec.md`, treats escrow-held VPFI as both fee-utility balance and staking balance, and routes VPFI acquisition through a dedicated preferred-chain purchase page that delivers VPFI into the user's wallet first and then supports an explicit user-initiated wallet-to-escrow deposit step for staking / discount usage.
