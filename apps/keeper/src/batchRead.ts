import { createPublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './multicall3';

/** Result shape viem's `multicall` returns under `allowFailure: true`. */
export type BatchResult = { status: 'success' | 'failure'; result?: unknown; error?: unknown };

/**
 * One `aggregate3` for a set of reads, falling back to serial reads per entry.
 *
 * The fallback is the dangerous part and the reason this is a named helper
 * rather than an inline try/catch: a chainless client makes `multicall()` throw
 * LOCALLY, every time, so a swallowed error means the batching silently never
 * happens and the pass still completes normally. That is exactly how the
 * liquidator's batching went unnoticed until #1946. `multicallAddress` is what
 * prevents it; the fallback exists only for a chain genuinely missing
 * Multicall3.
 */
export async function batchedRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  if (contracts.length === 0) return [];
  try {
    const results = (await client.multicall({
      contracts: contracts as never,
      allowFailure: true,
      // REQUIRED — see src/multicall3.ts (#1946).
      multicallAddress: MULTICALL3_ADDRESS,
      // Disable viem's byte-size re-split (1024 B default), which would turn
      // one bounded chunk back into several requests (#1965 r2).
      batchSize: 0,
    })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];

    // A REJECTED aggregate3 does not throw. With `allowFailure: true` viem
    // catches the chunk-level RPC error and hands back one `failure` per
    // contract carrying the SAME error object — so the `catch` below never
    // runs and every entry silently reads as unevaluated. Verified against the
    // installed viem: a chunk-level error returns `["failure"]`, it does not
    // throw. This is the liquidator's #1965 finding, and the watcher's
    // fallback would have been dead code without it.
    //
    // `batchSize: 0` means one batch per call, so "every result failed AND
    // they share one error object identity" is exactly the aggregate-level
    // case; per-entry reverts carry their own decoded errors.
    const aggregateFailed =
      results.length > 0 &&
      results.every(
        (r) => r.status === 'failure' && r.error === results[0].error && r.error !== undefined,
      );
    if (aggregateFailed) {
      console.error(
        `[keeper] ${label} aggregate3 rejected: ${String(results[0].error).slice(0, 200)} — retrying serially`,
      );
      return serialRead(client, contracts);
    }
    return results;
  } catch (err) {
    console.error(
      `[keeper] ${label} multicall failed, falling back to serial: ${String(err).slice(0, 200)}`,
    );
    return serialRead(client, contracts);
  }
}

/** One read per contract — the degraded path, kept out of `batchedRead` so both entries share it. */
async function serialRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  const out: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (const c of contracts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push({ status: 'success', result: await client.readContract(c as never) });
    } catch (e) {
      out.push({ status: 'failure', error: e });
    }
  }
  return out;
}
