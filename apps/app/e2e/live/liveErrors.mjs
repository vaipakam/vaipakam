/**
 * Error types shared by the driver and the modules it builds on, kept in a
 * module of their own so a module the driver imports can extend them
 * without an import cycle (#2841: `shapeCheckedClient.mjs` raises a
 * subclass of `LivePreconditionError`).
 */

/**
 * A PRECONDITION failure raised where exiting immediately would be
 * unsafe (Codex #1621 r4).
 *
 * `blockedSync` is right before a drive can mutate anything. After that
 * point `process.exit` skips the drive's `finally`, which is what cancels
 * a posted offer or a resting signed order — so a stale ABI bundle could
 * cost real testnet funds. Throwing instead lets the cleanup run, and the
 * drive classifies this type as BLOCKED at its final exit.
 *
 * Preferred over an up-front list of everything used after the mutation
 * boundary: such a list drifted within one review round (it omitted
 * `getOffer` and `previewMatch`), and a list that must stay exhaustive to
 * be safe is the wrong shape for a safety property.
 */
export class LivePreconditionError extends Error {
  constructor(why) {
    super(why);
    this.name = 'LivePreconditionError';
  }
}
