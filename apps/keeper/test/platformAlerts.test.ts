// apps/keeper/test/platformAlerts.test.ts — #3719: the platform's own record
// of loans, offers and slots, and every step that lowers protection, read
// from the chain.

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseAddressedAlert, renderTelegramAlert, type AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { memoryScanCursors } from '../src/scanCursors';
import { TAIL_BACKLOG, missingPlatformEvents, platformAlerts, type PlatformDeps, type PlatformLog } from '../src/platformAlerts';
import type { SendResult } from '../src/ownerAlertSend';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b2' as Address;
const KEEPER = '0x00000000000000000000000000000000000000c3' as Address;
const USDC = '0x00000000000000000000000000000000000000d4' as Address;
const WETH = '0x00000000000000000000000000000000000000e5' as Address;
const SITE = '0x00000000000000000000000000000000000000f6' as Address;
const ZERO = '0x0000000000000000000000000000000000000000';

const at = (block: number, log: number, tx = `0x${block}`) => ({ block, log, tx });
const loan = (block: number, extra: Record<string, unknown> = {}): PlatformLog[] => [
  { kind: 'LoanInitiated', from: 'diamond', ...at(block, 0), args: { loanId: 7n, offerId: 3n, lender: ALICE, borrower: BOB, principal: 1_000_000_000n, collateralAmount: 10n ** 18n } },
  {
    kind: 'LoanInitiatedDetails',
    from: 'diamond',
    ...at(block, 1),
    args: {
      loanId: 7n,
      lender: ALICE,
      borrower: BOB,
      details: { principalAsset: USDC, interestRateBps: 850n, durationDays: 30n, assetType: 0, collateralAssetType: 0, tokenId: 0n, collateralAsset: WETH, collateralAmount: 10n ** 18n, collateralTokenId: 0n, integrator: SITE, warnings: 3, ...extra },
    },
  },
];

function setup() {
  const sent: AddressedAlert[] = [];
  const st = { head: 1000n, logs: [] as PlatformLog[], outcomes: [] as SendResult[], offerReads: 0 };
  const cursors = memoryScanCursors();
  const deps = (): PlatformDeps => ({
    reads: {
      head: async () => st.head,
      logs: async (from, to) => st.logs.filter((l) => BigInt(l.block) >= from && BigInt(l.block) <= to),
      token: async (a) => (a === USDC ? { symbol: 'USDC', decimals: 6 } : a === WETH ? { symbol: 'WETH', decimals: 18 } : null),
      offer: async () => {
        st.offerReads += 1;
        return { lend: true, assetType: 0, lendingAsset: USDC, tokenId: 0n, collateralAssetType: 0, collateralAsset: WETH, collateralTokenId: 0n, durationDays: 60 };
      },
      slotRate: async () => 500,
    },
    cursors,
    cutoff: Date.now() + 60_000,
    chainId: 84532,
    diamond: '0x0000000000000000000000000000000000000001',
    subscriber: async () => null,
    notify: async (a) => {
      sent.push(a.telegram!.message as AddressedAlert);
      const o = st.outcomes.shift() ?? 'sent';
      return o === 'sent' ? { telegram: 'sent', push: 'off' } : o === 'retry' ? { telegram: 'retry', push: 'off' } : { telegram: 'off', push: 'off' };
    },
    appOrigin: 'https://app.example',
  });
  return { sent, st, cursors, run: () => platformAlerts(deps()) };
}

const en = (m: AddressedAlert) => renderTelegramAlert(parseAddressedAlert(JSON.parse(JSON.stringify(m)))!, { locale: 'en', chainName: 'x', appOrigin: 'https://app.example' }).text;

describe('platformAlerts (#3719)', () => {
  it('finds every event it reads in the exported ABIs', () => {
    expect(missingPlatformEvents()).toEqual([]);
  });

  it('starts at the head, then tells both parties of a loan its true terms', async () => {
    const { sent, st, run } = setup();
    st.logs = loan(900);
    await run();
    expect(sent).toEqual([]);
    st.logs = loan(1001);
    st.head = 1002n;
    const r = await run();
    expect(r.sent).toBe(2);
    expect(sent.map((m) => m.wallet)).toEqual([ALICE, BOB]);
    const text = en(sent[0]!);
    expect(text).toContain('loan #7');
    expect(text).toContain('you are the lender');
    expect(text).toContain('Lent: 1000 USDC');
    expect(text).toContain('Collateral: 1 WETH');
    expect(text).toContain('Interest rate: 8.5% a year.');
    expect(text).toContain('Term: 30 days.');
    expect(text).toContain(`Website named: ${SITE}.`);
    expect(text).toContain('concentration caution level');
    expect(text).toContain('far above the recent average');
    expect(en(sent[1]!)).toContain('you are the borrower');
    await run();
    expect(sent).toHaveLength(2);
  });

  it('says none for no integrator, and unknown for a principal it did not see', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = [loan(1001, { integrator: ZERO })[1]!];
    st.head = 1001n;
    await run();
    expect(en(sent[0]!)).toContain('Website named: none.');
    expect(en(sent[0]!)).toContain('Lent: unknown.');
  });

  it('a retry on the second party sends only that party again', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = loan(1001);
    st.head = 1001n;
    st.outcomes = ['sent', 'retry'];
    expect((await run()).retrying).toBe(1);
    await run();
    expect(sent.map((m) => m.wallet)).toEqual([ALICE, BOB, BOB]);
  });

  it('announces an offer and an edit, but not an offer a loan took in the same transaction', async () => {
    const { sent, st, run } = setup();
    await run();
    const fields = { offerType: 0, assetType: 0, collateralAssetType: 0, amount: 5_000_000n, amountMax: 9_000_000n, tokenId: 0n, collateralAsset: WETH, collateralAmount: 0n, collateralAmountMax: 0n, interestRateBps: 400n, interestRateBpsMax: 600n, durationDays: 14n, integrator: ZERO, linkKind: 1, linkMarginBps: -25, warnings: 4 };
    st.logs = [
      { kind: 'OfferCreatedDetails', from: 'diamond', ...at(1001, 0), args: { offerId: 9n, creator: ALICE, lendingAsset: USDC, fields } },
      { kind: 'OfferCreatedDetails', from: 'diamond', ...at(1002, 0), args: { offerId: 3n, creator: ALICE, lendingAsset: USDC, fields } },
      ...loan(1002).map((l, i) => ({ ...l, log: i + 1 })),
      { kind: 'OfferModified', from: 'diamond', ...at(1003, 0), args: { offerId: 9n, creator: ALICE, amount: 1_000_000n, amountMax: 1_000_000n, interestRateBps: 450n, interestRateBpsMax: 450n, collateralAmount: 0n, collateralAmountMax: 0n, integrator: SITE, linkKind: 0, linkMarginBps: 0, warnings: 0 } },
    ];
    st.head = 1003n;
    const r = await run();
    expect(r.quiet).toBe(2); // the taken offer and the LoanInitiated row itself
    const kinds = sent.map((m) => m.alert.kind);
    expect(kinds).toEqual(['offerPosted', 'loanOpened', 'loanOpened', 'offerPosted']);
    const posted = en(sent[0]!);
    expect(posted).toContain('lending offer #9');
    expect(posted).toContain('posted');
    expect(posted).toContain('Lent: 5 – 9 USDC');
    expect(posted).toContain('4% – 6%');
    expect(posted).toContain('-0.25 percentage points');
    expect(posted).toContain('far below the recent average');
    const edited = en(sent[3]!);
    expect(edited).toContain('edited');
    expect(edited).toContain('Term: 60 days.');
    expect(st.offerReads).toBe(1);
  });

  it('announces a slot with its least rate and its market link', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = [{ kind: 'LenderIntentRateTermsSet', from: 'diamond', ...at(1001, 0), args: { owner: BOB, lendingAsset: USDC, collateralAsset: WETH, slot: 2, linkKind: 1, linkMarginBps: 150, warnings: 0 } }];
    st.head = 1001n;
    await run();
    const t = en(sent[0]!);
    expect(t).toContain('Auto-lend slot 2');
    expect(t).toContain('Least interest rate: 5% a year.');
    expect(t).toContain('+1.5 percentage points');
    expect(t).toContain('Website named: unknown.');
  });

  it('warns of each step that lowers protection, and not of one that raises it', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = [
      { kind: 'VaultRiskTierSet', from: 'diamond', ...at(1001, 0), args: { vault: ALICE, level: 2, previousLevel: 1, usableFrom: 1_800_000_000n } },
      { kind: 'VaultRiskTierSet', from: 'diamond', ...at(1001, 1), args: { vault: ALICE, level: 0, previousLevel: 2, usableFrom: 0n } },
      { kind: 'IlliquidPairConsentSet', from: 'diamond', ...at(1001, 2), args: { vault: ALICE, consent: true, lendAsset: USDC, collAsset: WETH, usableFrom: 0n } },
      { kind: 'KeeperActionsUpdated', from: 'diamond', ...at(1001, 3), args: { user: ALICE, keeper: KEEPER, actions: 3, previousActions: 1 } },
      { kind: 'KeeperActionsUpdated', from: 'diamond', ...at(1001, 4), args: { user: ALICE, keeper: KEEPER, actions: 1, previousActions: 3 } },
      { kind: 'LoanKeeperEnabled', from: 'diamond', ...at(1001, 5), args: { loanId: 7n, keeper: KEEPER, enabled: true, owner: ALICE } },
      { kind: 'OfferKeeperEnabled', from: 'diamond', ...at(1001, 6), args: { offerId: 9n, keeper: KEEPER, enabled: false, owner: ALICE } },
      { kind: 'Approval', from: 'position', ...at(1001, 7), args: { owner: ALICE, approved: BOB, tokenId: 42n } },
      { kind: 'Approval', from: 'position', ...at(1001, 8), args: { owner: ALICE, approved: ZERO, tokenId: 42n } },
      { kind: 'HolderUnlockRequested', from: 'position', ...at(1001, 9), args: { holder: ALICE, executableAt: 1_800_000_000n } },
      { kind: 'LockDelayLowerRequested', from: 'position', ...at(1001, 10), args: { holder: ALICE, newDelay: 7200n, executableAt: 1_800_000_000n } },
    ];
    st.head = 1001n;
    const r = await run();
    expect(r.quiet).toBe(4);
    const texts = sent.map(en);
    expect(texts[0]).toContain('raised from 1 to 2');
    expect(texts[0]).toContain('It takes effect at 2027-01-15 08:00 UTC.');
    expect(texts[1]).toContain('USDC');
    expect(texts[1]).toContain('without a market price');
    expect(texts[2]).toContain(`keeper ${KEEPER}`);
    expect(texts[3]).toContain('loan #7');
    expect(texts[4]).toContain(`approved ${BOB} to move your position token #42`);
    expect(texts[5]).toContain('unlock your position tokens');
    expect(texts[6]).toContain('to 2 hours');
    expect(sent.every((m) => m.wallet === ALICE)).toBe(true);
  });

  it('jumps a backlog wider than it works', async () => {
    const { st, run } = setup();
    await run();
    st.head = 1000n + TAIL_BACKLOG + 50n;
    expect((await run()).skippedBlocks).toBe(49);
  });

  it('refuses a terms field out of shape', () => {
    const terms = { lend: null, collateral: null, rateBps: 1, rateMaxBps: null, days: null, marginBps: null, integrator: 'none', warnings: 0 };
    const raw = { chainId: 1, wallet: ALICE, alert: { kind: 'loanOpened', loanId: '7', lender: true, terms } };
    expect(parseAddressedAlert(raw)).not.toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, terms: { ...terms, lend: 'evil.example/x' } } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, terms: { ...terms, warnings: 8 } } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, loanId: '-1' } })).toBeNull();
    for (const locale of ['es', 'fr', 'de', 'ja', 'zh', 'ko', 'hi', 'ta', 'ar']) {
      const t = renderTelegramAlert(parseAddressedAlert(raw)!, { locale, chainName: 'x', appOrigin: 'https://a' }).text;
      expect(t).not.toBe(renderTelegramAlert(parseAddressedAlert(raw)!, { locale: 'en', chainName: 'x', appOrigin: 'https://a' }).text);
    }
  });
});
