const CLASSIC_ORIGIN = 'https://defi.vaipakam.com';

export const DEFI_CLASSIC_LINKS = {
  home: CLASSIC_ORIGIN,
  loan: (loanId: number | string) => `${CLASSIC_ORIGIN}/loans/${loanId}`,
  keepers: `${CLASSIC_ORIGIN}/keepers`,
  riskAccess: `${CLASSIC_ORIGIN}/risk-access`,
  allowances: `${CLASSIC_ORIGIN}/allowances`,
  analytics: `${CLASSIC_ORIGIN}/analytics`,
  nftVerifier: `${CLASSIC_ORIGIN}/nft-verifier`,
  vault: `${CLASSIC_ORIGIN}/vault`,
} as const;