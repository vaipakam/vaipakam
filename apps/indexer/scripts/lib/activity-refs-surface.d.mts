/**
 * Types for the shared activity-refs surface derivation (plain .mjs so the
 * node checker script can import it without a TS loader; this declaration is
 * what lets the vitest half import it type-checked).
 */
export const DELIBERATELY_NOT_SCOPED: Record<string, string>;
export const REF_FIELDS: string[];
export const REF_SHAPE: Record<string, RegExp>;
export const REF_EXTRA_ALIASES: Record<string, string[]>;
export function isAliasOf(field: string, name: unknown): boolean;
export function deriveActivityRefsSurface(): {
  carries: Map<string, Set<string>>;
  aliasNames: Map<string, Map<string, Set<string>>>;
  eventInputs: Map<string, string>;
  /** One layout per DISTINCT signature, so every overload is present. */
  argShapes: Map<string, Map<string, Array<{ path: string; type: string }>>>;
  arrayOnlyRefs: Map<string, string>;
  abiConflicts: Array<{ kind: string; event: string; message: string }>;
};
