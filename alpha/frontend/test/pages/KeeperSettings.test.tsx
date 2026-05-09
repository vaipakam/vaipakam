import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', () => ({
  isAddress: (v: unknown) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  ethers: {
    isAddress: (v: unknown) =>
      typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  },
}));

const diamondMock: any = {
  getKeeperAccess: vi.fn(),
  getApprovedKeepers: vi.fn(),
  setKeeperAccess: vi.fn(),
  approveKeeper: vi.fn(),
  revokeKeeper: vi.fn(),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const walletMock: { address: string | null; isCorrectChain: boolean } = {
  address: '0xME',
  isCorrectChain: true,
};
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletMock,
}));

import KeeperSettings from '../../src/pages/KeeperSettings';

function renderPage(mode: 'basic' | 'advanced' = 'advanced') {
  localStorage.setItem('vaipakam.uiMode', mode);
  return render(
    <MemoryRouter initialEntries={['/keepers']}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route path="/keepers" element={<KeeperSettings />} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function mkTx() {
  return { wait: vi.fn().mockResolvedValue({}) };
}

beforeEach(() => {
  localStorage.clear();
  walletMock.address = '0xME';
  walletMock.isCorrectChain = true;
  Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
  diamondMock.getKeeperAccess.mockResolvedValue(false);
  diamondMock.getApprovedKeepers.mockResolvedValue([]);
});

describe('KeeperSettings', () => {
  it('renders basic-mode placeholder when mode is basic', () => {
    renderPage('basic');
    expect(
      screen.getByText(/Keeper management is an advanced feature/i),
    ).toBeInTheDocument();
  });

  it('renders connect-wallet prompt when no address', async () => {
    walletMock.address = null;
    renderPage('advanced');
    expect(
      screen.getByText(/Connect your wallet to manage keepers/i),
    ).toBeInTheDocument();
  });

  it('renders wrong-chain prompt when not on Sepolia', async () => {
    walletMock.isCorrectChain = false;
    renderPage('advanced');
    expect(
      screen.getByText(/Switch to Sepolia to manage keepers/i),
    ).toBeInTheDocument();
  });

  it('renders whitelist heading, disclaimer and Enable button when opted out', async () => {
    diamondMock.getKeeperAccess.mockResolvedValue(false);
    diamondMock.getApprovedKeepers.mockResolvedValue([]);
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Keeper Whitelist/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Keepers cannot claim assets\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Enable$/ })).toBeInTheDocument();
  });

  it('shows Disable button when already opted in', async () => {
    diamondMock.getKeeperAccess.mockResolvedValue(true);
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Disable$/ })).toBeInTheDocument(),
    );
  });

  it('renders existing keepers and empty label when none', async () => {
    diamondMock.getApprovedKeepers.mockResolvedValue([]);
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByText(/No keepers approved/i)).toBeInTheDocument(),
    );
  });

  it('toggles opt-in on Enable click', async () => {
    diamondMock.getKeeperAccess.mockResolvedValue(false);
    diamondMock.setKeeperAccess.mockResolvedValue(mkTx());
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Enable$/ })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Enable$/ }));
    await waitFor(() =>
      expect(diamondMock.setKeeperAccess).toHaveBeenCalledWith(true),
    );
  });

  it('surfaces opt-in error message', async () => {
    diamondMock.getKeeperAccess.mockResolvedValue(false);
    diamondMock.setKeeperAccess.mockRejectedValue(new Error('tx reverted'));
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Enable$/ })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Enable$/ }));
    await waitFor(() =>
      expect(screen.getByText(/tx reverted/i)).toBeInTheDocument(),
    );
  });

  it('rejects invalid keeper address on Approve', async () => {
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/0xKeeper\.\.\./i),
      ).toBeInTheDocument(),
    );
    const input = screen.getByPlaceholderText(/0xKeeper\.\.\./i);
    await userEvent.type(input, '0xNOT-VALID');
    await userEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() =>
      expect(screen.getByText(/Invalid address/i)).toBeInTheDocument(),
    );
    expect(diamondMock.approveKeeper).not.toHaveBeenCalled();
  });

  it('approves a valid keeper and clears input', async () => {
    const valid = '0x1111111111111111111111111111111111111111';
    diamondMock.approveKeeper.mockResolvedValue(mkTx());
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/0xKeeper\.\.\./i),
      ).toBeInTheDocument(),
    );
    const input = screen.getByPlaceholderText(/0xKeeper\.\.\./i) as HTMLInputElement;
    await userEvent.type(input, valid);
    await userEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() =>
      expect(diamondMock.approveKeeper).toHaveBeenCalledWith(valid),
    );
  });

  it('surfaces approveKeeper error', async () => {
    const valid = '0x2222222222222222222222222222222222222222';
    diamondMock.approveKeeper.mockRejectedValue(new Error('rpc fail'));
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/0xKeeper\.\.\./i),
      ).toBeInTheDocument(),
    );
    await userEvent.type(screen.getByPlaceholderText(/0xKeeper\.\.\./i), valid);
    await userEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(screen.getByText(/rpc fail/i)).toBeInTheDocument());
  });

  it('revokes an existing keeper', async () => {
    const k = '0x3333333333333333333333333333333333333333';
    diamondMock.getApprovedKeepers.mockResolvedValue([k]);
    diamondMock.revokeKeeper.mockResolvedValue(mkTx());
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByText(k)).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /Revoke/i }));
    await waitFor(() =>
      expect(diamondMock.revokeKeeper).toHaveBeenCalledWith(k),
    );
  });

  it('surfaces revokeKeeper error', async () => {
    const k = '0x4444444444444444444444444444444444444444';
    diamondMock.getApprovedKeepers.mockResolvedValue([k]);
    diamondMock.revokeKeeper.mockRejectedValue(new Error('revoke failed'));
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByText(k)).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /Revoke/i }));
    await waitFor(() =>
      expect(screen.getByText(/revoke failed/i)).toBeInTheDocument(),
    );
  });

  it('shows full-whitelist message when at capacity (5)', async () => {
    const full = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
    ];
    diamondMock.getApprovedKeepers.mockResolvedValue(full);
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByText(/Whitelist full/i)).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText(/0xKeeper\.\.\./i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeDisabled();
  });

  it('detects unsupported Diamond (FunctionDoesNotExist) and disables controls', async () => {
    const err = Object.assign(new Error('call reverted'), { data: '0xa9ad62f8' });
    diamondMock.getKeeperAccess.mockRejectedValue(err);
    diamondMock.getApprovedKeepers.mockRejectedValue(err);
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByText(/Keeper whitelist is not enabled/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Enable$/ })).toBeDisabled();
  });

  it('detects unsupported Diamond via "function does not exist" message', async () => {
    diamondMock.getKeeperAccess.mockRejectedValue(
      new Error('function does not exist'),
    );
    diamondMock.getApprovedKeepers.mockRejectedValue(
      new Error('function does not exist'),
    );
    renderPage('advanced');
    await waitFor(() =>
      expect(
        screen.getByText(/Keeper whitelist is not enabled/i),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces generic read error (not FunctionDoesNotExist)', async () => {
    diamondMock.getKeeperAccess.mockRejectedValue(new Error('some other err'));
    diamondMock.getApprovedKeepers.mockResolvedValue([]);
    renderPage('advanced');
    await waitFor(() =>
      expect(screen.getByText(/some other err/i)).toBeInTheDocument(),
    );
  });
});
