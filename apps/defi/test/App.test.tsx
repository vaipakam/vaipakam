import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '../src/context/ThemeContext';
import { WalletProvider } from '../src/context/WalletContext';
import { ModeProvider } from '../src/context/ModeContext';

// Replace router with a no-op memory router so App's BrowserRouter still works
vi.mock('ethers', () => ({
  BrowserProvider: class { async send() {} async getSigner() { return { getAddress: async () => '0x0' }; } async getNetwork() { return { chainId: 1n }; } },
  JsonRpcSigner: class {},
  JsonRpcProvider: class { async getNetwork() { return { chainId: 1n }; } },
  Contract: class { constructor(public addr: string) {} },
  id: (_s: string) => '0x' + '0'.repeat(64),
}));

import App from '../src/App';

describe('App router', () => {
  it('mounts without crashing', () => {
    render(
      <ThemeProvider>
        <WalletProvider>
          <ModeProvider>
            <App />
          </ModeProvider>
        </WalletProvider>
      </ThemeProvider>,
    );
    // Landing page root
    expect(screen.getByRole('heading', { name: /Peer-to-Peer Lending/i })).toBeInTheDocument();
  });
});
