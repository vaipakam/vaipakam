/**
 * `@vaipakam/lib` — root entry.
 *
 * Re-exports the framework-agnostic utilities. Per-module subpath
 * imports (`@vaipakam/lib/multicall`, `@vaipakam/lib/decodeContractError`,
 * etc.) are also exposed via the package.json `exports` map for
 * consumers that prefer narrow imports.
 */
export * from './address.js';
export * from './multicall.js';
export * from './decodeContractError.js';
export * from './chainPlatforms.js';
export * from './canonicalAssets.js';
export * from './crossDomainPref.js';
// T-086 step 14 — `prepayOrderShape` deliberately NOT re-exported
// from the root barrel: it's framework-agnostic (no browser
// globals), but every consumer that needs it goes through the
// `@vaipakam/lib/prepayOrderShape` subpath. Keeping it out of the
// root re-export means the indexer + keeper Workers don't have to
// pull in the browser-only modules transitively through the
// barrel. Subpath-only is the import contract.
