import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { assertTokenScreenLive, screenTargets } from './acceptTokenScreen';
import { copy } from '../content/copy';

const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const NFT = '0x3333333333333333333333333333333333333333';
const MAINNET = 1; // covered by the screen
const TESTNET = 84532; // not covered: verdicts read 'unsupported'

/** GoPlus answers `row` for every address asked about. */
function goplusReturns(row: Record<string, unknown> | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const addr = new URL(url).searchParams.get('contract_addresses')!;
      return new Response(JSON.stringify({ result: row ? { [addr]: row } : {} }), {
        status: 200,
      });
    }),
  );
}

const CLEAN_ROW = {
  is_honeypot: '0',
  cannot_sell_all: '0',
  cannot_buy: '0',
  buy_tax: '0',
  sell_tax: '0',
  transfer_tax: '0',
  is_mintable: '0',
  owner_change_balance: '0',
  is_blacklisted: '0',
  transfer_pausable: '0',
  is_whitelisted: '0',
  is_anti_whale: '0',
  anti_whale_modifiable: '0',
  trading_cooldown: '0',
  hidden_owner: '0',
  can_take_back_ownership: '0',
  is_proxy: '0',
  selfdestruct: '0',
  slippage_modifiable: '0',
  personal_slippage_modifiable: '0',
  external_call: '0',
  is_open_source: '1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#2726 screenTargets', () => {
  it('screens both legs of an ERC-20 loan', () => {
    expect(
      screenTargets({
        assetType: 0,
        lendingAsset: TOKEN_A,
        collateralAssetType: 0,
        collateralAsset: TOKEN_B,
        prepayAsset: ZERO,
      }),
    ).toEqual([
      { key: 'loanAsset', address: TOKEN_A },
      { key: 'collateral', address: TOKEN_B },
    ]);
  });

  it("screens a rental's prepayment token, never the rented NFT", () => {
    expect(
      screenTargets({
        assetType: 1,
        lendingAsset: NFT,
        collateralAssetType: 0,
        collateralAsset: ZERO,
        prepayAsset: TOKEN_A,
      }),
    ).toEqual([{ key: 'prepay', address: TOKEN_A }]);
  });

  it('skips an NFT collateral leg', () => {
    expect(
      screenTargets({
        assetType: 0,
        lendingAsset: TOKEN_A,
        collateralAssetType: 1,
        collateralAsset: NFT,
        prepayAsset: ZERO,
      }),
    ).toEqual([{ key: 'loanAsset', address: TOKEN_A }]);
  });
});

describe('#2726 assertTokenScreenLive', () => {
  const targets = [{ key: 'loanAsset' as const, address: TOKEN_A }];

  it('passes a clean token', async () => {
    goplusReturns(CLEAN_ROW);
    await expect(
      assertTokenScreenLive({
        chainId: MAINNET,
        targets,
        reviewed: { loanAsset: 'clean' },
        queryClient: new QueryClient(),
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a blocked token and puts the verdict in the cache', async () => {
    goplusReturns({ ...CLEAN_ROW, is_honeypot: '1' });
    const queryClient = new QueryClient();
    await expect(
      assertTokenScreenLive({
        chainId: MAINNET,
        targets,
        reviewed: { loanAsset: 'clean' },
        queryClient,
      }),
    ).rejects.toThrow(copy.offerFlow.securityLegLoanAsset);
    expect(
      queryClient.getQueryData(['tokenSecurity', MAINNET, TOKEN_A]),
    ).toMatchObject({ kind: 'block' });
  });

  it('refuses when the check cannot run (fail closed)', async () => {
    goplusReturns(null);
    await expect(
      assertTokenScreenLive({
        chainId: MAINNET,
        targets,
        reviewed: { loanAsset: 'clean' },
        queryClient: new QueryClient(),
      }),
    ).rejects.toThrow(copy.tokenSecurity.gateUnknown(copy.offerFlow.securityLegLoanAsset));
  });

  it('refuses a warning the review did not show, passes the one it did', async () => {
    goplusReturns({ ...CLEAN_ROW, sell_tax: '0.1' });
    const queryClient = new QueryClient();
    await expect(
      assertTokenScreenLive({ chainId: MAINNET, targets, reviewed: {}, queryClient }),
    ).rejects.toThrow(copy.tokenSecurity.gateChanged(copy.offerFlow.securityLegLoanAsset));
    const shown = queryClient.getQueryData(['tokenSecurity', MAINNET, TOKEN_A]) as {
      kind: string;
      reasons: string[];
    };
    expect(shown.kind).toBe('warn');
    await expect(
      assertTokenScreenLive({
        chainId: MAINNET,
        targets,
        reviewed: { loanAsset: `warn:${shown.reasons.join(',')}` },
        queryClient,
      }),
    ).resolves.toBeUndefined();
  });

  it('passes a network the screen does not cover', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      assertTokenScreenLive({
        chainId: TESTNET,
        targets,
        reviewed: {},
        queryClient: new QueryClient(),
      }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
