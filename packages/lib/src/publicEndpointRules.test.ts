/**
 * #2755 / #2756 — the request-side rules every Worker shares, pinned across
 * the whole tree rather than per app.
 *
 * Two rules live in this package so that no Worker can carry its own copy:
 * `rateLimit.ts` is the only place a limiter binding is called and the only
 * place a limiter failure is named, and `requestBody.ts` is the only reader
 * of a request body. A local copy is how the agent came to let requests
 * through when a binding was missing, and how the indexer came to read
 * bodies of any size. These cases walk every Worker's source and refuse a
 * file that does either outside this package.
 *
 * There is no exemption. The one file that had one,
 * `apps/indexer/src/loanRoutes.ts`, lost the OpenSea match-source handler
 * that needed it in #2757.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/** Every Worker's source tree: the `src/` of each app and ops Worker. */
function workerSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(p);
    }
  };
  for (const root of ['apps', 'ops']) {
    for (const worker of readdirSync(join(REPO, root))) {
      const src = join(REPO, root, worker, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a directory with no src/ carries no Worker code
      }
    }
  }
  return out;
}

/** Source with comments removed, so a rule quoted in prose is not a hit. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

const FILES = workerSourceFiles();
const rel = (f: string) => relative(REPO, f).split('\\').join('/');

describe('one rate-limit rule, one body reader, across every Worker', () => {
  it('walks the Workers that serve public endpoints', () => {
    const names = FILES.map(rel);
    expect(names.some((n) => n.startsWith('apps/agent/src/'))).toBe(true);
    expect(names.some((n) => n.startsWith('apps/indexer/src/'))).toBe(true);
  });

  const LIMIT_CALL = /\.limit\(\s*\{/;
  const FAILURE_NAME = /['"`]rate[-_]limit[-_](unavailable|binding[-_]missing|not[-_]configured)['"`]/;
  // A request's body read directly. Responses from upstream fetches are read
  // with `.text()` / `.json()` too, so the receiver is what is matched: the
  // handlers name their request `req` or `request`.
  const RAW_BODY_READ = /\b(req|request)(\.clone\(\))?\.(json|text|formData|arrayBuffer|blob)\(\)/;

  it('no Worker calls a limiter binding itself', () => {
    for (const f of FILES) {
      expect(code(f), rel(f)).not.toMatch(LIMIT_CALL);
    }
  });

  it('no Worker names a limiter failure itself', () => {
    for (const f of FILES) {
      expect(code(f), rel(f)).not.toMatch(FAILURE_NAME);
    }
  });

  it('no Worker reads a request body except through requestBody.ts', () => {
    for (const f of FILES) {
      expect(code(f), rel(f)).not.toMatch(RAW_BODY_READ);
    }
  });

  it('the shared modules are where the rules live', () => {
    expect(code(resolve(HERE, 'rateLimit.ts'))).toMatch(LIMIT_CALL);
    expect(code(resolve(HERE, 'rateLimit.ts'))).toMatch(FAILURE_NAME);
  });
});
