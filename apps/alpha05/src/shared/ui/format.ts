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

/** Digit groups on a whole number written in base 10: "1234567" → "1,234,567". */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A token amount for reading (RB-FUNDS): digit groups, and the fraction
 * shortened to four places once there is a whole part, or to four
 * significant digits below one, cut toward zero and never rounded up.
 * `cut` says whether any digit was dropped, so the surface marks the figure
 * approximate and can still show the exact one (`formatUnits`). An amount
 * too small to show in that many places keeps its first four significant
 * digits however far right they sit, so it never reads as zero.
 */
export function formatFigure(amount: bigint, decimals: number): { text: string; cut: boolean } {
  const exact = formatUnits(amount, decimals);
  const negative = exact.startsWith('-');
  const [whole, frac = ''] = (negative ? exact.slice(1) : exact).split('.');
  let keep = frac.length;
  if (whole !== '0') keep = Math.min(frac.length, 4);
  else if (frac.length > 0) keep = Math.min(frac.length, frac.search(/[1-9]/) + 4);
  const shown = frac.slice(0, keep).replace(/0+$/, '');
  return { text: `${negative ? '-' : ''}${group(whole!)}${shown ? `.${shown}` : ''}`, cut: keep < frac.length };
}

/** A token amount with every digit (`formatUnits`) and digit groups on the
 *  whole part: for a figure the protocol acts on exactly as written, such as
 *  an approval. */
export function formatExact(amount: bigint, decimals: number): string {
  const exact = formatUnits(amount, decimals);
  const negative = exact.startsWith('-');
  const [whole, frac] = (negative ? exact.slice(1) : exact).split('.');
  return `${negative ? '-' : ''}${group(whole!)}${frac ? `.${frac}` : ''}`;
}

/** A token amount for reading in a sentence: `formatFigure` with "≈ " in
 *  front when digits were dropped. */
export function formatFigureText(amount: bigint, decimals: number): string {
  const f = formatFigure(amount, decimals);
  return f.cut ? `≈ ${f.text}` : f.text;
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
