# 🛡️ Vaipakam: The Complete Protocol Guide

This document is the master reference for all Vaipakam users, covering everything from basic borrowing to advanced portfolio management.

---

## I. Core Concepts

Vaipakam is a **Peer-to-Peer (P2P)** protocol. Unlike pooled-liquidity systems, you are interacting directly with another user's offer.

### 1. Isolated Security

Your assets are never mixed with other users' funds. Every user has a unique **Isolated Escrow** vault. This ensures that a problem with one asset or user doesn't affect the rest of the protocol.

### 2. NFT-Based Positions

All loans and rentals are represented by an NFT. Whoever holds the NFT holds the rights.

- **Lender NFT:** Entitles the holder to principal + interest.
- **Borrower NFT:** Entitles the holder to the underlying collateral after repayment.

---

## II. User Roles & Procedures

### 1. The Borrower (ERC-20 Loans)

- **Initiation:** Accept a Lender's offer or create your own Borrower offer.
- **Collateral Management:** You can "Top-up" (add) collateral to a live loan to improve your **Health Factor (HF)**.
- **Withdrawal:** If your collateral value goes up, you can withdraw the excess as long as your HF stays above 1.5.
- **Repayment:** Can be done by anyone, but only the Borrower NFT holder can claim the collateral.

### 2. The Lender (ERC-20 Loans)

- **Income:** You earn interest set by the offer.
- **Early Exit:** You can sell your loan to another lender (Option 1) or create a "Borrower-style" offer to find a buyer (Option 2). Note: Accrued interest is typically forfeited to the treasury when exiting early.

### 3. The NFT Renter

- **Rights:** You receive ERC-4907 "User Rights." This allows you to use the NFT (in a game/metaverse) while the owner keeps the actual token in escrow.
- **Fees:** Rental fees are deducted daily. If you run out of prepaid funds, the rental defaults.

---

## III. Risk & Liquidation

### 1. Liquid Assets (Oracles & DEXs)

Assets like ETH or WBTC are tracked by **Chainlink Oracles**.

- **Liquidation:** If your Health Factor falls below 1.0, your collateral is sold via the configured on-chain swap-aggregator proxy to pay the lender.
- **Slippage Protection:** If a market crash is too fast (slippage > 6%), the system enters a **Fallback Period**. The lender can then claim a specific "Equivalent Amount" of collateral instead of the swap.

### 2. Illiquid Assets (NFTs & Small Tokens)

These have a platform value of **$0**.

- **Defaults:** There is no "selling" of these assets. If the loan isn't paid, the **entire collateral** is transferred to the lender.

---

## IV. Advanced Procedures

### 1. Refinancing (ERC-20 Only)

Switch your loan to a new lender without paying it off first. This is useful if interest rates drop. The original lender is always "made whole" (paid their expected earnings) during this switch.

### 2. Offsetting (Option 3 Preclose)

Instead of paying back a loan, you can become a lender in a _new_ loan that covers your old debt. This "neutralizes" your position.

### 3. Keeper Whitelisting

Advanced users can authorize up to **5 automated "Keepers"** (bot addresses). These Keepers can perform specific actions like adding collateral or partial repayments on your behalf to keep your loans healthy.

---

## V. Compliance (KYC)

Based on the total USD value of the transaction:
| Tier | Value | Requirement |
| :--- | :--- | :--- |
| **Tier 0** | < $1,000 | No Verification |
| **Tier 1** | $1,000 - $10,000 | Basic Identity Verification |
| **Tier 2** | > $10,000 | Full Identity & AML Verification |

---

## VI. Troubleshooting

If a transaction fails, check the **Dashboard Diagnostics**:

1.  **Wallet Connection:** Ensure your wallet is on the correct network (Ethereum, Polygon, or Arbitrum).
2.  **Asset Status:** Is the token "Liquid" on your current network? If not, the transaction may be blocked.
3.  **NFT Ownership:** Do you still hold the Vaipakam NFT required for this action?
4.  **KYC Status:** Does the transaction value exceed your current verification tier?

---

_For technical support, export your **Structured Logs** from the dashboard and share them with the Vaipakam team._

---

_Vaipakam Protocol Phase 1. Developed with EIP-2535 Diamond Standards._
