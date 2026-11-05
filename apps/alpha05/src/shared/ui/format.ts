/** Display helpers with one rule each, shared by every surface. */

/** An age in seconds as a short duration: "12 s", "4 min", "2 h 5 min". */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** `0x1234…abcd`: the first six and last four characters of an address. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A token amount from its base units, with the asset's decimals, trimmed
 *  of trailing zeros and never rounded up. Group separators are left to the
 *  reader's locale by the caller; this is the exact figure. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A rate in basis points as a percentage, exact: 500 → "5", 525 → "5.25". */
export function formatBps(bps: bigint): string {
  return formatUnits(bps, 2);
}

/** A 1e18-scaled figure (a health factor, a numeraire value) cut to
 *  `places` decimals, never rounded up, with digit groups: 1234.5678e18 →
 *  "1,234.56". A summary figure; exact figures use `formatUnits`. */
export function formatScaled(value: bigint, places = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** 18n;
  const whole = (abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = ((abs % unit) / 10n ** BigInt(18 - places)).toString().padStart(places, '0');
  return `${negative ? '-' : ''}${whole}${places > 0 ? `.${frac}` : ''}`;
}

/** A span of time ahead or behind, coarse: whole days from two days up,
 *  otherwise hours and minutes as `formatAge` writes them. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 2 * 86_400) return `${Math.floor(s / 86_400)} days`;
  return formatAge(s);
}

/** A moment as a date and time in UTC, in the reader's language, always
 *  labelled UTC so it is never read as local time. */
export function formatUtc(unixSeconds: number, locale?: string): string {
  const d = new Date(unixSeconds * 1000);
  const text = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d);
  return `${text} UTC`;
}
