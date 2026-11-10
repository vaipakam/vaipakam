/**
 * The index's count of loans on a token pair whose agreed terms it has not
 * confirmed (`unplaced` on `/loans/recent` and `/loans/rate-candles`). Such a
 * loan is in no term's market, so every surface that reads one market's
 * loans states this count beside them: an empty market never hides loans
 * whose term is unknown. `capped`: the index stopped counting, so the count
 * is a floor.
 */
import { IndexerUnavailable } from './indexerClient';

export interface Unplaced {
  count: number;
  capped: boolean;
}

/** Reads the count, or throws a shape failure when the index did not give
 *  one: a missing count would read as "none". */
export function unplacedFrom(v: unknown): Unplaced {
  const u = v as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== 'object' || !Number.isSafeInteger(u.count) || (u.count as number) < 0 || typeof u.capped !== 'boolean') {
    throw new IndexerUnavailable('shape', 'The index did not say how many loans on this pair have unconfirmed terms.');
  }
  return { count: u.count as number, capped: u.capped };
}
