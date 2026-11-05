import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import '../../test/i18n';
import { OPEN, closed, unknownVerdict } from '../eligibility/types';
import type { Receipt as ReceiptModel } from '../receipt/types';
import { summarize } from '../tx/outcome';
import { ActionList } from './ActionList';
import { FinishCard } from './FinishCard';
import { Receipt, renderValue } from './Receipt';

const USDC = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const UNKNOWN_ASSET = ('0x' + 'b'.repeat(40)) as `0x${string}`;
const describeAsset = (asset: `0x${string}`) => (asset === USDC ? { symbol: 'USDC', decimals: 6 } : null);

const receipt: ReceiptModel = {
  title: 'Repay in full',
  rows: [
    { label: 'You pay', value: { kind: 'amount', asset: USDC, amount: 1_500_000n }, binding: true },
    { label: 'Collateral released', value: { kind: 'amount', asset: UNKNOWN_ASSET, amount: 1n }, binding: true },
    { label: 'Late fee', value: { kind: 'unknown', why: 'the clock view could not be read' }, binding: true },
  ],
  consequences: ['Once paid, the loan closes and the collateral returns to your vault.'],
  prompts: 1,
  readAt: 1_000_000,
};

const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

describe('Receipt', () => {
  it('renders every row, marking an unknown as unknown and never as a figure', () => {
    const out = html(createElement(Receipt, { receipt, describeAsset, nowMs: 1_061_000 }));
    expect(out).toContain('1.5 USDC');
    expect(out).toContain('Unknown: asset 0xbbbb…bbbb not identified');
    expect(out).not.toMatch(/>1<\/dd>/);
    expect(out).toContain('Unknown: the clock view could not be read');
    expect(out).toContain('Wallet prompts: 1.');
    expect(out).toContain('Figures read 1 min ago.');
    expect(out).toContain('Once paid, the loan closes');
    expect((out.match(/data-binding="true"/g) ?? []).length).toBe(3);
  });
  it('renderValue states a time in UTC', () => {
    expect(renderValue({ kind: 'time', unixSeconds: 1_700_000_000 }, describeAsset, 'Unknown')).toEqual({ text: '2023-11-14 22:13 UTC', unknown: false });
  });
});

describe('FinishCard', () => {
  it('states a partial outcome as partial, one leg per effect with its reason', () => {
    const outcome = summarize(
      [
        { status: 'done', label: 'Repay' },
        { status: 'unknown', label: 'Collateral returned', reason: 'the vault balance could not be read' },
      ],
      1,
    );
    const out = html(createElement(FinishCard, { card: { receipt, outcome, next: { label: 'See the position', to: '/positions/1' } }, describeAsset, nowMs: 1_000_000 }));
    expect(out).toContain('Partly done');
    expect(out).toContain('Repay</span>: done');
    expect(out).toContain('Collateral returned</span>: the vault balance could not be read');
    expect(out).toContain('href="/positions/1"');
    expect(out).toContain('Repay in full');
  });
});

describe('ActionList', () => {
  it('withholds a control under an unknown verdict and disables one under a closed verdict with its refusals', () => {
    const out = html(
      createElement(ActionList, {
        actions: [
          { id: 'repay', label: 'Repay', verdict: OPEN, to: '/repay', primary: true },
          { id: 'extend', label: 'Extend', verdict: unknownVerdict('not read'), onStart: () => {} },
          {
            id: 'sell',
            label: 'Sell',
            verdict: closed([{ code: 'SaleListingActive', reason: 'A sale is already listed.', reopensAt: 1_700_000_000, remedy: { label: 'See the listing', to: '/offers/3' } }], null, 1, 'own'),
            onStart: () => {},
          },
        ],
      }),
    );
    expect(out).toContain('href="/repay"');
    expect(out).toContain('Extend: checking whether this is open');
    expect(out).not.toMatch(/<button[^>]*>Extend<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Sell<\/button>/);
    expect(out).toContain('A sale is already listed.');
    expect(out).toContain('May reopen at 2023-11-14 22:13 UTC.');
    expect(out).toContain('href="/offers/3"');
  });
});
