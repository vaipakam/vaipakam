/**
 * #3734 — the Terms standing the indexer reads off the on-chain record.
 *
 * Pinned: the fold of publications, announcements, withdrawals and
 * comings-into-force (design section 5); the standing rule (section 3: an
 * acceptance counts only for a version in force from the minimum to the
 * latest); per-network isolation; an unreadable record reads `unknown`;
 * and the book's marks — a sale listing is never marked, every other open
 * offer and every signed order carries its maker's standing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  foldTermsRecord,
  makerStandings,
  termsAcceptanceStatement,
  termsChangeStatement,
  walletStanding,
  walletTerms,
  TERMS_EVENTS_WIRED,
  type TermsChange,
} from '../src/termsStanding';
import { handleOfferById } from '../src/offerRoutes';
import { handleTermsWallet } from '../src/termsRoutes';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrations = (upTo?: string) =>
  migrationFiles()
    .filter((f) => upTo === undefined || f < upTo)
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const MIGRATION_0100 = migrationFiles().find((f) => f.startsWith('0100_'))!;

const CHAIN = 84532;
const OTHER_CHAIN = 421614;
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b0';
const DAY = 86_400;

let log = 0;
const change = (
  kind: TermsChange['kind'],
  version: number,
  at: number,
  extra: Partial<TermsChange> = {},
): TermsChange => ({
  blockNumber: at,
  logIndex: log++,
  kind,
  version,
  termsHash: null,
  movesMinimum: false,
  inForceAt: kind === 'published' ? at : null,
  blockAt: at,
  ...extra,
});

describe('foldTermsRecord', () => {
  it('no change: nothing in force', () => {
    expect(foldTermsRecord([], 100)).toEqual({ inForce: [], minimum: null, latest: null, pending: null });
  });

  it('the first publication sets the minimum and the latest', () => {
    const r = foldTermsRecord([change('published', 1, 10)], 100);
    expect(r).toMatchObject({ inForce: [1], minimum: 1, latest: 1, pending: null });
  });

  it('a small change moves the latest and keeps the minimum', () => {
    const r = foldTermsRecord([change('published', 1, 10), change('published', 2, 20)], 100);
    expect(r).toMatchObject({ inForce: [1, 2], minimum: 1, latest: 2 });
  });

  it('an announcement changes nothing until its time, then raises the minimum', () => {
    const changes = [
      change('published', 1, 10),
      change('announced', 2, 20, { movesMinimum: true, inForceAt: 20 + 14 * DAY }),
    ];
    const before = foldTermsRecord(changes, 20 + 14 * DAY - 1);
    expect(before).toMatchObject({ inForce: [1], minimum: 1, latest: 1 });
    expect(before.pending).toEqual({ version: 2, inForceAt: 20 + 14 * DAY, movesMinimum: true });
    const after = foldTermsRecord(changes, 20 + 14 * DAY);
    expect(after).toMatchObject({ inForce: [1, 2], minimum: 2, latest: 2, pending: null });
  });

  it('a coming-into-force event applies the open announcement at once', () => {
    const r = foldTermsRecord(
      [
        change('published', 1, 10),
        change('announced', 2, 20, { movesMinimum: true, inForceAt: 1_000 }),
        change('in-force', 2, 30, { movesMinimum: true }),
      ],
      40,
    );
    expect(r).toMatchObject({ inForce: [1, 2], minimum: 2, latest: 2, pending: null });
  });

  it('a withdrawn new version never comes into force', () => {
    const r = foldTermsRecord(
      [
        change('published', 1, 10),
        change('announced', 2, 20, { movesMinimum: true, inForceAt: 50 }),
        change('withdrawn', 2, 30),
      ],
      1_000,
    );
    expect(r).toMatchObject({ inForce: [1], minimum: 1, latest: 1, pending: null });
  });

  it('withdrawing a raise to the already-latest version keeps that version in force', () => {
    const r = foldTermsRecord(
      [
        change('published', 1, 10),
        change('published', 2, 20),
        change('announced', 2, 30, { movesMinimum: true, inForceAt: 60 }),
        change('withdrawn', 2, 40),
      ],
      1_000,
    );
    expect(r).toMatchObject({ inForce: [1, 2], minimum: 1, latest: 2, pending: null });
  });

  it('a raise to the already-latest version moves only the minimum', () => {
    const r = foldTermsRecord(
      [
        change('published', 1, 10),
        change('published', 2, 20),
        change('announced', 2, 30, { movesMinimum: true, inForceAt: 60 }),
      ],
      60,
    );
    expect(r).toMatchObject({ inForce: [1, 2], minimum: 2, latest: 2 });
  });

  it('reads the log in log order, whatever order it is given', () => {
    const a = change('published', 1, 10);
    const b = change('published', 2, 20);
    expect(foldTermsRecord([b, a], 100)).toEqual(foldTermsRecord([a, b], 100));
  });
});

describe('walletStanding', () => {
  const v1v2 = foldTermsRecord([change('published', 1, 10), change('published', 2, 20)], 100);

  it('no Terms in force: nobody is marked', () => {
    expect(walletStanding(foldTermsRecord([], 0), [])).toEqual({ state: 'no-terms-in-force' });
  });

  it('an older version that still counts is current', () => {
    expect(walletStanding(v1v2, [1])).toMatchObject({ state: 'current', acceptedVersion: 1 });
  });

  it('no acceptance is not current', () => {
    expect(walletStanding(v1v2, [])).toEqual({
      state: 'not-current',
      reason: 'no-acceptance',
      minimumVersion: 1,
      latestVersion: 2,
    });
  });

  it('after a material change, an acceptance below the minimum no longer counts', () => {
    const r = foldTermsRecord(
      [change('published', 1, 10), change('announced', 2, 20, { movesMinimum: true, inForceAt: 30 })],
      30,
    );
    expect(walletStanding(r, [1])).toMatchObject({ state: 'not-current', reason: 'below-minimum' });
    expect(walletStanding(r, [1, 2])).toMatchObject({ state: 'current', acceptedVersion: 2 });
  });

  it('during the notice: current, with the date it stops unless it accepts the new version', () => {
    const r = foldTermsRecord(
      [change('published', 1, 10), change('announced', 2, 20, { movesMinimum: true, inForceAt: 500 })],
      100,
    );
    expect(walletStanding(r, [1])).toMatchObject({ state: 'current', stopsBeingCurrentAt: 500 });
    // Accepting the announced version early keeps it current with no gap.
    expect(walletStanding(r, [1, 2])).toMatchObject({ state: 'current', acceptedVersion: 1, stopsBeingCurrentAt: null });
    // An acceptance of only the announced version does not make it current yet.
    expect(walletStanding(r, [2])).toMatchObject({ state: 'not-current', reason: 'accepted-version-not-in-force' });
  });

  it('an acceptance of a withdrawn version never counts', () => {
    const r = foldTermsRecord(
      [
        change('published', 1, 10),
        change('announced', 2, 20, { movesMinimum: true, inForceAt: 50 }),
        change('withdrawn', 2, 30),
        change('published', 3, 40),
      ],
      1_000,
    );
    expect(r).toMatchObject({ inForce: [1, 3], minimum: 1, latest: 3 });
    expect(walletStanding(r, [2])).toMatchObject({ state: 'not-current', reason: 'accepted-version-not-in-force' });
  });
});

type H = ReturnType<typeof createSqliteD1>;
const envOf = (h: H) => ({ DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9', RPC_ARB_SEPOLIA: 'http://127.0.0.1:9' }) as unknown as Env;

const seedRecord = async (h: H, chainId: number, changes: TermsChange[]) => {
  for (const c of changes) await termsChangeStatement(h.d1 as unknown as D1Database, chainId, { ...c, txHash: '0xAB' }).run();
};
const seedAcceptance = async (h: H, chainId: number, wallet: string, version: number, block = 50) => {
  await termsAcceptanceStatement(h.d1 as unknown as D1Database, chainId, {
    wallet,
    version,
    termsHash: '0xF00',
    acceptedAt: block,
    blockNumber: block,
    logIndex: 0,
    txHash: `0xACC${version}`,
  }).run();
};

describe('the stored record', () => {
  it('is per network: an acceptance on another network never counts', async () => {
    const h = createSqliteD1(migrations());
    await seedRecord(h, CHAIN, [change('published', 1, 10)]);
    await seedRecord(h, OTHER_CHAIN, [change('published', 1, 10)]);
    await seedAcceptance(h, OTHER_CHAIN, ALICE, 1);
    const s = await makerStandings(envOf(h), CHAIN, [ALICE.toUpperCase().replace('0X', '0x')], 100, { wired: true });
    expect(s.get(ALICE)).toMatchObject({ state: 'not-current', reason: 'no-acceptance' });
    const o = await makerStandings(envOf(h), OTHER_CHAIN, [ALICE], 100, { wired: true });
    expect(o.get(ALICE)).toMatchObject({ state: 'current' });
  });

  it('a repeated acceptance keeps the first record', async () => {
    const h = createSqliteD1(migrations());
    await seedRecord(h, CHAIN, [change('published', 1, 10)]);
    await seedAcceptance(h, CHAIN, ALICE, 1, 50);
    await seedAcceptance(h, CHAIN, ALICE, 1, 60);
    const w = await walletTerms(envOf(h), CHAIN, ALICE, 100, { wired: true });
    expect(w.accepted).toEqual([{ version: 1, termsHash: '0xf00', acceptedAt: 50, blockNumber: 50, txHash: '0xacc1' }]);
    expect(w.standing).toMatchObject({ state: 'current', acceptedVersion: 1 });
  });

  it('an empty record on a wired build: no Terms in force, nobody marked', async () => {
    const h = createSqliteD1(migrations());
    const s = await makerStandings(envOf(h), CHAIN, [ALICE], 100, { wired: true });
    expect(s.get(ALICE)).toEqual({ state: 'no-terms-in-force' });
  });

  it('a database before migration 0100 reads unknown', async () => {
    const h = createSqliteD1(migrations(MIGRATION_0100));
    const s = await makerStandings(envOf(h), CHAIN, [ALICE], 100, { wired: true });
    expect(s.get(ALICE)).toEqual({ state: 'unknown' });
    const w = await walletTerms(envOf(h), CHAIN, ALICE, 100, { wired: true });
    expect(w).toMatchObject({ standing: { state: 'unknown' }, accepted: null, record: null });
  });

  it('a build that does not decode the Terms events yet reads unknown, not "none in force"', async () => {
    expect(TERMS_EVENTS_WIRED).toBe(false);
    const h = createSqliteD1(migrations());
    await seedRecord(h, CHAIN, [change('published', 1, 10)]);
    await seedAcceptance(h, CHAIN, ALICE, 1);
    const s = await makerStandings(envOf(h), CHAIN, [ALICE], 100);
    expect(s.get(ALICE)).toEqual({ state: 'unknown' });
  });
});

describe('the book and the wallet read', () => {
  const seedOffer = (h: H, offerId: number, creator: string, extra: Record<string, string | number> = {}) => {
    const row: Record<string, string | number> = {
      chain_id: CHAIN,
      offer_id: offerId,
      status: 'active',
      creator,
      offer_type: 0,
      asset_type: 0,
      collateral_asset_type: 0,
      lending_asset: '0xa1',
      collateral_asset: '0xb1',
      amount: '1000',
      interest_rate_bps: 500,
      collateral_amount: '150',
      duration_days: 30,
      first_seen_block: 1,
      first_seen_at: 1,
      updated_at: 1,
      ...extra,
    };
    const cols = Object.keys(row);
    h.db
      .prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(cols.map((k) => row[k]) as never[]));
  };
  const fetchOffer = async (h: H, offerId: number) => {
    const res = await handleOfferById(new Request(`https://x/offers/${offerId}?chainId=${CHAIN}`), envOf(h), String(offerId));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  it('a sale listing is never marked; an open offer carries its maker standing; a closed one carries none', async () => {
    const h = createSqliteD1(migrations());
    seedOffer(h, 1, BOB, { is_sale_vehicle: 1 });
    seedOffer(h, 2, BOB);
    seedOffer(h, 3, BOB, { is_offset_vehicle: 1 });
    seedOffer(h, 4, BOB, { status: 'cancelled' });
    expect((await fetchOffer(h, 1)).makerTerms).toEqual({ state: 'exempt' });
    // Not wired yet: the record is not read, so the standing is stated unknown.
    expect((await fetchOffer(h, 2)).makerTerms).toEqual({ state: 'unknown' });
    expect((await fetchOffer(h, 3)).makerTerms).toEqual({ state: 'unknown' });
    expect((await fetchOffer(h, 4)).makerTerms).toBeNull();
  });

  it('the wallet read answers 503 unknown while the record cannot be read', async () => {
    const h = createSqliteD1(migrations());
    const res = await handleTermsWallet(new Request(`https://x/terms/${ALICE}?chainId=${CHAIN}`), envOf(h), ALICE);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ chainId: CHAIN, wallet: ALICE, standing: { state: 'unknown' }, accepted: null });
  });
});
