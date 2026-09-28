/**
 * Pure mapping from the auto-refinance switch read to the posture the
 * refinance surfaces disclose (#2349 / #2355). Kept out of `protocol.ts`
 * so it can be unit-tested without a wagmi / React Query harness.
 */
export type AutoRefinancePosture = 'on' | 'off' | 'unknown';

/**
 * `isError` must reflect the LATEST fetch. React Query keeps a stale `data`
 * across a failed refetch, so the error is checked first: a cached answer
 * is never presented as current after a failed re-read, because the switch
 * may have flipped during the outage (#2355 r4). `undefined` means the
 * first read is still in flight.
 */
export function autoRefinancePostureFrom(read: {
  data: boolean | undefined;
  isError: boolean;
}): AutoRefinancePosture | undefined {
  if (read.isError) return 'unknown';
  if (read.data !== undefined) return read.data ? 'on' : 'off';
  return undefined;
}
