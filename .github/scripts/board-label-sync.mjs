#!/usr/bin/env node
/**
 * Mirror `priority:*`, `stage:*` and `thread:*` issue labels onto the
 * `@vaipakam-labs` board's `Priority`, `Stage` and `Thread` fields.
 *
 * WHY. Labels are the one place project agents can record priority, stage and
 * ownership: the board's fields have no API those agents can write. So the
 * labels are the source of truth and the board follows them (owner decision
 * 2026-11-22). This script is the "follows": it reads the labels, reads the
 * board, and writes only the fields that differ. It never reads a field to
 * decide a label — the direction is one way.
 *
 * WHAT IS PURE AND WHAT IS NOT. `planWrites` decides every write and every
 * report line from plain data, with no I/O, and is what the self-test pins
 * (`board-label-sync.selftest.mjs`). `listBoard` pages the board through an
 * injected GraphQL transport, so its pagination is pinned there too. Only the
 * transport (`gh` under `GH_DEBUG=api`) and the REST reads touch the network.
 *
 * Usage (the workflow sets every variable):
 *   node .github/scripts/board-label-sync.mjs              # reconcile every open issue
 *   node .github/scripts/board-label-sync.mjs --issue 123  # one issue (a label event)
 *
 *   PROJECT_OWNER, PROJECT_NUMBER, ISSUE_REPO   which board, which repository
 *   GH_TOKEN      the PAT: project reads and writes (GraphQL only)
 *   REPO_TOKEN    the Actions token: issue and label reads (REST only)
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

/** The five stages, in the order the board shows them. The option names on
 *  the board's `Stage` field are these strings exactly. */
export const STAGES = ['building', 'held-for-batch', 'queued', 'waiting-on-owner', 'built-not-closed'];

/**
 * One entry per mirrored family. `field` is the board field's NAME — matched
 * at run time, case-insensitively; no field or option id is ever written into
 * this file, so renaming or recreating an option on the board cannot leave a
 * stale id behind.
 *
 * `valid(value)` says whether a label suffix is a value this family defines;
 * a label that fails it is reported as unrecognised and ignored.
 * `matches(optionName, value)` says whether a board option carries `value`.
 * `optionFor(value)` is the option name the summary asks the owner to add.
 */
export const FAMILIES = [
  {
    key: 'priority',
    prefix: 'priority:',
    field: 'Priority',
    valid: (v) => /^p[1-5]$/.test(v),
    // `P1`, `p1`, `P1 – security`: the same P-number, followed by anything
    // that is not another digit (so `P1` never matches a `P10`).
    matches: (opt, v) => new RegExp(`^${v}(?![0-9])`, 'i').test(opt.trim()),
    optionFor: (v) => v.toUpperCase(),
  },
  {
    key: 'stage',
    prefix: 'stage:',
    field: 'Stage',
    valid: (v) => STAGES.includes(v),
    matches: (opt, v) => opt.trim().toLowerCase() === v,
    optionFor: (v) => v,
  },
  {
    key: 'thread',
    prefix: 'thread:',
    field: 'Thread',
    // Any non-empty suffix is a thread; whether the board has an option for
    // it is the "missing option" report, not a validity question.
    valid: (v) => v.length > 0,
    matches: (opt, v) => opt.trim().toLowerCase() === v,
    optionFor: (v) => v,
  },
];

// ── the planner (pure) ──────────────────────────────────────────────────────

/**
 * Decide every field write for the given issues and board items.
 *
 * @param {Array<{number:number,url:string,labels:string[]}>} issues
 *   The OPEN issues of `repo`, with their label names. Only these are planned.
 * @param {Array<{id:string,type:string,url?:string,repo?:string,state?:string,
 *                values:Record<string,{optionId:string,name:string}>}>} boardItems
 *   Board items. `values` is keyed by field id and holds single-select values.
 * @param {Array<{id:string,name:string,dataType?:string,options?:Array<{id:string,name:string}>}>} fields
 *   The board's fields.
 * @param {{repo:string, threadValues?:string[]}} context
 *   `repo` is `owner/name`; only that repository's issues are ever touched.
 *   `threadValues` lists every `thread:` suffix defined in the repository — a
 *   Thread value counts as one the sync would have written only when it is in
 *   this list (see the clearing rule below).
 * @returns {{writes:Array<object>, conflicts:Array<object>, unrecognised:Array<object>,
 *            missingFields:string[], missingOptions:Record<string,string[]>,
 *            notOnBoard:number[], closedOnBoard:number[], foreignItems:number}}
 */
export function planWrites(issues, boardItems, fields, context) {
  const repo = context.repo.toLowerCase();
  const threadValues = new Set((context.threadValues ?? []).map((v) => v.toLowerCase()));

  // Resolve each family's field by NAME. A field that is not a single select
  // is treated as absent: writing an option id into a text field would fail
  // every write, and reporting it as missing says what to fix.
  const resolved = {};
  const missingFields = [];
  for (const fam of FAMILIES) {
    const f = fields.find(
      (x) => x.name.trim().toLowerCase() === fam.field.toLowerCase() &&
        Array.isArray(x.options) && (x.dataType === undefined || x.dataType === 'SINGLE_SELECT'),
    );
    if (f) resolved[fam.key] = f;
    else missingFields.push(fam.field);
  }

  // Which options of a field the sync itself would write. Only a value that is
  // one of these is ever cleared when its label goes away; anything else on
  // the field was put there by a person or another tool and is left alone.
  const known = (fam, f) => (opt) => {
    if (fam.key === 'thread') {
      return [...threadValues].some((v) => fam.matches(opt.name, v));
    }
    const values = fam.key === 'priority' ? ['p1', 'p2', 'p3', 'p4', 'p5'] : STAGES;
    return values.some((v) => fam.matches(opt.name, v));
  };

  // Only this repository's issue items. Drafts, pull requests and other
  // repositories' issues are counted and never touched.
  const byUrl = new Map();
  let foreignItems = 0;
  for (const it of boardItems) {
    if (it.type === 'Issue' && (it.repo ?? '').toLowerCase() === repo && it.url) {
      byUrl.set(it.url, it);
    } else {
      foreignItems += 1;
    }
  }

  const writes = [];
  const conflicts = [];
  const unrecognised = [];
  const missingOptions = {};
  const notOnBoard = [];
  const closedOnBoard = [];

  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const item = byUrl.get(issue.url);
    if (!item) {
      notOnBoard.push(issue.number);
      continue;
    }
    // The issue list says open; a board that says closed is a race between
    // the two reads. Closed cards are never written, so it is skipped and the
    // next run, reading both again, settles it.
    if ((item.state ?? 'OPEN') !== 'OPEN') {
      closedOnBoard.push(issue.number);
      continue;
    }

    for (const fam of FAMILIES) {
      const values = [];
      for (const label of issue.labels) {
        if (!label.toLowerCase().startsWith(fam.prefix)) continue;
        const v = label.slice(fam.prefix.length).trim().toLowerCase();
        if (fam.valid(v)) values.push(v);
        else unrecognised.push({ issue: issue.number, label });
      }
      const unique = [...new Set(values)];

      const field = resolved[fam.key];
      if (!field) continue; // reported once, in missingFields
      const current = item.values?.[field.id] ?? null;

      if (unique.length > 1) {
        // Two labels of one family: the sync picks neither and leaves the
        // field as it is. Choosing one would put a guess on the board that
        // nobody asked for.
        conflicts.push({ issue: issue.number, family: fam.key, labels: unique.map((v) => fam.prefix + v) });
        continue;
      }

      if (unique.length === 1) {
        const v = unique[0];
        // An exact name beats a prefix match, so `P1` wins over `P1 (old)`.
        const opts = field.options.filter((o) => fam.matches(o.name, v));
        const opt = opts.find((o) => o.name.trim().toLowerCase() === fam.optionFor(v).toLowerCase()) ?? opts[0];
        if (!opt) {
          (missingOptions[fam.field] ??= []);
          const want = fam.optionFor(v);
          if (!missingOptions[fam.field].includes(want)) missingOptions[fam.field].push(want);
          continue;
        }
        if (current && current.optionId === opt.id) continue;
        writes.push({
          action: 'set', issue: issue.number, itemId: item.id, field: fam.field, fieldId: field.id,
          optionId: opt.id, optionName: opt.name, from: current?.name ?? null,
        });
        continue;
      }

      // No label of this family. Clear only a value the sync would have
      // written; leave anything else alone.
      if (current && field.options.some((o) => o.id === current.optionId && known(fam, field)(o))) {
        writes.push({
          action: 'clear', issue: issue.number, itemId: item.id, field: fam.field, fieldId: field.id,
          optionId: null, optionName: null, from: current.name,
        });
      }
    }
  }

  for (const k of Object.keys(missingOptions)) missingOptions[k].sort();
  return { writes, conflicts, unrecognised, missingFields, missingOptions, notOnBoard, closedOnBoard, foreignItems };
}

// ── GraphQL documents ───────────────────────────────────────────────────────

const FIELDS_FRAGMENT = `
  fields(first: 50) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } }
    }
  }`;

const VALUES_FRAGMENT = `
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        optionId
        name
        field { ... on ProjectV2FieldCommon { id } }
      }
    }
  }`;

/** One page of board items, and (on the first page only) the project id and
 *  its fields. No titles or bodies are requested: Drafts on this board exist
 *  nowhere else, and nothing here needs them. */
export const BOARD_PAGE_QUERY = `
query($owner: String!, $number: Int!, $after: String, $first: Boolean!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id @include(if: $first)
      ${FIELDS_FRAGMENT.replace('fields(first: 50)', 'fields(first: 50) @include(if: $first)')}
      items(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue { number url state repository { nameWithOwner } }
          }
          ${VALUES_FRAGMENT}
        }
      }
    }
  }
}`;

/** One issue's board item, with the board's fields, in ONE request — what a
 *  label event costs before any write. */
export const ISSUE_ITEM_QUERY = `
query($owner: String!, $number: Int!, $repoOwner: String!, $repoName: String!, $issue: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      ${FIELDS_FRAGMENT}
    }
  }
  repository(owner: $repoOwner, name: $repoName) {
    issue(number: $issue) {
      number
      url
      state
      projectItems(first: 20) {
        nodes {
          id
          project { id }
          ${VALUES_FRAGMENT}
        }
      }
    }
  }
}`;

/** Normalise a GraphQL item node into the planner's shape. */
export function itemFromNode(node, fallback = {}) {
  const c = node.content ?? {};
  const values = {};
  for (const v of node.fieldValues?.nodes ?? []) {
    if (v && v.optionId && v.field?.id) values[v.field.id] = { optionId: v.optionId, name: v.name };
  }
  return {
    id: node.id,
    type: c.__typename ?? fallback.type ?? 'Unknown',
    url: c.url ?? fallback.url,
    repo: c.repository?.nameWithOwner ?? fallback.repo,
    state: c.state ?? fallback.state,
    number: c.number ?? fallback.number,
    values,
  };
}

/** Normalise the fields connection. Non-select fields keep no `options`. */
export function fieldsFromNodes(nodes) {
  return (nodes ?? [])
    .filter((n) => n && n.id && n.name)
    .map((n) => ({ id: n.id, name: n.name, dataType: n.dataType, options: n.options }));
}

/**
 * Page every board item, once. `gql(query, variables)` returns the decoded
 * response body (`{data: …}`). Aborts on a short read rather than plan from
 * part of the board: an item read as absent is merely skipped, but a
 * truncated listing hides how much was skipped.
 */
export async function listBoard(gql, owner, number, { maxPages = 100 } = {}) {
  let after = null;
  let projectId = null;
  let fields = null;
  let total = null;
  const items = [];
  for (let page = 0; page < maxPages; page += 1) {
    const res = await gql(BOARD_PAGE_QUERY, { owner, number, after, first: page === 0 });
    const proj = res?.data?.user?.projectV2;
    if (!proj) throw new Error(`board ${owner}/${number} not readable (no projectV2 in the response)`);
    if (page === 0) {
      projectId = proj.id;
      fields = fieldsFromNodes(proj.fields?.nodes);
      total = proj.items.totalCount;
    }
    for (const n of proj.items.nodes ?? []) items.push(itemFromNode(n));
    if (!proj.items.pageInfo.hasNextPage) {
      if (items.length < total) {
        throw new Error(`board listing returned ${items.length} of ${total} items`);
      }
      return { projectId, fields, items, pages: page + 1 };
    }
    after = proj.items.pageInfo.endCursor;
  }
  throw new Error(`board listing did not end within ${maxPages} pages`);
}

/** Build one aliased mutation document for a batch of writes, values passed
 *  as variables (never interpolated into the document). */
export function mutationFor(projectId, batch) {
  const decls = ['$p: ID!'];
  const parts = [];
  const variables = { p: projectId };
  batch.forEach((w, i) => {
    decls.push(`$i${i}: ID!`, `$f${i}: ID!`);
    variables[`i${i}`] = w.itemId;
    variables[`f${i}`] = w.fieldId;
    if (w.action === 'set') {
      decls.push(`$o${i}: String!`);
      variables[`o${i}`] = w.optionId;
      parts.push(`w${i}: updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i${i}, fieldId: $f${i}, value: {singleSelectOptionId: $o${i}}}) { clientMutationId }`);
    } else {
      parts.push(`w${i}: clearProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i${i}, fieldId: $f${i}}) { clientMutationId }`);
    }
  });
  return { query: `mutation(${decls.join(', ')}) {\n  ${parts.join('\n  ')}\n}`, variables };
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

/**
 * A GraphQL transport over `gh api graphql`, carrying the reconcile job's
 * rule unchanged: when a request fails, its OWN trace is classified by
 * `gh-trace-ratelimit-wait.sh` (the one statement of what counts as a limit);
 * a recognised limit whose wait, margin included, fits under the cap is waited
 * out and the request tried ONCE more. Anything else fails at once.
 *
 * ONE wait per RUN, not per request: a run that meets the limit twice has met
 * a bucket some other tool is draining, and parking the runner again would
 * hide that. The second failure ends the run; the writes are idempotent and
 * the next hourly run carries on from what the board then shows.
 *
 * `deps` is injectable so the self-test can drive the rule without a network:
 * `run(args, input)` → {status, stdout, stderr}, `classify(trace)` →
 * {rc, stdout}, `sleep(seconds)`, `log(line)`.
 */
export function makeGhTransport(deps, { waitCap = 900, margin = 5 } = {}) {
  let waited = false;
  const stats = { calls: 0, waits: 0 };
  async function gql(query, variables) {
    const body = JSON.stringify({ query, variables });
    for (let attempt = 0; ; attempt += 1) {
      stats.calls += 1;
      const r = deps.run(['api', 'graphql', '--input', '-'], body);
      if (r.status === 0) return JSON.parse(r.stdout);
      const c = deps.classify(r.stderr ?? '');
      let note;
      if (c.rc === 0) {
        const [secs, reason] = c.stdout.trim().split('\t');
        const wait = Number(secs) + margin;
        if (attempt === 0 && !waited && wait <= waitCap) {
          waited = true;
          stats.waits += 1;
          deps.log(`::warning::GraphQL request was rate limited (${reason}); waiting ${wait}s before trying once more`);
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
      const err = new Error(`GraphQL request ${note}`);
      err.evidence = traceEvidence(r.stderr ?? '');
      throw err;
    }
  }
  return { gql, stats };
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

/** A REST read with the repository-scoped token, never the PAT: issue and
 *  label listings have their own budget, untouched by the board's. */
function restLines(path, jq, token) {
  const r = spawnSync('gh', ['api', '--paginate', path, '--jq', jq], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: token },
  });
  if (r.status !== 0) throw new Error(`REST read of ${path.split('?')[0]} failed: ${(r.stderr ?? '').trim().slice(0, 500)}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── the report ──────────────────────────────────────────────────────────────

/** Render the job summary. Every missing field or option is an instruction
 *  for the owner, and is listed as one. */
export function renderSummary(plan, outcome) {
  const lines = ['## Board label sync', ''];
  lines.push(`- mode: ${outcome.mode}${outcome.dryRun ? ' (dry run — nothing written)' : ''}`);
  lines.push(`- open issues read: ${outcome.issues}`);
  lines.push(`- board items read: ${outcome.boardItems} (other items, never touched: ${plan.foreignItems})`);
  lines.push(`- writes planned: ${plan.writes.length}; made: ${outcome.written}; deferred to the next run by MAX_WRITES: ${outcome.deferred}`);
  if (outcome.failed) lines.push(`- writes not confirmed (the next run re-plans them): ${outcome.failed}`);
  lines.push(`- GraphQL requests: ${outcome.calls}${outcome.waits ? `, after one rate-limit wait` : ''}`);
  if (plan.notOnBoard.length) {
    lines.push(`- open issues not on the board, skipped (project-board-reconcile.yml adds them): ${plan.notOnBoard.map((n) => `#${n}`).join(', ')}`);
  }
  if (plan.closedOnBoard.length) {
    lines.push(`- open issues the board shows as closed, skipped this run: ${plan.closedOnBoard.map((n) => `#${n}`).join(', ')}`);
  }
  const todo = [];
  for (const f of plan.missingFields) {
    const fam = FAMILIES.find((x) => x.field === f);
    const hint = fam.key === 'priority' ? 'options P1, P2, P3, P4, P5'
      : fam.key === 'stage' ? `options ${STAGES.join(', ')}`
        : 'one option per `thread:` label suffix';
    todo.push(`- Add the single-select field **${f}** on the board (${hint}). Its writes are skipped until it exists.`);
  }
  for (const [f, opts] of Object.entries(plan.missingOptions)) {
    for (const o of opts) todo.push(`- Add the option **${o}** to the **${f}** field. Issues labelled with it are skipped until it exists.`);
  }
  if (todo.length) lines.push('', '### Add on the board', '', ...todo);
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
      lines.push(`- #${w.issue} ${w.field}: ${w.from ?? '(empty)'} → ${w.action === 'set' ? w.optionName : '(cleared)'}`);
    }
    if (plan.writes.length > 200) lines.push(`- … and ${plan.writes.length - 200} more`);
  }
  return `${lines.join('\n')}\n`;
}

// ── main ────────────────────────────────────────────────────────────────────

const BATCH = 20; // writes per mutation document
const BATCH_PAUSE_SECONDS = 4; // between documents: at most 300 writes a minute

async function main() {
  const args = process.argv.slice(2);
  let issueNo = null;
  if (args.length === 2 && args[0] === '--issue' && /^[1-9][0-9]*$/.test(args[1])) issueNo = Number(args[1]);
  else if (args.length !== 0) {
    console.error('Usage: board-label-sync.mjs [--issue <number>]');
    return 2;
  }
  const env = process.env;
  for (const k of ['PROJECT_OWNER', 'PROJECT_NUMBER', 'ISSUE_REPO', 'GH_TOKEN', 'REPO_TOKEN']) {
    if (!env[k]) { console.error(`::error::${k} is not set`); return 2; }
  }
  const owner = env.PROJECT_OWNER;
  const number = Number(env.PROJECT_NUMBER);
  const repo = env.ISSUE_REPO;
  const dryRun = env.DRY_RUN === 'true';
  const maxWrites = Number(env.MAX_WRITES || '300');
  const deps = realDeps();
  const { gql, stats } = makeGhTransport(deps, {
    waitCap: Number(env.RETRY_WAIT_CAP_SECONDS || '900'),
    margin: Number(env.RETRY_MARGIN_SECONDS || '5'),
  });

  // Every `thread:` label the repository defines — what decides whether a
  // Thread value on the board is one this sync would have written.
  const threadValues = restLines(`repos/${repo}/labels?per_page=100`, '.[].name | select(startswith("thread:")) | tojson', env.REPO_TOKEN)
    .map((n) => n.slice('thread:'.length));

  let issues;
  let board;
  if (issueNo === null) {
    issues = restLines(`repos/${repo}/issues?state=open&per_page=100`,
      '.[] | select(has("pull_request") | not) | {number, url: .html_url, labels: [.labels[].name]} | tojson', env.REPO_TOKEN);
    console.log(`open issues: ${issues.length}`);
    board = await listBoard(gql, owner, number);
    console.log(`board items: ${board.items.length} over ${board.pages} page(s)`);
  } else {
    const [one] = restLines(`repos/${repo}/issues/${issueNo}`,
      '{number, url: .html_url, state, pr: has("pull_request"), labels: [.labels[].name]} | tojson', env.REPO_TOKEN);
    if (one.pr || one.state !== 'open') {
      console.log(`#${issueNo} is ${one.pr ? 'a pull request' : 'closed'}; nothing to mirror`);
      return 0;
    }
    issues = [{ number: one.number, url: one.url, labels: one.labels }];
    const [repoOwner, repoName] = repo.split('/');
    const res = await gql(ISSUE_ITEM_QUERY, { owner, number, repoOwner, repoName, issue: issueNo });
    const proj = res?.data?.user?.projectV2;
    const iss = res?.data?.repository?.issue;
    if (!proj || !iss) throw new Error('board or issue not readable');
    const node = (iss.projectItems?.nodes ?? []).find((n) => n.project?.id === proj.id);
    board = {
      projectId: proj.id,
      fields: fieldsFromNodes(proj.fields?.nodes),
      items: node ? [itemFromNode(node, { type: 'Issue', url: iss.url, repo, state: iss.state, number: iss.number })] : [],
      pages: 1,
    };
  }

  const plan = planWrites(issues, board.items, board.fields, { repo, threadValues });
  const todo = plan.writes.slice(0, maxWrites);
  const deferred = plan.writes.length - todo.length;
  let written = 0;
  let failed = 0;
  let fatal = null;
  if (!dryRun) {
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        const { query, variables } = mutationFor(board.projectId, batch);
        await gql(query, variables);
        written += batch.length;
      } catch (e) {
        failed += todo.length - i;
        fatal = e;
        break; // a failed write does not get followed by more of the same
      }
      if (i + BATCH < todo.length) await deps.sleep(BATCH_PAUSE_SECONDS);
    }
  }

  const summary = renderSummary(plan, {
    mode: issueNo === null ? 'scheduled reconcile' : `label event on #${issueNo}`,
    dryRun, issues: issues.length, boardItems: board.items.length,
    written, failed, deferred: dryRun ? 0 : deferred, calls: stats.calls, waits: stats.waits,
  });
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (deferred && !dryRun) console.log(`::warning::${deferred} write(s) over MAX_WRITES=${maxWrites} left for the next run`);
  if (plan.missingFields.length || Object.keys(plan.missingOptions).length) {
    console.log('::notice::board fields or options are missing — see the job summary for what to add');
  }
  if (fatal) {
    console.log('::group::failed request — status, rate-limit headers, error message');
    console.log(fatal.evidence || '(nothing recognised in the trace; it is not printed because it carries board contents)');
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
      console.log(e.evidence || '(nothing recognised in the trace; it is not printed because it carries board contents)');
      console.log('::endgroup::');
    }
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
