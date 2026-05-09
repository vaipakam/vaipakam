/**
 * T-042 Phase 2 — display formatters per knob unit.
 *
 * Converts the raw on-chain value (bigint / boolean / hex string)
 * into the human-readable representation rendered on the dashboard
 * card.
 *
 * Each formatter takes a `KnobReadValue` plus the knob's metadata
 * and returns a short formatted string. Cards also render the unit
 * label (e.g. " (5 min)") via `formatUnitHint` for context.
 */

import type { KnobMeta, KnobUnit } from './protocolConsoleKnobs';

export type RawValue = bigint | boolean | string | null;

/**
 * Format a raw knob value for primary display. "—" when the value
 * isn't loaded or doesn't apply.
 */
export function formatKnobValue(raw: RawValue, knob: KnobMeta): string {
  if (raw == null) return '—';

  switch (knob.unit) {
    case 'bool':
      return raw === true ? 'ENABLED' : raw === false ? 'DISABLED' : '—';
    case 'address':
      return typeof raw === 'string' ? shortenHex(raw) : '—';
    case 'bytes32':
      return typeof raw === 'string' ? shortenHex(raw) : '—';
    case 'bps':
      if (typeof raw !== 'bigint') return '—';
      return formatBps(raw);
    case 'seconds':
      if (typeof raw !== 'bigint') return '—';
      return formatSeconds(raw);
    case 'usd1e18':
      if (typeof raw !== 'bigint') return '—';
      return `$${formatTokens(raw, 18, 2)}`;
    case 'tokens1e18':
      if (typeof raw !== 'bigint') return '—';
      return formatTokens(raw, 18, 2);
    case 'wholeNumber':
      if (typeof raw !== 'bigint') return '—';
      return raw.toString();
    default:
      return '—';
  }
}

/**
 * Format a value for the secondary zone-bar tooltip / hint. Used
 * inline on the segmented bar to label each zone breakpoint
 * (`hardMin`, `safeMin`, etc.).
 */
export function formatBound(raw: bigint | string, unit: KnobUnit): string {
  if (typeof raw === 'string') {
    const n = BigInt(raw);
    return formatBound(n, unit);
  }
  switch (unit) {
    case 'bps':
      return formatBps(raw);
    case 'seconds':
      return formatSeconds(raw);
    case 'wholeNumber':
      return raw.toString();
    case 'usd1e18':
      return `$${formatTokens(raw, 18, 0)}`;
    case 'tokens1e18':
      return formatTokens(raw, 18, 0);
    case 'bool':
      return raw === 1n ? 'on' : 'off';
    default:
      return raw.toString();
  }
}

/** BPS → percent. 100 bp = 1%, 10000 bp = 100%. */
function formatBps(bps: bigint): string {
  // Show at most 2 decimal places.
  const integer = bps / 100n;
  const remainder = bps % 100n;
  if (remainder === 0n) return `${integer}%`;
  // Pad single-digit fractions to two digits for "1.05%" instead of "1.5%".
  const frac = remainder.toString().padStart(2, '0');
  return `${integer}.${frac}%`;
}

/** Seconds → "X min", "X h", "X d" depending on magnitude. */
function formatSeconds(s: bigint): string {
  if (s < 60n) return `${s} s`;
  if (s < 3600n) return `${s / 60n} min`;
  if (s < 86400n) return `${s / 3600n} h`;
  return `${s / 86400n} d`;
}

/** 1e18-scaled bigint → decimal string with given precision. */
function formatTokens(raw: bigint, decimals: number, precision: number): string {
  const base = 10n ** BigInt(decimals);
  const integer = raw / base;
  if (precision === 0) return integer.toString();
  const remainder = raw % base;
  const fracStr = remainder
    .toString()
    .padStart(decimals, '0')
    .slice(0, precision)
    .replace(/0+$/, '');
  if (fracStr.length === 0) return integer.toString();
  return `${integer}.${fracStr}`;
}

/** "0xABC…1234" — short form for addresses and bytes32 ids. */
function shortenHex(hex: string): string {
  if (hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * Compute the marker position (0..1) on the zone bar for the given
 * raw value, given the knob's hard min/max. Returns null when the
 * unit doesn't have a numeric range (bool / address / bytes32).
 */
export function knobValuePosition(raw: RawValue, knob: KnobMeta): number | null {
  if (!knob.hasNumericRange || typeof raw !== 'bigint') return null;
  const min = BigInt(knob.hardMin);
  const max = BigInt(knob.hardMax);
  if (max <= min) return null;
  const clamped = raw < min ? min : raw > max ? max : raw;
  // Convert the position to a number with reasonable precision via
  // scaling to 10000-bps before dividing.
  const numerator = (clamped - min) * 10000n;
  const denom = max - min;
  return Number(numerator / denom) / 10000;
}
