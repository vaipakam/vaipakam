import { formatUnits } from 'viem';
import i18n from '../i18n';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Active locale snapshot at call time. Falls back to `'en'` when
 * i18next hasn't yet resolved a language. Format helpers below pull
 * this on every invocation so that components which re-render on
 * language change automatically pick up the locale-correct output —
 * no per-call `useTranslation()` plumbing required.
 *
 * Note: format functions stay pure (no React hooks). When the active
 * locale changes, the surrounding component re-renders (because it
 * almost always consumes `useTranslation()` for `t()` calls), and
 * the next invocation of these helpers reads the new locale.
 */
function activeLocale(): string {
  return i18n.resolvedLanguage ?? 'en';
}

export function shortenAddr(addr: string): string {
  if (!addr) return '';
  if (addr.toLowerCase() === ZERO_ADDRESS) return 'Native';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Format a basis-points value as a percentage string, locale-aware.
 *   en: `5.00%` (NBSP between number and `%` per CLDR for some locales)
 *   fr: `5,00 %`
 *   de: `5,00 %`
 *   ar: `5٫00٪` (Arabic-Indic decimal separator + percent sign)
 */
export function bpsToPercent(bps: bigint | number, digits = 2): string {
  const n = typeof bps === 'bigint' ? Number(bps) : bps;
  return new Intl.NumberFormat(activeLocale(), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n / 10000);
}

/** Locale-aware decimal separator (looked up via `formatToParts`).
 *  Used by helpers below that need to splice a pre-computed fraction
 *  into a locale-grouped integer. */
function decimalSeparator(locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
  return parts.find((p) => p.type === 'decimal')?.value ?? '.';
}

/**
 * Human-readable token amount. Trims trailing zeros, keeps up to `maxFrac`
 * fractional digits, and group-separates the integer part using the
 * active locale's grouping convention (`1,000` in en-US, `1.000` in
 * de-DE, `1 000` in fr-FR, `1٬000` in ar). Works for any decimals
 * (defaults to 18 — the common ERC-20 case).
 */
export function formatUnitsPretty(
  amount: bigint,
  decimals = 18,
  maxFrac = 4,
): string {
  const lng = activeLocale();
  if (amount === 0n) return new Intl.NumberFormat(lng).format(0);
  const raw = formatUnits(amount, decimals);
  const [whole, frac = ''] = raw.split('.');
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  // BigInt input is supported by Intl.NumberFormat on every engine
  // we target. We use BigInt(whole) to avoid silently losing
  // precision on amounts > Number.MAX_SAFE_INTEGER.
  let wholeBig: bigint;
  try {
    wholeBig = BigInt(whole);
  } catch {
    wholeBig = 0n;
  }
  const wholeFmt = new Intl.NumberFormat(lng).format(wholeBig);
  if (!trimmed) return wholeFmt;
  return `${wholeFmt}${decimalSeparator(lng)}${trimmed}`;
}

/**
 * Format an arbitrary number with locale-aware grouping + decimal
 * separator. Wraps `Intl.NumberFormat` so call sites don't have to
 * plumb the active locale themselves.
 */
export function formatNumber(
  n: number | bigint,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(activeLocale(), options).format(n);
}

/**
 * Format a fractional `value` (0..1 range) as a percentage string.
 *   formatPercent(0.05)        → "5%"
 *   formatPercent(0.05, 2)     → "5.00%" (en) / "5,00 %" (fr)
 *
 * Use this for already-fractional inputs (HF deltas, share-of-supply,
 * APR as a fraction). For BPS use `bpsToPercent`.
 */
export function formatPercent(value: number, digits = 0): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Format a USD amount as locale-aware currency.
 *   en: "$1,000.00"
 *   fr: "1 000,00 $"
 *   ja: "$1,000.00" (ja conventionally keeps the dollar sign)
 */
export function formatUsd(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  }).format(value);
}

/**
 * Compact-notation number formatter for stat cards / charts.
 *   1234 → "1.2K" (en) / "1,2 k" (fr) / "1234" (small numbers under 1k)
 *   1234567 → "1.2M"
 */
export function formatCompact(n: number, digits = 1): string {
  return new Intl.NumberFormat(activeLocale(), {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(n);
}

/**
 * Locale-aware date formatting. Default style is "short" (numeric
 * year-month-day in the user's locale conventions).
 *   en: "4/27/2026"
 *   fr: "27/04/2026"
 *   ja: "2026/4/27"
 */
export function formatDate(
  date: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat(activeLocale(), options).format(d);
}

/**
 * Locale-aware time-of-day formatting.
 *   en: "2:30:45 PM"
 *   fr: "14:30:45"
 *   ja: "14:30:45"
 */
export function formatTime(
  date: Date | number,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'medium' },
): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat(activeLocale(), options).format(d);
}

/**
 * Locale-aware combined date+time.
 *   en: "Apr 27, 2026, 2:30 PM"
 *   fr: "27 avr. 2026, 14:30"
 */
export function formatDateTime(
  date: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat(activeLocale(), options).format(d);
}

/**
 * Locale-aware relative-time string. Picks the largest meaningful
 * unit (seconds → minutes → hours → days → weeks → months → years)
 * and formats accordingly.
 *   en: "2 days ago", "in 3 hours"
 *   fr: "il y a 2 jours", "dans 3 heures"
 *   ja: "2 日前", "3 時間後"
 *
 * Use for activity feeds, "loaded N seconds ago" indicators,
 * "expires in" countdowns where second-resolution doesn't matter.
 */
export function formatRelativeTime(
  fromDate: Date | number,
  toDate: Date | number = Date.now(),
): string {
  const from = typeof fromDate === 'number' ? fromDate : fromDate.getTime();
  const to = typeof toDate === 'number' ? toDate : toDate.getTime();
  const diffSec = Math.round((from - to) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(diffSec, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 604_800) return rtf.format(Math.round(diffSec / 86_400), 'day');
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 604_800), 'week');
  if (abs < 31_536_000) return rtf.format(Math.round(diffSec / 2_592_000), 'month');
  return rtf.format(Math.round(diffSec / 31_536_000), 'year');
}

/**
 * Format a duration in seconds as a compact "Xd Yh" / "Xh Ym" /
 * "Xm Ys" string using the active locale's narrow unit-format
 * convention. Used by the lender-discount-card "Window elapsed"
 * indicator and similar.
 *
 * Falls back to a compact `Nd Mh` style for locales where
 * `Intl.NumberFormat` doesn't support the `unit` style (very few in
 * practice today — Safari < 14.1).
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0s';
  const lng = activeLocale();
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  // Compact: pick the two largest non-zero units, join with a
  // narrow no-break space. Skip Intl.NumberFormat unit style here
  // since the unit names ("day", "hour") are localised but verbose;
  // the existing UI uses the abbreviated form ("d", "h", "m", "s").
  if (days > 0) {
    parts.push(`${formatNumber(days)}d`);
    if (hours > 0) parts.push(`${formatNumber(hours)}h`);
    return parts.join(' ');
  }
  if (hours > 0) {
    parts.push(`${formatNumber(hours)}h`);
    if (minutes > 0) parts.push(`${formatNumber(minutes)}m`);
    return parts.join(' ');
  }
  if (minutes > 0) {
    parts.push(`${formatNumber(minutes)}m`);
    if (seconds > 0) parts.push(`${formatNumber(seconds)}s`);
    return parts.join(' ');
  }
  return `${formatNumber(seconds)}s`;
  // Note: the `lng` const is unused in this fallback because the
  // unit suffixes are intentionally English single-letter glyphs
  // matched to the existing UI. Future iteration can promote them
  // to `Intl.NumberFormat({ style: 'unit', unit: 'day' })` if the
  // longer localised form proves more readable in CJK / Indic
  // locales — at which point the suffix becomes locale-derived.
  void lng;
}
