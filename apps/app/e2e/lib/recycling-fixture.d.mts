/**
 * Types for the one export of `recycling-fixture.mjs` a TypeScript spec
 * reads. The fixture stays plain .mjs because the indexer stub (plain Node)
 * imports it; this declaration lets `tests/analytics-recycling.spec.ts`
 * iterate the stub's OWN variant list instead of retyping it, so a variant
 * added to the stub is checked against the shared verdict automatically.
 */
export declare const RECYCLING_FIXTURE_VARIANTS: readonly string[];
