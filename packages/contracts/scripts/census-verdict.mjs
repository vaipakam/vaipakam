/**
 * census-verdict.mjs — the ONE writer of a custody-census verdict (#1566; the
 * #2095 root arrest).
 *
 * Twenty-eight review rounds on #2095 found one defect in many places: a
 * verdict word, a count or a liability figure written at one site and left
 * standing after a later site withdrew the evidence it rested on (a shell
 * builder, a result constructor, thirteen post-hoc downgrade passes and a
 * finalizer, each stating part of the rule). Each fix guarded one more path.
 * This module removes the paths instead.
 *
 * THE RULE. The collector (`census-grandfathered-custody.mjs`) produces an
 * EVIDENCE LEDGER — every read it took, tagged with its source, nothing
 * derived — and `verdictFromEvidence(ledger, { proofStandard, storageRead })`
 * derives every published figure from it, once, after the last read:
 *
 *   - `proven` is the conjunction of the named obligations in `OBLIGATIONS`,
 *     each discharged by evidence PRESENT in the ledger — never by the absence
 *     of a refusal; `indeterminate` is the complement and names every
 *     undischarged obligation;
 *   - storage decides the loan-id range (`1..nextLoanId`, the one slot that
 *     never moved) and the existence of every row; a routed read is a range
 *     WITNESS, an observation reconciled against HEAD storage, or an asset
 *     label whose soundness is itself derived — nothing routed grants a bound;
 *   - the only zero-loans bound is `nextLoanId === 0` with HEAD's reading of
 *     BOTH counter kinds present and every KEPT counter reading of both kinds
 *     zero — an earlier era's counter slot that a current value field occupies
 *     today reads that field and is set aside (#2095 r6 P2), and a kind with
 *     no reading is no evidence of zero; routed zeros agree with the bound,
 *     they never are it;
 *   - facet code is attributed to layout eras HERE, from raw code hashes and
 *     the era table the judge is GIVEN, so a regenerated table re-judges a
 *     committed ledger offline (`--rejudge`) without an archive RPC, and
 *     `era-coverage` names, by slot, when a rerun is actually owed.
 *
 * Held to: PURE (no I/O but reading this file once, below, for the rule's own
 * hash); TOTAL over the ledger's shape (a malformed ledger is never an
 * exception, and a malformed read is never evidence: a list that is not a
 * list, a key read twice, a value that does not parse or a scan count short
 * of the range each fails, by name, the obligation that rests on that read.
 * Where nothing rests on it, nothing fails: under the routed standard a
 * provenance refusal may be waived, since the waiver does not read
 * provenance, and a scope getter's host is read only where a fallback or
 * intent row is filed by comparing its asset with the token. A row
 * observation is included: a loan id that does not parse or that the range
 * cannot reach, an amount that does not parse or is missing where the read
 * has one, and a source that is neither storage nor a routed getter each
 * file that read unknown and fail `row-attributed`, see `observationOf`);
 * ORDER-INDEPENDENT over `observations`.
 *
 * MONOTONE — in the one direction a proof needs, at the granularity stated
 * here, and no further. Removing a read deletes its record from the ledger,
 * with what that read produced (the rows read at a removed slot, the ids a
 * removed range asked). Two kinds of read are distinguished:
 *
 *   - SUPPORTING: removing one never moves a class from indeterminate to
 *     proven, and never adds an entry to a proven class's evidence chain,
 *     because some conjunct requires it PRESENT. At this granularity —
 *     EVERY record of a read, where the ledger carries more than one: the
 *     storage range; the scan's own count of the ids it read; the
 *     observations AS A LIST; the counters record, and every reading at a
 *     counter slot the era table lists, HEAD's included; each era slot the
 *     scan covered; the flags record that carries the code and Diamond
 *     answers; the provenance read, and each of its five writer lists AS A
 *     LIST; every code-hash entry the ledger carries for a writer some list
 *     names (deleted, the writer is unhashed), and the hash of any one such
 *     entry alone (deleted, that entry is malformed; both refuse); a routed
 *     getter's asked-ids record; each recorded routing answer, a custody
 *     getter's or a metrics selector's; the corroboration record; the token
 *     scope; every key naming a scope getter's host. Test I9 holds the
 *     derivation to exactly this: over a fifth of the generated family it
 *     removes one instance of each kind per ledger, alone, and fails unless
 *     every instance it lists was removed from some ledger that carried it.
 *   - REFUTING: removing one MAY restore a proof, because some conjunct tests
 *     it for contradiction, and a deleted refuting read describes a different
 *     Diamond, not a weaker reading of this one: every row observation (a
 *     row's source, loan id, asset, amount, slot and twin are what file it
 *     unknown or disagreeing); each ENTRY inside a writer list (an address
 *     the cut history, the loupe or the records name is a writer whose code
 *     must be read and attributed; deleted, that writer may no longer be
 *     owed); a facet entry NO list names whose code no era built; a
 *     counter reading at a slot the era table does not list, which no
 *     conjunct owes but whose value still contradicts; a routed range
 *     witness on a ledger that does NOT record both metrics selectors
 *     routed (unowed there, it is read only for a contradiction with the
 *     storage range); and the scan's truncation marker (a recorded
 *     truncation is what files a short scan unread). A
 *     routed getter row storage holds only at an earlier era's slot is one
 *     such read — proof that the cut getter reads a layout other than HEAD's
 *     (#2095 r4/r7). So is a SECOND record of a key already read: a second
 *     reading at one counter slot, a second facet entry for one address (in
 *     any spelling), a second spelling of one scope getter's host. One key,
 *     one read — which record is the read is unknowable, so the pair refuses
 *     whatever the records say (`readingsOf`, the `malformed` list,
 *     `hostFor`), and removing one may restore a proof, as removing any
 *     duplicate read may. I9 removes none of these: it removes every record
 *     of a key or none, and holds only that deleting an observation never
 *     proves ANOTHER class. The cell after it shows a writer-list entry, an
 *     unnamed facet entry, an unlisted counter reading and each kind of
 *     duplicate record restoring the proof it withheld.
 *
 * The two lists are the kinds the collector writes, not every shape a ledger
 * can take. Neither covers a facet entry no list names whose code IS attributed —
 * a read the collector never takes, since it reads code for exactly the
 * writers its lists name: deleting it can only withdraw attribution, but a
 * proof that survives restates its attributed count. And a record's PRESENCE
 * and its VALUE are different things: a counter reading at a listed slot, the
 * routed range witness where both metrics selectors are recorded routed, and
 * the corroboration record are owed — absent, each refuses (I9 removes the
 * first and the last; a T-D breaker the witness) — while what each says may
 * contradict, so changing a value, unlike removing the record, can restore a
 * proof.
 *
 * Nothing outside this module writes a verdict word, and a result is a
 * verdict only if this module made it (`isVerdict` — a module-private brand a
 * spread copy does not carry), so the collector's single exit can refuse
 * anything else.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLASSES,
  LIABILITY_CLASS_FIELDS,
  attributeCounters,
  splitByHeadSlot,
  markAliasedRows,
  getterAgreement,
  // the ONE whole-number parser and the ONE amounts-agree predicate, shared
  // with getterAgreement so the HEAD merge and the agreement check cannot
  // differ on what an amount is or when two agree
  wholeNumber as big,
  amountOf,
  amountsAgree,
  attributeFacetCode,
  refuseUnreadableCutSources,
  cutHistoryCompleteness,
  gettersShareLayout,
  deriveLiabilityAggregates,
} from './census-storage-read.mjs';

/**
 * The rule's identity, recorded on every verdict and on the report. It is
 * PROVENANCE, not a gate: a comment edit changes the hash without changing a
 * single verdict, so the artifact self-check compares re-derived verdicts,
 * never this digest.
 */
const VERDICT_RULE = Object.freeze({
  module: 'census-verdict.mjs',
  sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
});

/** Results this module derived. Module-private: nothing else can add to it, so `isVerdict` is a brand a copy cannot forge. */
const PUBLISHED = new WeakSet();

const STANDARDS = ['provenance', 'routed'];
const INTENT = 'liveIntentCommits';
/** Classes 1 and 4 hold VPFI amounts by construction (`vpfiHeld`, `rebateAmount`); no asset read files them. */
const VPFI_BY_CONSTRUCTION = new Set(['vpfiHeldCustody', 'rebateRows']);
/** The storage mapping each class's rows live in — the key into the era table's slot lists. */
const FIELD_OF = {
  vpfiHeldCustody: 'borrowerLifRebate',
  rebateRows: 'borrowerLifRebate',
  fallbackSnapshotCustody: 'fallbackSnapshot',
  liveIntentCommits: 'intentCommits',
};
/**
 * The class's PRIMARY getter — the one that reads its rows. `getLoanDetails`
 * is not on this list: it only labels a fallback row's asset (S1-R9), and its
 * routing decides that label's soundness, not the class's coverage.
 */
const PRIMARY_GETTER = {
  vpfiHeldCustody: 'getBorrowerLifRebate',
  rebateRows: 'getBorrowerLifRebate',
  fallbackSnapshotCustody: 'getFallbackSnapshot',
  liveIntentCommits: 'getIntentCommit',
};
const COUNTER_FIELDS = ['totalLoansEverCreated', 'intentLiveCommitCount'];
/**
 * The getters a row's asset scope rests on, and the keys the ledger may name
 * each host by: the 4-byte selector the loupe answers for (the collector's
 * key), the getter's name (as `surfaces` and `idsAskedOfGetter` key it) and
 * the role. A miss on every form is an unknown host, which shares no layout —
 * the conservative outcome, never a pass.
 */
const SCOPE_GETTERS = {
  fallback: { getter: 'getFallbackSnapshot', selector: '0xd66ca646' },
  loan: { getter: 'getLoanDetails', selector: '0x66877b8d' },
  token: { getter: 'getVPFIToken', selector: '0x4decf685' },
  intent: { getter: 'getIntentCommit', selector: '0xef2da606' },
};
/** The identity a verdict carries FLAT at its top level (C7) — the keys every committed-artifact reader indexes by. Only these are lifted, so an identity cannot smuggle a verdict-shaped key. */
const IDENTITY_KEYS = ['chainSlug', 'deployment', 'chainId', 'diamond', 'atBlock', 'atBlockHash', 'blockTag', 'rpcHost', 'sourceRecord', 'duplicateOfDeployment'];
const TOKEN_SOURCE_LABEL = { 'on-chain': 'on-chain getVPFIToken()', artifact: 'deployment artifact' };

// ── shape normalisation: every ledger read goes through these, which is what makes the judge total ──

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const dec = (n) => (n === null ? null : n.toString());
/** A storage slot in one canonical spelling, so a table slot and a ledger slot compare by value, not by case or padding. */
function slotOf(v) {
  const n = big(v);
  return n === null || n < 0n ? null : `0x${n.toString(16).padStart(64, '0')}`;
}
const addrOf = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
/** A code-hash READ: a keccak256 word. Anything else — null, a number, a short string — is no read, and never empty code. */
const isCodeHash = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const idOf = (v) => {
  const n = big(v);
  return n === null ? String(v) : n.toString();
};
function compareIds(a, b) {
  const x = big(a);
  const y = big(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
/**
 * A bigint as the artifact spells it: its decimal string (the collector's
 * writer, `bigintAsDecimal`). A run holds bigints where a revived ledger holds
 * those strings, so every rendering and every copy the judge publishes goes
 * through this one rule — a ledger in memory and the same ledger read back
 * then sort, describe and publish identically. Rendered as `5n` instead, a
 * bigint and its twin wrote different detail text and, as a sort key, could
 * order the same rows differently.
 */
const decimal = (x) => (typeof x === 'bigint' ? x.toString() : x);
const stable = (v) => JSON.stringify(v ?? null, (_, x) => decimal(x));
/** A ledger value as a verdict detail names it — a key the record lacks is said to be missing, not null. */
const shown = (v) => (v === undefined ? 'not recorded' : stable(v));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** A deep copy with `undefined` dropped and each bigint its decimal string (`decimal`): the published verdict shares no object with its input, so freezing it never freezes the caller's ledger, and it survives a JSON round trip unchanged. */
function copy(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : copy(x)));
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = copy(x);
    return out;
  }
  return decimal(v);
}
function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/**
 * An id set as the ledger records it: `'1..N'`, `''` (nothing asked), or an
 * explicit list. `null` when it is none of these — an unparseable set covers
 * nothing and is a subset of nothing.
 */
function idSetOf(v) {
  if (v === '' || v === 'none') return { upTo: 0n, ids: null };
  if (typeof v === 'string') {
    const m = v.trim().match(/^1\.\.(\d+)$/);
    return m ? { upTo: BigInt(m[1]), ids: null } : null;
  }
  if (Array.isArray(v)) {
    const ids = v.map(big);
    return ids.some((x) => x === null) ? null : { upTo: null, ids };
  }
  return null;
}
const sizeOf = (set) => (set.ids ? BigInt(set.ids.length) : set.upTo);
/** How many distinct loans an id set lists: a repeated id is one loan listed twice, never two loans. */
const distinctSizeOf = (set) => (set.ids ? BigInt(new Set(set.ids.map(String)).size) : set.upTo);
function covers(set, n) {
  // The record first: an empty range is covered only by a getter whose asked
  // set was RECORDED ('' for none) — never by the absence of a record (§1).
  if (!set) return false;
  if (n === 0n) return true;
  if (!set.ids) return set.upTo >= n;
  if (BigInt(set.ids.length) < n) return false;
  const have = new Set(set.ids.map(String));
  for (let i = 1n; i <= n; i++) if (!have.has(i.toString())) return false;
  return true;
}
const outsideRange = (set, n) => (set.ids ? set.ids.filter((id) => id === 0n || id > n) : set.upTo > n ? [set.upTo] : []);

/** The era table the judge was given, in canonical spelling. A table that did not prepare is carried with its reason, never guessed at. */
function tableOf(storageRead) {
  const identity = storageRead?.evidence?.eraTableIdentity ?? null;
  if (!isObj(storageRead) || storageRead.ok !== true) {
    return { ok: false, reason: String(storageRead?.reason ?? 'no storage read was prepared for the judge'), eraSlots: {}, headSlots: {}, occupied: [], eras: [], identity };
  }
  const eraSlots = {};
  for (const [field, list] of Object.entries(isObj(storageRead.eraSlots) ? storageRead.eraSlots : {})) {
    eraSlots[field] = arr(list).map((e) => ({ slot: slotOf(e?.slot), eras: arr(e?.eras) })).filter((e) => e.slot !== null);
  }
  const headSlots = Object.fromEntries(Object.entries(isObj(storageRead.headSlots) ? storageRead.headSlots : {}).map(([f, s]) => [f, slotOf(s)]));
  return { ok: true, reason: null, eraSlots, headSlots, occupied: arr(storageRead.occupied), eras: arr(storageRead.eras), identity };
}

/**
 * Counter readings as `{slot, value: bigint, eras}`. The ledger records what
 * was READ — a slot and its value — and which eras a slot stands for is the
 * answer of the table the judge is GIVEN, never of one the collector held: a
 * re-judgement against a regenerated table must not carry a second, frozen
 * slot→era mapping that disagrees with it. A slot off that table stands for no
 * era. A reading whose slot or value does not parse, or a second reading of a
 * slot already read (one slot, one read — which of two values is the counter
 * is unknowable), is not dropped: it is returned in `unreadable`, and the range
 * obligations refuse on it — a reading nobody can read cannot be shown to be
 * zero, or to stay inside the range.
 */
function readingsOf(list, table, field) {
  const readings = [];
  const unreadable = [];
  if (list !== undefined && list !== null && !Array.isArray(list)) unreadable.push({ field, slot: null, value: stable(list), why: `the ${field} readings are not a list` });
  for (const r of arr(list)) {
    const slot = slotOf(r?.slot);
    const value = big(r?.value);
    if (slot === null || value === null) {
      unreadable.push({ field, slot: slot ?? stable(r?.slot), value: stable(r?.value), why: slot === null ? 'its slot does not parse' : 'its value does not parse' });
      continue;
    }
    if (readings.some((x) => x.slot === slot)) {
      unreadable.push({ field, slot, value: dec(value), why: 'the slot is read more than once' });
      continue;
    }
    readings.push({ slot, value, eras: table.eraSlots[field]?.find((e) => e.slot === slot)?.eras ?? [] });
  }
  return { readings, unreadable };
}

/**
 * One row observation as the judge reads it, and — when it cannot be read —
 * why. Three fields carry a row: its SOURCE decides which reconciliation it
 * joins, its LOAN ID keys every join, and its AMOUNT is what the merge
 * compares and the total sums. Each is read here, once, and a read is
 * UNREADABLE when
 *   - its source is neither `storage` nor `routed-getter`;
 *   - its loan id does not parse, or lies outside `1..nextLoanId` — every id
 *     is `++nextLoanId`, so no read of this range was asked about it;
 *   - its amount is present and is not a whole non-negative number, or is
 *     missing on a read that has one (every read but a storage intent row,
 *     whose slot holds an orderHash, not an amount).
 * `fileClass` files an unreadable read unknown, total withdrawn, and fails
 * `row-attributed` naming it — exactly as it treats a key read twice. Reading
 * past it instead certified rows nobody read: an unknown source passed as
 * storage, an id the scan never reached was counted, and an amount that did
 * not parse became a missing one, which the HEAD merge and the getter
 * agreement then judged by two different rules (one row counted twice, under
 * `proven`). The class is known here; the range is the one storage decided.
 */
function observationOf(o, range) {
  const source = o.source === 'storage' || o.source === 'routed-getter' ? o.source : null;
  const id = big(o.loanId);
  const amountRecorded = o.amount !== null && o.amount !== undefined;
  const amount = amountRecorded ? amountOf(o.amount) : null;
  const why = [];
  if (source === null) why.push(`its source ${shown(o.source)} is neither storage nor routed-getter`);
  if (id === null) why.push(`its loan id ${shown(o.loanId)} does not parse`);
  else if (id < 1n) why.push(`its loan id ${id} is no loan id (ids start at 1)`);
  else if (range.known && id > range.N) why.push(`its loan id ${id} exceeds nextLoanId=${range.N}, so no read of the range was asked about it`);
  if (amountRecorded && amount === null) why.push(`its amount ${shown(o.amount)} is not a whole non-negative number`);
  else if (!amountRecorded && !(o.class === INTENT && source === 'storage')) why.push('it carries no amount, which only a storage intent row (an orderHash, not an amount) may');
  return {
    loanId: idOf(o.loanId),
    amount,
    assetAddr: addrOf(o.assetAddr),
    assetSource: typeof o.assetSource === 'string' ? o.assetSource : null,
    source,
    slot: slotOf(o.slot),
    extra: o.extra ?? null,
    unreadable: why.length ? why.join('; ') : null,
  };
}

/**
 * The facet hosting a scope getter, as the ledger records it: `{ host,
 * conflict }`. Every key form PRESENT (selector, getter, role) records the
 * same read — which facet answers that selector — and a form naming no
 * address (`null`, the collector's "no facet") is an answer too. One key,
 * one read (#2095 round-28 'duplicate reads'): forms that disagree leave the
 * host unknown, with the disagreement named, rather than settled by which
 * form is consulted first — a precedence that once let a selector naming
 * HEAD's facet outvote a role naming an earlier era's.
 */
function hostFor(hostOf, role) {
  if (!isObj(hostOf)) return { host: null, conflict: null };
  const { getter, selector } = SCOPE_GETTERS[role];
  const forms = [selector, getter, role].filter((k) => hostOf[k] !== undefined).map((k) => [k, typeof hostOf[k] === 'string' && hostOf[k] ? hostOf[k].toLowerCase() : null]);
  if (new Set(forms.map(([, h]) => h)).size > 1) {
    return { host: null, conflict: `${getter}'s host is recorded twice, differently (${forms.map(([k, h]) => `${k}: ${h ?? 'no facet'}`).join('; ')}) — one key, one read, so it is unknown` };
  }
  return { host: forms[0]?.[1] ?? null, conflict: null };
}

// ── the derivation (brief §2 steps 1–7): facts the obligations read, independent of the proof standard ──

function deriveFacts(L, storageRead) {
  const table = tableOf(storageRead);
  const flags = isObj(L.flags) ? L.flags : {};
  // The code and Diamond checks are discharged by the collector's RECORDED
  // answers (§1: evidence present, never the absence of a refusal): a flags
  // record that is not an object, or that does not say `false`, leaves both
  // undischarged rather than reading as "no problem recorded".
  const codePresent = isObj(L.flags) && L.flags.codeAbsent === false;
  const isDiamond = isObj(L.flags) && L.flags.notADiamond === false;
  const scope = {
    vpfiToken: addrOf(L.scope?.vpfiToken),
    source: L.scope?.source === 'on-chain' || L.scope?.source === 'artifact' ? L.scope.source : null,
  };
  const surfaces = isObj(L.surfaces) ? L.surfaces : {};

  // Step 1 — the range. Storage decides it; `nextLoanId`'s slot never moved.
  const st = isObj(L.range?.storage) ? L.range.storage : null;
  const N = st ? big(st.nextLoanId) : null;
  const known = N !== null && N >= 0n;
  const range = {
    known,
    N: known ? N : null,
    truncatedAt: st?.truncatedAt ?? null,
    // The scan's coverage is proven by what it RECORDED (§1: never by the
    // absence of a refusal): the count of ids it read and its rows as a list.
    // A ledger without `truncatedAt` says nothing about completeness, and a
    // `--rejudge` reads ledgers no current collector wrote.
    loansScanned: st ? big(st.read?.loansScanned) : null,
    observationsListed: Array.isArray(L.observations),
    unavailable: L.range?.storageUnavailable ?? null,
  };
  const parsedCounters = Object.fromEntries(COUNTER_FIELDS.map((f) => [f, readingsOf(st?.counters?.[f], table, f)]));
  const readings = Object.fromEntries(COUNTER_FIELDS.map((f) => [f, parsedCounters[f].readings]));
  const unreadableCounters = COUNTER_FIELDS.flatMap((f) => parsedCounters[f].unreadable);
  // era-coverage (S2-9/S3-4): every slot the table lists, for every field, was
  // READ — recorded per field in `slotsScanned`, and for the counters also as a
  // value. A table regenerated after the read that names a slot this run never
  // touched would make an offline re-judgement dishonest, so it fails by name
  // rather than certifying the unread slot.
  const missing = [];
  if (table.ok && known) {
    const scanned = isObj(st?.read?.slotsScanned) ? st.read.slotsScanned : {};
    for (const [field, list] of Object.entries(table.eraSlots)) {
      const read = new Set(arr(scanned[field]).map(slotOf));
      if (COUNTER_FIELDS.includes(field)) {
        const valued = new Set(readings[field].map((r) => r.slot));
        for (const e of list) if (!read.has(e.slot) || !valued.has(e.slot)) missing.push({ field, slot: e.slot });
      } else {
        for (const e of list) if (!read.has(e.slot)) missing.push({ field, slot: e.slot });
      }
    }
  }
  // A Diamond with code on which no storage read was taken: the collector
  // skips the read there for one reason only — the era table it held could not
  // be used — so which slots the reads would cover cannot be computed at all.
  // That is a rerun owed exactly as an unread slot is, once the table is usable
  // (this judge's is: `table.ok`). A no-code or non-Diamond address has nothing
  // more to read, so no rerun is owed there.
  const unreadOnDiamond = table.ok && st === null && codePresent && isDiamond;
  const coverage = {
    missing,
    unreadOnDiamond,
    rerunOwed: missing.length > 0 || unreadOnDiamond,
    rerunOwedBecause: missing.length
      ? `${missing.map((m) => `${m.field}@${m.slot}`).join(', ')} — slot(s) the era table lists that the reads never covered`
      : unreadOnDiamond
        ? `no storage read was taken on this Diamond (${L.range?.storageUnavailable ?? 'no reason recorded'}) — the era table was unusable at collection, so the slots the reads cover cannot be computed`
        : null,
  };

  // Step 3 — attribution, computed ahead of the witness list only because each
  // storage witness records whether an attributed facet ever wrote its slot.
  const prov = isObj(L.provenance) ? L.provenance : { read: false, reason: 'the ledger carries no provenance read' };
  const provRead = prov.read === true;
  const provReason = prov.reason ?? 'no reason recorded';
  const ch = isObj(L.cutHistory) ? L.cutHistory : null;
  // The writer lists are read AS lists or not at all: one that is not a list,
  // read as empty, would certify a population nobody read. `loupe` alone may
  // be null (unrouted or failed — the population check names that), and a
  // missing cut history is the population check's to refuse. A facet entry's
  // code hash is read as a keccak256 word or not at all (round-3 review P2):
  // trusted by its type, a null or a number became "no code", which reads as
  // "never wrote" — a read nobody took certifying a writer's absence.
  // One address, one code-hash read (#2095 round-28 'duplicate reads'). The
  // collector reads each writer's code once, keyed by its lowercase address,
  // so an address carrying two facet entries — alike or not, in any spelling
  // — is a malformed ledger, and which entry is the facet's code is
  // unknowable. The pair refuses (`malformed`) and NEITHER entry is
  // attributed, so no fact derived below — a slot's attribution, a scope
  // host's layout — depends on which entry comes first.
  const entriesOf = new Map();
  for (const f of arr(prov.facets)) if (isObj(f) && typeof f.address === 'string') entriesOf.set(f.address.toLowerCase(), (entriesOf.get(f.address.toLowerCase()) ?? 0) + 1);
  const readTwice = new Set([...entriesOf].filter(([, n]) => n > 1).map(([a]) => a));
  const malformed = !provRead
    ? []
    : [
        ['provenance.facets', prov.facets, false],
        ['provenance.loupe', prov.loupe, true],
        ['provenance.recorded.facets', prov.recorded?.facets, false],
        ['cutHistory.addresses', ch?.addresses, ch === null],
        ['cutHistory.initializers', ch?.initializers, ch === null],
      ]
        .filter(([, v, mayBeAbsent]) => !Array.isArray(v) && !(mayBeAbsent && (v === null || v === undefined)))
        .map(([k]) => `${k} is not a list`)
        .concat(arr(prov.facets).some((f) => !isObj(f) || typeof f.address !== 'string') ? ['provenance.facets has an entry without an address'] : [])
        .concat(
          arr(prov.facets)
            .filter((f) => isObj(f) && typeof f.address === 'string' && !isCodeHash(f.codeHash))
            .map((f) => `provenance.facets entry ${f.address.toLowerCase()} carries no code-hash read (codeHash ${shown(f.codeHash)} is not a keccak256 word)`),
        )
        .concat([...readTwice].sort(byText).map((a) => `provenance.facets carries ${entriesOf.get(a)} entries for ${a} — one address, one code-hash read`));
  // Only an entry whose hash was READ, once, is attributed: one whose hash
  // does not parse is no read, so its address joins `unhashed` below wherever
  // a writer list names it, exactly as a named writer with no entry at all
  // does; an address read twice is refused above, as malformed.
  const facets = provRead
    ? arr(prov.facets)
        .filter((f) => isObj(f) && isCodeHash(f.codeHash) && !readTwice.has(String(f.address ?? '').toLowerCase()))
        .map((f) => ({ address: String(f.address ?? '').toLowerCase(), sources: arr(f.sources).map(String), codeHash: f.codeHash }))
    : [];
  const recordedFacets = arr(prov.recorded?.facets).map((f) => (typeof f === 'string' ? f : f?.address)).filter((a) => typeof a === 'string');
  // Attribution judges only the facets whose code hash was READ, while the
  // population check vouches for every writer the cut history, the loupe and
  // the records name. Before the arrest the collector attributed the very
  // union it built, so the two sets were one by construction; split from the
  // collector, the judge must show they are (root-arrest review r1 P1). A
  // named writer with no code-hash read is a writer whose layout nothing
  // attested — it refuses exactly as an unattributed one does.
  // (A named writer read twice carries reads, just not one: it is named under
  // `malformed`, not here.)
  const hashed = new Set(facets.map((f) => f.address));
  const named = provRead ? [...new Set([...arr(ch?.addresses), ...arr(ch?.initializers), ...arr(prov.loupe), ...recordedFacets].map((a) => String(a).toLowerCase()))] : [];
  const unhashed = named.filter((a) => !hashed.has(a) && !readTwice.has(a)).sort(byText);
  // an address the cut history names with empty code is unreadable, not
  // "never wrote" (#2095 r15/r17 P1) — named by MEMBERSHIP in the cut
  // history's own lists, never by the facet entry's self-reported label
  // (round-3 review P2)
  const attribution = refuseUnreadableCutSources(attributeFacetCode({ facets, eras: table.eras }), { addresses: arr(ch?.addresses), initializers: arr(ch?.initializers) });
  const population = provRead
    ? cutHistoryCompleteness({
        verdict: String(ch?.verdict ?? 'unread').split(' ')[0],
        cuts: ch?.cuts ?? 0,
        constructorCutSeen: ch?.constructorCutSeen === true,
        addresses: arr(ch?.addresses).map(String),
        loupe: Array.isArray(prov.loupe) ? prov.loupe.map(String) : null,
        cutFacetHost: typeof prov.cutFacetHost === 'string' ? prov.cutFacetHost : null,
        loupeReadFailed: prov.loupeReadFailed === true,
        recordedFacets,
      })
    : { complete: false, reasons: [`layout provenance was not read (${provReason})`] };
  const attributedEras = new Set(attribution.attributed.flatMap((a) => a.eras.map((e) => String(e.layoutEra ?? e.commit).slice(0, 9))));
  const namedSet = new Set(named);
  const namedAttributed = attribution.attributed.filter((a) => namedSet.has(a.address)).length;
  // ONE list states the attribution rule: attribution holds exactly when
  // nothing here refuses. Each refusal carries the brief the per-class
  // outcome quotes and the full text scanned.provenance.refusal publishes, so
  // the rule, its summary and its statement are one list and cannot drift.
  const refusals = [];
  const refuse = (brief, full) => refusals.push({ brief, full });
  if (!provRead) refuse(`layout provenance not read (${provReason})`, `layout provenance was not read (${provReason})`);
  else {
    const u = attribution.unattributed;
    if (u.length) refuse(`${u.length} unattributed facet(s)`, `${u.length} facet(s) of this Diamond carry code no layout era's build produced (${u.slice(0, 4).map((x) => `${x.address} via ${x.sources.join('+')}`).join('; ')}${u.length > 4 ? '; …' : ''}) — compiled from sources the walk never saw (a dirty tree, an unmerged branch), so the era-complete read cannot claim to cover their layout`);
    if (!population.complete) refuse('facet population not exhaustive', `the facet population is not exhaustive — ${population.reasons.join('; ')} — so a writer cut in and out between the records could be missing from the set`);
    if (unhashed.length) refuse(`${unhashed.length} named writer(s) without a code-hash read`, `${unhashed.length} writer(s) the cut history, the loupe or the records name carry no code-hash read (${unhashed.slice(0, 4).join('; ')}${unhashed.length > 4 ? '; …' : ''}) — attribution covers only the facets whose code was read, so their layouts are unattested`);
    if (malformed.length) refuse('malformed provenance record', `the provenance record is malformed (${malformed.join('; ')}) — a writer set that cannot be read cannot be attributed`);
    // Positive presence (§1): "every writer is attributed" is true of no
    // writers at all, so attribution is discharged only by a writer PRESENT —
    // one some list names, its code read once and built by an era. A facet
    // entry no list names does not stand in for it. The Diamond's constructor
    // installs the facet hosting diamondCut, so a loupe that answers names at
    // least that writer; a ledger naming none is refused, not certified.
    if (!namedAttributed) refuse('no named writer attributed', `no writer the cut history, the loupe or the records name is attributed (${named.length} named) — "every writer is attributed" holds of an empty population only vacuously`);
  }
  // the refusal in brief, for the per-class outcome; the full text is
  // published once, at scanned.provenance.refusal
  const refusalSummary = refusals.map((r) => r.brief).join(', ');
  const notRead = { shared: false, reason: `layout provenance was not read (${provReason})` };
  // a host the ledger records twice, differently, shares no layout: the
  // disagreement is named before any host is compared
  const sharedLayout = (roles) => {
    const hosts = roles.map((r) => hostFor(L.hostOf, r));
    const conflict = hosts.find((h) => h.conflict)?.conflict;
    return conflict ? { shared: false, reason: conflict } : gettersShareLayout(attribution.attributed, hosts.map((h) => h.host));
  };
  const scopeShared = {
    // the TOKEN getter joins every exclusion (#2095 r25 P1): a row is filed by
    // comparing its getter's asset with getVPFIToken(), so all of them must
    // read one layout for the comparison to mean anything
    fallbackSnapshotCustody: provRead ? sharedLayout(['fallback', 'loan', 'token']) : notRead,
    liveIntentCommits: provRead ? sharedLayout(['intent', 'token']) : notRead,
  };
  const slotAttributed = (field, slot) => slot !== null && (table.eraSlots[field]?.find((e) => e.slot === slot)?.eras ?? []).some((e) => attributedEras.has(String(e.commit).slice(0, 9)));

  // Step 2 — counters and the one witness list. HEAD/earlier/aliased is
  // DERIVED from the raw per-era readings (#2095 r6 P2: an earlier counter slot
  // that is a current value field today reads that field, not a counter).
  let kept = readings;
  let unexplained = [];
  let aliased = [];
  if (table.ok && known) {
    const a = attributeCounters({ nextLoanId: N, ...readings }, table.headSlots, table.occupied);
    kept = { totalLoansEverCreated: a.counters.totalLoansEverCreated, intentLiveCommitCount: a.counters.intentLiveCommitCount };
    unexplained = a.unexplained;
    aliased = a.aliased;
  }
  const headOf = (f) => (table.ok ? (kept[f].find((x) => x.slot === table.headSlots[f]) ?? null) : null);
  const head = { totalLoansEverCreated: headOf('totalLoansEverCreated'), intentLiveCommitCount: headOf('intentLiveCommitCount') };
  // C4/S2-1 — the ONLY zero-loans bound: storage's own loan counter at zero and
  // every KEPT counter reading of both kinds zero (brief step 2; the bound the
  // shell path held since #2095 r6 P2). A reading set aside as aliased sits at
  // an earlier era's counter slot a current VALUE field occupies today (a list
  // length, tierTableVersion) and reads that field. At nextLoanId=0 it cannot
  // be a loan counter: `nextLoanId`'s slot never moved and every loan id is
  // `++nextLoanId`, so no era ever issued one, and every row of the four
  // classes is keyed by a loan id. Counting it would refuse the bound on every
  // loan-less Diamond with offers or a tier table. Routed zeros agree with the
  // bound; they never are it.
  // A reading that cannot be read (it does not parse, or its slot was read
  // twice) is in no kept list and cannot be shown to be zero: it withholds the
  // bound rather than vanishing from it.
  // And the bound rests on readings PRESENT (§1), never on an empty list:
  // "every kept reading is zero" is true of no readings at all, so a counters
  // record with no reading, with one kind missing, or without HEAD's slot
  // would grant the bound over counters nobody read. HEAD's slot holds each
  // counter today and is never set aside as aliased, so its reading of BOTH
  // kinds must be read, kept and zero. `headUnread` names a kind whose HEAD
  // reading is absent (one that is present but unreadable is already named in
  // `unreadableCounters`), so a refusal states each gap once.
  const keptReadings = [...kept.totalLoansEverCreated, ...kept.intentLiveCommitCount];
  const nonZero = keptReadings.filter((x) => x.value !== 0n);
  const headUnread = COUNTER_FIELDS.filter((f) => head[f] === null && !(table.ok && unreadableCounters.some((u) => u.field === f && u.slot === table.headSlots[f])));
  const zero = known && N === 0n && COUNTER_FIELDS.every((f) => head[f] !== null) && nonZero.length === 0 && unreadableCounters.length === 0;
  const rel = (v) => (!known || v === null ? null : v > N ? '>' : v < N ? '<' : '=');
  const witnesses = [];
  if (head.totalLoansEverCreated) {
    const h = head.totalLoansEverCreated;
    witnesses.push({ source: 'storage', what: "totalLoansEverCreated at HEAD's slot", slot: h.slot, value: dec(h.value), relation: rel(h.value), attributedWriter: slotAttributed('totalLoansEverCreated', h.slot) });
  }
  for (const u of unexplained.filter((x) => x.which === 'totalLoansEverCreated')) {
    const s = slotOf(u.slot);
    witnesses.push({ source: 'storage', what: "totalLoansEverCreated at an earlier era's slot no current value field occupies", slot: s, value: String(u.value), relation: rel(big(u.value)), attributedWriter: slotAttributed('totalLoansEverCreated', s), ...(u.atMappingHead ? { atMappingHead: u.atMappingHead } : {}) });
  }
  const routedRaw = isObj(L.range?.routed) ? L.range.routed : null;
  const routed = routedRaw ? { stats: big(routedRaw.totalLoansEverCreated), ids: idSetOf(routedRaw.enumeratedIds), reported: big(routedRaw.reportedTotal) } : null;
  if (routed) {
    witnesses.push({ source: 'routed', what: 'getProtocolStats()[3]', value: dec(routed.stats), relation: rel(routed.stats) });
    witnesses.push({ source: 'routed', what: 'getAllLoansPaginated ids enumerated', value: routed.ids ? dec(sizeOf(routed.ids)) : null, relation: routed.ids ? rel(sizeOf(routed.ids)) : null });
    witnesses.push({ source: 'routed', what: 'getAllLoansPaginated reported total', value: dec(routed.reported), relation: rel(routed.reported) });
  }
  // Strict `>` (V10): a counter or a routed figure ABOVE the range names a loan
  // the range cannot reach; one below it is a stale or vehicle-filtered witness.
  // A witness that does not parse is not "no contradiction": nobody can show
  // it stays inside the range, so it withholds no-range-contradiction by name,
  // exactly as one above the range does.
  //
  // Nor is a witness the reads OWE and the ledger does not carry (§1: the
  // obligation is discharged by witnesses present, never by their absence).
  // Storage's own is HEAD's lifetime counter, which every storage read takes.
  // The routed one is owed unless the surfaces RECORD the enumeration
  // unavailable — getProtocolStats unrouted, or it routed and
  // getAllLoansPaginated not (the collector probes the second only when the
  // first routes): both recorded routed with no witness is a witness missing,
  // and a surfaces record that answers neither way leaves unread whether one
  // was owed.
  const unreadableWitnesses = unreadableCounters.map((u) => `the ${u.field} reading at ${u.slot ?? 'no slot'} (${u.value}): ${u.why}`);
  const unrecordedWitnesses = [];
  if (headUnread.includes('totalLoansEverCreated')) {
    unrecordedWitnesses.push(table.ok ? `no totalLoansEverCreated reading at HEAD's slot ${table.headSlots.totalLoansEverCreated ?? '(not in the era table)'} is recorded` : `HEAD's totalLoansEverCreated slot is unknown (the era table is unavailable: ${table.reason})`);
  }
  const metricsUnrouted = surfaces.getProtocolStats === 'unrouted' || (surfaces.getProtocolStats === 'routed' && surfaces.getAllLoansPaginated === 'unrouted');
  if (routed) {
    if (routed.stats === null) unreadableWitnesses.push(`getProtocolStats()[3] does not parse (${stable(routedRaw.totalLoansEverCreated)})`);
    if (routed.ids === null) unreadableWitnesses.push(`getAllLoansPaginated's enumerated ids do not parse (${stable(routedRaw.enumeratedIds).slice(0, 80)})`);
    if (routed.reported === null) unreadableWitnesses.push(`getAllLoansPaginated's reported total does not parse (${stable(routedRaw.reportedTotal)})`);
  } else if (L.range?.routed !== null && L.range?.routed !== undefined) {
    unreadableWitnesses.push(`the routed range witness is not a record (${stable(L.range.routed).slice(0, 80)})`);
  } else if (surfaces.getProtocolStats === 'routed' && surfaces.getAllLoansPaginated === 'routed') {
    unrecordedWitnesses.push('both metrics selectors are recorded routed, yet the ledger carries no routed range witness');
  } else if (!metricsUnrouted) {
    unrecordedWitnesses.push(`no routed range witness, and no record that the metrics enumeration is unrouted (getProtocolStats ${shown(surfaces.getProtocolStats)}, getAllLoansPaginated ${shown(surfaces.getAllLoansPaginated)}) — whether one was owed is unread`);
  }
  const contradictions = [];
  if (known) {
    for (const w of witnesses) if (w.relation === '>') contradictions.push(`${w.what} = ${w.value}${w.slot ? ` at ${w.slot}` : ''} > nextLoanId=${N}`);
    for (const id of routed?.ids?.ids ? outsideRange(routed.ids, N) : []) contradictions.push(`getAllLoansPaginated enumerated loan id ${id}, outside 1..${N}`);
    if (N === 0n) for (const r of kept.intentLiveCommitCount) if (r.value > 0n) contradictions.push(`intentLiveCommitCount=${r.value} at ${r.slot} with nextLoanId=0`);
  }
  // S1-R2/S2-3/S2-4 — the routed enumeration is SOUND only when it is present
  // and agrees with storage: its lifetime counter equals HEAD's (which never
  // counted vehicle loans), its ids are a SUBSET of the range (pagination skips
  // vehicles), its total does not exceed it, and it lists every loan ANY
  // era's lifetime counter counted, HEAD's included. An absent enumeration is
  // not agreement.
  //
  // That last conjunct (#2095 r28 P1b): every loan a lifetime counter counted
  // is a loan the pagination lists. The pagination lists every id with a loan
  // record that is not a vehicle, and loan records are never deleted; the
  // counter is incremented once per initialized loan and never for a vehicle;
  // the two vehicle rules arrived in one change (#1825), so no era counted a
  // loan the pagination hides. A kept lifetime reading ABOVE the distinct ids
  // listed therefore names loans storage counted that the pagination does not
  // list — the metrics facet is reading `s.loans` under another layout. That
  // is ONE rule over every kept reading: HEAD's, and each earlier era's that
  // no current field explains (`unexplained`, never an aliased one, which
  // reads a value field). HEAD is not exempt because it equals the routed
  // counter: equality says the stats getter reads HEAD's counter slot, not
  // that the pagination reads HEAD's loan records, so HEAD 5 = routed 5 beside
  // an empty enumeration is the r28 P1 shape at HEAD (round-3 review P1).
  // Without the earlier term, an empty enumeration beside HEAD 0 passed as
  // agreement over an old counter of 3. Each reading is bounded on its own,
  // never their sum, because an upgrade may have copied the old value
  // forward: a migrated Diamond (old 3, HEAD 2, ids 1..5) stays sound. A
  // reading that cannot be read cannot be shown to be listed, so it withholds
  // soundness, as it withholds the zero bound.
  const earlierCounted = unexplained.filter((x) => x.which === 'totalLoansEverCreated');
  const unreadableCounted = unreadableCounters.filter((u) => u.field === 'totalLoansEverCreated');
  let routedBecause = null;
  if (!routed) routedBecause = 'no routed enumeration (the metrics surface is not routed)';
  else if (!known) routedBecause = 'the storage range is unknown';
  else if (routed.stats === null || !head.totalLoansEverCreated || routed.stats !== head.totalLoansEverCreated.value) routedBecause = `getProtocolStats()[3]=${dec(routed.stats)} vs totalLoansEverCreated at HEAD's slot ${head.totalLoansEverCreated ? dec(head.totalLoansEverCreated.value) : 'unread'}`;
  else if (!routed.ids || outsideRange(routed.ids, N).length) routedBecause = `the enumerated ids are not a subset of 1..${N}`;
  else if (routed.reported === null || routed.reported > N) routedBecause = `reportedTotal=${dec(routed.reported)} > nextLoanId=${N}`;
  else {
    const listed = distinctSizeOf(routed.ids);
    // HEAD's reading is non-null here: the stats comparison above refused without it
    const counted = [head.totalLoansEverCreated, ...earlierCounted];
    const unlisted = counted.filter((u) => BigInt(u.value) > listed);
    if (unlisted.length) routedBecause = `totalLoansEverCreated counted more loans than the ${dec(listed)} distinct id(s) enumerated (${unlisted.map((u) => `${dec(BigInt(u.value))} at ${u.slot}${u === head.totalLoansEverCreated ? " (HEAD's slot)" : " (an earlier era's slot)"}`).join('; ')}) — loans storage counted that the pagination does not list`;
    else if (unreadableCounted.length) routedBecause = `a totalLoansEverCreated reading cannot be read (${unreadableCounted.map((u) => `at ${u.slot ?? 'no slot'}: ${u.why}`).join('; ')}) — nobody can show the enumeration lists the loans it counted`;
  }
  const routedEnumerationSound = routed !== null && routedBecause === null;

  // Step 4 — observations, per class, sorted canonically first so the result
  // does not depend on the order the collector read in.
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, []]));
  const unfiled = [];
  for (const o of arr(L.observations)) {
    if (!isObj(o) || !CLASSES.includes(o.class)) {
      unfiled.push(o);
      continue;
    }
    byClass[o.class].push(observationOf(o, range));
  }
  const sortKey = (o) => [o.source ?? '', o.slot ?? '', dec(o.amount) ?? '', o.assetAddr ?? '', o.assetSource ?? '', stable(o.extra), o.unreadable ?? ''].join('|');
  for (const c of CLASSES) byClass[c].sort((a, b) => compareIds(a.loanId, b.loanId) || byText(sortKey(a), sortKey(b)));

  const cls = {};
  for (const c of CLASSES) {
    cls[c] = fileClass(c, byClass[c], { table, range, surfaces, scope, scopeShared: scopeShared[c] ?? null, slotAttributed, idsAsked: L.idsAskedOfGetter, unfiled: unfiled.length });
  }

  // Step 7 — the class-3 extras, both over observations of EVERY scope: the
  // counter is protocol-wide (#2095 r12 P2), and the event lifecycle saw every
  // live commit whatever its asset (S1-R4).
  const intentCandidates = cls[INTENT].deduped.length;
  const earlierIntent = unexplained.filter((x) => x.which === 'intentLiveCommitCount');
  const headIntent = head.intentLiveCommitCount;
  const corr = isObj(L.corroboration) ? L.corroboration : null;
  const fromLogs = corr && Array.isArray(corr.liveLoanIdsFromLogs) ? corr.liveLoanIdsFromLogs.map(idOf).sort(compareIds) : null;
  // "Not taken" is a RECORD too (§1): the collector writes `null` when it did
  // not walk the logs and an `unavailable` reason when the walk failed. A
  // ledger that says neither and lists no ids — the key missing, a record
  // carrying neither, ids that are not a list — records nothing either way,
  // and is not read as "not taken".
  const corrState = fromLogs !== null ? 'taken' : L.corroboration === null ? 'not-taken' : corr && typeof corr.unavailable === 'string' && corr.liveLoanIdsFromLogs === undefined ? 'unavailable' : 'unrecorded';
  const fromView = [...new Set(byClass[INTENT].filter((o) => o.source === 'routed-getter').map((o) => o.loanId))].sort(compareIds);

  return {
    table,
    flags,
    scope,
    surfaces,
    range,
    coverage,
    flagsRecorded: isObj(L.flags),
    codePresent,
    isDiamond,
    counters: { kept, head, headUnread, unexplained, aliased, zero, readingCount: keptReadings.length, nonZero, unreadable: unreadableCounters },
    witnesses,
    contradictions,
    unreadableWitnesses,
    unrecordedWitnesses,
    routed: { present: routed !== null, stats: routed?.stats ?? null, sound: routedEnumerationSound, because: routedBecause },
    attribution: { read: provRead, reason: provRead ? null : provReason, facets, ...attribution, population, unhashed, malformed, refusals, refusalSummary, holds: refusals.length === 0 },
    scopeShared,
    unfiled,
    cls,
    intent: {
      candidates: intentCandidates,
      earlierNonZero: earlierIntent,
      contradiction: known && ((headIntent !== null && headIntent.value > BigInt(intentCandidates)) || earlierIntent.length > 0),
    },
    corroboration: {
      state: corrState,
      record: L.corroboration,
      taken: fromLogs !== null,
      agrees: fromLogs === null ? null : fromLogs.length === fromView.length && fromLogs.every((id, i) => id === fromView[i]),
      fromLogs,
      fromView,
    },
  };
}

/**
 * Steps 4–6 for ONE class: deduplicate its observations, reconcile the routed
 * getter against HEAD storage, attribute every slotted row, tag every asset,
 * and compute the figures. Every observation lands in exactly one of `rows`,
 * `unknown` and `excluded` — nothing is dropped.
 */
function fileClass(c, observations, { table, range, surfaces, scope, scopeShared, slotAttributed, idsAsked, unfiled }) {
  const field = FIELD_OF[c];
  const amountField = LIABILITY_CLASS_FIELDS[c];
  const getter = PRIMARY_GETTER[c];
  // a getter that returned a row answered, whatever `surfaces` records
  const getterRouted = surfaces[getter] === 'routed' || observations.some((o) => o.source === 'routed-getter');
  // One that returned none is outside the reconciliation only where the ledger
  // RECORDS it unrouted (§1). The collector probes each primary getter on every
  // Diamond and records the answer; a surfaces entry that says neither —
  // missing, 'not-probed', anything else — leaves unread whether a routed read
  // was owed, and is never taken for "unrouted".
  const getterUnrouted = !getterRouted && surfaces[getter] === 'unrouted';
  // One key, one read (root-arrest review r1 P2). The collector asks each
  // getter once per id and reads each slot once, so a (getter, loan) or a
  // (storage, loan, slot) key that occurs twice is a malformed ledger — and
  // the reconciliation below keys by loan id, where a second read would
  // silently replace the first: a getter row storage never saw passing as
  // reconciled, two values at one slot, a doubled total, an inflated intent
  // candidate count. Every read of a repeated key is filed unknown (counted,
  // total withdrawn) and fails `row-attributed`; none is reconciled or counted
  // as an intent candidate.
  //
  // A read the judge cannot read (`observationOf`) is set aside the same way,
  // and first: it has no key a join can trust, so it is neither reconciled,
  // nor merged, nor an intent candidate, nor one of a repeated key's reads.
  const unreadable = observations.filter((o) => o.unreadable !== null);
  const readable = observations.filter((o) => o.unreadable === null);
  const keyOf = (o) => (o.source === 'routed-getter' ? `routed|${o.loanId}` : `storage|${o.loanId}|${o.slot ?? 'no slot'}`);
  const reads = new Map();
  for (const o of readable) reads.set(keyOf(o), (reads.get(keyOf(o)) ?? 0) + 1);
  const repeated = readable.filter((o) => reads.get(keyOf(o)) > 1);
  const routedObs = readable.filter((o) => o.source === 'routed-getter' && reads.get(keyOf(o)) === 1);
  const storageObs = readable.filter((o) => o.source === 'storage' && reads.get(keyOf(o)) === 1);
  const eraAt = (slot) => (slot === null ? null : slot === table.headSlots[field] ? 'head' : 'earlier');

  // HEAD vs earlier is derived against the table (splitByHeadSlot), and an
  // earlier row whose old head is a current MAPPING's head is ambiguous
  // (markAliasedRows) — today's row for the same key sits at the same slot.
  const { head, earlier } = splitByHeadSlot({ [c]: storageObs.map((o) => ({ ...o, mappingSlot: o.slot })) }, table.headSlots);
  const headRows = head[c];
  const earlierRows = [...markAliasedRows(earlier[c].filter((o) => o.mappingSlot !== null), table.occupied), ...earlier[c].filter((o) => o.mappingSlot === null)];

  // One observation where two reads saw the same row: a HEAD-slot storage row
  // and a routed row with the same amount (presence only for intent — storage
  // reads its orderHash, the getter its order). "The same amount" is
  // `amountsAgree`, the predicate getterAgreement asks below, so a pair the
  // merge leaves apart is a pair the agreement check names. The merged
  // observation keeps asset, source and extra from the ROUTED row; storage
  // contributes only its slot (S2-8).
  const consumed = new Set();
  const out = routedObs.map((r) => {
    const i = headRows.findIndex((s, k) => !consumed.has(k) && s.loanId === r.loanId && (c === INTENT || amountsAgree(s.amount, r.amount)));
    if (i < 0) return { ...r, era: null };
    consumed.add(i);
    return { ...r, slot: headRows[i].slot, era: 'head', storageTwin: true };
  });
  out.push(...headRows.filter((_, k) => !consumed.has(k)).map((s) => ({ ...s, era: 'head' })));
  // #2095 r7/r8/r20 — an earlier-era row is absorbed by at most one routed row
  // with the same key AND amount, and only where no HEAD-slot row exists for
  // that loan (a getter reading HEAD is that row; an older same-valued row is a
  // distinct liability). An intent row is never absorbed: a commit left under
  // an old layout beside a current one is a distinct candidate.
  const headLoanIds = new Set(headRows.map((s) => s.loanId));
  for (const e of earlierRows) {
    if (c !== INTENT && !headLoanIds.has(e.loanId)) {
      const j = out.findIndex((m) => m.source === 'routed-getter' && !m.storageTwin && !m.absorbed && m.loanId === e.loanId && amountsAgree(m.amount, e.amount));
      if (j >= 0) {
        out[j] = { ...out[j], slot: e.slot, era: 'earlier', absorbed: true, ...(e.ambiguous ? { ambiguous: true, aliasesCurrentField: e.aliasesCurrentField } : {}) };
        continue;
      }
    }
    out.push({ ...e, era: 'earlier' });
  }

  // #2095 r4 P1 — the routed getter and HEAD storage must agree per loan id,
  // both ways: a row storage sees at HEAD's slot that the getter did not
  // report, a routed row storage does not see THERE, or a differing amount
  // means the cut getter reads a layout other than the one its proof assumes
  // (design §7a, round 4). EVERY routed row is reconciled against HEAD's
  // slot, the absorbed ones included: the absorption above makes a getter row
  // and its earlier-era storage twin one row for the COUNT (#2095 r7 P2), and
  // the layout disagreement it reveals still stands — the getter demonstrably
  // read an earlier era's slot. That routed read REFUTES the HEAD-layout claim,
  // so removing it may restore a proof, as removing any refuting read may (see
  // the header). An unrouted getter was not asked.
  // an amount nobody read stays `null` — never the word 'null', which once
  // compared equal to itself in getterAgreement while the merge refused it
  const legacy = (o) => ({ loanId: o.loanId, [amountField]: dec(o.amount) });
  // A disagreement says what the reads were, not only that they failed to
  // pair: a getter row storage holds at an earlier era's slot, or a side whose
  // repeated or unreadable read was set aside above, is named as such — never
  // as "absent".
  const earlierTwin = new Map(out.filter((o) => o.absorbed).map((o) => [o.loanId, o.slot]));
  const setAsideGetter = (list) => new Set(list.filter((o) => o.source === 'routed-getter').map((o) => o.loanId));
  const setAsideHead = (list) => new Set(list.filter((o) => o.source === 'storage' && o.slot === table.headSlots[field]).map((o) => o.loanId));
  const repeatedGetter = setAsideGetter(repeated);
  const repeatedHead = setAsideHead(repeated);
  const unreadableGetter = setAsideGetter(unreadable);
  const unreadableHead = setAsideHead(unreadable);
  const mismatches = (getterRouted && range.known ? getterAgreement({ headRows: { [c]: headRows.map(legacy) }, routed: { [c]: routedObs.map(legacy) } })[c] : []).map((m) =>
    m.getter === 'present' && earlierTwin.has(m.loanId)
      ? { ...m, storage: `absent at the HEAD slot, present at the earlier era slot ${earlierTwin.get(m.loanId)}` }
      : m.getter === 'present' && repeatedHead.has(m.loanId)
        ? { ...m, storage: 'read more than once at the HEAD slot (filed unknown)' }
        : m.getter === 'present' && unreadableHead.has(m.loanId)
          ? { ...m, storage: 'read at the HEAD slot, but the read cannot be read (filed unknown)' }
          : m.getter === 'absent' && repeatedGetter.has(m.loanId)
            ? { ...m, getter: 'answered more than once (filed unknown)' }
            : m.getter === 'absent' && unreadableGetter.has(m.loanId)
              ? { ...m, getter: 'answered, but the answer cannot be read (filed unknown)' }
              : m,
  );

  const rows = [];
  const unknown = [];
  const excluded = [];
  const rowAttributionFailures = [];
  for (const o of out) {
    // S1-R3/S2-7 — a read at a slot is a row of this mapping only where it is
    // unambiguous AND the slot is the mapping's slot in a layout era some
    // ATTRIBUTED facet of this deployment was compiled against; otherwise it
    // is filed unknown (counted, total withdrawn).
    if (o.source === 'storage' || o.slot !== null) {
      const why = o.ambiguous
        ? `aliasReading: the old head ${o.slot} is today's ${o.aliasesCurrentField} mapping head, whose row for this key sits at the same slot`
        : !slotAttributed(field, o.slot)
          ? `unattributedSlot: ${o.slot ?? 'no slot recorded'} is no attributed layout era's ${field} slot`
          : null;
      if (why) {
        rowAttributionFailures.push({ loanId: o.loanId, slot: o.slot, why });
        unknown.push(rowOf(c, o, { unknownBecause: why }));
        continue;
      }
    }
    if (VPFI_BY_CONSTRUCTION.has(c)) {
      rows.push(rowOf(c, o));
      continue;
    }
    // Step 5 — the one place a fallback or intent row is filed. Filing needs
    // the token the Diamond answers AND the derived layout agreement of the
    // getters behind the comparison; both exist only here.
    const assetSound = scope.source === 'on-chain' && scope.vpfiToken !== null && scopeShared?.shared === true;
    const provisional = o.assetAddr !== null && scope.vpfiToken !== null ? { provisionalScope: o.assetAddr === scope.vpfiToken ? 'vpfi' : 'nonVpfi' } : {};
    const unknownBecause =
      o.source === 'storage'
        ? 'storage row — asset not read'
        : o.assetAddr === null
          ? c === 'fallbackSnapshotCustody' && surfaces.getLoanDetails !== 'routed'
            ? 'getLoanDetails unrouted'
            : 'the getter returned no asset'
          : scope.vpfiToken === null
            ? 'token absent'
            : scope.source !== 'on-chain'
              ? 'artifact-sourced token'
              : !assetSound
                ? `hosts do not share a layout: ${scopeShared?.reason ?? 'no layout agreement'}`
                : null;
    if (unknownBecause) unknown.push(rowOf(c, o, { unknownBecause, ...provisional }));
    else if (o.assetAddr === scope.vpfiToken) rows.push(rowOf(c, o));
    else excluded.push(rowOf(c, o));
  }
  for (const o of repeated) {
    const what = o.source === 'routed-getter' ? `${getter} answers` : `storage reads at ${o.slot ?? 'no recorded slot'}`;
    unknown.push(rowOf(c, { ...o, era: eraAt(o.slot) }, { unknownBecause: `duplicateRead: the ledger records ${reads.get(keyOf(o))} ${what} for loan ${o.loanId} — one key, one read` }));
  }
  for (const k of new Set(repeated.map(keyOf))) {
    const o = repeated.find((x) => keyOf(x) === k);
    rowAttributionFailures.push({ loanId: o.loanId, slot: o.slot, why: `duplicateRead: ${reads.get(k)} reads of one ${o.source === 'routed-getter' ? 'getter answer' : 'storage slot'}` });
  }
  // every unreadable read, each on its own: unlike a repeated key, no two of
  // them can be shown to be one read
  for (const o of unreadable) {
    const why = `unreadableRead: ${o.unreadable}`;
    unknown.push(rowOf(c, { ...o, era: eraAt(o.slot) }, { unknownBecause: why }));
    rowAttributionFailures.push({ loanId: o.loanId, slot: o.slot, why });
  }
  if (unfiled) rowAttributionFailures.push({ loanId: null, slot: null, why: `${unfiled} observation(s) in the ledger name no census class — reads the judge cannot file into any class` });

  // Step 6 — the figures, one formula (C3). Status is not an input. A counted
  // row cannot lack an amount (`observationOf` files that read unknown, and a
  // merged row carries its routed twin's); the formula still declines to sum
  // one rather than throw, so it stays total if that ever changes.
  const nullAmounts = rows.filter((r) => r[amountField] === null).length;
  const total = unknown.length || nullAmounts ? null : rows.reduce((a, r) => a + BigInt(r[amountField]), 0n).toString();
  const totalUnavailable =
    total !== null
      ? null
      : unknown.length
        ? `${unknown.length} row(s) in evidence have an unsettled asset or attribution — a total here would bound a liability the reads cannot bound`
        : `${nullAmounts} row(s) carry no amount read`;

  // C6 — a routed getter is asked over 1..nextLoanId(storage), never over the routed enumeration
  const asked = isObj(idsAsked) ? (idsAsked[getter] ?? null) : null;
  const coverage = !getterRouted ? { applies: false, ok: true, asked } : { applies: true, ok: range.known && covers(idSetOf(asked), range.N), asked };
  const getterEntry = getterRouted && range.known && coverage.ok && !mismatches.length ? { kind: 'getter', source: 'routed', detail: `${getter} agreed at HEAD over ${range.N} ids` } : null;

  const sortRows = (list) => list.sort((a, b) => compareIds(a.loanId, b.loanId) || byText(stable(a), stable(b)));
  return {
    field,
    getter,
    getterRouted,
    getterUnrouted,
    deduped: out,
    rows: sortRows(rows),
    unknown: sortRows(unknown),
    excluded: sortRows(excluded),
    mismatches,
    rowAttributionFailures,
    historicalRows: out.filter((o) => o.source === 'storage' && o.era === 'earlier').length,
    // reads the reconciliation never saw, so "agree" can be said only of the rest
    setAsideReads: repeated.length + unreadable.length,
    total,
    totalUnavailable,
    coverage,
    getterEntry,
  };
}

/**
 * A published row: its amount under the field `LIABILITY_CLASS_FIELDS` names
 * for the class (the one list every figure derived from a class reads), where
 * it was read, and why it is filed where it is.
 */
function rowOf(c, o, filing = {}) {
  const r = { loanId: o.loanId, [LIABILITY_CLASS_FIELDS[c]]: dec(o.amount), source: o.source };
  if (o.assetAddr !== null) r.asset = o.assetAddr;
  if (o.assetSource !== null) r.assetSource = o.assetSource;
  if (o.slot !== null) {
    r.mappingSlot = o.slot;
    r.era = o.era;
  }
  if (o.absorbed) r.absorbedStorageRow = true;
  if (o.aliasesCurrentField) r.aliasesCurrentField = o.aliasesCurrentField;
  if (o.extra !== null && o.extra !== undefined) r.extra = copy(o.extra);
  return { ...r, ...filing };
}

// ── the obligations: evaluated in this order, every outcome recorded whatever the status ──

const needsRange = (d) => (d.range.known ? null : { ok: false, detail: 'not evaluable: the storage range is unknown (range-known)' });
/** The aliased counter readings the zero bound did not count, named wherever the bound is stated, so a verdict shows what it set aside. */
const setAside = (d) =>
  d.counters.aliased.length
    ? `; set aside as a current value field's reading, not a counter: ${d.counters.aliased.map((x) => `${x.which}@${x.slot}=${x.value} (today's ${x.aliases})`).join(', ')}`
    : '';
const intentOnly = (cls, name) => (cls === INTENT ? null : { ok: true, detail: `n/a — ${name} binds class 3 (${INTENT}) only` });
/**
 * Both getter obligations for a class whose getter returned no row: it is no
 * conjunct of theirs only where the ledger records it unrouted, so the two
 * cannot disagree on what "unrouted" takes.
 */
const unroutedGetter = (d, c, consequence) =>
  c.getterUnrouted
    ? { ok: true, detail: `${c.getter} is unrouted — ${consequence}` }
    : { ok: false, detail: `the ledger records no routing answer for ${c.getter} (surfaces.${c.getter} is ${shown(d.surfaces[c.getter])}) and holds no row it returned — whether a routed read was owed is unread` };

/** Step 8's waiver under the routed standard — see `provenance-attributed`. */
function routedWaiver(d, cls) {
  if (!d.routed.sound) return { ok: false, detail: `the routed enumeration does not agree with storage (${d.routed.because})` };
  if (d.range.N === 0n) return { ok: true, detail: 'the routed enumeration agrees with storage on zero loans; there is no row for a getter to read' };
  const c = d.cls[cls];
  return c.getterEntry
    ? { ok: true, detail: `the routed enumeration agrees with storage and ${c.getter} read the class over 1..${d.range.N}` }
    : { ok: false, detail: `${c.getter} did not read this class over 1..${d.range.N} through a routed getter — a storage-only proof keeps no exception under the routed standard` };
}

/**
 * The conjuncts of `proven`, in derivation order. `holds(ledger, derived, cls)`
 * reads the derived facts (`derived.standard` is the proof standard) and
 * returns `{ ok, detail, waived? }`. A `deployment` obligation states one fact
 * about the Diamond: it is evaluated once, with no class, and its outcome is
 * recorded once per verdict (`scanned.deploymentObligations`). A `class`
 * obligation is evaluated per class and recorded on each class — the class's
 * own facts, and ANY obligation whose outcome can differ between classes
 * under SOME standard, which is what makes it one. `provenance-attributed` is
 * the case in point: under the provenance standard it is one fact, alike for
 * all four classes, but under the routed standard a refusal is waived per
 * class, on that class's own getter, so one refusal can withhold the held and
 * rebate classes and leave the fallback and intent classes proven.
 */
export const OBLIGATIONS = Object.freeze(
  [
    {
      // Positive (§1): discharged by the collector's recorded `codeAbsent: false`, never by a flag that is missing.
      name: 'code-present',
      scope: 'deployment',
      holds: (_, d) =>
        d.codePresent
          ? { ok: true, detail: 'code present at the census block' }
          : d.flags.codeAbsent === true
            ? { ok: false, detail: String(d.flags.codeAbsentReason ?? 'the address has no code at the census block') }
            : { ok: false, detail: `the ledger records no code read (flags.codeAbsent is ${shown(d.flags.codeAbsent)}${d.flagsRecorded ? '' : '; the flags record is absent or not an object'}) — whether the address has code is unread` },
    },
    {
      // Positive (§1): discharged by the collector's recorded `notADiamond: false`.
      name: 'is-a-diamond',
      scope: 'deployment',
      holds: (_, d) =>
        d.isDiamond
          ? { ok: true, detail: 'the address answers as a Vaipakam Diamond' }
          : d.flags.notADiamond === true
            ? { ok: false, detail: "the contract at the recorded address is NOT a Vaipakam Diamond (custody selectors revert without the fallback's FunctionDoesNotExist) — its rows, if any, are not this protocol's; undetermined until the artifact is corrected" }
            : { ok: false, detail: `the ledger records no Diamond check (flags.notADiamond is ${shown(d.flags.notADiamond)}${d.flagsRecorded ? '' : '; the flags record is absent or not an object'}) — whether the address is this protocol's Diamond is unread` },
    },
    {
      name: 'range-known',
      scope: 'deployment',
      holds: (_, d) =>
        d.range.known
          ? { ok: true, detail: `nextLoanId=${d.range.N} read from storage at its one era slot` }
          : { ok: false, detail: `the loan-id range is unknown: ${d.range.unavailable ?? 'the ledger carries no storage read of nextLoanId'}` },
    },
    {
      name: 'era-coverage',
      scope: 'deployment',
      holds: (_, d) => {
        if (!d.table.ok) return { ok: false, detail: `the era table is unavailable: ${d.table.reason}` };
        if (d.coverage.unreadOnDiamond) return { ok: false, detail: `${d.coverage.rerunOwedBecause} — a rerun is owed` };
        const r = needsRange(d);
        if (r) return r;
        const m = d.coverage.missing;
        return m.length
          ? { ok: false, detail: `the era table lists ${m.length} slot(s) this run never read (${m.slice(0, 6).map((x) => `${x.field}@${x.slot}`).join(', ')}${m.length > 6 ? ', …' : ''}) — a rerun is owed` }
          : { ok: true, detail: 'every era slot the table lists was read' };
      },
    },
    {
      // Positive (§1): discharged by the scan's own record that it read every
      // id of the range, never by the absence of a truncation marker.
      name: 'not-truncated',
      scope: 'deployment',
      holds: (_, d) => {
        const r = needsRange(d);
        if (r) return r;
        const problems = [];
        if (d.range.truncatedAt !== null) problems.push(`the scan stopped at ${d.range.truncatedAt} of nextLoanId=${d.range.N}; rows beyond it were not read`);
        if (d.range.loansScanned === null) problems.push('the ledger records no count of the loan ids the storage scan read');
        else if (d.range.loansScanned !== d.range.N) problems.push(`the storage scan read ${d.range.loansScanned} loan id(s), not the ${d.range.N} of the range`);
        if (!d.range.observationsListed) problems.push("the ledger's observations are not a list, so the rows the scan read are not recorded");
        return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `the storage scan read all ${d.range.N} id(s) of the range` };
      },
    },
    {
      name: 'no-range-contradiction',
      scope: 'deployment',
      holds: (_, d) => {
        const r = needsRange(d);
        if (r) return r;
        const problems = [];
        if (d.contradictions.length) problems.push(`a witness contradicts the loan-id range (${d.contradictions.join('; ')}) — rows the range cannot reach may exist`);
        if (d.unreadableWitnesses.length) problems.push(`a witness cannot be read (${d.unreadableWitnesses.join('; ')}) — nobody can show it stays inside the range`);
        if (d.unrecordedWitnesses.length) problems.push(`a witness the reads owe is not recorded (${d.unrecordedWitnesses.join('; ')}) — nobody can show it stays inside the range`);
        return problems.length ? { ok: false, detail: problems.join('; and ') } : { ok: true, detail: `no witness exceeds nextLoanId=${d.range.N}` };
      },
    },
    {
      // S2-1 — at nextLoanId=0 an empty scan proves nothing on its own: only
      // the zero bound settles it — HEAD's reading of both counter kinds
      // present, and every kept reading of both kinds zero.
      name: 'range-nonempty-or-bound',
      scope: 'deployment',
      holds: (_, d) =>
        needsRange(d) ??
        (d.range.N > 0n
          ? { ok: true, detail: `the range 1..${d.range.N} is non-empty` }
          : d.counters.zero
            ? { ok: true, detail: `nextLoanId=0 and all ${d.counters.readingCount} kept counter reading(s) of both kinds, HEAD's included, are zero${setAside(d)}` }
            : {
                ok: false,
                detail: `nextLoanId=0 while ${[
                  ...d.counters.headUnread.map((f) => (d.table.ok ? `no ${f} reading at HEAD's slot ${d.table.headSlots[f] ?? '(not in the era table)'} is recorded, so nothing shows it zero` : `HEAD's ${f} slot is unknown (the era table is unavailable), so nothing shows it zero`)),
                  ...d.counters.nonZero.map((x) => `the reading at ${x.slot} is ${x.value}`),
                  ...d.counters.unreadable.map((u) => `the ${u.field} reading at ${u.slot ?? 'no slot'} cannot be read (${u.why})`),
                ].join(', ')} — there is no loan range to scan and no zero bound`,
              }),
    },
    {
      // Positive (S1-R8/S3-4): discharged by attribution PRESENT in the ledger
      // — at least one writer a list names, its code attributed, since "every
      // writer is attributed" is true of no writers at all.
      // Under the routed standard the waiver (step 8) stands in for it: a
      // routed-getter enumeration is the ratified proof only where the routed
      // enumeration agrees with storage AND this class was read through a
      // routed getter — with no loan id there is no row for a getter to read,
      // so the agreeing enumeration is the whole of it. A shell never
      // qualifies. The waiver turns on the CLASS's getter, so the outcome can
      // differ between classes: a class obligation, though the refusal it
      // names is one fact about the Diamond, published once in full at
      // scanned.provenance.refusal and summarised here.
      name: 'provenance-attributed',
      scope: 'class',
      holds: (_, d, cls) => {
        const a = d.attribution;
        if (a.holds) return { ok: true, detail: `${a.attributed.length} facet(s) attributed; population complete` };
        const refusal = `attribution refused: ${a.refusalSummary} (stated in full at scanned.provenance.refusal)`;
        if (d.standard !== 'routed') return { ok: false, detail: `${refusal}; refusing to certify under the provenance standard` };
        const waiver = routedWaiver(d, cls);
        return waiver.ok
          ? { ok: true, waived: true, detail: `${refusal}; waived under the routed standard — ${waiver.detail}` }
          : { ok: false, detail: `${refusal}; the routed standard's waiver is denied — ${waiver.detail}` };
      },
    },
    {
      name: 'getter-head-slot-agreement',
      scope: 'class',
      holds: (_, d, cls) => {
        const c = d.cls[cls];
        if (!c.getterRouted) return unroutedGetter(d, c, 'the class is read from storage alone, with no routed read to reconcile');
        const r = needsRange(d);
        if (r) return r;
        const m = c.mismatches;
        return m.length
          ? { ok: false, detail: `the routed getter and the storage read at HEAD's slot disagree for ${m.length} loan id(s) (${m.slice(0, 3).map((x) => `#${x.loanId}: storage ${x.storage}, getter ${x.getter}`).join('; ')}${m.length > 3 ? '; …' : ''}) — the cut getter reads a layout other than HEAD's` }
          : { ok: true, detail: `${c.getter} and HEAD-slot storage agree on every loan id${c.setAsideReads ? ` they both read readably — ${c.setAsideReads} read(s) repeated or unreadable were set aside, named under row-attributed` : ''}` };
      },
    },
    {
      name: 'getter-coverage',
      scope: 'class',
      holds: (_, d, cls) => {
        const c = d.cls[cls];
        if (!c.coverage.applies) return unroutedGetter(d, c, 'not a conjunct; it contributes no routed chain entry');
        const r = needsRange(d);
        if (r) return r;
        return c.coverage.ok
          ? { ok: true, detail: `${c.getter} was asked over 1..${d.range.N}` }
          : { ok: false, detail: `${c.getter} was asked over ${stable(c.coverage.asked ?? 'nothing')} but storage's range is 1..${d.range.N} — the ids it was not asked are unread by it` };
      },
    },
    {
      name: 'row-attributed',
      scope: 'class',
      holds: (_, d, cls) => {
        const f = d.cls[cls].rowAttributionFailures;
        return f.length
          ? { ok: false, detail: `${f.length} read(s) are not provably rows of ${d.cls[cls].field} (${f.slice(0, 3).map((x) => (x.loanId === null ? x.why : `#${x.loanId}: ${x.why}`)).join('; ')}${f.length > 3 ? '; …' : ''}) — filed unknown` }
          : { ok: true, detail: 'every slotted row sits at an attributed era slot and is unambiguous' };
      },
    },
    {
      name: 'asset-settled',
      scope: 'class',
      holds: (_, d, cls) => {
        const u = d.cls[cls].unknown;
        const why = [...new Set(u.map((r) => String(r.unknownBecause).split(':')[0]))];
        return u.length
          ? { ok: false, detail: `${u.length} row(s) in evidence are neither provably VPFI nor provably not (${why.join('; ')}) — their custody is unsettled` }
          : { ok: true, detail: 'every row is filed VPFI or non-VPFI' };
      },
    },
    {
      // S1-R6/S2-6/S3-6 — classes 1/4 need a token to be VPFI custody of this
      // deployment; classes 2/3 file rows by comparison, so they need the
      // token the Diamond itself answers (an artifact token may predate a
      // rotation, #2070 r22). The zero bound needs no scope (D:5003).
      name: 'scope-known',
      scope: 'class',
      holds: (_, d, cls) => {
        if (d.counters.zero) return { ok: true, detail: 'discharged by the zero bound — no loan exists, so no row needs a scope' };
        if (VPFI_BY_CONSTRUCTION.has(cls)) {
          // A token is evidence only with the source it was read from: a record
          // that names no source, or one outside the two the collector writes,
          // is a malformed read and resolves nothing (§1).
          return d.scope.vpfiToken !== null && Object.hasOwn(TOKEN_SOURCE_LABEL, d.scope.source ?? '')
            ? { ok: true, detail: `VPFI by construction; token ${d.scope.vpfiToken} (${TOKEN_SOURCE_LABEL[d.scope.source]})` }
            : { ok: false, detail: 'VPFI token unresolvable (neither on-chain nor in the artifact); VPFI custody cannot be scoped' };
        }
        if (d.scope.source === 'on-chain' && d.scope.vpfiToken !== null) return { ok: true, detail: `rows scoped by getVPFIToken() = ${d.scope.vpfiToken}` };
        return {
          ok: false,
          detail:
            d.scope.vpfiToken === null
              ? 'VPFI token unresolvable (neither on-chain nor in the artifact); VPFI custody cannot be scoped'
              : 'the VPFI token getter is unrouted, so the effective token cannot be read; the artifact token may predate a rotation via setVPFIToken, and a row denominated in the live token would be filed as non-VPFI',
        };
      },
    },
    {
      // #2095 r4/r11/r12 + S2-2 — the protocol's own live-commit counter can
      // CONTRADICT the class: at HEAD it may not exceed the candidates of every
      // scope found, and an unexplained earlier-era reading must be zero.
      name: 'intent-counter-consistent',
      scope: 'class',
      holds: (_, d, cls) => {
        const skip = intentOnly(cls, 'intent-counter-consistent');
        if (skip) return skip;
        const r = needsRange(d);
        if (r) return r;
        const h = d.counters.head.intentLiveCommitCount;
        if (!h) return { ok: false, detail: "intentLiveCommitCount was not read at HEAD's slot" };
        const problems = [];
        if (h.value > BigInt(d.intent.candidates)) problems.push(`intentLiveCommitCount at HEAD's slot reads ${h.value} while only ${d.intent.candidates} live intent candidate(s) of any scope were found — a commit exists that no read reached`);
        if (d.intent.earlierNonZero.length) problems.push(`intentLiveCommitCount is non-zero at an earlier era's slot no current field occupies (${d.intent.earlierNonZero.map((x) => `${x.value} at ${x.slot}`).join('; ')}) — a commit written under an earlier layout that no read matched`);
        return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `HEAD counter ${h.value} ≤ ${d.intent.candidates} candidate(s); no earlier-era reading non-zero` };
      },
    },
    {
      // S1-R4 — the event lifecycle is an independent second source: when it
      // was read it must name exactly the loans the view observed, of every
      // scope. RECORDED not taken (null) or unavailable (a reason), it
      // discharges nothing and fails nothing; a ledger recording neither, nor
      // a list of ids, records no outcome, and that fails (§1).
      name: 'corroboration-consistent',
      scope: 'class',
      holds: (_, d, cls) => {
        const skip = intentOnly(cls, 'corroboration-consistent');
        if (skip) return skip;
        const k = d.corroboration;
        if (k.state === 'unrecorded') return { ok: false, detail: `the ledger records no corroboration outcome (corroboration is ${shown(k.record)}) — neither a list of live loan ids, nor an unavailable reason, nor null for a walk not taken` };
        if (!k.taken) return { ok: true, detail: `the event-lifecycle corroboration was ${k.state === 'unavailable' ? 'unavailable' : 'not taken'} — it discharges nothing and fails nothing` };
        return k.agrees
          ? { ok: true, detail: `${k.fromLogs.length} live commit(s) from the event lifecycle match the view` }
          : { ok: false, detail: `the event-lifecycle reconstruction (${stable(k.fromLogs)}) disagrees with the live-state view (${stable(k.fromView)})` };
      },
    },
  ].map((o) => Object.freeze(o)),
);

function outcomeOf(o, ledger, d, cls) {
  try {
    const r = o.holds(ledger, d, cls);
    return r && typeof r.ok === 'boolean' ? r : { ok: false, detail: 'the obligation returned no outcome' };
  } catch (err) {
    return { ok: false, detail: `the obligation could not be evaluated: ${String(err?.message ?? err).split('\n')[0]}` };
  }
}

/** The evidence chain a class's proof rests on: one entry per piece of evidence present. */
function chainFor(d, cls, outcomes) {
  const c = d.cls[cls];
  const chain = [];
  if (d.range.known) chain.push({ kind: 'range', source: 'storage', detail: `nextLoanId=${d.range.N}` });
  if (d.range.known && d.range.N > 0n) chain.push({ kind: 'scan', source: 'storage', detail: `${c.field} read at ${(d.table.eraSlots[c.field] ?? []).length} era slot(s) over 1..${d.range.N}` });
  if (d.counters.zero) chain.push({ kind: 'witness', source: 'storage', detail: `counters zero at ${d.counters.readingCount} kept era slot(s)${setAside(d)}` });
  if (c.getterEntry) chain.push(c.getterEntry);
  if (d.routed.sound) chain.push({ kind: 'witness', source: 'routed', detail: `getProtocolStats=${d.routed.stats}` });
  if (d.attribution.holds) chain.push({ kind: 'provenance', source: 'attribution', detail: `${d.attribution.attributed.length} facet(s) attributed; population complete` });
  const waiver = d.standard === 'routed' ? routedWaiver(d, cls) : null;
  if (waiver?.ok) chain.push({ kind: 'standard', source: 'routed', detail: waiver.detail });
  chain.push({ kind: 'scope', source: d.counters.zero ? 'storage' : (d.scope.source ?? 'none'), detail: outcomes['scope-known'].detail });
  if (cls === INTENT && d.corroboration.agrees === true) chain.push({ kind: 'corroboration', source: 'event-lifecycle', detail: outcomes['corroboration-consistent'].detail });
  return chain;
}

/**
 * Steps 1–8 under one proof standard. `verdictFromEvidence` calls it twice
 * when the standard is `provenance` — the second call, under `routed`, is what
 * `withoutProvenanceRule` publishes — and never recursively.
 */
function deriveClasses(ledger, storageRead, standard) {
  const d = { ...deriveFacts(ledger, storageRead), standard };
  // a deployment obligation is one fact about the Diamond: evaluated once,
  // recorded once, and a conjunct of every class
  const deployment = {};
  for (const o of OBLIGATIONS) if (o.scope === 'deployment') deployment[o.name] = outcomeOf(o, ledger, d, null);
  const classes = {};
  for (const cls of CLASSES) {
    const own = {};
    for (const o of OBLIGATIONS) if (o.scope !== 'deployment') own[o.name] = outcomeOf(o, ledger, d, cls);
    const outcomes = { ...deployment, ...own };
    const failed = OBLIGATIONS.filter((o) => !outcomes[o.name].ok);
    const status = failed.length ? 'indeterminate' : 'proven';
    const c = d.cls[cls];
    classes[cls] = {
      status,
      evidence: status === 'proven' ? chainFor(d, cls, outcomes) : [],
      reasons: failed.map((o) => ({ obligation: o.name, detail: outcomes[o.name].detail })),
      obligations: own,
      count: c.rows.length + c.unknown.length,
      excludedCount: c.excluded.length,
      total: c.total,
      ...(c.total === null ? { totalUnavailable: c.totalUnavailable } : {}),
      rows: c.rows,
      nonVpfiRowsExcluded: c.excluded,
      unknownAssetRows: c.unknown,
      historicalRows: c.historicalRows,
      flags: {
        rangeContradiction: d.contradictions.length > 0,
        getterDisagreement: c.mismatches.length > 0,
        intentCounterContradiction: cls === INTENT && d.intent.contradiction,
        corroborationContradiction: cls === INTENT && d.corroboration.agrees === false,
      },
    };
  }
  return { d, classes, deployment };
}

/**
 * The ONE derivation of a deployment's verdict from its frozen evidence ledger.
 *
 * @param {object} ledger the collector's evidence ledger (schema 2). Bigints in
 *   memory and their decimal strings from a committed artifact judge, and
 *   publish, identically: the verdict spells every bigint as its decimal
 *   string (`decimal`).
 * @param {{ proofStandard: 'provenance'|'routed', storageRead: object }} options
 *   `storageRead` is `prepareStorageRead({ slots, eras })` — the era table the
 *   ledger is judged WITH, which need not be the one it was read with.
 * @returns {object} the verdict: the identity keys flat (C7), `classes`, the
 *   liability aggregates, `scanned` (the provenance of every figure) and the
 *   ledger itself, so the derivation can be re-run offline. Registered as a
 *   verdict, and frozen except for the `ledger` it carries by reference.
 */
export function verdictFromEvidence(ledger, { proofStandard, storageRead } = {}) {
  if (!STANDARDS.includes(proofStandard)) throw new TypeError(`verdictFromEvidence: proofStandard must be one of ${STANDARDS.join(', ')}, got ${JSON.stringify(proofStandard)}`);
  const L = isObj(ledger) ? ledger : {};
  const judged = deriveClasses(L, storageRead, proofStandard);
  const routedView = proofStandard === 'routed' ? judged : deriveClasses(L, storageRead, 'routed');
  const { d, classes, deployment } = judged;

  // Step 9 — the liability aggregates from the classes as derived, by the one
  // rule (`deriveLiabilityAggregates`), which also states a shortfall only
  // against the token the Diamond itself answers (S1-R5). A balance read of a
  // token other than the scope's is not this Diamond's VPFI backing at all.
  const backing = isObj(L.backing) ? { token: addrOf(L.backing.token), balance: big(L.backing.balance) } : null;
  const vpfiBalance = backing && backing.balance !== null && backing.token !== null && backing.token === d.scope.vpfiToken ? backing.balance : null;
  const agg = deriveLiabilityAggregates({ classes, diamondVpfiBacking: vpfiBalance === null ? null : vpfiBalance.toString(), scope: d.scope, vpfiTokenSource: TOKEN_SOURCE_LABEL[d.scope.source] ?? 'unresolvable' });

  const a = d.attribution;
  const attributedByLayoutEra = {};
  for (const f of a.attributed) for (const era of new Set(f.eras.map((e) => String(e.layoutEra ?? e.commit).slice(0, 9)))) attributedByLayoutEra[era] = (attributedByLayoutEra[era] ?? 0) + 1;
  const identity = isObj(L.identity) ? Object.fromEntries(IDENTITY_KEYS.filter((k) => L.identity[k] !== undefined).map((k) => [k, L.identity[k]])) : {};
  const ch = isObj(L.cutHistory) ? L.cutHistory : null;
  const corr = isObj(L.corroboration) ? L.corroboration : null;

  const body = copy({
    ...identity,
    vpfiToken: d.scope.vpfiToken,
    vpfiTokenSource: TOKEN_SOURCE_LABEL[d.scope.source] ?? 'unresolvable',
    diamondVpfiBacking: backing && backing.balance !== null ? backing.balance.toString() : null,
    schema: 2,
    proofStandard,
    eraTableIdentity: d.table.identity,
    verdictRule: { ...VERDICT_RULE },
    flags: isObj(L.flags) ? L.flags : {},
    scanned: {
      deploymentObligations: deployment,
      rangeWitnesses: d.witnesses,
      routedRangeAgrees: d.routed.sound,
      routedRangeDisagreement: d.routed.because,
      zeroBound: d.counters.zero,
      counters: {
        nextLoanId: dec(d.range.N),
        head: {
          totalLoansEverCreated: d.counters.head.totalLoansEverCreated ? dec(d.counters.head.totalLoansEverCreated.value) : null,
          intentLiveCommitCount: d.counters.head.intentLiveCommitCount ? dec(d.counters.head.intentLiveCommitCount.value) : null,
        },
        earlierUnexplained: d.counters.unexplained,
        aliasedIgnored: d.counters.aliased,
      },
      eraCoverage: { complete: d.table.ok && d.range.known && d.coverage.missing.length === 0, missing: d.coverage.missing, rerunOwed: d.coverage.rerunOwed, rerunOwedBecause: d.coverage.rerunOwedBecause },
      getterDisagreements: Object.fromEntries(CLASSES.map((c) => [c, d.cls[c].mismatches])),
      intentCandidatesFound: d.intent.candidates,
      corroboration: corr ? { ...corr, agreesWithObservations: d.corroboration.agrees } : null,
      cutHistory: ch
        ? { verdict: ch.verdict ?? null, cuts: ch.cuts ?? null, constructorCutSeen: ch.constructorCutSeen === true, addresses: arr(ch.addresses).length, initializers: arr(ch.initializers).length, unreadableBlocks: arr(ch.unreadableBlocks).length, reason: ch.reason ?? null }
        : null,
      provenance: {
        verdict: !a.read ? 'not-read' : a.facets.length ? a.verdict : 'no-facet-known',
        reason: a.reason,
        populationComplete: a.population.complete,
        populationIncompleteBecause: a.population.complete ? null : a.population.reasons,
        facetsChecked: a.facets.length,
        attributedCount: a.attributed.length,
        attributedByLayoutEra,
        unattributed: a.unattributed.map((u) => u.address),
        noCode: a.noCode.map((n) => n.address),
        unhashedWriters: a.unhashed,
        malformed: a.malformed,
        scopeGetters: { fallback: d.scopeShared.fallbackSnapshotCustody, intent: d.scopeShared.liveIntentCommits },
        refusal: a.holds ? null : a.refusals.map((r) => r.full).join('; and '),
        withoutProvenanceRule: Object.fromEntries(CLASSES.map((c) => [c, routedView.classes[c].status])),
      },
      surfaces: d.surfaces,
      refutations: L.refutations ?? null,
      storageReadUnavailable: d.range.unavailable,
      observationsUnfiled: d.unfiled.length,
      // what the scan RECORDED reading — nextLoanId says what it should have read
      loanIdsEnumerated: d.range.loansScanned === null ? null : Number(d.range.loansScanned),
      loanIdRange: d.range.loansScanned !== null && d.range.loansScanned > 0n ? `1..${d.range.loansScanned}` : 'none',
      enumerable: d.routed.present,
      producersMayBeLive: !d.flags.notADiamond,
    },
    classes,
    vpfiRowsTotal: agg.vpfiRowsTotal ?? null,
    vpfiRowsTotalUnavailable: agg.vpfiRowsTotalUnavailable ?? null,
    backingShortfall: agg.backingShortfall ?? null,
    backingShortfallUnavailable: agg.backingShortfallUnavailable ?? null,
  });
  deepFreeze(body);
  const verdict = Object.freeze({ ...body, ledger });
  PUBLISHED.add(verdict);
  return verdict;
}

/** True only for an object `verdictFromEvidence` returned — a spread copy, a JSON round trip or a hand-built result is not a verdict. */
export const isVerdict = (o) => o !== null && typeof o === 'object' && PUBLISHED.has(o);

/**
 * The report-level aggregates over a run's verdicts — the claims the census
 * makes across deployments, read from the verdicts alone.
 *
 * @param {object[]} results the run's published verdicts (each `isVerdict`)
 * @param {{ allDeployed: string[], failures: object[], proofStandard: string }} options
 *   `allDeployed` is every deployed `slug|label`; `failures` the deployments
 *   whose collection threw
 */
export function reportVerdict(results, { allDeployed = [], failures = [], proofStandard } = {}) {
  const list = arr(results);
  // the statuses read below must be this module's own output
  const forged = list.filter((r) => !isVerdict(r));
  if (forged.length) throw new TypeError(`reportVerdict: ${forged.length} result(s) are not verdicts verdictFromEvidence derived — a copied or hand-built result states figures no derivation produced`);
  // "Empty" is only claimable where every class was actually ESTABLISHED. An
  // indeterminate class is not evidence of absence, so it blocks the verdict
  // rather than passing as a zero.
  const allProven = list.every((r) => Object.values(r.classes).every((c) => c.status === 'proven'));
  const empty = allProven && list.every((r) => Object.values(r.classes).every((c) => c.count === 0));
  // an index into the results, not a second copy of them: each class's
  // reasons, with their detail, live on the class itself
  const indeterminateClasses = list.flatMap((r) =>
    Object.entries(r.classes)
      .filter(([, c]) => c.status !== 'proven')
      .map(([name, c]) => ({ chainSlug: r.chainSlug, deployment: r.deployment, class: name, obligations: c.reasons.map((x) => x.obligation) })),
  );
  // Codex #2070 r3 P1 — `allClassesEmpty` is a claim about EVERY deployed
  // chain, so only a run that covered every deployed DEPLOYMENT may assert it;
  // `null`, not `false`, on a partial run, which established nothing either way.
  const deployed = arr(allDeployed);
  const covered = new Set(list.map((r) => `${r.chainSlug}|${r.deployment}`));
  const coversEveryDeployedChain = deployed.length > 0 && deployed.every((k) => covered.has(k));
  const allClassesEmpty = coversEveryDeployedChain ? arr(failures).length === 0 && list.length > 0 && empty : null;
  // Codex #2070 r13 P1 — "empty at block X" retires the MIGRATION half only if
  // no qualifying row can be written after X and before isolation lands; a
  // census cannot see a producer freeze, so a live producer anywhere withholds it.
  const liveProducerDeployments = list.filter((r) => r.scanned?.producersMayBeLive).map((r) => `${r.chainSlug}/${r.deployment}`);
  const migrationRetirable = allClassesEmpty === true && liveProducerDeployments.length === 0;
  const migrationRetirableReason =
    allClassesEmpty !== true
      ? 'the population is not established empty'
      : liveProducerDeployments.length
        ? `empty at the census block, but producers may be live on ${liveProducerDeployments.length} deployment(s) ` +
          `(${liveProducerDeployments.join(', ')}); a row written after the census block and before isolation lands would ` +
          `have no migration path — re-run after a producer freeze that has finalized, or after isolation is deployed`
        : 'empty at the census block and no deployment has a live producer';
  // one report is judged with one era table; two would make its figures incomparable
  const tables = new Set(list.map((r) => stable(r.eraTableIdentity)));
  if (tables.size > 1) throw new TypeError(`reportVerdict: the results were judged with ${tables.size} different era tables — re-judge them with one`);
  return {
    allProven,
    empty,
    indeterminateClasses,
    allClassesEmpty,
    scope: coversEveryDeployedChain ? 'all-deployed-chains' : 'partial',
    migrationRetirable,
    migrationRetirableReason,
    proofStandard,
    verdictRule: { ...VERDICT_RULE },
    eraTableIdentity: list.length ? list[0].eraTableIdentity : null,
  };
}
