import { describe, expect, it } from 'vitest';
import { programmeHeadline, roleOf, type ProgrammeRead } from './programme';

const NOW = 1_800_000_000;

function read(over: Partial<ProgrammeRead> = {}): ProgrammeRead {
  return {
    launch: BigInt(NOW - 86_400),
    role: 'canonical',
    retirement: { retired: false, returnChainId: 0, returnDeployment: '0x0000000000000000000000000000000000000000', returned: 0n },
    baseChainId: 84532,
    custodyActivated: true,
    horizonDays: 0,
    funding: { fresh: 10n, recycled: 0n, noToken: false },
    blockNumber: 1n,
    chainTime: NOW,
    ...over,
  };
}

describe('roleOf', () => {
  it('names the four roles and nothing else', () => {
    expect([0, 1, 2, 3].map(roleOf)).toEqual(['canonical', 'mirror', 'unconfigured', 'detached']);
    expect(roleOf(4)).toBeNull();
  });
});

describe('programmeHeadline', () => {
  it('is live only when launched, in a paying role and funded', () => {
    expect(programmeHeadline(read())).toEqual({ kind: 'live' });
    expect(programmeHeadline(read({ funding: { fresh: 0n, recycled: 5n, noToken: false } }))).toEqual({ kind: 'live' });
    expect(programmeHeadline(read({ role: 'unconfigured' }))).toEqual({ kind: 'live' });
  });

  it('says nothing is held to pay when both sources are empty', () => {
    expect(programmeHeadline(read({ funding: { fresh: 0n, recycled: 0n, noToken: true } }))).toEqual({ kind: 'unfunded', mirror: false });
    expect(programmeHeadline(read({ role: 'mirror', funding: { fresh: 0n, recycled: 0n, noToken: false } }))).toEqual({ kind: 'unfunded', mirror: true });
  });

  it('states a missing or future start before funding', () => {
    expect(programmeHeadline(read({ launch: 0n, funding: null }))).toEqual({ kind: 'not-started' });
    expect(programmeHeadline(read({ launch: BigInt(NOW + 60), funding: null }))).toEqual({ kind: 'starts', at: NOW + 60 });
  });

  it('a detached network has left, whatever else reads', () => {
    expect(programmeHeadline(read({ role: 'detached', launch: null, funding: null }))).toEqual({ kind: 'left' });
  });

  it('never reads as running when a deciding fact is unread', () => {
    expect(programmeHeadline(read({ role: null }))).toEqual({ kind: 'unknown' });
    expect(programmeHeadline(read({ launch: null }))).toEqual({ kind: 'unknown' });
    expect(programmeHeadline(read({ funding: null }))).toEqual({ kind: 'unknown' });
  });
});
