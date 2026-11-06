/**
 * #3231 follow-up — the live signing drives run with the risk-access gate ON
 * when every gated party is already allowed, and BLOCK naming the reason when
 * one is not. The drives' happy path cannot exercise the refusals, so they
 * are pinned here, together with the classification of every read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { judgeOfferGate, judgeRiskGateParties, readOfferGate, readRiskGateParties, RISK_GATE_READS } from './riskGateReadiness.mjs';
import { STATE_READS } from './watchedConfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const ready = { label: 'p', tier: 2, consent: true, strictBlocked: false };

describe('judgeRiskGateParties — before any offer exists', () => {
  it('passes everyone when the gate is off, and says so', () => {
    const r = judgeRiskGateParties({ gateEnabled: false, required: 2, parties: [{ ...ready, tier: 0, consent: false }] });
    expect(r.ok).toBe(true);
    expect(r.lines[0].label).toMatch(/gate off/);
  });

  it('refuses an unreadable gate state rather than guessing', () => {
    expect(judgeRiskGateParties({ gateEnabled: undefined, required: 0, parties: [] }).ok).toBe(false);
  });

  it('passes an illiquid pair only with the tier AND an armed consent', () => {
    expect(judgeRiskGateParties({ gateEnabled: true, required: 2, parties: [ready] }).ok).toBe(true);
    const noConsent = judgeRiskGateParties({ gateEnabled: true, required: 2, parties: [{ ...ready, consent: false }] });
    expect(noConsent.ok).toBe(false);
    expect(noConsent.lines[0].observed).toMatch(/armed standing consent/);
    const lowTier = judgeRiskGateParties({ gateEnabled: true, required: 2, parties: [{ ...ready, tier: 1 }] });
    expect(lowTier.ok).toBe(false);
    expect(lowTier.lines[0].observed).toMatch(/BroadLiquid is below the pair's IlliquidCustom/);
  });

  it('needs no consent below the illiquid band, but honours strict mode', () => {
    expect(judgeRiskGateParties({ gateEnabled: true, required: 1n, parties: [{ ...ready, tier: 1n, consent: false }] }).ok).toBe(true);
    expect(judgeRiskGateParties({ gateEnabled: true, required: 1, parties: [{ ...ready, tier: 1, strictBlocked: true }] }).ok).toBe(false);
  });

  it('judges every party: one not ready fails the whole check', () => {
    const r = judgeRiskGateParties({ gateEnabled: true, required: 2, parties: [ready, { ...ready, label: 'q', tier: 0 }] });
    expect(r.ok).toBe(false);
    expect(r.lines.map((l) => l.ok)).toEqual([true, false]);
  });
});

describe('judgeOfferGate — the contract previews once the request exists', () => {
  const base = { gateEnabled: true, creatorLabel: 'c', acceptorLabel: 'a', offerId: 7n };
  it('passes only when both previews read 0', () => {
    expect(judgeOfferGate({ ...base, creatorCode: 0, acceptorCode: 0n }).ok).toBe(true);
    const r = judgeOfferGate({ ...base, creatorCode: 0, acceptorCode: 2 });
    expect(r.ok).toBe(false);
    expect(r.lines[1].observed).toMatch(/armed standing consent/);
    expect(judgeOfferGate({ ...base, creatorCode: 1, acceptorCode: 0 }).ok).toBe(false);
  });
  it('is not gated when the switch is off', () => {
    expect(judgeOfferGate({ gateEnabled: false, offerId: 7n }).ok).toBe(true);
  });
});

describe('the readers', () => {
  it('read nothing when the gate is off', async () => {
    const read = () => { throw new Error('no read expected'); };
    expect((await readRiskGateParties(read, { gateEnabled: false, pair: {}, parties: [{ label: 'x', address: '0x1' }] })).ok).toBe(true);
    expect((await readOfferGate(read, { gateEnabled: false, offerId: 1n })).ok).toBe(true);
  });

  it('read exactly the declared getters, at the given block', async () => {
    const seen = [];
    const answers = { pairRequiredRiskLevel: 2, getEffectiveRiskTier: 2, hasIlliquidPairConsent: true, midTierStrictBlocked: false, previewCreatorBlock: 0, previewOfferAcceptBlock: 0 };
    const read = async (fn, _args, block) => { seen.push([fn, block]); return answers[fn]; };
    await readRiskGateParties(read, { gateEnabled: true, pair: {}, parties: [{ label: 'x', address: '0x1' }], blockNumber: 5n });
    await readOfferGate(read, { gateEnabled: true, offerId: 1n, acceptor: '0x2', blockNumber: 5n });
    expect([...new Set(seen.map(([fn]) => fn))].sort()).toEqual([...RISK_GATE_READS].sort());
    expect(seen.every(([, b]) => b === 5n)).toBe(true);
  });

  it('every getter the module reads is classified as state, and the source names no other', () => {
    for (const fn of RISK_GATE_READS) expect(Object.hasOwn(STATE_READS, fn), fn).toBe(true);
    const named = [...new Set([...src('riskGateReadiness.mjs').matchAll(/\bread\(\s*'(\w+)'/g)].map((m) => m[1]))].sort();
    expect(named).toEqual([...RISK_GATE_READS].sort());
  });

  it('both signing drives use it instead of requiring the gate off', () => {
    for (const f of ['live-seed-illiquid-loan.mjs', 'live-refinance.mjs']) {
      expect(src(f), f).toMatch(/readRiskGateParties\(/);
      expect(src(f), f).toMatch(/readOfferGate\(/);
      expect(src(f), f).not.toMatch(/risk-access gate disabled/);
    }
  });
});
