/** Protocol minimum health factor (1.5) scaled to 1e18. */
export const MIN_HEALTH_FACTOR_1E18 = 15n * 10n ** 17n;

/** Liquidation threshold health factor (1.0) scaled to 1e18. */
export const LIQUIDATION_HEALTH_FACTOR_1E18 = 10n ** 18n;

/** Format on-chain HF (1e18-scaled) for Advanced panels. */
export function formatHealthFactor(hf18: bigint): string {
  const n = Number(hf18) / 1e18;
  if (!Number.isFinite(n)) return '—';
  return n % 1 === 0 ? n.toString() : n.toFixed(2).replace(/\.?0+$/, '');
}

/** Format on-chain LTV (basis points) as a percentage string. */
export function formatLtvBps(ltvBps: bigint): string {
  const n = Number(ltvBps) / 100;
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}

export function collateralLiquidityLabel(collateralAssetType: number): string {
  return collateralAssetType === 0
    ? 'Liquid (oracle + AMM checks when configured)'
    : 'Illiquid (NFT / no oracle)';
}

export function isHealthFactorAtRisk(hf18: bigint | null | undefined): boolean {
  if (hf18 == null || hf18 === 0n) return false;
  return hf18 < MIN_HEALTH_FACTOR_1E18;
}