import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

// #1076: NftVerifier does NOT go through the `useDiamond` hooks. It matches
// the pasted contract address against every deployed Diamond in
// CHAIN_REGISTRY, then builds its OWN viem PublicClient via
// `createPublicClient(http(chain.rpcUrl))` and reads through it. Intercept
// viem's `createPublicClient` so every `readContract` resolves against a
// controllable stub instead of a live testnet RPC. `http` is left real so the
// wagmi provider tree (renderWithProviders) still builds its transports.
const readContract = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ readContract }) };
});

// The burned-vs-never-minted branch scans a per-chain event log index over the
// network. Stub it to fail so revert paths resolve deterministically to the
// "never minted" verdict without a real RPC.
vi.mock('../../src/lib/logIndex', () => ({
  loadLoanIndex: vi.fn().mockRejectedValue(new Error('no index in test')),
}));

import NftVerifier from '../../src/pages/NftVerifier';

// Base Sepolia's deployed Diamond (from @vaipakam/contracts/deployments).
// `findChainByDiamond` normalises both sides with `getAddress`, so this must
// be a genuine registry Diamond for the verify flow to reach the reads.
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const OWNER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

// `readContract` dispatches by `functionName`; each test seeds the reads it
// expects. A value may be a plain resolved value or a thrower.
function stubReads(map: Record<string, unknown>) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (!(functionName in map)) throw new Error(`unstubbed read: ${functionName}`);
    const v = map[functionName];
    if (typeof v === 'function') return (v as () => unknown)();
    return v;
  });
}

describe('NftVerifier', () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  // Fill BOTH the contract-address and token-ID inputs (the current page
  // requires both) then submit.
  async function submit(id: string, addr = DIAMOND) {
    await userEvent.type(screen.getByPlaceholderText('0x…'), addr);
    await userEvent.type(screen.getByPlaceholderText('e.g. 6'), id);
    await userEvent.click(screen.getByRole('button', { name: /Verify/i }));
  }

  it('renders form and contract-address label', () => {
    renderWithProviders(<NftVerifier />);
    expect(screen.getByRole('button', { name: /Verify/i })).toBeInTheDocument();
    // #1076: label is "NFT Contract Address" now (was "Diamond Contract").
    expect(screen.getByText(/NFT Contract Address/i)).toBeInTheDocument();
  });

  it('reports not-minted on zero-address owner', async () => {
    stubReads({ ownerOf: ZERO });
    renderWithProviders(<NftVerifier />);
    await submit('99');
    // #1076: a zero-address owner routes through the burned/never-minted
    // branch; with no local log index it lands on the "not been minted" card.
    await waitFor(() =>
      expect(screen.getByText(/not been minted/i)).toBeInTheDocument(),
    );
  });

  it('verifies NFT with base64 metadata', async () => {
    const meta = {
      name: 'Vaipakam Loan #1',
      description: 'Lender position',
      attributes: [{ trait_type: 'Role', value: 'Lender' }],
      image: 'data:image/png;base64,AAA',
    };
    stubReads({
      ownerOf: OWNER,
      tokenURI: 'data:application/json;base64,' + btoa(JSON.stringify(meta)),
      isSanctionedAddress: false,
    });
    renderWithProviders(<NftVerifier />);
    await submit('1');
    // #1076: live-card verdict copy is "Genuine Vaipakam NFT on <chain>"
    // (was "Verified Vaipakam NFT"). The card no longer echoes the metadata
    // name; it surfaces the parsed Role as "Lender position".
    await waitFor(() =>
      expect(screen.getByText(/Genuine Vaipakam NFT/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Lender position/i)).toBeInTheDocument();
  });

  it('verifies NFT with plain JSON metadata', async () => {
    stubReads({ ownerOf: OWNER, tokenURI: '{"name":"Plain"}', isSanctionedAddress: false });
    renderWithProviders(<NftVerifier />);
    await submit('2');
    await waitFor(() =>
      expect(screen.getByText(/Genuine Vaipakam NFT/i)).toBeInTheDocument(),
    );
  });

  it('still verifies when tokenURI read fails', async () => {
    stubReads({
      ownerOf: OWNER,
      isSanctionedAddress: false,
      tokenURI: () => {
        throw new Error('no uri');
      },
    });
    renderWithProviders(<NftVerifier />);
    await submit('3');
    // owner is the authoritative proof; a failed tokenURI still verifies.
    await waitFor(() =>
      expect(screen.getByText(/Genuine Vaipakam NFT/i)).toBeInTheDocument(),
    );
  });

  it('shows decoded error when ownerOf throws a non-revert error', async () => {
    stubReads({
      ownerOf: () => {
        throw { reason: 'nonexistent token' };
      },
    });
    renderWithProviders(<NftVerifier />);
    await submit('404');
    // A thrown error carrying no revert data (not a nonexistent-token revert)
    // surfaces via decodeContractError, which prefers `reason`.
    await waitFor(() =>
      expect(screen.getByText(/nonexistent token/i)).toBeInTheDocument(),
    );
  });
});
