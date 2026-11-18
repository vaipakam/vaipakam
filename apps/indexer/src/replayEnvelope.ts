/**
 * The `ingest` field on every chain-keyed read (row 3.9, #3411 follow-up).
 *
 * The offer, signed-offer, loan, activity, claim and notification routes
 * serve rows the scan builds. While a chain's rows are being replayed (a
 * deployment adopted, or a reorg rebuild), those rows are partial. So every
 * 200 answer states that chain's replay state, under one key, beside
 * whatever the route returns:
 *
 *   ingest: { chainId, replaying, reason, cursorBlock, safeHead,
 *             safeHeadObservedAt, lagBlocks, caughtUpWithinBlocks }
 *
 * (see `replayState.ReplayState` for each field). The field is added here,
 * at the one place the router hands these answers back, not inside each
 * handler. A route added to that block later carries it without anyone
 * remembering to.
 *
 * Failure is stated, not hidden. If the state cannot be read, the answer
 * still goes out, with `replaying: null` (unknown), because withholding a
 * list for want of a disclosure helps nobody. A body that is not a JSON
 * object, or a non-200 answer, passes through unchanged.
 */
import { redactedError } from '@vaipakam/lib/errorDescription';
import { readReplayState, unknownReplayState, type ReplayReadDb, type ReplayState } from './replayState';

/** The envelope key. Pinned by test so a consumer can rely on it. */
export const REPLAY_ENVELOPE_KEY = 'ingest';

/** What the envelope carries for one chain. */
export type ReplayEnvelope = { chainId: number } & ReplayState;

/** Add the chain's replay state to a 200 JSON-object answer. */
export async function withReplayEnvelope(res: Response, db: ReplayReadDb, chainId: number): Promise<Response> {
  if (res.status !== 200) return res;
  if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  let state: ReplayState;
  try {
    state = await readReplayState(db, chainId);
  } catch (err) {
    console.error(`[replayEnvelope] chain ${chainId}: replay state could not be read`, redactedError(err));
    state = unknownReplayState();
  }
  const envelope: ReplayEnvelope = { chainId, ...state };
  return new Response(
    JSON.stringify({
      ...(body as Record<string, unknown>),
      [REPLAY_ENVELOPE_KEY]: envelope,
    }),
    {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    },
  );
}
