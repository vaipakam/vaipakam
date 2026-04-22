import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// `useWallet` is mutated per-test. By default the wallet is connected on an
// unsupported chain so the banner renders — tests that want it hidden flip
// either `address` or `isCorrectChain`.
const walletState: {
  address: string | null;
  chainId: number | null;
  isCorrectChain: boolean;
  switchToDefaultChain: () => Promise<void>;
} = {
  address: '0xUSER',
  chainId: 999_999,
  isCorrectChain: false,
  switchToDefaultChain: vi.fn(async () => {}),
};
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletState,
}));

import { UnsupportedChainBanner } from '../../src/components/app/UnsupportedChainBanner';

beforeEach(() => {
  walletState.address = '0xUSER';
  walletState.chainId = 999_999;
  walletState.isCorrectChain = false;
  walletState.switchToDefaultChain = vi.fn(async () => {});
});

describe('UnsupportedChainBanner', () => {
  it('renders nothing when no wallet is connected', () => {
    walletState.address = null;
    const { container } = render(<UnsupportedChainBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the wallet is on a supported chain', () => {
    walletState.isCorrectChain = true;
    const { container } = render(<UnsupportedChainBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Unsupported network" copy when the chainId is not in the registry', () => {
    walletState.chainId = 999_999;
    render(<UnsupportedChainBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Unsupported network/i)).toBeInTheDocument();
    expect(screen.getByText(/chainId 999999/i)).toBeInTheDocument();
  });

  it('shows "Phase 1 Diamond pending" copy when the chain is registered but has no Diamond yet', () => {
    // Ethereum mainnet (1) is in the registry but has no Diamond in Phase 1.
    walletState.chainId = 1;
    render(<UnsupportedChainBanner />);
    expect(screen.getByText(/Phase 1 Diamond pending/i)).toBeInTheDocument();
    expect(screen.getByText(/chainId 1/i)).toBeInTheDocument();
  });

  it('mentions the currently-live chains in the "currently live on:" sentence', () => {
    render(<UnsupportedChainBanner />);
    // Sepolia is the one chain with a diamondAddress in the default config.
    expect(screen.getByText(/currently live on:.*Sepolia/i)).toBeInTheDocument();
  });

  it('lists mainnet rollout targets when any registered mainnet is still pending', () => {
    render(<UnsupportedChainBanner />);
    const alert = screen.getByRole('alert');
    // Every mainnet in the Phase 1 registry is pending, so all five should
    // be named in the rollout sentence.
    expect(alert.textContent).toMatch(/Mainnet rollout to .+ is planned for Phase 1/i);
    expect(alert.textContent).toMatch(/Ethereum/);
    expect(alert.textContent).toMatch(/Base/);
    expect(alert.textContent).toMatch(/Polygon/);
  });

  it('triggers the network switch when the CTA button is clicked', () => {
    render(<UnsupportedChainBanner />);
    const btn = screen.getByRole('button', { name: /Switch to/i });
    fireEvent.click(btn);
    expect(walletState.switchToDefaultChain).toHaveBeenCalledTimes(1);
  });

  it('falls back to "unknown" when chainId is null', () => {
    walletState.chainId = null;
    render(<UnsupportedChainBanner />);
    expect(screen.getByText(/chainId unknown/i)).toBeInTheDocument();
  });
});
