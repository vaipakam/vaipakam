/**
 * Display formatting — human units everywhere. Basic mode never shows
 * raw wei, raw bps, or unshortened addresses (spec: WebsiteReadme
 * "Key UX Requirements").
 */
import { formatUnits } from 'viem';

/** "1234.5678" → "1,234.56" (trims trailing zeros, max 6 sig decimals). */
export function formatTokenAmount(
  raw: bigint | string,
  decimals: number,
  maxFraction = 4,
): string {
  const value = typeof raw === 'string' ? BigInt(raw) : raw;
  const asString = formatUnits(value, decimals);
  const num = Number(asString);
  if (!Number.isFinite(num)) return asString;
  return num.toLocaleString('en-US', {
    maximumFractionDigits: maxFraction,
  });
}

/** 550 bps → "5.5%". */
export function formatBpsAsPercent(bps: number): string {
  const pct = bps / 100;
  return `${Number(pct.toFixed(2))}%`;
}

/** "0xE873…23Cb" */
export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatDurationDays(days: number): string {
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? '1 month' : `${days / 30} months`;
  return `${days} days`;
}

/** Unix-seconds → "12 Jun 2026". */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Days remaining until (startTime + durationDays), can be negative. */
export function daysRemaining(startTime: number, durationDays: number): number {
  const dueAt = startTime + durationDays * 86_400;
  return Math.ceil((dueAt - Date.now() / 1000) / 86_400);
}

/** Full-term simple interest, mirroring the protocol formula
 *  Interest = Principal × APR × days / (100 × 365) with bps rates. */
export function fullTermInterest(
  principal: bigint,
  rateBps: number,
  durationDays: number,
): bigint {
  return (
    (principal * BigInt(rateBps) * BigInt(durationDays)) / (10_000n * 365n)
  );
}
