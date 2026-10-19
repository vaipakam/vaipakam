// apps/keeper/src/rotate.ts
//
// The keeper's one stateless rotation: a list started at `step mod length`.
// A pass that can reach only part of a list per run rotates its start with the
// run, so every item is reached within a bounded number of runs without any
// state carried between them.

/** The items starting at `step mod length`. Pure. */
export function rotate<T>(items: readonly T[], step: number): T[] {
  if (items.length === 0) return [];
  const start = ((step % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
