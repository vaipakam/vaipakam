import { describe, expect, it } from 'vitest';
import { parseKeeperSteps, readKeeperSteps, ROLL_STEP, runnerState } from './keeperSteps';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';

const D = '0x2c300b26bc15359E7948dA61a1960303772b0335' as const;
const row = (over: Partial<{ pass: string; step: string; diamond: string; running: boolean }> = {}) => ({
  pass: 'matcher',
  step: 'roll',
  diamond: D.toLowerCase(),
  armed: true,
  observedAt: 1,
  running: true,
  ...over,
});
const body = (steps: unknown[]) => ({ chainId: 84532, staleAfterSeconds: 900, steps });

describe('keeper steps (#3763 rule 7)', () => {
  it('reads a running step for this Diamond as running', () => {
    expect(runnerState(parseKeeperSteps(body([row()]), 84532), ROLL_STEP, D)).toBe('running');
  });
  it('reads a stale or unarmed step, a missing row and another Diamond as not running', () => {
    expect(runnerState(parseKeeperSteps(body([row({ running: false })]), 84532), ROLL_STEP, D)).toBe('not-running');
    expect(runnerState(parseKeeperSteps(body([]), 84532), ROLL_STEP, D)).toBe('not-running');
    expect(runnerState(parseKeeperSteps(body([row({ diamond: '0x' + '1'.repeat(40) })]), 84532), ROLL_STEP, D)).toBe('not-running');
  });
  it('reads an answer it cannot place as not known', () => {
    expect(parseKeeperSteps(body([row()]), 1)).toBeNull();
    expect(parseKeeperSteps({ steps: 'x' }, 84532)).toBeNull();
    expect(parseKeeperSteps(body([{ pass: 'matcher' }]), 84532)).toBeNull();
    expect(runnerState(null, ROLL_STEP, D)).toBe('unknown');
  });
  it('reads an outage or a missing indexer as not known, never as running', async () => {
    const failing: IndexerClient = {
      origin: null,
      getJson: () => Promise.reject(new IndexerUnavailable('status', '503')),
    };
    expect(await readKeeperSteps(failing, 84532)).toBeNull();
  });
});
