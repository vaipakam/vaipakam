import { describe, expect, it } from 'vitest';
import type { RiskSettings } from './riskAccess';
import { changeCall, changeEffectiveAt, changeMoved, changeOffered, changeReceipt, levelChoice, levelChoices, strictState } from './riskSettings';

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = { text: (k: string) => k, format: (k: string) => k } as unknown as Parameters<typeof changeReceipt>[2];

function settings(over: Partial<RiskSettings> = {}): RiskSettings {
  return {
    gateOn: true,
    held: 0,
    effective: 0,
    stale: false,
    unlockAt: 0n,
    cooldown: 0n,
    nonce: 3n,
    termsVersion: 2n,
    strict: false,
    strictUntil: 0n,
    chainNow: 1_000n,
    blockNumber: 7n,
    ...over,
  };
}

describe('what each level choice would do', () => {
  it('a fresh wallet: blue-chip counts, the two above are raises', () => {
    expect(levelChoices(settings()).map((c) => c.choice.kind)).toEqual(['current', 'raise', 'raise']);
  });
  it('a raise still waiting is never offered again, and the level that counts is a lower step', () => {
    const s = settings({ held: 2, effective: 1, unlockAt: 4_600n, cooldown: 3_600n });
    expect(levelChoice(s, 2)).toEqual({ kind: 'waiting', until: 4_600n });
    expect(levelChoice(s, 1).kind).toBe('lower');
    expect(levelChoice(s, 0).kind).toBe('lower');
    expect(changeOffered(s, { kind: 'level', level: 2 })).toBe(false);
  });
  it('a choice stopped by new risk terms is confirmed, and waits the period like a raise', () => {
    const s = settings({ held: 2, effective: 0, stale: true, cooldown: 3_600n });
    expect(levelChoice(s, 2).kind).toBe('reaffirm');
    expect(levelChoice(s, 1).kind).toBe('raise');
    expect(levelChoice(s, 0).kind).toBe('lower');
    expect(changeEffectiveAt({ kind: 'level', level: 2 }, s)).toBe(4_600n);
  });
  it('lowering takes effect at once; raising waits when the protocol sets a period', () => {
    const s = settings({ held: 1, effective: 1, cooldown: 3_600n });
    expect(changeEffectiveAt({ kind: 'level', level: 0 }, s)).toBeNull();
    expect(changeEffectiveAt({ kind: 'level', level: 2 }, s)).toBe(4_600n);
    expect(changeEffectiveAt({ kind: 'level', level: 2 }, settings({ held: 1, effective: 1 }))).toBeNull();
  });
});

describe('strict mode', () => {
  it('reads on, off, or switched off and still applying', () => {
    expect(strictState(settings({ strict: true })).kind).toBe('on');
    expect(strictState(settings({ strictUntil: 1_000n })).kind).toBe('off');
    expect(strictState(settings({ strictUntil: 1_500n }))).toEqual({ kind: 'lingering', until: 1_500n });
  });
  it('switching on counts at once; switching off keeps it applying for the period', () => {
    const s = settings({ strict: true, cooldown: 600n });
    expect(changeEffectiveAt({ kind: 'strict', on: false }, s)).toBe(1_600n);
    expect(changeEffectiveAt({ kind: 'strict', on: true }, settings({ cooldown: 600n }))).toBeNull();
    expect(changeOffered(s, { kind: 'strict', on: true })).toBe(false);
  });
});

describe('the change to sign', () => {
  it('a level names the change counter and terms version it was read with', () => {
    expect(changeCall({ kind: 'level', level: 1 }, settings())).toEqual({ functionName: 'setVaultRiskTierChecked', args: [1, 3n, 2n] });
    expect(changeCall({ kind: 'strict', on: true }, settings())).toEqual({ functionName: 'setRiskStrictMode', args: [true] });
  });
  it('a re-read that moved what the receipt states is a change, for the kind under review only', () => {
    const a = settings();
    expect(changeMoved({ kind: 'level', level: 1 }, a, settings({ nonce: 4n }))).toBe(true);
    expect(changeMoved({ kind: 'level', level: 1 }, a, settings({ termsVersion: 3n }))).toBe(true);
    expect(changeMoved({ kind: 'strict', on: true }, a, settings({ nonce: 4n }))).toBe(false);
    expect(changeMoved({ kind: 'strict', on: true }, a, settings({ strictUntil: 9n }))).toBe(true);
    expect(changeMoved({ kind: 'level', level: 1 }, a, settings({ gateOn: false }))).toBe(true);
    expect(changeMoved({ kind: 'level', level: 1 }, a, settings({ chainNow: 2_000n, blockNumber: 8n }))).toBe(false);
  });
});

describe('the receipt', () => {
  it('a lowering says what closes and that loans already open are not affected', () => {
    const r = changeReceipt({ kind: 'level', level: 0 }, settings({ held: 1, effective: 1 }), copy, { chain: 'Base Sepolia', readAt: 1 });
    expect(r.title).toBe('riskSettings.titleLower');
    expect(r.consequences).toContain('riskSettings.lowerLose');
    expect(r.consequences).not.toContain('riskSettings.gateOffSaved');
  });
  it('a change that replaces a choice still waiting says so', () => {
    const r = changeReceipt({ kind: 'level', level: 1 }, settings({ held: 2, effective: 1, unlockAt: 4_600n, cooldown: 3_600n }), copy, { chain: 'X', readAt: 1 });
    expect(r.consequences).toContain('riskSettings.replacesChoice');
  });
  it('on a network that does not enforce it, the receipt says the change is only saved', () => {
    const r = changeReceipt({ kind: 'level', level: 1 }, settings({ gateOn: false }), copy, { chain: 'X', readAt: 1 });
    expect(r.title).toBe('risk.titleRaise');
    expect(r.consequences).toContain('riskSettings.gateOffSaved');
    const strict = changeReceipt({ kind: 'strict', on: true }, settings({ gateOn: false }), copy, { chain: 'X', readAt: 1 });
    expect(strict.consequences).toContain('riskSettings.gateOffSaved');
  });
  it('switching strict mode off states when it stops applying', () => {
    const r = changeReceipt({ kind: 'strict', on: false }, settings({ strict: true, cooldown: 600n }), copy, { chain: 'X', readAt: 1 });
    expect(r.title).toBe('riskSettings.titleStrictOff');
    expect(r.rows.map((row) => (row.value.kind === 'text' ? row.value.text : ''))).toContain('riskSettings.strictOffLater');
    expect(r.consequences).toEqual(['riskSettings.strictOffLose']);
  });
});
