import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StoredOffer } from '../offers/acceptTerms';
import { fillFor, INTENT_ERRORS, intentGapOf, intentRefusalText, riskBlockText, whyIntentOf, type IntentVerdict, type SlotRequest, type WhyIntentRead } from './whyIntent';

const copy = { text: (k: string) => k, format: (k: string, v: Record<string, string>) => `${k}#${v.code ?? ''}` } as never;
const slot = { minRateBps: 500n, maxDurationDays: 30, availableCapital: 1000n, maxExposure: 5000n, livePrincipal: 0n };

const offer = (p: Partial<StoredOffer> = {}): StoredOffer =>
  ({ id: 7n, amount: 400n, amountMax: 0n, amountFilled: 0n, interestRateBps: 300n, interestRateBpsMax: 450n, durationDays: 60n, ...p }) as StoredOffer;
const v = (p: Partial<IntentVerdict> = {}): IntentVerdict => ({ intentError: 0, matchError: 0, riskBlock: 0, matchRateBps: 0n, matchAmount: 0n, ...p });
const req = (rank: number, p: Partial<SlotRequest> = {}): SlotRequest => ({ rank, offer: offer({ id: BigInt(rank + 1) }), state: 'open', fill: 1n, verdict: v(), ...p });
const read = (requests: SlotRequest[]): WhyIntentRead => ({ block: 1n, requests, unread: 0 });

describe('fillFor', () => {
  it('asks the open remainder, capped by the money waiting and the room left', () => {
    expect(fillFor(offer({ amount: 400n, amountMax: 900n, amountFilled: 100n }), slot)).toBe(800n);
    expect(fillFor(offer({ amount: 4000n }), slot)).toBe(1000n);
    expect(fillFor(offer({ amount: 4000n }), { ...slot, availableCapital: 9000n, livePrincipal: 4500n })).toBe(500n);
  });
  it('asks the remainder where the slot has no room, so the protocol names the shortfall', () => {
    expect(fillFor(offer({ amount: 400n }), { ...slot, availableCapital: 0n })).toBe(400n);
  });
});

describe('intentGapOf', () => {
  it('names the rate and the term with their figures', () => {
    expect(intentGapOf(slot, offer(), v({ matchError: 5 }))).toEqual({ kind: 'rate', theirs: 450n, mine: 500n });
    expect(intentGapOf(slot, offer(), v({ intentError: 11 }))).toEqual({ kind: 'term', theirs: 60n, mine: 30 });
  });
  it('names every other refusal by its layer', () => {
    expect(intentGapOf(slot, offer(), v({ intentError: 27 }))).toEqual({ kind: 'intent', code: 27 });
    expect(intentGapOf(slot, offer({ interestRateBpsMax: 900n }), v({ matchError: 5 }))).toEqual({ kind: 'match', code: 5 });
    expect(intentGapOf(slot, offer(), v({ matchError: 9 }))).toEqual({ kind: 'match', code: 9 });
    expect(intentGapOf(slot, offer(), v({ riskBlock: 2 }))).toEqual({ kind: 'risk', code: 2 });
  });
});

describe('whyIntentOf', () => {
  const ranked = (n: number) => ({ ids: Array.from({ length: n }, (_, k) => BigInt(k + 1)), oppositeOpen: n });
  it('says nothing stands on the pair', () => {
    expect(whyIntentOf(slot, { ids: [], oppositeOpen: 0 }, read([]))).toEqual({ kind: 'none' });
  });
  it('names a fill the protocol would take before any gap', () => {
    const w = whyIntentOf(slot, ranked(2), read([req(0, { verdict: v({ matchError: 5 }) }), req(1)]));
    expect(w.kind === 'fillable' && w.with.rank).toBe(1);
  });
  it('states the closest answered refusal, and counts closer requests with no answer', () => {
    const w = whyIntentOf(slot, ranked(3), read([req(0, { verdict: null }), req(1, { state: 'accepted' as never, verdict: null }), req(2, { verdict: v({ intentError: 15 }) })]));
    expect(w).toMatchObject({ kind: 'gap', gap: { kind: 'intent', code: 15 }, closerUnknown: 1 });
  });
  it('says the requests could not be read when none answered open', () => {
    expect(whyIntentOf(slot, ranked(1), read([req(0, { verdict: null })])).kind).toBe('unread');
  });
});

describe('refusal words', () => {
  it('names each slot refusal, and states an unknown one by its number', () => {
    expect(intentRefusalText(15, copy)).toBe('whyIntent.intentCapital');
    expect(intentRefusalText(26, copy)).toBe('whyIntent.intentNoCheckpoint');
    expect(intentRefusalText(28, copy)).toBe('whyIntent.intentUnpriced');
    expect(intentRefusalText(7, copy)).toBe('whyIntent.intentOther#7');
    expect(intentRefusalText(40, copy)).toBe('whyIntent.intentOther#40');
  });
  it('names the risk-access blocks', () => {
    expect([1, 2, 3, 4].map((c) => riskBlockText(c, copy))).toEqual(['whyIntent.riskTier', 'whyIntent.riskConsent', 'whyIntent.riskAck', 'whyIntent.riskConsent']);
    expect(riskBlockText(9, copy)).toBe('whyIntent.riskOther#9');
  });

  it('names every IntentError the contract declares, in order', () => {
    const sol = readFileSync(new URL('../../../../../contracts/src/libraries/LibOfferMatch.sol', import.meta.url), 'utf8');
    const open = sol.indexOf('enum IntentError {');
    const body = sol.slice(open + 'enum IntentError {'.length, sol.indexOf('}', open));
    const names = body
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .join('')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect([...INTENT_ERRORS]).toEqual(names);
  });

  it('words a refusal by its name', () => {
    const at = (name: (typeof INTENT_ERRORS)[number]) => intentRefusalText(INTENT_ERRORS.indexOf(name), copy);
    expect(at('CapitalInsufficient')).toBe('whyIntent.intentCapital');
    expect(at('PairNotCalm')).toBe('whyIntent.intentNotCalm');
    expect(at('RetiredVpfiLending')).toBe(`whyIntent.intentOther#${INTENT_ERRORS.indexOf('RetiredVpfiLending')}`);
  });
});
