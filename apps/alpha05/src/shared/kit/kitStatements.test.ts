import { describe, expect, it } from 'vitest';
import type { ChainRead } from '../reads/chainRead';
import { borrowerShareLine, entryLine, kitWhat, kitWho, ruleLine } from './kitStatements';
import type { IntegratorEntry, IntegratorShare } from './kit';

const A = '0x1111111111111111111111111111111111111111' as const;
const I = '0x2222222222222222222222222222222222222222' as const;
/** The key and its values, so a test reads which sentence was chosen. */
const format = (key: string, vars: Readonly<Record<string, string>>) => `${key}${Object.keys(vars).length ? ' ' + JSON.stringify(vars) : ''}`;
const read = <T,>(data: T | null, state: ChainRead<T>['state'] = 'ready', error: string | null = null): ChainRead<T> => ({ data, state, error, readAt: 1, refreshing: false, refetch: () => {} });
const meta = { [A]: { symbol: 'USDC', decimals: 6, name: 'USD Coin' } } as never;

describe('kitWhat', () => {
  it('says what each link asks for', () => {
    expect(kitWhat({ action: 'borrow', chainId: 1, asset: A }, meta, format)).toBe('kit.whatBorrow {"asset":"USDC"}');
    expect(kitWhat({ action: 'borrow', chainId: 1, asset: A, tokenId: 7n }, meta, format)).toBe('kit.whatBorrowToken {"asset":"USDC","token":"7"}');
    expect(kitWhat({ action: 'rent', chainId: 1, asset: A, tokenId: 3n }, meta, format)).toBe('kit.whatRent {"asset":"USDC","token":"3"}');
    expect(kitWhat({ action: 'lend', chainId: 1, asset: A, amount: 1_500_000n }, meta, format)).toBe('kit.whatLend {"amount":"1.5 USDC"}');
  });
});

describe('the registry answer', () => {
  it('names the entry beside its address, or the address alone', () => {
    expect(kitWho(I, { status: 'active', name: 'Wallet X' }, format)).toBe(`kit.whoNamed {"name":"Wallet X","address":"${I}"}`);
    expect(kitWho(I, { status: 'none', name: '' }, format)).toBe(I);
    expect(kitWho(I, null, format)).toBe(I);
  });
  it('states each status, and an unread entry as unread', () => {
    expect(entryLine(read<IntegratorEntry>({ status: 'active', name: 'X' }), format)).toBe('kit.entryActive {"name":"X"}');
    expect(entryLine(read<IntegratorEntry>({ status: 'suspended', name: 'X' }), format)).toBe('kit.entrySuspended {"name":"X"}');
    expect(entryLine(read<IntegratorEntry>({ status: 'none', name: '' }), format)).toBe('kit.entryNone');
    expect(entryLine(read<IntegratorEntry>(null, 'failed', 'rpc down'), format)).toBe('kit.entryUnread {"reason":"rpc down"}');
    expect(entryLine(read<IntegratorEntry>(null, 'reading'), format)).toBeNull();
  });
  it('states the rule for each action', () => {
    expect(ruleLine({ action: 'borrow', chainId: 1, asset: A }, format)).toBe('kit.ruleMayApply');
    expect(ruleLine({ action: 'lend', chainId: 1, asset: A, amount: 1n }, format)).toBe('kit.ruleAttribution');
    expect(ruleLine({ action: 'rent', chainId: 1, asset: A, tokenId: 1n }, format)).toBe('kit.ruleNoFee');
  });
});

describe("a borrower's review line", () => {
  it('states the rate the protocol would pay, as a percentage', () => {
    expect(borrowerShareLine('X', read<IntegratorShare>({ rateBps: 1000n, refusal: 'none' }), format)).toBe('kit.reviewShare {"who":"X","rate":"10"}');
  });
  it('states why nothing would be paid', () => {
    expect(borrowerShareLine('X', read<IntegratorShare>({ rateBps: 0n, refusal: 'flagged' }), format)).toBe('kit.reviewShareNot {"who":"X","why":"kit.whyFlagged"}');
    expect(borrowerShareLine('X', read<IntegratorShare>({ rateBps: 0n, refusal: 'borrower-is-integrator' }), format)).toBe('kit.reviewShareNot {"who":"X","why":"kit.whyYou"}');
  });
  it('says an unread answer is unread, never paid or unpaid', () => {
    expect(borrowerShareLine('X', read<IntegratorShare>(null, 'failed', 'rpc down'), format)).toBe('kit.reviewShareUnread {"who":"X","reason":"rpc down"}');
    expect(borrowerShareLine('X', read<IntegratorShare>(null, 'reading'), format)).toBe('kit.reviewShareUnread {"who":"X","reason":"kit.stillReading"}');
  });
});
