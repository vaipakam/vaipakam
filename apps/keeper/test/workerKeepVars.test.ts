import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every Worker that carries plain-text `vars` declares `keep_vars: true`.
 *
 * WHY THIS TEST EXISTS, and why it is small.
 *
 * Wrangler treats the config file as the source of truth for environment
 * configuration: on deploy it DELETES the vars that are not in the file before
 * setting the ones that are. Any value managed only in the Cloudflare
 * dashboard is therefore wiped by an ordinary `wrangler deploy` — for the
 * keeper that is `HF_SCALE`, the `LIQ_*` confidence thresholds,
 * `SPLIT_MIN_IMPROVEMENT_BPS` and `PARTIAL_LIQ_MIN_HF_BPS`, i.e. liquidation
 * behaviour silently reverting to defaults; for the agent it is
 * `RECIPIENT_VALIDATING_TOKENS` and `OPENSEA_OFFERS_MAX_PAGES`.
 *
 * The original defence was to require `--keep-vars` on every invocation, and
 * `scripts/check-deploy-invocations.mjs` searches the whole tree for deploys
 * that lack it. That predicate is unbounded: a deploy can be spelled through a
 * package script, a manifest alias, a Makefile variable, a sourced helper, a
 * shell function, an alias, a matrix expression, a reusable-workflow input, a
 * Windows shim, `eval`, or an Actions marketplace action — and #1995 answered
 * 242 review findings enumerating them without reaching the end.
 *
 * `keep_vars` asks the bounded question instead. It is the field wrangler
 * itself consults on BOTH paths (`props.keepVars || config.keep_vars` for
 * deploy; the handler passes `config.keep_vars` for `versions upload`), so
 * declaring it makes every spelling safe at once — including the ones nobody
 * has written yet. What was an open-ended search becomes this file: one
 * assertion per Worker.
 *
 * The scanner is kept as defence in depth and now activates exactly when this
 * invariant is broken — remove the key and it resumes reporting every bare
 * deploy for that package.
 *
 * A Worker with no `vars` at all (`apps/app`, `apps/www`) has nothing to
 * preserve and is deliberately not listed; adding one would state a
 * requirement the Worker does not have.
 */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');

/** Workers whose config declares plain-text `vars`, so a deploy can wipe them. */
const VAR_CARRYING_WORKERS = [
  'apps/agent',
  'apps/keeper',
  'apps/indexer',
  'ops/mesh-watcher',
  'ops/offchain-data-warm',
];

/**
 * Strip JSONC comments without firing inside a string.
 *
 * A `//` in a URL is not a comment, and treating it as one truncates the value
 * and can make a valid config unparseable — which this test would then report
 * as a missing key, i.e. the wrong failure.
 */
function stripJsonComments(raw: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function readJsonc(relPath: string): Record<string, unknown> {
  const raw = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  return JSON.parse(stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1')) as Record<
    string,
    unknown
  >;
}

describe('worker configs preserve dashboard vars at the source (#1995)', () => {
  it.each(VAR_CARRYING_WORKERS)('%s declares keep_vars: true', (dir) => {
    const cfg = readJsonc(`${dir}/wrangler.jsonc`);
    expect(cfg.keep_vars).toBe(true);
  });

  it.each(VAR_CARRYING_WORKERS)('%s actually carries vars, so the rule applies', (dir) => {
    // Pins the LIST as well as the key. If a Worker's `vars` block is removed
    // this fails, prompting a decision — drop it from the list, or find out
    // why the block went away — rather than leaving an assertion that passes
    // for a Worker the rule no longer describes.
    const cfg = readJsonc(`${dir}/wrangler.jsonc`);
    expect(cfg.vars, `${dir} has no "vars" block`).toBeTypeOf('object');
  });

  it('CI actually runs this suite when any listed config changes', () => {
    // The assertions above only protect anything if they RUN. The job that
    // runs them is path-gated, and that gate listed `apps/(app|indexer|keeper)`
    // — so an agent-only or ops-only PR could delete `keep_vars` with this
    // file never executing (#1995 r22). The invariant now carries the whole
    // var-preservation property, so a gate that skips it is a hole in the
    // property itself.
    //
    // Asserted against the workflow's own regex rather than restated here:
    // a copy would drift, and the failure mode is silence.
    const wf = readFileSync(join(REPO_ROOT, '.github/workflows/app-vitest.yml'), 'utf8');
    const line = wf.split('\n').find((l) => l.trim().startsWith('DEFI_RE='));
    expect(line, 'DEFI_RE not found in app-vitest.yml').toBeTruthy();
    const pattern = /DEFI_RE='(.*)'\s*$/.exec(line as string)?.[1];
    expect(pattern, 'DEFI_RE is not single-quoted as expected').toBeTruthy();
    const re = new RegExp(pattern as string);
    for (const dir of VAR_CARRYING_WORKERS) {
      expect(
        re.test(`${dir}/wrangler.jsonc`),
        `${dir}/wrangler.jsonc does not trigger the vitest job, so removing its keep_vars would go unchecked`,
      ).toBe(true);
    }
    // …and the test file itself, so editing the invariant runs it.
    expect(re.test('apps/keeper/test/workerKeepVars.test.ts')).toBe(true);
  });

  it('the comment strip does not truncate a value containing //', () => {
    // The parser above is what every assertion here depends on, so its one
    // non-obvious rule gets a case of its own: a `//` inside a string is data.
    const parsed = JSON.parse(
      stripJsonComments(
        '{\n  // real comment\n  "a": "https://x.example/y", // trailing\n  "b": 1,\n}\n',
      ).replace(/,(\s*[}\]])/g, '$1'),
    );
    expect(parsed.a).toBe('https://x.example/y');
    expect(parsed.b).toBe(1);
  });
});
