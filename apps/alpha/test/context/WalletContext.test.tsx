import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ethersState, resetEthersState, ethersMockModule } from '../ethersMock';

vi.mock('ethers', () => ethersMockModule());

import { WalletProvider, useWallet } from '../../src/context/WalletContext';

function Probe() {
  const w = useWallet();
  return (
    <div>
      <span data-testid="addr">{w.address ?? 'none'}</span>
      <span data-testid="chain">{String(w.chainId)}</span>
      <span data-testid="correct">{String(w.isCorrectChain)}</span>
      <span data-testid="conn">{String(w.isConnecting)}</span>
      <span data-testid="err">{w.error ?? ''}</span>
      <button onClick={w.connect}>connect</button>
      <button onClick={w.disconnect}>disconnect</button>
      <button onClick={w.switchToDefaultChain}>switch</button>
    </div>
  );
}

interface MockEth {
  request: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  _accounts: string[];
}

function installEthereum(overrides: Partial<MockEth> = {}): MockEth {
  const listeners: Record<string, Function[]> = {};
  const eth: MockEth = {
    _accounts: [],
    request: vi.fn(async ({ method }: any) => {
      if (method === 'eth_accounts') return eth._accounts;
      return undefined;
    }),
    on: vi.fn((evt: string, fn: Function) => {
      listeners[evt] = listeners[evt] ?? [];
      listeners[evt].push(fn);
    }),
    removeListener: vi.fn(),
    ...overrides,
  };
  (window as any).ethereum = eth;
  (eth as any)._listeners = listeners;
  return eth;
}

describe('WalletContext', () => {
  beforeEach(() => {
    resetEthersState();
    delete (window as any).ethereum;
  });

  it('sets error when no wallet detected', async () => {
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    expect(screen.getByTestId('err').textContent).toMatch(/No wallet/);
  });

  it('connects successfully', async () => {
    installEthereum();
    ethersState.signerAddress = '0xABCDEF0000000000000000000000000000000001';
    ethersState.chainId = 11155111;
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('addr').textContent).toMatch(/0xABC/i));
    expect(screen.getByTestId('correct')).toHaveTextContent('true');
  });

  it('reports wrong chain', async () => {
    installEthereum();
    ethersState.signerAddress = '0xAAA';
    ethersState.chainId = 1;
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('chain')).toHaveTextContent('1'));
    expect(screen.getByTestId('correct')).toHaveTextContent('false');
  });

  it('handles user rejection (4001)', async () => {
    installEthereum();
    ethersState.sendImpl = (method) => {
      if (method === 'eth_requestAccounts') {
        const e: any = new Error('rej');
        e.code = 4001;
        throw e;
      }
    };
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('err').textContent).toMatch(/rejected/));
  });

  it('handles generic failure', async () => {
    installEthereum();
    ethersState.sendImpl = () => { throw new Error('boom'); };
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('err').textContent).toMatch(/Failed/));
  });

  it('disconnect clears address', async () => {
    installEthereum();
    ethersState.signerAddress = '0xFFEE';
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('addr').textContent).not.toBe('none'));
    await userEvent.click(screen.getByText('disconnect'));
    expect(screen.getByTestId('addr')).toHaveTextContent('none');
  });

  it('switchToDefaultChain calls wallet_switchEthereumChain', async () => {
    const eth = installEthereum();
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('switch'));
    expect(eth.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_switchEthereumChain' }));
  });

  it('switchToDefaultChain falls back to addEthereumChain on 4902', async () => {
    const eth = installEthereum({
      request: vi.fn(async ({ method }: any) => {
        if (method === 'wallet_switchEthereumChain') {
          const e: any = new Error('unknown chain'); e.code = 4902; throw e;
        }
        if (method === 'eth_accounts') return [];
        return undefined;
      }) as any,
    });
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('switch'));
    await waitFor(() => {
      expect((eth.request as any).mock.calls.some((c: any[]) => c[0].method === 'wallet_addEthereumChain')).toBe(true);
    });
  });

  it('switchToDefaultChain returns silently with no wallet', async () => {
    render(<WalletProvider><Probe /></WalletProvider>);
    await userEvent.click(screen.getByText('switch'));
    // no throw
  });

  it('auto-reconnects when eth_accounts returns addresses', async () => {
    const eth = installEthereum();
    eth._accounts = ['0xDEAD'];
    ethersState.signerAddress = '0xDEAD';
    render(<WalletProvider><Probe /></WalletProvider>);
    await waitFor(() => expect(screen.getByTestId('addr').textContent).not.toBe('none'));
  });

  it('handleAccountsChanged empty -> disconnect', async () => {
    const eth = installEthereum();
    eth._accounts = ['0xDEAD'];
    ethersState.signerAddress = '0xDEAD';
    render(<WalletProvider><Probe /></WalletProvider>);
    await waitFor(() => expect(screen.getByTestId('addr').textContent).not.toBe('none'));
    const listeners = (eth as any)._listeners;
    await act(async () => { listeners.accountsChanged?.forEach((fn: any) => fn([])); });
    await waitFor(() => expect(screen.getByTestId('addr')).toHaveTextContent('none'));
  });

  it('handleAccountsChanged with new account updates address', async () => {
    const eth = installEthereum();
    eth._accounts = ['0xDEAD'];
    ethersState.signerAddress = '0xDEAD';
    render(<WalletProvider><Probe /></WalletProvider>);
    await waitFor(() => expect(screen.getByTestId('addr').textContent).not.toBe('none'));
    const listeners = (eth as any)._listeners;
    await act(async () => { listeners.accountsChanged?.forEach((fn: any) => fn(['0xBEEF'])); });
    await waitFor(() => expect(screen.getByTestId('addr')).toHaveTextContent(/0xBEEF/i));
  });

  it('handleChainChanged re-reads network', async () => {
    const eth = installEthereum();
    eth._accounts = ['0xDEAD'];
    ethersState.signerAddress = '0xDEAD';
    ethersState.chainId = 11155111;
    render(<WalletProvider><Probe /></WalletProvider>);
    await waitFor(() => expect(screen.getByTestId('correct')).toHaveTextContent('true'));
    ethersState.chainId = 1;
    const listeners = (eth as any)._listeners;
    await act(async () => { listeners.chainChanged?.forEach((fn: any) => fn('0x1')); });
    await waitFor(() => expect(screen.getByTestId('correct')).toHaveTextContent('false'));
  });

  it('throws when useWallet used without provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/WalletProvider/);
    spy.mockRestore();
  });
});
