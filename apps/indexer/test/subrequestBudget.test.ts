import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_WRITE_RESERVE,
  MAX_SUBREQUESTS_PER_INVOCATION,
  canAfford,
  createBudget,
  meterD1,
  MAX_D1_QUERIES_PER_INVOCATION,
  meterEnv,
  meterFetch,
  overspent,
  spend,
  spendD1Queries,
  spent,
  spentD1Queries,
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
    expect(createBudget().subrequests.remaining).toBe(
      MAX_SUBREQUESTS_PER_INVOCATION,
    );
    expect(MAX_SUBREQUESTS_PER_INVOCATION).toBe(50);
  });

  it('reports what has been spent, not merely what is left', () => {
    const budget = createBudget();
    spend(budget);
    spend(budget);
    expect(spent(budget)).toBe(2);
    expect(budget.subrequests.remaining).toBe(48);
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
    expect(budget.subrequests.limit).toBe(5);
    expect(spent(budget)).toBe(2);
    expect(budget.subrequests.remaining).toBe(3);
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
    expect(budget.subrequests.remaining).toBe(50); // built locally, sent nothing

    void metered.prepare('SELECT 2').run!();
    expect(budget.subrequests.remaining).toBe(49);
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

  it('charges a batch ONE subrequest and ONE QUERY PER STATEMENT', () => {
    // #2227 r4 `4034041832` — both ceilings are real and they disagree about
    // a batch. It is one round trip, so one subrequest; Cloudflare's D1 limits
    // apply per statement inside a batch, so nine queries. Charging one of
    // each would let a batching lane reach the 50-query ceiling with the
    // counter reading comfortable; charging nine to both would refuse work
    // that fits.
    const { db } = fakeDb();
    const budget = createBudget();
    const metered = meterD1(db, budget);
    const statements = Array.from({ length: 9 }, (_, i) =>
      metered.prepare(`INSERT ${i}`),
    );
    void metered.batch!(statements);
    expect(spent(budget)).toBe(1);
    expect(spentD1Queries(budget)).toBe(9);
  });

  it('charges a single statement one of each', () => {
    const { db } = fakeDb();
    const budget = createBudget();
    void meterD1(db, budget).prepare('SELECT ?').bind!(1).run!();
    expect(spent(budget)).toBe(1);
    expect(spentD1Queries(budget)).toBe(1);
  });

  it('charges exec() by the statements it submits', () => {
    // D1 splits `exec` on newlines, so a three-line call is three queries.
    const { db } = fakeDb();
    const budget = createBudget();
    void meterD1(db, budget).exec!('DELETE FROM a;\nDELETE FROM b;\n\nDELETE FROM c;');
    expect(spent(budget)).toBe(1);
    expect(spentD1Queries(budget)).toBe(3);
  });

  it('charges exec() one request', () => {
    const { db } = fakeDb();
    const budget = createBudget();
    void meterD1(db, budget).exec!('PRAGMA foo');
    expect(spent(budget)).toBe(1);
    expect(spentD1Queries(budget)).toBe(1);
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

describe('the D1 query meter — the second ceiling', () => {
  it('starts at the documented free-tier ceiling', () => {
    expect(createBudget().d1Queries.remaining).toBe(
      MAX_D1_QUERIES_PER_INVOCATION,
    );
    expect(MAX_D1_QUERIES_PER_INVOCATION).toBe(50);
  });

  it('is over when EITHER ceiling is crossed', () => {
    // A figure that answered for subrequests alone would read as comfortable
    // on an invocation about to be killed for its query count.
    const budget = createBudget(50, 'test', 2);
    spendD1Queries(budget, 3);
    expect(spent(budget)).toBe(0);
    expect(overspent(budget)).toBe(true);
  });

  it('announces the query ceiling separately, naming what it counts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const budget = createBudget(50, 'cron tick', 2);
      spendD1Queries(budget, 3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('D1 query');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not charge fetch against it', () => {
    const budget = createBudget();
    void meterFetch(budget, (async () => new Response('ok')) as typeof fetch)(
      'https://rpc.test',
    );
    expect(spentD1Queries(budget)).toBe(0);
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

  it('does NOT follow a redirect — it counts the one request and surfaces the 3xx', async () => {
    // #2227 r3: following meant re-implementing `fetch`'s redirect algorithm,
    // and three of that round's four findings were that re-implementation
    // diverging from the standard. Not following is exact by construction —
    // one request issued, one counted — and needs no second implementation of
    // anybody's spec.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const budget = createBudget();
      const seen: string[] = [];
      const base = (async (url: string) => {
        seen.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.test/moved?key=SECRET' },
        });
      }) as unknown as typeof fetch;

      const res = await meterFetch(budget, base)('https://rpc.test/start');
      expect(res.status).toBe(302);
      expect(seen).toEqual(['https://rpc.test/start']);
      expect(spent(budget)).toBe(1);
      // Loud, and names where it was being sent, so the configured URL can be
      // fixed rather than the failure being opaque.
      // The HOST, so an operator can act — and nothing after it, because a
      // Location can echo a credential-bearing path straight back.
      const warned = String(warn.mock.calls[0]?.[0]);
      expect(warned).toContain('elsewhere.test');
      expect(warned).not.toContain('/moved');
      expect(warned).toContain('path and query withheld');
    } finally {
      warn.mockRestore();
    }
  });

  it('asks the runtime not to follow, so no hop can go uncounted', async () => {
    let init: RequestInit | undefined;
    const base = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response('ok');
    }) as unknown as typeof fetch;
    await meterFetch(createBudget(), base)('https://rpc.test');
    expect(init?.redirect).toBe('manual');
  });

  it('passes a Request input straight through, body and all', async () => {
    // Nothing is re-derived from it: the runtime that defines what a Request
    // means is the one that sends it. The version this replaced rebuilt the
    // request by hand and dropped its body, its signal, and a replacement
    // body — three findings for one avoidable re-implementation.
    let sent: unknown;
    const base = (async (input: unknown) => {
      sent = input;
      return new Response('ok');
    }) as unknown as typeof fetch;

    const request = new Request('https://api.test/orders', {
      method: 'POST',
      body: '{"listing":1}',
    });
    await meterFetch(createBudget(), base)(request);
    expect(sent).toBe(request);
    expect(await (sent as Request).text()).toBe('{"listing":1}');
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
