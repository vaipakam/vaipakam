import { describe, expect, it } from 'vitest';
import type { Abi, AbiEvent, AbiParameter } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { activityActor, actorAttributedKinds } from './activityActor';
import {
  EXEMPT_GROUPS,
  PARTICIPANT_RULE_FOR_TEST,
  activityParticipants,
  participantKinds,
} from './activityParticipants';

const { PARTIES, NOT_A_PARTY, LOCAL_NOT_A_PARTY, EXEMPT } = PARTICIPANT_RULE_FOR_TEST;

const A = '0xAbCdEf0000000000000000000000000000000001';
const B = '0x00000000000000000000000000000000000000b2';
const ZERO = '0x0000000000000000000000000000000000000000';

type Param = AbiParameter & { components?: readonly Param[] };

const isAddress = (p: Param) => p.type === 'address' || p.type === 'address[]';
const tupleHasAddress = (p: Param): boolean =>
  Array.isArray(p.components) && p.components.some((c) => isAddress(c) || tupleHasAddress(c));

/** Every Diamond event that carries an address, by name (first definition). */
const EVENTS: Map<string, readonly Param[]> = (() => {
  const out = new Map<string, readonly Param[]>();
  for (const item of DIAMOND_ABI_VIEM as Abi) {
    if (item.type !== 'event') continue;
    const inputs = (item as AbiEvent).inputs as readonly Param[];
    if (!inputs.some((i) => isAddress(i) || tupleHasAddress(i))) continue;
    if (!out.has(item.name)) out.set(item.name, inputs);
  }
  return out;
})();

/** The input the actor rule reads, found by giving each address its own value. */
function actorInput(kind: string, inputs: readonly Param[]): string | null {
  const args: Record<string, unknown> = {};
  const byValue = new Map<string, string>();
  inputs.forEach((p, i) => {
    if (p.type !== 'address' || !p.name) return;
    const v = `0x${(i + 1).toString(16).padStart(40, '0')}`;
    args[p.name] = v;
    byValue.set(v, p.name);
  });
  const actor = activityActor(kind, args);
  return actor ? (byValue.get(actor) ?? null) : null;
}

describe('activityParticipants — the rule', () => {
  it('names the actor and the listed parties, lower-cased and once each', () => {
    expect(activityParticipants('LoanInitiated', { borrower: A, lender: B })).toEqual([
      A.toLowerCase(),
      B,
    ]);
    expect(activityParticipants('Transfer', { from: A, to: A })).toEqual([A.toLowerCase()]);
  });

  it('drops the zero address (a mint has no sender, a cleared exclusion no owner)', () => {
    expect(activityParticipants('Transfer', { from: ZERO, to: A })).toEqual([A.toLowerCase()]);
    expect(activityParticipants('TierExclusionUpdated', { vaultOwner: ZERO })).toEqual([]);
  });

  it('names nobody for an exempt or unknown kind, whatever its args hold', () => {
    expect(activityParticipants('RoleGranted', { account: A, sender: A })).toEqual([]);
    expect(activityParticipants('TreasurySet', { newTreasury: A })).toEqual([]);
    expect(activityParticipants('NoSuchEvent', { user: A })).toEqual([]);
  });

  it('never names an authorized or configured address', () => {
    expect(activityParticipants('Approval', { owner: A, approved: B })).toEqual([A.toLowerCase()]);
    expect(activityParticipants('KeeperActionsUpdated', { user: A, keeper: B })).toEqual([
      A.toLowerCase(),
    ]);
  });

  it('never reads an Object.prototype member as an entry', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(activityParticipants(name, { user: A })).toEqual([]);
      expect(participantKinds().has(name)).toBe(false);
    }
  });

  it('admits every actor-attributed kind', () => {
    for (const k of actorAttributedKinds()) expect(participantKinds().has(k)).toBe(true);
  });
});

describe('activityParticipants — every address in the Diamond ABI is classified', () => {
  it('reads a Diamond ABI that carries address-bearing events', () => {
    expect(EVENTS.size).toBeGreaterThan(200);
  });

  it('each event is admitted, exempt, or names only non-party addresses', () => {
    const unclassified: string[] = [];
    for (const [kind, inputs] of EVENTS) {
      if (participantKinds().has(kind) || EXEMPT.has(kind)) continue;
      const local = LOCAL_NOT_A_PARTY.get(kind) ?? {};
      const open = inputs.filter(
        (p) =>
          (isAddress(p) && !(NOT_A_PARTY.has(p.name!) || Object.hasOwn(local, p.name!))) ||
          tupleHasAddress(p),
      );
      if (open.length > 0) unclassified.push(`${kind}(${open.map((p) => p.name).join(', ')})`);
    }
    expect(unclassified, 'name the parties in PARTIES or record the kind in EXEMPT').toEqual([]);
  });

  it("each admitted kind's addresses are its actor's, its parties, or not a party", () => {
    const open: string[] = [];
    for (const kind of participantKinds()) {
      const inputs = EVENTS.get(kind);
      if (!inputs) continue; // an actor kind whose actor arg the indexer adds
      const parties = PARTIES.get(kind) ?? [];
      const local = LOCAL_NOT_A_PARTY.get(kind) ?? {};
      const actor = actorInput(kind, inputs);
      for (const p of inputs) {
        if (!isAddress(p)) continue;
        const n = p.name!;
        if (n === actor || parties.includes(n) || NOT_A_PARTY.has(n) || Object.hasOwn(local, n)) continue;
        open.push(`${kind}.${n}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('each listed party is a top-level address input of its kind', () => {
    const bad: string[] = [];
    for (const [kind, parties] of PARTIES) {
      const inputs = EVENTS.get(kind);
      for (const n of parties) {
        if (!inputs?.some((p) => p.name === n && p.type === 'address')) bad.push(`${kind}.${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no party repeats the actor, and no name is both a party and not one', () => {
    const bad: string[] = [];
    for (const [kind, parties] of PARTIES) {
      const inputs = EVENTS.get(kind) ?? [];
      const actor = actorInput(kind, inputs);
      const local = LOCAL_NOT_A_PARTY.get(kind) ?? {};
      for (const n of parties) {
        if (n === actor || NOT_A_PARTY.has(n) || Object.hasOwn(local, n)) bad.push(`${kind}.${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('an exempt kind is never admitted, and every exemption is needed', () => {
    const bad: string[] = [];
    for (const [kind, group] of EXEMPT) {
      expect(Object.hasOwn(EXEMPT_GROUPS, group)).toBe(true);
      if (participantKinds().has(kind)) bad.push(`${kind}: admitted and exempt`);
      const inputs = EVENTS.get(kind);
      if (!inputs) {
        bad.push(`${kind}: no such address-bearing event`);
        continue;
      }
      const local = LOCAL_NOT_A_PARTY.get(kind) ?? {};
      const needed = inputs.some(
        (p) =>
          (isAddress(p) && !NOT_A_PARTY.has(p.name!) && !Object.hasOwn(local, p.name!)) ||
          tupleHasAddress(p),
      );
      if (!needed) bad.push(`${kind}: every address is already not a party`);
    }
    expect(bad).toEqual([]);
  });

  it('every non-party name and local entry is used', () => {
    const used = new Set<string>();
    for (const inputs of EVENTS.values()) for (const p of inputs) if (p.name) used.add(p.name);
    expect([...NOT_A_PARTY.keys()].filter((n) => !used.has(n))).toEqual([]);
    const bad: string[] = [];
    for (const [kind, local] of LOCAL_NOT_A_PARTY) {
      const inputs = EVENTS.get(kind) ?? [];
      for (const n of Object.keys(local)) {
        if (!inputs.some((p) => p.name === n && isAddress(p))) bad.push(`${kind}.${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every event with an address inside a tuple was looked at', () => {
    const unread: string[] = [];
    for (const [kind, inputs] of EVENTS) {
      if (!inputs.some(tupleHasAddress)) continue;
      if (!participantKinds().has(kind) && !EXEMPT.has(kind)) unread.push(kind);
    }
    expect(unread).toEqual([]);
  });
});
