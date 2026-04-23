import { formatUnits } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function shortenAddr(addr: string): string {
  if (!addr) return '';
  if (addr.toLowerCase() === ZERO_ADDRESS) return 'Native';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function bpsToPercent(bps: bigint | number, digits = 2): string {
  const n = typeof bps === 'bigint' ? Number(bps) : bps;
  return `${(n / 100).toFixed(digits)}%`;
}

/**
 * Human-readable token amount. Trims trailing zeros, keeps up to `maxFrac`
 * fractional digits, and group-separates the integer part. Works for any
 * decimals (defaults to 18 — the common ERC-20 case).
 */
export function formatUnitsPretty(
  amount: bigint,
  decimals = 18,
  maxFrac = 4,
): string {
  if (amount === 0n) return '0';
  const raw = formatUnits(amount, decimals);
  const [whole, frac = ''] = raw.split('.');
  const wholeFmt = Number(whole).toLocaleString('en-US');
  if (!frac) return wholeFmt;
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  return trimmed ? `${wholeFmt}.${trimmed}` : wholeFmt;
}
