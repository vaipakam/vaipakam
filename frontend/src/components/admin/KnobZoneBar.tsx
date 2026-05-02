/**
 * T-042 Phase 2 — segmented zone bar for a numeric knob.
 *
 * Renders the knob's hard bound `[hardMin, hardMax]` as a horizontal
 * track split into three coloured regions:
 *   - red    (caution): hardMin..midMin   AND  midMax..hardMax
 *   - amber  (mid):     midMin..safeMin   AND  safeMax..midMax
 *   - green  (safe):    safeMin..safeMax
 *
 * A vertical marker on top shows the current value's position along
 * the bar. The marker takes the colour of the zone it sits in so the
 * card communicates a status at a glance even without reading the
 * numeric value.
 *
 * The component is unit-aware (via the knob's `unit` field): tooltip
 * labels under each breakpoint use the right human-readable suffix
 * (e.g. "5%" for bps, "5 min" for seconds).
 *
 * For non-numeric knobs (bool / address / bytes32) the dashboard
 * renders a different component — this one returns `null` if asked
 * to render a non-numeric knob (defensive guard).
 */

import type { KnobMeta } from '../../lib/adminKnobsZones';
import {
  formatBound,
  knobValuePosition,
  type RawValue,
} from '../../lib/adminKnobFormat';

interface Props {
  knob: KnobMeta;
  value: RawValue;
}

export function KnobZoneBar({ knob, value }: Props) {
  if (!knob.hasNumericRange) return null;

  const hardMin = BigInt(knob.hardMin);
  const hardMax = BigInt(knob.hardMax);
  if (hardMax <= hardMin) return null;

  // Compute zone widths as fractions of the total hard range. All
  // arithmetic in bigint to keep precision; convert to Number only
  // at the CSS-percent boundary.
  const range = hardMax - hardMin;
  const pct = (n: bigint, d: bigint): number => {
    if (d === 0n) return 0;
    return Number((n * 10000n) / d) / 100;
  };

  const safeMin = BigInt(knob.safeMin);
  const safeMax = BigInt(knob.safeMax);
  const midMin = BigInt(knob.midMin);
  const midMax = BigInt(knob.midMax);

  // Five segments left-to-right:
  //   1. red    [hardMin, midMin)
  //   2. amber  [midMin,  safeMin)
  //   3. green  [safeMin, safeMax]
  //   4. amber  (safeMax, midMax]
  //   5. red    (midMax,  hardMax]
  // Some boundaries can collapse (e.g. when safeMin == midMin), in
  // which case the segment width is 0.
  const segments: { color: string; widthPct: number }[] = [
    { color: 'var(--knob-zone-caution, #ef4444)', widthPct: pct(midMin - hardMin, range) },
    { color: 'var(--knob-zone-mid, #f59e0b)', widthPct: pct(safeMin - midMin, range) },
    { color: 'var(--knob-zone-safe, #10b981)', widthPct: pct(safeMax - safeMin, range) },
    { color: 'var(--knob-zone-mid, #f59e0b)', widthPct: pct(midMax - safeMax, range) },
    { color: 'var(--knob-zone-caution, #ef4444)', widthPct: pct(hardMax - midMax, range) },
  ];

  const markerPos = knobValuePosition(value, knob);

  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          display: 'flex',
          background: 'var(--border)',
        }}
        aria-label={`${knob.label} zone bar`}
      >
        {segments.map((seg, i) => (
          <div
            key={i}
            style={{
              height: '100%',
              background: seg.color,
              width: `${seg.widthPct}%`,
              opacity: 0.8,
            }}
          />
        ))}
        {markerPos !== null && (
          <div
            style={{
              position: 'absolute',
              left: `calc(${markerPos * 100}% - 3px)`,
              top: -2,
              width: 6,
              height: 12,
              borderRadius: 2,
              background: 'var(--text-primary)',
              border: '1px solid var(--bg)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
            }}
            aria-label="current value marker"
          />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.7rem',
          opacity: 0.55,
          marginTop: 4,
        }}
      >
        <span>{formatBound(knob.hardMin, knob.unit)}</span>
        <span style={{ color: 'var(--knob-zone-safe, #10b981)' }}>
          safe: {formatBound(knob.safeMin, knob.unit)}–{formatBound(knob.safeMax, knob.unit)}
        </span>
        <span>{formatBound(knob.hardMax, knob.unit)}</span>
      </div>
    </div>
  );
}
