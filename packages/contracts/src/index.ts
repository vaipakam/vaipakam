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
 *
 * `./recycle-backing` is the one piece of LOGIC here: the recycle-backing
 * verdict the indexer serves and the dashboard displays. It sits beside the
 * ABIs because it interprets exactly one view's outputs
 * (`getRecycleBackingSnapshotV2`), and a consumer that needs only the
 * verdict types can import that subpath without pulling the ABI bundle.
 */
export * from './abis/index.js';
export * from './chain-config.js';
export * from './deployments.js';
export * from './recycleBacking.js';
