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
  // HEAD's occupied ranges: what an EARLIER era's slot may alias today. Without
  // them a non-zero read at an old slot cannot be attributed, so the read is
  // refused (a sound proof of absence never needs them, but the census also
  // reports candidates, and a candidate must be attributable).
  if (!Array.isArray(head.occupied) || !head.occupied.length) return refuse('the HEAD era carries no occupied-range map — regenerate the era table');
  const occupied = head.occupied.map((r) => ({ ...r, fromN: BigInt(r.from), toN: BigInt(r.to) }));
  return {
    ok: true,
    head: eras.head,
    occupied,
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

/** The era slots of each field EXCEPT the one HEAD's layout uses — what a routed getter cannot see. */
export function eraSlotsExcept(eraSlots, headSlots) {
  const out = {};
  for (const [f, list] of Object.entries(eraSlots)) out[f] = list.filter((x) => x.slot !== headSlots[f]);
  return out;
}

/**
 * #2095 r3 P1 — a routed getter reads TODAY's layout; rows written by earlier
 * facets sit at earlier era slots where no getter looks. This merges the
 * historical scan into a class's routed verdict: a rebate or held row is VPFI
 * by definition and simply counts; a fallback or intent row has no readable
 * asset and makes the class indeterminate. Pure; exported for the test.
 */
export function mergeHistoricalRows(cls, historical, className) {
  const hist = historical?.rows?.[className] ?? [];
  if (!hist.length) return { ...cls, historicalRows: 0 };
  if (className === 'vpfiHeldCustody' || className === 'rebateRows') {
    const field = className === 'vpfiHeldCustody' ? 'vpfiHeld' : 'rebateAmount';
    const rows = [...(cls.rows ?? []), ...hist.map((r) => ({ ...r, layoutEra: 'earlier' }))];
    const total = rows.reduce((a, r) => a + BigInt(r[field]), 0n).toString();
    return { ...cls, count: rows.length, total, rows, historicalRows: hist.length };
  }
  return {
    ...cls,
    status: 'indeterminate',
    provenBy: undefined,
    indeterminateReason: `${hist.length} row candidate(s) at an EARLIER layout era's slot (no getter reads them)${hist.some((r) => r.ambiguous) ? `; ${hist.filter((r) => r.ambiguous).length} of them alias a current field's rows (${[...new Set(hist.filter((r) => r.ambiguous).map((r) => r.aliasesCurrentField))].join(', ')}) and may be today's rows of that field for the same key` : ''}; their asset cannot be read without a getter for that era`,
    unknownAssetRows: [...(cls.unknownAssetRows ?? []), ...hist],
    count: (cls.count ?? 0) + hist.length,
    historicalRows: hist.length,
  };
}

/**
 * What a slot means in TODAY's layout: the top-level Storage member whose
 * span covers it, or null when no current field lives there. An earlier
 * era's slot that aliases a current field reads that field's current value,
 * which is neither a stale counter nor a stale row (#2095 r3 follow-up:
 * base-sepolia live showed three "non-zero earlier-era counters" that were
 * exactly this).
 */
export function aliasOf(slot, occupied) {
  return aliasEntry(slot, occupied)?.label ?? null;
}
export function aliasEntry(slot, occupied) {
  const n = BigInt(slot);
  return (occupied ?? []).find((r) => n >= (r.fromN ?? BigInt(r.from)) && n <= (r.toN ?? BigInt(r.to))) ?? null;
}

/**
 * Split earlier-era counter readings into contradictions (a non-zero value
 * at a slot no current field occupies — an old counter left behind) and
 * aliased readings (a current field's value, ignored as a counter). Pure.
 */
export function classifyEarlierCounters(readings, occupied) {
  const contradictions = [];
  const aliased = [];
  for (const r of readings) {
    if (BigInt(r.value) === 0n) continue;
    const alias = aliasOf(r.slot, occupied);
    if (alias) aliased.push({ ...r, aliases: alias });
    else contradictions.push(r);
  }
  return { contradictions, aliased };
}

/**
 * A row candidate found at an earlier era's mapping slot is AMBIGUOUS only
 * when that head slot is a current MAPPING's head: today's row for the same
 * key then lives at the very same derived slot. A current value field at the
 * old head occupies that one slot and nothing hashed from it, so rows under
 * it are unambiguous. Marks each candidate; never drops it.
 */
export function markAliasedRows(rows, occupied) {
  return rows.map((r) => {
    const hit = aliasEntry(r.mappingSlot, occupied);
    return hit && hit.isMapping ? { ...r, aliasesCurrentField: hit.label, ambiguous: true } : hit ? { ...r, oldHeadNowHolds: hit.label } : r;
  });
}

/** Split scanned rows into those at HEAD's slot for their mapping (what a current-layout getter reads) and those at earlier slots. */
export function splitByHeadSlot(rows, headSlots) {
  const head = {};
  const earlier = {};
  for (const [cls, list] of Object.entries(rows)) {
    const field = cls === 'liveIntentCommits' ? 'intentCommits' : cls === 'fallbackSnapshotCustody' ? 'fallbackSnapshot' : 'borrowerLifRebate';
    head[cls] = list.filter((r) => r.mappingSlot === headSlots[field]);
    earlier[cls] = list.filter((r) => r.mappingSlot !== headSlots[field]);
  }
  return { head, earlier };
}

/**
 * #2095 r4 P1 — a routed getter reads the layout of the FACET that was cut,
 * which need not be HEAD's. So the HEAD-slot rows the storage read finds
 * are not merged; they are reconciled against what the routed getter said,
 * per loan id and in BOTH directions. A row storage sees at the HEAD slot
 * that the getter did not report, or a row the getter reported that storage
 * does not see at the HEAD slot, means the getter reads another layout — the
 * class is indeterminate. Pure; exported for the test.
 */
export function getterAgreement({ headRows, routed }) {
  const out = {};
  const amount = { vpfiHeldCustody: 'vpfiHeld', rebateRows: 'rebateAmount' };
  for (const cls of Object.keys(headRows)) {
    const storage = new Map(headRows[cls].map((r) => [String(r.loanId), r]));
    const getter = new Map((routed[cls] ?? []).map((r) => [String(r.loanId), r]));
    const mismatches = [];
    for (const [id, r] of storage) {
      const g = getter.get(id);
      if (!g) { mismatches.push({ loanId: id, storage: amount[cls] ? r[amount[cls]] : 'present', getter: 'absent' }); continue; }
      if (amount[cls] && String(g[amount[cls]]) !== String(r[amount[cls]])) mismatches.push({ loanId: id, storage: r[amount[cls]], getter: String(g[amount[cls]]) });
    }
    for (const [id] of getter) if (!storage.has(id)) mismatches.push({ loanId: id, storage: 'absent at the HEAD slot', getter: 'present' });
    out[cls] = mismatches;
  }
  return out;
}

/**
 * #2095 r5 P1 — without the era-complete read there is no proof on the
 * enumerable path. A routed getter reads only the layout its facet was
 * compiled from, so a row written under another era's layout is invisible to
 * it; the era-complete read is what excludes that. When that read is
 * unavailable (no table, a rejected table, a HEAD mismatch) every class the
 * getters called proven is downgraded to indeterminate. Pure; exported for
 * the test.
 */
export function downgradeWithoutEraRead(classes, reason) {
  const out = {};
  for (const [name, c] of Object.entries(classes)) {
    if (c.status !== 'proven') { out[name] = c; continue; }
    out[name] = { ...c, status: 'indeterminate', provenBy: undefined, indeterminateReason: `the era-complete storage read is unavailable (${reason}) — a routed getter reads only its facet's layout, so a row at another era's slot cannot be excluded; refusing to certify` };
  }
  return out;
}
