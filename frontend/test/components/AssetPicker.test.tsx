import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const topTokensState: { tokens: any[]; loading: boolean } = { tokens: [], loading: false };
const stableTokensState: { tokens: any[]; loading: boolean } = { tokens: [], loading: false };
const verifyState: { result: any; loading: boolean } = { result: null, loading: false };

vi.mock('../../src/hooks/useCoinGecko', () => ({
  useTopTokens: () => topTokensState,
  useStablecoins: () => stableTokensState,
  useVerifyContract: () => verifyState,
}));

// chainPlatforms is a pure module — we exercise it for real instead of mocking.

import { AssetPicker } from '../../src/components/app/AssetPicker';

const USDC_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USDT_ADDR = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const UNKNOWN_ADDR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function mkToken(over: any = {}) {
  return {
    id: over.id ?? 'usd-coin',
    symbol: over.symbol ?? 'USDC',
    name: over.name ?? 'USD Coin',
    contractAddress: (over.contractAddress ?? USDC_ADDR).toLowerCase(),
    image: over.image ?? 'https://example/usdc.png',
    marketCapRank: over.marketCapRank ?? 7,
  };
}

beforeEach(() => {
  topTokensState.tokens = [];
  topTokensState.loading = false;
  stableTokensState.tokens = [];
  stableTokensState.loading = false;
  verifyState.result = null;
  verifyState.loading = false;
});

describe('AssetPicker', () => {
  it('falls back to plain input when the chain has no CoinGecko platform', () => {
    render(
      <AssetPicker
        mode="top"
        chainId={11155111}
        value=""
        onChange={() => {}}
        label="Asset"
      />,
    );
    expect(screen.getByText(/Token discovery is not available/i)).toBeInTheDocument();
    // No dropdown trigger rendered
    expect(screen.queryByPlaceholderText(/Search top 50/i)).toBeNull();
  });

  it('opens the dropdown on input focus and renders the curated list', () => {
    topTokensState.tokens = [mkToken(), mkToken({ id: 'weth', symbol: 'WETH', name: 'Wrapped Ether', contractAddress: '0xc0ffee', marketCapRank: 30 })];
    render(<AssetPicker mode="top" chainId={1} value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByPlaceholderText('0x...'));
    expect(screen.getByPlaceholderText(/Search top 50/i)).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('WETH')).toBeInTheDocument();
  });

  it('shows a Loading… state while the token list is loading', () => {
    topTokensState.loading = true;
    render(<AssetPicker mode="top" chainId={1} value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByPlaceholderText('0x...'));
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
  });

  it('filters the list by search query', () => {
    topTokensState.tokens = [
      mkToken({ id: 'usd-coin', symbol: 'USDC', name: 'USD Coin' }),
      mkToken({ id: 'weth', symbol: 'WETH', name: 'Wrapped Ether', contractAddress: '0xc0ffee' }),
    ];
    render(<AssetPicker mode="top" chainId={1} value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByPlaceholderText('0x...'));
    fireEvent.change(screen.getByPlaceholderText(/Search top 50/i), { target: { value: 'usd' } });
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.queryByText('WETH')).toBeNull();
  });

  it('shows the empty-state hint when no tokens match the search', () => {
    topTokensState.tokens = [mkToken()];
    render(<AssetPicker mode="top" chainId={1} value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByPlaceholderText('0x...'));
    fireEvent.change(screen.getByPlaceholderText(/Search top 50/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
  });

  it('calls onChange with the token address when a row is picked', () => {
    topTokensState.tokens = [mkToken()];
    const onChange = vi.fn();
    render(<AssetPicker mode="top" chainId={1} value="" onChange={onChange} />);
    fireEvent.focus(screen.getByPlaceholderText('0x...'));
    fireEvent.click(screen.getByText('USDC'));
    expect(onChange).toHaveBeenCalledWith(USDC_ADDR);
  });

  it('renders the selected-chip when the value matches a curated token', () => {
    topTokensState.tokens = [mkToken()];
    render(<AssetPicker mode="top" chainId={1} value={USDC_ADDR} onChange={() => {}} />);
    // Selected chip renders the symbol + shortened address.
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByLabelText(/Clear selection/i)).toBeInTheDocument();
  });

  it('clears the selection via the ✕ button without bubbling to the chip', () => {
    topTokensState.tokens = [mkToken()];
    const onChange = vi.fn();
    render(<AssetPicker mode="top" chainId={1} value={USDC_ADDR} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Clear selection/i));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows an error notice on malformed addresses', () => {
    render(<AssetPicker mode="top" chainId={1} value="0xnothex" onChange={() => {}} />);
    expect(screen.getByText(/valid 0x contract address/i)).toBeInTheDocument();
  });

  it('stablecoin mode: unknown-to-CoinGecko custom address → error notice', async () => {
    verifyState.result = { known: false, isStablecoin: false };
    render(<AssetPicker mode="stablecoin" chainId={1} value={UNKNOWN_ADDR} onChange={() => {}} />);
    // mountedOnce flips on first effect — flush effects.
    await act(async () => {});
    expect(screen.getByText(/not recognized by CoinGecko/i)).toBeInTheDocument();
  });

  it('stablecoin mode: non-stablecoin token → error', async () => {
    verifyState.result = { known: true, isStablecoin: false, symbol: 'WETH' };
    render(<AssetPicker mode="stablecoin" chainId={1} value={USDT_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/WETH is not categorized as a stablecoin/i)).toBeInTheDocument();
  });

  it('stablecoin mode: verified stablecoin → info notice', async () => {
    verifyState.result = { known: true, isStablecoin: true, symbol: 'USDT' };
    render(<AssetPicker mode="stablecoin" chainId={1} value={USDT_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/USDT recognized as a stablecoin/i)).toBeInTheDocument();
  });

  it('top mode: unknown-to-CoinGecko token → warning notice', async () => {
    verifyState.result = { known: false };
    render(<AssetPicker mode="top" chainId={1} value={UNKNOWN_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/not listed on CoinGecko/i)).toBeInTheDocument();
  });

  it('top mode: known but outside top 200 → warning with rank', async () => {
    verifyState.result = { known: true, inTop200: false, symbol: 'FOO', marketCapRank: 412 };
    render(<AssetPicker mode="top" chainId={1} value={UNKNOWN_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/FOO is outside the top 200/i)).toBeInTheDocument();
    expect(screen.getByText(/rank #412/)).toBeInTheDocument();
  });

  it('top mode: known and in top 200 → info with rank', async () => {
    verifyState.result = { known: true, inTop200: true, symbol: 'UNI', marketCapRank: 42 };
    render(<AssetPicker mode="top" chainId={1} value={UNKNOWN_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/UNI recognized/)).toBeInTheDocument();
    expect(screen.getByText(/rank #42/)).toBeInTheDocument();
  });

  it('shows "Verifying…" while the verify call is in flight', async () => {
    verifyState.loading = true;
    verifyState.result = null;
    render(<AssetPicker mode="top" chainId={1} value={UNKNOWN_ADDR} onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/Verifying token with CoinGecko/i)).toBeInTheDocument();
  });

  it('suppresses notice when the address matches a curated token', () => {
    topTokensState.tokens = [mkToken()];
    verifyState.result = { known: true, inTop200: true, symbol: 'USDC', marketCapRank: 7 };
    render(<AssetPicker mode="top" chainId={1} value={USDC_ADDR} onChange={() => {}} />);
    expect(screen.queryByText(/recognized/)).toBeNull();
    expect(screen.queryByText(/not listed/)).toBeNull();
  });

  it('renders the hint prop verbatim', () => {
    render(
      <AssetPicker
        mode="top"
        chainId={1}
        value=""
        onChange={() => {}}
        hint="Pick the asset you want to lend."
      />,
    );
    expect(screen.getByText(/Pick the asset you want to lend/)).toBeInTheDocument();
  });

  it('renders a required-marker and disables the input when disabled', () => {
    render(
      <AssetPicker
        mode="top"
        chainId={1}
        value=""
        onChange={() => {}}
        label="Collateral"
        required
        disabled
      />,
    );
    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0x...')).toBeDisabled();
  });
});
