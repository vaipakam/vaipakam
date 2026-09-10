/**
 * census-storage-read.mjs — the ERA-COMPLETE storage read the custody census
 * uses where a Diamond routes no getter (#1566, design §7 + §7a).
 *
 * Pure over an injected `readSlot(slotHex) → Promise<bigint>`, so the rules
 * are unit-tested with a fake reader and the census supplies the hash-pinned
 * `eth_getStorageAt`. Two tables feed it, both compiler-generated and both
 * pinned by test: `storage-slots.json` (HEAD, forge probe) and
 * `storage-slot-eras.json` (every layout era since the walk began).
 *
 * What it certifies: a row is ABSENT only when it reads zero at EVERY era's
 * slot for that mapping; a Diamond has NO LOANS only when `nextLoanId` (whose
 * slot never moved) is zero and the other counters are zero at every era slot.
 * A non-zero read is a ROW CANDIDATE reported with the era slot it was found
 * at — never silently dropped and never a bound. If the era table is
 * incomplete, or the row member offsets differ between eras, the read is
 * refused up front (`prepareStorageRead().ok === false`) and the cells stay
 * indeterminate with the reason recorded.
 */
import { rowSlot, memberSlot } from './storage-slots.mjs';

export const CLASSES = ['vpfiHeldCustody', 'rebateRows', 'fallbackSnapshotCustody', 'liveIntentCommits'];
/** The member offsets the reads rely on; every era must agree or the read is refused. */
export const ROW = {
  SwapToRepayIntentCommit: { orderHash: 0 },
  BorrowerLifRebate: { vpfiHeld: 0, rebateAmount: 1 },
  FallbackSnapshot: { lenderCollateral: 0, treasuryCollateral: 1, borrowerCollateral: 2, active: 5 },
};
const FIELD_TO_ROW = { intentCommits: 'SwapToRepayIntentCommit', borrowerLifRebate: 'BorrowerLifRebate', fallbackSnapshot: 'FallbackSnapshot' };
export const MAX_STORAGE_LOAN_SCAN = 5000;

/**
 * Validate the two tables against each other and against the offsets above,
 * and derive the distinct slot set per field. Returns `{ ok, reason?, ... }`.
 */
export function prepareStorageRead({ slots, eras }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!slots?.fields || !slots?.storagePosition) return refuse('storage-slots.json is missing or has no fields');
  if (!eras?.eras?.length) return refuse('storage-slot-eras.json is missing or has no eras');
  if (!eras.complete) return refuse(`the era table is INCOMPLETE — ${eras.unavailable?.length ?? '?'} era(s) could not be built (${(eras.unavailable ?? []).map((u) => u.commit.slice(0, 9)).join(', ')}); a "zero at every era" claim needs every era`);
  const head = eras.eras.find((e) => e.commit === eras.head);
  if (!head) return refuse('the era table carries no HEAD era');
  for (const f of Object.keys(slots.fields)) {
    if (head.fields[f]?.slot !== slots.fields[f]) return refuse(`HEAD era slot for ${f} (${head.fields[f]?.slot}) differs from the pinned probe (${slots.fields[f]})`);
  }
  if (head.storagePosition !== slots.storagePosition) return refuse('HEAD era storage position differs from the pinned probe');
  // member offsets must be identical in every era where the row struct exists;
  // and a mapping that EXISTS in an era must carry its row layout (#2095 r1
  // P1) — a null row beside a live mapping is a lookup miss, not an absent
  // struct, and reading it with today's offsets would misattribute that era.
  for (const e of eras.eras) {
    for (const [field, struct] of Object.entries(FIELD_TO_ROW)) {
      if (e.fields?.[field]?.slot && !e.rows?.[struct]) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) carries the ${field} mapping but no ${struct} row layout — the era table cannot say how that era laid its rows out`);
    }
    for (const [struct, members] of Object.entries(ROW)) {
      const r = e.rows?.[struct];
      if (!r) continue; // the struct did not exist in that era, and neither did its mapping (checked above)
      for (const [m, off] of Object.entries(members)) {
        if (!r[m] || r[m].slot !== off || (r[m].offset ?? 0) !== 0) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) places ${struct}.${m} at slot ${r[m]?.slot}/offset ${r[m]?.offset}, not ${off}/0 — the read would misattribute that era's rows`);
      }
    }
  }
  const eraSlots = {};
  for (const f of Object.keys(slots.fields)) {
    const set = new Map();
    for (const e of eras.eras) {
      const s = e.fields?.[f]?.slot;
      if (s) set.set(s, [...(set.get(s) ?? []), { commit: e.commit.slice(0, 9), date: e.date.slice(0, 10) }]);
    }
    eraSlots[f] = [...set.entries()].map(([slot, inEras]) => ({ slot, eras: inEras }));
  }
  if (eraSlots.nextLoanId.length !== 1) return refuse(`nextLoanId occupied ${eraSlots.nextLoanId.length} different slots across eras; the loan-id range would be ambiguous`);
  return {
    ok: true,
    head: eras.head,
    erasBuilt: eras.eras.length,
    generatedAt: eras.generatedAt,
    eraSlots,
    evidence: {
      method: 'eth_getStorageAt pinned by the census block hash (EIP-1898, requireCanonical)',
      slotTable: 'contracts/deployments/storage-slots.json (forge probe; StorageSlotPinTest)',
      eraTable: `contracts/deployments/storage-slot-eras.json (${eras.eras.length} eras since ${eras.since}; head ${eras.head.slice(0, 9)})`,
      calibration: 'contracts/test/StorageSlotCalibrationTest.t.sol — derived slots vs routed getters on non-zero rows',
      distinctSlots: Object.fromEntries(Object.entries(eraSlots).map(([f, v]) => [f, v.length])),
    },
  };
}

const hex = (s) => s;

/** The counters at every era slot. */
export async function readCountersByStorage({ readSlot, eraSlots }) {
  const nextLoanId = await readSlot(hex(eraSlots.nextLoanId[0].slot));
  const perEra = async (field) => {
    const out = [];
    for (const { slot, eras } of eraSlots[field] ?? []) out.push({ slot, eras, value: await readSlot(slot) });
    return out;
  };
  const totalLoansEverCreated = await perEra('totalLoansEverCreated');
  const intentLiveCommitCount = await perEra('intentLiveCommitCount');
  const allZero = nextLoanId === 0n && totalLoansEverCreated.every((x) => x.value === 0n) && intentLiveCommitCount.every((x) => x.value === 0n);
  return {
    nextLoanId,
    totalLoansEverCreated,
    intentLiveCommitCount,
    allZero,
    slotsRead: 1 + totalLoansEverCreated.length + intentLiveCommitCount.length,
  };
}

/**
 * Scan the requested classes for every loan id at every era slot. A non-zero
 * read is a row candidate carrying the slot and era it was found at; the
 * class is empty only when no candidate exists.
 */
export async function scanRowsByStorage({ readSlot, loanIds, eraSlots, classes = CLASSES }) {
  const rows = Object.fromEntries(classes.map((c) => [c, []]));
  let slotsRead = 0;
  const rd = async (slot) => { slotsRead += 1; return readSlot(slot); };
  for (const id of loanIds) {
    if (classes.includes('vpfiHeldCustody') || classes.includes('rebateRows')) {
      for (const { slot, eras } of eraSlots.borrowerLifRebate ?? []) {
        const held = classes.includes('vpfiHeldCustody') ? await rd(memberSlot(id, slot, ROW.BorrowerLifRebate.vpfiHeld)) : 0n;
        const reb = classes.includes('rebateRows') ? await rd(memberSlot(id, slot, ROW.BorrowerLifRebate.rebateAmount)) : 0n;
        if (held > 0n) rows.vpfiHeldCustody.push({ loanId: id.toString(), vpfiHeld: held.toString(), mappingSlot: slot, eras });
        if (reb > 0n) rows.rebateRows.push({ loanId: id.toString(), rebateAmount: reb.toString(), mappingSlot: slot, eras });
      }
    }
    if (classes.includes('fallbackSnapshotCustody')) {
      for (const { slot, eras } of eraSlots.fallbackSnapshot ?? []) {
        const packed = await rd(memberSlot(id, slot, ROW.FallbackSnapshot.active));
        const active = (packed & 0xffn) !== 0n;
        const lc = await rd(memberSlot(id, slot, ROW.FallbackSnapshot.lenderCollateral));
        const tc = await rd(memberSlot(id, slot, ROW.FallbackSnapshot.treasuryCollateral));
        const bc = await rd(memberSlot(id, slot, ROW.FallbackSnapshot.borrowerCollateral));
        const custody = lc + tc + bc;
        if (active || custody > 0n) rows.fallbackSnapshotCustody.push({ loanId: id.toString(), active, collateralTotal: custody.toString(), asset: 'unreadable without the getter', mappingSlot: slot, eras });
      }
    }
    if (classes.includes('liveIntentCommits')) {
      for (const { slot, eras } of eraSlots.intentCommits ?? []) {
        const oh = await rd(memberSlot(id, slot, ROW.SwapToRepayIntentCommit.orderHash));
        if (oh !== 0n) rows.liveIntentCommits.push({ loanId: id.toString(), orderHash: '0x' + oh.toString(16).padStart(64, '0'), asset: 'unreadable without the getter', mappingSlot: slot, eras });
      }
    }
  }
  return { rows, slotsRead, loansScanned: loanIds.length, erasPerField: Object.fromEntries(Object.entries(eraSlots).map(([f, v]) => [f, v.length])) };
}

/**
 * #2095 r1 P1 — the verdict for the intent class from a storage scan. The
 * live-commit counter is corroboration and never sufficient alone, but it can
 * CONTRADICT: a non-zero counter at any era slot beside an empty row scan
 * means a row the scan did not reach (a missing era, a wrong slot), and the
 * class must not be certified. Pure; exported for the test.
 */
export function intentVerdictFromStorage({ rows, liveCommitCounts }) {
  const nonZero = (liveCommitCounts ?? []).filter((c) => BigInt(c.value) !== 0n);
  if (rows.length) return { status: 'indeterminate', reason: `${rows.length} live intent row(s) exist at era slots (read from storage); their asset cannot be read without the getter, so they are not provably VPFI or non-VPFI` };
  if (nonZero.length) {
    return {
      status: 'indeterminate',
      reason: `the row scan found no intent row, but intentLiveCommitCount reads ${nonZero.map((c) => `${c.value} at ${c.slot} (${c.eras.map((e) => e.date).join(',')})`).join('; ')} — the protocol's own counter says a commit exists that the scan did not reach; refusing to certify`,
      contradiction: true,
    };
  }
  return { status: 'proven', provenBy: 'storage-read-calibrated' };
}
