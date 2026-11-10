import { describe, expect, it } from 'vitest';
import {
  destinationBlockers,
  destinationCall,
  destinationClock,
  pendingState,
  type DestinationFacts,
  type DestinationMode,
  type DestinationReview,
} from './destinations';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const DEST = '0x00000000000000000000000000000000000000d5' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const DAY = 86_400;
const NOW = 1_800_000_000;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};

const ON: DestinationMode = { enabled: true, locked: false, retired: false, delaySeconds: 2 * DAY, cooldownUntil: 0, controller: ME };

function facts(over: Partial<DestinationFacts> = {}): DestinationFacts {
  return { account: ME, mode: ON, destinations: [], pending: [], signers: [], paused: false, queuedTo: {}, chainNow: NOW, readAt: Date.now(), ...over };
}

function review(action: DestinationReview['action'], over: Partial<DestinationFacts> = {}, extra: Partial<DestinationReview> = {}): DestinationReview {
  return { identity: 'me', action, destination: DEST, facts: facts(over), screen: null, dryRun: null, readAt: Date.now(), ...extra };
}

describe('pendingState', () => {
  const p = { destination: DEST, maturesAt: NOW };
  it('waits before maturity, is ready for one further delay, then lapses', () => {
    expect(pendingState(p, DAY, NOW - 1)).toBe('waiting');
    expect(pendingState(p, DAY, NOW)).toBe('ready');
    expect(pendingState(p, DAY, NOW + DAY)).toBe('ready');
    expect(pendingState(p, DAY, NOW + DAY + 1)).toBe('expired');
  });
});

describe('destinationClock', () => {
  it('adds the seconds since the read to the block time, and is unknown without one', () => {
    expect(destinationClock({ chainNow: NOW, readAt: 1_000 }, 61_500)).toBe(NOW + 60);
    expect(destinationClock({ chainNow: NOW, readAt: 5_000 }, 1_000)).toBe(NOW);
    expect(destinationClock({ chainNow: null, readAt: 0 }, 0)).toBeNull();
  });
});

describe('destinationCall', () => {
  it('names the facet entry for each action, with the account and the destination', () => {
    expect(destinationCall('add', ME, DEST)).toMatchObject({ functionName: 'addAllowlisted', args: [ME, DEST] });
    expect(destinationCall('cancel', ME, DEST).functionName).toBe('cancelAddAllowlisted');
    expect(destinationCall('apply', ME, DEST).functionName).toBe('finalizeAddAllowlisted');
    expect(destinationCall('remove', ME, DEST).functionName).toBe('removeAllowlisted');
  });
});

describe('destinationBlockers', () => {
  it('states an absent feature, a retired account and protected mode off first', () => {
    expect(destinationBlockers(review('add', { mode: 'absent' }), copy)).toEqual(['safety.unavailable']);
    expect(destinationBlockers(review('remove', { mode: { ...ON, retired: true } }), copy)).toEqual(['safety.retired']);
    expect(destinationBlockers(review('cancel', { mode: { ...ON, enabled: false } }), copy)).toEqual(['dest.modeOff']);
  });

  it('refuses an addition the facet would refuse', () => {
    expect(destinationBlockers(review('add'), copy)).toEqual([]);
    expect(destinationBlockers(review('add', { paused: true }), copy)).toEqual(['dest.paused']);
    expect(destinationBlockers(review('add', {}, { destination: ME }), copy)).toEqual(['dest.isSelf']);
    expect(destinationBlockers(review('add', { destinations: [DEST] }), copy)).toEqual(['dest.alreadyListed']);
    expect(destinationBlockers(review('add', { mode: { ...ON, locked: true } }), copy)).toEqual(['dest.locked']);
    expect(destinationBlockers(review('add', { mode: { ...ON, cooldownUntil: NOW + DAY } }), copy)[0]).toMatch(/^safety.cooldown/);
    expect(destinationBlockers(review('add', { pending: [{ destination: DEST, maturesAt: NOW + DAY }] }), copy)[0]).toMatch(/^dest.alreadyWaiting/);
    const five = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}` as Hex);
    expect(destinationBlockers(review('add', { destinations: five }), copy)[0]).toMatch(/^dest.full/);
    expect(destinationBlockers(review('add', { pending: five.map((d) => ({ destination: d, maturesAt: NOW + DAY })) }), copy)[0]).toMatch(/^dest.pendingFull/);
    expect(destinationBlockers(review('add', {}, { screen: 'flagged' }), copy)).toEqual(['dest.flagged']);
  });

  it('lets a lapsed request be asked for again', () => {
    expect(destinationBlockers(review('add', { pending: [{ destination: DEST, maturesAt: NOW - 3 * DAY }] }), copy)).toEqual([]);
  });

  it('applies only a matured, unlapsed request, and never while paused or locked', () => {
    const ready = { pending: [{ destination: DEST, maturesAt: NOW - DAY }] };
    expect(destinationBlockers(review('apply', ready), copy)).toEqual([]);
    expect(destinationBlockers(review('apply', { ...ready, paused: true }), copy)).toEqual(['dest.paused']);
    expect(destinationBlockers(review('apply', { ...ready, mode: { ...ON, locked: true } }), copy)).toEqual(['dest.locked']);
    expect(destinationBlockers(review('apply', { pending: [{ destination: DEST, maturesAt: NOW + DAY }] }), copy)[0]).toMatch(/^dest.notYet/);
    expect(destinationBlockers(review('apply', { pending: [{ destination: DEST, maturesAt: NOW - 3 * DAY }] }), copy)[0]).toMatch(/^dest.expired/);
    expect(destinationBlockers(review('apply', { pending: [{ destination: OTHER, maturesAt: NOW - DAY }] }), copy)).toEqual(['dest.notWaiting']);
  });

  it('keeps cancelling and removing open during a pause', () => {
    expect(destinationBlockers(review('cancel', { paused: true, pending: [{ destination: DEST, maturesAt: NOW + DAY }] }), copy)).toEqual([]);
    expect(destinationBlockers(review('remove', { paused: true, destinations: [DEST] }), copy)).toEqual([]);
    expect(destinationBlockers(review('remove', { destinations: [OTHER] }), copy)).toEqual(['dest.notListed']);
  });

  it('states a refused dry run last', () => {
    const refused = { code: 'X', reason: 'no', reopensAt: null, remedy: null };
    expect(destinationBlockers(review('add', {}, { dryRun: refused }), copy)[0]).toMatch(/^safety.dryRunRefused/);
    expect(destinationBlockers(review('add', {}, { dryRun: 'unread' }), copy)).toEqual([]);
  });
});
