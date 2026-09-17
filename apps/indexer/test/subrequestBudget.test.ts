import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_WRITE_RESERVE,
  MAX_SUBREQUESTS_PER_INVOCATION,
  canAfford,
  createBudget,
  meterD1,
  meterEnv,
  meterFetch,
  overspent,
  spend,
  spent,
} from '../src/subrequestBudget';

/**
 * A stand-in for the D1 binding that records what was actually called, so these
 * tests assert the COST MODEL rather than a re-statement of the implementation.
 */
function fakeDb() {
  const calls: string[] = [];
  const statement = (sql: string) => ({
    sql,
    bind(...args: unknown[]) {
      calls.push(`bind:${sql}:${args.length}`);
      return statement(sql);
    },
    async first() {
      calls.push(`first:${sql}`);
      return { sql };
    },
    async run() {
      calls.push(`run:${sql}`);
      return { success: true };
    },
    async all() {
      calls.push(`all:${sql}`);
      return { results: [] };
    },
    async raw() {
      calls.push(`raw:${sql}`);
      return [];
    },
  });
  return {
    calls,
    db: {
      prepare(sql: string) {
        calls.push(`prepare:${sql}`);
        return statement(sql);
      },
      async batch(statements: unknown[]) {
        calls.push(`batch:${statements.length}`);
        return [];
      },
      async exec(sql: string) {
        calls.push(`exec:${sql}`);
        return { count: 1 };
      },
    },
  };
}

describe('subrequest budget', () => {
  it('starts at the tier ceiling', () => {
    expect(createBudget().remaining).toBe(MAX_SUBREQUESTS_PER_INVOCATION);
    expect(MAX_SUBREQUESTS_PER_INVOCATION).toBe(50);
  });

  it('reports what has been spent, not merely what is left', () => {
    const budget = createBudget();
    spend(budget);
    spend(budget);
    expect(spent(budget)).toBe(2);
    expect(budget.remaining).toBe(48);
  });

  it('does NOT throw when exhausted — it reports', () => {
    // An exception here would unwind past the cursor write, which is the exact
    // frozen-chain failure the budget exists to prevent.
    const budget = createBudget(1);
    expect(spend(budget)).toBe(true);
    expect(() => spend(budget)).not.toThrow();
    expect(overspent(budget)).toBe(true);
  });

  it('counts against ITS OWN limit, not the default one', () => {
    // #2227 r1 `4033546291`: a budget created with a limit of 5 that had
    // issued 5 requests reported 45 spent, because the reporter subtracted
    // from the default 50. A figure neither true nor obviously false is the
    // worst kind, and one object knowing its own ceiling makes it unsayable.
    const budget = createBudget(5);
    spend(budget);
    spend(budget);
    expect(budget.limit).toBe(5);
    expect(spent(budget)).toBe(2);
    expect(budget.remaining).toBe(3);
  });

  it('announces the ceiling AT the crossing, once, naming the scope', () => {
    // #2227 r1 `4033546277`: the announcement used to sit after the pass's
    // work, where it could not run — the platform kills the invocation at the
    // request that crosses the ceiling. Announcing inside `spend()` happens
    // BEFORE that request is issued, which is the last moment anything here
    // is guaranteed to execute.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const budget = createBudget(2, 'chain 84532 pass');
      spend(budget);
      spend(budget);
      expect(warn).not.toHaveBeenCalled();
      spend(budget); // the crossing
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('chain 84532 pass');
      spend(budget); // still over — but already announced
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('canAfford', () => {
  it('keeps the cursor write affordable after the work', () => {
    const budget = createBudget(5);
    // 4 units of work + the reserved cursor write exactly fits.
    expect(canAfford(budget, 4)).toBe(true);
    // 5 would leave nothing to record progress with.
    expect(canAfford(budget, 5)).toBe(false);
  });

  it('defaults its reserve to the cursor write', () => {
    const budget = createBudget(3);
    expect(canAfford(budget, 3, 0)).toBe(true);
    expect(canAfford(budget, 3)).toBe(false);
    expect(CURSOR_WRITE_RESERVE).toBe(1);
  });
});

describe('meterD1 cost model', () => {
  it('charges the terminal, not prepare()', () => {
    const { db, calls } = fakeDb();
    const budget = createBudget();
    const metered = meterD1(db, budget);

    metered.prepare('SELECT 1');
    expect(budget.remaining).toBe(50); // built locally, sent nothing

    void metered.prepare('SELECT 2').run!();
    expect(budget.remaining).toBe(49);
    expect(calls).toContain('run:SELECT 2');
  });

  it.each(['first', 'run', 'all', 'raw'] as const)(
    'charges one request for .%s()',
    async (terminal) => {
      const { db } = fakeDb();
      const budget = createBudget();
      const stmt = meterD1(db, budget).prepare('SELECT 1') as Record<
        string,
        () => Promise<unknown>
      >;
      await stmt[terminal]();
      expect(spent(budget)).toBe(1);
    },
  );

  it('still charges after bind() — the bound statement is a NEW object', () => {
    // Most statements on this lane are bound. If bind() returned the unwrapped
    // statement, nearly every request would go uncounted.
    const { db } = fakeDb();
    const budget = createBudget();
    void meterD1(db, budget).prepare('SELECT ?').bind!(1).run!();
    expect(spent(budget)).toBe(1);
  });

  it('charges bind() itself nothing', () => {
    const { db } = fakeDb();
    const budget = createBudget();
    meterD1(db, budget).prepare('SELECT ?').bind!(1).bind!(2);
    expect(spent(budget)).toBe(0);
  });

  it('charges a batch ONCE, whatever its length', () => {
    // The whole array travels as one subrequest. Charging per statement would
    // make the counter refuse work that actually fits.
    const { db } = fakeDb();
    const budget = createBudget();
    const metered = meterD1(db, budget);
    const statements = Array.from({ length: 9 }, (_, i) =>
      metered.prepare(`INSERT ${i}`),
    );
    void metered.batch!(statements);
    expect(spent(budget)).toBe(1);
  });

  it('charges exec() one request', () => {
    const { db } = fakeDb();
    const budget = createBudget();
    void meterD1(db, budget).exec!('PRAGMA foo');
    expect(spent(budget)).toBe(1);
  });

  it('counts a call site nobody updated — the point of the wrapper', async () => {
    // #2221's root: a hand-maintained enumeration lets a NEW call site escape.
    // Here a request added by code that has never heard of the budget is still
    // counted, because the binding it goes through is the thing that counts.
    //
    // AWAITED, not `void`-ed: the second request is issued after the first
    // resolves, so asserting without awaiting would read the counter one
    // request early and pass for the wrong reason.
    const { db } = fakeDb();
    const budget = createBudget();
    const metered = meterD1(db, budget);

    async function codeWrittenLaterThatIgnoresTheBudget(handle: typeof db) {
      await handle.prepare('SELECT something_new').bind(1).run();
      await handle.batch([handle.prepare('a'), handle.prepare('b')]);
    }

    await codeWrittenLaterThatIgnoresTheBudget(metered);
    expect(spent(budget)).toBe(2);
  });

  it('passes results through unchanged', async () => {
    const { db } = fakeDb();
    const metered = meterD1(db, createBudget());
    await expect(metered.prepare('SELECT 1').first!()).resolves.toEqual({
      sql: 'SELECT 1',
    });
  });
});

describe('meterFetch — the egress rule', () => {
  it('charges one request per outbound call, whoever makes it', async () => {
    const budget = createBudget();
    const send = meterFetch(budget, (async () => new Response('ok')) as typeof fetch);
    await send('https://example.test/a');
    await send('https://example.test/b');
    expect(spent(budget)).toBe(2);
  });

  it('charges EACH ATTEMPT, which is what object-metering missed', async () => {
    // #2227 r1 `4033546264`: viem retries a failed request up to three more
    // times underneath ONE client method call. Counting the method call gave
    // 1 where the platform counted 4 — and only when a provider was failing,
    // i.e. exactly when the number mattered. At egress there is no such gap:
    // an attempt is a call.
    const budget = createBudget();
    let attempts = 0;
    const flaky = (async () => {
      attempts += 1;
      if (attempts < 4) throw new Error('rate limited');
      return new Response('ok');
    }) as typeof fetch;
    const send = meterFetch(budget, flaky);
    for (let i = 0; i < 4; i += 1) {
      try {
        await send('https://example.test/rpc');
      } catch {
        /* the retry loop viem runs for us */
      }
    }
    expect(attempts).toBe(4);
    expect(spent(budget)).toBe(4);
  });

  it('meters a non-global sender, so a DO ping counts too', async () => {
    const budget = createBudget();
    const stub = { fetch: async () => new Response('pong') };
    const send = meterFetch(budget, stub.fetch.bind(stub) as typeof fetch);
    await send('https://chain-ingest-do/trigger');
    expect(spent(budget)).toBe(1);
  });

  it('passes the response through untouched', async () => {
    const send = meterFetch(
      createBudget(),
      (async () => new Response('body')) as typeof fetch,
    );
    await expect((await send('https://example.test')).text()).resolves.toBe(
      'body',
    );
  });
});

describe('meterEnv', () => {
  it('meters both handles the invocation actually uses', async () => {
    const { db } = fakeDb();
    const budget = createBudget();
    const env = meterEnv(
      { DB: db, other: 'untouched' },
      budget,
    ) as unknown as {
      DB: ReturnType<typeof fakeDb>['db'];
      fetchFn: typeof fetch;
      other: string;
    };
    await env.DB.prepare('SELECT 1').first();
    // A sender is present on the env, which is the whole reason a helper five
    // calls deep can be counted without being handed a budget.
    expect(typeof env.fetchFn).toBe('function');
    expect(env.other).toBe('untouched');
    expect(spent(budget)).toBe(1);
  });

  it('is idempotent — metering twice counts once', async () => {
    // The cron entry point meters the env and hands it to a pass that meters
    // what it is given. Double-counting there would inflate every tick's
    // figure by the share of its work that is D1.
    const { db } = fakeDb();
    const budget = createBudget();
    const once = meterEnv({ DB: db }, budget);
    const twice = meterEnv(once, budget);
    await (
      twice as unknown as { DB: ReturnType<typeof fakeDb>['db'] }
    ).DB.prepare('SELECT 1').first();
    expect(spent(budget)).toBe(1);
  });
});
