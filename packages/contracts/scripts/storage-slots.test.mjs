// storage-slots.test.mjs — the census's row-slot arithmetic reproduces the rows
// the COMPILER loaded (pinned by forge into storage-slots.json, #1566 §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSlots, rowSlot, memberSlot } from './storage-slots.mjs';
import { slotsFromLayout, occupiedRangesFromLayout } from './storage-layout-eras.mjs';
import { storagePositionOf } from './storage-layout-provenance.mjs';

test('rowSlot/memberSlot reproduce the compiler-loaded example rows in storage-slots.json', () => {
  const s = loadSlots();
  assert.equal(rowSlot(s.example.loanId, s.fields.intentCommits), s.example.intentCommitsOrderHash, 'intentCommits[1].orderHash = row + 0');
  assert.equal(rowSlot(s.example.loanId, s.fields.borrowerLifRebate), s.example.borrowerLifRebateVpfiHeld, 'borrowerLifRebate[1].vpfiHeld = row + 0');
  assert.equal(memberSlot(s.example.loanId, s.fields.borrowerLifRebate, 1), s.example.borrowerLifRebateRebateAmount, 'borrowerLifRebate[1].rebateAmount = row + 1');
  assert.equal(memberSlot(s.example.loanId, s.fields.fallbackSnapshot, 5), s.example.fallbackSnapshotActive, 'fallbackSnapshot[1].active = row + 5');
  // the loan counter is the base + 1, as the design records (ids are assigned as ++nextLoanId)
  assert.equal(BigInt(s.fields.nextLoanId) - BigInt(s.storagePosition), 1n);
});

test('slotsFromLayout: relative member slots become absolute against the era position; a missing field is null, not zero', () => {
  const layout = {
    storage: [{ label: 's', slot: '0', offset: 0, type: 't_struct(Storage)1_storage' }],
    types: {
      't_struct(Storage)1_storage': { members: [{ label: 'nextLoanId', slot: '1', offset: 0, type: 't_uint256' }, { label: 'intentCommits', slot: '194', offset: 0, type: 't_mapping(t_uint256,t_struct(SwapToRepayIntentCommit)2_storage)' }] },
      't_struct(SwapToRepayIntentCommit)2_storage': { members: [{ label: 'orderHash', slot: '0', offset: 0, type: 't_bytes32' }, { label: 'deadline', slot: '1', offset: 0, type: 't_uint64' }] },
    },
  };
  const pos = '0x' + '00'.repeat(31) + '10';
  const r = slotsFromLayout(layout, pos, ['nextLoanId', 'intentCommits', 'borrowerLifRebate'], ['SwapToRepayIntentCommit', 'BorrowerLifRebate']);
  assert.equal(r.fields.nextLoanId.slot, '0x' + '00'.repeat(31) + '11');
  assert.equal(r.fields.intentCommits.slot, '0x' + (0x10n + 194n).toString(16).padStart(64, '0'));
  assert.equal(r.fields.borrowerLifRebate, null, 'a field absent from that era is NULL — the era simply had no such slot');
  assert.deepEqual(r.rows.SwapToRepayIntentCommit.orderHash, { slot: 0, offset: 0, type: 't_bytes32' });
  assert.equal(r.rows.BorrowerLifRebate, null);
});

test('storagePositionOf: the ERC-7201 constant when declared, the plain hash for pre-7201 source, null otherwise', () => {
  assert.deepEqual(storagePositionOf('bytes32 internal constant VANGKI_STORAGE_POSITION = 0x' + 'AB'.repeat(32) + ';'), { position: '0x' + 'ab'.repeat(32), derivation: 'VANGKI_STORAGE_POSITION constant (ERC-7201)' });
  const plain = storagePositionOf('bytes32 position = keccak256("vaipakam.storage");');
  assert.equal(plain.derivation, 'keccak256("vaipakam.storage") (pre-ERC-7201 source)');
  assert.match(plain.position, /^0x[0-9a-f]{64}$/);
  assert.equal(storagePositionOf('nothing here'), null);
});

test('occupiedRangesFromLayout: one head slot per mapping, numberOfBytes-wide spans for value and inline types', () => {
  const layout = {
    storage: [{ label: 's', slot: '0', offset: 0, type: 't_struct(Storage)1_storage' }],
    types: {
      't_struct(Storage)1_storage': { members: [{ label: 'nextLoanId', slot: '1', offset: 0, type: 't_uint256' }, { label: 'cfg', slot: '2', offset: 0, type: 't_struct(Config)9_storage' }, { label: 'intentCommits', slot: '5', offset: 0, type: 't_mapping(t_uint256,t_struct(X)2_storage)' }] },
      't_uint256': { numberOfBytes: '32' },
      't_struct(Config)9_storage': { numberOfBytes: '96' },
      't_mapping(t_uint256,t_struct(X)2_storage)': { numberOfBytes: '32' },
    },
  };
  const r = occupiedRangesFromLayout(layout, '0x' + '00'.repeat(31) + '10');
  const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
  assert.deepEqual(r.map((x) => [x.label, x.from, x.to, x.isMapping]), [['nextLoanId', hex(0x11n), hex(0x11n), false], ['cfg', hex(0x12n), hex(0x14n), false], ['intentCommits', hex(0x15n), hex(0x15n), true]]);
});
