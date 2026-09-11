// census-storage-read.test.mjs — the era-complete storage read's rules (#1566 §7/§7a), over fake readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, intentVerdictFromStorage, eraSlotsExcept, mergeHistoricalRows, aliasOf, classifyEarlierCounters, markAliasedRows, splitByHeadSlot, getterAgreement, downgradeWithoutEraRead, attributeCounters, attributeFacetCode, downgradeProvenClasses, downgradeStorageOnlyProofs, requireHexData, cutHistoryCompleteness, refuseUnreadableCutSources, ROW } from './census-storage-read.mjs';
import { memberSlot, rowSlot } from './storage-slots.mjs';

const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const base = 0x1000n;
const slotOf = (rel) => H(base + BigInt(rel));
const era = (commit, date, rel, withRows = true) => ({
  commit, date, storagePosition: H(base), bytecode: { '0xfixture': 'FixtureFacet' },
  ...(commit === 'headhead1' ? { occupied: OCCUPIED_FOR_HEAD } : {}),
  fields: Object.fromEntries(Object.entries(rel).map(([f, r]) => [f, r === null ? null : { slot: slotOf(r), relative: r, offset: 0 }])),
  rows: withRows ? {
    SwapToRepayIntentCommit: rel.intentCommits === null ? null : { orderHash: { slot: 0, offset: 0, type: 't_bytes32' }, deadline: { slot: 1, offset: 0, type: 't_uint64' } },
    BorrowerLifRebate: { vpfiHeld: { slot: 0, offset: 0, type: 't_uint256' }, rebateAmount: { slot: 1, offset: 0, type: 't_uint256' } },
    FallbackSnapshot: { lenderCollateral: { slot: 0, offset: 0, type: 't_uint256' }, treasuryCollateral: { slot: 1, offset: 0, type: 't_uint256' }, borrowerCollateral: { slot: 2, offset: 0, type: 't_uint256' }, active: { slot: 5, offset: 0, type: 't_bool' } },
  } : {},
});
const HEADREL = { nextLoanId: 1, totalLoansEverCreated: 86, intentLiveCommitCount: 193, intentCommits: 194, borrowerLifRebate: 137, fallbackSnapshot: 45 };
let OCCUPIED_FOR_HEAD = [];
const OLDREL = { nextLoanId: 1, totalLoansEverCreated: 90, intentLiveCommitCount: 200, intentCommits: 201, borrowerLifRebate: 140, fallbackSnapshot: 45 };
const slots = { storagePosition: H(base), fields: Object.fromEntries(Object.entries(HEADREL).map(([f, r]) => [f, slotOf(r)])) };
const OCCUPIED = [
  { label: 'nextLoanId', type: 't_uint256', from: slotOf(1), to: slotOf(1) },
  { label: 'someCounterToday', type: 't_uint256', from: slotOf(OLDREL.totalLoansEverCreated), to: slotOf(OLDREL.totalLoansEverCreated) }, // today's field at the OLD counter slot
  { label: 'totalLoansEverCreated', type: 't_uint256', from: slotOf(HEADREL.totalLoansEverCreated), to: slotOf(HEADREL.totalLoansEverCreated) },
  { label: 'otherMapping', type: 't_mapping(t_uint256,t_uint256)', from: slotOf(OLDREL.intentCommits), to: slotOf(OLDREL.intentCommits), isMapping: true }, // today's mapping at the OLD intent head
  { label: 'intentCommits', type: 't_mapping(...)', from: slotOf(HEADREL.intentCommits), to: slotOf(HEADREL.intentCommits), isMapping: true },
];
OCCUPIED_FOR_HEAD = OCCUPIED;
const eras = { head: 'headhead1', since: '2026-05-01', generatedAt: 'now', complete: true, unavailable: [], eras: [era('oldold001', '2026-05-10T00:00:00Z', OLDREL), era('headhead1', '2026-09-09T00:00:00Z', HEADREL)] };

test('prepareStorageRead: validates the tables and derives distinct slots per field', () => {
  const p = prepareStorageRead({ slots, eras });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.eraSlots.nextLoanId.length, 1, 'the loan counter never moved');
  assert.equal(p.eraSlots.intentCommits.length, 2, 'two eras, two intent slots');
  assert.equal(p.eraSlots.fallbackSnapshot.length, 1, 'same slot in both eras collapses to one');
  // refusals
  assert.match(prepareStorageRead({ slots, eras: { ...eras, complete: false, unavailable: [{ commit: 'deadbeef0' }] } }).reason, /INCOMPLETE/);
  assert.match(prepareStorageRead({ slots: { ...slots, fields: { ...slots.fields, intentCommits: H(1) } }, eras }).reason, /differs from the pinned probe/);
  const badRows = { ...eras, eras: [era('oldold001', '2026-05-10T00:00:00Z', OLDREL), { ...era('headhead1', '2026-09-09T00:00:00Z', HEADREL), rows: { ...era('headhead1', 'x', HEADREL).rows, BorrowerLifRebate: { vpfiHeld: { slot: 1, offset: 0 }, rebateAmount: { slot: 0, offset: 0 } } } }] };
  assert.match(prepareStorageRead({ slots, eras: badRows }).reason, /BorrowerLifRebate\.vpfiHeld at slot 1/);
  const movedCounter = { ...eras, eras: [era('oldold001', '2026-05-10T00:00:00Z', { ...OLDREL, nextLoanId: 2 }), era('headhead1', '2026-09-09T00:00:00Z', HEADREL)] };
  assert.match(prepareStorageRead({ slots, eras: movedCounter }).reason, /nextLoanId occupied 2/);
  // a mapping present in an era WITHOUT its row layout is a lookup miss, not an absent struct: refused (#2095 r1 P1)
  const oldNoRows = era('oldold001', '2026-05-10T00:00:00Z', OLDREL);
  oldNoRows.rows = { ...oldNoRows.rows, SwapToRepayIntentCommit: null };
  assert.match(prepareStorageRead({ slots, eras: { ...eras, eras: [oldNoRows, era('headhead1', '2026-09-09T00:00:00Z', HEADREL)] } }).reason, /carries the intentCommits mapping but no SwapToRepayIntentCommit row layout/);
  // whereas an era with NO intent mapping legitimately has no row layout
  const preIntent = era('preintent1', '2026-05-05T00:00:00Z', { ...OLDREL, intentCommits: null, intentLiveCommitCount: null });
  assert.equal(prepareStorageRead({ slots, eras: { ...eras, eras: [preIntent, era('headhead1', '2026-09-09T00:00:00Z', HEADREL)] } }).ok, true);
});

test('scanRowsByStorage: a row written under an OLD era is found at the old slot and named with its era; all-zero everywhere is empty', async () => {
  const p = prepareStorageRead({ slots, eras });
  const store = new Map();
  // an intent row written by pre-June facets at the OLD intentCommits slot, loan 7
  store.set(memberSlot(7, slotOf(OLDREL.intentCommits), ROW.SwapToRepayIntentCommit.orderHash), 0xabcn);
  // a rebate row at the HEAD slot, loan 3, vpfiHeld only
  store.set(memberSlot(3, slotOf(HEADREL.borrowerLifRebate), ROW.BorrowerLifRebate.vpfiHeld), 5n);
  // an active fallback snapshot, loan 9, old era slot == head slot (never moved)
  store.set(memberSlot(9, slotOf(HEADREL.fallbackSnapshot), ROW.FallbackSnapshot.active), 0x0101n);
  store.set(memberSlot(9, slotOf(HEADREL.fallbackSnapshot), ROW.FallbackSnapshot.lenderCollateral), 11n);
  const readSlot = async (s) => store.get(s) ?? 0n;
  const r = await scanRowsByStorage({ readSlot, loanIds: [1n, 3n, 7n, 9n], eraSlots: p.eraSlots });
  assert.deepEqual(r.rows.liveIntentCommits.map((x) => [x.loanId, x.mappingSlot === slotOf(OLDREL.intentCommits), x.eras[0].commit]), [['7', true, 'oldold001']]);
  assert.deepEqual(r.rows.vpfiHeldCustody.map((x) => [x.loanId, x.vpfiHeld]), [['3', '5']]);
  assert.deepEqual(r.rows.rebateRows, []);
  assert.deepEqual(r.rows.fallbackSnapshotCustody.map((x) => [x.loanId, x.active, x.collateralTotal]), [['9', true, '11']]);
  assert.ok(r.slotsRead > 0);
  // every slot zero: every class empty
  const empty = await scanRowsByStorage({ readSlot: async () => 0n, loanIds: [1n, 2n], eraSlots: p.eraSlots });
  assert.deepEqual(Object.values(empty.rows).map((x) => x.length), [0, 0, 0, 0]);
  // a subset of classes reads only what it needs
  const only = await scanRowsByStorage({ readSlot, loanIds: [7n], eraSlots: p.eraSlots, classes: ['liveIntentCommits'] });
  assert.equal(only.rows.liveIntentCommits.length, 1);
  assert.equal(only.rows.vpfiHeldCustody, undefined);
});

test('readCountersByStorage: no loans only when nextLoanId is zero and every era counter is zero', async () => {
  const p = prepareStorageRead({ slots, eras });
  const zero = await readCountersByStorage({ readSlot: async () => 0n, eraSlots: p.eraSlots });
  assert.equal(zero.allZero, true);
  assert.equal(zero.slotsRead, 1 + 2 + 2);
  const oldCounter = await readCountersByStorage({ readSlot: async (s) => (s === slotOf(OLDREL.totalLoansEverCreated) ? 4n : 0n), eraSlots: p.eraSlots });
  assert.equal(oldCounter.allZero, false, 'a counter left non-zero at an OLD era slot still counts');
  assert.equal(oldCounter.totalLoansEverCreated.find((x) => x.value === 4n).eras[0].commit, 'oldold001');
});

test('intentVerdictFromStorage: an empty scan is proven only when every live-commit counter era slot is zero (#2095 r1 P1)', () => {
  const zero = [{ slot: '0x01', value: '0', eras: [{ date: '2026-06-23' }] }, { slot: '0x02', value: '0', eras: [{ date: '2026-09-09' }] }];
  assert.deepEqual(intentVerdictFromStorage({ rows: [], liveCommitCounts: zero }), { status: 'proven', provenBy: 'storage-read-calibrated' });
  const contradiction = intentVerdictFromStorage({ rows: [], liveCommitCounts: [{ slot: '0x01', value: '1', eras: [{ date: '2026-06-23' }] }, zero[1]] });
  assert.equal(contradiction.status, 'indeterminate');
  assert.equal(contradiction.contradiction, true);
  assert.match(contradiction.reason, /intentLiveCommitCount reads 1 at 0x01/);
  const rows = intentVerdictFromStorage({ rows: [{ loanId: '7' }], liveCommitCounts: zero });
  assert.equal(rows.status, 'indeterminate');
  assert.match(rows.reason, /1 live intent row/);
});

test('eraSlotsExcept drops exactly the slot HEAD uses; mergeHistoricalRows counts VPFI rows and marks unreadable-asset rows indeterminate (#2095 r3 P1)', () => {
  const p = prepareStorageRead({ slots, eras });
  const nonHead = eraSlotsExcept(p.eraSlots, slots.fields);
  assert.equal(nonHead.intentCommits.length, 1, 'the OLD intent slot remains');
  assert.equal(nonHead.intentCommits[0].slot, slotOf(OLDREL.intentCommits));
  assert.equal(nonHead.fallbackSnapshot.length, 0, 'a field that never moved has no earlier slot');
  assert.equal(nonHead.nextLoanId.length, 0);
  const held = mergeHistoricalRows({ status: 'proven', provenBy: 'x', count: 0, total: '0', rows: [] }, { rows: { vpfiHeldCustody: [{ loanId: '3', vpfiHeld: '7', mappingSlot: '0xold', eras: [] }] } }, 'vpfiHeldCustody');
  assert.equal(held.status, 'proven');
  assert.equal(held.count, 1);
  assert.equal(held.total, '7');
  assert.equal(held.rows[0].layoutEra, 'earlier');
  const intent = mergeHistoricalRows({ status: 'proven', provenBy: 'x', count: 0, total: '0', rows: [], unknownAssetRows: [] }, { rows: { liveIntentCommits: [{ loanId: '9', orderHash: '0xab', mappingSlot: '0xold', eras: [] }] } }, 'liveIntentCommits');
  assert.equal(intent.status, 'indeterminate');
  assert.equal(intent.provenBy, undefined);
  assert.equal(intent.count, 1);
  assert.equal(intent.unknownAssetRows.length, 1);
  assert.match(intent.indeterminateReason, /EARLIER layout era/);
  const same = mergeHistoricalRows({ status: 'proven', provenBy: 'x', count: 0, total: '0', rows: [] }, { rows: { rebateRows: [] } }, 'rebateRows');
  assert.equal(same.status, 'proven');
  assert.equal(same.historicalRows, 0);
});

test('aliasing: an earlier-era slot that is a current field today is that field, not an old counter or row (#2095 r3 follow-up)', () => {
  const p = prepareStorageRead({ slots, eras });
  assert.equal(p.ok, true, p.reason);
  assert.equal(aliasOf(slotOf(OLDREL.totalLoansEverCreated), p.occupied), 'someCounterToday');
  assert.equal(aliasOf(slotOf(OLDREL.borrowerLifRebate), p.occupied), null, 'no current field lives at the old rebate head');
  const { contradictions, aliased } = classifyEarlierCounters([
    { which: 'totalLoansEverCreated', slot: slotOf(OLDREL.totalLoansEverCreated), value: '5', eras: [] },
    { which: 'intentLiveCommitCount', slot: slotOf(OLDREL.intentLiveCommitCount), value: '2', eras: [] },
    { which: 'intentLiveCommitCount', slot: slotOf(OLDREL.intentLiveCommitCount + 50), value: '0', eras: [] },
  ], p.occupied);
  assert.deepEqual(aliased.map((a) => a.aliases), ['someCounterToday'], 'the aliased reading is ignored as a counter');
  assert.equal(contradictions.length, 1, 'a non-zero at a slot no field occupies is a contradiction');
  assert.equal(contradictions[0].which, 'intentLiveCommitCount');
  // a row candidate under an old mapping head that is today another mapping's head is ambiguous, and still reported
  const rows = markAliasedRows([{ loanId: '7', orderHash: '0xab', mappingSlot: slotOf(OLDREL.intentCommits) }, { loanId: '8', vpfiHeld: '1', mappingSlot: slotOf(OLDREL.borrowerLifRebate) }, { loanId: '9', vpfiHeld: '2', mappingSlot: slotOf(OLDREL.totalLoansEverCreated) }], p.occupied);
  assert.equal(rows[0].ambiguous, true, 'the old head is a current MAPPING head: same-key rows collide');
  assert.equal(rows[0].aliasesCurrentField, 'otherMapping');
  assert.equal(rows[1].ambiguous, undefined, 'no current field at the old head');
  assert.equal(rows[2].ambiguous, undefined, 'a current VALUE field at the old head occupies one slot, never a hashed row');
  assert.equal(rows[2].oldHeadNowHolds, 'someCounterToday');
  // the merge names the ambiguity
  const merged = mergeHistoricalRows({ status: 'proven', count: 0, total: '0', rows: [] }, { rows: { liveIntentCommits: [rows[0]] } }, 'liveIntentCommits');
  assert.match(merged.indeterminateReason, /alias a current field's rows \(otherMapping\)/);
  // without occupied ranges the read is refused
  const bare = { ...era('headhead1', '2026-09-09T00:00:00Z', HEADREL) }; delete bare.occupied;
  const noOcc = { ...eras, eras: [era('oldold001', '2026-05-10T00:00:00Z', OLDREL), bare] };
  assert.match(prepareStorageRead({ slots, eras: noOcc }).reason, /no occupied-range map/);
});

test('HEAD-slot rows are reconciled with the routed getter both ways, never merged (#2095 r4 P1)', () => {
  const rows = {
    vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '5', mappingSlot: slots.fields.borrowerLifRebate }, { loanId: '2', vpfiHeld: '9', mappingSlot: slotOf(OLDREL.borrowerLifRebate) }],
    rebateRows: [{ loanId: '3', rebateAmount: '4', mappingSlot: slots.fields.borrowerLifRebate }],
    fallbackSnapshotCustody: [],
    liveIntentCommits: [{ loanId: '7', orderHash: '0xab', mappingSlot: slots.fields.intentCommits }],
  };
  const { head, earlier } = splitByHeadSlot(rows, slots.fields);
  assert.deepEqual(head.vpfiHeldCustody.map((r) => r.loanId), ['1']);
  assert.deepEqual(earlier.vpfiHeldCustody.map((r) => r.loanId), ['2'], 'the old-slot row is historical');
  // getter agrees on loan 1 and 3; reported loan 8 that storage does not see at HEAD; did not report loan 7's intent
  const agreement = getterAgreement({ headRows: head, routed: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '5' }, { loanId: '8', vpfiHeld: '1' }], rebateRows: [{ loanId: '3', rebateAmount: '4' }], fallbackSnapshotCustody: [], liveIntentCommits: [] } });
  assert.deepEqual(agreement.rebateRows, []);
  assert.deepEqual(agreement.vpfiHeldCustody, [{ loanId: '8', storage: 'absent at the HEAD slot', getter: 'present' }]);
  assert.deepEqual(agreement.liveIntentCommits, [{ loanId: '7', storage: 'present', getter: 'absent' }]);
  // an amount mismatch is a disagreement too — for a fallback snapshot as well (#2095 r8 P1)
  const amt = getterAgreement({ headRows: head, routed: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '6' }], rebateRows: [{ loanId: '3', rebateAmount: '4' }], fallbackSnapshotCustody: [], liveIntentCommits: [{ loanId: '7' }] } });
  assert.deepEqual(amt.vpfiHeldCustody, [{ loanId: '1', storage: '5', getter: '6' }]);
  assert.deepEqual(amt.liveIntentCommits, []);
  const fbHead = { fallbackSnapshotCustody: [{ loanId: '4', collateralTotal: '10', mappingSlot: slots.fields.fallbackSnapshot }] };
  assert.deepEqual(getterAgreement({ headRows: fbHead, routed: { fallbackSnapshotCustody: [{ loanId: '4', collateralTotal: '9' }] } }).fallbackSnapshotCustody, [{ loanId: '4', storage: '10', getter: '9' }]);
  assert.deepEqual(getterAgreement({ headRows: fbHead, routed: { fallbackSnapshotCustody: [{ loanId: '4', collateralTotal: '10' }] } }).fallbackSnapshotCustody, []);
});

test('without the era-complete read no getter-derived class stays proven (#2095 r5 P1)', () => {
  const classes = {
    vpfiHeldCustody: { status: 'proven', provenBy: undefined, count: 0, total: '0', rows: [] },
    rebateRows: { status: 'proven', provenBy: 'no-loans-ever-created', count: 0, total: '0', rows: [] },
    fallbackSnapshotCustody: { status: 'indeterminate', indeterminateReason: 'already undetermined', count: 0, total: '0', rows: [] },
    liveIntentCommits: { status: 'non-empty', count: 1, total: '5', rows: [{ loanId: '1' }] },
  };
  const out = downgradeWithoutEraRead(classes, 'HEAD mismatch');
  assert.equal(out.vpfiHeldCustody.status, 'indeterminate');
  assert.equal(out.rebateRows.status, 'indeterminate');
  assert.equal(out.rebateRows.provenBy, undefined, 'the routed zero-loans proof is withdrawn too');
  assert.match(out.rebateRows.indeterminateReason, /HEAD mismatch/);
  assert.equal(out.fallbackSnapshotCustody.indeterminateReason, 'already undetermined', 'an already-indeterminate class keeps its reason');
  assert.equal(out.liveIntentCommits.status, 'non-empty', 'a found row is not hidden by the downgrade');
});

test('counter readings are attributed on every path: an old counter slot a current field occupies is that field, not a counter (#2095 r6 P2)', () => {
  const headSlots = { totalLoansEverCreated: '0x' + 'aa'.repeat(32), intentLiveCommitCount: '0x' + 'bb'.repeat(32) };
  const oldTotal = '0x' + '00'.repeat(31) + '10';   // 0x10 — inside a current list's span below
  const oldIntent = '0x' + '00'.repeat(31) + '20';  // 0x20 — inside tierTableVersion's span
  const orphan = '0x' + '00'.repeat(31) + '30';     // 0x30 — no current field
  const occupied = [
    { label: 'activeOfferIdsList', from: '16', to: '16', isMapping: false },
    { label: 'tierTableVersion', from: '32', to: '32', isMapping: false },
  ];
  const counters = {
    nextLoanId: 0n,
    totalLoansEverCreated: [{ slot: headSlots.totalLoansEverCreated, value: 0n, eras: [] }, { slot: oldTotal, value: 4n, eras: [{ date: '2026-05' }] }],
    intentLiveCommitCount: [{ slot: headSlots.intentLiveCommitCount, value: 0n, eras: [] }, { slot: oldIntent, value: 3n, eras: [{ date: '2026-06' }] }],
    allZero: false,
    slotsRead: 5,
  };
  const a = attributeCounters(counters, headSlots, occupied);
  assert.equal(a.counters.allZero, true, 'offers and a tier-table version are not loans or commits');
  assert.deepEqual(a.aliased.map((x) => [x.which, x.value, x.aliases]), [['totalLoansEverCreated', '4', 'activeOfferIdsList'], ['intentLiveCommitCount', '3', 'tierTableVersion']]);
  assert.deepEqual(a.unexplained, []);
  assert.equal(a.counters.intentLiveCommitCount.length, 1, 'the HEAD-slot reading stays');
  // a non-zero at a slot no current field occupies is kept and is unexplained
  const b = attributeCounters({ ...counters, intentLiveCommitCount: [{ slot: headSlots.intentLiveCommitCount, value: 0n, eras: [] }, { slot: orphan, value: 1n, eras: [{ date: '2026-06' }] }] }, headSlots, occupied);
  assert.equal(b.counters.allZero, false);
  assert.deepEqual(b.unexplained.map((x) => [x.which, x.value]), [['intentLiveCommitCount', '1']]);
  // a non-zero at HEAD's slot is the counter today: kept, never unexplained, never aliased
  const c = attributeCounters({ ...counters, totalLoansEverCreated: [{ slot: headSlots.totalLoansEverCreated, value: 7n, eras: [] }] }, headSlots, occupied);
  assert.equal(c.counters.allZero, false);
  assert.deepEqual(c.unexplained.filter((x) => x.which === 'totalLoansEverCreated'), []);
  assert.equal(c.counters.totalLoansEverCreated[0].value, 7n);
});

test('a historical row an older routed getter already returned is not merged twice (#2095 r7 P2)', () => {
  const cls = { status: 'proven', count: 1, total: '5', rows: [{ loanId: '1', vpfiHeld: '5' }] };
  const historical = { rows: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '5', mappingSlot: '0x01' }, { loanId: '2', vpfiHeld: '7', mappingSlot: '0x01' }] } };
  const m = mergeHistoricalRows(cls, historical, 'vpfiHeldCustody');
  assert.equal(m.count, 2, 'loan 1 once, loan 2 once');
  assert.equal(m.total, '12');
  assert.equal(m.historicalRows, 1);
  assert.equal(m.historicalRowsAlreadyReportedByGetter, 1);
  // a different amount for the same key is a different physical row and is kept
  const d = mergeHistoricalRows(cls, { rows: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '6', mappingSlot: '0x01' }] } }, 'vpfiHeldCustody');
  assert.equal(d.count, 2); assert.equal(d.total, '11'); assert.equal(d.historicalRowsAlreadyReportedByGetter, 0);
  // one getter row absorbs at most one historical row: two era rows for one key with the same amount keep one
  const two = mergeHistoricalRows(cls, { rows: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '5', mappingSlot: '0x01' }, { loanId: '1', vpfiHeld: '5', mappingSlot: '0x02' }] } }, 'vpfiHeldCustody');
  assert.equal(two.count, 2); assert.equal(two.historicalRowsAlreadyReportedByGetter, 1);
  // a getter row filed as non-VPFI or unknown-asset counts as reported too (fallback: same key and amount)
  const fb = mergeHistoricalRows({ status: 'proven', count: 0, rows: [], nonVpfiRowsExcluded: [{ loanId: '9', asset: '0xab', collateralTotal: '3' }] }, { rows: { fallbackSnapshotCustody: [{ loanId: '9', collateralTotal: '3', mappingSlot: '0x01' }] } }, 'fallbackSnapshotCustody');
  assert.equal(fb.status, 'proven', 'nothing new to merge'); assert.equal(fb.historicalRowsAlreadyReportedByGetter, 1);
  // an intent row is NEVER absorbed (#2095 r8 P1): the getter does not expose the orderHash, so commit A under an old
  // layout and commit B under today's for the same loan are distinct candidates — A survives as unknown-asset
  const intent = mergeHistoricalRows({ status: 'proven', count: 1, rows: [], nonVpfiRowsExcluded: [{ loanId: '9', asset: '0xab' }] }, { rows: { liveIntentCommits: [{ loanId: '9', orderHash: '0xcd', mappingSlot: '0x01' }] } }, 'liveIntentCommits');
  assert.equal(intent.status, 'indeterminate');
  assert.equal(intent.historicalRowsAlreadyReportedByGetter, 0);
  assert.deepEqual(intent.unknownAssetRows.map((r) => r.orderHash), ['0xcd']);
});

test('a non-zero at an old counter slot that is now a MAPPING head is a stale counter, not the mapping (#2095 r9 P1)', () => {
  const occupied = [
    { label: 'lastUpdateDayId', from: '32', to: '32', isMapping: true },
    { label: 'activeOfferIdsList', from: '16', to: '16', isMapping: false },
  ];
  const at = (n) => '0x' + n.toString(16).padStart(64, '0');
  const readings = [
    { which: 'intentLiveCommitCount', slot: at(32), value: '2', eras: [{ date: '2026-06' }] },
    { which: 'totalLoansEverCreated', slot: at(16), value: '4', eras: [{ date: '2026-05' }] },
  ];
  const { contradictions, aliased } = classifyEarlierCounters(readings, occupied);
  assert.deepEqual(aliased.map((x) => [x.which, x.aliases]), [['totalLoansEverCreated', 'activeOfferIdsList']], 'an array length explains a non-zero');
  assert.deepEqual(contradictions.map((x) => [x.which, x.atMappingHead]), [['intentLiveCommitCount', 'lastUpdateDayId']], 'a mapping head holds nothing — the reading is the old counter');
  // and through attributeCounters the stale live-commit counter stays a contradiction candidate
  const headSlots = { totalLoansEverCreated: at(999), intentLiveCommitCount: at(998) };
  const a = attributeCounters({ nextLoanId: 0n, totalLoansEverCreated: [{ slot: at(16), value: 4n, eras: [] }], intentLiveCommitCount: [{ slot: at(32), value: 2n, eras: [] }], allZero: false, slotsRead: 3 }, headSlots, occupied);
  assert.equal(a.counters.allZero, false);
  assert.deepEqual(a.unexplained.map((x) => [x.which, x.value, x.atMappingHead]), [['intentLiveCommitCount', '2', 'lastUpdateDayId']]);
});

test('an era whose row member has the same slot but a narrower type is refused (#2095 r9 P2)', () => {
  const ok = prepareStorageRead({ slots, eras });
  assert.equal(ok.ok, true, ok.reason);
  const narrowed = JSON.parse(JSON.stringify(eras));
  const e = narrowed.eras.find((x) => x.commit !== narrowed.head && x.rows?.FallbackSnapshot);
  e.rows.FallbackSnapshot.borrowerCollateral.type = 't_uint128';
  const r = prepareStorageRead({ slots, eras: narrowed });
  assert.equal(r.ok, false);
  assert.match(r.reason, /borrowerCollateral as t_uint128, not t_uint256/);
});

test('a facet is attributed to the era whose catalogue holds its code hash; unknown code refuses; empty code never wrote (#2095 r9 P1)', () => {
  const erasT = [
    { commit: 'a'.repeat(40), date: '2026-05-10T00:00:00Z', bytecode: { '0x11': 'RiskFacet' } },
    { commit: 'b'.repeat(40), date: '2026-07-01T00:00:00Z', bytecode: { '0x11': 'RiskFacet', '0x22': 'DefaultedFacet' } },
  ];
  const EMPTY = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
  const r = attributeFacetCode({ facets: [
    { address: '0xA', codeHash: '0x11', sources: ['loupe'] },
    { address: '0xB', codeHash: '0x22', sources: ['record'] },
    { address: '0xC', codeHash: '0x33', sources: ['cut-history'] },
    { address: '0xD', codeHash: EMPTY, sources: ['record'] },
  ], eras: erasT });
  assert.equal(r.verdict, 'unattributed');
  assert.deepEqual(r.attributed.map((x) => [x.address, x.name, x.eras.length]), [['0xA', 'RiskFacet', 2], ['0xB', 'DefaultedFacet', 1]]);
  assert.deepEqual(r.unattributed.map((x) => x.address), ['0xC']);
  assert.deepEqual(r.noCode.map((x) => x.address), ['0xD']);
  assert.equal(attributeFacetCode({ facets: [{ address: '0xA', codeHash: '0x11', sources: [] }], eras: erasT }).verdict, 'attributed');
  const d = downgradeProvenClasses({ a: { status: 'proven', provenBy: 'x' }, b: { status: 'indeterminate', indeterminateReason: 'kept' } }, 'why');
  assert.deepEqual(d, { a: { status: 'indeterminate', provenBy: undefined, indeterminateReason: 'why' }, b: { status: 'indeterminate', indeterminateReason: 'kept' } });
});

test('a state response that is not hex data throws instead of reading as zero or empty (#2095 r10 P1)', () => {
  assert.equal(requireHexData('0x', 'code'), '0x');
  assert.equal(requireHexData('0x00ff', 'slot'), '0x00ff');
  for (const bad of [null, undefined, '', '0x0', 'ff', 0, {}, '0xzz']) assert.throws(() => requireHexData(bad, 'slot'), /malformed state response/, `${JSON.stringify(bad)}`);
});

test('the facet population is exhaustive only with a read history that holds the deploy-time cut and every routed facet (#2095 r10 P1)', () => {
  const ok = cutHistoryCompleteness({ verdict: 'read', cuts: 3, constructorCutSeen: true, addresses: ['0xa', '0xb'], loupe: ['0xA', '0xb', '0xCUT'], cutFacetHost: '0xcut' });
  assert.deepEqual(ok, { complete: true, reasons: [] }, 'the constructor-installed cut facet never appears as an Add and is exempt');
  assert.match(cutHistoryCompleteness({ verdict: 'empty', cuts: 0, constructorCutSeen: false, addresses: [], loupe: ['0xa'] }).reasons.join(' '), /empty/);
  assert.match(cutHistoryCompleteness({ verdict: 'unreadable', cuts: 0, constructorCutSeen: false, addresses: [], loupe: null }).reasons.join(' '), /unreadable/);
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 2, constructorCutSeen: false, addresses: ['0xa'], loupe: ['0xa'] }).reasons.join(' '), /constructor's empty DiamondCut/);
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 2, constructorCutSeen: true, addresses: ['0xa'], loupe: ['0xa', '0xc'] }).reasons.join(' '), /1 facet\(s\) the loupe routes today never appear/);
  assert.equal(cutHistoryCompleteness({ verdict: 'read', cuts: 1, constructorCutSeen: true, addresses: [], loupe: null }).complete, true, 'a shell with no loupe: the history alone decides');
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 1, constructorCutSeen: true, addresses: [], loupe: null, loupeReadFailed: true }).reasons.join(' '), /facets\(\) but the call failed/, 'a loupe that failed to answer is an incomplete population (#2095 r17)');
  // an address the cut history names with empty code is unreadable, not "never wrote"; a record-only one may be
  const att = { attributed: [], unattributed: [], noCode: [{ address: '0x1', sources: ['cut-history'] }, { address: '0x2', sources: ['record:live'] }, { address: '0x3', sources: ['cut-history:initializer'] }], verdict: 'attributed' };
  refuseUnreadableCutSources(att);
  assert.deepEqual(att.noCode.map((x) => x.address), ['0x2']);
  assert.deepEqual(att.unattributed.map((x) => [x.address, /initializer/.test(x.note)]), [['0x1', false], ['0x3', true]]);
  assert.equal(att.verdict, 'unattributed');
  // routed standard: a storage-only proof still falls on a provenance refusal; a routed proof keeps
  const d = downgradeStorageOnlyProofs({ a: { status: 'proven', provenBy: undefined }, b: { status: 'proven', provenBy: 'no-loans-ever-created' }, c: { status: 'proven', provenBy: 'no-loans-ever-created-by-storage' }, e: { status: 'proven', provenBy: 'storage-read-calibrated' } }, 'why');
  assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.status])), { a: 'proven', b: 'proven', c: 'indeterminate', e: 'indeterminate' });
});
