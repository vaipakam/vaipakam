/**
 * What these cases pin, and why each one exists.
 *
 * The module's value is entirely in its edges: a stub that throws on the wrong
 * things is worse than no stub, because it converts a deliberate refusal back
 * into the unexplained failure it was built to replace. So the cases below are
 * mostly about what must NOT throw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  D1MaintenanceError,
  D1_MAINTENANCE_CODE,
  hasD1Binding,
  isD1MaintenanceError,
  maintenanceD1Stub,
  maintenanceRefusal,
  resolveD1Binding,
} from './d1Maintenance.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the stub refuses database work', () => {
  it('throws a NAMED error from a method D1 has', () => {
    const db = maintenanceD1Stub('vaipakam-indexer') as {
      prepare: (sql: string) => unknown;
    };
    let thrown: unknown;
    try {
      db.prepare('SELECT 1');
    } catch (err) {
      thrown = err;
    }
    expect(isD1MaintenanceError(thrown)).toBe(true);
    expect((thrown as D1MaintenanceError).worker).toBe('vaipakam-indexer');
    expect((thrown as D1MaintenanceError).operation).toBe('prepare');
  });

  it('throws the same way from a method D1 does NOT have yet', () => {
    // The whole reason this is a Proxy rather than an object with five
    // methods on it. A stub that listed today's D1 surface would return
    // `undefined` here, and the caller would get `undefined is not a
    // function` — the uninformative failure the module exists to replace,
    // arriving exactly when the platform changes underneath us.
    const db = maintenanceD1Stub('vaipakam-agent') as Record<
      string,
      () => unknown
    >;
    expect(() => db.somethingD1AddsIn2027!()).toThrow(D1MaintenanceError);
  });

  it('says that nothing was read and nothing was written', () => {
    // Not decoration. On a funds surface the operator's first question about
    // a refused write is whether it half-happened, and an error that does not
    // answer it leaves the reader to guess.
    const db = maintenanceD1Stub('vaipakam-keeper') as {
      batch: (s: unknown[]) => unknown;
    };
    expect(() => db.batch([])).toThrow(/Nothing was read and nothing was written/);
  });
});

describe('the stub does NOT break the things that are not database work', () => {
  it('is not thenable, so awaiting it does not hang or reject elsewhere', async () => {
    // A throwing `then` is the subtle one: `await db` would invoke it, and the
    // rejection would surface at a line that never touched the database.
    const db = maintenanceD1Stub('vaipakam-agent');
    expect((db as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(db)).resolves.toBe(db);
  });

  it('survives a symbol read, which is how the subrequest meter probes it', () => {
    // `apps/indexer`'s `meterD1` reads a `Symbol.for(...)` marker on the
    // binding BEFORE wrapping it. If that read threw, metering a maintenance
    // build would fail in the meter rather than at the query.
    const db = maintenanceD1Stub('vaipakam-indexer') as Record<symbol, unknown>;
    expect(() => db[Symbol.for('vaipakam.indexer.metered')]).not.toThrow();
    expect(db[Symbol.for('vaipakam.indexer.metered')]).toBeUndefined();
  });

  it('describes itself instead of exploding when logged or serialised', () => {
    const db = maintenanceD1Stub('vaipakam-keeper');
    expect(String(db)).toContain('maintenance build');
    expect(JSON.stringify(db)).toContain('unavailable');
    // The JavaScript object protocol keeps working — these are not database
    // operations and treating them as such would make the stub unloggable.
    expect(() =>
      Object.prototype.hasOwnProperty.call(db, 'prepare'),
    ).not.toThrow();
  });
});

describe('the seam', () => {
  it('returns a present binding untouched — a no-op on every ordinary deploy', () => {
    const real = { prepare: () => 'statement' };
    expect(resolveD1Binding(real, 'vaipakam-agent')).toBe(real);
  });

  it('substitutes the stub when the binding is absent, and discloses it ONCE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A distinct label per run: the disclosure set is module-scoped on
    // purpose (once per isolate, not once per call), so a shared label would
    // make this case depend on which test ran first.
    const label = `vaipakam-test-${Math.random()}`;
    const first = resolveD1Binding<{ prepare: (s: string) => unknown }>(
      undefined,
      label,
    );
    const second = resolveD1Binding(undefined, label);
    expect(() => first.prepare('SELECT 1')).toThrow(D1MaintenanceError);
    expect(second).toBeDefined();
    // Twice through the seam, one line: a maintenance build refuses every
    // request and every tick, so per-call logging is the flood that turns a
    // deliberate state into noise.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toContain('maintenance build');
  });

  it('treats null like absent, because a binding is an object or it is nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(hasD1Binding(null)).toBe(false);
    expect(hasD1Binding(undefined)).toBe(false);
    expect(hasD1Binding({})).toBe(true);
    const db = resolveD1Binding<{ exec: (s: string) => unknown }>(
      null,
      `vaipakam-test-${Math.random()}`,
    );
    expect(() => db.exec('SELECT 1')).toThrow(D1MaintenanceError);
    expect(warn).toHaveBeenCalled();
  });
});

describe('recognising a refusal', () => {
  it('matches on the code rather than on the class', () => {
    // The three Workers each bundle their own copy of this package, so an
    // `instanceof` against one bundle's class is false for an error thrown by
    // another's — and a refusal silently reclassified as an unknown error is
    // how a maintenance window would start looking like an outage.
    const fromAnotherBundle = Object.assign(new Error('refused'), {
      code: D1_MAINTENANCE_CODE,
    });
    expect(isD1MaintenanceError(fromAnotherBundle)).toBe(true);
    expect(isD1MaintenanceError(new Error('something else'))).toBe(false);
    expect(isD1MaintenanceError(undefined)).toBe(false);
    expect(isD1MaintenanceError('a string')).toBe(false);
  });
});

describe('the HTTP refusal', () => {
  it('is a 503 that tells the caller the write did not happen', () => {
    const r = maintenanceRefusal('vaipakam-agent');
    expect(r.status).toBe(503);
    // NO `Retry-After`, deliberately (#2252 r10). The Worker cannot know how
    // long a maintenance window lasts — the procedure, the tooling and the
    // drain are all unsettled — so a number here would be an invented figure
    // on the one surface whose purpose is to avoid exactly that.
    expect(r.headers['retry-after']).toBeUndefined();
    // Never cached: a cached maintenance page outlives the window.
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('nothing you sent has been recorded');
    // It says the duration is unknown rather than implying one.
    expect(r.body).toContain('not something this service can tell you');
    // And it does not imply a stale read would be safe either.
    expect(r.body).toContain('nothing you read here would be current');
  });
});
