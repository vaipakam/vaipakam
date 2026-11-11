import { describe, expect, it } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import { effectiveAfter, erc20Pair, needFromAcceptCode, needFromRefusal, planCall, riskPlan, riskRefusalActor, type RiskStatus } from './riskAccess';
import { isAction, needSentences, planMoved, riskReceipt } from './riskReceipt';

type Hex = `0x${string}`;
const lend = '0x00000000000000000000000000000000000000a1' as Hex;
const coll = '0x00000000000000000000000000000000000000c1' as Hex;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = { text: (k: string) => k, format: (k: string) => k } as unknown as Parameters<typeof needSentences>[1];

function status(over: Partial<RiskStatus> = {}): RiskStatus {
  return {
    need: 'tier',
    pair: erc20Pair(lend, coll),
    required: 1,
    held: 0,
    effective: 0,
    stale: false,
    unlockAt: 0n,
    cooldown: 0n,
    nonce: 4n,
    termsVersion: 2n,
    pending: false,
    inEffect: false,
    gateOn: true,
    chainNow: 1_000n,
    blockNumber: 9n,
    ...over,
  };
}

describe('which step the protocol asks for', () => {
  it('maps the accept preview codes, never the acknowledgement-covered one', () => {
    expect(needFromAcceptCode(1)).toBe('tier');
    expect(needFromAcceptCode(2)).toBe('pair-consent');
    expect(needFromAcceptCode(3)).toBe('mid-tier-ack');
    expect(needFromAcceptCode(4)).toBe('pair-consent');
    expect(needFromAcceptCode(0)).toBeNull();
  });
  it('maps the create refusals by name', () => {
    expect(needFromRefusal('RiskTierTooLow')).toBe('tier');
    expect(needFromRefusal('IlliquidPairNotConsented')).toBe('pair-consent');
    expect(needFromRefusal('MidTierPairNotAcknowledged')).toBe('mid-tier-ack');
    expect(needFromRefusal('OfferAmountZero')).toBeNull();
  });
});

describe('whose risk access a refusal names', () => {
  const ERRS = parseAbi([
    'error RiskTierTooLow(address actor, uint8 requiredTier, uint8 actorTier)',
    'error IlliquidPairNotConsented(address actor, bytes32 pairKey)',
    'error Other(address who)',
  ]);
  const MAKER = '0x1111111111111111111111111111111111111111';
  const wrap = (data: string) => ({ shortMessage: 'reverted', cause: { name: 'ContractFunctionRevertedError', raw: data, data: undefined } });
  it('reads the actor from the revert’s own bytes', () => {
    const data = encodeErrorResult({ abi: ERRS, errorName: 'RiskTierTooLow', args: [MAKER, 1, 0] });
    expect(riskRefusalActor(wrap(data))?.toLowerCase()).toBe(MAKER);
    const pair = encodeErrorResult({ abi: ERRS, errorName: 'IlliquidPairNotConsented', args: [MAKER, `0x${'ab'.repeat(32)}`] });
    expect(riskRefusalActor(wrap(pair))?.toLowerCase()).toBe(MAKER);
  });
  it('names no one for another error or unreadable bytes', () => {
    expect(riskRefusalActor(wrap(encodeErrorResult({ abi: ERRS, errorName: 'Other', args: [MAKER] })))).toBeNull();
    expect(riskRefusalActor(new Error('execution reverted'))).toBeNull();
  });
});

describe('the plan', () => {
  it('raises to the least level the pair needs', () => {
    expect(riskPlan(status({ required: 1 }))).toEqual({ kind: 'raise', level: 1 });
    expect(riskPlan(status({ required: 2, held: 1, effective: 1 }))).toEqual({ kind: 'raise', level: 2 });
  });
  it('waits for a raise already recorded instead of starting the wait over', () => {
    expect(riskPlan(status({ held: 1, effective: 0, unlockAt: 5_000n }))).toEqual({ kind: 'wait-tier', until: 5_000n });
  });
  it('confirms again a level a terms change made stale, at the level the wallet chose', () => {
    expect(riskPlan(status({ held: 2, effective: 0, stale: true }))).toEqual({ kind: 'reaffirm', level: 2 });
  });
  it('is met when the level in effect covers the pair, or the gate is off', () => {
    expect(riskPlan(status({ held: 1, effective: 1 }))).toEqual({ kind: 'met' });
    expect(riskPlan(status({ gateOn: false }))).toEqual({ kind: 'met' });
  });
  it('agrees to the pair, or waits for an agreement still in its waiting period', () => {
    expect(riskPlan(status({ need: 'pair-consent' }))).toEqual({ kind: 'consent' });
    // No read says when it counts, so no time is offered for it.
    expect(riskPlan(status({ need: 'pair-consent', pending: true }))).toEqual({ kind: 'wait-pair' });
    expect(riskPlan(status({ need: 'pair-consent', inEffect: true }))).toEqual({ kind: 'met' });
    expect(riskPlan(status({ need: 'mid-tier-ack' }))).toEqual({ kind: 'ack' });
  });
});

describe('the call a plan sends', () => {
  it('names the observed counter and terms version on a raise', () => {
    const s = status();
    expect(planCall({ kind: 'raise', level: 1 }, s)).toEqual({ functionName: 'setVaultRiskTierChecked', args: [1, 4n, 2n] });
    expect(planCall({ kind: 'consent' }, s)).toEqual({ functionName: 'setIlliquidPairConsent', args: [s.pair, true] });
    expect(planCall({ kind: 'ack' }, s)).toEqual({ functionName: 'setMidTierPairAck', args: [s.pair] });
    expect(planCall({ kind: 'met' }, s)).toBeNull();
  });
});

describe('what the step says', () => {
  it('states when it counts: at once, or after the waiting period', () => {
    expect(effectiveAfter(status())).toBeNull();
    expect(effectiveAfter(status({ cooldown: 86_400n }))).toBe(87_400n);
  });
  it('says the level change reaches every pair up to it, and that no funds move', () => {
    const r = riskReceipt({ kind: 'raise', level: 1 }, status(), copy, { chain: 'Base Sepolia', pairLabel: 'P', readAt: 1 });
    expect(r.title).toBe('risk.titleRaise');
    expect(r.rows.map((x) => x.label)).toEqual(['risk.rowLevel', 'risk.rowScope', 'risk.rowEffect', 'risk.rowMoves', 'risk.rowLower']);
    expect(r.consequences).toEqual(['risk.loseTier', 'risk.loseTerms']);
    expect(r.prompts).toBe(1);
  });
  it('binds an agreement to the exact pair and states what illiquid means', () => {
    const r = riskReceipt({ kind: 'consent' }, status({ need: 'pair-consent' }), copy, { chain: 'Base Sepolia', pairLabel: 'P', readAt: 1 });
    expect(r.rows[0]).toMatchObject({ label: 'risk.rowPair', value: { kind: 'text', text: 'P' } });
    expect(r.consequences).toContain('risk.loseConsent');
  });
  it('names a stale level alongside the level the pair needs', () => {
    expect(needSentences(status({ held: 2, stale: true }), copy, 'P')).toEqual(['risk.needTier', 'risk.needStale']);
    expect(needSentences(status({ need: 'pair-consent' }), copy, 'P')).toEqual(['risk.needConsent']);
  });
  it('treats only a raise, a re-confirm, an agreement or an acknowledgement as a step', () => {
    expect(isAction({ kind: 'raise', level: 1 })).toBe(true);
    expect(isAction({ kind: 'wait-tier', until: 1n })).toBe(false);
    expect(isAction({ kind: 'met' })).toBe(false);
  });
  it('counts a moved counter, terms version or waiting period as a changed review', () => {
    const a = { plan: { kind: 'raise', level: 1 } as const, status: status() };
    expect(planMoved(a, a)).toBe(false);
    expect(planMoved(a, { ...a, status: status({ nonce: 5n }) })).toBe(true);
    expect(planMoved(a, { ...a, status: status({ termsVersion: 3n }) })).toBe(true);
    expect(planMoved(a, { ...a, status: status({ cooldown: 60n }) })).toBe(true);
    expect(planMoved(a, { plan: { kind: 'raise', level: 2 }, status: status() })).toBe(true);
  });
});
