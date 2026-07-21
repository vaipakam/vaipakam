/**
 * Display formatting — human units everywhere. Basic mode never shows
 * raw wei, raw bps, or unshortened addresses (spec: WebsiteReadme
 * "Key UX Requirements").
 */
import { formatUnits } from 'viem';
import i18n from '../i18n';
import { copy } from '../content/copy';

/** Human display of a token amount. Small-but-nonzero values keep
 *  enough significant digits that real money never renders as "0"
 *  (a 0.00004 WBTC claim is ~$4 — it must not display as zero). */
export function formatTokenAmount(
  raw: bigint | string,
  decimals: number,
  maxFraction = 4,
): string {
  const value = typeof raw === 'string' ? BigInt(raw) : raw;
  const asString = formatUnits(value, decimals);
  const num = Number(asString);
  if (!Number.isFinite(num)) return asString;
  if (num !== 0 && Math.abs(num) < 1) {
    return num.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  }
  return num.toLocaleString('en-US', {
    maximumFractionDigits: maxFraction,
  });
}

/** LOSSLESS decimal string for pre-filling inputs (Max buttons).
 *  Never round-trips through Number — 18-decimal balances lose
 *  precision past ~15 significant digits and can round UP above the
 *  true balance, tripping over-max guards. */
export function exactAmountString(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
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

/** Human duration, locale-aware. Reads the unit words (day/month/year,
 *  singular/plural) from the copy catalog so every locale renders its
 *  own — the English one/other forms reproduce the previous hardcoded
 *  output exactly. Whole-year and whole-month spans collapse to those
 *  units; everything else counts in days. */
export function formatDurationDays(days: number): string {
  if (days < 30) return copy.units.durationDay(days);
  if (days % 365 === 0) return copy.units.durationYear(days / 365);
  if (days % 30 === 0) return copy.units.durationMonth(days / 30);
  return copy.units.durationDay(days);
}

/** Unix-seconds → localized date ("12 Jun 2026" / "2026年6月12日" / …).
 *  Uses the active UI language so the month name and ordering match
 *  the rest of the surface; falls back to en-US before i18next is
 *  ready. */
export function formatDate(unixSeconds: number): string {
  const locale = i18n.isInitialized && i18n.language ? i18n.language : 'en-US';
  return new Date(unixSeconds * 1000).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Unix-seconds → compact relative age ("2m ago", "3h ago", "5d ago").
 *  Used by the Rate Desk tape; clamps future/clock-skew to "just now". */
export function formatTimeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return copy.units.timeJustNow;
  if (diff < 3_600) return copy.units.timeMinutesAgo(Math.floor(diff / 60));
  if (diff < 86_400) return copy.units.timeHoursAgo(Math.floor(diff / 3_600));
  if (diff < 30 * 86_400) return copy.units.timeDaysAgo(Math.floor(diff / 86_400));
  return formatDate(unixSeconds);
}

/** Days remaining until (startTime + durationDays). Negative the
 *  moment the due time passes — Math.floor, NOT ceil: ceil returns -0
 *  for the first 24h past due (and -0 < 0 is false), which showed
 *  overdue — even already-defaultable — loans as "Due today". */
export function daysRemaining(startTime: number, durationDays: number): number {
  const dueAt = startTime + durationDays * 86_400;
  const diff = dueAt - Date.now() / 1000;
  if (diff < 0) return Math.min(-1, Math.ceil(diff / 86_400));
  return Math.floor(diff / 86_400);
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
