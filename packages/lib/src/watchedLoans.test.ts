import { describe, expect, it } from 'vitest';
import {
  buildListWatchedLoansMessage,
  buildUnwatchLoanMessage,
  buildWatchLoanMessage,
  watchAlertText,
  watchBandOf,
  type WatchEvent,
} from './watchedLoans';

const W = '0xAbC0000000000000000000000000000000000001';

describe('watched-loan signed messages (#3769)', () => {
  it('are pinned verbatim', () => {
    expect(buildWatchLoanMessage(W, 84532, 7, 1_800_000_000)).toBe(
      [
        'Vaipakam — Watch a loan',
        '',
        'I request alerts about the loan below, sent to the Telegram chat',
        'linked to the wallet below. Watching a loan gives no rights over',
        'it. Signing this message proves ownership of the wallet. It is',
        'not a transaction and costs no gas.',
        '',
        'Loan id: 7',
        '',
        'Wallet: 0xabc0000000000000000000000000000000000001',
        'Chain id: 84532',
        'Issued at (unix): 1800000000',
      ].join('\n'),
    );
    expect(buildUnwatchLoanMessage(W, 84532, 7, 1)).toContain('Vaipakam — Stop watching a loan');
    expect(buildListWatchedLoansMessage(W, 84532, 1)).toContain('Vaipakam — Show the loans I watch');
  });

  it('never let one action stand for another, or one loan for another', () => {
    const all = [
      buildWatchLoanMessage(W, 1, 7, 1),
      buildWatchLoanMessage(W, 1, 8, 1),
      buildUnwatchLoanMessage(W, 1, 7, 1),
      buildListWatchedLoansMessage(W, 1, 1),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('watched-loan alerts', () => {
  it('classify the health level into the default bands', () => {
    expect(watchBandOf(2)).toBe('healthy');
    expect(watchBandOf(1.5)).toBe('warn');
    expect(watchBandOf(1.2)).toBe('alert');
    expect(watchBandOf(1.05)).toBe('critical');
  });

  it('say in every message that the wallet holds no position', () => {
    const events: WatchEvent[] = [
      { kind: 'band', band: 'alert', hf: 1.18 },
      { kind: 'due', dueAt: 2_000_000_000, graceEnd: 2_000_100_000, now: 1_999_900_000 },
      { kind: 'due', dueAt: 2_000_000_000, graceEnd: 2_000_100_000, now: 2_000_000_001 },
      { kind: 'repaid' },
      { kind: 'closed', status: 'liquidated' },
      { kind: 'closed', status: 'something-new' },
    ];
    for (const event of events) {
      const text = watchAlertText({ event, chainName: 'Base Sepolia', loanId: 12, appOrigin: 'https://app.example' });
      expect(text).toContain('Your wallet holds no position in it.');
      expect(text).toContain('watched loan #12 on Base Sepolia');
      expect(text).toContain('https://app.example/loans/12');
    }
  });

  it('say when the watch has ended with the loan', () => {
    const text = watchAlertText({ event: { kind: 'repaid' }, chainName: 'X', loanId: 1, appOrigin: 'o' });
    expect(text).toContain('this watch has ended');
    const due = watchAlertText({
      event: { kind: 'due', dueAt: 2_000_000_000, graceEnd: 2_000_100_000, now: 2_000_000_001 },
      chainName: 'X',
      loanId: 1,
      appOrigin: 'o',
    });
    expect(due).toContain('The grace period ends 2033-05-19 07:20 UTC.');
  });
});
