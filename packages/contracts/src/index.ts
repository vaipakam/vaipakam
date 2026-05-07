/**
 * `@vaipakam/contracts` — root entry.
 *
 * Re-exports the two most commonly-consumed surfaces:
 *   - `./abis`        per-facet ABI JSONs + the viem-typed Diamond
 *                     ABI bundle used for multicall encoding and
 *                     contract-method typing.
 *   - `./deployments` typed loader over the consolidated
 *                     `deployments.json` keyed by `chainId`.
 *
 * Per-file ABI imports (e.g. `@vaipakam/contracts/abis/OfferFacet.json`)
 * are also exposed via the package.json `exports` map.
 */
export * from './abis/index.js';
export * from './chain-config.js';
export * from './deployments.js';
