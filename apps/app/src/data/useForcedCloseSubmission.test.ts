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
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';
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

async function mount(client: QueryClient, onClosedOut = vi.fn(), publicClient = CLIENT) {
  const wrapper = (children: ReactNode) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = await renderHook(
    (p: { chainId: number | undefined }) =>
      useForcedCloseSubmission({
        chainId: p.chainId,
        loanId: LOAN,
        publicClient,
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

  describe('reconciling a reloaded submission by its nonce (#2086)', () => {
    const SENDER = `0x${'11'.repeat(20)}` as const;
    const NONCE = 5;

    /** A chain whose wait cannot account for the hash — the reload case:
     *  the live wait that would have seen a cancel or a Speed Up went
     *  with the page.
     *
     *  The wait NEVER SETTLES here, which is what viem's
     *  `waitForTransactionReceipt` actually does with `timeout: 0` for a
     *  hash it has never seen: it keeps watching blocks (Codex #3040 r1 —
     *  an earlier version of this helper made it reject, and so hid that
     *  a reconciliation run only on failure never ran). `visible` says
     *  whether the node still has the transaction. */
    function orphanedChain(accountNonce: number, visible = false) {
      vi.mocked(settled).mockReturnValue(new Promise(() => {}));
      return {
        getTransactionCount: vi.fn(async () => accountNonce),
        getTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => {
          throw new TransactionReceiptNotFoundError({ hash });
        }),
        getTransaction: vi.fn(async ({ hash }: { hash: `0x${string}` }) => {
          if (!visible) throw new TransactionNotFoundError({ hash });
          return { from: SENDER, nonce: NONCE };
        }),
      };
    }

    it('reads a spent nonce with no receipt for our hash as superseded, and holds until a read refreshes', async () => {
      const reads = readinessRead(client);
      reads.fetches[0].resolve('pre-close');
      await flush();
      writeForcedCloseSubmission(CHAIN, LOAN, {
        hash: HASH,
        at: Date.now(),
        sender: SENDER,
        nonce: NONCE,
      });
      const pc = orphanedChain(NONCE + 1);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(hook.result.current.disposition).toBe('superseded');
      expect(pc.getTransactionCount).toHaveBeenCalledWith({ address: SENDER, blockTag: 'latest' });
      // A Speed Up under another hash may have closed the loan, so the
      // action stays held until the position is read again.
      expect(hook.result.current.holding).toBe(true);
      reads.fetches[1].resolve('post-close');
      await flush();
      expect(hook.result.current.holding).toBe(false);
      reads.unsubscribe();
    });

    it('leaves the answer to the live wait while the node still has the transaction', async () => {
      writeForcedCloseSubmission(CHAIN, LOAN, {
        hash: HASH,
        at: Date.now(),
        sender: SENDER,
        nonce: NONCE,
      });
      const pc = orphanedChain(NONCE + 1, true);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(pc.getTransactionCount).toHaveBeenCalled();
      expect(hook.result.current.disposition).toBe('undetermined');
      expect(hook.result.current.holding).toBe(true);
    });

    it('takes the sender and nonce another tab stored for the same hash, and reconciles with them', async () => {
      writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at: Date.now() });
      // This tab's node no longer has the transaction, so it cannot read
      // the nonce back itself.
      const pc = orphanedChain(NONCE + 1);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(hook.result.current.submitted?.nonce).toBeUndefined();
      expect(pc.getTransactionCount).not.toHaveBeenCalled();
      // The other tab enriches the record under the same hash.
      const at = readForcedCloseSubmission(CHAIN, LOAN)!.at;
      writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at, sender: SENDER, nonce: NONCE });
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      await flush();
      expect(hook.result.current.submitted).toMatchObject({ hash: HASH, sender: SENDER, nonce: NONCE });
      expect(pc.getTransactionCount).toHaveBeenCalledWith({ address: SENDER, blockTag: 'latest' });
      await flush();
      expect(hook.result.current.disposition).toBe('superseded');
    });

    it('stays undetermined while the nonce is unspent', async () => {
      writeForcedCloseSubmission(CHAIN, LOAN, {
        hash: HASH,
        at: Date.now(),
        sender: SENDER,
        nonce: NONCE,
      });
      const pc = orphanedChain(NONCE);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(hook.result.current.disposition).toBe('undetermined');
      expect(hook.result.current.holding).toBe(true);
    });

    it('reads the sender and nonce back for a record that lacks them, and stores them', async () => {
      writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at: Date.now() });
      const pc = orphanedChain(NONCE + 1, true);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(pc.getTransaction).toHaveBeenCalledWith({ hash: HASH });
      expect(readForcedCloseSubmission(CHAIN, LOAN)).toMatchObject({
        hash: HASH,
        sender: SENDER,
        nonce: NONCE,
      });
      expect(hook.result.current.submitted?.hash).toBe(HASH);
    });

    it('keeps a learned nonce when a later identity read finds nothing (Codex #3040 r2)', async () => {
      writeForcedCloseSubmission(CHAIN, LOAN, { hash: HASH, at: Date.now() });
      const pc = orphanedChain(NONCE, true);
      const { hook } = await mount(client, vi.fn(), pc as unknown as PublicClient);
      await flush();
      expect(hook.result.current.submitted).toMatchObject({ sender: SENDER, nonce: NONCE });
      // The node drops the transaction, every query is asked again (a
      // reconnect), and then a replacement takes the nonce.
      pc.getTransaction.mockImplementation(async ({ hash }: { hash: `0x${string}` }) => {
        throw new TransactionNotFoundError({ hash });
      });
      // Not awaited: the wait it also refetches never settles, as viem's
      // does not for this hash.
      void client.invalidateQueries();
      await flush();
      expect(hook.result.current.submitted).toMatchObject({ sender: SENDER, nonce: NONCE });
      pc.getTransactionCount.mockResolvedValue(NONCE + 1);
      void client.invalidateQueries({ queryKey: ['forcedClose', 'disposition'] });
      await flush();
      await flush();
      expect(hook.result.current.disposition).toBe('superseded');
    });
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
