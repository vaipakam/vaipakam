import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRICE_GUARD_KIND_KNOB,
  PRICE_GUARD_KIND_NAMES,
  PRICE_GUARD_SOURCE_NAMES,
  SECONDARY_REMOVAL_KIND,
  priceGuardKindName,
} from './priceGuardChanges';
import { PRICE_GUARD_KNOB_GETTERS } from './protocolKnobs';
import { PriceGuardABI } from '@vaipakam/contracts/abis';

const STATE_SOURCE = readFileSync(
  new URL('../../../contracts/src/oracle/PriceGuardState.sol', import.meta.url),
  'utf8',
);

/** The members of `enum <name> { ... }` in the contract source, comments stripped. */
function enumMembers(name: string): string[] {
  const code = STATE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(code);
  if (!m) throw new Error(`enum ${name} not found in PriceGuardState.sol`);
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('price guard change kinds (#3453)', () => {
  it('mirror PriceGuardState.Kind by position', () => {
    expect([...PRICE_GUARD_KIND_NAMES]).toEqual(enumMembers('Kind'));
  });

  it('mirror PriceGuardState.Source by position', () => {
    expect([...PRICE_GUARD_SOURCE_NAMES]).toEqual(enumMembers('Source'));
  });

  it('keep the removal marker outside the enum', () => {
    expect(SECONDARY_REMOVAL_KIND).toBeGreaterThanOrEqual(PRICE_GUARD_KIND_NAMES.length);
    expect(priceGuardKindName(SECONDARY_REMOVAL_KIND)).toBe('SecondaryRemoval');
    expect(priceGuardKindName(2)).toBe('EthNumeraireFeed');
    expect(priceGuardKindName(PRICE_GUARD_KIND_NAMES.length)).toBeNull();
  });

  it('map each unkeyed kind to a setting the console publishes', () => {
    const keys = new Set<string>(PRICE_GUARD_KNOB_GETTERS.map((k) => k.key));
    for (const key of Object.values(PRICE_GUARD_KIND_KNOB)) expect(keys.has(key as string)).toBe(true);
  });

  it('name events the guard ABI declares, with the arguments the indexer reads', () => {
    const events = new Map(
      (PriceGuardABI as readonly { type: string; name?: string; inputs?: { name: string }[] }[])
        .filter((e) => e.type === 'event')
        .map((e) => [e.name, (e.inputs ?? []).map((i) => i.name)]),
    );
    expect(events.get('ChangeProposed')).toEqual(['kind', 'subject', 'value', 'executableAt']);
    expect(events.get('ChangeCancelled')?.slice(0, 2)).toEqual(['kind', 'subject']);
    expect(events.get('ConfigSet')).toEqual(['kind', 'subject', 'value']);
    expect(events.get('SecondaryRemovalProposed')).toEqual(['source', 'by', 'executableAt']);
    expect(events.get('SecondaryRemovalCancelled')?.[0]).toBe('source');
    expect(events.get('SecondaryRemoved')).toEqual(['source']);
  });
});
