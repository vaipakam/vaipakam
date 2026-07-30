#!/usr/bin/env node
/**
 * Docs check: no secret in a command line.
 *
 * WHY THIS EXISTS. Three separate review rounds on #1450 found the same
 * defect in three different runbook steps: a credential typed or expanded
 * into an external command's arguments. A value in `argv` is readable from
 * `ps` / `/proc/<pid>/cmdline` by any other user on the machine for the
 * lifetime of the process, and — if typed literally — lands in shell
 * history as well. In every one of those three cases the surrounding prose
 * was careful about secrets; the command was not.
 *
 * Three instances of one shape across independent documents is a class, and
 * a class in prose cannot be closed by a type. So it is closed here: the
 * rule stops being a discipline someone has to remember and becomes
 * something a machine re-checks on every merge.
 *
 * WHAT IT FLAGS. Inside fenced shell blocks in `docs/`, a line that both
 *   (a) invokes a known EXTERNAL command, and
 *   (b) carries a secret-shaped token — a `$VAR`/`${VAR}` whose name looks
 *       like a credential, an `<ANGLE_PLACEHOLDER>` that does, or an
 *       explicit `--value` on a secret-setting command.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG, and why each is genuinely safe:
 *   - Shell BUILTINS. `printf 'fmt' "$TOKEN" | curl -K -` is the
 *     recommended pattern precisely because `printf` is a bash builtin —
 *     there is no separate process, so nothing enters any argv. Verified
 *     with `type printf`. An external `/usr/bin/printf` would expose it,
 *     which is why the allowlist is by command name, not by shape.
 *   - `read -rs VAR` — an assignment, and the whole point of the pattern.
 *   - Assignments (`VAR=$(...)`, `export VAR=...`) — the value is in the
 *     shell, not in a child's argv.
 *   - Comment lines, and prose outside fenced blocks.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads a green run as a proof:
 *   - A secret reaching argv through a variable this check cannot tell is
 *     secret (`$X`, `$1`).
 *   - An external command not in the list below.
 *   - Anything outside `docs/`.
 * It closes the class that recurred, not the whole space.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { report } from './docs-check-ratchet.mjs';

/** Historical records — describe what was true when written; never edited. */
const SKIP_DIRS = [
  'docs/ReleaseNotes/',
  'docs/FindingsAndFixes/',
  'docs/OlderDocs/',
];

/**
 * External commands whose arguments become argv. Builtins are absent on
 * purpose — see the header. `printf` and `echo` are bash builtins.
 */
const EXTERNAL = [
  'curl', 'wget', 'wrangler', 'npx', 'gh', 'git', 'cast', 'forge',
  'b2', 'aws', 'openssl', 'ssh', 'scp', 'docker', 'node', 'psql',
];

/** Name fragments that make an identifier credential-shaped. */
const SECRET_WORDS = [
  // Deliberately COMPOUND rather than bare `TOKEN`. In this codebase
  // `TOKEN` overwhelmingly means an ERC20 contract address
  // (`BASE_SEPOLIA_VPFI_TOKEN`), which is public — a bare match made the
  // check cry wolf on its first run, and a check that cries wolf gets
  // ignored, which is worse than not having it.
  'BOT_TOKEN', 'API_TOKEN', 'AUTH_TOKEN', 'ACCESS_TOKEN', 'SESSION_TOKEN',
  'SECRET', 'PRIVATE_KEY', 'PRIVKEY', 'PASSWORD', 'PASSWD',
  'API_KEY', 'APIKEY', 'ACCESS_KEY', 'APPLICATION_KEY', 'SIGNING_KEY',
  'ENCRYPTION_KEY', 'HMAC', 'CHANNEL_PK', 'CREDENTIAL', 'BEARER',
];

const looksSecret = (name) =>
  SECRET_WORDS.some((w) => name.toUpperCase().includes(w));

function trackedDocs() {
  const out = execFileSync('git', ['ls-files', 'docs/**/*.md', 'docs/*.md'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SKIP_DIRS.some((d) => f.startsWith(d)));
}

/** Lines inside ```bash / ```sh / ```shell / ```console fences. */
function shellLines(text) {
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```+\s*([a-zA-Z0-9]*)/);
    if (fence) {
      if (!inFence) inFence = /^(bash|sh|shell|console|zsh)$/i.test(fence[1]);
      else inFence = false;
      continue;
    }
    if (inFence) out.push({ n: i + 1, line });
  }
  return out;
}

function findings(file) {
  const hits = [];
  for (const { n, line } of shellLines(readFileSync(file, 'utf8'))) {
    const code = line.replace(/^\s*>?\s*/, '');
    if (code.trimStart().startsWith('#')) continue;

    // Assignment or prompted read — the value stays in the shell.
    if (/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(code)) continue;
    if (/\bread\s+-[a-z]*s/.test(code)) continue;

    const cmds = EXTERNAL.filter((c) =>
      new RegExp(`(^|[|;&(]|\\s)${c}\\s`).test(code),
    );
    if (cmds.length === 0) continue;

    // `--value <x>` on a secret-setting command is unsafe by construction:
    // wrangler's own help says it "will leave secret value in plain-text in
    // terminal history".
    if (/\bsecret\b/.test(code) && /--value(\s|=)/.test(code)) {
      hits.push({ n, line: code, why: '`--value` puts the secret in argv and in shell history; omit it so wrangler prompts' });
      continue;
    }

    const vars = [...code.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)]
      .map((m) => m[1])
      .filter(looksSecret);
    const placeholders = [...code.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>/g)]
      .map((m) => m[1])
      .filter(looksSecret);

    const named = [...new Set([...vars, ...placeholders])];
    if (named.length === 0) continue;

    hits.push({
      n,
      line: code,
      why:
        `${named.map((v) => `\`${v}\``).join(', ')} reaches \`${cmds[0]}\`'s argv — ` +
        `readable from \`ps\` / \`/proc/<pid>/cmdline\`. Prompt with \`read -rs\` and pass ` +
        `options on stdin (\`curl -K -\`), or use the tool's own prompt`,
    });
  }
  return hits;
}

const all = [];
for (const file of trackedDocs()) {
  for (const h of findings(file)) all.push({ file, ...h });
}

process.exit(
  report(
    'docs secret-argv check',
    all,
    '.github/docs-check-baselines/secret-argv.json',
    { write: process.argv.includes('--write-baseline') },
  ),
);
