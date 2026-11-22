import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { FALLBACK_CUSTODY, fallbackEndState, finishBlockers, finishChanged, finishReceipt, finishedInKind, measureFinish, type FallbackEnd, type FinishReview } from './fallbackEnd';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const CALLER = '0x00000000000000000000000000000000000000aa' as Hex;
const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;

const end = (over: Partial<FallbackEnd> = {}): FallbackEnd => ({ enteredAt: 1_000n, waitSeconds: 2_592_000n, endAt: 2_593_000n, finishable: false, ...over });
const review = (over: Partial<FinishReview> = {}): FinishReview => ({ identity: '1:0xaa', loanId: 7n, end: end({ finishable: true }), dryRun: null, readAt: 1, ...over });

function finishedLog(loanId: bigint, lenderPart: bigint, treasuryPart: bigint, borrowerPart: bigint, address: Hex = DIAMOND): Log {
  const abi = FALLBACK_CUSTODY as Abi;
  const args = { loanId, lenderPart, treasuryPart, borrowerPart, caller: CALLER };
  const event = abi.find((e) => e.type === 'event' && e.name === 'FallbackFinishedInKind') as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: 'FallbackFinishedInKind', args } as never);
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => (args as Record<string, unknown>)[i.name]));
  return { address, topics, data } as unknown as Log;
}

describe('fallback dated end state', () => {
  it('says none when the protocol reports no date', () => {
    expect(fallbackEndState(end({ enteredAt: 0n, waitSeconds: 0n, endAt: 0n }), 5_000_000).kind).toBe('none');
  });
  it('waits before the date, and takes the protocol’s word once it is finishable', () => {
    expect(fallbackEndState(end(), 2_000_000).kind).toBe('waiting');
    expect(fallbackEndState(end({ finishable: true }), 2_000_000).kind).toBe('finishable');
  });
  it('says held when the date has passed but the protocol does not allow the finish (a pause)', () => {
    expect(fallbackEndState(end(), 3_000_000).kind).toBe('held');
  });
});

describe('finish review', () => {
  it('is blocked when not finishable, when the dry run is unread, and when it refuses', () => {
    expect(finishBlockers(review(), copy)).toEqual([]);
    expect(finishBlockers(review({ end: end() }), copy)).toEqual(['fallbackEnd.notFinishableNow']);
    expect(finishBlockers(review({ end: end({ endAt: 0n }) }), copy)).toEqual(['fallbackEnd.noneNow']);
    expect(finishBlockers(review({ dryRun: 'unread' }), copy)).toEqual(['fallbackEnd.dryRunUnread']);
    expect(finishBlockers(review({ dryRun: { code: 'X', reason: 'no', reopensAt: null, remedy: null } }), copy)).toEqual(['repay.dryRunRefused{"reason":"no"}']);
  });
  it('reopens only when whether it can be finished changes, not when the date moves', () => {
    expect(finishChanged(review(), review({ end: end({ finishable: true, endAt: 2_600_000n }) }), copy)).toBeNull();
    expect(finishChanged(review(), review({ end: end() }), copy)).toBe('fallbackEnd.changed');
  });
  it('states the caller receives nothing, and what the finish does', () => {
    const r = finishReceipt(review(), copy);
    expect(r.rows.map((x) => x.label)).toEqual(['fallbackEnd.rowEnd', 'fallbackEnd.rowYouGet']);
    expect(r.rows[1]!.value).toEqual({ kind: 'text', text: 'fallbackEnd.youGetNothing' });
    expect(r.consequences).toEqual(['fallbackEnd.applySplit', 'fallbackEnd.defaulted', 'fallbackEnd.eachClaims', 'loanClaim.pauseHolds']);
    expect(r.prompts).toBe(1);
  });
});

describe('finish record', () => {
  it('reads only this loan’s finish from the Diamond', () => {
    expect(finishedInKind([finishedLog(8n, 1n, 1n, 1n)], DIAMOND, 7n)).toBeNull();
    expect(finishedInKind([finishedLog(7n, 1n, 1n, 1n, '0x00000000000000000000000000000000000000e1')], DIAMOND, 7n)).toBeNull();
    const got = finishedInKind([finishedLog(7n, 60n, 5n, 35n)], DIAMOND, 7n);
    expect(got).toMatchObject({ lenderPart: 60n, treasuryPart: 5n, borrowerPart: 35n });
    expect(got!.caller.toLowerCase()).toBe(CALLER);
  });
  it('measures the finish and the split the protocol recorded', () => {
    const legs = measureFinish(review(), [finishedLog(7n, 60n, 5n, 35n)], DIAMOND, (v) => `${v}`, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(legs.map((l) => l.label)).toEqual([
      'fallbackEnd.legFinished{"id":"7"}',
      'fallbackEnd.legLender{"amount":"60"}',
      'fallbackEnd.legBorrower{"amount":"35"}',
      'fallbackEnd.legTreasury{"amount":"5"}',
    ]);
    expect(measureFinish(review(), [], DIAMOND, (v) => `${v}`, copy)).toEqual([{ status: 'not-done', label: 'fallbackEnd.legFinished{"id":"7"}', reason: 'fallbackEnd.notFinished' }]);
  });
});
