/**
 * Read one entry of a copy catalog map by a key that came from outside the
 * app (an event kind, a status name from the indexer).
 *
 * A plain `map[key]` resolves inherited members for keys such as
 * `constructor`, `toString` or `__proto__`, so an unexpected key would hand
 * the page a function or an object instead of falling back (#2701 r1).
 * Only an OWN entry whose value is a string counts; anything else is
 * `undefined`, and the caller's fallback applies.
 */
export function catalogText(map: Record<string, string>, key: string): string | undefined {
  if (!Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : undefined;
}
