/**
 * Guardrail (#1624): the admin runbook served at `/protocol-console/docs`
 * must be byte-identical to the canonical it is generated from.
 *
 *     node apps/www/scripts/check-admin-knobs-mirror.mjs
 *
 * `contracts/script/sync-admin-knobs-doc.sh` copies
 * `docs/ops/AdminConfigurableKnobsAndSwitches.md` over
 * `apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`.
 * It is a plain `cp`, so "in sync" is exactly "the bytes match" — there
 * is no formatting step to account for and no reason to compare
 * anything looser.
 *
 * Why this exists rather than trusting the documented workflow: the two
 * files had silently swapped roles. Edits kept landing on the MIRROR —
 * naturally, since a docs sweep opens the file under `apps/www/src/`,
 * which is where the content lives — while the canonical went untouched.
 * By the time anyone noticed, running the sync as documented would have
 * REVERTED five months of corrections: it would have reinstated the
 * cross-chain VPFI buy section that #687-A excised for legal reasons,
 * and rewritten Chainlink CCIP back to LayerZero, on a published page.
 *
 * That is the failure this check is for. A generated file that can be
 * hand-edited without complaint is not generated, it is forked; and the
 * moment it forks, the generator becomes a weapon pointed at the newer
 * copy. Failing here means one of the two was edited alone, and the fix
 * is always the same: put the change in the canonical and re-run the
 * sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const CANONICAL = path.join(
  REPO_ROOT,
  'docs/ops/AdminConfigurableKnobsAndSwitches.md',
);
const MIRROR = path.join(
  REPO_ROOT,
  'apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md',
);

const missing = [CANONICAL, MIRROR].filter((p) => !fs.existsSync(p));
if (missing.length > 0) {
  console.error(
    `[check-admin-knobs-mirror] FAIL — file(s) not found:\n` +
      missing.map((p) => `  ${path.relative(REPO_ROOT, p)}`).join('\n') +
      `\n\nIf one was renamed, update this check and ` +
      `contracts/script/sync-admin-knobs-doc.sh together.`,
  );
  process.exit(1);
}

const canonical = fs.readFileSync(CANONICAL);
const mirror = fs.readFileSync(MIRROR);

if (canonical.equals(mirror)) {
  console.log(
    '[check-admin-knobs-mirror] OK — the admin runbook mirror matches its canonical byte for byte',
  );
  process.exit(0);
}

// Name the first divergence by LINE, not byte offset: the reader's next
// action is to open one of the files, and a byte offset does not help
// them do that.
const a = canonical.toString('utf8').split('\n');
const b = mirror.toString('utf8').split('\n');
let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i += 1;

console.error(
  `[check-admin-knobs-mirror] FAIL — the mirror has diverged from its canonical.

  canonical: docs/ops/AdminConfigurableKnobsAndSwitches.md          (${a.length} lines)
  mirror:    apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md  (${b.length} lines)

  first difference at line ${i + 1}:
    canonical: ${a[i] === undefined ? '(end of file)' : JSON.stringify(a[i].slice(0, 100))}
    mirror:    ${b[i] === undefined ? '(end of file)' : JSON.stringify(b[i].slice(0, 100))}

  The mirror is GENERATED. Do not fix it by editing the mirror — that is
  how the two files swapped roles in the first place (#1624). Put the
  change in the canonical, then:

    bash contracts/script/sync-admin-knobs-doc.sh

  and commit both files together.`,
);
process.exit(1);
