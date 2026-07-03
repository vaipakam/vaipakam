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

/** Label collateral liquidity from indexer classification (preferred) or asset type fallback. */
export function collateralLiquidityLabel(
  collateralLiquidity: number | undefined,
  collateralAssetType?: number,
): string {
  if (collateralLiquidity === 0) return 'Liquid (oracle + AMM checks when configured)';
  if (collateralLiquidity === 1) return 'Illiquid (no oracle / AMM gate)';
  if (collateralAssetType === 0) return 'Liquid (ERC-20; liquidity not indexed)';
  if (collateralAssetType != null && collateralAssetType !== 0) {
    return 'Illiquid (NFT / no oracle)';
  }
  return 'Unknown';
}

export function isHealthFactorAtRisk(
  hf18: bigint | null | undefined,
  minHf1e18: bigint = MIN_HEALTH_FACTOR_1E18,
): boolean {
  if (hf18 == null || hf18 === 0n) return false;
  return hf18 < minHf1e18;
}