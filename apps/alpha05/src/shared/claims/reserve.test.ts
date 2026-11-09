import { encodeAbiParameters, encodeEventTopics, parseAbi, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { AutoLifecycleFacetABI } from '@vaipakam/contracts/abis';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { discoverReserveLoans, RESERVE_KINDS, reserveDrawable, reserveLogs, reserveRowKey, reserveRowShown, reserveVerdict, type ReserveRow } from './reserve';
import { measureReserve, reserveBlockers, reserveReceipt, type ReserveReview } from './reserveReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000aa' as Hex;
const OTHER = '0x00000000000000000000000000000000000000bb' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;
const words = { amount: (_a: Hex, v: bigint) => `${v}` };

function row(over: Partial<ReserveRow> = {}, loan: Partial<LoanDetails> = {}): ReserveRow {
  return {
    loanId: 7n,
    loan: { status: 0, assetType: 0, periodicInterestCadence: 0, principalAsset: WETH, borrowerTokenId: 2n, ...loan } as LoanDetails,
    funding: { asset: WETH, reserved: 500n, otherFree: 0n, chargeNow: 10n, chargeAtGraceEnd: 40n },
    borrowerHolder: ME,
    ...over,
  };
}
const code = (v: ReturnType<typeof reserveVerdict>) => (v.state === 'open' ? 'open' : v.state === 'unknown' ? 'unknown' : v.refusals[0]!.code);

describe('extension reserve rules', () => {
  it('lets an extension draw only on a running ERC-20 loan with no cadence, for the borrower position’s holder', () => {
    expect(reserveDrawable(row(), ME)).toBe(true);
    // The position moved: an extension charges only the current holder.
    expect(reserveDrawable(row({ borrowerHolder: OTHER }), ME)).toBe(false);
    expect(reserveDrawable(row({}, { status: 1 }), ME)).toBe(false);
    expect(reserveDrawable(row({}, { assetType: 1 }), ME)).toBe(false);
    expect(reserveDrawable(row({}, { periodicInterestCadence: 1 }), ME)).toBe(false);
    // Ended: no extension, whatever the holder read says.
    expect(reserveDrawable(row({ borrowerHolder: null }, { status: 1 }), ME)).toBe(false);
    // Running with the holder unread: not shown as safe from an extension.
    expect(reserveDrawable(row({ borrowerHolder: null }), ME)).toBeNull();
    expect(reserveDrawable(row({ loan: null }), ME)).toBeNull();
  });

  it('lists a reserve left, and a row that could not be read, never an empty reserve', () => {
    expect(reserveRowShown(row())).toBe(true);
    expect(reserveRowShown(row({ funding: null }))).toBe(true);
    expect(reserveRowShown(row({ funding: { asset: WETH, reserved: 0n, otherFree: 0n, chargeNow: 0n, chargeAtGraceEnd: 0n } }))).toBe(false);
  });

  it('checks the pause first, then a flagged wallet, then what is reserved', () => {
    expect(code(reserveVerdict(row(), false, copy, 1))).toBe('open');
    expect(code(reserveVerdict(row(), null, copy, 1))).toBe('unknown');
    const paused = reserveVerdict(row(), true, copy, 1);
    expect(code(paused)).toBe('EnforcedPause');
    expect(paused.state !== 'open' && paused.switchClass).toBe('2');
    expect(code(reserveVerdict(row(), false, copy, 1, 'flagged'))).toBe('SanctionedAddress');
    // The caller screen lets an outage through: the dry run decides.
    expect(code(reserveVerdict(row(), false, copy, 1, 'outage'))).toBe('open');
    expect(code(reserveVerdict(row({ funding: null }), false, copy, 1))).toBe('unknown');
    expect(code(reserveVerdict(row({ funding: { asset: WETH, reserved: 0n, otherFree: 0n, chargeNow: 0n, chargeAtGraceEnd: 0n } }), false, copy, 1))).toBe(
      'ExtendReserveZeroAmount',
    );
    // Open whatever the loan's state, and whoever holds the position now.
    expect(code(reserveVerdict(row({ borrowerHolder: OTHER }, { status: 1 }), false, copy, 1))).toBe('open');
  });

  it('reopens a review when the reserve, the loan or the holder moves', () => {
    expect(reserveRowKey(row())).not.toBe(reserveRowKey(row({ funding: { asset: WETH, reserved: 400n, otherFree: 0n, chargeNow: 10n, chargeAtGraceEnd: 40n } })));
    expect(reserveRowKey(row())).not.toBe(reserveRowKey(row({ borrowerHolder: OTHER })));
  });
});

describe('reserve discovery', () => {
  it('asks the index for the three reserve steps filed under the wallet', async () => {
    const asked: string[] = [];
    const indexer = { origin: 'x', getJson: async (p: string) => (asked.push(p), { events: [{ loanId: 4 }, { loanId: 4 }], nextBefore: null }) } as never;
    expect(await discoverReserveLoans(indexer, 84532, ME)).toEqual({ loanIds: [4n], complete: true });
    expect(decodeURIComponent(asked[0]!)).toContain(`kind=${RESERVE_KINDS.join(',')}`);
    expect(asked[0]).toContain('actor=' + ME);
  });
});

function log(abi: Abi, address: Hex, eventName: string, args: Record<string, unknown>): Log {
  const event = abi.find((e) => e.type === 'event' && e.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((i) => args[i.name]),
  );
  return { address, topics: topics as [Hex, ...Hex[]], data } as unknown as Log;
}
const AUTO = AutoLifecycleFacetABI as Abi;
const ERC20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']) as Abi;
const withdrawn = (amount: bigint, reserved = 0n, loanId = 7n) => log(AUTO, DIAMOND, 'ExtendReserveWithdrawn', { loanId, holder: ME, asset: WETH, amount, reserved });
const transfer = (amount: bigint) => log(ERC20, WETH, 'Transfer', { from: OTHER, to: ME, value: amount });

function review(r: ReserveRow, over: Partial<ReserveReview> = {}): ReserveReview {
  return { identity: '1:0xaa', loanId: 7n, row: r, paused: false, protection: null, route: 'wallet', frozen: null, dryRun: null, verdict: OPEN, readAt: 1, ...over };
}

describe('reserve withdrawal record', () => {
  it('reads only this wallet’s withdrawal on this loan', () => {
    expect(reserveLogs([withdrawn(500n), withdrawn(9n, 0n, 8n)], DIAMOND, 7n, ME)).toEqual([{ asset: WETH, amount: 500n, reserved: 0n }]);
  });

  it('measures the withdrawal where it landed, and says what stays reserved', () => {
    const r = review(row());
    expect(measureReserve(r, [withdrawn(500n), transfer(500n)], DIAMOND, ME, words, copy).map((l) => l.status)).toEqual(['done']);
    expect(measureReserve(r, [], DIAMOND, ME, words, copy)[0]!.status).toBe('not-done');
    const left = measureReserve(r, [withdrawn(500n, 30n), transfer(500n)], DIAMOND, ME, words, copy);
    expect(left.map((l) => l.label)).toContain('reserve.legLeft{"amount":"30"}');
  });

  it('states the reserve and where it lands, and that a running extension loses it', () => {
    const receipt = reserveReceipt(review(row()), ME, copy);
    expect(receipt.rows.map((x) => x.label)).toEqual(['reserve.rowReserved', 'takeBack.rowTo']);
    expect(receipt.rows[0]!.value).toEqual({ kind: 'amount', asset: WETH, amount: 500n });
    expect(receipt.consequences).toContain('reserve.afterDrawable');
    expect(reserveReceipt(review(row({}, { status: 1 })), ME, copy).consequences).not.toContain('reserve.afterDrawable');
  });

  it('says a dry-run refusal for a retired account in its own words', () => {
    const r = review(row(), { dryRun: { code: 'NotAccountManager', reason: 'x', reopensAt: null, remedy: null } });
    expect(reserveBlockers(r, copy)).toEqual(['reserve.notManager']);
    expect(reserveBlockers(review(row(), { dryRun: 'unread' }), copy)).toEqual(['reserve.dryRunUnread']);
  });
});
