/**
 * #2422 r12 — ONE watched-config snapshot. Every mutable governance value
 * the refinance drive reads is in WATCHED_CONFIG; the driver reads none of
 * those getters directly (only through `readWatchedConfig`); and every other
 * Diamond read it makes is classified as per-loan/user/offer STATE. A new
 * read that is neither fails here, so it cannot silently bypass the snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readWatchedConfig, STATE_READS, WATCHED_CONFIG, WATCHED_GETTERS } from './watchedConfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'));
const VIEWS = new Set(ABI.filter((e) => e.type === 'function' && ['view', 'pure'].includes(e.stateMutability)).map((e) => e.name));
/** Every Diamond getter named by a `read('<name>'` call in `text`. */
const readsIn = (text) => [...new Set([...text.matchAll(/\bread\(\s*'(\w+)'/g)].map((m) => m[1]))].sort();

describe('watchedConfig — the one snapshot', () => {
  it('has unique keys, and every getter is a real Diamond view', () => {
    const keys = WATCHED_CONFIG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const fn of WATCHED_GETTERS) expect(VIEWS.has(fn), fn).toBe(true);
    for (const fn of Object.keys(STATE_READS)) expect(VIEWS.has(fn), fn).toBe(true);
  });

  it('covers the fees, grace, risk-terms epoch, posture and BOTH asset pauses', () => {
    const keys = new Set(WATCHED_CONFIG.map((e) => e.key));
    for (const k of [
      'paused',
      'autoRefinance',
      'partialFill',
      'treasuryFeeBps',
      'lifBps',
      'lifMatcherFeeBps',
      'treasury',
      'graceBuckets',
      'riskTermsHash',
      'principalPaused',
      'collateralPaused',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
    const ctx = { principalAsset: '0xP', collateralAsset: '0xC' };
    const pause = WATCHED_CONFIG.filter((e) => e.fn === 'isAssetPaused').map((e) => [e.key, e.args(ctx)]);
    expect(pause).toEqual([
      ['principalPaused', ['0xP']],
      ['collateralPaused', ['0xC']],
    ]);
  });

  it('a getter is either watched config or classified state — never both', () => {
    for (const fn of WATCHED_GETTERS) expect(Object.hasOwn(STATE_READS, fn), fn).toBe(false);
  });

  it('the driver reads NO watched getter directly, and every other read it makes is classified', () => {
    const reads = readsIn(src('live-refinance.mjs'));
    expect(reads.length).toBeGreaterThan(10); // the scan found the driver's reads at all
    const direct = reads.filter((fn) => WATCHED_GETTERS.includes(fn));
    expect(direct, 'governance values must come from readWatchedConfig').toEqual([]);
    const unclassified = reads.filter((fn) => !Object.hasOwn(STATE_READS, fn));
    expect(unclassified, 'classify each new read: watched config, or state with a reason').toEqual([]);
  });

  it('the expected and settlement builders read nothing themselves — their config arrives from the snapshot', () => {
    for (const f of ['refinanceExpected.mjs', 'refinanceOutcome.mjs', 'reviewTerms.mjs']) {
      expect(readsIn(src(f)), f).toEqual([]);
      expect(src(f), f).not.toMatch(/readContract\(/);
    }
  });

  it('reads every key, sharing one call per (getter, args)', async () => {
    const calls = [];
    const read = async (fn, args, block) => {
      calls.push(`${fn}(${args.join(',')})@${block}`);
      if (fn === 'getMasterFlags') return [false, false, true];
      if (fn === 'getFeesConfig') return [200n, 20n];
      if (fn === 'getProtocolConfigBundle') return Array.from({ length: 15 }, (_, i) => BigInt(i));
      if (fn === 'isAssetPaused') return args[0] === '0xC';
      return `${fn}-value`;
    };
    const snap = await readWatchedConfig(read, { principalAsset: '0xP', collateralAsset: '0xC' }, 9n);
    expect(Object.keys(snap).sort()).toEqual(WATCHED_CONFIG.map((e) => e.key).sort());
    expect(snap).toMatchObject({ partialFill: true, treasuryFeeBps: 200n, maxOfferDurationDays: 14n, principalPaused: false, collateralPaused: true });
    expect(calls.filter((c) => c.startsWith('getFeesConfig'))).toEqual(['getFeesConfig()@9']);
    expect(calls.every((c) => c.endsWith('@9'))).toBe(true);
  });
});
