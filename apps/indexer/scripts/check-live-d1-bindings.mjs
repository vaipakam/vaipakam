#!/usr/bin/env node
/**
 * check-live-d1-bindings — what database is each Worker ACTUALLY SERVING
 * against, right now.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A ONE-LINE `curl` (#2214). The
 * cutover's last step is "verify every Worker's D1 binding id". An
 * earlier revision of the runbook said to read
 * `/workers/scripts/<name>/settings`, and that probe RETURNS THE WRONG
 * ANSWER — it reports the bindings of the most recently UPLOADED version,
 * which on any repository with branch builds is a version nobody is
 * served. Measured on 2026-09-21, mid-cutover: `settings` reported
 * `DB=e5e927cf…` (warm) for `vaipakam-indexer` while the deployment
 * actually serving traffic — version `964d9628…`, from the day before —
 * was bound to `3cffebf5…` (archive). A cutover verified that way passes
 * while every write still lands in the database being abandoned, which is
 * the precise failure the step was added to catch.
 *
 * So the question has to be asked of the DEPLOYMENT, not the script:
 *
 *   1. `/workers/scripts/<name>/deployments` → the active deployment.
 *   2. Every version inside it — a gradual deployment splits traffic
 *      across several, so checking only the first would let a 90/10 split
 *      pass with one tenth of requests still writing to the old database.
 *   3. That version's own `resources.bindings`.
 *
 * The expected id is not a free parameter: it is one of the two
 * databases this move is between, pinned by id in
 * `lib/cutover-databases.mjs` — never a name resolved against the
 * account, which is a label the account can reassign. The Workers to ask
 * about are read from their own committed configs, so a Worker added
 * later is covered without editing a list here.
 *
 * This is a LIVE check against the Cloudflare API — it needs credentials
 * and it is not wired into CI. Run it after a cutover, and after any
 * deploy that was supposed to change a binding.
 *
 * USAGE
 *   node apps/indexer/scripts/check-live-d1-bindings.mjs
 *
 * ENVIRONMENT: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREDECESSOR,
  SUCCESSOR,
  knownDatabase,
} from './lib/cutover-databases.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');


/**
 * The Workers that bind the shared database, by the config that declares
 * each. The binding NAME differs by Worker — the backup Worker reads it
 * as `DB_ARCHIVE` — so the check keys on the database id, not the name.
 */
/**
 * The WRITERS — the three Workers the barrier has to stop, and the three
 * a merge redeploys automatically (#2237).
 */
const WRITERS = [
  'apps/indexer/wrangler.jsonc',
  'apps/keeper/wrangler.jsonc',
  'apps/agent/wrangler.jsonc',
];

/**
 * Deployed BY HAND, so a merge does not move it and the barrier does not
 * stop it. It is listed separately because the two facts change what each
 * check may assume, not because it matters less.
 */
const MANUAL = ['ops/offchain-data-warm/wrangler.jsonc'];

const CONFIGS = [...WRITERS, ...MANUAL];

/**
 * The binding NAME a Worker's code reads, taken from its own config. It
 * matters as much as the id: a serving build can attach the right
 * database under the wrong name — or lose `DB` while gaining some other
 * d1 binding — and the Worker's `env.DB` is then undefined while a check
 * that only looked at ids reported OK. This command is the gate that
 * authorises normal operation after the switch, so "some binding somewhere
 * points at the right database" is not the question it is asked.
 */
function requiredBindings(cfg) {
  return (cfg.d1_databases ?? []).map((e) => e.binding).filter(Boolean);
}

function fail(msg) {
  console.error(`\n[check-live-d1-bindings] ${msg}\n`);
  process.exit(1);
}

/** Strip JSONC comments without mangling string contents. */
function parseJsonc(src, file) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch (err) {
    fail(`${file}: not parseable as JSONC — ${err.message}`);
  }
}

const cfgOf = (file) => parseJsonc(readFileSync(join(REPO, file), 'utf8'), file);

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';

/** Account-relative, so the account id never reaches an error message. */
async function cf(subpath) {
  const res = await fetch(`${API}/accounts/${ACCOUNT}${subpath}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body?.success) {
    throw new Error(`HTTP ${res.status} on ${subpath}\n${text.slice(0, 1000)}`);
  }
  return body.result;
}

/** The versions currently serving traffic, with their traffic share. */
async function servingVersions(script) {
  const result = await cf(`/workers/scripts/${script}/deployments`);
  const list = Array.isArray(result) ? result : (result?.deployments ?? []);
  const active = list[0];
  if (!active) return null;
  return {
    deployment: active.id,
    createdOn: active.created_on,
    versions: (active.versions ?? []).map((v) => ({
      id: v.version_id,
      percentage: v.percentage,
    })),
  };
}

async function d1Of(script, versionId) {
  const v = await cf(`/workers/scripts/${script}/versions/${versionId}`);
  return (v?.resources?.bindings ?? []).filter((b) => b.type === 'd1');
}

/**
 * Inside the barrier: every serving version of every WRITER must carry no
 * D1 binding whatsoever. That is the property the maintenance build is
 * for — capability removed, not routes closed — and this asserts it
 * rather than tolerating it.
 */
async function assertWritersHeld() {
  console.log(
    `expecting every serving version of the three writers to carry NO D1 ` +
      `binding.\nThe hand-deployed backup Worker is NOT checked here: the ` +
      `barrier does not\nstop it, and it stays on the database being left ` +
      `behind until step 5.\n`,
  );
  const problems = [];
  for (const file of WRITERS) {
    const script = cfgOf(file).name;
    const serving = await servingVersions(script);
    if (!serving) {
      problems.push(`${script}: has no active deployment`);
      continue;
    }
    for (const v of serving.versions) {
      const bindings = await d1Of(script, v.id);
      const share = v.percentage == null ? '' : ` @ ${v.percentage}%`;
      const held = bindings.length === 0;
      console.log(
        `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ` +
          (held
            ? 'no D1 binding — HELD'
            : `${bindings
                .map((b) => `${b.name}=${b.id}`)
                .join(', ')} ← STILL BOUND`),
      );
      if (!held) {
        problems.push(
          `${script} version ${v.id}${share} still carries ` +
            `${bindings.map((b) => b.name).join(', ')}. This writer can ` +
            `still reach a database, so the barrier is not closed and any ` +
            `copy taken now can be overtaken.`,
        );
      }
    }
  }
  console.log('');
  if (problems.length > 0) {
    console.error(
      `[check-live-d1-bindings] ${problems.length} problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nDo not take the final carry until every writer is held.\n`,
    );
    process.exit(1);
  }
  console.log(
    `[check-live-d1-bindings] OK — every serving version of all ` +
      `${WRITERS.length} writers carries no D1 binding. New invocations ` +
      `cannot obtain a handle; work already running is the residual the ` +
      `runbook names, which the digest barrier narrows and step 6 closes.`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const USAGE =
    'usage:\n' +
    '  check-live-d1-bindings.mjs [--expect <database name>]  # after the switch\n' +
    '  check-live-d1-bindings.mjs --writers-held              # inside the barrier';
  // Strict, for the same reason the carry tool is: a mistyped flag that is
  // silently ignored turns a deliberate allowance into an accidental one.
  let writersHeld = false;
  let expectName = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--writers-held') {
      writersHeld = true;
      continue;
    }
    if (argv[i] === '--expect') {
      expectName = argv[i + 1];
      if (!expectName || expectName.startsWith('--')) {
        fail(`--expect needs a database name\n\n${USAGE}`);
      }
      i += 1;
      continue;
    }
    fail(`unrecognised argument: ${argv[i]}\n\n${USAGE}`);
  }

  if (!ACCOUNT || !TOKEN) {
    fail('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.');
  }

  // `--writers-held` is a DIFFERENT QUESTION, not a relaxation of this
  // one, and the flag it replaces could not answer it either way.
  //
  // `--allow-maintenance` merely PERMITTED a version with no binding: it
  // would have passed a writer still happily serving warm, so it proved
  // nothing about the writers being stopped. And it still checked the
  // backup Worker, which inside the barrier is deliberately still on
  // archive — so the one command the runbook offered for confirming the
  // barrier reported a mismatch even when the barrier was perfect.
  //
  // This asks the positive question of the three Workers the barrier is
  // about: does each serving version carry NO D1 binding at all. The
  // hand-deployed backup Worker is out of scope here by construction,
  // which is stated rather than worked around.
  if (writersHeld) {
    if (expectName) fail(`--writers-held takes no --expect\n\n${USAGE}`);
    await assertWritersHeld();
    return;
  }

  // The default expectation is the successor, which is the forward
  // direction. A ROLLBACK inverts it: the Workers are meant to be back on
  // the database being left behind, and a probe that can only expect the
  // successor would reject every correctly rolled-back Worker — leaving
  // the reverse switch with no serving-version check at all, which is the
  // half of the move where one is needed most.
  //
  // THE EXPECTATION IS PINNED BY ID, AND NOT RESOLVED FROM THE ACCOUNT.
  // This used to ask Cloudflare which database owns the given name and
  // trust the answer, which makes the gate only as strong as a label the
  // account can reassign: delete the predecessor and recreate it under the
  // same name, and every Worker attached to the REPLACEMENT passes a
  // rollback check while the retained data sits in a database nothing is
  // bound to (#2267 r23). The carry tool has pinned both ends by id since
  // r3 for the same reason; this probe was the other half of that pair and
  // had not been.
  let expected = SUCCESSOR;
  let expectLabel = `${SUCCESSOR.name} (${SUCCESSOR.id})`;
  if (expectName && expectName !== SUCCESSOR.name) {
    const hit = knownDatabase(expectName);
    if (!hit) {
      fail(
        `--expect "${expectName}" is neither database this move is ` +
          `between (${SUCCESSOR.name}, ${PREDECESSOR.name}).\n\nThis probe ` +
          `does not resolve a name against the account: a name is a label ` +
          `the account can reassign, and trusting one would let a Worker ` +
          `attached to a replacement database pass a rollback check while ` +
          `the retained data is elsewhere.`,
      );
    }
    expected = hit;
    expectLabel =
      `${hit.name} (${hit.id}) — NOT the successor (${SUCCESSOR.name}). ` +
      `This is the rollback direction; say so in the run log`;
  }
  const EXPECT = expected.id;
  console.log(`expecting ${expectLabel}\n`);

  const problems = [];
  for (const file of CONFIGS) {
    const cfg = cfgOf(file);
    const script = cfg.name;
    const needed = requiredBindings(cfg);
    if (!script) {
      problems.push(`${file}: no "name", so there is no Worker to ask about`);
      continue;
    }

    let serving;
    try {
      serving = await servingVersions(script);
    } catch (err) {
      problems.push(`${script}: could not read its deployments — ${err.message}`);
      continue;
    }
    if (!serving) {
      problems.push(`${script}: has no active deployment`);
      continue;
    }

    for (const v of serving.versions) {
      const bindings = await d1Of(script, v.id);
      const share = v.percentage == null ? '' : ` @ ${v.percentage}%`;
      if (bindings.length === 0) {
        // A version with NO d1 binding is the maintenance build. That is a
        // deliberate state inside the barrier and a FAILED OR UNFINISHED
        // DEPLOY here, where this command is the gate authorising normal
        // operation — and the two are indistinguishable from outside, so
        // this mode never accepts it. Confirming the barrier is a
        // different question with its own mode: `--writers-held`, which
        // asserts the absence rather than tolerating it.
        console.log(
          `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  no D1 ` +
            `binding — held off its database ← NOT ACCEPTABLE HERE`,
        );
        problems.push(
          `${script} version ${v.id}${share} serves NO D1 binding. If the ` +
            `switch is done, this is a Worker still on the maintenance ` +
            `build — a failed or unfinished deploy, not a success. To ` +
            `confirm the barrier itself, run --writers-held instead.`,
        );
        continue;
      }
      // Every binding the Worker's own config declares must be PRESENT, by
      // name, and pointing at the expected database. A serving build that
      // attached the right database under a different name would leave
      // `env.DB` undefined while every id on the version matched.
      const served = new Map(bindings.map((b) => [b.name, b.id]));
      for (const name of needed) {
        const id = served.get(name);
        if (id === undefined) {
          console.log(
            `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ${name} ` +
              `ABSENT ← the Worker reads env.${name}`,
          );
          problems.push(
            `${script} version ${v.id}${share} has no d1 binding named ` +
              `"${name}", which ${file} declares and the Worker's code ` +
              `reads as env.${name}. Whatever else is attached, that ` +
              `reference is undefined at runtime.`,
          );
          continue;
        }
        const ok = id === EXPECT;
        console.log(
          `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ${name}=${id} ` +
            `${ok ? 'OK' : '← MISMATCH'}`,
        );
        if (!ok) {
          problems.push(
            `${script} version ${v.id}${share} serves ${name}=${id}, not ` +
              `${EXPECT}`,
          );
        }
      }
      // An attachment the config does not declare is reported rather than
      // ignored: it is not a failure by itself, but on a gate authorising
      // normal operation an unexplained database attachment is worth a line.
      for (const b of bindings) {
        if (needed.includes(b.name)) continue;
        console.log(
          `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ${b.name}=${b.id} ` +
            `(not declared in ${file})`,
        );
      }
    }
    console.log(
      `  ${''.padEnd(30)} deployment ${serving.deployment.slice(0, 8)} ` +
        `(${serving.createdOn})`,
    );
  }

  console.log('');
  if (problems.length > 0) {
    console.error(
      `[check-live-d1-bindings] ${problems.length} problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nThese are the bindings of the versions actually SERVING, which ` +
        `is\nnot what \`/settings\` reports — that shows the most recently ` +
        `uploaded\nversion, which on a repository with branch builds is a ` +
        `version nobody\nis served.\n`,
    );
    process.exit(1);
  }
  console.log(
    `[check-live-d1-bindings] OK — every serving version of every Worker ` +
      `that binds a database binds ${EXPECT}.`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
