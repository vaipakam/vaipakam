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
import { expandBytecode, normalizeFieldType } from './storage-layout-eras.mjs';

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
export function prepareStorageRead({ slots, eras: rawEras }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!slots?.fields || !slots?.storagePosition) return refuse('storage-slots.json is missing or has no fields');
  // #2095 r20 P1 — every census field must be pinned: a missing one would read as
  // an empty era-slot list downstream and certify a class it never read
  const REQUIRED_FIELDS = ['nextLoanId', 'totalLoansEverCreated', 'intentLiveCommitCount', 'intentCommits', 'borrowerLifRebate', 'fallbackSnapshot'];
  const missingFields = REQUIRED_FIELDS.filter((f) => !slots.fields[f]);
  if (missingFields.length) return refuse(`storage-slots.json lacks the pinned slot of ${missingFields.join(', ')} — regenerate it with the probe script; a class cannot be read without its field`);
  if (!rawEras?.eras?.length) return refuse('storage-slot-eras.json is missing or has no eras');
  const eras = expandBytecode(rawEras);
  if (eras.eras.some((e) => !e.bytecode || !Object.keys(e.bytecode).length)) return refuse('an era carries no bytecode catalogue — regenerate the era table (#2095 r9)');
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
  // #2095 r21 P1 — only the schemas the readers decode are accepted: a plain
  // uint256 counter, and a mapping(uint256 => Row) whose row the ROW table
  // describes. A nested mapping or a retyped counter is a layout the row
  // formula cannot read, whatever its head slot
  const SUPPORTED = {
    nextLoanId: /^t_uint256$/, totalLoansEverCreated: /^t_uint256$/, intentLiveCommitCount: /^t_uint256$/,
    intentCommits: /^t_mapping\(t_uint256,t_struct\(SwapToRepayIntentCommit\)_storage\)$/,
    borrowerLifRebate: /^t_mapping\(t_uint256,t_struct\(BorrowerLifRebate\)_storage\)$/,
    fallbackSnapshot: /^t_mapping\(t_uint256,t_struct\(FallbackSnapshot\)_storage\)$/,
  };
  for (const e of eras.eras) {
    for (const [field, re] of Object.entries(SUPPORTED)) {
      const f = e.fields?.[field];
      if (!f?.slot) continue;
      if (f.type !== undefined && !re.test(normalizeFieldType(f.type))) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) declares ${field} as ${f.type}, a schema the census cannot read`);
      if ((f.offset ?? 0) !== 0) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) places ${field} at offset ${f.offset}, not 0 — a packed field the readers do not decode`);
    }
    for (const [field, struct] of Object.entries(FIELD_TO_ROW)) {
      if (e.fields?.[field]?.slot && !e.rows?.[struct]) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) carries the ${field} mapping but no ${struct} row layout — the era table cannot say how that era laid its rows out`);
    }
    for (const [struct, members] of Object.entries(ROW)) {
      const r = e.rows?.[struct];
      if (!r) continue; // the struct did not exist in that era, and neither did its mapping (checked above)
      for (const [m, off] of Object.entries(members)) {
        if (!r[m] || r[m].slot !== off || (r[m].offset ?? 0) !== 0) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) places ${struct}.${m} at slot ${r[m]?.slot}/offset ${r[m]?.offset}, not ${off}/0 — the read would misattribute that era's rows`);
        // #2095 r9 P2 — the same slot and offset with a NARROWER type packs the
        // next member into the upper part of the word; a full-word read would
        // then fabricate an amount. The type must be HEAD's in every era.
        const headType = head.rows?.[struct]?.[m]?.type;
        if (headType && r[m].type !== headType) return refuse(`era ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) declares ${struct}.${m} as ${r[m].type}, not ${headType} — a full-word read would misattribute that era's rows`);
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
    headSlots: slots.fields,
    // what a deployed facet's code hash attributes to (#2095 r9 P1): every era's
    // build, and every deployment build whose layout an era holds
    eras: [
      ...eras.eras.map((e) => ({ commit: e.commit, date: e.date, bytecode: e.bytecode, kind: 'era' })),
      ...(eras.deploymentBuilds ?? []).filter((b) => b.bytecode && b.layoutInTable === true && !b.sameAsEra).map((b) => ({ commit: b.commit, date: b.date, bytecode: b.bytecode, kind: 'deployment build', reasons: b.reasons, layoutEra: b.layoutEra })),
    ],
    deploymentBuildsOutsideTable: (eras.deploymentBuilds ?? []).filter((b) => b.layoutInTable !== true).map((b) => b.commit),
    erasBuilt: eras.eras.length,
    generatedAt: eras.generatedAt,
    eraSlots,
    evidence: {
      method: 'eth_getStorageAt pinned by the census block hash (EIP-1898, requireCanonical)',
      slotTable: 'contracts/deployments/storage-slots.json (forge probe; StorageSlotPinTest)',
      eraTable: `contracts/deployments/storage-slot-eras.json (${eras.eras.length} eras since ${eras.since}; head ${eras.head.slice(0, 9)})`,
      eraTableIdentity: eras.tableIdentity ?? null, // the table's content identity — stable across a HEAD-era rebuild at a new commit with the same layout and code (#2095 r22)
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
  const all = historical?.rows?.[className] ?? [];
  if (!all.length) return { ...cls, historicalRows: 0 };
  // #2095 r20 P1 — a getter row may absorb a historical (earlier-slot) row only
  // when the getter cannot be reading HEAD's row for that loan: if storage holds
  // a row for the same loan at HEAD's slot, the getter (reading HEAD) is that
  // row, and a same-valued row at an older slot is a DISTINCT liability
  const headLoanIds = new Set(((historical?.headRows ?? {})[className] ?? []).map((r) => String(r.loanId)));
  // #2095 r7 P2 — a routed getter compiled against an EARLIER layout returns
  // the very row the era scan finds at that era's slot. Such a row is already
  // in the getter's set; merging it again would double the count, the total
  // and the shortfall. Each getter row absorbs at most ONE historical row
  // with the same key (and the same amount where the row carries one); the
  // HEAD-slot reconciliation still records the layout disagreement. A row
  // that carries no amount (intent) is never absorbed — see below.
  // An intent row is NEVER absorbed (#2095 r8 P1): storage reads its orderHash
  // and the routed getter returns the order, not the hash, so a historical
  // intent row cannot be proven to be the getter's — an old-layout commit A
  // left behind under a current-layout commit B for the same loan is a
  // distinct candidate and must survive as one.
  const amountField = { vpfiHeldCustody: 'vpfiHeld', rebateRows: 'rebateAmount', fallbackSnapshotCustody: 'collateralTotal' }[className];
  const unclaimed = amountField ? [...(cls.rows ?? []), ...(cls.nonVpfiRowsExcluded ?? []), ...(cls.unknownAssetRows ?? [])] : [];
  const hist = [];
  let alreadyReported = 0;
  for (const r of all) {
    const i = headLoanIds.has(String(r.loanId)) ? -1 : unclaimed.findIndex((g) => String(g.loanId) === String(r.loanId) && String(g[amountField]) === String(r[amountField]));
    if (i >= 0) { unclaimed.splice(i, 1); alreadyReported += 1; } else hist.push(r);
  }
  const base = { historicalRows: hist.length, historicalRowsAlreadyReportedByGetter: alreadyReported };
  if (!hist.length) return { ...cls, ...base };
  if (className === 'vpfiHeldCustody' || className === 'rebateRows') {
    const rows = [...(cls.rows ?? []), ...hist.map((r) => ({ ...r, layoutEra: 'earlier' }))];
    const total = rows.reduce((a, r) => a + BigInt(r[amountField]), 0n).toString();
    return { ...cls, count: rows.length, total, rows, ...base };
  }
  return {
    ...cls,
    status: 'indeterminate',
    provenBy: undefined,
    indeterminateReason: `${hist.length} row candidate(s) at an EARLIER layout era's slot (no getter reads them)${hist.some((r) => r.ambiguous) ? `; ${hist.filter((r) => r.ambiguous).length} of them alias a current field's rows (${[...new Set(hist.filter((r) => r.ambiguous).map((r) => r.aliasesCurrentField))].join(', ')}) and may be today's rows of that field for the same key` : ''}; their asset cannot be read without a getter for that era`,
    unknownAssetRows: [...(cls.unknownAssetRows ?? []), ...hist],
    count: (cls.count ?? 0) + hist.length,
    ...base,
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
    const hit = aliasEntry(r.slot, occupied);
    // #2095 r9 P1 — a mapping stores NOTHING at its head slot, so a non-zero
    // there cannot be the current mapping's value: it is the old counter (or
    // some other earlier occupant), left where an upgraded layout put a
    // mapping head. Only a current value field, array length or inline
    // struct explains a non-zero reading.
    if (hit && !hit.isMapping) aliased.push({ ...r, aliases: hit.label });
    else contradictions.push(hit ? { ...r, atMappingHead: hit.label } : r);
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
  // every class that carries an amount compares it (#2095 r8 P1 — fallback included); an intent row has no amount storage reads
  const amount = { vpfiHeldCustody: 'vpfiHeld', rebateRows: 'rebateAmount', fallbackSnapshotCustody: 'collateralTotal' };
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

/**
 * #2095 r6 P2 — the ONE attribution rule for counter readings, on every
 * path. A reading at HEAD's slot is the counter today and is kept as read; a
 * NON-ZERO reading at an earlier era's slot is kept only when no current
 * field occupies that slot (an unexplained counter — a genuine contradiction
 * candidate), and is set aside as `aliased` when one does (the checked-in
 * table has an old `totalLoansEverCreated` slot that is now a list length and
 * an old `intentLiveCommitCount` slot that is now `tierTableVersion`, so a
 * getter-less Diamond with offers but no loans must not read as a
 * contradiction). `allZero` is recomputed over the kept readings. Pure.
 */
export function attributeCounters(counters, headSlots, occupied) {
  const earlier = (list, which) => list.filter((x) => x.slot !== headSlots[which]).map((x) => ({ ...x, which, value: x.value.toString() }));
  const { contradictions, aliased } = classifyEarlierCounters([...earlier(counters.totalLoansEverCreated, 'totalLoansEverCreated'), ...earlier(counters.intentLiveCommitCount, 'intentLiveCommitCount')], occupied);
  const aliasedSlots = new Set(aliased.map((x) => `${x.which}@${x.slot}`));
  const keep = (list, which) => list.filter((x) => !aliasedSlots.has(`${which}@${x.slot}`));
  const totalLoansEverCreated = keep(counters.totalLoansEverCreated, 'totalLoansEverCreated');
  const intentLiveCommitCount = keep(counters.intentLiveCommitCount, 'intentLiveCommitCount');
  return {
    counters: {
      ...counters,
      totalLoansEverCreated,
      intentLiveCommitCount,
      allZero: counters.nextLoanId === 0n && totalLoansEverCreated.every((x) => x.value === 0n) && intentLiveCommitCount.every((x) => x.value === 0n),
    },
    unexplained: contradictions.map((x) => ({ which: x.which, slot: x.slot, value: String(x.value), eras: x.eras, atMappingHead: x.atMappingHead })),
    aliased: aliased.map((x) => ({ which: x.which, slot: x.slot, value: String(x.value), aliases: x.aliases })),
  };
}

/**
 * #2095 r9 P1 — attribute every facet that ever wrote to a deployment to the
 * layout era it was compiled against, by the keccak256 of its runtime code
 * against each era's catalogue. A facet whose code is in no era's catalogue
 * was built from sources the walk never saw — a dirty tree whose dirt reached
 * the storage library, or an unmerged branch — and the era-complete read
 * cannot claim to cover its layout. Empty code is a contract that never
 * existed (post-Cancun, code cannot vanish — EIP-6780), so it never wrote.
 * Pure; exported for the test.
 */
export function attributeFacetCode({ facets, eras }) {
  const EMPTY = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'; // keccak256('0x')
  const attributed = [];
  const unattributed = [];
  const noCode = [];
  for (const f of facets) {
    if (!f.codeHash || f.codeHash === EMPTY) { noCode.push({ address: f.address, sources: f.sources }); continue; }
    const hits = (eras ?? []).filter((e) => e.bytecode?.[f.codeHash]).map((e) => ({ commit: e.commit.slice(0, 9), date: String(e.date).slice(0, 10), name: e.bytecode[f.codeHash], kind: e.kind ?? 'era', layoutEra: e.layoutEra ? String(e.layoutEra).slice(0, 9) : e.commit.slice(0, 9) }));
    if (hits.length) attributed.push({ address: f.address, name: hits[0].name, eras: hits.map((h) => ({ commit: h.commit, date: h.date, kind: h.kind, layoutEra: h.layoutEra })), sources: f.sources });
    else unattributed.push({ address: f.address, codeHash: f.codeHash, sources: f.sources });
  }
  return { attributed, unattributed, noCode, verdict: unattributed.length ? 'unattributed' : 'attributed' };
}

/** Every class the getters or the storage read called proven becomes indeterminate with `reason`; nothing else changes. Pure. */
export function downgradeProvenClasses(classes, reason) {
  const out = {};
  for (const [name, c] of Object.entries(classes)) {
    out[name] = c.status !== 'proven' ? c : { ...c, status: 'indeterminate', provenBy: undefined, indeterminateReason: reason };
  }
  return out;
}

/**
 * #2095 r10 P1 — a state response must be hex DATA. A replica that answers
 * `null` (or anything but `0x…`) for a failed lookup would otherwise become
 * `0n` or "empty code" and certify absence from incomplete state; the read
 * throws instead. Pure; exported for the test.
 */
export function requireHexData(value, what) {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${what}: malformed state response ${value === null ? 'null' : value === undefined ? 'undefined' : JSON.stringify(String(value).slice(0, 40))} — not hex data; refusing to read it as a value`);
  }
  return value;
}

/** The EIP-2535 `diamondCut(...)` selector — every Diamond's constructor cuts it, so its Add marks the deploy-time cut. */
export const DIAMOND_CUT_SELECTOR = '0x1f931c1c';

/**
 * #2095 r10 P1 — whether the facet POPULATION is exhaustive. The cut history
 * is the only source that sees a facet cut in and out between records, and a
 * pruned endpoint returns an empty history without an error. The history
 * counts as complete only when it was read, its FIRST log is the constructor's
 * own empty cut (the first thing pruning removes), and every facet the loupe
 * routes today appears in it — except the cut facet the constructor installed
 * by writing storage, which no cut ever added. An omitted Add/Remove
 * PAIR inside a returned window is undetectable by any test over logs and is
 * the stated residual. Pure; exported for the test.
 */
export function cutHistoryCompleteness({ verdict, cuts, constructorCutSeen, addresses, loupe, cutFacetHost, loupeReadFailed = false, recordedFacets = [] }) {
  const reasons = [];
  // #2095 r18 P1 — a record's facets were cut by the deploy that wrote the
  // record, so on a Diamond that routes today a recorded facet the history
  // never added is a cut the endpoint omitted (and it may have omitted
  // another writer). On a Diamond that routes nothing — a shell whose cut
  // never ran — a recorded facet absent from the history is exactly that.
  if (Array.isArray(loupe)) {
    const known = new Set((addresses ?? []).map((a) => a.toLowerCase()));
    const exempt = cutFacetHost ? String(cutFacetHost).toLowerCase() : null;
    const omitted = [...new Set((recordedFacets ?? []).map((a) => String(a).toLowerCase()))].filter((a) => a !== exempt && !known.has(a));
    if (omitted.length) reasons.push(`${omitted.length} facet(s) the records name were never added in the returned history — the endpoint omitted cuts`);
  }
  // #2095 r17 P1 — a loupe that answered the selector probe but not facets()
  // (a rate-limited replica) leaves the current facet set unknown: that is an
  // incomplete population, never a skipped check
  if (loupeReadFailed) reasons.push('the loupe routes facets() but the call failed, so the current facet set could not be checked against the history');
  // #2095 r23 P1 — no loupe, no enumeration of the current facets: a Diamond
  // can route writers without a loupe, and an Add the history omitted for one
  // of them would leave it out of attribution
  else if (!Array.isArray(loupe)) reasons.push('the loupe is unrouted, so the current facet set could not be enumerated and checked against the history');
  if (verdict !== 'read' || !cuts) reasons.push(`the cut history was ${verdict === 'read' ? 'empty' : verdict}`);
  // VaipakamDiamond's constructor emits ONE DiamondCut with an EMPTY cut array
  // and installs the diamondCut selector by writing storage directly
  // (#2095 r13 P1): the deploy-time marker is that empty cut at the head of
  // the history, and the cut facet it installed never appears as an Add.
  else if (!constructorCutSeen) reasons.push('the deploy-time cut (the constructor\'s empty DiamondCut) is not at the head of the returned history — its first blocks are pruned');
  if (Array.isArray(loupe)) {
    const known = new Set((addresses ?? []).map((a) => a.toLowerCase()));
    const exempt = cutFacetHost ? String(cutFacetHost).toLowerCase() : null;
    const missing = loupe.map((a) => a.toLowerCase()).filter((a) => a !== exempt && !known.has(a));
    if (missing.length) reasons.push(`${missing.length} facet(s) the loupe routes today never appear as an Add in the returned history`);
  }
  return { complete: reasons.length === 0, reasons };
}

/**
 * #2095 r13 P1 — under the ROUTED standard only a class proven by a routed
 * getter keeps its proof when provenance refuses; a class proven by the
 * storage read alone (a getter-less shell's counter twin, or the intent read
 * at every era slot) still depends on the era table covering every writer's
 * layout, which is exactly what an unattributed facet or an incomplete
 * population denies. Pure; exported for the test.
 */
export const STORAGE_ONLY_PROOFS = new Set(['no-loans-ever-created-by-storage', 'storage-read-calibrated']);
export function downgradeStorageOnlyProofs(classes, reason) {
  const out = {};
  for (const [name, c] of Object.entries(classes)) {
    out[name] = c.status === 'proven' && STORAGE_ONLY_PROOFS.has(c.provenBy) ? { ...c, status: 'indeterminate', provenBy: undefined, indeterminateReason: reason } : c;
  }
  return out;
}

/**
 * #2095 r17 P1 — an address the CUT HISTORY names (a facet or an initializer)
 * with empty code at the census block is unreadable, not "never wrote":
 * `LibDiamond.addFacet` checks extcodesize, so the cut proves the facet had
 * code, and EIP-6780 still lets a contract created and self-destructed in
 * one transaction vanish — a transient facet can be cut in, invoked, removed
 * and destroyed within one transaction. Only an address named by a RECORD
 * alone and never seen cut may count as never having written. Pure.
 */
export function refuseUnreadableCutSources(attribution) {
  const keep = [];
  for (const n of attribution.noCode) {
    if (n.sources.some((x) => x.startsWith('cut-history'))) {
      attribution.unattributed.push({ address: n.address, codeHash: null, sources: n.sources, note: n.sources.includes('cut-history:initializer') ? 'initializer delegatecalled by a cut, its code unreadable at the census block' : 'facet the cut history names, its code unreadable at the census block (a cut proves it had code)' });
    } else keep.push(n);
  }
  attribution.noCode = keep;
  if (attribution.unattributed.length) attribution.verdict = 'unattributed';
  return attribution;
}

/**
 * #2095 r24 P1 — whether two routed getters read the same layout: both hosts
 * known and attributed, and their attributed layout eras intersect (a build's
 * `layoutEra` counts as its era). An unknown or unattributed host shares
 * nothing. Pure; exported for the test.
 */
export function gettersShareLayout(attributed, hosts) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  if (list.some((h) => !h)) return { shared: false, reason: `a scope getter's host is unknown (a getter unrouted or the loupe unreadable)` };
  const erasOf = (h) => {
    const a = (attributed ?? []).find((x) => String(x.address).toLowerCase() === String(h).toLowerCase());
    return a ? new Set(a.eras.map((e) => e.layoutEra ?? e.commit)) : null;
  };
  const sets = list.map(erasOf);
  const missing = list.filter((h, i) => !sets[i]);
  if (missing.length) return { shared: false, reason: `a scope getter's host is unattributed (${missing[0]})` };
  if (new Set(list.map((h) => String(h).toLowerCase())).size === 1) return { shared: true, reason: 'one facet hosts every getter' };
  let common = [...sets[0]];
  for (const s of sets.slice(1)) common = common.filter((e) => s.has(e));
  return common.length ? { shared: true, reason: `all attribute to layout era ${common[0]}` } : { shared: false, reason: 'the hosts attribute to different layout eras' };
}
