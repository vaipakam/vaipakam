#!/usr/bin/env node
/**
 * Regression fixtures for the excision-residue gate.
 *
 * WHY THIS EXISTS. Every round of review on this checker has followed the same
 * shape: a fix for one false negative introduces a false positive, or silences
 * a neighbouring construct. A tag strip that invented matches, a `tagSpans`
 * reuse that switched off attribute scanning, a binary-format exemption that
 * swallowed PDFs, a link-destination skip that deleted three real pinned
 * mentions — each was caught by a reviewer, one round later, because the only
 * verification was ad-hoc fixtures re-typed by hand each time.
 *
 * These are those fixtures, committed. Each records a case that was WRONG at
 * some point and the direction it must fall. A change that re-breaks one is a
 * failing command rather than a finding in the next review.
 *
 * HOW IT WORKS. The checker reads `git ls-files`, so fixtures are staged in a
 * scratch directory inside the repo, the checker is run, and the staging is
 * undone. Nothing is committed and the index is restored even on failure.
 *
 * Run: `node .github/scripts/check-excision-residue.selftest.mjs`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
// Unique per run. A FIXED path is reused if a developer already has a
// directory of that name, and the cleanup below then deletes their files —
// reported against the first version of this script, reproduced with a
// `developer-notes.txt` that the run silently removed.
const DIR = `__excision_selftest__${process.pid}_${Date.now().toString(36)}`;

/** `caught: true` — the gate MUST report this file. `false` — must stay silent. */
const FIXTURES = [
  // --- rendered markup must fuse the words a reader sees as one phrase ---
  {
    name: 'inline-tag.md',
    caught: true,
    why: 'inline formatting splits a phrase the reader sees continuously',
    body: 'Operators must deploy the VPFI buy <strong>adapter</strong> before cutover.\n',
  },
  {
    name: 'attr-with-gt.md',
    caught: true,
    why: 'a quoted attribute containing > must not end the tag for the boundary pass',
    body: 'deploy the buy<span title="1 > 0: yes"> adapter</span> now.\n',
  },
  {
    name: 'link-destination.md',
    caught: true,
    why: 'a link URL sits between two words rendered side by side',
    body: 'Operators must deploy the [buy](https://example.com/config) adapter.\n',
  },
  {
    name: 'char-ref.md',
    caught: true,
    why: 'character references render as the identifier',
    body: 'Configure buyOpti&#111;ns before deployment.\n',
  },
  {
    name: 'attr-colon.html',
    caught: true,
    why: 'attribute values are configuration, not sentences — `:` is not a prose boundary there',
    body: '<div data-operation="buy:adapter"></div>\n',
  },
  {
    name: 'tag-interior.md',
    caught: true,
    why: 'attributes and component names are scanned as their own stream',
    body: '<div data-operation="buyOptions"></div>\n',
  },
  {
    name: 'br-is-not-a-block.md',
    caught: true,
    why: '<br> is a line break; a source newline does not stop a phrase fusing',
    body: 'Operators must deploy the VPFI buy<br>adapter before cutover.\n',
  },

  // --- but genuinely separate text must NOT be fused ---
  {
    name: 'autolink.md',
    caught: false,
    why: 'a Markdown autolink renders as visible text and separates the words either side',
    body: 'Decide what to buy<https://example.com>Adapter selection follows.\n',
  },
  {
    name: 'block-tag.md',
    caught: false,
    why: 'a block-level element separates two visibly distinct thoughts',
    body: 'Decide what to buy<hr>Adapter selection follows.\n',
  },
  {
    name: 'two-json-strings.json',
    caught: false,
    why: 'separate JSON string values never render as one phrase',
    body: '["Decide what to buy", "Adapter selection follows"]\n',
  },
  {
    name: 'synthesized-tag.md',
    caught: false,
    why: 'malformed markup must not be re-parsed into a tag that was never there',
    body: 'Configure buyOpti<o<strong>></strong>ns before deployment.\n',
  },

  // --- encodings that hide a phrase from a naive read ---
  {
    name: 'json-unicode-escape.json',
    caught: true,
    why: 'a \\u escape renders as the character, not as its spelling',
    body: '{"operatorMessage":"Deploy the buy\\u0020adapter before launch"}\n',
  },
  {
    name: 'json-escaped-quote.json',
    caught: true,
    why: 'an escaped quote stays inside ONE string value',
    body: '{"note": "Operators must deploy the VPFI buy \\"adapter\\" before cutover."}\n',
  },
];

/** PDFs are built rather than written literally, so the compression is real. */
function pdfFixtures() {
  const stream = (text) => {
    const raw = Buffer.from(`BT (${text}) Tj ET`);
    const comp = deflateSync(raw);
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      comp,
      Buffer.from('\nendstream\nendobj\n'),
    ]);
  };
  return [
    {
      name: 'compressed.pdf',
      caught: true,
      why: 'real PDFs Flate-compress their content streams; the phrase is absent from the raw bytes',
      buf: stream('Operators must deploy the VPFI buy adapter'),
    },
    {
      name: 'compressed-clean.pdf',
      caught: false,
      why: 'an ordinary document must not be failed by its drawing operators',
      buf: stream('Quarterly audit summary, nothing removed here'),
    },
    {
      name: 'uncompressed.pdf',
      caught: true,
      why: 'the uncompressed path must keep working',
      buf: Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Length 60 >>\nstream\nBT (Operators must deploy the VPFI buy adapter) Tj ET\nendstream\nendobj\n',
      ),
    },
  ];
}

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run() {
  const all = [...FIXTURES.map((f) => ({ ...f, buf: Buffer.from(f.body) })), ...pdfFixtures()];
  // `recursive: false` — refuse to adopt an existing directory rather than
  // writing into, and later deleting, something this run did not create.
  mkdirSync(join(REPO, DIR));
  for (const f of all) writeFileSync(join(REPO, DIR, f.name), f.buf);
  git('add', '--intent-to-add', '--', DIR);
  // `--intent-to-add` is enough for `git ls-files` to report them, and leaves
  // no staged content to clean out of the index afterwards.

  let output = '';
  try {
    output = execFileSync('node', [join(HERE, 'check-excision-residue.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }

  const failures = [];
  for (const f of all) {
    const reported = output.includes(`${DIR}/${f.name}`);
    if (reported !== f.caught) {
      failures.push(
        `  ${f.name}\n      expected ${f.caught ? 'CAUGHT' : 'clean'}, got ${reported ? 'CAUGHT' : 'clean'}\n      ${f.why}`,
      );
    }
  }
  return { failures, total: all.length };
}

let result;
try {
  result = run();
} finally {
  try {
    git('rm', '-r', '--cached', '--quiet', '--force', '--', DIR);
  } catch {
    // `--intent-to-add` entries may already be gone; the working tree removal below is what matters.
  }
  rmSync(join(REPO, DIR), { recursive: true, force: true });
}

if (result.failures.length) {
  console.error(`excision-residue selftest: ${result.failures.length} of ${result.total} fixtures wrong\n`);
  console.error(result.failures.join('\n\n'));
  console.error('\nEach fixture records a case that was wrong at some point. A failure here means a change re-broke one.');
  process.exit(1);
}
console.log(`excision-residue selftest: OK — ${result.total} fixtures behave as recorded.`);
