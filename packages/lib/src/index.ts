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
