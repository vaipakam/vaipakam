import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ethersState, resetEthersState, ethersMockModule } from '../ethersMock';

vi.mock('ethers', () => ethersMockModule());

const walletState: any = { signer: null, isCorrectChain: false };
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletState,
  WalletProvider: ({ children }: any) => children,
}));

import { useDiamondContract, useDiamondRead } from '../../src/contracts/useDiamond';
import { useERC20 } from '../../src/contracts/useERC20';

describe('contract hooks', () => {
  beforeEach(() => {
    resetEthersState();
    walletState.signer = null;
    walletState.isCorrectChain = false;
    delete (window as any).ethereum;
  });

  it('useDiamondRead returns a Contract-like object', () => {
    const { result } = renderHook(() => useDiamondRead());
    expect(result.current).toBeTruthy();
    expect((result.current as any).target).toMatch(/^0x/);
  });

  it('useDiamondContract returns read-only when no wallet', () => {
    const { result } = renderHook(() => useDiamondContract());
    expect(result.current).toBeTruthy();
  });

  it('useDiamondContract uses signer when connected to correct chain', () => {
    walletState.signer = { fake: true };
    walletState.isCorrectChain = true;
    const { result } = renderHook(() => useDiamondContract());
    expect(result.current).toBeTruthy();
    expect((result.current as any).target).toMatch(/^0x/);
  });

  it('useERC20 returns null when address is null', () => {
    const { result } = renderHook(() => useERC20(null));
    expect(result.current).toBeNull();
  });

  it('useERC20 returns null without signer', () => {
    const { result } = renderHook(() => useERC20('0x1234'));
    expect(result.current).toBeNull();
  });

  it('useERC20 returns Contract with signer', () => {
    walletState.signer = { fake: true };
    const { result } = renderHook(() => useERC20('0xAbC0000000000000000000000000000000000001'));
    expect(result.current).toBeTruthy();
    expect((result.current as any).target).toMatch(/^0x/);
  });
});
