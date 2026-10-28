// @vitest-environment jsdom
/**
 * The forced close-out's submission lifecycle, driven directly (#2090).
 *
 * Each case is a sequence the card makes awkward to reach: a write that
 * rejects while its transaction still mines, a success that arrives from
 * the watcher rather than the write, refreshes that compete or settle out
 * of order, another tab's record, a reload. The hold's PREDICATE has its
 * own case table in `forcedCloseHold.test.ts`; these cases are about the
 * ORDER of effects and the query-cache interaction that feeds it.
 *
 * The readiness reads are real TanStack queries with fetchers the test
 * resolves by hand, so "the refresh came back" means a query settled, not
 * that a test flag flipped. Only `settled` — the chain — is stubbed.
 */
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { PublicClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, renderHook } from '../test/renderHook';
import {
  readForcedCloseSubmission,
  writeForcedCloseSubmission,
  type ForcedCloseDisposition,
} from './forcedCloseHold';
import { useForcedCloseSubmission } from './useForcedCloseSubmission';

vi.mock('../contracts/ownReceipt', () => ({ settled: vi.fn() }));
import { settled } from '../contracts/ownReceipt';

const CHAIN = 84532;
const LOAN = 7;
const HASH = `0x${'ab'.repeat(32)}` as const;
const OTHER = `0x${'cd'.repeat(32)}` as const;
const CLIENT = {} as PublicClient;

/** A promise the test resolves when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The chain's answer per hash, resolved by the test. */
let chain: Map<string, ReturnType<typeof deferred<ForcedCloseDisposition>>>;
function chainSays(hash: string, outcome: 'success' | 'reverted' | 'cancelled') {
  chain.get(hash)!.resolve(outcome);
}

/** One readiness read under the `forcedClose` prefix, kept ACTIVE by an
 *  observer the way the page's aggregate is, with each fetch resolved by
 *  hand. */
function readinessRead(client: QueryClient, enabled = true) {
  const fetches: Array<ReturnType<typeof deferred<string>>> = [];
  const observer = new QueryObserver(client, {
    queryKey: ['forcedClose', 'reads', CHAIN, String(LOAN)],
    queryFn: () => {
      const d = deferred<string>();
      fetches.push(d);
      return d.promise;
    },
    enabled,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, fetches, unsubscribe };
}

async function mount(client: QueryClient, onClosedOut = vi.fn()) {
  const wrapper = (children: ReactNode) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = await renderHook(
    (p: { chainId: number | undefined }) =>
      useForcedCloseSubmission({
        chainId: p.chainId,
        loanId: LOAN,
        publicClient: CLIENT,
        onClosedOut,
      }),
    { initialProps: { chainId: CHAIN }, wrapper },
  );
  return { hook, onClosedOut };
}

let client: QueryClient;

beforeEach(() => {
  localStorage.clear();
  chain = new Map();
  vi.mocked(settled).mockImplementation(async (_c, hash) => {
    if (!chain.has(hash)) chain.set(hash, deferred());
    const outcome = await chain.get(hash)!.promise;
    return outcome === 'success'
      ? ({ ok: true } as never)
      : ({ ok: false, reason: outcome } as never);
  });
  client = new QueryClient();
});

afterEach(() => {
  client.clear();
  vi.clearAllMocks();
});

describe('useForcedCloseSubmission', () => {
  it('holds from the hash, through a write that rejects, until the watcher succeeds and a post-success read settles', async () => {
    const reads = readinessRead(client);
    reads.fetches[0].resolve('pre-close');
    await flush();
    const { hook, onClosedOut } = await mount(client);
    expect(hook.result.current.holding).toBe(false);

    // The send: stamped on the hash. The write then REJECTS (a receipt
    // wait that lost its RPC), so the card never calls refreshReadiness.
    const onSubmitted = hook.result.current.prepareSend();
    expect(onSubmitted).not.toBeNull();
    await hook.rerender({ chainId: CHAIN });
    onSubmitted!(HASH);
    await flush();
    expect(hook.result.current.holding).toBe(true);
    expect(readForcedCloseSubmission(CHAIN, LOAN)?.hash).toBe(HASH);

    // The transaction mines anyway; the watcher establishes it.
    chainSays(HASH, 'success');
    await flush();
    expect(hook.result.current.disposition).toBe('success');
    expect(onClosedOut).toHaveBeenCalledTimes(1);
    // A post-success read has been asked for and has NOT come back.
    expect(reads.fetches).toHaveLength(2);
    expect(hook.result.current.holding).toBe(true);
    // The record backs the hold, so it survives until the hold ends.
    expect(readForcedCloseSubmission(CHAIN, LOAN)).not.toBeNull();

    reads.fetches[1].resolve('post-close');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    expect(readForcedCloseSubmission(CHAIN, LOAN)).toBeNull();
    reads.unsubscribe();
  });

  it('is not released by a refresh the write cancels: only a read that settles counts', async () => {
    const reads = readinessRead(client);
    reads.fetches[0].resolve('pre-close');
    await flush();
    const { hook, onClosedOut } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();

    // Success from the WATCHER first…
    chainSays(HASH, 'success');
    await flush();
    expect(reads.fetches).toHaveLength(2);

    // …then the write resolves and fires its own invalidation, which
    // cancels and restarts the refetch the success effect is waiting on.
    hook.result.current.refreshReadiness();
    await flush();
    expect(reads.fetches).toHaveLength(3);
    expect(hook.result.current.holding).toBe(true);

    // The cancelled fetch's promise resolving late changes nothing.
    reads.fetches[1].resolve('cancelled-late');
    await flush();
    expect(hook.result.current.holding).toBe(true);

    reads.fetches[2].resolve('post-close');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    // One success, one refresh request — never re-fired per render.
    await hook.rerender({ chainId: CHAIN });
    expect(onClosedOut).toHaveBeenCalledTimes(1);
    reads.unsubscribe();
  });

  it('is not released by another caller cancelling the refresh (round 63): a cancelled fetch resolves, but advances nothing', async () => {
    const reads = readinessRead(client);
    reads.fetches[0].resolve('pre-close');
    await flush();
    const { hook } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    chainSays(HASH, 'success');
    await flush();
    expect(reads.fetches).toHaveLength(2);

    // Some other code path cancels the readiness reads. The refresh the
    // success effect issued RESOLVES on that cancellation, against the
    // reverted pre-close cache, so a hold released on its promise would
    // release here over pre-close figures.
    await client.cancelQueries({ queryKey: ['forcedClose', 'reads'] });
    await flush();
    expect(hook.result.current.holding).toBe(true);

    // Only a read that actually settles after the success releases it.
    hook.result.current.refreshReadiness();
    await flush();
    reads.fetches[2].resolve('post-close');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    reads.unsubscribe();
  });

  it('does not count a read that started before the mine (round 65): a first load in flight is cancelled, not awaited', async () => {
    // Reload with a pending close-out: the readiness read is on its FIRST
    // load, still in flight, when success arrives.
    writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at: Date.now() });
    const reads = readinessRead(client);
    const { hook } = await mount(client);
    expect(hook.result.current.holding).toBe(true);

    chainSays(HASH, 'success');
    await flush();
    // The pre-mine fetch is cancelled and a new one started after success.
    expect(reads.fetches).toHaveLength(2);
    reads.fetches[0].resolve('pre-mine');
    await flush();
    expect(hook.result.current.holding).toBe(true);

    reads.fetches[1].resolve('post-mine');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    reads.unsubscribe();
  });

  it('releases at once on a revert, keeps the ending to report, and clears the record', async () => {
    const reads = readinessRead(client);
    reads.fetches[0].resolve('pre-close');
    await flush();
    const { hook, onClosedOut } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    chainSays(HASH, 'reverted');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    expect(hook.result.current.disposition).toBe('reverted');
    expect(hook.result.current.submitted?.hash).toBe(HASH);
    expect(readForcedCloseSubmission(CHAIN, LOAN)).toBeNull();
    // A revert asks for no refresh and runs no success path.
    expect(onClosedOut).not.toHaveBeenCalled();
    expect(reads.fetches).toHaveLength(1);
    reads.unsubscribe();
  });

  it('resumes the hold after a reload from the device-local record', async () => {
    writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at: Date.now() });
    const { hook } = await mount(client);
    expect(hook.result.current.submitted?.hash).toBe(HASH);
    expect(hook.result.current.holding).toBe(true);
    expect(vi.mocked(settled)).toHaveBeenCalledWith(CLIENT, HASH, { timeout: 0 });
  });

  it('keeps a submission per chain and loan across a chain switch and back', async () => {
    const { hook } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    await hook.rerender({ chainId: 421614 });
    expect(hook.result.current.submitted).toBeNull();
    expect(hook.result.current.holding).toBe(false);
    await hook.rerender({ chainId: CHAIN });
    expect(hook.result.current.submitted?.hash).toBe(HASH);
    expect(hook.result.current.holding).toBe(true);
  });

  it('refuses to send over another tab\'s record and adopts it instead', async () => {
    const { hook } = await mount(client);
    // Written by another tab after this one rendered, with no storage
    // event delivered yet.
    writeForcedCloseSubmission(CHAIN, LOAN, { hash: OTHER, at: Date.now() });
    expect(hook.result.current.prepareSend()).toBeNull();
    await flush();
    expect(hook.result.current.submitted?.hash).toBe(OTHER);
    expect(hook.result.current.holding).toBe(true);
  });

  it('adopts another tab\'s submission, and ignores its clear while this tab is still holding', async () => {
    const reads = readinessRead(client);
    reads.fetches[0].resolve('pre-close');
    await flush();
    const { hook } = await mount(client);
    writeForcedCloseSubmission(CHAIN, LOAN, { hash: OTHER, at: Date.now() });
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await flush();
    expect(hook.result.current.submitted?.hash).toBe(OTHER);

    // The other tab saw success and cleared the record; this tab has not
    // yet seen its own post-success read, so the clear is a signal only.
    chainSays(OTHER, 'success');
    await flush();
    writeForcedCloseSubmission(CHAIN, LOAN, null);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await flush();
    expect(hook.result.current.holding).toBe(true);
    expect(hook.result.current.submitted?.hash).toBe(OTHER);

    reads.fetches[1].resolve('post-close');
    await flush();
    expect(hook.result.current.holding).toBe(false);
    reads.unsubscribe();
  });

  it('drops a reading that will not refetch rather than waiting on it (round 66)', async () => {
    // A disabled read still holding a pre-close value — the aggregate the
    // page disables when the loan leaves Active.
    client.setQueryData(['forcedClose', 'reads', CHAIN, String(LOAN)], 'pre-close');
    const reads = readinessRead(client, false);
    const { hook } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    chainSays(HASH, 'success');
    await flush();
    // Nothing will refetch, so there is nothing to wait for — and the
    // stale reading is gone, so a reactivated read cannot serve it.
    expect(hook.result.current.holding).toBe(false);
    expect(reads.observer.getCurrentResult().data).toBeUndefined();
    reads.unsubscribe();
  });

  it('says when this browser refused to store the record', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { hook } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    expect(hook.result.current.holding).toBe(true);
    expect(hook.result.current.storageRefused).toBe(true);
    setItem.mockRestore();
  });

  it('forgets an unaccounted submission when the lender says it is gone', async () => {
    const { hook } = await mount(client);
    hook.result.current.prepareSend()!(HASH);
    await flush();
    expect(hook.result.current.holding).toBe(true);
    await hook.rerender({ chainId: CHAIN });
    hook.result.current.forget();
    await flush();
    expect(hook.result.current.submitted).toBeNull();
    expect(hook.result.current.holding).toBe(false);
    expect(readForcedCloseSubmission(CHAIN, LOAN)).toBeNull();
  });
});
