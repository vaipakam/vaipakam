import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VPFIPanel } from '../../src/pages/Dashboard';

const TOKEN = '0xDeaDBeefdeAdbEEfDeADBeEfDeaDbEEfDEadbeEF';
const MINTER = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

function mkVpfi(over: any = {}) {
  return {
    token: TOKEN,
    registered: true,
    totalSupply: 1_000_000,
    cap: 230_000_000,
    capHeadroom: 229_000_000,
    circulatingShare: 1_000_000 / 230_000_000,
    minter: MINTER,
    fetchedAt: 0,
    ...over,
  };
}

function mkUserVpfi(over: any = {}) {
  return {
    token: TOKEN,
    registered: true,
    balance: 250,
    shareOfCirculating: 0.25,
    treasury: TREASURY,
    recentMints: [],
    recentTransfers: [],
    fetchedAt: 0,
    ...over,
  };
}

describe('VPFIPanel', () => {
  it('renders the unregistered empty state when the token is not bound', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi({ registered: false })}
        userVpfi={mkUserVpfi({ registered: false })}
        networkName="Sepolia"
        networkChainId={11155111}
        blockExplorer="https://sepolia.etherscan.io"
        isCanonicalVPFI={false}
      />,
    );
    expect(screen.getByText(/VPFI is not yet registered/i)).toBeInTheDocument();
    expect(screen.getByText(/setVPFIToken/i)).toBeInTheDocument();
  });

  it('shows the network badge and chainId', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi()}
        networkName="Base Sepolia"
        networkChainId={84532}
        blockExplorer="https://sepolia.basescan.org"
        isCanonicalVPFI={true}
      />,
    );
    expect(screen.getByText(/Base Sepolia · chainId 84532/i)).toBeInTheDocument();
  });

  it('renders a Canonical badge on the canonical chain', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi()}
        networkName="Base"
        networkChainId={8453}
        blockExplorer="https://basescan.org"
        isCanonicalVPFI={true}
      />,
    );
    expect(screen.getByText(/^Canonical$/)).toBeInTheDocument();
    expect(screen.queryByText(/^Mirror$/)).toBeNull();
  });

  it('renders a Mirror badge on non-canonical chains', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi()}
        networkName="Polygon"
        networkChainId={137}
        blockExplorer="https://polygonscan.com"
        isCanonicalVPFI={false}
      />,
    );
    expect(screen.getByText(/^Mirror$/)).toBeInTheDocument();
  });

  it('shows balance, share-of-circulating, and explorer links when registered', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi({ balance: 500, shareOfCirculating: 0.5 })}
        networkName="Sepolia"
        networkChainId={11155111}
        blockExplorer="https://sepolia.etherscan.io"
        isCanonicalVPFI={false}
      />,
    );
    expect(screen.getByText(/Your VPFI balance/i)).toBeInTheDocument();
    expect(screen.getByText(/Share of circulating/i)).toBeInTheDocument();
    expect(screen.getByText(/50\.00%/)).toBeInTheDocument();

    const tokenLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes(`/address/${TOKEN}`));
    const minterLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes(`/address/${MINTER}`));
    const treasuryLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes(`/address/${TREASURY}`));
    expect(tokenLink).toBeTruthy();
    expect(minterLink).toBeTruthy();
    expect(treasuryLink).toBeTruthy();
  });

  it('renders the empty transfer-state message when no wallet activity exists', () => {
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi({ recentTransfers: [] })}
        networkName="Sepolia"
        networkChainId={11155111}
        blockExplorer="https://sepolia.etherscan.io"
        isCanonicalVPFI={false}
      />,
    );
    expect(
      screen.getByText(/No VPFI transfers touch this wallet on Sepolia yet/i),
    ).toBeInTheDocument();
  });

  it('renders direction labels and makes counterparty a link for non-mint/burn', () => {
    const recentTransfers = [
      {
        direction: 'in' as const,
        counterparty: OTHER,
        amount: 100,
        blockNumber: 10,
        txHash: '0xdead',
        logIndex: 0,
      },
      {
        direction: 'out' as const,
        counterparty: OTHER,
        amount: 25,
        blockNumber: 9,
        txHash: '0xbeef',
        logIndex: 1,
      },
      {
        direction: 'mint' as const,
        counterparty: '0x0000000000000000000000000000000000000000',
        amount: 5,
        blockNumber: 8,
        txHash: '0xcafe',
        logIndex: 2,
      },
    ];
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi({ recentTransfers })}
        networkName="Sepolia"
        networkChainId={11155111}
        blockExplorer="https://sepolia.etherscan.io"
        isCanonicalVPFI={false}
      />,
    );
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Minted to you')).toBeInTheDocument();

    // The "in" and "out" rows have a counterparty link; "mint" does not.
    const explorerLinks = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.includes(`/address/${OTHER}`));
    // two rows (in + out) × one counterparty link each = at least 2 matches
    expect(explorerLinks.length).toBeGreaterThanOrEqual(2);
    // The mint row's counterparty (zero-address) must NOT produce an address link.
    const zeroLink = screen
      .queryAllByRole('link')
      .find((a) =>
        a.getAttribute('href')?.includes('/address/0x0000000000000000000000000000000000000000'),
      );
    expect(zeroLink).toBeFalsy();
  });

  it('renders the Diamond → Treasury mint events table when mints exist', () => {
    const recentMints = [
      { to: TREASURY, amount: 42, blockNumber: 5, txHash: '0xMintTx' },
    ];
    render(
      <VPFIPanel
        vpfi={mkVpfi()}
        userVpfi={mkUserVpfi({ recentMints })}
        networkName="Sepolia"
        networkChainId={11155111}
        blockExplorer="https://sepolia.etherscan.io"
        isCanonicalVPFI={false}
      />,
    );
    expect(screen.getByText(/Diamond → Treasury mint events/i)).toBeInTheDocument();
    // Block number (5) + mint-tx link appear in the mint table.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link')
        .some((a) => a.getAttribute('href')?.includes('/tx/0xMintTx')),
    ).toBe(true);
  });
});
