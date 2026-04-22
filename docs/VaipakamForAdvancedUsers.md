# 🔵 Vaipakam Protocol Guide: Advanced Mode

This guide is for experienced DeFi users, liquidity providers, and arbitrageurs. **Advanced Mode** provides higher information density and access to specialized protocol features.

## 1. Architectural Advantages

Vaipakam utilizes the **EIP-2535 Diamond Standard** for logic and **Isolated Per-User Escrows** for assets.

- **No Pooled Risk:** Your assets are stored in a unique UUPS proxy contract dedicated to your wallet. A vulnerability in one asset does not expose the entire protocol's TVL.
- **Gas Efficiency:** Escrow clones are deployed on-demand, minimizing overhead.

## 2. Risk Management & Health Factors (HF)

For liquid asset pairs (e.g., WBTC/USDC):

- **HF Calculation:** `(Collateral Value / Borrowed Amount)`.
- **Thresholds:** Loans must be initiated with an **HF ≥ 1.5**.
- **Liquidation:** If HF drops below **1.0**, the position is eligible for permissionless liquidation via 0x swap.
- **Slippage Protection:** Protocol-level 6% slippage cap. If a swap would exceed this, the system enters a **Fallback Period**.

## 3. Exit & Arbitrage Strategies

Advanced users can interact with the secondary market for loan positions:

### A. Loan Sales (Lender Early Withdrawal)

Lenders can exit positions before maturity by selling their **Lender NFT**.

- **Shortfall Coverage:** If the new lender requires a higher rate than the current loan, the seller must cover the difference.
- **Accrued Interest:** Typically forfeited to the treasury to incentivize holding to maturity.

### B. Refinancing

Borrowers can migrate debt to a more favorable offer without repaying the principal first.

- **Condition:** The new lender must accept the terms, and the original lender must be made economically whole.

### C. Offsetting (Option 3 Preclose)

A borrower can exit their debt by becoming a lender in a new, offsetting loan. This effectively "neutralizes" the position on the balance sheet.

## 4. Keeper & Third-Party Execution

In Advanced Mode, you can whitelist up to **5 external keeper addresses**.

- **Automated Maintenance:** Allow authorized bots to trigger partial repayments or collateral top-ups.
- **Safety First:** Liquidation and Defaults remain permissionless and do not require whitelisting.

## 5. Asset Liquidity Determination

The protocol enforces strict rules for "Liquid" status:

1. **Oracle:** Active Chainlink Price Feed on the local network.
2. **Volume:** >$1M 24h trading volume on recognized DEXs (Uniswap/Sushiswap).
   _Note: Assets liquid on Ethereum Mainnet but illiquid on an L2 must be transacted on Mainnet._

## 6. Advanced Collateral Management

- **Top-ups:** Add collateral to an active loan to prevent liquidation during volatility.
- **Partial Withdrawals:** Remove excess collateral as long as the Health Factor remains **≥ 1.5**.

## 7. Partial Lending/Borrowing

Offers can be configured for "Partial Acceptance." This allows a single large lender offer to be split across multiple smaller borrowers, or vice versa, maximizing capital utilization.

---

_Troubleshooting: Use the **Structured Logging** tool in the dashboard to export your transaction journey for technical support._

---

_Disclaimer: Interaction with Advanced Mode features involves higher risk. Ensure you understand the impact of slippage and oracle latency._
