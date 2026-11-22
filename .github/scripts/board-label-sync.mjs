#!/usr/bin/env node
/**
 * Mirror `priority:*`, `stage:*` and `thread:*` issue labels onto the issue
 * fields `Priority`, `Stage` and `Thread`, the account-level issue fields the
 * `@vaipakam-labs` board views group by; and fill the two DATE issue fields
 * `Start date` and `Target date` from each issue's and pull request's own
 * history (`DATE_FIELDS` states the rules).
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
 *   - The issue TIMELINE, REST, for an issue's Start date only:
 *       GET /repos/{o}/{r}/issues/{n}/timeline (100 events a page, oldest
 *       first). Read only for an issue that needs it (`timelineReason`), at
 *       most MAX_TIMELINE_READS requests a run, and never cached: once a
 *       Start date is written the issue needs no timeline again (apart from
 *       the bounded recheck `timelineReason` describes).
 *       https://docs.github.com/en/rest/issues/timeline
 *     A date value is written as an ISO 8601 date string ("2026-11-22") and
 *     reads back as `{data_type: "date", value: "2026-11-22"}`.
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
 * report line from plain data, with no I/O; `timelineFacts`, `timelineReason`,
 * `timelineQueue` and `selectWrites` likewise. They are what the self-test pins
 * (`board-label-sync.selftest.mjs`). `listIssueFields` pages the definitions
 * through an injected GraphQL transport, so its pagination is pinned there
 * too. Only the transport (`gh` under `GH_DEBUG=api`) and the paginated REST
 * reads touch the network.
 *
 * Usage (the workflow sets every variable):
 *   node .github/scripts/board-label-sync.mjs              # reconcile every issue and pull request
 *   node .github/scripts/board-label-sync.mjs --issue 123  # one item (a label, close or reopen event)
 *
 *   ISSUE_REPO    owner/name: the only repository read or written
 *   GH_TOKEN      the Actions token (`issues: write`)
 *   DRY_RUN=true  plan and report, write nothing
 *   MAX_WRITES    the most field writes one run makes (default 300)
 *   MAX_TIMELINE_READS   the most timeline requests one run makes (default 100)
 *   START_RECHECK_HOURS  how recently an issue must have changed for a Start
 *                 date equal to its creation day to be re-derived (default 2)
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

/**
 * The two DATE issue fields (owner rules 2026-11-22). Unlike the label
 * families they are derived from the item's own history, not from a label,
 * and they reach CLOSED issues and PULL REQUESTS as well as open issues.
 *
 *   Start date  — when work began. A pull request: its `created_at`. An
 *                 issue: the earliest of (a) the `created_at` of a pull
 *                 request linked to it (a `cross-referenced` timeline event
 *                 whose source is a pull request — a closing PR produces one
 *                 too) and (b) the first time `stage:building` was applied
 *                 (a `labeled` timeline event); with neither, the issue's
 *                 own `created_at`. Never cleared.
 *   Target date — a closed issue or pull request: its `closed_at` (for a
 *                 merged pull request, the merge). An open item: never
 *                 invented, and a value set by hand is left alone; the one
 *                 exception is a reopened item whose value equals the date
 *                 it was last closed — a value this job wrote — which is
 *                 cleared.
 *
 * Every date is the UTC calendar day, YYYY-MM-DD, the form the REST
 * endpoint documents for a date field.
 */
export const DATE_FIELDS = [
  { key: 'start', field: 'Start date', dataType: 'DATE' },
  { key: 'target', field: 'Target date', dataType: 'DATE' },
];

/**
 * How far a recorded close may sit from the `closed` timeline event. Measured
 * on #3836: `closed_at` 23:02:17, the event 23:02:18. Across midnight that one
 * second changes the day, so the event's day AND the day a few seconds before
 * it both count as "the date it was closed".
 */
export const CLOSE_EVENT_SKEW_MS = 5000;


// ── the date rules (pure) ───────────────────────────────────────────────────

/** The UTC calendar day of a timestamp (ISO string or epoch ms), or null. */
export function utcDay(t) {
  if (t == null || t === '') return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A date field's current value as YYYY-MM-DD, or null. A value that is not
 *  a date is kept as-is, so it compares unequal and is overwritten only where
 *  the rules would overwrite any value. */
export function fieldDay(text) {
  if (text == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(text).trim());
  return m ? m[1] : String(text);
}

/**
 * What an issue's timeline says about its dates. `events` is the timeline in
 * the order GitHub returns it (oldest first). `complete` is false when the
 * read stopped before the last page: the earliest events are all present, but
 * the latest close may not be, so `lastClosedAt` is then unknown (null) and
 * nothing is cleared on its account.
 *
 * Counted: `cross-referenced` events whose source is a pull request (any
 * repository; `source.issue.pull_request` present), by THAT pull request's
 * `created_at` — not the event's time, because a pull request opened earlier
 * can mention the issue later (#3836: its first linked PR, #3806, predates the
 * issue itself) — and `labeled` events for `stage:building`. A `connected`
 * event (a PR linked in the sidebar) carries no pull request in REST, so it is
 * not counted; the closing PR's own cross-reference is.
 */
export function timelineFacts(events, { complete = true } = {}) {
  const prDays = [];
  let firstBuilding = null;
  let lastClosedAt = null;
  for (const e of events ?? []) {
    if (!e || typeof e !== 'object') continue;
    if (e.event === 'cross-referenced' && e.source?.issue?.pull_request && e.source.issue.created_at) {
      const d = utcDay(e.source.issue.created_at);
      if (d) prDays.push(d);
    } else if (e.event === 'labeled' && lc(e.label?.name) === 'stage:building') {
      const d = utcDay(e.created_at);
      if (d && (firstBuilding === null || d < firstBuilding)) firstBuilding = d;
    } else if (e.event === 'closed' && e.created_at) {
      lastClosedAt = e.created_at;
    }
  }
  prDays.sort();
  return { firstPr: prDays[0] ?? null, firstBuilding, lastClosedAt: complete ? lastClosedAt : null, complete };
}

/** The Start date the rules give. A pull request needs no timeline; an issue
 *  needs its `facts` (null → unknown, return null). */
export function chooseStartDate(item, facts) {
  if (item.isPr) return utcDay(item.createdAt);
  if (!facts) return null;
  const candidates = [facts.firstPr, facts.firstBuilding].filter(Boolean).sort();
  return candidates[0] ?? utcDay(item.createdAt);
}

/** Whether a Target date equals the day the item was closed at `closedAt`
 *  (that day, or the day CLOSE_EVENT_SKEW_MS before it). */
export function isCloseDay(day, closedAt) {
  if (!day || !closedAt) return false;
  const t = new Date(closedAt).getTime();
  if (Number.isNaN(t)) return false;
  return day === utcDay(t) || day === utcDay(t - CLOSE_EVENT_SKEW_MS);
}

function resolveField(fields, spec) {
  return fields.find((x) => lc(x.name) === lc(spec.field) && x.dataType === spec.dataType) ?? null;
}

function currentValue(item, field) {
  if (!field) return null;
  const cur = (item.values ?? []).find((x) => (x.fieldId != null ? x.fieldId === field.dbId : lc(x.fieldName) === lc(field.name)));
  return cur?.text ?? null;
}

/**
 * Why an item needs its timeline read this run, or null. Only issues ever
 * need one; a pull request's dates come from the listing.
 *
 *   'fill'    — no Start date yet. Once one is written this never recurs.
 *   'recheck' — the Start date equals the issue's own creation day, which is
 *               what the fallback writes, AND the issue changed within the
 *               last `recheckHours` (`updated_at`): a pull request or a
 *               `stage:building` label since may have moved it. Open issues
 *               only on the sweep (a close arrives as an event, which
 *               rechecks whatever the state); any state on an event pass.
 *   'reopen'  — an open item with a Target date, no `closed_at`, changed
 *               within the window: it may have been reopened, and the old
 *               close date is only in the timeline.
 *
 * A field that does not exist creates no need: nothing is read for a field
 * nothing could be written to.
 */
export function timelineReason(item, fields, ctx = {}) {
  if (item.isPr || item.values == null) return null;
  const start = resolveField(fields, DATE_FIELDS[0]);
  const target = resolveField(fields, DATE_FIELDS[1]);
  const now = ctx.now ?? Date.now();
  const windowMs = (ctx.recheckHours ?? 2) * 3600 * 1000;
  const updated = new Date(item.updatedAt ?? 0).getTime();
  const recent = Number.isFinite(updated) && updated >= now - windowMs;
  const open = lc(item.state) === 'open';
  if (start) {
    const curStart = fieldDay(currentValue(item, start));
    if (curStart === null) return 'fill';
    if (recent && (open || ctx.eventMode) && curStart === utcDay(item.createdAt)) return 'recheck';
  }
  if (target && open && recent && !item.closedAt && currentValue(item, target) !== null) return 'reopen';
  return null;
}

/**
 * Order the items that need a timeline read: rechecks and reopen checks first
 * (their window closes), then fills; open before closed; newest first. The
 * caller reads in this order until MAX_TIMELINE_READS requests are spent.
 */
export function timelineQueue(items, fields, ctx = {}) {
  const rank = { recheck: 0, reopen: 0, fill: 1 };
  return items
    .map((it) => ({ number: it.number, reason: timelineReason(it, fields, ctx), open: lc(it.state) === 'open' }))
    .filter((x) => x.reason)
    .sort((a, b) => rank[a.reason] - rank[b.reason] || Number(b.open) - Number(a.open) || b.number - a.number);
}

// ── the planner (pure) ──────────────────────────────────────────────────────

/**
 * Decide every field write for the given items.
 *
 * @param {Array<{number:number, state?:string, isPr?:boolean, labels:string[],
 *                values:Array<{fieldId:number|null, fieldName:string, text:string|null}>|null,
 *                createdAt?:string, closedAt?:string|null, updatedAt?:string,
 *                facts?:object}>} issues
 *   Issues and pull requests of this repository with their label names, their
 *   current field values (`valuesFromRest`; null when unreadable — a pull
 *   request only, see `main`) and, for an issue whose timeline was read this
 *   run, its `timelineFacts`. The label families apply to OPEN ISSUES only;
 *   the two dates to every item.
 * @param {Array<{dbId:number, name:string, dataType:string, options?:Array<{name:string}>}>} fields
 *   The issue fields available to the repository (`listIssueFields`).
 * @param {{threadValues?:string[], now?:number, recheckHours?:number, eventMode?:boolean}} context
 *   `threadValues` lists every `thread:` suffix defined in the repository — a
 *   Thread value counts as one the sync would have written only when it is in
 *   this list (see the clearing rule below). `now`, `recheckHours` and
 *   `eventMode` feed `timelineReason`.
 * @returns {{writes:Array<object>, conflicts:Array<object>, unrecognised:Array<object>,
 *            missingFields:Array<{field:string, dataType:string}>,
 *            missingOptions:Record<string,string[]>, notOpen:number[], prs:number,
 *            awaitingTimeline:Record<string,number>, valuesUnknown:number[]}}
 */
export function planWrites(issues, fields, context = {}) {
  const threadValues = new Set((context.threadValues ?? []).map(lc));

  // Resolve each field by NAME and TYPE. A field of the wrong type is treated
  // as absent: writing an option name into a text field (or the reverse)
  // would put the wrong kind of value on every issue.
  const resolved = {};
  const missingFields = [];
  for (const fam of [...FAMILIES, ...DATE_FIELDS]) {
    const f = resolveField(fields, fam);
    if (f) resolved[fam.key] = f;
    else missingFields.push({ field: fam.field, dataType: fam.dataType });
  }

  const writes = [];
  const conflicts = [];
  const unrecognised = [];
  const missingOptions = {};
  const notOpen = [];
  const awaitingTimeline = {};
  const valuesUnknown = [];
  let prs = 0;

  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    if (issue.isPr) prs += 1;
    planDates(issue);

    // The label families: open ISSUES only, as before. A closed issue or a
    // pull request gets its dates and nothing else.
    if (issue.isPr) continue;
    if (issue.state !== undefined && lc(issue.state) !== 'open') {
      notOpen.push(issue.number);
      continue;
    }
    if (issue.values == null) { valuesUnknown.push(issue.number); continue; }

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
      const current = currentValue(issue, field);

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

  /** The two dates for one item. An item whose timeline is needed but was not
   *  read this run (the MAX_TIMELINE_READS cap) gets NO date write — not even
   *  a Target date it could have had — so each item is written once, in one
   *  request, rather than once per field across runs: every write notifies the
   *  item's subscribers. */
  function planDates(item) {
    const start = resolved.start;
    const target = resolved.target;
    if (!start && !target) return;
    if (item.values == null) {
      if (item.isPr) valuesUnknown.push(item.number);
      return;
    }
    const reason = timelineReason(item, fields, context);
    if (reason && !item.facts) {
      awaitingTimeline[reason] = (awaitingTimeline[reason] ?? 0) + 1;
      return;
    }
    const pending = [];
    if (start) {
      const cur = currentValue(item, start);
      // An issue's Start date is derived only while it is empty or still the
      // creation-day fallback; any other value is final (a timeline read for
      // a reopen check must not re-derive it). A pull request's always is.
      const curDay = fieldDay(cur);
      const derivable = item.isPr || curDay === null || curDay === utcDay(item.createdAt);
      const want = derivable ? chooseStartDate(item, item.facts ?? null) : null;
      // No facts and no need for them: the value stands as written.
      if (want !== null && fieldDay(cur) !== want) {
        pending.push({ action: 'set', issue: item.number, field: start.name, fieldId: start.dbId, value: want, from: cur, date: true });
      }
    }
    if (target) {
      const cur = currentValue(item, target);
      if (lc(item.state) !== 'open') {
        const want = utcDay(item.closedAt);
        if (want !== null && fieldDay(cur) !== want) {
          pending.push({ action: 'set', issue: item.number, field: target.name, fieldId: target.dbId, value: want, from: cur, date: true });
        }
      } else if (cur !== null) {
        // Open with a value: a hand-set date stays. Only the date the item
        // was last closed — what this job wrote before a reopen — is cleared.
        const lastClosed = item.closedAt ?? item.facts?.lastClosedAt ?? null;
        if (isCloseDay(fieldDay(cur), lastClosed)) {
          pending.push({ action: 'clear', issue: item.number, field: target.name, fieldId: target.dbId, value: null, from: cur, date: true });
        }
      }
    }
    writes.push(...pending);
  }

  for (const k of Object.keys(missingOptions)) missingOptions[k].sort();
  return { writes, conflicts, unrecognised, missingFields, missingOptions, notOpen, prs, awaitingTimeline, valuesUnknown };
}

/**
 * Pick the writes one run makes under MAX_WRITES. Label writes first, in plan
 * order — they are what the label event exists to show quickly. Then the date
 * writes, one item at a time and never split (an item's dates go in one
 * request): first the items whose timeline was read THIS run, so no read is
 * wasted (nothing is cached; a deferred item is read again next time), then
 * open before closed, newest first. The first item that does not fit ends the
 * selection, so the order stays predictable.
 */
export function selectWrites(writes, maxWrites, items = []) {
  const byNo = new Map(items.map((it) => [it.number, it]));
  const label = writes.filter((w) => !w.date);
  const groups = new Map();
  for (const w of writes.filter((x) => x.date)) groups.set(w.issue, [...(groups.get(w.issue) ?? []), w]);
  const order = [...groups.keys()].sort((a, b) => {
    const A = byNo.get(a) ?? {};
    const B = byNo.get(b) ?? {};
    return Number(Boolean(B.facts)) - Number(Boolean(A.facts))
      || Number(lc(B.state) === 'open') - Number(lc(A.state) === 'open')
      || b - a;
  });
  const todo = label.slice(0, maxWrites);
  for (const n of order) {
    const g = groups.get(n);
    if (todo.length + g.length > maxWrites) break;
    todo.push(...g);
  }
  return { todo, deferred: writes.length - todo.length };
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
  /** A REST read (the timeline), under the same rule; no API-version pin:
   *  the timeline is not one of the endpoints that header was chosen for. */
  const get = (path) => call(['api', path], undefined, `GET ${path.replace(/^repos\/[^/]+\/[^/]+\//, '').replace(/\?.*$/, '')}`);
  return { gql, rest, get, stats };
}

/** Timeline events come 100 a page; one issue's read stops after this many
 *  pages and its facts are marked incomplete (see `timelineFacts`). */
export const TIMELINE_PAGE_CAP = 10;

/**
 * Read the timelines the queue asks for, oldest event first, spending at most
 * `maxReads` requests in all. An item whose read the budget cuts off part-way
 * gets no facts — it is planned as still awaiting its timeline, never from a
 * partial history. `get(path)` is the transport's REST read.
 *
 * @returns {Promise<{facts: Map<number, object>, reads: number}>}
 */
export async function readTimelines(get, repo, queue, maxReads) {
  const facts = new Map();
  let reads = 0;
  for (const { number } of queue) {
    if (reads >= maxReads) break;
    const events = [];
    let complete = false;
    let cut = false;
    for (let page = 1; page <= TIMELINE_PAGE_CAP; page += 1) {
      if (reads >= maxReads) { cut = true; break; }
      reads += 1;
      const batch = await get(`repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`timeline of #${number} did not read as a list`);
      events.push(...batch);
      if (batch.length < 100) { complete = true; break; }
    }
    if (cut) break;
    facts.set(number, timelineFacts(events, { complete }));
  }
  return { facts, reads };
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
  lines.push(`- items read: ${outcome.issues} (pull requests among them: ${plan.prs ?? 0})`);
  lines.push(`- field writes planned: ${plan.writes.length}; made: ${outcome.written}; deferred to the next run by MAX_WRITES: ${outcome.deferred}`);
  if (outcome.failed) lines.push(`- writes not confirmed (the next run re-plans them): ${outcome.failed}`);
  lines.push(`- API requests through the rate-limit rule: ${outcome.calls}${outcome.waits ? ', after one rate-limit wait' : ''}`);
  if (outcome.timelineReads !== undefined) {
    const waiting = Object.entries(plan.awaitingTimeline ?? {});
    const total = waiting.reduce((a, [, n]) => a + n, 0);
    lines.push(`- timeline reads: ${outcome.timelineReads} of MAX_TIMELINE_READS=${outcome.maxTimelineReads}; items still awaiting one (their dates wait for it): ${total}${
      total ? ` (${waiting.map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
  }
  if (plan.notOpen.length) {
    lines.push(`- closed issues (dates only; the label rules apply to open issues): ${plan.notOpen.length}`);
  }
  if (plan.valuesUnknown?.length) {
    lines.push(`- items read without issue_field_values, skipped: ${plan.valuesUnknown.slice(0, 50).map((n) => `#${n}`).join(', ')}${plan.valuesUnknown.length > 50 ? ' …' : ''}`);
  }
  const todo = [];
  for (const { field, dataType } of plan.missingFields) {
    const hint = field === 'Priority' ? 'single select, options P1, P2, P3, P4, P5'
      : field === 'Stage' ? `single select, options ${STAGES.join(', ')} (any capitalisation)`
        : dataType === 'DATE' ? 'date'
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

const ISSUE_JQ = '{number, state, pr: has("pull_request"), labels: [.labels[].name], ifv: .issue_field_values, created_at, closed_at, updated_at} | tojson';

/** A listing row as a planner item. An ISSUE read without
 *  `issue_field_values` aborts the run (`valuesFromRest`); a PULL REQUEST
 *  without it is kept with unknown values and skipped, since whether pull
 *  requests carry the key is not something the docs promise. */
export function itemFromRow(r) {
  let values;
  if (r.pr && !Array.isArray(r.ifv)) values = null;
  else values = valuesFromRest(r.ifv, r.number);
  return {
    number: r.number, state: r.state, isPr: Boolean(r.pr), labels: r.labels, values,
    createdAt: r.created_at, closedAt: r.closed_at ?? null, updatedAt: r.updated_at,
  };
}

const envInt = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));

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
  const maxWrites = envInt(env.MAX_WRITES, 300);
  const maxTimelineReads = envInt(env.MAX_TIMELINE_READS, 100);
  const recheckHours = envInt(env.START_RECHECK_HOURS, 2);
  for (const [k, v] of [['MAX_WRITES', maxWrites], ['MAX_TIMELINE_READS', maxTimelineReads], ['START_RECHECK_HOURS', recheckHours]]) {
    if (!Number.isInteger(v) || v < 0) { console.error(`::error::${k} must be a whole number`); return 2; }
  }
  const deps = realDeps();
  const { gql, rest, get, stats } = makeGhTransport(deps, {
    waitCap: Number(env.RETRY_WAIT_CAP_SECONDS || '900'),
    margin: Number(env.RETRY_MARGIN_SECONDS || '5'),
  });

  // Every `thread:` label the repository defines — what decides whether a
  // Thread value on an issue is one this sync would have written.
  const threadValues = restLines(`repos/${repo}/labels?per_page=100`, '.[].name | select(startswith("thread:")) | tojson')
    .map((n) => n.slice('thread:'.length));

  // Every issue AND pull request, open and closed: the dates reach all of
  // them. A pull request is in this listing too (its `pull_request` key).
  const rows = issueNo === null
    ? restLines(`repos/${repo}/issues?state=all&per_page=100`, `.[] | ${ISSUE_JQ}`)
    : restLines(`repos/${repo}/issues/${issueNo}`, ISSUE_JQ);
  const items = rows.map(itemFromRow);
  console.log(`items: ${items.length}`);

  const { fields, pages } = await listIssueFields(gql, repo);
  console.log(`issue fields: ${fields.length} over ${pages} page(s)`);

  const ctx = { threadValues, now: Date.now(), recheckHours, eventMode: issueNo !== null };
  const queue = timelineQueue(items, fields, ctx);
  const { facts, reads } = await readTimelines(get, repo, queue, maxTimelineReads);
  for (const it of items) if (facts.has(it.number)) it.facts = facts.get(it.number);
  console.log(`timelines: ${facts.size} read in ${reads} request(s); ${queue.length - facts.size} left for later runs`);

  const plan = planWrites(items, fields, ctx);
  const { todo, deferred } = selectWrites(plan.writes, maxWrites, items);
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
    mode: issueNo === null ? 'scheduled reconcile' : `event on #${issueNo}`,
    dryRun, issues: items.length,
    written, failed, deferred: dryRun ? 0 : deferred, calls: stats.calls, waits: stats.waits,
    timelineReads: reads, maxTimelineReads,
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
