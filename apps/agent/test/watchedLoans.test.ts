/**
 * #3769 — watching a loan the wallet does not hold: the store (on SQLite, as
 * the state object runs it), the signed routes, the alert pass's rules, and
 * the two D1 statements against the shared database's real migrations.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { TelegramStateStore } from '../src/telegramState/store';
import { WatchStore, type WatchLimits, type WatchUpdate } from '../src/telegramState/watches';
import {
  LOAN_BY_ID_SQL,
  handleWatchRoute,
  watchLimitsOf,
  type LoanView,
  type WatchRouteDeps,
} from '../src/watchedLoanRoutes';
import {
  LOANS_BY_IDS_SQL,
  decideWatch,
  runWatchedLoanAlerts,
  type LoanReading,
  type WatchLaneDeps,
} from '../src/watchedLoanAlerts';
import type { TelegramOutcome } from '../src/telegram';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const w = W.toLowerCase();
const OTHER = '0x00000000000000000000000000000000000000ee';
const D1 = '0x00000000000000000000000000000000000000a1';
const D2 = '0x00000000000000000000000000000000000000b2';
const dep = { chainId: 84532, diamond: D1 };
const LIMITS: WatchLimits = { maxLoansPerWallet: 3, maxChangesPerDay: 5 };
const DAY = 86_400;

function store() {
  const h = sqliteDo();
  new TelegramStateStore(h.sql, h.tx); // runs the schema
  return { ...h, watches: new WatchStore(h.sql, h.tx) };
}

describe('watch store', () => {
  it('runs the state object’s schema to the current version', () => {
    const h = sqliteDo();
    new TelegramStateStore(h.sql, h.tx);
    expect(h.db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 3 }]);
  });

  it('adds once, counts the loan limit across chains, and spends nothing on a repeat', () => {
    const { watches } = store();
    expect(watches.add(dep, W, 1, 10, LIMITS)).toBe('added');
    expect(watches.add(dep, W, 1, 10, LIMITS)).toBe('already-watching');
    expect(watches.add({ chainId: 421614, diamond: D2 }, W, 1, 10, LIMITS)).toBe('added');
    expect(watches.add(dep, W, 2, 10, LIMITS)).toBe('added');
    expect(watches.add(dep, W, 3, 10, LIMITS)).toBe('too-many-loans');
    expect(watches.list(W, [dep]).map((x) => x.loanId)).toEqual([1, 2]);
  });

  it('caps adds and removes per day, and starts again the next day', () => {
    const { watches } = store();
    const lim = { maxLoansPerWallet: 10, maxChangesPerDay: 2 };
    expect(watches.add(dep, W, 1, 10, lim)).toBe('added');
    expect(watches.remove(dep, W, 1, 10, lim)).toBe('removed');
    expect(watches.add(dep, W, 1, 10, lim)).toBe('changes-spent');
    expect(watches.remove(dep, W, 9, 10, lim)).toBe('not-watching');
    expect(watches.add(dep, W, 1, 10 + DAY, lim)).toBe('added');
  });

  it('drops a retired Diamond’s watches and works the least recently checked first', () => {
    const { watches } = store();
    watches.add({ chainId: 84532, diamond: D2 }, W, 5, 1, LIMITS);
    watches.add(dep, W, 1, 1, LIMITS);
    watches.add(dep, OTHER, 2, 1, LIMITS);
    watches.record(dep, [{ wallet: w, loanId: 1, lastBand: 'warn' }], 100);
    const due = watches.due(dep, 10);
    expect(due.map((r) => r.loanId)).toEqual([2, 1]);
    expect(due[1]).toMatchObject({ lastBand: 'warn' });
    expect(watches.list(W, [{ chainId: 84532, diamond: D2 }])).toEqual([]);
    watches.record(dep, [{ wallet: w, loanId: 1, end: true }], 200);
    expect(watches.list(W, [dep])).toEqual([]);
  });
});

const ACTIVE: LoanView = { status: 'active', lenderHolder: '0x01', borrowerHolder: '0x02' };

function routeDeps(over: Partial<WatchRouteDeps> = {}): WatchRouteDeps & { authorised: unknown[] } {
  const { watches } = store();
  const authorised: unknown[] = [];
  return {
    authorised,
    state: {
      watchLoan: (d, wa, id, now, l) => watches.add(d, wa, id, now, l),
      unwatchLoan: (d, wa, id, now, l) => watches.remove(d, wa, id, now, l),
      watchedLoans: (wa, deps) => watches.list(wa, deps),
      chatsOf: (pairs) => pairs.map(() => null),
    },
    loanOf: async () => ACTIVE,
    authorise: async (_req, auth) => {
      authorised.push(auth);
      return { ok: true, via: 'ecdsa' };
    },
    deployments: () => [dep],
    limits: LIMITS,
    now: () => 1000,
    ...over,
  };
}

const body = (extra: Record<string, unknown> = {}) => ({
  wallet: W,
  chain_id: 84532,
  issuedAt: 1000,
  signature: '0x' + '11'.repeat(65),
  ...extra,
});

describe('watch routes', () => {
  it('watches an active loan, signed over that loan, and says whether alerts can arrive', async () => {
    const d = routeDeps();
    const res = await handleWatchRoute('/watch/loans/add', body({ loanId: 7 }), d);
    expect(res).toEqual({ status: 200, body: { ok: true, watching: true, already: false, telegramLinked: false } });
    expect(d.authorised).toEqual([{ action: 'watch-loan', loanId: 7 }]);
    const list = await handleWatchRoute('/watch/loans/list', body(), d);
    expect(list.body.loans).toEqual([{ chainId: 84532, loanId: 7, watchedAt: 1000 }]);
    expect(d.authorised[1]).toBe('list-watched');
  });

  it('refuses before taking the signature when the loan is missing, closed or the wallet holds it', async () => {
    for (const [loan, error] of [
      [null, 'loan-not-found'],
      [{ ...ACTIVE, status: 'repaid' }, 'loan-not-active'],
      [{ ...ACTIVE, borrowerHolder: W }, 'wallet-holds-a-position'],
    ] as const) {
      const d = routeDeps({ loanOf: async () => loan });
      const res = await handleWatchRoute('/watch/loans/add', body({ loanId: 7 }), d);
      expect(res.body.error).toBe(error);
      expect(d.authorised).toEqual([]);
    }
  });

  it('refuses an unserved chain, a bad loan id, and a failed signature', async () => {
    expect((await handleWatchRoute('/watch/loans/add', body({ loanId: 7, chain_id: 1 }), routeDeps())).body.error).toBe(
      'chain-not-served',
    );
    expect((await handleWatchRoute('/watch/loans/add', body({ loanId: 0 }), routeDeps())).status).toBe(400);
    const bad = routeDeps({ authorise: async () => ({ ok: false, status: 401, reason: 'no' }) });
    expect((await handleWatchRoute('/watch/loans/remove', body({ loanId: 7 }), bad)).status).toBe(401);
    expect((await handleWatchRoute('/watch/loans/list', body(), bad)).status).toBe(401);
  });

  it('reports the limits by name', async () => {
    const d = routeDeps({ limits: { maxLoansPerWallet: 1, maxChangesPerDay: 9 } });
    await handleWatchRoute('/watch/loans/add', body({ loanId: 1 }), d);
    const res = await handleWatchRoute('/watch/loans/add', body({ loanId: 2 }), d);
    expect(res).toEqual({ status: 409, body: { error: 'too-many-loans', limit: 1 } });
  });

  it('reads the limits from configuration, with the defaults for anything unusable', () => {
    expect(watchLimitsOf({})).toEqual({ maxLoansPerWallet: 10, maxChangesPerDay: 20 });
    expect(watchLimitsOf({ WATCH_MAX_LOANS_PER_WALLET: '4', WATCH_MAX_CHANGES_PER_DAY: 'x' })).toEqual({
      maxLoansPerWallet: 4,
      maxChangesPerDay: 20,
    });
  });
});

const row = (over: Partial<{ lastBand: string; dueToldFor: number; loanId: number }> = {}) => ({
  wallet: w,
  loanId: 7,
  lastBand: 'healthy',
  dueToldFor: 0,
  ...over,
});
const NOW = 2_000_000_000;
const reading = (over: Partial<LoanReading> = {}): LoanReading => ({ hf: 2, maturity: NOW + 30 * DAY, graceEnd: NOW + 33 * DAY, ...over });

describe('watch alert rules', () => {
  it('tells a worse band once and records a recovery silently', () => {
    const fall = decideWatch(row(), ACTIVE, reading({ hf: 1.18 }), NOW);
    expect(fall.events).toEqual([{ kind: 'band', band: 'alert', hf: 1.18 }]);
    expect(fall.onTold.lastBand).toBe('alert');
    expect(decideWatch(row({ lastBand: 'alert' }), ACTIVE, reading({ hf: 1.19 }), NOW).events).toEqual([]);
    const up = decideWatch(row({ lastBand: 'alert' }), ACTIVE, reading({ hf: 2 }), NOW);
    expect(up.events).toEqual([]);
    expect(up.base.lastBand).toBe('healthy');
  });

  it('tells a coming due date once per due date', () => {
    const r = reading({ maturity: NOW + DAY });
    const first = decideWatch(row(), ACTIVE, r, NOW);
    expect(first.events.map((e) => e.kind)).toEqual(['due']);
    expect(decideWatch(row({ dueToldFor: NOW + DAY }), ACTIVE, r, NOW).events).toEqual([]);
    expect(decideWatch(row({ dueToldFor: NOW + DAY }), ACTIVE, reading({ maturity: NOW + 2 * DAY }), NOW).events).toHaveLength(1);
  });

  it('ends the watch when the loan ends, and tells a holder nothing', () => {
    const repaid = decideWatch(row(), { ...ACTIVE, status: 'repaid' }, undefined, NOW);
    expect(repaid.events).toEqual([{ kind: 'repaid' }]);
    expect(repaid.onTold.end).toBe(true);
    expect(decideWatch(row(), { ...ACTIVE, status: 'liquidated' }, undefined, NOW).events).toEqual([
      { kind: 'closed', status: 'liquidated' },
    ]);
    expect(decideWatch(row(), { ...ACTIVE, lenderHolder: W }, reading({ hf: 1.01 }), NOW).events).toEqual([]);
    expect(decideWatch(row(), { ...ACTIVE, lenderHolder: W, status: 'repaid' }, undefined, NOW).events).toEqual([]);
  });

  it('decides nothing for a loan the indexer has not recorded or the chain did not answer', () => {
    expect(decideWatch(row(), undefined, undefined, NOW).events).toEqual([]);
    expect(decideWatch(row(), ACTIVE, undefined, NOW).events).toEqual([]);
  });
});

function lane(outcome: TelegramOutcome, chat: string | null = '42') {
  const { watches } = store();
  watches.add(dep, W, 7, 1, LIMITS);
  const sent: string[] = [];
  const recorded: WatchUpdate[][] = [];
  const deps: WatchLaneDeps = {
    chains: [{ id: 84532, name: 'Base Sepolia', diamond: D1 }],
    state: {
      dueWatches: (d, n) => watches.due(d, n),
      recordWatches: (d, u, now) => {
        recorded.push(u);
        watches.record(d, u, now);
      },
      chatsOf: (pairs) => pairs.map(() => chat),
    },
    loans: async () => new Map([[7, ACTIVE]]),
    reader: () => ({ costs: 1, read: async () => new Map([[7, reading({ hf: 1.1 })]]) }),
    send: async (_c, text) => {
      sent.push(text);
      return outcome;
    },
    appOrigin: 'https://app.example',
    now: NOW,
  };
  return { watches, sent, recorded, deps };
}

describe('watch alert pass', () => {
  it('sends to the linked chat and records the band as told', async () => {
    const t = lane('accepted');
    expect(await runWatchedLoanAlerts(t.deps)).toEqual({ sent: 1 });
    expect(t.sent[0]).toContain('Your wallet holds no position in it.');
    expect(t.watches.due(dep, 5)[0]!.lastBand).toBe('alert');
    await runWatchedLoanAlerts(t.deps);
    expect(t.sent).toHaveLength(1);
  });

  it('sends again next run when Telegram did not take the message', async () => {
    const t = lane('transient');
    await runWatchedLoanAlerts(t.deps);
    expect(t.watches.due(dep, 5)[0]!.lastBand).toBe('healthy');
    await runWatchedLoanAlerts(t.deps);
    expect(t.sent).toHaveLength(2);
  });

  it('with no chat linked, sends nothing and leaves nothing pending', async () => {
    const t = lane('accepted', null);
    await runWatchedLoanAlerts(t.deps);
    expect(t.sent).toEqual([]);
    expect(t.watches.due(dep, 5)[0]!.lastBand).toBe('alert');
  });
});

describe('the two D1 statements, on the shared database’s migrations', () => {
  const MIGRATIONS = new URL('../../indexer/migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  db.prepare(
    `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower, principal, collateral_amount,
       lender_current_owner, borrower_current_owner, start_block, start_at, updated_at)
     VALUES (84532, 7, 1, 'active', '0x1', '0x2', '1', '1', '0x3', '0x4', 1, 1, 1)`,
  ).run();

  it('read a loan and loans by id', () => {
    expect(db.prepare(LOAN_BY_ID_SQL).get(84532, 7)).toEqual({
      status: 'active',
      lender_current_owner: '0x3',
      borrower_current_owner: '0x4',
    });
    expect(db.prepare(LOANS_BY_IDS_SQL).all(84532, JSON.stringify([7, 8]))).toHaveLength(1);
  });
});
