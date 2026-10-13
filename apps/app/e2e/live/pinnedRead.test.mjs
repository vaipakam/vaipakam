/**
 * #2427 follow-up — a read pinned to a just-mined block is retried while
 * the node has not seen the block, and only then.
 */
import { HttpRequestError, InvalidParamsRpcError, ResourceNotFoundRpcError, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';

import { isRetryablePinnedFailure, readPinned } from './pinnedRead.mjs';

const reply = (code, message, data) => new RpcRequestError({ body: {}, url: 'https://rpc.test', error: { code, message, data } });
const blockNotFound = () => new ResourceNotFoundRpcError(reply(-32001, 'block not found'));
const requestFailed = () => new HttpRequestError({ url: 'https://rpc.test', details: 'Request failed', status: 503 });
const revert = () => reply(3, 'execution reverted', '0x08c379a0');
const badParams = () => new InvalidParamsRpcError(reply(-32602, 'invalid params'));
const noSleep = async () => {};

function flaky(failures, value = 'ok') {
  let calls = 0;
  const read = async () => {
    calls++;
    if (calls <= failures.length) throw failures[calls - 1]();
    return value;
  };
  return { read, calls: () => calls };
}

describe('isRetryablePinnedFailure', () => {
  it('retries the node not knowing the block, and a dead transport', () => {
    expect(isRetryablePinnedFailure(blockNotFound())).toBe(true);
    expect(isRetryablePinnedFailure(requestFailed())).toBe(true);
  });
  it('does not retry an answer: a revert, a malformed request, or a bug in the drive', () => {
    expect(isRetryablePinnedFailure(revert())).toBe(false);
    expect(isRetryablePinnedFailure(badParams())).toBe(false);
    expect(isRetryablePinnedFailure(new TypeError('x is undefined'))).toBe(false);
  });
});

describe('readPinned', () => {
  it('returns the first answer once the node has the block', async () => {
    const f = flaky([blockNotFound, requestFailed], 'settled');
    await expect(readPinned(f.read, { sleep: noSleep })).resolves.toBe('settled');
    expect(f.calls()).toBe(3);
  });

  it('gives up after the bound and says how many attempts it made', async () => {
    const f = flaky(Array(10).fill(blockNotFound));
    await expect(readPinned(f.read, { attempts: 4, sleep: noSleep })).rejects.toThrow(/no answer after 4 attempts/);
    expect(f.calls()).toBe(4);
  });

  it('rethrows a non-transport failure at once', async () => {
    for (const make of [revert, badParams, () => new TypeError('bug')]) {
      const f = flaky([make]);
      await expect(readPinned(f.read, { sleep: noSleep })).rejects.toBeTruthy();
      expect(f.calls()).toBe(1);
    }
  });

  it('waits between attempts', async () => {
    const waits = [];
    const f = flaky([blockNotFound]);
    await readPinned(f.read, { delayMs: 1234, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1234]);
  });
});
