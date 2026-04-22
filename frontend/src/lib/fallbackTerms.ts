export const FALLBACK_CONSENT_TITLE = "Abnormal-market & illiquid asset terms";

export const FALLBACK_CONSENT_BODY =
  "For Liquid Assets, If liquidation cannot execute safely — for example because slippage exceeds 6%, liquidity disappears, or the 0x swap reverts — the lender claims the collateral in collateral-asset form instead of receiving the lending asset. If collateral value has fallen below the amount due, the lender receives the full remaining collateral and nothing is left for the borrower. If collateral value is still above the amount due, the lender receives only the equivalent collateral amount and the remainder stays with the borrower after charges. The same fallback applies to loan with illiquid assets (both lending asset and / or collateral asset) on default — the lender takes the full collateral in-kind (in collateral asset as it is). Proceeding confirms you agree to these terms.";

export const FALLBACK_CONSENT_CHECKBOX_LABEL =
  "I have read and agree to the abnormal-market & illiquid asset terms.";
