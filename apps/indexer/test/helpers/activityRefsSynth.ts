/**
 * Shared synthesis for the two activity-refs EXECUTION suites (#1794,
 * round-70): one derived surface and one args synthesizer, so the mapper
 * suite (`activityRefsCoverage.test.ts`) and the ledger suite
 * (`activityLedger.test.ts`) exercise the SAME event set with the same
 * planted ids — the ledger claiming "one insert per decoded event" is only
 * meaningful if its batch is the whole surface, not a hand-picked pair.
 */
import { deriveActivityRefsSurface } from '../../scripts/lib/activity-refs-surface.mjs';

export const surface = deriveActivityRefsSurface();

/** Unique numeric id per (event, path) — starts high enough that no real
 *  constant in the mapper (0, 1, …) can collide with a planted value. */
export const plantedId = (() => {
  let next = 100_000;
  const byKey = new Map<string, bigint>();
  return (event: string, path: string) => {
    const key = `${event} ${path}`;
    let v = byKey.get(key);
    if (v === undefined) {
      v = BigInt((next += 7));
      byKey.set(key, v);
    }
    return v;
  };
})();

function valueFor(event: string, path: string, type: string): unknown {
  if (/^u?int(\d+)?$/.test(type)) return plantedId(event, path);
  if (/\]$/.test(type)) return []; // any array — inert
  if (type === 'address') return '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  if (type === 'bool') return false;
  if (type === 'string') return 'synthetic';
  if (/^bytes\d*$/.test(type)) return `0x${'00'.repeat(32)}`;
  return `0x${'00'.repeat(32)}`;
}

/** Every distinct argument layout the ABI declares for `event` — one per
 *  signature, so an overloaded event contributes each of its layouts (Codex
 *  round-71 P2: keeping only the last-parsed layout left the other overload's
 *  fields unsynthesized and therefore unexecuted). */
export function layoutsOf(event: string): Array<Array<{ path: string; type: string }>> {
  return [...(surface.argShapes.get(event)?.values() ?? [])];
}

/** A decoded-args bag for `event`, every ABI leaf populated by type. Numeric
 *  scalars get the planted unique id; everything else gets an inert value of
 *  the right JS shape (what viem would hand the mapper). Non-overloaded
 *  events have exactly one layout; pass `layout` to synthesize a specific
 *  overload's shape. */
export function synthesizeArgs(
  event: string,
  layout?: Array<{ path: string; type: string }>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const { path, type } of layout ?? layoutsOf(event)[0] ?? []) {
    if (type === 'tuple') continue; // parents materialize via their leaves
    const segs = path.split('.');
    let host = args;
    for (const s of segs.slice(0, -1)) {
      host = (host[s] ??= {}) as Record<string, unknown>;
    }
    host[segs[segs.length - 1]] = valueFor(event, path, type);
  }
  return args;
}

/** The planted values that count as "mapped" for this event+field. */
export function expectedIds(event: string, field: string): number[] {
  const paths = surface.aliasNames.get(event)?.get(field);
  if (!paths) return [];
  return [...paths].map((p) => Number(plantedId(event, p)));
}
