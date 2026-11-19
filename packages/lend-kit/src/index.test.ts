import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { borrowAgainstLink, KitLinkError, kitLink, lendLink, openKit, parseKitParams, rentLink, SHARE_RULE } from './index';

const APP = 'https://alpha05.vaipakam.com';
const NFT = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0x2222222222222222222222222222222222222222' as const;
const INT = '0x3333333333333333333333333333333333333333' as const;

const back = (link: string) => parseKitParams(new URL(link).searchParams);

describe('#3773 kit links', () => {
  it('builds each entry point on the app’s kit path and reads back exactly what it was given', () => {
    const b = borrowAgainstLink(APP, { chainId: 84532, asset: NFT, tokenId: 7n, integrator: INT });
    expect(new URL(b).pathname).toBe('/kit');
    expect(back(b)).toEqual({ action: 'borrow', chainId: 84532, asset: NFT, tokenId: 7n, integrator: INT });
    expect(back(lendLink(APP, { chainId: 84532, asset: USDC, amount: 5_000_000n }))).toEqual({ action: 'lend', chainId: 84532, asset: USDC, amount: 5_000_000n });
    expect(back(rentLink(APP, { chainId: 84532, asset: NFT, tokenId: 0n, integrator: INT }))).toEqual({
      action: 'rent',
      chainId: 84532,
      asset: NFT,
      tokenId: 0n,
      integrator: INT,
    });
  });

  it('says where a share can apply: only on a borrower’s action', () => {
    expect(SHARE_RULE).toEqual({ borrow: 'may-apply', lend: 'attribution-only', rent: 'no-fee' });
  });

  it('refuses what the app would refuse, by name, and guesses nothing', () => {
    const bad = (q: string) => () => parseKitParams(new URLSearchParams(q));
    expect(bad('v=2&action=lend&chain=1&asset=' + USDC + '&amount=1')).toThrow(KitLinkError);
    expect(bad('v=1&action=steal&chain=1&asset=' + USDC)).toThrow('action');
    expect(bad('v=1&action=lend&chain=0&asset=' + USDC + '&amount=1')).toThrow('chain');
    expect(bad('v=1&action=lend&chain=1&asset=0x0000000000000000000000000000000000000000&amount=1')).toThrow('non-zero');
    expect(bad('v=1&action=lend&chain=1&asset=' + USDC)).toThrow('amount is required');
    expect(bad('v=1&action=lend&chain=1&asset=' + USDC + '&amount=1.5')).toThrow('whole');
    expect(bad('v=1&action=borrow&chain=1&asset=' + NFT + '&quantity=2')).toThrow('needs a tokenId');
    expect(bad('v=1&action=rent&chain=1&asset=' + NFT + '&integrator=nope&tokenId=1')).toThrow('integrator');
    expect(() => kitLink('http://evil.example', { action: 'lend', chainId: 1, asset: USDC, amount: 1n })).toThrow('https');
  });

  it('carries no signing code and reads no key', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const word of ['signTypedData', 'signMessage', 'privateKey', 'sendTransaction', 'eth_sign', 'mnemonic']) expect(src).not.toContain(word);
  });
});

describe('openKit', () => {
  const g = globalThis as { open?: unknown };
  const before = g.open;
  afterEach(() => {
    g.open = before;
  });

  it('opens a blank tab, cuts its opener and follows the link from inside it without a referrer', () => {
    const clicked: { href: string; rel: string }[] = [];
    const tab = {
      opener: 'integrator' as unknown,
      document: {
        body: { appendChild: (n: unknown) => n },
        createElement: () => {
          const a = { href: '', rel: '', click: () => clicked.push({ href: a.href, rel: a.rel }) };
          return a;
        },
      },
    };
    const calls: unknown[][] = [];
    g.open = (...args: unknown[]) => {
      calls.push(args);
      return tab;
    };
    expect(openKit('https://app.example/kit?v=1')).toBe(true);
    expect(calls).toEqual([['', '_blank']]);
    expect(tab.opener).toBeNull();
    expect(clicked).toEqual([{ href: 'https://app.example/kit?v=1', rel: 'noopener noreferrer' }]);
  });

  it('says false only when the browser blocked the tab', () => {
    g.open = () => null;
    expect(openKit('https://app.example/kit')).toBe(false);
  });
});
