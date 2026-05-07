import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

const diamondMock: any = { ownerOf: vi.fn(), tokenURI: vi.fn() };
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

import NftVerifier from '../../src/pages/NftVerifier';

describe('NftVerifier', () => {
  beforeEach(() => {
    diamondMock.ownerOf.mockReset();
    diamondMock.tokenURI.mockReset();
    // NftVerifier gates the form behind advanced mode; seed it so the
    // Token-ID input is rendered on every test.
    localStorage.setItem('vaipakam.uiMode', 'advanced');
  });

  async function submit(id: string) {
    const input = screen.getByPlaceholderText(/Enter Token ID/i);
    await userEvent.type(input, id);
    await userEvent.click(screen.getByRole('button', { name: /Verify/i }));
  }

  it('renders form and contract address', () => {
    renderWithProviders(<NftVerifier />);
    expect(screen.getByRole('button', { name: /Verify/i })).toBeInTheDocument();
    expect(screen.getByText(/Diamond Contract/i)).toBeInTheDocument();
  });

  it('reports burned/nonexistent on zero-address owner', async () => {
    diamondMock.ownerOf.mockResolvedValue('0x0000000000000000000000000000000000000000');
    renderWithProviders(<NftVerifier />);
    await submit('99');
    await waitFor(() => expect(screen.getByText(/does not exist/i)).toBeInTheDocument());
  });

  it('verifies NFT with base64 metadata', async () => {
    diamondMock.ownerOf.mockResolvedValue('0xOWNER');
    const meta = {
      name: 'Vaipakam Loan #1', description: 'Lender position',
      attributes: [{ trait_type: 'Role', value: 'Lender' }],
      image: 'data:image/png;base64,AAA',
    };
    const encoded = 'data:application/json;base64,' + btoa(JSON.stringify(meta));
    diamondMock.tokenURI.mockResolvedValue(encoded);
    renderWithProviders(<NftVerifier />);
    await submit('1');
    await waitFor(() => expect(screen.getByText(/Verified Vaipakam NFT/i)).toBeInTheDocument());
    expect(screen.getByText(/Vaipakam Loan #1/)).toBeInTheDocument();
    expect(screen.getByText('Lender')).toBeInTheDocument();
  });

  it('verifies NFT with plain JSON metadata', async () => {
    diamondMock.ownerOf.mockResolvedValue('0xOWN');
    diamondMock.tokenURI.mockResolvedValue('{"name":"Plain"}');
    renderWithProviders(<NftVerifier />);
    await submit('2');
    await waitFor(() => expect(screen.getByText(/Verified Vaipakam NFT/i)).toBeInTheDocument());
    expect(screen.getByText('Plain')).toBeInTheDocument();
  });

  it('still verifies when tokenURI fails', async () => {
    diamondMock.ownerOf.mockResolvedValue('0xOWN');
    diamondMock.tokenURI.mockRejectedValue(new Error('no uri'));
    renderWithProviders(<NftVerifier />);
    await submit('3');
    await waitFor(() => expect(screen.getByText(/Verified Vaipakam NFT/i)).toBeInTheDocument());
  });

  it('shows error when ownerOf throws', async () => {
    diamondMock.ownerOf.mockRejectedValue({ reason: 'nonexistent token' });
    renderWithProviders(<NftVerifier />);
    await submit('404');
    await waitFor(() => expect(screen.getByText(/nonexistent token/i)).toBeInTheDocument());
  });
});
