#!/usr/bin/env node
/**
 * Fixtures for `board-label-sync.mjs`: the planner, the REST value parsing,
 * the issue-field definition pagination, the write requests, the rate-limit
 * rule of the transport, and the summary. No network and no token: the
 * planner is pure, the field listing and the transport take injected
 * functions, and the rate-limit classification runs the REAL
 * `gh-trace-ratelimit-wait.sh` against fixture traces.
 *
 * Run: `node .github/scripts/board-label-sync.selftest.mjs`
 */
import {
  classifyTrace, listIssueFields, makeGhTransport, planWrites, renderSummary, requestsFor, traceEvidence, valuesFromRest,
  FIELD_VALUES_API_VERSION,
} from './board-label-sync.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes += 1; console.log(`  ok    ${name}`); }
  else { failures += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const REPO = 'vaipakam/vaipakam';

// The live shape (read 2026-11-22): Thread is TEXT, Priority and Stage are
// single selects, and Stage's options are capitalised.
const FIELDS = [
  { dbId: 10, name: 'Thread', dataType: 'TEXT' },
  { dbId: 20, name: 'priority', dataType: 'SINGLE_SELECT', options: [
    { name: 'P1' }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }, { name: 'P5' },
  ] },
  { dbId: 30, name: 'Stage', dataType: 'SINGLE_SELECT', options: [
    { name: 'Building' }, { name: 'Held-for-Batch' }, { name: 'Queued' }, { name: 'Blocked' },
  ] },
  { dbId: 40, name: 'Effort', dataType: 'SINGLE_SELECT', options: [{ name: 'Large' }] },
];
const CTX = { threadValues: ['issues-plan', 'keeper', 'app-fixes'] };
const val = (fieldId, text) => ({ fieldId, fieldName: '', text });
const iss = (number, labels, values = [], extra = {}) => ({ number, state: 'open', labels, values, ...extra });
const writesFor = (plan, n) => plan.writes.filter((w) => w.issue === n);

console.log('planner');
{
  const issues = [
    iss(1, ['priority:p1', 'stage:building', 'thread:keeper', 'bug']),
    iss(2, ['priority:p2', 'stage:queued', 'thread:issues-plan'], [val(20, 'P1'), val(30, 'Queued'), val(10, 'issues-plan')]),
    iss(3, ['enhancement'], [val(20, 'P3'), val(30, 'Blocked'), val(10, 'legacy'), val(40, 'Large')]),
    iss(4, ['priority:p1', 'priority:p3'], [val(20, 'P2')]),
    iss(5, ['stage:waiting-on-owner', 'thread:app-fixes']),
    iss(6, ['priority:p9', 'stage:nonsense'], [val(20, 'P4')]),
    iss(8, ['priority:p1'], [], { state: 'closed' }),
    iss(11, ['PRIORITY:P5'], [val(20, 'P5')]),
    iss(12, ['stage:held-for-batch', 'thread:Keeper-Desk'], [val(30, 'building')]),
    iss(13, [], [val(30, 'held-for-batch'), val(10, 'KEEPER')]),
    iss(14, ['thread:keeper'], [val(10, 'Keeper')]),
  ];
  const plan = planWrites(issues, FIELDS, CTX);

  check('labels added: three sets on an issue with no values', same(
    writesFor(plan, 1).map((w) => [w.action, w.field, w.fieldId, w.value]),
    [['set', 'Priority', 20, 'P1'], ['set', 'Stage', 30, 'Building'], ['set', 'Thread', 10, 'keeper']],
  ), JSON.stringify(writesFor(plan, 1)));
  check('label changed: P1 → P2, and only that field', same(
    writesFor(plan, 2).map((w) => [w.action, w.field, w.value, w.from]),
    [['set', 'Priority', 'P2', 'P1']],
  ), JSON.stringify(writesFor(plan, 2)));
  check('labels removed: a known Priority value is cleared', writesFor(plan, 3).some(
    (w) => w.action === 'clear' && w.field === 'Priority' && w.from === 'P3' && w.fieldId === 20));
  check('labels removed: a Stage value the sync never writes is left alone',
    !writesFor(plan, 3).some((w) => w.field === 'Stage'));
  check('labels removed: a Thread value that is no thread: label is left alone',
    !writesFor(plan, 3).some((w) => w.field === 'Thread'));
  check('a field the sync does not own (Effort) is never written', !plan.writes.some((w) => w.fieldId === 40));
  check('two labels of one family: no write for that family', writesFor(plan, 4).length === 0,
    JSON.stringify(writesFor(plan, 4)));
  check('two labels of one family: the conflict is reported', same(plan.conflicts,
    [{ issue: 4, family: 'priority', labels: ['priority:p1', 'priority:p3'] }]), JSON.stringify(plan.conflicts));
  check('missing option: no Stage write, and the option is listed to add; Thread is text and needs none',
    same(writesFor(plan, 5).map((w) => [w.field, w.value]), [['Thread', 'app-fixes']]) &&
    same(plan.missingOptions, { Stage: ['waiting-on-owner'] }), JSON.stringify([writesFor(plan, 5), plan.missingOptions]));
  check('unrecognised labels are reported and ignored', same(
    plan.unrecognised.map((u) => u.label), ['priority:p9', 'stage:nonsense']));
  check('an unrecognised priority label does not set the field', !writesFor(plan, 6).some((w) => w.action === 'set'));
  check('a closed issue is never written, and is reported', !plan.writes.some((w) => w.issue === 8) && same(plan.notOpen, [8]));
  check('case is ignored in labels: PRIORITY:P5 matches the value P5', writesFor(plan, 11).length === 0,
    JSON.stringify(writesFor(plan, 11)));
  check('options match case-insensitively: stage:held-for-batch writes the option name Held-for-Batch, over `building`',
    same(writesFor(plan, 12).filter((w) => w.field === 'Stage').map((w) => [w.action, w.value, w.from]),
      [['set', 'Held-for-Batch', 'building']]), JSON.stringify(writesFor(plan, 12)));
  check('a thread suffix is written as the label has it', same(
    writesFor(plan, 12).filter((w) => w.field === 'Thread').map((w) => w.value), ['Keeper-Desk']));
  check('an owned value in another case is still recognised for clearing', same(
    writesFor(plan, 13).map((w) => [w.action, w.field]), [['clear', 'Stage'], ['clear', 'Thread']]),
  JSON.stringify(writesFor(plan, 13)));
  check('a Thread value in another case than the label is rewritten as-is', same(
    writesFor(plan, 14).map((w) => [w.action, w.value, w.from]), [['set', 'keeper', 'Keeper']]));
}

{
  const plan = planWrites(
    [iss(1, ['priority:p1', 'stage:queued', 'thread:keeper'])],
    FIELDS.filter((f) => f.name !== 'Stage' && f.name !== 'Thread')
      .concat([{ dbId: 11, name: 'Thread', dataType: 'SINGLE_SELECT', options: [{ name: 'keeper' }] }]),
    CTX,
  );
  check('missing field (or wrong type): listed, its writes skipped, the run carries on', same(
    plan.missingFields.map((f) => f.field), ['Stage', 'Thread']) &&
    same(plan.writes.map((w) => w.field), ['Priority']), JSON.stringify(plan));
}
{
  const plan = planWrites([iss(1, [], [val(10, 'keeper')])], FIELDS, {});
  check('without the repository\'s thread list, no Thread value is cleared', plan.writes.length === 0);
}
{
  const plan = planWrites([iss(1, ['thread:keeper', 'priority:p2'], [val(10, 'keeper'), val(20, 'P2')])], FIELDS, CTX);
  check('an issue already in sync gets no writes', plan.writes.length === 0);
}
{
  const plan = planWrites([iss(1, ['priority:p2'], [{ fieldId: null, fieldName: 'Priority', text: 'P2' }])], FIELDS, CTX);
  check('a value with no field id is matched by field name', plan.writes.length === 0, JSON.stringify(plan.writes));
}

console.log('REST values');
{
  const parsed = valuesFromRest([
    { issue_field_id: 10, issue_field_name: 'Thread', data_type: 'text', value: 'keeper' },
    { issue_field_id: 20, issue_field_name: 'Priority', data_type: 'single_select', value: 7, single_select_option: { id: 7, name: 'P2', color: 'GRAY' } },
  ], 1);
  check('a text value is its string; a single select is its option NAME, not the id in `value`', same(parsed,
    [{ fieldId: 10, fieldName: 'Thread', text: 'keeper' }, { fieldId: 20, fieldName: 'Priority', text: 'P2' }]), JSON.stringify(parsed));
  let threw = '';
  try { valuesFromRest(undefined, 42); } catch (e) { threw = e.message; }
  check('an issue read without issue_field_values aborts instead of planning from "none"', /#42/.test(threw), threw);
}

console.log('field definitions');
{
  const pages = [
    { cursor: 'c1', next: true, nodes: [{}, { name: 'Thread', dataType: 'TEXT', fullDatabaseId: '50243880' }] },
    { cursor: 'c2', next: false, nodes: [{ name: 'Stage', dataType: 'SINGLE_SELECT', fullDatabaseId: '50243938', options: [{ name: 'Queued' }] }] },
  ];
  const seen = [];
  const gql = async (_q, vars) => {
    seen.push(vars);
    const p = pages[seen.length - 1];
    return { data: { repository: { issueFields: { pageInfo: { hasNextPage: p.next, endCursor: p.cursor }, nodes: p.nodes } } } };
  };
  const { fields, pages: n } = await listIssueFields(gql, REPO);
  check('every page is read, in order, for the right repository', n === 2 && same(seen.map((s) => [s.owner, s.name, s.after]),
    [['vaipakam', 'vaipakam', null], ['vaipakam', 'vaipakam', 'c1']]), JSON.stringify(seen));
  check('fullDatabaseId becomes the numeric field id; empty nodes are dropped', same(fields, [
    { dbId: 50243880, name: 'Thread', dataType: 'TEXT' },
    { dbId: 50243938, name: 'Stage', dataType: 'SINGLE_SELECT', options: [{ name: 'Queued' }] },
  ]), JSON.stringify(fields));
  let threw = '';
  try { await listIssueFields(async () => ({ data: { repository: null }, errors: [{ message: 'Resource not accessible by integration' }] }), REPO); }
  catch (e) { threw = e.message; }
  check('an unreadable definition list aborts, naming the error', /not readable: Resource not accessible/.test(threw), threw);
}

console.log('write requests');
{
  const reqs = requestsFor(REPO, 7, [
    { action: 'set', fieldId: 20, value: 'P1' },
    { action: 'clear', fieldId: 30, value: null },
    { action: 'set', fieldId: 10, value: 'keeper' },
  ]);
  check('all sets for an issue go in ONE add request, values in the body', same(reqs[0], {
    method: 'POST', path: `repos/${REPO}/issues/7/issue-field-values`,
    body: { issue_field_values: [{ field_id: 20, value: 'P1' }, { field_id: 10, value: 'keeper' }] }, writes: 2,
  }), JSON.stringify(reqs[0]));
  check('each clear is a DELETE of that field id, never a PUT', same(reqs.slice(1), [
    { method: 'DELETE', path: `repos/${REPO}/issues/7/issue-field-values/30`, body: null, writes: 1 },
  ]) && !reqs.some((r) => r.method === 'PUT'));
}
{
  const calls = [];
  const t = makeGhTransport({
    run: (args, input) => { calls.push([args, input]); return { status: 0, stdout: '' }; },
    classify: () => ({ rc: 1, stdout: '' }), sleep: async () => {}, log: () => {},
  });
  const r = await t.rest('DELETE', `repos/${REPO}/issues/7/issue-field-values/30`, null);
  await t.rest('POST', `repos/${REPO}/issues/7/issue-field-values`, { issue_field_values: [] });
  check('an empty 204 body reads as null, not a parse error', r === null);
  check('the REST call pins the documented API version and sends a body only when there is one', same(calls[0][0],
    ['api', '--method', 'DELETE', `repos/${REPO}/issues/7/issue-field-values/30`, '-H', `X-GitHub-Api-Version: ${FIELD_VALUES_API_VERSION}`]) &&
    calls[0][1] === undefined && calls[1][0].includes('--input') && calls[1][1] === '{"issue_field_values":[]}', JSON.stringify(calls));
}

console.log('rate-limit rule');
{
  const now = Math.floor(Date.now() / 1000);
  const limited = (reset) => [
    '> POST /graphql HTTP/1.1',
    '< HTTP/2.0 200 OK',
    '< X-Ratelimit-Remaining: 0',
    `< X-Ratelimit-Reset: ${reset}`,
    '< Authorization: token ghp_abcdefghijklmnopqrstuvwxyz',
    '{"data":{"title":"secret issue title"},"message":"API rate limit already exceeded for user ID 1."}',
  ].join('\n');
  const c = classifyTrace(limited(now + 120));
  const secs = Number(c.stdout.split('\t')[0]);
  check('the real parser recognises the observed GraphQL shape', c.rc === 0 && secs >= 115 && secs <= 120, JSON.stringify(c));
  const restLimited = [
    '> POST /repos/vaipakam/vaipakam/issues/7/issue-field-values HTTP/1.1',
    '< HTTP/2.0 403 Forbidden',
    '< X-Ratelimit-Remaining: 0',
    `< X-Ratelimit-Reset: ${now + 60}`,
    '{"message":"API rate limit exceeded for installation ID 1.","documentation_url":"https://docs.github.com/rest"}',
  ].join('\n');
  check('the real parser recognises the REST primary-limit shape', classifyTrace(restLimited).rc === 0);
  check('the real parser refuses a 401', classifyTrace('< HTTP/2.0 401 Unauthorized\n{"message":"Bad credentials"}').rc === 1);
  check('the real parser reports an unreadable trace', classifyTrace('no status line here').rc === 2);

  const ev = traceEvidence(limited(now + 60));
  check('evidence keeps the status, headers and message', /HTTP\/2.0 200/.test(ev) && /X-Ratelimit-Remaining: 0/.test(ev) &&
    /API rate limit already exceeded/.test(ev));
  check('evidence drops response bodies and redacts tokens', !ev.includes('secret issue title') && !ev.includes('ghp_abc'));

  // A scripted transport: each entry is one `gh` outcome.
  const drive = async (script, opts = {}) => {
    const log = [];
    const sleeps = [];
    let i = 0;
    const t = makeGhTransport({
      run: () => script[i++] ?? { status: 0, stdout: '{"data":{}}' },
      classify: (trace) => ({ unlimited: { rc: 1, stdout: '' }, unreadable: { rc: 2, stdout: '' } }[trace]
        ?? { rc: 0, stdout: `${trace}\treset soon` }),
      sleep: async (s) => { sleeps.push(s); },
      log: (l) => log.push(l),
    }, { waitCap: 900, margin: 5, ...opts });
    const results = [];
    for (let k = 0; k < (opts.requests ?? 1); k += 1) {
      try {
        if (k % 2 === 0) await t.gql('q', {}); else await t.rest('POST', 'repos/o/r/issues/1/issue-field-values', {});
        results.push('ok');
      } catch (e) { results.push(e.message); }
    }
    return { results, sleeps, calls: t.stats.calls };
  };
  const fail = (trace) => ({ status: 1, stdout: '', stderr: trace });
  const ok = { status: 0, stdout: '{"data":{}}' };

  let r = await drive([fail('60'), ok]);
  check('a recognised limit is waited out (margin added) and tried once more', same(r.results, ['ok']) && same(r.sleeps, [65]) &&
    r.calls === 2, JSON.stringify(r));
  r = await drive([fail('60'), fail('60')]);
  check('limited again on the retry: the run stops', /rate limited again/.test(r.results[0]) && same(r.sleeps, [65]), JSON.stringify(r));
  r = await drive([fail('60'), ok, fail('30')], { requests: 2 });
  check('one wait per run, across GraphQL and REST: a second limit later is not waited out', r.results[0] === 'ok' &&
    /^POST issues\/1\/issue-field-values rate limited .*already spent its one wait/.test(r.results[1]) && same(r.sleeps, [65]),
  JSON.stringify(r));
  r = await drive([fail('896')]);
  check('a wait over the cap (margin included) is reported and not taken', /over the 900s cap/.test(r.results[0]) &&
    r.sleeps.length === 0, JSON.stringify(r));
  r = await drive([fail('unlimited')]);
  check('a failure with no recognised limit is not retried', /no recognised rate limit/.test(r.results[0]) && r.calls === 1);
  r = await drive([fail('unreadable')]);
  check('an unreadable trace says UNKNOWN, not "no"', /UNKNOWN/.test(r.results[0]));
}

console.log('summary');
{
  const plan = planWrites(
    [iss(5, ['stage:waiting-on-owner', 'priority:p1', 'priority:p2']), iss(6, [], [], { state: 'closed' })],
    FIELDS.filter((f) => f.name !== 'Thread'), CTX,
  );
  const md = renderSummary(plan, { mode: 'scheduled reconcile', dryRun: false, issues: 2, written: 0, failed: 0,
    deferred: 0, calls: 1, waits: 0 });
  check('a missing field becomes an instruction to add it', /Add the issue field \*\*Thread\*\* \(text\)/.test(md), md);
  check('a missing option becomes an instruction to add it', /Add the option \*\*waiting-on-owner\*\* to the \*\*Stage\*\* issue field/.test(md));
  check('a conflict names both labels', /#5: `priority:p1` and `priority:p2`/.test(md));
  check('an issue read as not open is named', /not open, skipped: #6/.test(md));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
