import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import React from 'react';

const ERC721_ID = '0x80ac58cd';
const ERC1155_ID = '0xd9b67a26';

type ContractBehavior = {
  supportsInterface?: (id: string) => boolean | Promise<boolean>;
  decimals?: () => number | Promise<number>;
};

const behaviorsByAddress: Record<string, ContractBehavior> = {};
let contractConstructionCount = 0;

vi.mock('ethers', () => {
  class Contract {
    constructor(
      public target: string,
      _abi: unknown,
      _runner: unknown,
    ) {
      contractConstructionCount += 1;
      const key = target.toLowerCase();
      const behavior = behaviorsByAddress[key] ?? {};
      return {
        target,
        supportsInterface: async (id: string) => {
          if (!behavior.supportsInterface) throw new Error('no supportsInterface');
          return behavior.supportsInterface(id);
        },
        decimals: async () => {
          if (!behavior.decimals) throw new Error('no decimals');
          return behavior.decimals();
        },
      };
    }
  }
  return {
    Contract,
    isAddress: (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  };
});

const walletMock: { provider: unknown; chainId: number | null } = {
  provider: { mock: true },
  chainId: 1,
};
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletMock,
  WalletProvider: ({ children }: { children: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

import { useAssetType } from '../../src/hooks/useAssetType';

function mkAddr(fill: string): string {
  return '0x' + fill.repeat(40).slice(0, 40);
}

beforeEach(() => {
  for (const k of Object.keys(behaviorsByAddress)) delete behaviorsByAddress[k];
  contractConstructionCount = 0;
  walletMock.provider = { mock: true };
  walletMock.chainId = 1;
});

describe('useAssetType', () => {
  it('returns null for empty address', () => {
    const { result } = renderHook(() => useAssetType(null));
    expect(result.current.type).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('returns null for invalid address', () => {
    const { result } = renderHook(() => useAssetType('0xnotvalid'));
    expect(result.current.type).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('returns null when provider is missing', () => {
    walletMock.provider = null;
    const { result } = renderHook(() => useAssetType(mkAddr('a')));
    expect(result.current.type).toBeNull();
  });

  it('detects ERC-1155 when supportsInterface(d9b67a26) is true', async () => {
    const addr = mkAddr('1');
    behaviorsByAddress[addr.toLowerCase()] = {
      supportsInterface: (id) => id === ERC1155_ID,
    };
    const { result } = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(result.current.type).toBe('erc1155'));
  });

  it('detects ERC-721 when only the 721 id is true', async () => {
    const addr = mkAddr('2');
    behaviorsByAddress[addr.toLowerCase()] = {
      supportsInterface: (id) => id === ERC721_ID,
    };
    const { result } = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(result.current.type).toBe('erc721'));
  });

  it('falls back to ERC-20 via decimals() when supportsInterface rejects', async () => {
    const addr = mkAddr('3');
    behaviorsByAddress[addr.toLowerCase()] = {
      decimals: () => 18,
    };
    const { result } = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(result.current.type).toBe('erc20'));
  });

  it('returns unknown when neither supportsInterface nor decimals succeed', async () => {
    const addr = mkAddr('4');
    const { result } = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(result.current.type).toBe('unknown'));
  });

  it('caches the result across remounts keyed by (chainId, address)', async () => {
    const addr = mkAddr('5');
    behaviorsByAddress[addr.toLowerCase()] = { decimals: () => 6 };
    const first = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(first.result.current.type).toBe('erc20'));
    const constructionsAfterFirst = contractConstructionCount;
    const second = renderHook(() => useAssetType(addr));
    await waitFor(() => expect(second.result.current.type).toBe('erc20'));
    expect(contractConstructionCount).toBe(constructionsAfterFirst);
  });

  it('does not update state if unmounted before detection resolves', async () => {
    const addr = mkAddr('6');
    let resolveSupports: ((v: boolean) => void) | null = null;
    behaviorsByAddress[addr.toLowerCase()] = {
      supportsInterface: () => new Promise<boolean>((r) => { resolveSupports = r; }),
    };
    const { result, unmount } = renderHook(() => useAssetType(addr));
    unmount();
    resolveSupports?.(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.type).toBeNull();
  });
});
