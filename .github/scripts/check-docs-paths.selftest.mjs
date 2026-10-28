#!/usr/bin/env node
/**
 * Regression fixtures for the docs path gate (#1486).
 *
 * WHY THIS EXISTS. #1467's review found its defects one round at a time:
 * six in extraction (angle-bracket destinations with spaces, titled
 * destinations, reference definitions, destinations on the following line,
 * two title separators) and more in adjudication (dot-directories read
 * document-relative, gitignored operator files, a global excludes file
 * leaking in, negated patterns, gitlinks, site-root URLs, escaping `../`,
 * trailing slashes on files). Every one landed on the does-it-exist rule,
 * which is why it waited for a parser. Now that it ships, each of those cases
 * is a fixture here, with the direction it must fall, so re-breaking one is a
 * failing command rather than a finding in a later review.
 *
 * HOW IT WORKS. The gate reads the repository it runs in (`git ls-files`), so
 * each run builds a throwaway repository in the system temp directory, commits
 * the fixture tree there, runs the gate with that repository as its working
 * directory, and deletes it. Nothing touches this checkout.
 *
 * Run: `node .github/scripts/check-docs-paths.selftest.mjs`
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'check-docs-paths.mjs');

/** Tracked files every fixture repository starts with. */
const TREE = {
  'contracts/src/Live.sol': '',
  'contracts/.gitignore': '.env\n',
  '.gitignore': '*.log\n!keep.log\n',
  'apps/keeper/wrangler.jsonc': '{}',
  'docs/ops/a b.md': '',
  'docs/ops/exists.md': '',
};

/**
 * One runbook per case. `finds` lists the tokens the gate must report from
 * it, in line order; an empty list means the runbook must pass.
 */
const CASES = [
  { name: 'a live link and a live code span', md: '[x](exists.md) and `contracts/src/Live.sol`', finds: [] },
  { name: 'a link to a missing file', md: '[x](gone.md)', finds: ['gone.md'] },
  { name: 'a code span naming a missing repository path', md: 'see `contracts/src/Gone.sol`', finds: ['contracts/src/Gone.sol'] },
  // #1467 r7–r10: extraction shapes that were false alarms under the patterns.
  { name: 'an angle-bracket destination with a space', md: '[x](<a b.md>)', finds: [] },
  { name: 'a percent-escaped destination', md: '[x](a%20b.md)', finds: [] },
  { name: 'a titled destination', md: '[x](exists.md "the title")', finds: [] },
  { name: 'a destination on the line after its opener', md: '[x](\nexists.md)', finds: [] },
  { name: 'a live reference definition', md: '[x][r]\n\n[r]: exists.md "t"', finds: [] },
  { name: 'a missing reference definition', md: '[x][r]\n\n[r]: <gone file.md>', finds: ['gone file.md'] },
  // CommonMark reads this as a link to `exists.md"t"`, which renders broken.
  { name: 'a quote with no title separator is part of the destination', md: '[x](exists.md"t") and (b) "c"', finds: ['exists.md"t"'] },
  // Forms a renderer never follows or shows as one path.
  { name: 'a link inside an HTML comment', md: '<!-- [x](gone.md) -->', finds: [] },
  { name: 'a missing path inside a code block', md: '```bash\ncat contracts/src/Gone.sol\n```', finds: [] },
  { name: 'a link in inline code is shown, not followed', md: '`[x](gone.md)`', finds: [] },
  // (5) not repository paths.
  { name: 'URLs, a protocol-relative link and a site-root route', md: '[a](https://x.test/gone) [b](//host/gone) [c](/alerts) [d](mailto:a@b.test)', finds: [] },
  // (6) escaping the repository.
  { name: 'a link that escapes the repository', md: '[x](../../../outside.md)', finds: [] },
  // Code spans that are words, placeholders or working-directory paths.
  { name: 'a code span that is not anchored at a top-level entry', md: '`read/write`, `owner/repo`, `Gone.md`', finds: [] },
  { name: 'placeholders and patterns', md: '`contracts/<slug>/x.json` `contracts/*.sol` `apps/{a,b}` `$HOME/x` `~/x`', finds: [] },
  // #3023 r1: `?` is a glob in a code span; normalisation used to cut the span
  // there and accuse the literal prefix. A link's `?` is still a query.
  { name: 'a question-mark glob in a code span', md: '`contracts/src/Live?.sol` and `contracts/src/Gone?.sol`', finds: [] },
  { name: 'a query on a link to a missing file', md: '[x](gone.md?plain=1)', finds: ['gone.md'] },
  { name: 'a query on a link to a live file', md: '[x](exists.md?plain=1)', finds: [] },
  { name: 'a code span relative to a working directory', md: '`./tickets.sql` from `apps/keeper/`, or `../sibling-repo`', finds: [] },
  { name: 'a line and a part of a file', md: '`contracts/src/Live.sol:12` `apps/keeper/wrangler.jsonc:vars`', finds: [] },
  // (2) trailing slashes and gitlinks.
  { name: 'a trailing slash on a directory', md: '`contracts/src/` and [d](../../apps/keeper/)', finds: [] },
  { name: 'a trailing slash on a file', md: '`contracts/src/Live.sol/`', finds: ['contracts/src/Live.sol/'] },
  { name: 'a path inside a gitlink', md: '`contracts/lib/sub/src/Anything.sol`', finds: [] },
  // (1) the tracked tree, not the working tree.
  { name: 'a file present on disk but not tracked', md: '`contracts/src/Untracked.sol`', finds: ['contracts/src/Untracked.sol'] },
  // (4) only the committed ignore files exempt.
  { name: 'a path the committed .gitignore covers', md: 'create `contracts/.env`', finds: [] },
  { name: 'a path a negated pattern re-includes', md: '`docs/keep.log` and `docs/drop.log`', finds: ['docs/keep.log'] },
  { name: 'a path only the global excludes file covers', md: '`contracts/global-only.txt`', finds: ['contracts/global-only.txt'] },
  { name: 'a path only .git/info/exclude covers', md: '`contracts/info-only.txt`', finds: ['contracts/info-only.txt'] },
  // The closed-world rule still reads the words inside command text.
  { name: 'a removed directory inside a code block', md: '```bash\ncd frontend && npm run build\n```', finds: ['frontend'] },
];

const git = (cwd, args, env) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

function run(c) {
  const repo = mkdtempSync(join(tmpdir(), 'docs-paths-selftest-'));
  try {
    const home = join(repo, '.home');
    mkdirSync(home);
    const globalExcludes = join(home, 'excludes');
    writeFileSync(globalExcludes, 'global-only.txt\n');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${globalExcludes}\n[user]\n\tname = t\n\temail = t@t.test\n`);
    // The developer's own Git configuration, which the gate must not honour.
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    git(repo, ['init', '-q'], env);
    for (const [p, body] of Object.entries({ ...TREE, 'docs/ops/runbook.md': `${c.md}\n` })) {
      mkdirSync(join(repo, dirname(p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    git(repo, ['add', '-A', '--', '.', ':!.home'], env);
    // A gitlink, without a submodule checkout.
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},contracts/lib/sub`], env);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'info-only.txt\n');
    writeFileSync(join(repo, 'contracts/src/Untracked.sol'), '');
    const res = spawnSync(process.execPath, [GATE], { cwd: repo, env, encoding: 'utf8' });
    if (res.status !== 0 && res.status !== 1) throw new Error(`gate crashed:\n${res.stderr}`);
    const found = [...res.stderr.matchAll(/^docs\/ops\/runbook\.md:\d+ {2}(.*)$/gm)].map((m) => m[1]);
    return { found, ok: res.status === (c.finds.length ? 1 : 0) };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

let failed = 0;
for (const c of CASES) {
  const { found, ok } = run(c);
  const same = found.length === c.finds.length && found.every((t, i) => t === c.finds[i]);
  if (same && ok) {
    console.log(`ok    ${c.name}`);
  } else {
    failed++;
    console.log(`FAIL  ${c.name}\n      expected ${JSON.stringify(c.finds)}, got ${JSON.stringify(found)}`);
  }
}
if (failed) {
  console.error(`\n${failed} of ${CASES.length} docs path gate fixture(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} docs path gate fixtures pass.`);
