import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// #1076: the contract layer migrated from ethers to viem. `useDiamond*`
// and `useERC20` are now built on wagmi's `usePublicClient` /
// `useWalletClient` plus the app's Wallet/Chain contexts — none of which
// exist under a bare `renderHook`. We mock those dependencies so the hooks
// resolve, and drop the dead `vi.mock('ethers', …)` / `ethersMock` shim
// (src imports no ethers). The returned handle is a viem-backed Proxy
// whose `get` trap returns a callable for EVERY string prop (with a
// `.staticCall` escape hatch) — it exposes NO `.target` address (the old
// ethers-Contract `.target` assertions are stale), so we assert the
// current shape: a truthy handle whose members are callable.

// A minimal fake ChainConfig so `resolveReadChain` returns it (activeChain
// wins over DEFAULT_CHAIN) and `buildDiamondProxy` gets a concrete address.
const FAKE_CHAIN = {
  chainId: 11155111,
  diamondAddress: '0x1111111111111111111111111111111111111111',
  rpcUrl: 'http://localhost:8545',
  deployBlock: 0,
  blockExplorer: 'https://sepolia.etherscan.io',
  name: 'Test Chain',
};

const walletState: {
  isCorrectChain: boolean;
  activeChain: typeof FAKE_CHAIN | null;
  address: string | null;
} = { isCorrectChain: false, activeChain: FAKE_CHAIN, address: null };

vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletState,
  WalletProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('../../src/context/ChainContext', () => ({
  useChainOverride: () => ({ viewChainId: null }),
}));

// wagmi hooks the contract layer calls. `usePublicClient` only needs to be
// a non-null object (the Proxy stores it and uses it lazily on invoke).
// `useWalletClient` returns `{ data }` — a wallet client only when the test
// simulates a connected signer.
let walletClientData: unknown = null;
const fakePublicClient = { readContract: vi.fn(), getLogs: vi.fn() };
vi.mock('wagmi', () => ({
  usePublicClient: () => fakePublicClient,
  useWalletClient: () => ({ data: walletClientData }),
}));

import { useDiamondContract, useDiamondRead } from '../../src/contracts/useDiamond';
import { useERC20 } from '../../src/contracts/useERC20';

/** The Diamond handle is a Proxy whose members are callables carrying a
 *  `.staticCall` escape hatch. Asserting this replaces the stale `.target`
 *  address-string check from the ethers era. */
function expectDiamondShape(handle: unknown) {
  expect(handle).toBeTruthy();
  const fn = (handle as Record<string, unknown>).balanceOf;
  expect(typeof fn).toBe('function');
  expect(typeof (fn as { staticCall?: unknown }).staticCall).toBe('function');
}

/** The ERC20 handle is a Proxy whose members are callables (no `.staticCall`
 *  helper — that's Diamond-only). */
function expectErc20Shape(handle: unknown) {
  expect(handle).toBeTruthy();
  expect(typeof (handle as Record<string, unknown>).balanceOf).toBe('function');
  expect(typeof (handle as Record<string, unknown>).approve).toBe('function');
}

beforeEach(() => {
  walletState.isCorrectChain = false;
  walletState.activeChain = FAKE_CHAIN;
  walletState.address = null;
  walletClientData = null;
});

describe('contract hooks', () => {
  it('useDiamondRead returns a callable Diamond handle', () => {
    const { result } = renderHook(() => useDiamondRead());
    // #1076: the viem Proxy exposes callables per selector, not a `.target`
    // address string like the old ethers Contract.
    expectDiamondShape(result.current);
  });

  it('useDiamondContract returns a read-only handle when no wallet', () => {
    const { result } = renderHook(() => useDiamondContract());
    expectDiamondShape(result.current);
  });

  it('useDiamondContract binds the wallet client when on the correct chain', () => {
    walletClientData = { account: { address: '0x2222222222222222222222222222222222222222' }, chain: FAKE_CHAIN };
    walletState.isCorrectChain = true;
    const { result } = renderHook(() => useDiamondContract());
    expectDiamondShape(result.current);
  });

  it('useERC20 returns null when address is null', () => {
    const { result } = renderHook(() => useERC20(null));
    expect(result.current).toBeNull();
  });

  it('useERC20 returns a read-only handle even without a wallet', () => {
    // #1076: changed from the ethers-era `null`. viem's `useERC20` now
    // exposes a read-only handle pre-connect so `balanceOf` / `allowance`
    // can fire before the user clicks Connect (see useERC20.ts docstring).
    const { result } = renderHook(() =>
      useERC20('0xabc0000000000000000000000000000000000001'),
    );
    expectErc20Shape(result.current);
  });

  it('useERC20 returns a callable handle when a wallet is connected', () => {
    walletClientData = { account: { address: '0x2222222222222222222222222222222222222222' }, chain: FAKE_CHAIN };
    walletState.isCorrectChain = true;
    const { result } = renderHook(() =>
      useERC20('0xabc0000000000000000000000000000000000001'),
    );
    expectErc20Shape(result.current);
  });
});
