import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/*
 * #564 D.1 — CollateralLienCard unit test.
 *
 * The card is a pure render of an `Encumbrance` plus role-specific copy.
 * It isolates cleanly: mock the i18n surface (return the key so assertions
 * are language-agnostic) and the token-meta lookup (so `<TokenAmount>` /
 * the symbol line don't reach for a chain client). This test runs without
 * the page-level wagmi / localStorage harness that Issue #85 leaves broken.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// The symbol line consults useTokenMeta directly. Return a fixed meta so
// the `<symbol> (<address>)` row is deterministic.
vi.mock('../../src/lib/tokenMeta', () => ({
  useTokenMeta: () => ({ address: '0xCOL', symbol: 'mUSDC', decimals: 18 }),
}));

// Keep the test focused on CollateralLienCard's own branching — stub the
// two presentational children so we don't pull in their i18n / ENS / format
// transitive imports (which reach src/i18n bootstrap).
vi.mock('../../src/components/app/TokenAmount', () => ({
  TokenAmount: ({ amount }: { amount: bigint }) => <span>{amount.toString()}</span>,
}));
vi.mock('../../src/components/app/AddressDisplay', () => ({
  AddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
}));

import { CollateralLienCard } from '../../src/components/loanDetails/CollateralLienCard';
import type { Encumbrance } from '../../src/types/encumbrance';

const EXPLORER = 'https://basescan.org';

function mkLien(over: Partial<Encumbrance> = {}): Encumbrance {
  return {
    user: '0xBORROWER0000000000000000000000000000abcd',
    asset: '0xCOL',
    tokenId: 0n,
    amount: 2n * 10n ** 18n,
    assetType: 0,
    released: false,
    ...over,
  };
}

describe('CollateralLienCard', () => {
  it('renders the lien card for an active lien', () => {
    render(<CollateralLienCard lien={mkLien()} blockExplorer={EXPLORER} role="borrower" />);
    expect(screen.getByText(/loanDetails\.lien\.title/)).toBeInTheDocument();
    // Active status label (key) shows for a live, un-released lien.
    expect(screen.getByText('loanDetails.lien.statusActive')).toBeInTheDocument();
    // Symbol + address rendered on the asset row.
    expect(screen.getByText(/mUSDC \(0xCOL\)/)).toBeInTheDocument();
  });

  it('shows the lender explorer-proof link for the lender role', () => {
    render(<CollateralLienCard lien={mkLien()} blockExplorer={EXPLORER} role="lender" />);
    const link = screen.getByRole('link', { name: /loanDetails\.lien\.verifyOnChain/ });
    expect(link).toHaveAttribute('href', `${EXPLORER}/address/${mkLien().user}`);
    expect(screen.getByText('loanDetails.lien.lenderNote')).toBeInTheDocument();
  });

  it('shows the borrower lock warning for the borrower role', () => {
    render(<CollateralLienCard lien={mkLien()} blockExplorer={EXPLORER} role="borrower" />);
    expect(screen.getByText('loanDetails.lien.borrowerNote')).toBeInTheDocument();
    // No explorer link for the borrower view.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders Released status for a lifted-but-nonzero lien', () => {
    render(
      <CollateralLienCard
        lien={mkLien({ released: true, amount: 5n * 10n ** 18n })}
        blockExplorer={EXPLORER}
      />,
    );
    expect(screen.getByText('loanDetails.lien.statusReleased')).toBeInTheDocument();
  });

  it('renders nothing when there is no live lien (released + zero amount)', () => {
    const { container } = render(
      <CollateralLienCard
        lien={mkLien({ released: true, amount: 0n })}
        blockExplorer={EXPLORER}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when lien is null', () => {
    const { container } = render(
      <CollateralLienCard lien={null} blockExplorer={EXPLORER} role="lender" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Finding 2 — `getLoanCollateralLien` returns a DEFAULT zero record
  // (user == address(0), amount == 0) for loans that never had a collateral
  // lien (e.g. NFT-rental loans). That bogus record must render NOTHING,
  // even though it's un-released.
  it('renders nothing for the default zero-filled never-encumbered record', () => {
    const { container } = render(
      <CollateralLienCard
        lien={mkLien({
          user: '0x0000000000000000000000000000000000000000',
          amount: 0n,
          released: false,
        })}
        blockExplorer={EXPLORER}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Also: a positive-amount record whose `user` is somehow the zero address
  // is still a non-live default and must not render a card.
  it('renders nothing when the lien user is the zero address', () => {
    const { container } = render(
      <CollateralLienCard
        lien={mkLien({
          user: '0x0000000000000000000000000000000000000000',
          amount: 5n,
          released: false,
        })}
        blockExplorer={EXPLORER}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Finding 3 — ERC-721 / ERC-1155 lien amounts are token COUNTS, not 18-dec
  // wei, and must render as the raw count, never via <TokenAmount> (which
  // would apply 18 decimals and show `0.000…001`).
  it('renders an ERC-721 lien as a raw count with the tokenId, not a decimal', () => {
    render(
      <CollateralLienCard
        lien={mkLien({ assetType: 1, amount: 1n, tokenId: 42n })}
        blockExplorer={EXPLORER}
        role="lender"
      />,
    );
    // Raw "1" count + the pluralization key (mock returns the key) — NOT the
    // <TokenAmount> mock, which would print the raw bigint "1" for a count
    // but the assertion below pins the count + tokenId presentation.
    expect(
      screen.getByText(/1\s+loanDetails\.lien\.tokenCountSuffix/),
    ).toBeInTheDocument();
    // The exact pledged NFT id is surfaced for the single-NFT case.
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('renders an ERC-1155 lien quantity as a raw count', () => {
    render(
      <CollateralLienCard
        lien={mkLien({ assetType: 2, amount: 7n, tokenId: 9n })}
        blockExplorer={EXPLORER}
        role="borrower"
      />,
    );
    expect(
      screen.getByText(/7\s+loanDetails\.lien\.tokenCountSuffix/),
    ).toBeInTheDocument();
    // ERC-1155 does NOT append the single-NFT "#id" suffix (quantity-based).
    expect(screen.queryByText(/#9/)).not.toBeInTheDocument();
  });
});
