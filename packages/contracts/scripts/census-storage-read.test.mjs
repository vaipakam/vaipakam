// census-storage-read.test.mjs — the era-complete storage read's rules (#1566 §7/§7a), over fake readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, ROW } from './census-storage-read.mjs';
import { memberSlot, rowSlot } from './storage-slots.mjs';

const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const base = 0x1000n;
const slotOf = (rel) => H(base + BigInt(rel));
const era = (commit, date, rel, withRows = true) => ({
  commit, date, storagePosition: H(base),
  fields: Object.fromEntries(Object.entries(rel).map(([f, r]) => [f, r === null ? null : { slot: slotOf(r), relative: r, offset: 0 }])),
  rows: withRows ? {
    SwapToRepayIntentCommit: rel.intentCommits === null ? null : { orderHash: { slot: 0, offset: 0 }, deadline: { slot: 1, offset: 0 } },
    BorrowerLifRebate: { vpfiHeld: { slot: 0, offset: 0 }, rebateAmount: { slot: 1, offset: 0 } },
    FallbackSnapshot: { lenderCollateral: { slot: 0, offset: 0 }, treasuryCollateral: { slot: 1, offset: 0 }, borrowerCollateral: { slot: 2, offset: 0 }, active: { slot: 5, offset: 0 } },
  } : {},
});
const HEADREL = { nextLoanId: 1, totalLoansEverCreated: 86, intentLiveCommitCount: 193, intentCommits: 194, borrowerLifRebate: 137, fallbackSnapshot: 45 };
const OLDREL = { nextLoanId: 1, totalLoansEverCreated: 90, intentLiveCommitCount: 200, intentCommits: 201, borrowerLifRebate: 140, fallbackSnapshot: 45 };
const slots = { storagePosition: H(base), fields: Object.fromEntries(Object.entries(HEADREL).map(([f, r]) => [f, slotOf(r)])) };
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
