/**
 * `GET /assets/issuer-powers` (#3433): the keeper's issuer-power results,
 * read against migration 0117's real DDL.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ISSUER_CHECKER_VERSION } from '@vaipakam/lib/issuerPowers';
import { createSqliteD1 } from './helpers/sqliteD1';
import { handleAssetIssuerPowers, parseAssetAddress, type IssuerPowers } from '../src/issuerPowers';

const DDL = [readFileSync(new URL('../migrations/0117_asset_issuer_powers.sql', import.meta.url), 'utf8')];
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const NFT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';

function seeded() {
  const h = createSqliteD1(DDL);
  const check = h.db.prepare(
    'INSERT INTO asset_issuer_check (chain_id, address, kind, checked_at, block_number, checker_version, complete, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  check.run(1, USDC, 'erc20', 1_000, 100, '1', 1, null);
  check.run(1, NFT, 'erc721', 2_000, 200, '1', 0, 'conduit simulation timed out');
  check.run(8453, USDC, 'erc20', 1_000, 100, '1', 1, null);
  const f = h.db.prepare('INSERT INTO asset_issuer_finding (chain_id, address, check_id, result, evidence, checked_at) VALUES (?, ?, ?, ?, ?, ?)');
  f.run(1, USDC, 'upgradeable_proxy', 'found', 'EIP-1967 implementation slot set', 1_000);
  f.run(1, USDC, 'freeze', 'found', 'blacklist(address)', 1_000);
  f.run(1, USDC, 'future_power', 'not_found', null, 1_000);
  f.run(1, NFT, 'conduit_transfer', 'unknown', null, 2_000);
  f.run(1, NFT, 'soulbound', 'not_found', null, 1_500); // left from an older run
  return h;
}

const get = (db: unknown, qs: string) => handleAssetIssuerPowers(new Request(`https://idx.test/assets/issuer-powers${qs}`), db as never);

describe('GET /assets/issuer-powers', () => {
  it('states each asset’s run and findings, keeping unknown check ids', async () => {
    const res = await get(seeded().d1, '?chainId=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = (await res.json()) as IssuerPowers;
    expect(body.currentCheckerVersion).toBe(ISSUER_CHECKER_VERSION);
    expect(body.notChecked).toEqual([]);
    expect(body.assets.map((a) => a.address)).toEqual([USDC, NFT]);
    expect(body.assets[0]).toEqual({
      address: USDC,
      kind: 'erc20',
      checkedAt: 1_000,
      blockNumber: 100,
      checkerVersion: '1',
      complete: true,
      detail: null,
      checks: [
        { check: 'freeze', result: 'found', evidence: 'blacklist(address)', known: true },
        { check: 'future_power', result: 'not_found', evidence: null, known: false },
        { check: 'upgradeable_proxy', result: 'found', evidence: 'EIP-1967 implementation slot set', known: true },
      ],
    });
  });

  it('never mixes a finding from another run into the stored run', async () => {
    const body = (await (await get(seeded().d1, '?chainId=1')).json()) as IssuerPowers;
    expect(body.assets[1].complete).toBe(false);
    expect(body.assets[1].detail).toBe('conduit simulation timed out');
    expect(body.assets[1].checks).toEqual([{ check: 'conduit_transfer', result: 'unknown', evidence: null, known: true }]);
  });

  it('reads the run and its findings in one statement, so a refresh cannot split them', async () => {
    const d1 = seeded().d1 as { prepare(sql: string): unknown };
    let statements = 0;
    const counting = {
      prepare(sql: string) {
        statements++;
        return d1.prepare(sql);
      },
    };
    const body = (await (await get(counting, '?chainId=1')).json()) as IssuerPowers;
    expect(statements).toBe(1);
    expect(body.assets[0].checks).toHaveLength(3);
  });

  it('answers one asset, and names an unchecked one as not checked', async () => {
    const one = (await (await get(seeded().d1, `?chainId=1&address=${USDC.toUpperCase().replace('0X', '0x')}`)).json()) as IssuerPowers;
    expect(one.assets.map((a) => a.address)).toEqual([USDC]);
    const none = (await (await get(seeded().d1, `?chainId=10&address=${USDC}`)).json()) as IssuerPowers;
    expect(none.assets).toEqual([]);
    expect(none.notChecked).toEqual([USDC]);
  });

  it('refuses a malformed chain id or address', async () => {
    for (const qs of ['', '?chainId=0', `?chainId=1&address=0x12`, '?chainId=1&address=']) {
      expect((await get(seeded().d1, qs)).status).toBe(400);
    }
    expect(parseAssetAddress(null)).toBeUndefined();
  });

  it('answers 503, never an empty list, before the migration is applied', async () => {
    const res = await get(createSqliteD1([]).d1, '?chainId=1');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a row the migration does not admit', () => {
    const h = createSqliteD1(DDL);
    const f = h.db.prepare('INSERT INTO asset_issuer_finding (chain_id, address, check_id, result, evidence, checked_at) VALUES (?, ?, ?, ?, ?, ?)');
    expect(() => f.run(1, USDC.toUpperCase().replace('0X', '0x'), 'freeze', 'found', null, 1)).toThrow();
    expect(() => f.run(1, USDC, 'freeze', 'safe', null, 1)).toThrow();
    const c = h.db.prepare(
      'INSERT INTO asset_issuer_check (chain_id, address, kind, checked_at, block_number, checker_version, complete, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    expect(() => c.run(1, USDC, 'erc4626', 1, 1, '1', 1, null)).toThrow();
    expect(() => c.run(1, USDC, 'erc20', 1, 1, '', 1, null)).toThrow();
  });
});
