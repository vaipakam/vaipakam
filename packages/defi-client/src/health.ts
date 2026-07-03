/** Plain-language health labels for Basic mode (HF scaled 1e18). */
export function plainHealthLabel(healthFactor: bigint | null | undefined): {
  label: string;
  tone: 'ok' | 'warn' | 'risk';
  detail: string;
} {
  if (healthFactor == null || healthFactor === 0n) {
    return {
      label: 'Status unknown',
      tone: 'warn',
      detail: 'Health data is still loading or unavailable for this loan.',
    };
  }
  const minHealthy = 15n * 10n ** 17n; // 1.5e18
  const liquidation = 10n ** 18n; // 1e18
  if (healthFactor >= minHealthy) {
    return {
      label: 'Healthy',
      tone: 'ok',
      detail: 'Your collateral currently covers the loan with comfortable margin.',
    };
  }
  if (healthFactor >= liquidation) {
    return {
      label: 'Needs attention',
      tone: 'warn',
      detail: 'Collateral value is getting closer to the safety limit. Consider repaying or adding collateral.',
    };
  }
  return {
    label: 'At risk',
    tone: 'risk',
    detail: 'Collateral may not be enough to keep the loan safe. Repay or add collateral soon.',
  };
}

export function borrowerPrimaryAction(opts: {
  role: 'borrower' | 'lender' | 'other';
  loanStatus: string;
  healthTone: 'ok' | 'warn' | 'risk';
  /** When set for terminal borrower claim paths, gates the CTA on on-chain claimability. */
  borrowerClaimable?: boolean;
  /** NFT rental positions use close-rental copy instead of debt-loan repay. */
  isRental?: boolean;
}): { action: 'repay' | 'claim-collateral' | 'claim-lender' | 'add-collateral' | 'none'; label: string } {
  const rental = opts.isRental === true;
  if (opts.role === 'borrower') {
    if (opts.loanStatus === 'repaid') {
      return {
        action: 'claim-collateral',
        label: rental ? 'Claim unused prepay' : 'Claim collateral',
      };
    }
    if (
      opts.loanStatus === 'internal_matched' ||
      opts.loanStatus === 'defaulted' ||
      opts.loanStatus === 'liquidated'
    ) {
      if (opts.borrowerClaimable) {
        return { action: 'claim-collateral', label: 'Claim collateral' };
      }
      return { action: 'none', label: 'No action available' };
    }
    if (opts.loanStatus === 'active') {
      if (rental) {
        return { action: 'repay', label: 'Close rental early' };
      }
      if (opts.healthTone === 'risk' || opts.healthTone === 'warn') {
        return { action: 'repay', label: 'Repay now' };
      }
      return { action: 'repay', label: 'Repay loan' };
    }
  }
  if (opts.role === 'lender') {
    if (
      opts.loanStatus === 'repaid' ||
      opts.loanStatus === 'defaulted' ||
      opts.loanStatus === 'liquidated' ||
      opts.loanStatus === 'fallback_pending' ||
      opts.loanStatus === 'internal_matched'
    ) {
      return {
        action: 'claim-lender',
        label: rental ? 'Claim fees and NFT' : 'Claim lender proceeds',
      };
    }
  }
  return { action: 'none', label: 'No action available' };
}