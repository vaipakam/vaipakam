/**
 * The cron lane reaches the network through the invocation's counted handles —
 * structurally, not by everyone remembering to (#2221, #2227 r1).
 *
 * #2227 round 1 found three requests the counter did not see: viem's retries
 * under one client method, a SECOND client built inside the reconciliation
 * pass, and a plain `fetch()` to OpenSea. Each was fixed at its site, and each
 * would have been reintroduced by the next client or the next POST — the fix
 * that holds is that the modules on this lane no longer have the ingredients
 * to make an uncounted request conveniently: no viem client constructor, no
 * bare `fetch`. This guard is what keeps that true.
 *
 * WHAT IT DOES NOT COVER, stated because a guard believed to cover more than
 * it does is worse than none:
 *
 *   - A module NOT listed here that the cron lane calls into. The list is the
 *     scope, and it is short on purpose; extending the lane means extending it.
 *   - `await import('viem')`, a re-export under another name, or `globalThis
 *     .fetch` reached by computed property. These are visible in review and
 *     absent from this tree; a check that tried to chase them would be the
 *     unbounded-predicate mistake #1995 and #2066 both recorded.
 *
 * What it does cover is the ordinary way the defect recurs: someone adds a
 * client or a POST the way the surrounding code used to, and CI says no.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Modules that run inside a counted cron invocation. */
const COUNTED_MODULES = [
  'chainIndexer.ts',
  'openseaPublish.ts',
  'recycleRoutes.ts',
] as const;

function source(file: string): string {
  return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

/** `fetch(...)` reached as a bare global — not `env.fetchFn(`, not `x.fetch(`,
 *  not `meterFetch(`. */
const BARE_FETCH_CALL = /(^|[^.\w])fetch\s*\(/m;

/** viem's client constructor, CALLED. */
const CLIENT_CALL = /(^|[^.\w])createPublicClient\s*\(/m;

/** viem's client constructor, IMPORTED — the ingredient, not just the use. */
const CLIENT_IMPORT = /import\s*\{[^}]*\bcreatePublicClient\b/s;

describe('the counted lane cannot build an uncounted sender', () => {
  it.each(COUNTED_MODULES)(
    '%s does not import viem’s client constructor',
    (file) => {
      // A client built directly takes the GLOBAL fetch, so its reads — and
      // viem's up-to-three retries of each — are invisible to the counter
      // while the pass still reports a number (#2227 r1 `4033546268`).
      // `createChainClient` is the one way in, and it takes the sender.
      const src = source(file);
      expect(CLIENT_IMPORT.test(src)).toBe(false);
      expect(CLIENT_CALL.test(src)).toBe(false);
    },
  );

  it.each(COUNTED_MODULES)('%s makes no bare fetch() call', (file) => {
    // #2227 r1 `4033546284` — the OpenSea POST went out on the global fetch.
    // The rule for this lane is `env.fetchFn ?? fetch`: counted where the
    // caller is counted, and explicit about the fallback where it is not.
    expect(BARE_FETCH_CALL.test(source(file))).toBe(false);
  });

  it('the constructor patterns actually match a direct client build', () => {
    // Guards the guard, the same way. Note both are deliberately blind to a
    // PROSE mention — the note at the top of `chainIndexer.ts` names the
    // constructor precisely to say it is absent, and a guard that failed on
    // its own documentation would be paid for by deleting the documentation.
    expect(
      CLIENT_IMPORT.test("import { createPublicClient, http } from 'viem';"),
    ).toBe(true);
    expect(CLIENT_CALL.test('const c = createPublicClient({ transport });')).toBe(
      true,
    );
    expect(CLIENT_IMPORT.test('// `createPublicClient` is NOT imported here.')).toBe(
      false,
    );
    expect(CLIENT_CALL.test('// see `createPublicClient` in viem')).toBe(false);
  });

  it('the bare-fetch pattern actually matches a bare fetch', () => {
    // Guards the guard. An expression that matched nothing would let all
    // three assertions above pass on a lane full of uncounted requests.
    expect(BARE_FETCH_CALL.test('const r = await fetch(url);')).toBe(true);
    expect(BARE_FETCH_CALL.test('  fetch(url)')).toBe(true);
    expect(BARE_FETCH_CALL.test('await (env.fetchFn ?? fetch)(url)')).toBe(
      false,
    );
    expect(BARE_FETCH_CALL.test('const send = meterFetch(budget);')).toBe(
      false,
    );
    expect(BARE_FETCH_CALL.test('await stub.fetch(url)')).toBe(false);
  });

  it('openseaPublish sends through the invocation’s sender', () => {
    expect(source('openseaPublish.ts')).toContain('env.fetchFn ?? fetch');
  });
});
