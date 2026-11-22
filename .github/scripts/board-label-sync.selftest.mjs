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
  chooseStartDate, classifyTrace, isCloseDay, itemFromRow, listIssueFields, makeGhTransport, planWrites, readTimelines,
  renderSummary, requestsFor, selectWrites, timelineFacts, timelineQueue, timelineReason, traceEvidence, valuesFromRest,
  FIELD_VALUES_API_VERSION, TIMELINE_PAGE_CAP,
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
    plan.missingFields.map((f) => f.field), ['Stage', 'Thread', 'Start date', 'Target date']) &&
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

console.log('dates');
{
  // Fixed clock: 2026-11-22 12:00 UTC.
  const NOW = Date.parse('2026-11-22T12:00:00Z');
  const DF = [...FIELDS, { dbId: 60, name: 'Start date', dataType: 'DATE' }, { dbId: 70, name: 'target date', dataType: 'DATE' }];
  const C = { ...CTX, now: NOW, recheckHours: 2 };
  const OLD = '2026-10-01T00:00:00Z'; // updated long ago: outside the recheck window
  const item = (number, extra = {}) => ({ number, state: 'open', isPr: false, labels: [], values: [],
    createdAt: '2026-11-01T10:00:00Z', closedAt: null, updatedAt: OLD, ...extra });
  const xref = (num, created, at = '2026-11-15T00:00:00Z') => ({ event: 'cross-referenced', created_at: at,
    source: { type: 'issue', issue: { number: num, created_at: created, pull_request: { url: 'x' } } } });
  const labeled = (name, at) => ({ event: 'labeled', created_at: at, label: { name } });
  const dw = (plan, n) => plan.writes.filter((w) => w.issue === n && w.date).map((w) => [w.action, w.field, w.value]);

  // Start date: which source wins.
  const fPr = timelineFacts([labeled('enhancement', '2026-11-01T10:00:01Z'), xref(90, '2026-11-05T09:00:00Z'),
    labeled('stage:building', '2026-11-07T00:00:00Z'), xref(91, '2026-11-03T23:59:59Z', '2026-11-20T00:00:00Z')]);
  check('start: the earliest linked PR wins, by the PR\'s own created_at (a PR mentioning the issue later still counts)',
    chooseStartDate(item(1), fPr) === '2026-11-03', JSON.stringify(fPr));
  const fLabel = timelineFacts([labeled('stage:building', '2026-11-02T00:30:00Z'), xref(92, '2026-11-04T00:00:00Z'),
    labeled('stage:building', '2026-11-06T00:00:00Z')]);
  check('start: a first stage:building before any PR wins, and only its FIRST application counts',
    chooseStartDate(item(2), fLabel) === '2026-11-02', JSON.stringify(fLabel));
  const fNone = timelineFacts([labeled('stage:queued', '2026-11-02T00:00:00Z'), { event: 'cross-referenced', created_at: '2026-11-03T00:00:00Z',
    source: { type: 'issue', issue: { number: 5, created_at: '2026-11-03T00:00:00Z' } } }, { event: 'referenced', created_at: '2026-11-04T00:00:00Z' }]);
  check('start: neither (an issue cross-reference and a commit reference do not count) → the issue\'s created_at',
    chooseStartDate(item(3), fNone) === '2026-11-01', JSON.stringify(fNone));
  check('start: a pull request is its own created_at, with no timeline',
    chooseStartDate(item(4, { isPr: true, createdAt: '2026-11-09T23:30:00-02:00' }), null) === '2026-11-10');
  check('start: an issue with no facts has no Start date to give', chooseStartDate(item(5), null) === null);

  // Planning dates.
  const pr = item(10, { isPr: true, state: 'closed', createdAt: '2026-11-03T05:00:00Z', closedAt: '2026-11-04T06:00:00Z',
    labels: ['priority:p1'] });
  const closedRead = item(11, { state: 'closed', closedAt: '2026-11-08T01:00:00Z', facts: fPr, labels: ['stage:queued'] });
  const openRead = item(12, { facts: fLabel });
  const openHandTarget = item(13, { values: [val(60, '2026-11-01'), val(70, '2026-12-31')] });
  const reopened = item(14, { updatedAt: '2026-11-22T11:30:00Z', values: [val(60, '2026-11-02'), val(70, '2026-11-20')],
    facts: timelineFacts([{ event: 'closed', created_at: '2026-11-19T22:00:00Z' }, { event: 'reopened', created_at: '2026-11-21T00:00:00Z' },
      { event: 'closed', created_at: '2026-11-21T00:00:01Z' }, { event: 'reopened', created_at: '2026-11-22T11:30:00Z' }]) });
  const reopenedHand = item(15, { updatedAt: '2026-11-22T11:30:00Z', values: [val(60, '2026-11-02'), val(70, '2026-12-31')],
    facts: timelineFacts([{ event: 'closed', created_at: '2026-11-21T00:00:01Z' }]) });
  const unchanged = item(16, { state: 'closed', closedAt: '2026-11-08T01:00:00Z', values: [val(60, '2026-11-02'), val(70, '2026-11-08')] });
  const unread = item(17, { state: 'closed', closedAt: '2026-11-08T01:00:00Z' });
  const plan = planWrites([pr, closedRead, openRead, openHandTarget, reopened, reopenedHand, unchanged, unread], DF, C);

  check('a pull request: Start = created_at, Target = closed_at (the merge), in the SAME plan',
    same(dw(plan, 10), [['set', 'Start date', '2026-11-03'], ['set', 'target date', '2026-11-04']]), JSON.stringify(dw(plan, 10)));
  check('a pull request never gets a label-family write', !plan.writes.some((w) => w.issue === 10 && !w.date));
  check('a closed issue: Start from its timeline, Target = closed_at; label rules still skip it',
    same(dw(plan, 11), [['set', 'Start date', '2026-11-03'], ['set', 'target date', '2026-11-08']]) &&
    !plan.writes.some((w) => w.issue === 11 && !w.date), JSON.stringify(plan.writes.filter((w) => w.issue === 11)));
  check('an open issue: Start set, and NO Target invented', same(dw(plan, 12), [['set', 'Start date', '2026-11-02']]),
    JSON.stringify(dw(plan, 12)));
  check('an open issue with a hand-set Target and no recent change: untouched, and no timeline needed',
    dw(plan, 13).length === 0 && timelineReason(openHandTarget, DF, C) === null);
  check('reopened: a Target equal to the LAST close day (the job\'s own value) is cleared with a DELETE, never a PUT',
    same(dw(plan, 14), [['clear', 'target date', null]]) &&
    requestsFor(REPO, 14, plan.writes.filter((w) => w.issue === 14)).every((q) => q.method === 'DELETE'), JSON.stringify(dw(plan, 14)));
  check('a reopen read never re-derives a Start date that is not the creation-day fallback',
    !plan.writes.some((w) => (w.issue === 14 || w.issue === 15) && w.field === 'Start date'));
  check('field names match trimmed and case-insensitively ("Start Date", " TARGET DATE ")', same(dw(planWrites([pr],
    [{ dbId: 80, name: 'Start Date', dataType: 'DATE' }, { dbId: 81, name: ' TARGET DATE ', dataType: 'DATE' }], C), 10).map((x) => x[2]),
  ['2026-11-03', '2026-11-04']));
  check('reopened: a hand-set Target that is not the close day stays', dw(plan, 15).length === 0, JSON.stringify(dw(plan, 15)));
  check('an unchanged value is never rewritten', dw(plan, 16).length === 0, JSON.stringify(dw(plan, 16)));
  const prSynced = item(19, { isPr: true, state: 'closed', createdAt: '2026-11-03T05:00:00Z', closedAt: '2026-11-04T06:00:00Z',
    values: [val(60, '2026-11-03'), val(70, '2026-11-04')] });
  const openPr = item(9, { isPr: true, labels: ['priority:p1', 'thread:keeper'], createdAt: '2026-11-03T05:00:00Z', values: [val(60, '2026-11-03')] });
  const p2 = planWrites([prSynced, openPr], DF, C);
  check('a pull request already carrying both dates gets no write', p2.writes.filter((w) => w.issue === 19).length === 0,
    JSON.stringify(p2.writes));
  check('an OPEN pull request with family labels gets no label write (dates only)', p2.writes.filter((w) => w.issue === 9).length === 0,
    JSON.stringify(p2.writes));
  check('an issue awaiting its timeline gets NO date write at all, not even its Target, and is counted',
    dw(plan, 17).length === 0 && plan.awaitingTimeline.fill === 1, JSON.stringify(plan.awaitingTimeline));
  check('the label families still run on open issues beside the dates',
    !plan.writes.some((w) => w.issue === 11 && w.field === 'Stage'));
  check('date writes never PUT', plan.writes.every((w) => ['set', 'clear'].includes(w.action)) &&
    [10, 11, 12, 14].flatMap((n) => requestsFor(REPO, n, plan.writes.filter((w) => w.issue === n))).every((q) => q.method !== 'PUT'));
  check('a PR\'s two dates go in ONE POST', same(requestsFor(REPO, 10, plan.writes.filter((w) => w.issue === 10)).map((q) => [q.method, q.writes]),
    [['POST', 2]]));

  check('close day: the event\'s day and the day a few seconds earlier both count (closed_at 23:59:59, event 00:00:01)',
    isCloseDay('2026-11-20', '2026-11-21T00:00:01Z') && isCloseDay('2026-11-21', '2026-11-21T00:00:01Z') &&
    !isCloseDay('2026-11-19', '2026-11-21T00:00:01Z'));
  check('a REST closed_at still on an open item is used without a timeline', same(dw(planWrites([item(18, {
    closedAt: '2026-11-20T03:00:00Z', values: [val(60, '2026-11-02'), val(70, '2026-11-20')] })], DF, C), 18), [['clear', 'target date', null]]));
  check('a timeline read cut short leaves the last close UNKNOWN, so nothing is cleared',
    timelineFacts([{ event: 'closed', created_at: '2026-11-20T00:00:00Z' }], { complete: false }).lastClosedAt === null);

  // When a timeline is needed.
  check('reason: no Start date → fill', timelineReason(item(20), DF, C) === 'fill');
  check('reason: a pull request never needs one', timelineReason(item(21, { isPr: true }), DF, C) === null);
  check('reason: Start = creation day and changed recently → recheck (open)',
    timelineReason(item(22, { updatedAt: '2026-11-22T10:30:00Z', values: [val(60, '2026-11-01')] }), DF, C) === 'recheck');
  check('reason: the same, but outside the window → none',
    timelineReason(item(23, { updatedAt: '2026-11-22T09:30:00Z', values: [val(60, '2026-11-01')] }), DF, C) === null);
  check('reason: a closed issue is rechecked on an event pass only',
    timelineReason(item(24, { state: 'closed', updatedAt: '2026-11-22T11:00:00Z', values: [val(60, '2026-11-01')] }), DF, C) === null &&
    timelineReason(item(24, { state: 'closed', updatedAt: '2026-11-22T11:00:00Z', values: [val(60, '2026-11-01')] }), DF, { ...C, eventMode: true }) === 'recheck');
  check('reason: a Start date that is not the creation day is final',
    timelineReason(item(25, { updatedAt: '2026-11-22T11:00:00Z', values: [val(60, '2026-11-05')] }), DF, C) === null);
  check('reason: open, Target set, recently changed → reopen',
    timelineReason(item(26, { updatedAt: '2026-11-22T11:00:00Z', values: [val(60, '2026-11-05'), val(70, '2026-11-20')] }), DF, C) === 'reopen');
  check('reason: no date fields → nothing is ever read', timelineReason(item(27), FIELDS, C) === null);

  // A reopened pull request: the same reopen rule as an issue's.
  const prReopened = item(41, { isPr: true, updatedAt: '2026-11-22T11:00:00Z', createdAt: '2026-11-03T05:00:00Z',
    values: [val(60, '2026-11-03'), val(70, '2026-11-20')] });
  check('reason: a reopened pull request (open, Target set, changed recently, no closed_at) → reopen',
    timelineReason(prReopened, DF, C) === 'reopen');
  check('reason: a pull request never needs a timeline for its Start date (fill or recheck)',
    timelineReason(item(42, { isPr: true, values: [] }), DF, C) === null &&
    timelineReason(item(43, { isPr: true, updatedAt: '2026-11-22T11:00:00Z', createdAt: '2026-11-03T05:00:00Z',
      values: [val(60, '2026-11-03')] }), DF, { ...C, eventMode: true }) === null);
  const prClosedFacts = timelineFacts([{ event: 'closed', created_at: '2026-11-20T10:00:00Z' }, { event: 'reopened', created_at: '2026-11-22T11:00:00Z' }]);
  check('a reopened pull request\'s job-written Target date is cleared once its last close is read',
    same(dw(planWrites([{ ...prReopened, facts: prClosedFacts }], DF, C), 41), [['clear', 'target date', null]]));
  check('a reopened pull request awaiting its read gets no date write, and is counted',
    (() => { const pl = planWrites([prReopened], DF, C); return dw(pl, 41).length === 0 && pl.awaitingTimeline.reopen === 1; })());
  check('a reopened pull request\'s hand-set Target date stays', dw(planWrites([{ ...prReopened,
    values: [val(60, '2026-11-03'), val(70, '2026-12-31')], facts: prClosedFacts }], DF, C), 41).length === 0);

  // Incomplete history is never written from.
  const longFacts = timelineFacts([labeled('stage:building', '2026-11-02T00:00:00Z')], { complete: false });
  const longIssue = item(44, { state: 'closed', closedAt: '2026-11-08T01:00:00Z', facts: longFacts });
  const pLong = planWrites([longIssue], DF, C);
  check('a timeline read only in part writes NO Start date (nor Target), and is named for a hand entry',
    dw(pLong, 44).length === 0 && same(pLong.incompleteHistory, [44]), JSON.stringify(pLong));
  check('the summary names an item whose timeline was too long', new RegExp(`timeline longer than ${TIMELINE_PAGE_CAP} pages.*#44`).test(
    renderSummary(pLong, { mode: 'm', dryRun: true, issues: 1, written: 0, failed: 0, deferred: 0, calls: 0, waits: 0 })));
  check('an incomplete read used for nothing (no reason) does not block the listing-only dates',
    same(dw(planWrites([{ ...item(45, { isPr: true, state: 'closed', createdAt: '2026-11-03T05:00:00Z', closedAt: '2026-11-04T00:00:00Z' }),
      facts: longFacts }], DF, C), 45), [['set', 'Start date', '2026-11-03'], ['set', 'target date', '2026-11-04']]));

  // Caps.
  const many = [item(30), item(31, { state: 'closed', closedAt: '2026-11-02T00:00:00Z' }), item(32),
    item(33, { updatedAt: '2026-11-22T11:00:00Z', values: [val(60, '2026-11-01')] }), item(34, { isPr: true })];
  const q = timelineQueue(many, DF, C);
  check('queue: rechecks first, then fills open before closed, newest first; a PR with no Target date absent',
    same(q.map((x) => [x.number, x.reason]), [[33, 'recheck'], [32, 'fill'], [30, 'fill'], [31, 'fill']]), JSON.stringify(q));
  const gets = [];
  const pageOf = (n, len) => Array.from({ length: len }, () => ({ event: 'labeled', created_at: '2026-11-02T00:00:00Z', label: { name: 'stage:building' } }));
  const fakeGet = async (path) => {
    gets.push(path);
    const n = Number(/issues\/(\d+)\//.exec(path)[1]);
    const page = Number(/[?&]page=(\d+)/.exec(path)[1]);
    return n === 32 && page === 1 ? pageOf(n, 100) : pageOf(n, 3);
  };
  let r = await readTimelines(fakeGet, REPO, q, 3);
  check('MAX_TIMELINE_READS caps requests; an item cut off part-way gets no facts; the rest wait',
    r.reads === 3 && same([...r.facts.keys()], [33, 32]) && gets.length === 3 &&
    r.facts.get(33).complete === true && r.facts.get(32).complete === true, JSON.stringify([r.reads, [...r.facts.keys()], gets]));
  gets.length = 0;
  r = await readTimelines(fakeGet, REPO, q, 0);
  gets.length = 0;
  r = await readTimelines(fakeGet, REPO, q, 2);
  check('the cap falling inside one issue\'s pages: that issue gets no facts (never a partial history) and no more is read',
    r.reads === 2 && same([...r.facts.keys()], [33]) && gets.length === 2, JSON.stringify([r.reads, [...r.facts.keys()], gets]));
  gets.length = 0;
  r = await readTimelines(fakeGet, REPO, q, 0);
  check('MAX_TIMELINE_READS=0 reads nothing', r.reads === 0 && r.facts.size === 0 && gets.length === 0);
  gets.length = 0;
  r = await readTimelines(async (p) => { gets.push(p); return pageOf(0, 100); }, REPO, [{ number: 40 }], 1000);
  check(`one issue stops at TIMELINE_PAGE_CAP (${TIMELINE_PAGE_CAP}) pages and is marked incomplete, so nothing is written from it`,
    r.reads === TIMELINE_PAGE_CAP && r.facts.get(40).complete === false &&
    dw(planWrites([item(40, { facts: r.facts.get(40) })], DF, C), 40).length === 0);
  const planAll = planWrites(many.map((it) => (r.facts.has(it.number) ? { ...it, facts: r.facts.get(it.number) } : it)), DF, C);
  check('the remaining count is reported by reason', same(planAll.awaitingTimeline, { fill: 3, recheck: 1 }), JSON.stringify(planAll.awaitingTimeline));
  const md = renderSummary(planAll, { mode: 'scheduled reconcile', dryRun: true, issues: 5, written: 0, failed: 0, deferred: 0,
    calls: 0, waits: 0, timelineReads: 3, maxTimelineReads: 3 });
  check('the summary states reads against the cap and what remains', /timeline reads: 3 of MAX_TIMELINE_READS=3; items still awaiting one \(their dates wait for it\): 4 \(fill 3, recheck 1\)/.test(md), md);

  // MAX_WRITES: label writes first, then whole date groups, read items first.
  const ws = [
    { action: 'set', issue: 1, field: 'Priority', value: 'P1' },
    { action: 'set', issue: 2, field: 'Start date', value: 'a', date: true }, { action: 'set', issue: 2, field: 'Target date', value: 'b', date: true },
    { action: 'set', issue: 3, field: 'Start date', value: 'c', date: true }, { action: 'set', issue: 3, field: 'Target date', value: 'd', date: true },
    { action: 'set', issue: 4, field: 'Start date', value: 'e', date: true },
  ];
  const its = [{ number: 2, state: 'closed' }, { number: 3, state: 'closed', facts: {} }, { number: 4, state: 'open' }];
  let sel = selectWrites(ws, 4, its);
  check('MAX_WRITES: label writes first, then the item read this run, and an item\'s dates are never split',
    same(sel.todo.map((w) => [w.issue, w.field]), [[1, 'Priority'], [3, 'Start date'], [3, 'Target date'], [4, 'Start date']]) &&
    sel.deferred === 2,
    JSON.stringify(sel));
  sel = selectWrites(ws, 100, its);
  check('MAX_WRITES: with room, everything goes; nothing deferred', sel.todo.length === 6 && sel.deferred === 0);

  // The missing-field report for the dates.
  const noDates = planWrites([item(50, { isPr: true, createdAt: '2026-11-01T00:00:00Z' })], FIELDS, C);
  check('missing date fields are listed and their writes skipped; nothing read', same(noDates.missingFields.map((f) => f.field),
    ['Start date', 'Target date']) && noDates.writes.length === 0);
  const wrongType = planWrites([item(51, { isPr: true })], [...FIELDS, { dbId: 61, name: 'Start date', dataType: 'TEXT' }], C);
  check('a "Start date" field that is not DATE counts as missing', wrongType.missingFields.some((f) => f.field === 'Start date') &&
    wrongType.writes.length === 0);

  // Listing rows.
  const prRow = itemFromRow({ number: 60, state: 'closed', pr: true, labels: [], created_at: 'x', closed_at: 'y', updated_at: 'z' });
  check('a pull request read without issue_field_values is kept with unknown values (skipped, reported), not fatal',
    prRow.values === null && prRow.isPr && same(planWrites([prRow], DF, C).valuesUnknown, [60]));
  let threw = '';
  try { itemFromRow({ number: 61, state: 'open', pr: false, labels: [] }); } catch (e) { threw = e.message; }
  check('an issue read without issue_field_values is still fatal', /#61/.test(threw), threw);
  const dateVal = valuesFromRest([{ issue_field_id: 60, issue_field_name: 'Start date', data_type: 'date', value: '2026-11-02' }], 1);
  check('a date value reads as its YYYY-MM-DD string', same(dateVal, [{ fieldId: 60, fieldName: 'Start date', text: '2026-11-02' }]));
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
  check('closed issues are counted as dates-only', /closed issues \(dates only; the label rules apply to open issues\): 1/.test(md), md);
  check('a missing DATE field becomes an instruction to add it', /Add the issue field \*\*Start date\*\* \(date\)/.test(md) &&
    /Add the issue field \*\*Target date\*\* \(date\)/.test(md));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
