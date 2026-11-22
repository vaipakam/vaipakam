#!/usr/bin/env node
/**
 * Mirror `priority:*`, `stage:*` and `thread:*` issue labels onto the issue
 * fields `Priority`, `Stage` and `Thread`, the account-level issue fields the
 * `@vaipakam-labs` board views group by.
 *
 * WHY. Labels are the one place project agents can record priority, stage and
 * ownership, so the labels are the source of truth and the issue fields follow
 * them (owner decision 2026-11-22). This script is the "follows": it reads the
 * labels and the issue's current field values, and writes only the values that
 * differ. It never reads a field to decide a label — the direction is one way.
 * The values live on the ISSUE, not on a project card, so nothing here reads
 * or pages the board.
 *
 * THE API THIS RELIES ON (read 2026-11-22):
 *   - Field values, REST, documented for GitHub App INSTALLATION tokens (which
 *     the Actions `GITHUB_TOKEN` is) with the repository "Issues" permission:
 *       read:   every issue object carries `issue_field_values` (the issue
 *               listing and the single-issue read both returned the key);
 *       add:    POST   /repos/{o}/{r}/issues/{n}/issue-field-values
 *               body {issue_field_values: [{field_id, value}]}, a single-select
 *               value given as the option NAME, a text value as the string;
 *       delete: DELETE /repos/{o}/{r}/issues/{n}/issue-field-values/{field_id}.
 *     https://docs.github.com/en/rest/issues/issue-field-values
 *     (PUT on the same path REPLACES every value on the issue, including fields
 *     this job does not own, so it is never used.)
 *   - Field definitions, GraphQL `Repository.issueFields` ("the repository's
 *     issue fields, inherited from the repository's owner"), added 2026-05-20.
 *     It is used because the REST definition endpoints are owner-scoped
 *     (`/orgs/{org}/issue-fields` needs an organization permission,
 *     `/user/issue-fields` a USER token) and this repository's owner is a
 *     personal account, so neither is reachable with a repository token.
 *     https://docs.github.com/en/graphql/reference/repos#repository
 *     https://docs.github.com/en/graphql/overview/changelog/2026
 *   The docs name no permission for that GraphQL read; whether the Actions
 *   token may make it is established by the first live run, which fails
 *   loudly (never writes) if it may not.
 *
 * WHAT IS PURE AND WHAT IS NOT. `planWrites` decides every write and every
 * report line from plain data, with no I/O, and is what the self-test pins
 * (`board-label-sync.selftest.mjs`). `listIssueFields` pages the definitions
 * through an injected GraphQL transport, so its pagination is pinned there
 * too. Only the transport (`gh` under `GH_DEBUG=api`) and the paginated REST
 * reads touch the network.
 *
 * Usage (the workflow sets every variable):
 *   node .github/scripts/board-label-sync.mjs              # reconcile every open issue
 *   node .github/scripts/board-label-sync.mjs --issue 123  # one issue (a label event)
 *
 *   ISSUE_REPO    owner/name: the only repository read or written
 *   GH_TOKEN      the Actions token (`issues: write`)
 *   DRY_RUN=true  plan and report, write nothing
 *   MAX_WRITES    the most field writes one run makes (default 300)
 *   RETRY_WAIT_CAP_SECONDS, RETRY_MARGIN_SECONDS  the rate-limit wait bounds
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── the label families ──────────────────────────────────────────────────────

/** The five stages. The `Stage` field's option names are these, matched
 *  case-insensitively (the live options are capitalised: `Held-for-Batch`). */
export const STAGES = ['building', 'held-for-batch', 'queued', 'waiting-on-owner', 'built-not-closed'];
const PRIORITIES = ['p1', 'p2', 'p3', 'p4', 'p5'];

/**
 * One entry per mirrored family. `field` is the issue field's NAME, matched at
 * run time, case-insensitively; no field id is ever written into this file.
 * `dataType` is the type the field must have: a field of another type is
 * reported as missing rather than written into.
 *
 * `valid(value)` says whether a label suffix is a value this family defines;
 * a label that fails it is reported as unrecognised and ignored. `owned` is
 * the set of values the sync itself writes — the only values it ever clears
 * (for Thread, the repository's own `thread:` suffixes, passed at run time).
 */
export const FAMILIES = [
  { key: 'priority', prefix: 'priority:', field: 'Priority', dataType: 'SINGLE_SELECT',
    valid: (v) => PRIORITIES.includes(v), owned: PRIORITIES },
  { key: 'stage', prefix: 'stage:', field: 'Stage', dataType: 'SINGLE_SELECT',
    valid: (v) => STAGES.includes(v), owned: STAGES },
  // Free text: any non-empty suffix is a thread, written as the label has it.
  { key: 'thread', prefix: 'thread:', field: 'Thread', dataType: 'TEXT',
    valid: (v) => v.length > 0, owned: null },
];

const lc = (s) => String(s ?? '').trim().toLowerCase();

// ── the planner (pure) ──────────────────────────────────────────────────────

/**
 * Decide every field write for the given issues.
 *
 * @param {Array<{number:number, state?:string, labels:string[],
 *                values:Array<{fieldId:number|null, fieldName:string, text:string|null}>}>} issues
 *   Issues of this repository with their label names and their current field
 *   values (`valuesFromRest`). Only OPEN ones are planned.
 * @param {Array<{dbId:number, name:string, dataType:string, options?:Array<{name:string}>}>} fields
 *   The issue fields available to the repository (`listIssueFields`).
 * @param {{threadValues?:string[]}} context
 *   `threadValues` lists every `thread:` suffix defined in the repository — a
 *   Thread value counts as one the sync would have written only when it is in
 *   this list (see the clearing rule below).
 * @returns {{writes:Array<object>, conflicts:Array<object>, unrecognised:Array<object>,
 *            missingFields:Array<{field:string, dataType:string}>,
 *            missingOptions:Record<string,string[]>, notOpen:number[]}}
 */
export function planWrites(issues, fields, context = {}) {
  const threadValues = new Set((context.threadValues ?? []).map(lc));

  // Resolve each family's field by NAME and TYPE. A field of the wrong type is
  // treated as absent: writing an option name into a text field (or the
  // reverse) would put the wrong kind of value on every issue.
  const resolved = {};
  const missingFields = [];
  for (const fam of FAMILIES) {
    const f = fields.find((x) => lc(x.name) === lc(fam.field) && x.dataType === fam.dataType);
    if (f) resolved[fam.key] = f;
    else missingFields.push({ field: fam.field, dataType: fam.dataType });
  }

  const writes = [];
  const conflicts = [];
  const unrecognised = [];
  const missingOptions = {};
  const notOpen = [];

  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    // The listing says open; an issue read as anything else is never written.
    if (issue.state !== undefined && lc(issue.state) !== 'open') {
      notOpen.push(issue.number);
      continue;
    }

    for (const fam of FAMILIES) {
      // Distinct values, keyed case-insensitively; a thread keeps its case.
      const values = new Map();
      for (const label of issue.labels) {
        if (!lc(label).startsWith(fam.prefix)) continue;
        const raw = label.slice(fam.prefix.length).trim();
        const v = fam.key === 'thread' ? raw : raw.toLowerCase();
        if (fam.valid(v)) { if (!values.has(lc(v))) values.set(lc(v), v); }
        else unrecognised.push({ issue: issue.number, label });
      }
      const unique = [...values.values()];

      const field = resolved[fam.key];
      if (!field) continue; // reported once, in missingFields
      // The current value, matched by the field's id (by name only when the
      // value carries no id).
      const cur = (issue.values ?? []).find((x) => (x.fieldId != null ? x.fieldId === field.dbId : lc(x.fieldName) === lc(field.name)));
      const current = cur?.text ?? null;

      if (unique.length > 1) {
        // Two labels of one family: the sync picks neither and leaves the
        // field as it is. Choosing one would put a guess on the issue that
        // nobody asked for.
        conflicts.push({ issue: issue.number, family: fam.key, labels: unique.map((v) => fam.prefix + v) });
        continue;
      }

      if (unique.length === 1) {
        const v = unique[0];
        let value;
        if (fam.dataType === 'SINGLE_SELECT') {
          // Case-insensitive: the label `stage:held-for-batch` is the option
          // `Held-for-Batch`. The option's own name is what is written.
          const opt = (field.options ?? []).find((o) => lc(o.name) === v);
          if (!opt) {
            (missingOptions[fam.field] ??= []);
            if (!missingOptions[fam.field].includes(v)) missingOptions[fam.field].push(v);
            continue;
          }
          if (current !== null && lc(current) === lc(opt.name)) continue;
          value = opt.name;
        } else {
          if (current === v) continue;
          value = v;
        }
        writes.push({ action: 'set', issue: issue.number, field: fam.field, fieldId: field.dbId, value, from: current });
        continue;
      }

      // No label of this family. Clear only a value the sync would have
      // written; leave anything else alone.
      if (current === null) continue;
      const owned = fam.owned ? fam.owned.includes(lc(current)) : threadValues.has(lc(current));
      if (owned) {
        writes.push({ action: 'clear', issue: issue.number, field: fam.field, fieldId: field.dbId, value: null, from: current });
      }
    }
  }

  for (const k of Object.keys(missingOptions)) missingOptions[k].sort();
  return { writes, conflicts, unrecognised, missingFields, missingOptions, notOpen };
}

/**
 * Normalise an issue's REST `issue_field_values` into the planner's shape.
 * A single-select value's `value` is the option's ID; its name is in
 * `single_select_option.name`, and the name is what is compared. A text
 * value's `value` is the string. Throws when the key is absent: without it
 * the current values are unknown, and planning from "none" would miss every
 * clear.
 */
export function valuesFromRest(issueFieldValues, issueNumber) {
  if (!Array.isArray(issueFieldValues)) {
    throw new Error(`#${issueNumber}: the issue read carries no issue_field_values, so its current field values are unknown`);
  }
  return issueFieldValues.map((x) => ({
    fieldId: x.issue_field_id == null ? null : Number(x.issue_field_id),
    fieldName: x.issue_field_name ?? '',
    text: x.single_select_option ? (x.single_select_option.name ?? null)
      : (typeof x.value === 'string' ? x.value : (x.value == null ? null : String(x.value))),
  }));
}

/** The writes for one issue as REST requests: every set in ONE add request,
 *  each clear as its own delete. Values travel in the JSON body. */
export function requestsFor(repo, issueNumber, writes) {
  const base = `repos/${repo}/issues/${issueNumber}/issue-field-values`;
  const out = [];
  const sets = writes.filter((w) => w.action === 'set');
  if (sets.length) {
    out.push({ method: 'POST', path: base, body: { issue_field_values: sets.map((w) => ({ field_id: w.fieldId, value: w.value })) }, writes: sets.length });
  }
  for (const w of writes.filter((x) => x.action === 'clear')) {
    out.push({ method: 'DELETE', path: `${base}/${w.fieldId}`, body: null, writes: 1 });
  }
  return out;
}

// ── field definitions (GraphQL) ─────────────────────────────────────────────

/** One page of the issue fields the repository inherits from its owner. No
 *  values and no issues: only names, types, database ids and option names. */
export const ISSUE_FIELDS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issueFields(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on IssueFieldCommon { name dataType fullDatabaseId }
        ... on IssueFieldSingleSelect { options { name } }
      }
    }
  }
}`;

/**
 * Page every issue field definition. `gql(query, variables)` returns the
 * decoded body (`{data: …}`). `fullDatabaseId` is the `field_id` the REST
 * value endpoints take; it arrives as a BigInt string.
 */
export async function listIssueFields(gql, repo, { maxPages = 10 } = {}) {
  const [owner, name] = repo.split('/');
  let after = null;
  const fields = [];
  for (let page = 0; page < maxPages; page += 1) {
    const res = await gql(ISSUE_FIELDS_QUERY, { owner, name, after });
    const conn = res?.data?.repository?.issueFields;
    if (!conn) {
      const msg = (res?.errors ?? []).map((e) => e.message).join('; ').slice(0, 300);
      throw new Error(`issue fields of ${repo} not readable${msg ? `: ${msg}` : ''}`);
    }
    for (const n of conn.nodes ?? []) {
      if (!n || !n.name || n.fullDatabaseId == null) continue;
      fields.push({ dbId: Number(n.fullDatabaseId), name: n.name, dataType: n.dataType, options: n.options });
    }
    if (!conn.pageInfo.hasNextPage) return { fields, pages: page + 1 };
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`issue field listing did not end within ${maxPages} pages`);
}

// ── the transport: gh, with the reconcile job's rate-limit rule ─────────────

/**
 * The lines of a failed request's trace that are safe to print: the status
 * line, rate-limit and retry headers, the request id, and error messages.
 * An allow-list, the same one `project-board-reconcile.yml` applies, for the
 * same reason: this repository's Actions logs are public and a trace carries
 * response bodies.
 */
export function traceEvidence(trace) {
  const out = [];
  for (const line of trace.split('\n')) {
    if (/^[\s]*[<>]?[\s]*(HTTP\/|x-ratelimit-|retry-after|x-github-request-id)/i.test(line)) out.push(line);
  }
  for (const m of trace.matchAll(/"(message|documentation_url)"\s*:\s*"[^"]{0,300}"/g)) out.push(m[0]);
  return out
    .map((l) => l
      .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '***redacted***')
      .replace(/github_pat_[A-Za-z0-9_]{16,}/g, '***redacted***')
      .replace(/^(\s*[<>]?\s*authorization:).*/i, '$1 ***redacted***'))
    .join('\n')
    .slice(-20000);
}

/** The REST API version the issue-field-values documentation is written
 *  against; sent on those requests only. */
export const FIELD_VALUES_API_VERSION = '2026-03-10';

/**
 * A transport over `gh api`, carrying the reconcile job's rule unchanged:
 * when a request fails, its OWN trace is classified by
 * `gh-trace-ratelimit-wait.sh` (the one statement of what counts as a limit,
 * GraphQL's 200-with-error and REST's 403 alike); a recognised limit whose
 * wait, margin included, fits under the cap is waited out and the request
 * tried ONCE more. Anything else fails at once.
 *
 * ONE wait per RUN, not per request: a run that meets the limit twice has met
 * a bucket something else is draining, and parking the runner again would
 * hide that. The second failure ends the run; the writes are idempotent and
 * the next hourly run carries on from what the issues then show.
 *
 * `deps` is injectable so the self-test can drive the rule without a network:
 * `run(args, input)` → {status, stdout, stderr}, `classify(trace)` →
 * {rc, stdout}, `sleep(seconds)`, `log(line)`.
 */
export function makeGhTransport(deps, { waitCap = 900, margin = 5 } = {}) {
  let waited = false;
  const stats = { calls: 0, waits: 0 };
  async function call(args, input, what) {
    for (let attempt = 0; ; attempt += 1) {
      stats.calls += 1;
      const r = deps.run(args, input);
      if (r.status === 0) return r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null;
      const c = deps.classify(r.stderr ?? '');
      let note;
      if (c.rc === 0) {
        const [secs, reason] = c.stdout.trim().split('\t');
        const wait = Number(secs) + margin;
        if (attempt === 0 && !waited && wait <= waitCap) {
          waited = true;
          stats.waits += 1;
          deps.log(`::warning::${what} was rate limited (${reason}); waiting ${wait}s before trying once more`);
          await deps.sleep(wait);
          continue;
        }
        note = attempt > 0 ? `rate limited again on the retry (${reason})`
          : waited ? `rate limited (${reason}) and this run has already spent its one wait`
            : `rate limited (${reason}); the wait would be ${wait}s, over the ${waitCap}s cap, so NOT retried`;
      } else if (c.rc === 2) {
        note = 'the parser could not read a response from the trace — whether this was a rate limit is UNKNOWN, not "no"';
      } else {
        note = 'failed with no recognised rate limit';
      }
      const err = new Error(`${what} ${note}`);
      err.evidence = traceEvidence(r.stderr ?? '');
      throw err;
    }
  }
  /** A GraphQL read; variables travel in the body, never in the document. */
  const gql = (query, variables) => call(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }), 'GraphQL request');
  /** A REST write to the issue-field-values endpoints. */
  const rest = (method, path, body) => call(
    ['api', '--method', method, path, '-H', `X-GitHub-Api-Version: ${FIELD_VALUES_API_VERSION}`, ...(body ? ['--input', '-'] : [])],
    body ? JSON.stringify(body) : undefined,
    `${method} ${path.replace(/^repos\/[^/]+\/[^/]+\//, '')}`,
  );
  return { gql, rest, stats };
}

const PARSER = join(dirname(fileURLToPath(import.meta.url)), 'gh-trace-ratelimit-wait.sh');

/** Classify a failed request's trace with the reconcile job's parser, run
 *  as-is. A file, not stdin: the parser reads its trace more than once. */
export function classifyTrace(trace) {
  const dir = mkdtempSync(join(tmpdir(), 'board-label-sync-'));
  try {
    writeFileSync(join(dir, 'trace.txt'), trace);
    const r = spawnSync('bash', [PARSER, join(dir, 'trace.txt')], { encoding: 'utf8' });
    return { rc: r.status, stdout: r.stdout ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function realDeps() {
  return {
    run: (args, input) => spawnSync('gh', args, {
      input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GH_DEBUG: 'api' },
    }),
    classify: classifyTrace,
    sleep: (s) => new Promise((res) => setTimeout(res, s * 1000)),
    log: (l) => console.log(l),
  };
}

/** A paginated REST read. Its stderr is NOT printed whole: an error line is
 *  cut to 500 characters and carries no trace (GH_DEBUG is not set here). */
function restLines(path, jq) {
  const r = spawnSync('gh', ['api', '--paginate', path, '--jq', jq], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`REST read of ${path.split('?')[0]} failed: ${(r.stderr ?? '').trim().slice(0, 500)}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── the report ──────────────────────────────────────────────────────────────

/** Render the job summary. Every missing field or option is an instruction
 *  for the owner, and is listed as one. */
export function renderSummary(plan, outcome) {
  const lines = ['## Issue field label sync', ''];
  lines.push(`- mode: ${outcome.mode}${outcome.dryRun ? ' (dry run — nothing written)' : ''}`);
  lines.push(`- open issues read: ${outcome.issues}`);
  lines.push(`- field writes planned: ${plan.writes.length}; made: ${outcome.written}; deferred to the next run by MAX_WRITES: ${outcome.deferred}`);
  if (outcome.failed) lines.push(`- writes not confirmed (the next run re-plans them): ${outcome.failed}`);
  lines.push(`- API requests through the rate-limit rule: ${outcome.calls}${outcome.waits ? ', after one rate-limit wait' : ''}`);
  if (plan.notOpen.length) {
    lines.push(`- issues read as not open, skipped: ${plan.notOpen.map((n) => `#${n}`).join(', ')}`);
  }
  const todo = [];
  for (const { field, dataType } of plan.missingFields) {
    const hint = field === 'Priority' ? 'single select, options P1, P2, P3, P4, P5'
      : field === 'Stage' ? `single select, options ${STAGES.join(', ')} (any capitalisation)`
        : 'text';
    todo.push(`- Add the issue field **${field}** (${hint}) for the repository's owner, or fix its type (it must be ${dataType}). Its writes are skipped until it exists.`);
  }
  for (const [f, opts] of Object.entries(plan.missingOptions)) {
    for (const o of opts) todo.push(`- Add the option **${o}** to the **${f}** issue field. Issues labelled with it are skipped until it exists.`);
  }
  if (todo.length) lines.push('', '### Add to the issue fields', '', ...todo);
  if (plan.conflicts.length) {
    lines.push('', '### Two labels of one family (field left as it is)', '');
    for (const c of plan.conflicts) lines.push(`- #${c.issue}: ${c.labels.map((l) => `\`${l}\``).join(' and ')} — remove all but one`);
  }
  if (plan.unrecognised.length) {
    lines.push('', '### Labels this sync does not recognise (ignored)', '');
    for (const u of plan.unrecognised) lines.push(`- #${u.issue}: \`${u.label}\``);
  }
  if (plan.writes.length) {
    lines.push('', '### Writes', '');
    for (const w of plan.writes.slice(0, 200)) {
      lines.push(`- #${w.issue} ${w.field}: ${w.from ?? '(empty)'} → ${w.action === 'set' ? w.value : '(cleared)'}`);
    }
    if (plan.writes.length > 200) lines.push(`- … and ${plan.writes.length - 200} more`);
  }
  return `${lines.join('\n')}\n`;
}

// ── main ────────────────────────────────────────────────────────────────────

// Each write request creates content and notifies the issue's subscribers, and
// GitHub meters content creation with a secondary limit; one request a second
// stays well under it.
const REQUEST_PAUSE_SECONDS = 1;

const ISSUE_JQ = '{number, state, pr: has("pull_request"), labels: [.labels[].name], ifv: .issue_field_values} | tojson';

async function main() {
  const args = process.argv.slice(2);
  let issueNo = null;
  if (args.length === 2 && args[0] === '--issue' && /^[1-9][0-9]*$/.test(args[1])) issueNo = Number(args[1]);
  else if (args.length !== 0) {
    console.error('Usage: board-label-sync.mjs [--issue <number>]');
    return 2;
  }
  const env = process.env;
  for (const k of ['ISSUE_REPO', 'GH_TOKEN']) {
    if (!env[k]) { console.error(`::error::${k} is not set`); return 2; }
  }
  const repo = env.ISSUE_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { console.error('::error::ISSUE_REPO is not owner/name'); return 2; }
  const dryRun = env.DRY_RUN === 'true';
  const maxWrites = Number(env.MAX_WRITES || '300');
  const deps = realDeps();
  const { gql, rest, stats } = makeGhTransport(deps, {
    waitCap: Number(env.RETRY_WAIT_CAP_SECONDS || '900'),
    margin: Number(env.RETRY_MARGIN_SECONDS || '5'),
  });

  // Every `thread:` label the repository defines — what decides whether a
  // Thread value on an issue is one this sync would have written.
  const threadValues = restLines(`repos/${repo}/labels?per_page=100`, '.[].name | select(startswith("thread:")) | tojson')
    .map((n) => n.slice('thread:'.length));

  let rows;
  if (issueNo === null) {
    rows = restLines(`repos/${repo}/issues?state=open&per_page=100`, `.[] | ${ISSUE_JQ}`).filter((r) => !r.pr);
  } else {
    const [one] = restLines(`repos/${repo}/issues/${issueNo}`, ISSUE_JQ);
    if (one.pr || one.state !== 'open') {
      console.log(`#${issueNo} is ${one.pr ? 'a pull request' : 'closed'}; nothing to mirror`);
      return 0;
    }
    rows = [one];
  }
  const issues = rows.map((r) => ({ number: r.number, state: r.state, labels: r.labels, values: valuesFromRest(r.ifv, r.number) }));
  console.log(`open issues: ${issues.length}`);

  const { fields, pages } = await listIssueFields(gql, repo);
  console.log(`issue fields: ${fields.length} over ${pages} page(s)`);

  const plan = planWrites(issues, fields, { threadValues });
  const todo = plan.writes.slice(0, maxWrites);
  const deferred = plan.writes.length - todo.length;
  let written = 0;
  let failed = 0;
  let fatal = null;
  if (!dryRun) {
    const byIssue = new Map();
    for (const w of todo) byIssue.set(w.issue, [...(byIssue.get(w.issue) ?? []), w]);
    const requests = [...byIssue].flatMap(([n, ws]) => requestsFor(repo, n, ws));
    for (let i = 0; i < requests.length; i += 1) {
      const q = requests[i];
      try {
        await rest(q.method, q.path, q.body);
        written += q.writes;
      } catch (e) {
        failed = todo.length - written;
        fatal = e;
        break; // a failed write does not get followed by more of the same
      }
      if (i + 1 < requests.length) await deps.sleep(REQUEST_PAUSE_SECONDS);
    }
  }

  const summary = renderSummary(plan, {
    mode: issueNo === null ? 'scheduled reconcile' : `label event on #${issueNo}`,
    dryRun, issues: issues.length,
    written, failed, deferred: dryRun ? 0 : deferred, calls: stats.calls, waits: stats.waits,
  });
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (deferred && !dryRun) console.log(`::warning::${deferred} write(s) over MAX_WRITES=${maxWrites} left for the next run`);
  if (plan.missingFields.length || Object.keys(plan.missingOptions).length) {
    console.log('::notice::issue fields or options are missing — see the job summary for what to add');
  }
  if (fatal) {
    console.log('::group::failed request — status, rate-limit headers, error message');
    console.log(fatal.evidence || '(nothing recognised in the trace; it is not printed because it carries response bodies)');
    console.log('::endgroup::');
    console.log(`::error::${fatal.message}; ${written} write(s) made before it`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    if (e.evidence !== undefined) {
      console.log('::group::failed request — status, rate-limit headers, error message');
      console.log(e.evidence || '(nothing recognised in the trace; it is not printed because it carries response bodies)');
      console.log('::endgroup::');
    }
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
