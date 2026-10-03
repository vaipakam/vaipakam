/**
 * A query's data only while its LATEST fetch succeeded (#2389 r8).
 *
 * TanStack Query keeps `data` through a failed refetch, so a cached
 * answer outlives the state it described: a loan that closed elsewhere
 * still reads Active, a position that moved still names its old holder.
 * For a surface that moves funds, a fact that failed to refresh is an
 * unknown, not the last thing the app heard — this is the one place that
 * rule is written, so each consumer cannot forget the `isError` half.
 */
export function freshData<T>(q: { data: T | undefined; isError: boolean }): T | undefined {
  return q.isError ? undefined : q.data;
}
