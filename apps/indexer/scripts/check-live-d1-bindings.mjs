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
 * The expected id is not a parameter either: it is read from
 * `apps/indexer/wrangler.jsonc`, the single declaration that
 * `check-d1-name-consistency` holds every other reference to. The Workers
 * to ask about are read from their own committed configs, so a Worker
 * added later is covered without editing a list here.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const DECLARING_FILE = 'apps/indexer/wrangler.jsonc';

/**
 * The Workers that bind the shared database, by the config that declares
 * each. The binding NAME differs by Worker — the backup Worker reads it
 * as `DB_ARCHIVE` — so the check keys on the database id, not the name.
 */
const CONFIGS = [
  'apps/indexer/wrangler.jsonc',
  'apps/keeper/wrangler.jsonc',
  'apps/agent/wrangler.jsonc',
  'ops/offchain-data-warm/wrangler.jsonc',
];

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

async function main() {
  const argv = process.argv.slice(2);
  const USAGE =
    'usage:\n  check-live-d1-bindings.mjs [--allow-maintenance] [--expect <database name>]';
  // Strict, for the same reason the carry tool is: a mistyped flag that is
  // silently ignored turns a deliberate allowance into an accidental one.
  let allowMaintenance = false;
  let expectName = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--allow-maintenance') {
      allowMaintenance = true;
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

  const declared = (cfgOf(DECLARING_FILE).d1_databases ?? []).find(
    (e) => e.binding === 'DB',
  );
  if (!declared?.database_id) {
    fail(`${DECLARING_FILE} has no complete "DB" d1 binding to check against.`);
  }
  // The default expectation is the declared shared database, which is the
  // forward direction. A ROLLBACK inverts it: the Workers are meant to be
  // back on the database being left behind, and a probe that can only
  // expect the shared one would reject every correctly rolled-back Worker
  // — leaving the reverse switch with no serving-version check at all,
  // which is the half of the move where one is needed most.
  let EXPECT = declared.database_id;
  let expectLabel = `${declared.database_name} (${EXPECT}), per ${DECLARING_FILE}`;
  if (expectName && expectName !== declared.database_name) {
    const found = await cf(
      `/d1/database?name=${encodeURIComponent(expectName)}`,
    );
    const hit = (found ?? []).find((d) => d.name === expectName);
    if (!hit) fail(`no D1 database named "${expectName}" in this account`);
    EXPECT = hit.uuid;
    expectLabel =
      `${expectName} (${EXPECT}) — NOT the database ${DECLARING_FILE} ` +
      `declares (${declared.database_name}). This is the rollback ` +
      `direction; say so in the run log`;
  }
  console.log(`expecting ${expectLabel}\n`);

  const problems = [];
  for (const file of CONFIGS) {
    const cfg = cfgOf(file);
    const script = cfg.name;
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
        // A version with NO d1 binding is the maintenance build. That IS a
        // deliberate state — during the barrier, before the switch. It is
        // not a deliberate state AFTER the merge, where this command is the
        // gate that authorises restoring normal operation: a failed build
        // that left a Worker on the maintenance version looks exactly like
        // this, and passing it would authorise traffic to a Worker that
        // cannot reach any database. So it fails unless the operator says
        // they are inside that window.
        const note = allowMaintenance
          ? 'no D1 binding — held off its database (allowed: --allow-maintenance)'
          : 'no D1 binding — held off its database ← NOT ACCEPTABLE HERE';
        console.log(`  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ${note}`);
        if (!allowMaintenance) {
          problems.push(
            `${script} version ${v.id}${share} serves NO D1 binding. If the ` +
              `switch is done, this is a Worker still on the maintenance ` +
              `build — a failed or unfinished deploy, not a success. If you ` +
              `are inside the barrier on purpose, pass --allow-maintenance ` +
              `and say so.`,
          );
        }
        continue;
      }
      for (const b of bindings) {
        const ok = b.id === EXPECT;
        console.log(
          `  ${script.padEnd(30)} ${v.id.slice(0, 8)}${share}  ${b.name}=${b.id} ` +
            `${ok ? 'OK' : '← MISMATCH'}`,
        );
        if (!ok) {
          problems.push(
            `${script} version ${v.id}${share} serves ${b.name}=${b.id}, ` +
              `not ${EXPECT}`,
          );
        }
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
