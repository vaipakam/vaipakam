/**
 * #2759 — a caught value becomes text only through the formatters in
 * `errorDescription.ts`, in every server-side workspace package.
 *
 * The first block pins what the syntax-tree rule refuses and allows, on
 * small sources written for it. The second walks the tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUnformattedErrorText } from './logRedaction';

const forms = (src: string) => findUnformattedErrorText('x.ts', src).map((f) => f.form);

describe('the rule', () => {
  it.each([
    ['String()', `try { a() } catch (err) { log(String(err)) }`],
    ['.message', `try { a() } catch (err) { send((err as Error).message) }`],
    ['.message', `try { a() } catch (err) { send((err as Error)?.message) }`],
    ['.stack', `try { a() } catch (e) { send(e.stack) }`],
    ['.toString()', `try { a() } catch (e) { send(e.toString()) }`],
    ['JSON.stringify()', `try { a() } catch (e) { send(JSON.stringify(e)) }`],
    ['template literal', 'try { a() } catch (err) { send(`failed: ${err}`) }'],
    ["'+' operand", `try { a() } catch (err) { send('failed: ' + err) }`],
    ['logged raw', `try { a() } catch (err) { console.error('failed', err) }`],
    ['logged raw', `p.catch((err) => console.warn('failed', err))`],
    ['logged raw', `p.then(ok, (err) => { console.log(err) })`],
    ['logged raw', `try { a() } catch (err) { const e = err; console.error(e) }`],
    ['logged raw', `try { a() } catch (err) { items.forEach(() => console.error(err)) }`],
    ['String()', `try { a() } catch (err) { return { detail: String(err) } }`],
    ['logged raw', `try { a() } catch (err) { console.error('failed', { err, chain }) }`],
    ['logged raw', `try { a() } catch (err) { console.error('failed', { cause: err }) }`],
    ['JSON.stringify()', `try { a() } catch (err) { send(JSON.stringify({ error: err })) }`],
  ])('refuses %s', (form, src) => {
    expect(forms(src)).toContain(form);
  });

  it.each([
    ['a formatter', `try { a() } catch (err) { console.error('failed', redactedError(err)) }`],
    ['a formatter around text', `try { a() } catch (err) { send(redactSecrets(String(err))) }`],
    ['describeFailure', `try { a() } catch (err) { console.warn(describeFailure(err)) }`],
    ['a regex test', `try { a() } catch (err) { if (/no such table/i.test(String(err))) return }`],
    ['a named regex test', `try { a() } catch (err) { if (RE.test((err as Error).message ?? '')) return }`],
    ['an includes test', `try { a() } catch (err) { if (String(err).includes('x')) return }`],
    ['instanceof', `try { a() } catch (err) { if (err instanceof TypeError) return }`],
    ['scalar fields', `try { a() } catch (err) { console.warn((err as Error).name, (err as any).code) }`],
    ['a rethrow', `try { a() } catch (err) { throw err }`],
    ['a cause', `try { a() } catch (err) { throw new Error('read failed', { cause: err }) }`],
    ['a hand-off', `try { a() } catch (err) { record(err) }`],
    ['an unrelated value', `try { a() } catch (err) { console.error('failed', other) }`],
  ])('allows %s', (_label, src) => {
    expect(forms(src)).toEqual([]);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/**
 * Browser bundles are outside the rule: what they log goes to the user's
 * own developer tools, and the RPC URLs they hold are already in the bundle
 * (#1724). Everything else under apps/ and packages/ runs on a server or in
 * a Worker.
 */
const BROWSER = new Set(['apps/app', 'apps/www', 'packages/i18n']);

/**
 * Sites not yet moved, each with the change that moves it. An entry must
 * still match, so it is removed in the change that clears it.
 */
const PENDING: Array<{ path: RegExp; why: string }> = [
  { path: /^apps\/indexer\/src\/loanRoutes\.ts$/, why: 'in flight under #2757; moved after it lands' },
];

function serverSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mts)$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const base of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(REPO, base))) {
      if (BROWSER.has(`${base}/${pkg}`)) continue;
      const src = join(REPO, base, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // no src/, no code to check
      }
    }
  }
  return out;
}

describe('every server-side workspace package', () => {
  const files = serverSourceFiles().map((p) => ({ p, rel: relative(REPO, p).split('\\').join('/') }));
  const hits = files.map(({ p, rel }) => ({ rel, found: findUnformattedErrorText(p, readFileSync(p, 'utf8')) }));

  it('walks the Workers', () => {
    for (const w of ['apps/agent/src/', 'apps/indexer/src/', 'apps/keeper/src/', 'packages/push/src/']) {
      expect(files.some((f) => f.rel.startsWith(w)), w).toBe(true);
    }
  });

  it('makes text from a caught value only through the formatters', () => {
    const open = hits
      .filter((h) => h.found.length > 0 && !PENDING.some((e) => e.path.test(h.rel)))
      .flatMap((h) => h.found.map((f) => `${h.rel}:${f.line} ${f.form}: ${f.text}`));
    expect(open).toEqual([]);
  });

  it.each(PENDING.map((e) => [e.why, e.path] as const))('the pending entry for %s still matches a site', (_why, path) => {
    expect(hits.some((h) => path.test(h.rel) && h.found.length > 0)).toBe(true);
  });
});
