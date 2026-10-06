// census-storage-read.test.mjs — the era-complete storage read's rules (#1566 §7/§7a), over fake readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, aliasOf, classifyEarlierCounters, markAliasedRows, splitByHeadSlot, getterAgreement, amountsAgree, attributeCounters, attributeFacetCode, requireHexData, cutHistoryCompleteness, refuseUnreadableCutSources, gettersShareLayout, deriveLiabilityAggregates, ROW } from './census-storage-read.mjs';
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
  // reads only: no per-field era count beside the slot lists, and no asset on a
  // storage row (storage holds amounts; the judge files a storage row's asset as unread)
  assert.deepEqual(Object.keys(r).sort(), ['loansScanned', 'rows', 'slotsRead', 'slotsScanned']);
  assert.ok(Object.values(r.rows).flat().every((x) => !('asset' in x)), 'a storage row names no asset it never read');
  // every slot zero: every class empty
  const empty = await scanRowsByStorage({ readSlot: async () => 0n, loanIds: [1n, 2n], eraSlots: p.eraSlots });
  assert.deepEqual(Object.values(empty.rows).map((x) => x.length), [0, 0, 0, 0]);
  // a subset of classes reads only what it needs
  const only = await scanRowsByStorage({ readSlot, loanIds: [7n], eraSlots: p.eraSlots, classes: ['liveIntentCommits'] });
  assert.equal(only.rows.liveIntentCommits.length, 1);
  assert.equal(only.rows.vpfiHeldCustody, undefined);
  // the slot set the read stood for, per mapping field — what the judge's
  // era-coverage compares with the table it judges WITH, so a regenerated
  // table names any slot this read never covered (#2095 root arrest, S2-9)
  for (const f of ['borrowerLifRebate', 'fallbackSnapshot', 'intentCommits']) assert.deepEqual(r.slotsScanned[f], p.eraSlots[f].map((x) => x.slot), f);
  assert.deepEqual(Object.keys(only.slotsScanned), ['intentCommits'], 'a subset scan claims only the fields it read');
  const noIds = await scanRowsByStorage({ readSlot, loanIds: [], eraSlots: p.eraSlots });
  assert.deepEqual(noIds.slotsScanned.intentCommits, p.eraSlots.intentCommits.map((x) => x.slot), 'a zero-loan scan still records the layouts it stood for');
});

test('readCountersByStorage: nextLoanId at its one slot and every counter at every era slot, raw — no summary of them', async () => {
  const p = prepareStorageRead({ slots, eras });
  const zero = await readCountersByStorage({ readSlot: async () => 0n, eraSlots: p.eraSlots });
  // the reader returns readings only: whether they bound anything is the
  // judge's call over the KEPT readings, and a summary over the raw ones once
  // disagreed with it (#2095 root arrest)
  assert.deepEqual(Object.keys(zero).sort(), ['intentLiveCommitCount', 'nextLoanId', 'slotsRead', 'slotsScanned', 'totalLoansEverCreated']);
  assert.equal(zero.nextLoanId, 0n);
  for (const f of ['totalLoansEverCreated', 'intentLiveCommitCount']) assert.deepEqual(zero[f].map((x) => [x.slot, x.value]), p.eraSlots[f].map((x) => [x.slot, 0n]), `${f}: one reading per era slot`);
  assert.equal(zero.slotsRead, 1 + 2 + 2);
  assert.deepEqual(zero.slotsScanned, { nextLoanId: p.eraSlots.nextLoanId.map((x) => x.slot), totalLoansEverCreated: p.eraSlots.totalLoansEverCreated.map((x) => x.slot), intentLiveCommitCount: p.eraSlots.intentLiveCommitCount.map((x) => x.slot) }, 'every counter era slot the read covered');
  const oldCounter = await readCountersByStorage({ readSlot: async (s) => (s === slotOf(OLDREL.totalLoansEverCreated) ? 4n : 0n), eraSlots: p.eraSlots });
  assert.deepEqual(oldCounter.totalLoansEverCreated.filter((x) => x.value !== 0n).map((x) => x.slot), [slotOf(OLDREL.totalLoansEverCreated)], 'a counter left non-zero at an OLD era slot is read and reported there');
  assert.equal(oldCounter.totalLoansEverCreated.find((x) => x.value === 4n).eras[0].commit, 'oldold001');
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

test('amountsAgree is the ONE amounts-agree predicate: a whole amount agrees in either spelling, and an amount nobody can read agrees with nothing, itself included — on the agreement path too', () => {
  assert.equal(amountsAgree(5n, '5'), true, 'the collector holds bigints, a committed ledger their decimal strings');
  assert.equal(amountsAgree('5', '6'), false);
  for (const v of [null, undefined, 'x', '-1', 1.5, {}]) assert.equal(amountsAgree(v, v), false, `${String(v)} agreed with itself`);
  // getterAgreement used to compare String(null) === String(null) and agree,
  // while the merge refused the same pair — one row counted twice under proof
  for (const v of [null, 'x']) {
    const m = getterAgreement({ headRows: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: v }] }, routed: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: v }] } }).vpfiHeldCustody;
    assert.deepEqual(m, [{ loanId: '1', storage: v === null ? 'no amount read' : v, getter: v === null ? 'no amount read' : v }], `${String(v)}: two unreadable amounts read as agreement`);
  }
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
    slotsRead: 5,
  };
  const kept = (x) => [...x.counters.totalLoansEverCreated, ...x.counters.intentLiveCommitCount];
  const a = attributeCounters(counters, headSlots, occupied);
  assert.ok(kept(a).every((x) => x.value === 0n), 'offers and a tier-table version are not loans or commits: every KEPT reading is zero');
  assert.deepEqual(a.aliased.map((x) => [x.which, x.value, x.aliases]), [['totalLoansEverCreated', '4', 'activeOfferIdsList'], ['intentLiveCommitCount', '3', 'tierTableVersion']]);
  assert.deepEqual(a.unexplained, []);
  assert.equal(a.counters.intentLiveCommitCount.length, 1, 'the HEAD-slot reading stays');
  // a non-zero at a slot no current field occupies is kept and is unexplained
  const b = attributeCounters({ ...counters, intentLiveCommitCount: [{ slot: headSlots.intentLiveCommitCount, value: 0n, eras: [] }, { slot: orphan, value: 1n, eras: [{ date: '2026-06' }] }] }, headSlots, occupied);
  assert.deepEqual(kept(b).filter((x) => x.value !== 0n).map((x) => [x.slot, x.value]), [[orphan, 1n]], 'the unexplained reading is KEPT');
  assert.deepEqual(b.unexplained.map((x) => [x.which, x.value]), [['intentLiveCommitCount', '1']]);
  // a non-zero at HEAD's slot is the counter today: kept, never unexplained, never aliased
  const c = attributeCounters({ ...counters, totalLoansEverCreated: [{ slot: headSlots.totalLoansEverCreated, value: 7n, eras: [] }] }, headSlots, occupied);
  assert.deepEqual(c.unexplained.filter((x) => x.which === 'totalLoansEverCreated'), []);
  assert.equal(c.counters.totalLoansEverCreated[0].value, 7n);
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
  const a = attributeCounters({ nextLoanId: 0n, totalLoansEverCreated: [{ slot: at(16), value: 4n, eras: [] }], intentLiveCommitCount: [{ slot: at(32), value: 2n, eras: [] }], slotsRead: 3 }, headSlots, occupied);
  assert.deepEqual(a.counters.intentLiveCommitCount.map((x) => [x.slot, x.value]), [[at(32), 2n]], 'the stale live-commit reading is KEPT — the zero bound reads it');
  assert.deepEqual(a.unexplained.map((x) => [x.which, x.value, x.atMappingHead]), [['intentLiveCommitCount', '2', 'lastUpdateDayId']]);
});

test('a slot table missing a census field is refused (#2095 r20 P1)', () => {
  const { fallbackSnapshot, ...fewer } = slots.fields;
  const r = prepareStorageRead({ slots: { ...slots, fields: fewer }, eras });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lacks the pinned slot of fallbackSnapshot/);
});

test('an era whose census field has an unsupported schema or a packed offset is refused (#2095 r21 P1)', () => {
  const nested = JSON.parse(JSON.stringify(eras));
  const e = nested.eras.find((x) => x.commit !== nested.head);
  e.fields.intentCommits.type = 't_mapping(t_uint256,t_mapping(t_address,t_struct(SwapToRepayIntentCommit)1234_storage))';
  assert.match(prepareStorageRead({ slots, eras: nested }).reason, /declares intentCommits as .* a schema the census cannot read/);
  const typed = JSON.parse(JSON.stringify(eras));
  typed.eras[0].fields.intentCommits.type = 't_mapping(t_uint256,t_struct(SwapToRepayIntentCommit)99_storage)'; // a per-build struct id is fine
  typed.eras[0].fields.nextLoanId.type = 't_uint256';
  assert.equal(prepareStorageRead({ slots, eras: typed }).ok, true);
  const packed = JSON.parse(JSON.stringify(eras));
  packed.eras[0].fields.totalLoansEverCreated.offset = 16;
  assert.match(prepareStorageRead({ slots, eras: packed }).reason, /at offset 16/);
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
  // round-3 review P2 — only the empty-code hash is "no code": a hash nobody read is unattributed, never "never wrote"
  const unread = attributeFacetCode({ facets: [null, undefined, 12345, ''].map((codeHash, i) => ({ address: `0xE${i}`, codeHash, sources: ['record:live'] })), eras: erasT });
  assert.deepEqual(unread.noCode, []);
  assert.deepEqual(unread.unattributed.map((x) => x.note), Array(4).fill('its code hash was never read'));
  assert.equal(unread.verdict, 'unattributed');
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
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 1, constructorCutSeen: true, addresses: [], loupe: null }).reasons.join(' '), /loupe is unrouted/, 'no loupe: the current facet set is unknown, so the population is not exhaustive (#2095 r23)');
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 1, constructorCutSeen: true, addresses: [], loupe: null, loupeReadFailed: true }).reasons.join(' '), /facets\(\) but the call failed/, 'a loupe that failed to answer is an incomplete population (#2095 r17)');
  // a recorded facet the history never added: on a routed Diamond the endpoint omitted a cut; on a shell it was never cut (#2095 r18)
  assert.match(cutHistoryCompleteness({ verdict: 'read', cuts: 2, constructorCutSeen: true, addresses: ['0xa'], loupe: ['0xa'], recordedFacets: ['0xA', '0xOLD'] }).reasons.join(' '), /1 facet\(s\) the records name were never added/);
  assert.equal(cutHistoryCompleteness({ verdict: 'read', cuts: 2, constructorCutSeen: true, addresses: ['0xa'], loupe: ['0xa', '0xcut'], cutFacetHost: '0xcut', recordedFacets: ['0xa', '0xcut'] }).complete, true, 'the constructor-installed cut facet is exempt here too');
  assert.deepEqual(cutHistoryCompleteness({ verdict: 'read', cuts: 1, constructorCutSeen: true, addresses: [], loupe: null, recordedFacets: ['0xnever'] }).reasons.filter((r) => /records name/.test(r)), [], 'a shell: recorded facets absent from the history are not an omission (the loupe reason stands alone)');
  // an address the cut history names with empty code is unreadable, not "never wrote"; a record-only one may be
  const att = { attributed: [], unattributed: [], noCode: [{ address: '0x1', sources: ['cut-history'] }, { address: '0x2', sources: ['record:live'] }, { address: '0x3', sources: ['cut-history:initializer'] }], verdict: 'attributed' };
  refuseUnreadableCutSources(att, { addresses: ['0x1', '0x3'], initializers: ['0x3'] });
  assert.deepEqual(att.noCode.map((x) => x.address), ['0x2']);
  assert.deepEqual(att.unattributed.map((x) => [x.address, /initializer/.test(x.note)]), [['0x1', false], ['0x3', true]]);
  assert.equal(att.verdict, 'unattributed');
  // round-3 review P2 — MEMBERSHIP in the cut history decides, not the entry's
  // label: a record-labelled address the history names is refused, its
  // published sources gaining the membership; a cut-labelled one the history
  // omits still refuses (a label can only refuse); the record-only one stays
  const byList = { attributed: [], unattributed: [], noCode: [{ address: '0xAA', sources: ['record:live'] }, { address: '0xbb', sources: [] }, { address: '0xcc', sources: ['cut-history'] }, { address: '0xdd', sources: ['record:live'] }], verdict: 'attributed' };
  refuseUnreadableCutSources(byList, { addresses: ['0xaa', '0xbb'], initializers: ['0xBB'] });
  assert.deepEqual(byList.unattributed.map((x) => [x.address, x.sources, /initializer/.test(x.note)]), [['0xAA', ['record:live', 'cut-history'], false], ['0xbb', ['cut-history:initializer'], true], ['0xcc', ['cut-history'], false]]);
  assert.deepEqual(byList.noCode.map((x) => x.address), ['0xdd']);
  assert.throws(() => refuseUnreadableCutSources({ attributed: [], unattributed: [], noCode: [] }), /cut history is required/, 'a caller that hands in no cut history would decide by the label alone');
});

test('the snapshot getter and the loan getter must attribute to a common layout for an excluded fallback row to be scoped (#2095 r24 P1)', () => {
  const attributed = [
    { address: '0xClaim', eras: [{ commit: 'e1', layoutEra: 'e1' }, { commit: 'b7', layoutEra: 'e2' }] },
    { address: '0xLoanOld', eras: [{ commit: 'e0', layoutEra: 'e0' }] },
    { address: '0xLoanNew', eras: [{ commit: 'e2', layoutEra: 'e2' }] },
  ];
  assert.equal(gettersShareLayout(attributed, ['0xclaim', '0xloannew']).shared, true, 'a deployment build attributed to era e2 shares with the era');
  assert.equal(gettersShareLayout(attributed, ['0xClaim', '0xLoanOld']).shared, false, 'different layouts');
  assert.equal(gettersShareLayout(attributed, ['0xClaim', '0xClaim']).shared, true, 'one facet hosting both');
  assert.match(gettersShareLayout(attributed, [null, '0xClaim']).reason, /host is unknown/);
  assert.match(gettersShareLayout(attributed, ['0xClaim', '0xNobody']).reason, /unattributed/);
  // the token getter joins: three hosts must share (#2095 r25 P1)
  const withToken = [...attributed, { address: '0xToken', eras: [{ commit: 'e2', layoutEra: 'e2' }] }, { address: '0xTokenOld', eras: [{ commit: 'e0', layoutEra: 'e0' }] }];
  assert.equal(gettersShareLayout(withToken, ['0xClaim', '0xLoanNew', '0xToken']).shared, true);
  assert.equal(gettersShareLayout(withToken, ['0xClaim', '0xLoanNew', '0xTokenOld']).shared, false, 'a token getter on another layout breaks the exclusion');
});

test('#2095 r27 + S1-R5 — the liability aggregates are derived from ESTABLISHED classes only, and a shortfall only against an on-chain token', () => {
  // established = the judge gave the class a proof chain; the helper keys on
  // that evidence, never on a status word a caller could have written
  const chain = [{ kind: 'range', source: 'storage', detail: 'nextLoanId=5' }];
  const est = (c) => ({ evidence: chain, reasons: [], ...c });
  const rows = {
    vpfiHeldCustody: est({ count: 1, total: '10', rows: [{ vpfiHeld: '10' }] }),
    rebateRows: est({ count: 1, total: '5', rows: [{ rebateAmount: '5' }] }),
    fallbackSnapshotCustody: est({ count: 1, total: '20', rows: [{ collateralTotal: '20' }] }),
    liveIntentCommits: est({ count: 0, total: '0', rows: [] }),
  };
  const onChain = { vpfiToken: '0xt1', source: 'on-chain' };
  // nothing withdrawn: the derivation states the figures, shortfall included
  const clean = deriveLiabilityAggregates({ classes: rows, diamondVpfiBacking: '30', scope: onChain });
  assert.equal(clean.vpfiRowsTotal, '35');
  assert.equal(clean.backingShortfall, '5');
  assert.equal(clean.vpfiRowsTotalUnavailable, undefined);

  const covered = deriveLiabilityAggregates({ classes: rows, diamondVpfiBacking: '100', scope: onChain });
  assert.equal(covered.backingShortfall, '0', 'backing above the liability is a real zero, not a withdrawal');

  // THE REGRESSION (r27): the scope downgrade emptied `rows` into unknown-asset
  // evidence and withdrew the class total AFTER these two figures were
  // written. They kept publishing the amount as a substantiated liability.
  const downgraded = {
    ...rows,
    fallbackSnapshotCustody: { evidence: [], reasons: [{ obligation: 'asset-settled', detail: 'hosts do not share a layout' }], count: 1, total: null, totalUnavailable: 'the asset of every row is unreconciled — the getters do not attribute to a common layout', rows: [], unknownAssetRows: [{ collateralTotal: '20' }] },
  };
  const w = deriveLiabilityAggregates({ classes: downgraded, diamondVpfiBacking: '30', scope: onChain });
  assert.equal(w.vpfiRowsTotal, null, 'a liability no class can total is not stated');
  assert.notEqual(w.vpfiRowsTotal, '15', 'and it is NOT re-derived from the surviving rows, which would understate it');
  assert.match(w.vpfiRowsTotalUnavailable, /fallbackSnapshotCustody/);
  assert.equal(w.backingShortfall, null, 'no shortfall is computable against a liability that is not stated');
  assert.match(w.backingShortfallUnavailable, /not stated/);

  // an unestablished class still carrying a total contributes nothing: its
  // total is a lower bound at best, and summing it would state a completeness
  // nothing proved
  const unestablished = { ...rows, liveIntentCommits: { evidence: [], reasons: [{ obligation: 'getter-coverage', detail: 'getIntentCommit asked over 1..2 of 1..5' }], count: 0, total: '0', rows: [] } };
  const u = deriveLiabilityAggregates({ classes: unestablished, diamondVpfiBacking: '30', scope: onChain });
  assert.equal(u.vpfiRowsTotal, null);
  assert.match(u.vpfiRowsTotalUnavailable, /liveIntentCommits is not established/);
  assert.equal(u.backingShortfall, null);

  // a status word without a chain is not establishment (the root arrest: the
  // judge is the only writer of `proven`, and it always writes the chain)
  const labelled = { ...rows, rebateRows: { status: 'proven', count: 1, total: '5', rows: [{ rebateAmount: '5' }] } };
  assert.equal(deriveLiabilityAggregates({ classes: labelled, diamondVpfiBacking: '30', scope: onChain }).vpfiRowsTotal, null);

  // an unreadable Diamond balance withholds the shortfall and says so
  const noBacking = deriveLiabilityAggregates({ classes: rows, diamondVpfiBacking: null, scope: onChain });
  assert.equal(noBacking.vpfiRowsTotal, '35');
  assert.equal(noBacking.backingShortfall, null);
  assert.match(noBacking.backingShortfallUnavailable, /balance could not be read/);

  // S1-R5 — a balance of an artifact-sourced (possibly rotated-away) token is
  // no backing figure: the liability stands, the shortfall is withheld; the
  // scope is read off a verdict's ledger as well
  for (const scoped of [{ scope: { vpfiToken: '0xt1', source: 'artifact' } }, { ledger: { scope: { vpfiToken: null, source: null } } }]) {
    const a = deriveLiabilityAggregates({ classes: rows, diamondVpfiBacking: '30', ...scoped });
    assert.equal(a.vpfiRowsTotal, '35');
    assert.equal(a.backingShortfall, null);
    assert.match(a.backingShortfallUnavailable, /not read from the chain/);
  }
});

