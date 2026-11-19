// #2447 — the shared watch-only wallet: the answers `answerWatchOnly` gives
// and the origin rule `installInjectedWallet` enforces. Both drives that
// observe a wallet without its key (`launch({ watchAddress })` and
// `live-position-observe.mjs`) present this one wallet.
import { describe, expect, it } from 'vitest';
import { answerWatchOnly, installInjectedWallet } from './driver.mjs';

const ADDR = '0x' + '11'.repeat(20);
const opts = (extra = {}) => ({
  address: ADDR,
  chainId: 84532,
  isPermitted: (m) => !/^(eth_send|eth_sign|personal_sign|wallet_sendCalls)/.test(m),
  forward: async ({ method }) => `forwarded:${method}`,
  ...extra,
});

describe('answerWatchOnly', () => {
  it('reports the watched address as connected, on one chain', async () => {
    expect(await answerWatchOnly({ method: 'eth_accounts' }, opts())).toEqual([ADDR]);
    expect(await answerWatchOnly({ method: 'eth_requestAccounts' }, opts())).toEqual([ADDR]);
    expect(await answerWatchOnly({ method: 'eth_chainId' }, opts())).toBe('0x14a34');
    expect(await answerWatchOnly({ method: 'net_version' }, opts())).toBe('84532');
    expect(await answerWatchOnly({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] }, opts())).toBeNull();
    await expect(
      answerWatchOnly({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }, opts()),
    ).rejects.toMatchObject({ code: 4902 });
  });

  it('refuses what it may not answer as 4100, marked so the caller can record it', async () => {
    for (const method of ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls']) {
      await expect(answerWatchOnly({ method }, opts())).rejects.toMatchObject({ code: 4100, refused: true });
    }
  });

  it('forwards every other permitted call, and never answers undefined', async () => {
    expect(await answerWatchOnly({ method: 'eth_call', params: [] }, opts())).toBe('forwarded:eth_call');
    expect(await answerWatchOnly({ method: 'eth_call' }, opts({ forward: async () => undefined }))).toBeNull();
  });
});

describe('installInjectedWallet', () => {
  /** A context that records the binding and the init script. */
  const fakeCtx = () => {
    const ctx = { binding: null, init: null };
    ctx.exposeBinding = async (name, fn) => {
      ctx.bindingName = name;
      ctx.binding = fn;
    };
    ctx.addInitScript = async (fn, arg) => {
      ctx.init = { fn, arg };
    };
    return ctx;
  };
  const frame = (url) => ({ frame: { url: () => url } });

  it('answers the site under test, and refuses and records any other frame', async () => {
    const ctx = fakeCtx();
    const foreign = [];
    await installInjectedWallet(ctx, {
      siteOrigin: 'https://app.example',
      request: async ({ method }) => (method === 'boom' ? Promise.reject(Object.assign(new Error('no'), { code: 4100 })) : 7n),
      onForeignFrame: (r) => foreign.push(r),
      watchOnly: true,
    });
    expect(ctx.bindingName).toBe('__walletRequest');
    expect(await ctx.binding(frame('https://app.example/positions'), { method: 'eth_call' })).toEqual({ result: '0x7' });
    expect(await ctx.binding(frame('https://app.example/'), { method: 'boom' })).toEqual({ error: { code: 4100, message: 'no' } });
    expect(await ctx.binding(frame('https://evil.example/'), { method: 'eth_accounts' })).toMatchObject({ error: { code: 4100 } });
    expect(foreign).toEqual([{ method: 'eth_accounts', origin: 'https://evil.example' }]);
  });

  it('names itself watch-only when no key is behind it', async () => {
    const watch = fakeCtx();
    await installInjectedWallet(watch, { siteOrigin: 'https://app.example', request: async () => null, watchOnly: true });
    expect(watch.init.arg).toMatchObject({ allowedOrigin: 'https://app.example', info: { name: 'Vaipakam Watch-Only' } });
    const signing = fakeCtx();
    await installInjectedWallet(signing, { siteOrigin: 'https://app.example', request: async () => null });
    expect(signing.init.arg.info.name).toBe('Vaipakam Test Wallet');
  });
});
