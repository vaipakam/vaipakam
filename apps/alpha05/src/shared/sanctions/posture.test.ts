import { describe, expect, it } from 'vitest';
import { frozenRefusal, frozenState, isFrozenRefusal, type SanctionsPosture } from './posture';

const p = (over: Partial<SanctionsPosture>): SanctionsPosture => ({ configured: true, read: 'clean', registered: false, ...over });
const copy = { text: (k: string) => k };

describe('frozen state (RB-FROZEN)', () => {
  it('freezes nothing where no screen is configured, and a clean wallet', () => {
    expect(frozenState(p({ configured: false, read: null, registered: null }))).toBeNull();
    expect(frozenState(p({}))).toBeNull();
  });
  it('reads a flagged wallet as flagged, whatever the registry says', () => {
    expect(frozenState(p({ read: 'flagged', registered: false }))).toBe('flagged');
    expect(frozenState(p({ read: 'flagged', registered: null }))).toBe('flagged');
  });
  it('freezes in an outage only a wallet confirmed flagged before', () => {
    expect(frozenState(p({ read: 'unavailable', registered: true }))).toBe('outage');
    expect(frozenState(p({ read: 'unavailable', registered: false }))).toBeNull();
    expect(frozenState(p({ read: 'unavailable', registered: null }))).toBe('unknown');
  });
  it('says unknown when the posture could not be read, never assumes', () => {
    expect(frozenState(null)).toBe('unknown');
    expect(frozenState(undefined)).toBe('unknown');
    expect(frozenState(p({ configured: null, read: null, registered: null }))).toBe('unknown');
    expect(frozenState(p({ read: null }))).toBe('unknown');
  });
  it('names the refusals a claim gives a frozen party, in one set of words', () => {
    expect(isFrozenRefusal({ code: 'SanctionedAddress' })).toBe(true);
    expect(isFrozenRefusal({ code: 'SanctionsOracleUnavailable' })).toBe(true);
    expect(isFrozenRefusal({ code: 'EnforcedPause' })).toBe(false);
    expect(isFrozenRefusal(null)).toBe(false);
    expect(frozenRefusal('recorded', copy).reason).toBe('frozen.claimRecorded');
    expect(frozenRefusal('outage', copy).code).toBe('SanctionedAddress');
  });
});
