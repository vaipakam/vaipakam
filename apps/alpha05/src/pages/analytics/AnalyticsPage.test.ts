/**
 * RW-74 / RW-75 — the Analytics page states every state of its read: none
 * yet, zero and not read are three different answers, a total is shown with
 * the assets it leaves out, and the treasury's custody is disclosed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import '../../test/i18n';
import type { SupportedChain } from '../../chain/chains';
import type { ProtocolFigures } from '../../shared/analytics/figures';
import { HelpProvider } from '../../shared/help/HelpContext';
import { AnalyticsView } from './AnalyticsPage';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000D1' as Hex;
const TREASURY = '0x00000000000000000000000000000000000000C0' as Hex;
const WETH = '0x00000000000000000000000000000000000000E1' as Hex;
const ODD = '0x00000000000000000000000000000000000000E2' as Hex;
const chain: SupportedChain = {
  chainId: 31337,
  name: 'Anvil',
  rpcEndpoints: [],
  blockExplorer: 'https://explorer.example',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: DIAMOND,
  deployBlock: 7,
};
const NOW = 1_900_000_000;
const E18 = 10n ** 18n;

function figures(over: Partial<ProtocolFigures> = {}): ProtocolFigures {
  return {
    block: { number: 1000n, timestamp: BigInt(NOW - 30) },
    deployedAt: { ok: true, value: 1_800_000_000n },
    symbol: { ok: true, value: 'USD' },
    stats: {
      ok: true,
      value: { users: 0n, activeLoans: 0n, activeOffers: 0n, loansOpened: 0n, volumeLent: 0n, interestPaid: 0n, defaultRateBps: 0n, averageRateBps: 0n },
    },
    locked: { ok: true, value: { total: 0n, erc20Collateral: 0n, nftCollateralLoans: 0n } },
    health: { ok: true, value: { utilizationBps: 0n, collateral: 0n, debt: 0n, paused: false } },
    offersPosted: { ok: true, value: 0n },
    assets: { ok: true, value: { rows: [], meta: {} } },
    custody: { ok: true, value: { kind: 'external', address: TREASURY } },
    feeRates: { ok: true, value: { treasuryShareBps: 200n, loanStartFeeBps: 20n } },
    treasury: { ok: true, value: { heldOnOpenLoanAssets: 0n, feesSinceStart: 0n, feesLastDay: 0n, feesLastWeek: 0n } },
    convert: { ok: true, value: { targets: [], lastConversionAt: 0n } },
    vpfi: { ok: true, value: { kind: 'none' } },
    ...over,
  };
}

const html = (data: ProtocolFigures | null, state: 'reading' | 'ready' | 'failed' = 'ready', error: string | null = null) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        HelpProvider,
        null,
        createElement(AnalyticsView, { chain, figures: { data, state, error, refetch: () => {} }, nowSec: NOW, onPick: () => {} }),
      ),
    ),
  );

describe('AnalyticsView', () => {
  it('says the figures are being read, and that a failed read shows none', () => {
    expect(html(null, 'reading')).toContain('Reading the protocol’s figures on Anvil.');
    expect(html(null, 'failed', 'upstream timeout')).toContain('could not be read, so none is shown (upstream timeout)');
  });

  it('states the block, its age, the start of the counters and the source', () => {
    const out = html(figures());
    expect(out).toContain('Read at block 1000');
    expect(out).toContain('30 s ago');
    expect(out).toContain('Counted since this deployment began at block 7');
    expect(out).toContain(`${chain.blockExplorer}/address/${DIAMOND}`);
    expect(out).toContain('Nothing on this page comes from the app’s indexer database.');
  });

  it('never calls a block from the future fresh', () => {
    const out = html(figures({ block: { number: 1000n, timestamp: BigInt(NOW + 3600) } }));
    expect(out).toContain('how old these figures are is unknown');
    expect(out).not.toContain(' ago.');
  });

  it('says there is no rate before any loan, rather than 0%', () => {
    const out = html(figures());
    expect(out).toContain('None yet: no loan has opened');
    expect(out).toContain('None: no priced collateral on open loans');
    expect(out).not.toContain('>0%<');
  });

  it('shows a rate once loans exist, and a failed group as not read', () => {
    const f = figures({
      stats: {
        ok: true,
        value: { users: 3n, activeLoans: 1n, activeOffers: 2n, loansOpened: 4n, volumeLent: 0n, interestPaid: 0n, defaultRateBps: 0n, averageRateBps: 825n },
      },
      health: { ok: false, reason: 'upstream timeout' },
    });
    const out = html(f);
    expect(out).toContain('8.25%');
    expect(out).toContain('0% of loans opened');
    expect(out).toContain('Not read: upstream timeout');
  });

  it('names the assets a lifetime total leaves out, and keeps recoveries out of interest', () => {
    const f = figures({
      stats: {
        ok: true,
        value: {
          users: 2n,
          activeLoans: 0n,
          activeOffers: 0n,
          loansOpened: 2n,
          volumeLent: 100n * E18,
          interestPaid: 0n,
          defaultRateBps: 0n,
          averageRateBps: 500n,
        },
      },
      assets: {
        ok: true,
        value: {
          rows: [
            {
              asset: WETH,
              principalLent: 5n * E18,
              interestPaid: 0n,
              lentValue: { kind: 'value', value: 100n * E18 },
              interestValue: { kind: 'value', value: 0n },
            },
            { asset: ODD, principalLent: 3n * E18, interestPaid: 0n, lentValue: { kind: 'refused' }, interestValue: { kind: 'refused' } },
          ],
          meta: { [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 }, [ODD.toLowerCase()]: { symbol: 'ODD', decimals: 18 } },
        },
      },
    });
    const out = html(f);
    expect(out).toContain('Amount lent, valued now leaves out ODD, which the protocol cannot value now.');
    expect(out).toContain('Cannot be valued now');
    expect(out).toContain('100.00 USD');
    expect(out).toContain('is a recovery, not interest, and is not counted');
  });

  it('discloses an outside treasury and shows no held balance for it', () => {
    const out = html(figures());
    expect(out).toContain('Fees go straight to the treasury at');
    expect(out).toContain('The protocol contract keeps none of them');
    expect(out).not.toContain('data-testid="analytics-held"');
  });

  it('shows a held balance only when the protocol contract keeps the fees', () => {
    const out = html(figures({ custody: { ok: true, value: { kind: 'diamond', address: DIAMOND } } }));
    expect(out).toContain('The protocol contract keeps the fees itself');
    expect(out).toContain('data-testid="analytics-held"');
    expect(out).toContain('This counts only assets that appear on open loans.');
  });

  it('says the reference currency is unnamed instead of guessing it', () => {
    const out = html(figures({ symbol: { ok: true, value: null } }));
    expect(out).toContain('reference currency not named');
  });

  it('shows the home network’s cap, mintable figure and minter, and the undecided reserve', () => {
    const token = '0x00000000000000000000000000000000000000F1' as Hex;
    const out = html(
      figures({
        vpfi: {
          ok: true,
          value: {
            kind: 'token',
            facts: {
              token,
              home: true,
              name: { ok: true, value: 'Vaipakam DeFi Token' },
              symbol: { ok: true, value: 'VPFI' },
              decimals: { ok: true, value: 18 },
              supply: { ok: true, value: 23_000_000n * E18 },
              owner: { ok: true, value: TREASURY },
              paused: { ok: true, value: false },
              homeFacts: {
                cap: { ok: true, value: 230_000_000n * E18 },
                initialMint: { ok: true, value: 23_000_000n * E18 },
                minter: { ok: true, value: DIAMOND },
              },
            },
          },
        },
      }),
    );
    expect(out).toContain('230,000,000 VPFI');
    expect(out).toContain('207,000,000 VPFI');
    expect(out).toContain(`The protocol contract, ${DIAMOND}`);
    expect(out).toContain('Anvil is VPFI’s home network');
    expect(out).toContain('cannot say such a change must wait');
    expect(out).toContain('undecided: governance has not chosen');
    expect(out.toLowerCase()).not.toContain('insurance');
    expect(out).not.toContain('differs from the 230,000,000');
  });

  it('gives a bridged network no cap of its own and says where the cap lives', () => {
    const token = '0x00000000000000000000000000000000000000F1' as Hex;
    const out = html(
      figures({
        vpfi: {
          ok: true,
          value: {
            kind: 'token',
            facts: {
              token,
              home: false,
              name: { ok: true, value: 'VPFI' },
              symbol: { ok: true, value: 'VPFI' },
              decimals: { ok: false, reason: 'timeout' },
              supply: { ok: true, value: 5n },
              owner: { ok: true, value: TREASURY },
              paused: { ok: true, value: true },
              homeFacts: null,
            },
          },
        },
      }),
    );
    expect(out).toContain('Supply on this network');
    expect(out).toContain('5 base units (decimals not read)');
    expect(out).toContain('The cap belongs to');
    expect(out).not.toContain('data-testid="analytics-vpfi-cap"');
    expect(out).toContain('VPFI transfers are paused on Anvil.');
  });

  it('says a network has no VPFI token, or that it could not be read', () => {
    expect(html(figures())).toContain('No VPFI token is set on Anvil.');
    expect(html(figures({ vpfi: { ok: false, reason: 'upstream timeout' } }))).toContain('The VPFI token on Anvil could not be read (upstream timeout).');
  });
});
