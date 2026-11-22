#!/usr/bin/env node
/**
 * Fixtures for `board-label-sync.mjs`: the planner, the board pagination, the
 * mutation document, the rate-limit rule of the transport, and the summary.
 * No network and no token: the planner is pure, the board listing and the
 * transport take injected functions, and the rate-limit classification runs
 * the REAL `gh-trace-ratelimit-wait.sh` against fixture traces.
 *
 * Run: `node .github/scripts/board-label-sync.selftest.mjs`
 */
import {
  classifyTrace, listBoard, makeGhTransport, mutationFor, planWrites, renderSummary, traceEvidence,
} from './board-label-sync.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes += 1; console.log(`  ok    ${name}`); }
  else { failures += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const REPO = 'vaipakam/vaipakam';
const url = (n, repo = REPO) => `https://github.com/${repo}/issues/${n}`;

const FIELDS = [
  { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'S_done', name: 'Done' }] },
  { id: 'F_thread', name: 'Thread', dataType: 'SINGLE_SELECT', options: [
    { id: 'T_plan', name: 'issues-plan' }, { id: 'T_keeper', name: 'keeper' }, { id: 'T_legacy', name: 'legacy' },
  ] },
  { id: 'F_prio', name: 'priority', dataType: 'SINGLE_SELECT', options: [
    { id: 'P_1', name: 'P1' }, { id: 'P_2', name: 'P2 – loan path' }, { id: 'P_3', name: 'P3' },
    { id: 'P_4', name: 'P4' }, { id: 'P_5', name: 'P5' }, { id: 'P_10', name: 'P10' },
  ] },
  { id: 'F_stage', name: 'Stage', dataType: 'SINGLE_SELECT', options: [
    { id: 'G_building', name: 'building' }, { id: 'G_queued', name: 'queued' }, { id: 'G_other', name: 'blocked' },
  ] },
  { id: 'F_text', name: 'Notes', dataType: 'TEXT' },
];
const CTX = { repo: REPO, threadValues: ['issues-plan', 'keeper', 'app-fixes'] };
const item = (n, values = {}, extra = {}) => ({
  id: `I_${n}`, type: 'Issue', url: url(n), repo: REPO, state: 'OPEN', number: n, values, ...extra,
});
const v = (optionId, name) => ({ optionId, name });
const writesFor = (plan, n) => plan.writes.filter((w) => w.issue === n);

console.log('planner');
{
  const issues = [
    { number: 1, url: url(1), labels: ['priority:p1', 'stage:building', 'thread:keeper', 'bug'] },
    { number: 2, url: url(2), labels: ['priority:p2', 'stage:queued', 'thread:issues-plan'] },
    { number: 3, url: url(3), labels: ['enhancement'] },
    { number: 4, url: url(4), labels: ['priority:p1', 'priority:p3'] },
    { number: 5, url: url(5), labels: ['stage:waiting-on-owner', 'thread:app-fixes'] },
    { number: 6, url: url(6), labels: ['priority:p9', 'stage:nonsense'] },
    { number: 7, url: url(7), labels: ['priority:p4'] },
    { number: 9, url: url(9), labels: ['priority:p5'] },
    { number: 11, url: url(11), labels: ['PRIORITY:P5'] },
  ];
  const board = [
    item(1),
    item(2, { F_prio: v('P_1', 'P1'), F_stage: v('G_queued', 'queued'), F_thread: v('T_plan', 'issues-plan') }),
    item(3, { F_prio: v('P_3', 'P3'), F_stage: v('G_other', 'blocked'), F_thread: v('T_legacy', 'legacy'), F_status: v('S_done', 'Done') }),
    item(4, { F_prio: v('P_2', 'P2 – loan path') }),
    item(5),
    item(6, { F_prio: v('P_4', 'P4') }),
    // #7 is in another repository with the SAME number: never touched.
    { ...item(7, { F_prio: v('P_1', 'P1') }), id: 'I_other7', url: url(7, 'vaipakam/keeper-bot'), repo: 'vaipakam/keeper-bot' },
    // #8 is closed: not in the open list; its stale values stay.
    item(8, { F_prio: v('P_1', 'P1'), F_stage: v('G_building', 'building') }, { state: 'CLOSED' }),
    // #9 is open in the issue list but closed on the board (a race).
    item(9, {}, { state: 'CLOSED' }),
    { id: 'I_draft', type: 'DraftIssue', values: { F_prio: v('P_1', 'P1') } },
    { id: 'I_pr', type: 'PullRequest', url: `https://github.com/${REPO}/pull/10`, repo: REPO, values: {} },
    item(11, { F_prio: v('P_5', 'P5') }),
  ];
  const plan = planWrites(issues, board, FIELDS, CTX);

  check('labels added: three sets on an empty card', same(
    writesFor(plan, 1).map((w) => [w.action, w.field, w.optionId]),
    [['set', 'Priority', 'P_1'], ['set', 'Stage', 'G_building'], ['set', 'Thread', 'T_keeper']],
  ), JSON.stringify(writesFor(plan, 1)));
  check('label changed: P1 → the option whose name starts with P2', same(
    writesFor(plan, 2).map((w) => [w.action, w.field, w.optionId, w.from]),
    [['set', 'Priority', 'P_2', 'P1']],
  ), JSON.stringify(writesFor(plan, 2)));
  check('field already matching is not rewritten', !writesFor(plan, 2).some((w) => w.field !== 'Priority'));
  check('labels removed: a known Priority value is cleared', writesFor(plan, 3).some(
    (w) => w.action === 'clear' && w.field === 'Priority' && w.from === 'P3'));
  check('labels removed: a Stage value the sync never writes is left alone',
    !writesFor(plan, 3).some((w) => w.field === 'Stage'));
  check('labels removed: a Thread value with no thread: label is left alone',
    !writesFor(plan, 3).some((w) => w.field === 'Thread'));
  check('a field the sync does not own (Status) is never written', !plan.writes.some((w) => w.fieldId === 'F_status'));
  check('two labels of one family: no write for that family', writesFor(plan, 4).length === 0,
    JSON.stringify(writesFor(plan, 4)));
  check('two labels of one family: the conflict is reported', same(plan.conflicts,
    [{ issue: 4, family: 'priority', labels: ['priority:p1', 'priority:p3'] }]), JSON.stringify(plan.conflicts));
  check('missing option: no write, and the option is listed to add', writesFor(plan, 5).length === 0 &&
    same(plan.missingOptions, { Stage: ['waiting-on-owner'], Thread: ['app-fixes'] }), JSON.stringify(plan.missingOptions));
  check('unrecognised labels are reported and ignored', same(
    plan.unrecognised.map((u) => u.label), ['priority:p9', 'stage:nonsense']));
  check('an unrecognised priority label does not clear the field either way',
    writesFor(plan, 6).every((w) => w.field !== 'Priority' || w.action === 'clear'));
  check('another repository\'s issue with the same number is never written',
    !plan.writes.some((w) => w.itemId === 'I_other7'));
  check('an open issue whose card is in another repository counts as not on the board', plan.notOnBoard.includes(7));
  check('drafts, pull requests and other repositories are counted as foreign', plan.foreignItems === 3,
    String(plan.foreignItems));
  check('a closed issue is never written', !plan.writes.some((w) => w.issue === 8));
  check('an issue the board shows closed is skipped and reported', same(plan.closedOnBoard, [9]));
  check('P5 does not match P10, and case is ignored in labels', writesFor(plan, 11).length === 0,
    JSON.stringify(writesFor(plan, 11)));
}

{
  const plan = planWrites(
    [{ number: 1, url: url(1), labels: ['priority:p1', 'stage:queued', 'thread:keeper'] }],
    [item(1)],
    FIELDS.filter((f) => f.id !== 'F_stage' && f.id !== 'F_thread').concat([{ id: 'F_tt', name: 'Thread', dataType: 'TEXT' }]),
    CTX,
  );
  check('missing field: listed, its writes skipped, the run carries on', same(plan.missingFields, ['Stage', 'Thread']) &&
    same(plan.writes.map((w) => w.field), ['Priority']), JSON.stringify(plan));
}
{
  const plan = planWrites([{ number: 1, url: url(1), labels: [] }], [item(1, { F_thread: v('T_keeper', 'keeper') })], FIELDS,
    { repo: REPO });
  check('without the repository\'s thread list, no Thread value is cleared', plan.writes.length === 0);
}
{
  const plan = planWrites([{ number: 1, url: url(1), labels: ['thread:keeper'] }], [item(1, { F_thread: v('T_keeper', 'keeper') })],
    FIELDS, CTX);
  check('a card already in sync gets no writes', plan.writes.length === 0);
}

console.log('pagination');
{
  const pages = [
    { cursor: 'c1', next: true, nodes: [1, 2] },
    { cursor: 'c2', next: true, nodes: [3] },
    { cursor: 'c3', next: false, nodes: [4, 5] },
  ];
  const seen = [];
  const node = (n) => ({
    id: `I_${n}`,
    content: { __typename: 'Issue', number: n, url: url(n), state: 'OPEN', repository: { nameWithOwner: REPO } },
    fieldValues: { nodes: [{}, { optionId: 'P_1', name: 'P1', field: { id: 'F_prio' } }] },
  });
  const gql = async (_q, vars) => {
    seen.push(vars);
    const p = pages[seen.length - 1];
    return { data: { user: { projectV2: {
      ...(vars.first ? { id: 'PROJ', fields: { nodes: [{}, ...FIELDS] } } : {}),
      items: { totalCount: 5, pageInfo: { hasNextPage: p.next, endCursor: p.cursor }, nodes: p.nodes.map(node) },
    } } } };
  };
  const board = await listBoard(gql, 'vaipakam', 1);
  check('every page is read, in order', board.pages === 3 && same(board.items.map((i) => i.number), [1, 2, 3, 4, 5]));
  check('each page after the first asks after the previous cursor', same(seen.map((s) => s.after), [null, 'c1', 'c2']));
  check('fields and project id are requested on the first page only', same(seen.map((s) => s.first), [true, false, false]) &&
    board.projectId === 'PROJ' && board.fields.length === FIELDS.length);
  check('single-select values are keyed by field id', same(board.items[0].values, { F_prio: { optionId: 'P_1', name: 'P1' } }));

  const short = async (_q, vars) => ({ data: { user: { projectV2: {
    ...(vars.first ? { id: 'PROJ', fields: { nodes: FIELDS } } : {}),
    items: { totalCount: 9, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] },
  } } } });
  let threw = '';
  try { await listBoard(short, 'vaipakam', 1); } catch (e) { threw = e.message; }
  check('a short read aborts instead of planning from part of the board', /returned 1 of 9/.test(threw), threw);

  let threw2 = '';
  try { await listBoard(async () => ({ data: { user: null } }), 'vaipakam', 1); } catch (e) { threw2 = e.message; }
  check('an unreadable board aborts', /not readable/.test(threw2), threw2);
}

console.log('mutation document');
{
  const { query, variables } = mutationFor('PROJ', [
    { action: 'set', itemId: 'I_1', fieldId: 'F_prio', optionId: 'P_1' },
    { action: 'clear', itemId: 'I_2', fieldId: 'F_stage', optionId: null },
  ]);
  check('one aliased document, set then clear', /w0: updateProjectV2ItemFieldValue/.test(query) &&
    /w1: clearProjectV2ItemFieldValue/.test(query));
  check('values travel as variables, not in the document text', !query.includes('I_1') && !query.includes('P_1') &&
    same(variables, { p: 'PROJ', i0: 'I_1', f0: 'F_prio', o0: 'P_1', i1: 'I_2', f1: 'F_stage' }));
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
    '{"data":{"title":"secret draft title"},"message":"API rate limit already exceeded for user ID 1."}',
  ].join('\n');
  const c = classifyTrace(limited(now + 120));
  const secs = Number(c.stdout.split('\t')[0]);
  check('the real parser recognises the observed shape', c.rc === 0 && secs >= 115 && secs <= 120, JSON.stringify(c));
  check('the real parser refuses a 401', classifyTrace('< HTTP/2.0 401 Unauthorized\n{"message":"Bad credentials"}').rc === 1);
  check('the real parser reports an unreadable trace', classifyTrace('no status line here').rc === 2);

  const ev = traceEvidence(limited(now + 60));
  check('evidence keeps the status, headers and message', /HTTP\/2.0 200/.test(ev) && /X-Ratelimit-Remaining: 0/.test(ev) &&
    /API rate limit already exceeded/.test(ev));
  check('evidence drops response bodies and redacts tokens', !ev.includes('secret draft title') && !ev.includes('ghp_abc'));

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
      try { await t.gql('q', {}); results.push('ok'); } catch (e) { results.push(e.message); }
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
  check('one wait per run: a second limit later is not waited out', r.results[0] === 'ok' &&
    /already spent its one wait/.test(r.results[1]) && same(r.sleeps, [65]), JSON.stringify(r));
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
    [{ number: 5, url: url(5), labels: ['stage:waiting-on-owner', 'priority:p1', 'priority:p2'] }, { number: 6, url: url(6), labels: [] }],
    [item(5)], FIELDS.filter((f) => f.id !== 'F_thread'), CTX,
  );
  const md = renderSummary(plan, { mode: 'scheduled reconcile', dryRun: false, issues: 2, boardItems: 1, written: 0, failed: 0,
    deferred: 0, calls: 1, waits: 0 });
  check('a missing field becomes an instruction to add it', /Add the single-select field \*\*Thread\*\*/.test(md));
  check('a missing option becomes an instruction to add it', /Add the option \*\*waiting-on-owner\*\* to the \*\*Stage\*\* field/.test(md));
  check('a conflict names both labels', /#5: `priority:p1` and `priority:p2`/.test(md));
  check('an issue not on the board is named', /#6/.test(md));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
