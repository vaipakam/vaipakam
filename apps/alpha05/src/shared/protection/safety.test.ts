import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { ProtectedAccountFacetABI, VaultProtectionABI } from '@vaipakam/contracts/abis';
import { directAuth, protectionCall } from '@vaipakam/lib/protectedAccountView';
import { dueChanges, measureSafety, pendingChanges, safetyBlockers, safetyChanged, safetySteps, type SafetyFacts, type SafetyMode, type SafetyReview } from './safety';
import { safetyReceipt } from './safetyReceipt';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const DAY = 86_400;
const NOW = 1_800_000_000;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};

const OFF: SafetyMode = {
  enabled: false,
  locked: false,
  nftLock: false,
  nftUnlockAt: 0,
  requireCosign: false,
  retired: false,
  delaySeconds: 0,
  pendingDelay: 0,
  pendingDelayAt: 0,
  pendingDisableAt: 0,
  pendingUnlockAt: 0,
  pendingNftOffAt: 0,
  pendingCosignOffAt: 0,
  cooldownUntil: 0,
  lockedAt: 0,
  lockedBy: ZERO,
  controller: ZERO,
};
const ON: SafetyMode = { ...OFF, enabled: true, delaySeconds: 2 * DAY };
const LOCKED: SafetyMode = { ...ON, locked: true, lockedAt: NOW - DAY, lockedBy: ME };

function facts(p: Partial<SafetyFacts> = {}): SafetyFacts {
  return {
    account: ME,
    vault: VAULT,
    mode: OFF,
    bounds: { min: 2 * DAY, max: 5 * DAY },
    paused: false,
    frozen: null,
    openRows: 0,
    chainNow: Math.floor(Date.now() / 1000),
    readAt: Date.now(),
    ...p,
  };
}

function review(action: SafetyReview['action'], f: Partial<SafetyFacts> = {}, p: Partial<SafetyReview> = {}): SafetyReview {
  return { identity: 'i', action, draft: action === 'enable' ? { delaySeconds: 2 * DAY, protectNfts: false } : null, facts: facts(f), due: [], dryRun: null, readAt: 0, ...p };
}

function eventLog(eventName: string, args: Record<string, unknown>, data: { types: { type: string }[]; values: unknown[] }, address: Hex = DIAMOND): Log {
  const abi = (address === VAULT ? VaultProtectionABI : ProtectedAccountFacetABI) as Abi;
  const topics = encodeEventTopics({ abi, eventName, args } as never);
  return { address, topics, data: data.types.length === 0 ? '0x' : encodeAbiParameters(data.types, data.values as never) } as unknown as Log;
}

describe('pending and due changes', () => {
  it('lists every pending change, soonest first, and only those past their time as due', () => {
    const m = { ...LOCKED, pendingUnlockAt: NOW + 10, pendingDelayAt: NOW - 5, pendingDelay: 3 * DAY, pendingDisableAt: NOW + 99 };
    expect(pendingChanges(m).map((p) => p.change)).toEqual(['lowerDelay', 'unlock', 'disable']);
    expect(dueChanges(m, NOW)).toEqual(['lowerDelay']);
    expect(dueChanges(m, NOW + 10)).toEqual(['lowerDelay', 'unlock']);
    expect(pendingChanges(ON)).toEqual([]);
  });
});

describe('safetySteps', () => {
  it('writes each action to the wallet’s own vault with its direct authorization, and the Diamond applies the posture', () => {
    const auth = directAuth(ME);
    const protect = (fn: string, args: readonly unknown[]) => ({ to: 'vault', functionName: 'protect', args: [protectionCall(fn, args)] });
    expect(safetySteps('enable', ME, VAULT, { delaySeconds: 3 * DAY, protectNfts: true })).toMatchObject([
      protect('enable', [3 * DAY, auth]),
      { to: 'diamond', functionName: 'lockPositionNfts', args: [ME] },
      { to: 'diamond', functionName: 'applyProtection', args: [ME] },
    ]);
    expect(safetySteps('enable', ME, null, { delaySeconds: 3 * DAY, protectNfts: false }).map((x) => x.functionName)).toEqual(['getOrCreateUserVault', 'protect', 'applyProtection']);
    expect(safetySteps('lock', ME, VAULT, null)).toMatchObject([protect('lock', [auth]), { to: 'diamond', functionName: 'applyProtection', args: [ME] }]);
    expect(safetySteps('unlock', ME, VAULT, null)).toMatchObject([protect('requestUnlock', [auth])]);
    expect(safetySteps('finalize', ME, VAULT, null, ['cosignOff'])).toMatchObject([{ to: 'diamond', functionName: 'finalizeSettingChanges', args: [ME] }]);
    expect(safetySteps('finalize', ME, VAULT, null, ['unlock']).map((x) => x.functionName)).toEqual(['protect', 'applyProtection']);
  });
});

describe('safetyBlockers', () => {
  it('a Diamond without the feature, and a retired wallet, stop every action first', () => {
    expect(safetyBlockers(review('lock', { mode: 'absent' }), copy)).toEqual(['safety.unavailable']);
    expect(safetyBlockers(review('lock', { mode: { ...ON, retired: true }, paused: true }), copy)).toEqual(['safety.retired']);
  });
  it('turning on: the pause, the screen, already on, and a delay outside the bounds', () => {
    expect(safetyBlockers(review('enable'), copy)).toEqual([]);
    expect(safetyBlockers(review('enable', { paused: true, frozen: 'flagged' }), copy)).toEqual(['safety.paused']);
    expect(safetyBlockers(review('enable', { frozen: 'flagged' }), copy)).toEqual(['safety.flagged']);
    expect(safetyBlockers(review('enable', { mode: ON }), copy)).toEqual(['safety.alreadyOn']);
    expect(safetyBlockers(review('enable', {}, { draft: { delaySeconds: DAY, protectNfts: false } }), copy)[0]).toMatch(/^safety.delayOutOfBounds/);
  });
  it('a lock works during a pause, but not on an account without the mode or already locked', () => {
    expect(safetyBlockers(review('lock', { mode: ON, paused: true }), copy)).toEqual([]);
    expect(safetyBlockers(review('lock', { mode: OFF }), copy)).toEqual(['safety.notOn']);
    expect(safetyBlockers(review('lock', { mode: LOCKED }), copy)).toEqual(['safety.alreadyLocked']);
  });
  it('an unlock request: locked, not already asked, outside a cool-down, not during a pause', () => {
    expect(safetyBlockers(review('unlock', { mode: LOCKED }), copy)).toEqual([]);
    expect(safetyBlockers(review('unlock', { mode: ON }), copy)).toEqual(['safety.notLocked']);
    expect(safetyBlockers(review('unlock', { mode: { ...LOCKED, pendingUnlockAt: NOW } }), copy)[0]).toMatch(/^safety.unlockPending/);
    expect(safetyBlockers(review('unlock', { mode: { ...LOCKED, cooldownUntil: Math.floor(Date.now() / 1000) + DAY } }), copy)[0]).toMatch(/^safety.cooldown/);
    expect(safetyBlockers(review('unlock', { mode: LOCKED, paused: true }), copy)).toEqual(['safety.paused']);
  });
  it('applying due changes: something due, and a switch-off alone waits for an empty queue', () => {
    expect(safetyBlockers(review('finalize', { mode: ON }), copy)).toEqual(['safety.nothingDue']);
    expect(safetyBlockers(review('finalize', { mode: ON }, { due: ['unlock'] }), copy)).toEqual([]);
    expect(safetyBlockers(review('finalize', { mode: ON, openRows: 2 }, { due: ['disable'] }), copy)).toEqual(['safety.rowsOpen']);
    expect(safetyBlockers(review('finalize', { mode: ON, openRows: 2 }, { due: ['unlock', 'disable'] }), copy)).toEqual([]);
  });
  it('the protocol’s dry-run refusal stops it; an unread dry run does not', () => {
    const refusal = { code: 'X', reason: 'no', reopensAt: null, remedy: null };
    expect(safetyBlockers(review('lock', { mode: ON }, { dryRun: refusal }), copy)).toEqual(['safety.dryRunRefused:{"reason":"no"}']);
    expect(safetyBlockers(review('lock', { mode: ON }, { dryRun: 'unread' }), copy)).toEqual([]);
  });
});

describe('safetyChanged', () => {
  it('the mode, the due changes, the queue a lock cancels and the pause are changes', () => {
    expect(safetyChanged(review('lock', { mode: ON }), review('lock', { mode: ON }), copy)).toBeNull();
    expect(safetyChanged(review('lock', { mode: ON }), review('lock', { mode: LOCKED }), copy)).toBe('safety.changedMode');
    expect(safetyChanged(review('finalize', { mode: ON }), review('finalize', { mode: ON }, { due: ['unlock'] }), copy)).toBe('safety.changedDue');
    expect(safetyChanged(review('lock', { mode: ON }), review('lock', { mode: ON, openRows: 1 }), copy)).toBe('safety.changedRows');
    expect(safetyChanged(review('enable'), review('enable', { paused: true }), copy)).toBe('repay.changedVerdict');
  });
});

describe('measureSafety', () => {
  const posture = (account: Hex, enabled: boolean, locked: boolean, address: Hex = DIAMOND) =>
    eventLog('ProtectionApplied', { account }, { types: [{ type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'uint32' }], values: [enabled, locked, false, 2 * DAY] }, address);
  it('reads the switch-on and its delay from the Diamond’s applied posture for this wallet', () => {
    expect(measureSafety(review('enable'), [posture(ME, true, false)], DIAMOND, copy)).toEqual([{ status: 'done', label: 'safety.legEnabled:{"delay":"2 days"}' }]);
    expect(measureSafety(review('enable'), [posture(OTHER, true, false)], DIAMOND, copy)[0]?.status).toBe('not-done');
    expect(measureSafety(review('enable'), [posture(ME, true, false, OTHER)], DIAMOND, copy)[0]?.status).toBe('not-done');
  });
  it('reads a lock, an unlock request (from the vault) and the changes applied', () => {
    expect(measureSafety(review('lock', { mode: ON }), [posture(ME, true, true)], DIAMOND, copy)).toEqual([{ status: 'done', label: 'safety.legLocked' }]);
    const asked = eventLog('ProtectionSettingRequested', { action: 4 }, { types: [{ type: 'uint256' }, { type: 'uint64' }, { type: 'address' }], values: [0n, BigInt(NOW), ME] }, VAULT);
    expect(measureSafety(review('unlock', { mode: LOCKED }), [asked], DIAMOND, copy)[0]?.status).toBe('done');
    const legs = measureSafety(review('finalize', { mode: LOCKED }, { due: ['unlock', 'disable'] }), [posture(ME, true, false)], DIAMOND, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'not-done']);
  });
});

describe('safetyReceipt', () => {
  it('turning on states the delay, what waits, and that it never delays what is owed to others', () => {
    const r = safetyReceipt(review('enable'), copy);
    expect(r.rows.find((x) => x.label === 'safety.rowDelay')?.value).toEqual({ kind: 'text', text: '2 days' });
    expect(r.consequences).toEqual(
      expect.arrayContaining(['safety.enableNeverOthers', 'safety.enableInbound', 'safety.enableNftsOff', 'safety.enableVault', 'safety.enableVoidsPin']),
    );
    // #3379 B2: the vault's write, then the Diamond applying it.
    expect(r.prompts).toBe(2);
  });
  it('a lock states what it cancels and drops; unread facts are said', () => {
    const r = safetyReceipt(review('lock', { mode: { ...ON, pendingDelayAt: NOW, pendingDelay: 3 * DAY }, openRows: 3 }), copy);
    expect(r.rows.find((x) => x.label === 'safety.rowCancels')?.value).toEqual({ kind: 'text', text: 'safety.payoutCount:{"count":"3"}' });
    expect(r.rows.find((x) => x.label === 'safety.rowDrops')?.value).toEqual({ kind: 'text', text: 'safety.changeCount:{"count":"1"}' });
    expect(r.consequences).toEqual(expect.arrayContaining(['safety.lockServicing', 'safety.lockDrops', 'safety.lockReplacement']));
    expect(safetyReceipt(review('lock', { mode: null, openRows: null }), copy).consequences).toEqual(expect.arrayContaining(['safety.modeUnread', 'safety.rowsUnread']));
  });
  it('applying due changes names each change and that all due ones apply together', () => {
    const r = safetyReceipt(review('finalize', { mode: ON }, { due: ['unlock', 'disable'] }), copy);
    expect(r.rows[0]?.value).toEqual({ kind: 'text', text: 'safety.changeUnlock · safety.changeDisable' });
    expect(r.consequences).toEqual(expect.arrayContaining(['safety.finalizeAll', 'safety.finalizeUnlock', 'safety.finalizeDisable', 'safety.finalizeDisableClears']));
  });
  it('a due shorter delay names the delay it sets, beside the current one', () => {
    const r = safetyReceipt(review('finalize', { mode: { ...ON, delaySeconds: 5 * DAY, pendingDelay: 2 * DAY, pendingDelayAt: NOW - 1 } }, { due: ['lowerDelay'] }), copy);
    expect(r.rows[0]?.value).toEqual({ kind: 'text', text: 'safety.changeLowerDelayTo:{"delay":"2 days"}' });
    expect(r.rows.find((x) => x.label === 'safety.rowDelayAfter')?.value).toEqual({ kind: 'text', text: 'safety.delayFromTo:{"to":"2 days","from":"5 days"}' });
  });
});
