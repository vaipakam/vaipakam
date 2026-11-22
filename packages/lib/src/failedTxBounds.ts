/**
 * The failed transaction record's size bounds (#3918, #3919,
 * TroubleshootingPictureDesign.md §4.3), in one place.
 *
 * The indexer's write route refuses a record over any of them, and the pass
 * cuts every record to fit them before it writes. One definition for both
 * sides: a record the pass sends and the route refuses would come back on
 * every run, since the pass's cursor moves only after its records are stored.
 */

/** A stored explanation is kept whole up to this size (§4.3, Default 256 KB). */
export const MAX_EXPLANATION_BYTES = 256 * 1024;
/** The decoded error values, as JSON. */
export const MAX_ERROR_VALUES_BYTES = 16 * 1024;
/** The list of what a record cannot hold, as JSON. */
export const MAX_UNAVAILABLE_BYTES = 4 * 1024;
/** Records in one write. */
export const MAX_RECORDS_PER_WRITE = 20;

/** Everything a record holds besides those fields, at most (ids, names, hashes, flags). */
const RECORD_FIXED_BYTES = 4 * 1024;
/** A cursor statement besides its records, at most (checkpoints, gaps and audit slices). */
const CURSOR_FIXED_BYTES = 256 * 1024;
/**
 * The request body the route reads at most: a full write of records at every
 * field's bound, with the cursor statement they can travel in.
 */
export const MAX_FAILED_TX_BODY =
  MAX_RECORDS_PER_WRITE * (MAX_EXPLANATION_BYTES + MAX_ERROR_VALUES_BYTES + MAX_UNAVAILABLE_BYTES + RECORD_FIXED_BYTES) + CURSOR_FIXED_BYTES;

/** The UTF-8 size of a value's JSON. */
export const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
