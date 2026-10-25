/**
 * #2760 — the remit pass names a finalized day that is still owed and says
 * why, from the send's own verdict, and stays quiet about a day that owed the
 * mirror nothing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REMIT_DAY_STATUSES,
  owedButBlocked,
  remitDayStatusName,
  remitStatusReadFailure,
} from '../src/remitDayStatus';

const FACET_SRC = new URL('../../../contracts/src/facets/RewardRemittanceFacet.sol', import.meta.url);

describe('#2760 remit day statuses', () => {
  it('names the statuses in the contract enum order', () => {
    const src = readFileSync(FACET_SRC, 'utf8');
    const body = /enum RemitDayStatus \{([^}]*)\}/.exec(src)?.[1];
    expect(body, 'the enum is declared in the facet').toBeDefined();
    const members = body!
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    expect(members).toEqual([...REMIT_DAY_STATUSES]);
  });

  it('decodes a uint8 and refuses a value it cannot name', () => {
    expect(remitDayStatusName(0)).toBe('NotFinalized');
    expect(remitDayStatusName(8n)).toBe('Closeable');
    expect(remitDayStatusName(9)).toBeUndefined();
    expect(remitDayStatusName('x')).toBeUndefined();
  });

  it('reports only the days still owed, each with its reason', () => {
    const days = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];
    const blocked = owedButBlocked(days, [
      'Remitted',
      'Closed',
      'NothingOwed',
      'Closeable',
      'AwaitingCommitment',
      'Unbacked',
      'Ineligible',
      'Repeated',
    ]);
    expect(blocked.map((b) => [b.day, b.status])).toEqual([
      [5n, 'AwaitingCommitment'],
      [6n, 'Unbacked'],
      [7n, 'Ineligible'],
    ]);
    expect(blocked.every((b) => b.reason.length > 0)).toBe(true);
  });

  it('a day that owed this mirror nothing is never reported', () => {
    expect(owedButBlocked([1n, 2n], ['NothingOwed', 'NothingOwed'])).toEqual([]);
  });

  it('only the Diamond saying it routes no such view counts as an older build', () => {
    expect(remitStatusReadFailure({ revert: { name: 'FunctionDoesNotExist' } }).kind).toBe('unrouted');
    expect(remitStatusReadFailure({ data: '0xa9ad62f8' }).kind).toBe('unrouted');
    expect(remitStatusReadFailure(new Error('fetch failed')).kind).toBe('unread');
  });
});
