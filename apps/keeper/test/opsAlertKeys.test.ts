/**
 * #2677 — the ops-alert key lookup selects by a literal prefix, so a prefix
 * longer than D1 lets a LIKE pattern be (the undelivered-remittance one names
 * a Diamond and is ~76 bytes) still lists its alerts.
 */
import { describe, expect, it } from 'vitest';
import { listOpsAlertKeys, recordOpsAlertSent } from '../src/db';
import { undeliveredAlertKey, undeliveredAlertPrefix } from '../src/remitRoute';
import { D1_MAX_PATTERN_BYTES } from './helpers/sqliteD1';
import { createKeeperD1 } from './helpers/schemas';

const DIAMOND = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;

async function seeded(keys: string[]) {
  const keeper = createKeeperD1();
  const db = keeper.d1 as Parameters<typeof listOpsAlertKeys>[0];
  for (const key of keys) await recordOpsAlertSent(db, key, 1);
  return { keeper, db };
}

describe('listOpsAlertKeys (#2677)', () => {
  it('lists the undelivered-remittance alerts of one path and Diamond, whose prefix is over the D1 pattern cap', async () => {
    const prefix = undeliveredAlertPrefix('pending', 84532, DIAMOND);
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(D1_MAX_PATTERN_BYTES);
    const mine = [undeliveredAlertKey('pending', 84532, DIAMOND, 'retired', 3), undeliveredAlertKey('pending', 84532, DIAMOND, 'retired', 9)];
    const { db } = await seeded([
      ...mine,
      undeliveredAlertKey('late', 84532, DIAMOND, 'retired', 3),
      undeliveredAlertKey('pending', 84532, OTHER, 'retired', 3),
      undeliveredAlertKey('pending', 421614, DIAMOND, 'retired', 3),
    ]);
    expect((await listOpsAlertKeys(db, prefix)).sort()).toEqual([...mine].sort());
  });

  it('narrows a family to one chain by the key\'s chain segment', async () => {
    const { db } = await seeded([
      'delivery-revert:84532:a',
      'delivery-unwhole:84532:b',
      'delivery-revert:845320:c',
      'delivery-revert:97:d',
      'horizon-revert:84532:e',
    ]);
    expect((await listOpsAlertKeys(db, 'delivery-', 84532)).sort()).toEqual(['delivery-revert:84532:a', 'delivery-unwhole:84532:b']);
    expect((await listOpsAlertKeys(db, 'delivery-')).length).toBe(4);
  });

  it('treats the prefix literally: `%` and `_` match only themselves', async () => {
    const { db } = await seeded(['dayclose-gate:1:x', 'dayclose_gate:1:y', 'daycloseXgate:1:z']);
    expect(await listOpsAlertKeys(db, 'dayclose-')).toEqual(['dayclose-gate:1:x']);
    expect(await listOpsAlertKeys(db, 'dayclose%')).toEqual([]);
  });
});

describe('the test D1 refuses a LIKE or GLOB pattern over the D1 cap (#2677)', () => {
  it('refuses the pattern the old lookup built, and still matches short ones', async () => {
    const { keeper } = await seeded([undeliveredAlertKey('pending', 84532, DIAMOND, 'retired', 3)]);
    const old = `${undeliveredAlertPrefix('pending', 84532, DIAMOND)}%`;
    expect(() => keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert WHERE alert_key LIKE ?1').all(old)).toThrow(
      'LIKE or GLOB pattern too complex',
    );
    expect(() => keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert WHERE alert_key GLOB ?1').all(`${'x'.repeat(51)}*`)).toThrow(
      'LIKE or GLOB pattern too complex',
    );
    expect(keeper.db.prepare(`SELECT 'Remit-X' LIKE 'remit-%' AS a, 'a_c' LIKE 'a\\_c' ESCAPE '\\' AS b, 'abc' GLOB 'a*' AS c`).get()).toEqual(
      expect.objectContaining({ a: 1, b: 1, c: 1 }),
    );
  });
});
