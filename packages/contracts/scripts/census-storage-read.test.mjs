// census-storage-read.test.mjs — the era-complete storage read's rules (#1566 §7/§7a), over fake readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, intentVerdictFromStorage, eraSlotsExcept, mergeHistoricalRows, aliasOf, classifyEarlierCounters, markAliasedRows, splitByHeadSlot, getterAgreement, downgradeWithoutEraRead, attributeCounters, ROW } from './census-storage-read.mjs';
import { memberSlot, rowSlot } from './storage-slots.mjs';

const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const base = 0x1000n;
const slotOf = (rel) => H(base + BigInt(rel));
const era = (commit, date, rel, withRows = true) => ({
  commit, date, storagePosition: H(base),
  ...(commit === 'headhead1' ? { occupied: OCCUPIED_FOR_HEAD } : {}),
  fields: Object.fromEntries(Object.entries(rel).map(([f, r]) => [f, r === null ? null : { slot: slotOf(r), relative: r, offset: 0 }])),
  rows: withRows ? {
    SwapToRepayIntentCommit: rel.intentCommits === null ? null : { orderHash: { slot: 0, offset: 0 }, deadline: { slot: 1, offset: 0 } },
    BorrowerLifRebate: { vpfiHeld: { slot: 0, offset: 0 }, rebateAmount: { slot: 1, offset: 0 } },
    FallbackSnapshot: { lenderCollateral: { slot: 0, offset: 0 }, treasuryCollateral: { slot: 1, offset: 0 }, borrowerCollateral: { slot: 2, offset: 0 }, active: { slot: 5, offset: 0 } },
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
  // an amount mismatch is a disagreement too
  const amt = getterAgreement({ headRows: head, routed: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: '6' }], rebateRows: [{ loanId: '3', rebateAmount: '4' }], fallbackSnapshotCustody: [], liveIntentCommits: [{ loanId: '7' }] } });
  assert.deepEqual(amt.vpfiHeldCustody, [{ loanId: '1', storage: '5', getter: '6' }]);
  assert.deepEqual(amt.liveIntentCommits, []);
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
