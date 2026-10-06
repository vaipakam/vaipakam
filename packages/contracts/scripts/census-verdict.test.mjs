// census-verdict.test.mjs — the census verdict has ONE writer (#2095 root arrest).
//
// Twenty-eight review rounds added a guard per path that could publish a class
// verdict or a liability figure nothing re-derived; each round found the next
// path. The arrest moves every verdict word into one pure function over a
// frozen evidence ledger, so the tests here are aimed at that function and at
// the absence of any other writer:
//
//   T-A  invariants over a generated ledger family (seeded, with a guard that
//        fails when the family stops reaching a cell — scanning nothing is a
//        hard error, D:5615);
//   T-B  the no-loans truth table — the bound exists in exactly two cells;
//   T-C  structural non-bypass — one exit, one push, one brand, flat identity;
//   T-D  one breaker per obligation — an obligation nobody can break is a
//        conjunct nobody tested, so an unregistered one fails the suite;
//   T-E  the committed artifact re-derives from its own ledger, and a census at
//        the committed scale, written by the real writer, fits the size cap;
//   T-F  source mutations of the judge, each of which some cell must kill;
//   T-G  a shell is an enumerable Diamond whose routed surfaces are unrouted;
//   T-H  the collector's offline paths — a failure's partial ledger, the reuse
//        relabel, the artifact round trip, `--rejudge`, the build-candidate
//        request and the command-line check — each of which decides what is
//        written without a chain read.
//
// Fixtures are Ledger literals over a fixture `storageRead` built by the real
// `prepareStorageRead` from the era-table fixture census-storage-read.test.mjs
// builds, widened to three eras so every row kind (HEAD, earlier, ambiguous,
// unattributed) has a slot of its own.
import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { toFunctionSelector } from 'viem';
import * as VERDICT from './census-verdict.mjs';
import { prepareStorageRead, attributeFacetCode, refuseUnreadableCutSources, cutHistoryCompleteness, getterAgreement, amountsAgree, CLASSES, LIABILITY_CLASS_FIELDS, EMPTY_CODE_HASH } from './census-storage-read.mjs';
import { loadSlots, loadEras } from './storage-slots.mjs';
import { CANDIDATES_FILE } from './storage-layout-eras.mjs';
import * as COLLECTOR from './census-grandfathered-custody.mjs';

const { verdictFromEvidence, reportVerdict, OBLIGATIONS, isVerdict } = VERDICT;
const { snapshotRegression, observe } = COLLECTOR;
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPTS, '..', '..', '..');

// ── fixture tables ──────────────────────────────────────────────────────────
const H = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ADDR = (n) => '0x' + BigInt(n).toString(16).padStart(40, '0');
const POS = 0x1000n;
const slotOf = (rel) => H(POS + BigInt(rel));
// HEAD and OLD are census-storage-read.test.mjs's eras; OLD's mapping heads
// move to unoccupied slots (earlier rows are UNAMBIGUOUS there) and a MID era
// puts each mapping head on a slot that is a current mapping's head today
// (rows there are AMBIGUOUS — same key, same derived slot). The MID era also
// kept the lifetime counter at a slot no current field occupies (87), so a
// non-zero reading there is the old counter itself, UNEXPLAINED — beside OLD's
// counter slot, which today's someCounterToday occupies and so ALIASES.
const HEADREL = { nextLoanId: 1, totalLoansEverCreated: 86, intentLiveCommitCount: 193, intentCommits: 194, borrowerLifRebate: 137, fallbackSnapshot: 45 };
const MIDREL = { ...HEADREL, totalLoansEverCreated: 87, intentCommits: 201, borrowerLifRebate: 150, fallbackSnapshot: 46 };
const OLDREL = { nextLoanId: 1, totalLoansEverCreated: 90, intentLiveCommitCount: 200, intentCommits: 202, borrowerLifRebate: 140, fallbackSnapshot: 47 };
const ERA = { old: { commit: 'oldold001', date: '2026-05-10T00:00:00Z', rel: OLDREL }, mid: { commit: 'midmid001', date: '2026-07-01T00:00:00Z', rel: MIDREL }, head: { commit: 'headhead1', date: '2026-09-09T00:00:00Z', rel: HEADREL } };
const CODE = { old: H(0xc01d), mid: H(0xc0111d), head: H(0xc4ead) };
const A = { old: ADDR(0xa01d), mid: ADDR(0xa0111d), head: ADDR(0xa4ead), rogue: ADDR(0xbad) };
const VPFI = ADDR(0x7f1);
const OTHER = ADDR(0x07e4);
const mapping = (label, rel) => ({ label, type: 't_mapping(t_uint256,t_struct(X)_storage)', from: slotOf(rel), to: slotOf(rel), isMapping: true });
const value = (label, rel) => ({ label, type: 't_uint256', from: slotOf(rel), to: slotOf(rel) });
const OCCUPIED = [
  value('nextLoanId', 1), mapping('fallbackSnapshot', 45), mapping('fallbackAliasMapping', 46), value('totalLoansEverCreated', 86),
  value('someCounterToday', 90), mapping('borrowerLifRebate', 137), mapping('rebateAliasMapping', 150), value('intentLiveCommitCount', 193),
  mapping('intentCommits', 194), mapping('otherMapping', 201),
];
const eraOf = (key) => ({
  commit: ERA[key].commit, date: ERA[key].date, storagePosition: H(POS), bytecode: { [CODE[key]]: `${key}Facet` },
  ...(key === 'head' ? { occupied: OCCUPIED } : {}),
  fields: Object.fromEntries(Object.entries(ERA[key].rel).map(([f, r]) => [f, { slot: slotOf(r), relative: r, offset: 0 }])),
  rows: {
    SwapToRepayIntentCommit: { orderHash: { slot: 0, offset: 0, type: 't_bytes32' }, deadline: { slot: 1, offset: 0, type: 't_uint64' } },
    BorrowerLifRebate: { vpfiHeld: { slot: 0, offset: 0, type: 't_uint256' }, rebateAmount: { slot: 1, offset: 0, type: 't_uint256' } },
    FallbackSnapshot: { lenderCollateral: { slot: 0, offset: 0, type: 't_uint256' }, treasuryCollateral: { slot: 1, offset: 0, type: 't_uint256' }, borrowerCollateral: { slot: 2, offset: 0, type: 't_uint256' }, active: { slot: 5, offset: 0, type: 't_bool' } },
  },
});
const SLOTS = { storagePosition: H(POS), fields: Object.fromEntries(Object.entries(HEADREL).map(([f, r]) => [f, slotOf(r)])) };
const ERA_TABLE = { head: 'headhead1', since: '2026-05-01', generatedAt: 'fixture', complete: true, unavailable: [], tableIdentity: 'fixture-era-table-1', eras: [eraOf('old'), eraOf('mid'), eraOf('head')] };
const STORAGE_READ = prepareStorageRead({ slots: SLOTS, eras: ERA_TABLE });
if (!STORAGE_READ.ok) throw new Error(`census-verdict.test.mjs: the fixture storageRead is refused (${STORAGE_READ.reason}) — every cell below would judge nothing`);

const FIELD = { vpfiHeldCustody: 'borrowerLifRebate', rebateRows: 'borrowerLifRebate', fallbackSnapshotCustody: 'fallbackSnapshot', liveIntentCommits: 'intentCommits' };
const PRIMARY = { vpfiHeldCustody: 'getBorrowerLifRebate', rebateRows: 'getBorrowerLifRebate', fallbackSnapshotCustody: 'getFallbackSnapshot', liveIntentCommits: 'getIntentCommit' };
const LOAN = { vpfiHeldCustody: '1', rebateRows: '2', fallbackSnapshotCustody: '3', liveIntentCommits: '4' };
const AMOUNT = { vpfiHeldCustody: 10n, rebateRows: 4n, fallbackSnapshotCustody: 20n, liveIntentCommits: 7n };
const ASSETFUL = new Set(['fallbackSnapshotCustody', 'liveIntentCommits']);
const IDENTITY_KEYS = ['chainSlug', 'deployment', 'chainId', 'diamond', 'atBlock', 'atBlockHash', 'blockTag', 'rpcHost', 'sourceRecord'];
const FLAG_KEYS = ['rangeContradiction', 'getterDisagreement', 'intentCounterContradiction', 'corroborationContradiction'];
const CAP = 5000n;
const RANGE_RE = /^1\.\.(\d+)$/;

// The ledger keys hostOf by the scope getter's role (what the judge reads) and
// by its selector (what the loupe answers); the fixture carries both so it
// reads as either collector would write it.
const abi = (name) => { const raw = JSON.parse(readFileSync(join(SCRIPTS, '..', 'src', 'abis', `${name}.json`), 'utf8')); return Array.isArray(raw) ? raw : raw.abi; };
const sel = (facet, fn) => toFunctionSelector(abi(facet).find((e) => e.type === 'function' && e.name === fn));
const SELECTOR = { fallback: sel('ClaimFacet', 'getFallbackSnapshot'), loan: sel('LoanFacet', 'getLoanDetails'), token: sel('VPFITokenFacet', 'getVPFIToken'), intent: sel('SwapToRepayIntentFacet', 'getIntentCommit') };
const setHost = (L, role, addr) => { L.hostOf[role] = addr; L.hostOf[SELECTOR[role]] = addr; };

// ── ledger builders ─────────────────────────────────────────────────────────
const slotAt = (cls, era) => slotOf(ERA[era].rel[FIELD[cls]]);
const storageObs = (cls, loanId, era, amount) => ({
  class: cls, loanId: String(loanId), amount: cls === 'liveIntentCommits' ? null : amount, assetAddr: null, source: 'storage', slot: slotAt(cls, era),
  ...(cls === 'liveIntentCommits' ? { extra: { orderHash: H(0xf00 + Number(loanId)) } } : cls === 'fallbackSnapshotCustody' ? { extra: { active: true } } : {}),
});
const routedObs = (cls, loanId, amount, asset) => ({
  class: cls, loanId: String(loanId), amount, assetAddr: ASSETFUL.has(cls) ? asset : null,
  ...(cls === 'fallbackSnapshotCustody' ? { assetSource: 'getLoanDetails' } : cls === 'liveIntentCommits' ? { assetSource: 'getIntentCommit.makerAsset' } : {}),
  source: 'routed-getter',
});
// A counter reading is what the collector READ: a slot and its value. Which eras
// a slot stands for is the table's answer, mapped by the judge from the table it
// is given — so the fixture, like the collector, records no eras of its own.
const counterList = (field, head, earlier = 0n) => STORAGE_READ.eraSlots[field].map(({ slot }) => ({ slot, value: slot === SLOTS.fields[field] ? head : earlier }));
const setHead = (L, field, v) => { for (const r of L.range.storage.counters[field]) if (r.slot === SLOTS.fields[field]) r.value = v; };
const setAt = (L, field, slot, v) => { for (const r of L.range.storage.counters[field]) if (r.slot === slot) r.value = v; };
const routedOf = (L, cls) => L.observations.find((o) => o.class === cls && o.source === 'routed-getter');

/** Every knob of a ledger; DEFAULT_SPEC is the all-good Diamond — five loans, one row of each class at HEAD with an agreeing routed twin. */
const DEFAULT_SPEC = Object.freeze({
  flags: 'ok', range: 'N', routed: 'agreeing', counters: 'head-equal', provenance: 'attributed', scopeSource: 'on-chain', scopeShared: true,
  corroboration: 'none', backing: 'read',
  'getter.getBorrowerLifRebate': 'routed', 'getter.getFallbackSnapshot': 'routed', 'getter.getIntentCommit': 'routed',
  'rows.vpfiHeldCustody': 'head', 'rows.rebateRows': 'head', 'rows.fallbackSnapshotCustody': 'head', 'rows.liveIntentCommits': 'head',
  'asset.fallbackSnapshotCustody': 'vpfi', 'asset.liveIntentCommits': 'vpfi',
  standard: 'provenance',
});
const ROW_KINDS = ['none', 'head', 'earlier', 'both', 'ambiguous', 'unattributed-slot', 'head-no-twin', 'routed-only', 'earlier-with-twin'];
const AXES = {
  flags: ['ok', 'codeAbsent', 'notADiamond'],
  range: ['N', 'zero', 'truncated', 'unavailable'],
  routed: ['agreeing', 'absent', 'subset', 'stale-counter', 'over'],
  counters: ['head-equal', 'all-zero', 'head-trails', 'head-over', 'intent>candidates', 'earlier-intent>0'],
  provenance: ['attributed', 'unattributed', 'incomplete', 'not-read'],
  scopeSource: ['on-chain', 'artifact', 'null'],
  scopeShared: [true, false],
  corroboration: ['none', 'agreeing', 'disagreeing', 'unavailable'],
  backing: ['read', 'unread'],
  'getter.getBorrowerLifRebate': ['routed', 'unrouted'],
  'getter.getFallbackSnapshot': ['routed', 'unrouted'],
  'getter.getIntentCommit': ['routed', 'unrouted'],
  ...Object.fromEntries(CLASSES.map((c) => [`rows.${c}`, ROW_KINDS])),
  'asset.fallbackSnapshotCustody': ['vpfi', 'nonVpfi', 'null'],
  'asset.liveIntentCommits': ['vpfi', 'nonVpfi', 'null'],
  standard: ['provenance', 'routed'],
};

/**
 * Build a Ledger literal from a spec, and the generator's own account of it:
 * `expected[C]` is the number of PHYSICAL rows the spec put in class C (what
 * the dedup must arrive at), `forbidden[C]` the loan ids whose only row sits
 * at an ambiguous or unattributed slot (never a counted row).
 */
function ledgerOf(specIn = {}) {
  const s = { ...DEFAULT_SPEC, ...specIn };
  const noReads = s.flags !== 'ok';
  const storageOk = !noReads && s.range !== 'unavailable';
  const N = s.range === 'zero' ? 0n : s.range === 'truncated' ? 6000n : 5n;
  const scanned = N > CAP ? CAP : N;
  const asked = storageOk && scanned > 0n ? `1..${scanned}` : '';
  const dropOld = CLASSES.some((c) => s[`rows.${c}`] === 'unattributed-slot');
  const getterRouted = (g) => !noReads && s[`getter.${g}`] === 'routed';
  const loanRouted = !noReads && s['asset.fallbackSnapshotCustody'] !== 'null';
  const assetOf = (cls) => ({ vpfi: VPFI, nonVpfi: OTHER, null: null })[s[`asset.${cls}`]];
  const gen = { spec: s, expected: {}, forbidden: {}, completeStorage: true };
  const observations = [];
  for (const cls of CLASSES) {
    const kind = storageOk && N > 0n ? s[`rows.${cls}`] : 'none';
    const routed = getterRouted(PRIMARY[cls]);
    const id = LOAN[cls];
    const S = (era) => observations.push(storageObs(cls, id, era, AMOUNT[cls]));
    const R = () => { if (routed) observations.push(routedObs(cls, id, AMOUNT[cls], assetOf(cls))); };
    let expected = 0;
    let lone = false; // the loan's only physical row sits at a slot no counted row may come from
    if (kind === 'head') { S('head'); R(); expected = 1; }
    else if (kind === 'earlier') { S('old'); expected = 1; lone = dropOld; }
    else if (kind === 'both') { S('head'); R(); S('old'); expected = 2; }
    else if (kind === 'ambiguous') { S('mid'); expected = 1; lone = true; }
    else if (kind === 'unattributed-slot') { S('old'); expected = 1; lone = true; }
    else if (kind === 'head-no-twin') { S('head'); expected = 1; }
    else if (kind === 'routed-only') { R(); expected = routed ? 1 : 0; if (routed) gen.completeStorage = false; }
    else if (kind === 'earlier-with-twin') { S('old'); R(); expected = routed && cls !== 'liveIntentCommits' ? 1 : routed ? 2 : 1; lone = dropOld && !routed; }
    gen.expected[cls] = expected;
    gen.forbidden[cls] = lone ? [id] : [];
  }
  const intentCandidates = BigInt(gen.expected.liveIntentCommits);
  // The 'subset' witness is a Diamond with ONE internal vehicle (loan 3): the
  // lifetime counter never counted it and the pagination skips it, so HEAD's
  // counter, the routed one and the ids listed all read N − 1 — the only shape
  // the contract can produce (round-3 review P1: stats 5 = HEAD 5 beside four
  // listed ids is the metrics facet reading another layout's loan records).
  const vehicles = s.routed === 'subset' && N > 0n ? 1n : 0n;
  const counted = N - vehicles;
  const tlecHead = { 'head-equal': counted, 'all-zero': 0n, 'head-trails': counted > 0n ? counted - 1n : 0n, 'head-over': N + 1n, 'intent>candidates': counted, 'earlier-intent>0': counted }[s.counters];
  const intentHead = { 'head-equal': intentCandidates, 'all-zero': 0n, 'head-trails': intentCandidates, 'head-over': intentCandidates, 'intent>candidates': intentCandidates + 1n, 'earlier-intent>0': intentCandidates }[s.counters];
  const earlierIntent = s.counters === 'earlier-intent>0' ? 1n : 0n;
  const agreeing = { totalLoansEverCreated: N, enumeratedIds: N > 0n ? `1..${N}` : [], reportedTotal: N };
  const routedRange = noReads || s.routed === 'absent' ? null : {
    agreeing,
    subset: N > 0n ? { totalLoansEverCreated: counted, enumeratedIds: Array.from({ length: Number(N) }, (_, i) => BigInt(i + 1)).filter((id) => id !== 3n), reportedTotal: counted } : agreeing,
    'stale-counter': { totalLoansEverCreated: 0n, enumeratedIds: [], reportedTotal: 0n },
    over: { totalLoansEverCreated: N + 2n, enumeratedIds: `1..${N + 2n}`, reportedTotal: N + 2n },
  }[s.routed];
  const scope = s.scopeSource === 'on-chain' ? { vpfiToken: VPFI, source: 'on-chain' } : s.scopeSource === 'artifact' ? { vpfiToken: VPFI, source: 'artifact' } : { vpfiToken: null, source: null };
  const provenanceRead = !noReads && s.provenance !== 'not-read';
  const writers = [
    { address: A.old, sources: ['cut-history'], codeHash: CODE.old },
    { address: A.mid, sources: ['cut-history'], codeHash: CODE.mid },
    { address: A.head, sources: ['loupe', 'cut-history', 'record:live'], codeHash: CODE.head },
    ...(s.provenance === 'unattributed' ? [{ address: A.rogue, sources: ['cut-history'], codeHash: H(0xbad) }] : []),
  ].filter((f) => !(dropOld && f.address === A.old));
  const L = {
    schema: 2,
    identity: { chainSlug: 'fixture-chain', deployment: 'live', chainId: 31337, diamond: ADDR(0xd1a), atBlock: '1000', atBlockHash: H(0xb10c), blockTag: 'finalized', rpcHost: 'rpc.fixture.invalid', sourceRecord: 'contracts/deployments/fixture-chain/addresses.json' },
    flags: { codeAbsent: s.flags === 'codeAbsent', codeAbsentReason: s.flags === 'codeAbsent' ? 'fixture: no code at the census block' : null, notADiamond: s.flags === 'notADiamond', loupeRouted: !noReads, custodySurfaceUnrouted: false },
    scope,
    backing: s.backing === 'read' && scope.vpfiToken ? { token: scope.vpfiToken, balance: 100n } : null,
    range: {
      storage: storageOk ? {
        nextLoanId: N,
        truncatedAt: N > CAP ? Number(CAP) : null,
        counters: { totalLoansEverCreated: counterList('totalLoansEverCreated', tlecHead), intentLiveCommitCount: counterList('intentLiveCommitCount', intentHead, earlierIntent) },
        read: { ...STORAGE_READ.evidence, slotsRead: 5 + Number(scanned) * 21, loansScanned: Number(scanned), slotsScanned: Object.fromEntries(Object.entries(STORAGE_READ.eraSlots).map(([f, list]) => [f, list.map((x) => x.slot)])) },
      } : null,
      storageUnavailable: storageOk || noReads ? null : 'fixture: the storage read was refused for this deployment',
      routed: routedRange,
    },
    surfaces: noReads
      ? Object.fromEntries(['getProtocolStats', 'getAllLoansPaginated', 'getBorrowerLifRebate', 'getFallbackSnapshot', 'getLoanDetails', 'getIntentCommit', 'getVPFIToken', 'commitSwapToRepayIntent', 'facets', 'facetAddress', 'facetAddresses'].map((k) => [k, s.flags === 'codeAbsent' ? 'not-probed' : 'unrouted']))
      : {
          getProtocolStats: routedRange ? 'routed' : 'unrouted', getAllLoansPaginated: routedRange ? 'routed' : 'unrouted',
          getBorrowerLifRebate: s['getter.getBorrowerLifRebate'], getFallbackSnapshot: s['getter.getFallbackSnapshot'], getIntentCommit: s['getter.getIntentCommit'],
          getLoanDetails: loanRouted ? 'routed' : 'unrouted', getVPFIToken: scope.source === 'on-chain' ? 'routed' : 'unrouted',
          commitSwapToRepayIntent: 'routed', facets: 'routed', facetAddress: 'routed', facetAddresses: 'routed',
        },
    hostOf: {},
    idsAskedOfGetter: Object.fromEntries(['getBorrowerLifRebate', 'getFallbackSnapshot', 'getIntentCommit'].map((g) => [g, getterRouted(g) ? asked : ''])
      .concat([['getLoanDetails', loanRouted ? asked : '']])),
    observations,
    corroboration: null,
    cutHistory: provenanceRead ? {
      verdict: 'read', cuts: 3, constructorCutSeen: s.provenance !== 'incomplete', constructorCutEvidence: 'fixture: the constructor\'s empty DiamondCut at the deploy block',
      addresses: writers.map((f) => f.address), initializers: [], blocksOf: Object.fromEntries(writers.map((f, i) => [f.address, [String(10 + i)]])),
      blockTimestamps: {}, unreadableBlocks: [],
    } : null,
    provenance: provenanceRead
      ? { read: true, facets: writers, loupe: [A.head], loupeReadFailed: false, cutFacetHost: A.head, recorded: { records: ['live'], facets: [{ address: A.head, sources: ['record:live'] }], deployedAt: [{ record: 'record:live', iso: '2026-09-09T00:00:00Z' }] } }
      : { read: false, reason: s.flags === 'codeAbsent' ? 'no-code' : s.flags === 'notADiamond' ? 'not-a-diamond' : 'fixture: provenance not read' },
  };
  if (provenanceRead) {
    const shared = s.scopeShared;
    setHost(L, 'fallback', getterRouted('getFallbackSnapshot') ? A.head : null);
    setHost(L, 'loan', loanRouted ? (shared ? A.head : A.old) : null);
    setHost(L, 'token', scope.source === 'on-chain' ? A.head : null);
    setHost(L, 'intent', getterRouted('getIntentCommit') ? (shared ? A.head : A.old) : null);
  }
  const intentView = observations.filter((o) => o.class === 'liveIntentCommits' && o.source === 'routed-getter').map((o) => o.loanId).sort();
  L.corroboration = !storageOk || s.corroboration === 'none' ? null
    : s.corroboration === 'agreeing' ? { source: 'event-lifecycle', logsSeen: intentView.length * 2, liveLoanIdsFromLogs: intentView }
      : s.corroboration === 'disagreeing' ? { source: 'event-lifecycle', logsSeen: 2, liveLoanIdsFromLogs: ['3'] }
        : { source: 'event-lifecycle', unavailable: 'fixture: the endpoint pruned the logs' };
  return { ledger: L, gen, standard: s.standard };
}

const big = (x) => (x === null || x === undefined ? null : BigInt(x));
const toJson = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const judge = (ledger, proofStandard = 'provenance', storageRead = STORAGE_READ) => verdictFromEvidence(ledger, { proofStandard, storageRead });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const stripLedger = (v) => { const { ledger, verdictRule, ...rest } = v; return rest; };
const reasonsOf = (v, cls) => (v.classes?.[cls]?.reasons ?? []).map((r) => r.obligation);
const chainOf = (v, cls) => v.classes?.[cls]?.evidence ?? [];
/** A chain entry claiming the zero-loans bound or either half of it: storage's nextLoanId at zero, or every kept counter reading zero. */
const isBoundEntry = (e) => /\bnextLoanId=0\b|\bcounters zero\b/.test(String(e?.detail ?? ''));
/** `scanned.routedRangeAgrees` is the published soundness of the routed enumeration — a boolean, or a record carrying it beside the disagreeing figure. */
const routedAgrees = (v) => { const x = v.scanned?.routedRangeAgrees; return typeof x === 'boolean' ? x : Boolean(x?.agrees ?? x?.sound ?? x?.ok); };
/** A ledger integer, or null where it does not parse — an oracle must not throw on the malformed ledgers the breakers build. */
const num = (x) => { try { return x === null || x === undefined ? null : BigInt(x); } catch { return null; } };
/**
 * The counter readings the zero bound reads (C4/I7), restated independently of
 * the judge: a reading at HEAD's slot is the counter today and is kept; an
 * earlier era's NON-ZERO reading is set aside only where a current VALUE field
 * (a list length, a version — never a mapping head, which stores nothing)
 * occupies that slot today, because it then reads that field. An unparseable
 * value is kept as null: nobody can show it zero.
 */
/** A current VALUE field (never a mapping head, which stores nothing) occupies `slot` today, so a non-zero earlier counter reading there reads that field. */
const valueFieldAt = (slot, storageRead) => (storageRead?.occupied ?? []).some((o) => !o.isMapping && num(slot) !== null && num(slot) >= BigInt(o.from) && num(slot) <= BigInt(o.to));
function keptReadings(storage, storageRead) {
  const head = storageRead?.headSlots ?? {};
  const out = [];
  for (const f of ['totalLoansEverCreated', 'intentLiveCommitCount']) {
    for (const r of Array.isArray(storage?.counters?.[f]) ? storage.counters[f] : []) {
      const v = num(r?.value);
      const atHead = num(r?.slot) !== null && num(r.slot) === num(head[f]);
      if (!atHead && v !== null && v !== 0n && valueFieldAt(r?.slot, storageRead)) continue;
      out.push(v);
    }
  }
  return out;
}
const obligationNames = () => new Set(OBLIGATIONS.map((o) => o.name));
const DEPLOYMENT_OBLIGATIONS = new Set(OBLIGATIONS.filter((o) => o.scope === 'deployment').map((o) => o.name));
const rangeTop = (ids) => (typeof ids === 'string' ? Number((ids.match(RANGE_RE) ?? [])[1] ?? 0) : null);

/**
 * `routedEnumerationSound` (S1-R2/S2-3/S2-4, r28 P1b) restated independently
 * of the judge — the oracle the waiver cells are checked against. Beside the
 * HEAD counter, the subset and the reported total: the enumeration lists at
 * least as many DISTINCT loans as each lifetime-counter reading counted —
 * HEAD's included, since equal to the routed counter it still counts loans
 * the pagination must list (round-3 review P1) — every one of them a loan the
 * pagination does not skip. An earlier reading at a current value field's
 * slot is that field's and is not held to it; a reading that does not parse
 * cannot be shown listed.
 */
function routedSound(ledger, storageRead = STORAGE_READ) {
  const st = ledger.range?.storage;
  const r = ledger.range?.routed;
  if (!st || !r) return false;
  const N = big(st.nextLoanId);
  const headSlot = SLOTS.fields.totalLoansEverCreated;
  const head = (st.counters?.totalLoansEverCreated ?? []).find((x) => x.slot === headSlot);
  if (!head || big(head.value) !== big(r.totalLoansEverCreated)) return false;
  const ids = typeof r.enumeratedIds === 'string' ? (rangeTop(r.enumeratedIds) ? [1n, BigInt(rangeTop(r.enumeratedIds))] : []) : r.enumeratedIds.map(big);
  if (!(ids.every((i) => i >= 1n && i <= N) && big(r.reportedTotal) <= N)) return false;
  const listed = typeof r.enumeratedIds === 'string' ? BigInt(rangeTop(r.enumeratedIds) ?? 0) : BigInt(new Set(r.enumeratedIds.map(String)).size);
  return (st.counters?.totalLoansEverCreated ?? []).every((x) => num(x.value) !== null && (num(x.value) <= listed || (x.slot !== headSlot && valueFieldAt(x.slot, storageRead))));
}

/**
 * Whether the ledger names a writer whose code the table attributes: an
 * address some writer list names, carrying exactly ONE facet entry (one
 * address, one code-hash read), whose hash an era of the table built.
 * "Every writer is attributed" is true of no writers at all, so a provenance
 * proof needs one PRESENT (§1). Restated here, independently of the judge.
 */
function namedAttributedWriter(ledger, storageRead = STORAGE_READ) {
  const p = ledger?.provenance;
  const lower = (x) => String(x?.address ?? x).toLowerCase();
  const named = new Set([ledger?.cutHistory?.addresses, ledger?.cutHistory?.initializers, p?.loupe, p?.recorded?.facets].flatMap((list) => (Array.isArray(list) ? list.map(lower) : [])));
  const entries = new Map();
  for (const f of Array.isArray(p?.facets) ? p.facets : []) if (typeof f?.address === 'string') entries.set(lower(f), [...(entries.get(lower(f)) ?? []), f]);
  const built = (h) => (storageRead?.eras ?? []).some((e) => typeof h === 'string' && e.bytecode?.[h]);
  return [...named].some((a) => entries.get(a)?.length === 1 && built(entries.get(a)[0].codeHash));
}
/** An address the provenance read carries more than one facet entry for, in any spelling. */
const facetReadTwice = (p) => { const seen = (Array.isArray(p?.facets) ? p.facets : []).map((f) => String(f?.address).toLowerCase()); return seen.some((a, i) => seen.indexOf(a) !== i); };
/** A provenance refusal as the kept helpers see it — the same pure functions the judge composes. */
function refusedByProvenance(ledger) {
  const p = ledger.provenance;
  if (!p?.read || facetReadTwice(p) || !namedAttributedWriter(ledger)) return true;
  const att = refuseUnreadableCutSources(attributeFacetCode({ facets: p.facets, eras: STORAGE_READ.eras }), { addresses: ledger.cutHistory?.addresses, initializers: ledger.cutHistory?.initializers });
  const pop = cutHistoryCompleteness({ ...(ledger.cutHistory ?? { verdict: 'unreadable', cuts: 0 }), loupe: p.loupe, cutFacetHost: p.cutFacetHost, loupeReadFailed: p.loupeReadFailed, recordedFacets: (p.recorded?.facets ?? []).map((f) => f.address ?? f) });
  return att.unattributed.length > 0 || !pop.complete;
}

/**
 * I1–I8 and I11–I14 over one verdict. Returns the violations instead of
 * asserting, so the source-mutation cells (T-F) can require that a mutant
 * produces at least one.
 */
function invariantViolations(v, ledger, { standard, gen = null, storageRead = STORAGE_READ } = {}) {
  const out = [];
  const names = obligationNames();
  for (const k of IDENTITY_KEYS) if (!(k in v)) out.push(`I11 identity key ${k} is not flat on the verdict`);
  for (const [k, x] of Object.entries(ledger.identity ?? {})) if (!isDeepStrictEqual(toJson(v[k] ?? null), toJson(x ?? null))) out.push(`I11 identity key ${k} differs from the ledger's`);
  if (v.schema !== 2) out.push(`schema ${v.schema}, not 2`);
  if (v.backingShortfall !== null && v.backingShortfall !== undefined && ledger.scope?.source !== 'on-chain') out.push(`I12 a backing shortfall ${v.backingShortfall} is published over a ${ledger.scope?.source ?? 'null'}-sourced scope`);
  const st = ledger.range?.storage;
  const refused = gen ? gen.spec.provenance !== 'attributed' || gen.spec.flags !== 'ok' : storageRead === STORAGE_READ ? refusedByProvenance(ledger) : !(v.scanned?.provenance?.unattributed?.length === 0 && v.scanned?.provenance?.populationComplete === true);
  // I7 (non-vacuous) — the zero bound rests on readings PRESENT: wherever the
  // verdict publishes it, or the range obligation holds at nextLoanId=0, the
  // ledger carries HEAD's reading of BOTH counter kinds at zero beside every
  // kept reading zero. Checked per verdict, so an indeterminate class (another
  // conjunct failed) cannot hide a vacuous bound.
  const headZero = (f) => (Array.isArray(st?.counters?.[f]) ? st.counters[f] : []).some((r) => num(r?.slot) !== null && num(r.slot) === num(storageRead?.headSlots?.[f]) && num(r?.value) === 0n);
  const boundShown = Boolean(st) && num(st.nextLoanId) === 0n && headZero('totalLoansEverCreated') && headZero('intentLiveCommitCount') && keptReadings(st, storageRead).every((x) => x === 0n);
  if (v.scanned?.zeroBound === true && !boundShown) out.push(`I7 the zero bound is published without HEAD's reading of both counter kinds at zero (nextLoanId ${st?.nextLoanId ?? 'unread'})`);
  if (v.scanned?.deploymentObligations?.['range-nonempty-or-bound']?.ok === true && st && num(st.nextLoanId) === 0n && !boundShown) out.push('I7 range-nonempty-or-bound holds at nextLoanId 0 without HEAD\'s reading of both counter kinds at zero');
  for (const C of CLASSES) {
    const c = v.classes?.[C];
    if (!c) { out.push(`${C}: no class on the verdict`); continue; }
    const rows = c.rows ?? [];
    const unknown = c.unknownAssetRows ?? [];
    const excluded = c.nonVpfiRowsExcluded ?? [];
    const chain = c.evidence ?? [];
    const reasons = c.reasons ?? [];
    const proven = c.status === 'proven';
    // a published row carries its amount under the class's own field (vpfiHeld, rebateAmount, …)
    const amountOf = (r) => r[LIABILITY_CLASS_FIELDS[C]];
    if (c.status !== 'proven' && c.status !== 'indeterminate') out.push(`${C}: status ${c.status}`);
    if (c.count !== rows.length + unknown.length) out.push(`${C}: I2 count ${c.count} ≠ ${rows.length} counted + ${unknown.length} unknown-asset`);
    const anyNull = rows.some((r) => amountOf(r) === null || amountOf(r) === undefined);
    if ((c.total === null) !== (unknown.length > 0 || anyNull)) out.push(`${C}: I3 total ${c.total} beside ${unknown.length} unknown-asset row(s)${anyNull ? ' and a row without an amount' : ''}`);
    else if (c.total !== null && big(c.total) !== rows.reduce((a, r) => a + big(amountOf(r)), 0n)) out.push(`${C}: I3 total ${c.total} is not the sum of the counted rows`);
    if (gen && rows.length + unknown.length + excluded.length !== gen.expected[C]) out.push(`${C}: I4 ${rows.length}+${unknown.length}+${excluded.length} rows for ${gen.expected[C]} physical row(s)`);
    if (proven !== chain.length > 0) out.push(`${C}: I6 ${c.status} with an evidence chain of ${chain.length}`);
    // I8 — every conjunct's outcome is recorded whatever the status, once, where
    // its scope puts it: a deployment obligation is one fact about the Diamond,
    // on the verdict (`scanned.deploymentObligations`); a class obligation is on
    // the class. The reasons are exactly the conjuncts that failed: nothing
    // short-circuited, nothing named that held.
    const deploymentOutcomes = v.scanned?.deploymentObligations ?? {};
    const misplaced = [
      ...Object.keys(c.obligations ?? {}).filter((n) => DEPLOYMENT_OBLIGATIONS.has(n)),
      ...Object.keys(deploymentOutcomes).filter((n) => !DEPLOYMENT_OBLIGATIONS.has(n)),
    ];
    if (misplaced.length) out.push(`${C}: I8 outcome(s) recorded outside their obligation's scope: ${misplaced.join(', ')}`);
    const outcomes = { ...deploymentOutcomes, ...(c.obligations ?? {}) };
    const missing = [...names].filter((n) => typeof outcomes[n]?.ok !== 'boolean' || !outcomes[n]?.detail);
    if (missing.length) out.push(`${C}: I8 no recorded outcome for ${missing.join(', ')}`);
    else if (!isDeepStrictEqual(reasons.map((r) => r.obligation), OBLIGATIONS.map((o) => o.name).filter((n) => !outcomes[n].ok))) out.push(`${C}: I8 reasons [${reasons.map((r) => r.obligation)}] are not the failed outcomes`);
    if (proven === reasons.length > 0) out.push(`${C}: I8 ${c.status} with ${reasons.length} reason(s)`);
    for (const r of reasons) if (!names.has(r.obligation) || !r.detail) out.push(`${C}: I8 reason ${JSON.stringify(toJson(r))} names no OBLIGATIONS entry or carries no detail`);
    for (const f of FLAG_KEYS) if (typeof c.flags?.[f] !== 'boolean') out.push(`${C}: I8 flag ${f} is not recorded`);
    if (proven) {
      if (unknown.length) out.push(`${C}: I1 proven over ${unknown.length} unknown-asset row(s)`);
      for (const f of FLAG_KEYS) if (c.flags?.[f]) out.push(`${C}: I1 proven beside ${f}`);
      if (!st) out.push(`${C}: I1 proven without the storage range`);
      else if (st.truncatedAt !== null && st.truncatedAt !== undefined) out.push(`${C}: I1 proven over a truncated scan`);
      if (standard === 'provenance' && refused) out.push(`${C}: I1 proven under the provenance standard over a provenance refusal`);
      // a provenance entry in a proof's chain rests on a writer PRESENT (§1), under either standard
      if (chain.some((e) => e.kind === 'provenance') && !namedAttributedWriter(ledger, storageRead)) out.push(`${C}: I1 proven with a provenance entry in its chain, yet no writer a list names carries one code-hash read the table attributes`);
      // a proof bounds the liability: every counted row's amount was read, so a
      // proven class always has a total ('0' when it holds no row)
      if (c.total === null) out.push(`${C}: I1 proven without a total (${c.totalUnavailable ?? 'no reason given'})`);
      if (standard === 'routed' && refused && (!routedSound(ledger, storageRead) || !chain.some((e) => e.source === 'routed'))) out.push(`${C}: I5 the routed waiver was taken without a sound routed enumeration and a routed chain entry`);
    }
    // I7 — C4: the only zero-loans bound is storage's nextLoanId at zero with
    // every KEPT counter reading of both kinds zero (an aliased reading is a
    // current value field's, set aside and named); a chain claiming either part
    // over anything else is a bound granted by something other than storage
    const kept = keptReadings(st, storageRead);
    if (chain.some(isBoundEntry) && (!st || num(st.nextLoanId) !== 0n || kept.some((x) => x !== 0n))) out.push(`${C}: I7 a zero-loans bound over nextLoanId ${st?.nextLoanId ?? 'unread'} / kept counters ${kept.map(String).join(',')}`);
    for (const r of rows) if (r.ambiguous === true || r.aliasesCurrentField || r.unknownBecause) out.push(`${C}: I13 a row filed unknown (${r.unknownBecause ?? r.aliasesCurrentField}) is counted`);
    for (const id of gen?.forbidden?.[C] ?? []) if (rows.some((r) => String(r.loanId) === id)) out.push(`${C}: I13 loan ${id}'s row at an ambiguous or unattributed slot is counted`);
    // I14 — a counted row is a read of a loan the range reaches: every id is
    // ++nextLoanId, so a whole number in 1..nextLoanId, never one no read of
    // the range was asked about, and never a word
    const top = num(st?.nextLoanId);
    for (const r of rows) {
      const id = num(r.loanId);
      if (id === null || id < 1n || (top !== null && id > top)) out.push(`${C}: I14 a counted row's loan id ${JSON.stringify(r.loanId)} is no id in 1..${st?.nextLoanId ?? 'unread'}`);
    }
  }
  return out;
}

// ── the generated family ────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.CENSUS_VERDICT_SEED ?? 0x2095);
const FAMILY_SIZE = 3000;
/**
 * Perturbations of the all-good ledger: k axes (0..5) moved to a random value
 * each. Uniform sampling over the full product almost never reaches an
 * all-good ledger, so `proven` would go untested; perturbing from it reaches
 * both outcomes in every class, and the guard below checks that it did.
 */
function generateFamily(n = FAMILY_SIZE, seed = SEED) {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const axes = Object.keys(AXES);
  const out = [];
  for (let i = 0; i < n; i++) {
    const spec = { ...DEFAULT_SPEC };
    const k = pick([0, 1, 1, 2, 2, 2, 3, 3, 4, 5]);
    for (let j = 0; j < k; j++) { const ax = pick(axes); spec[ax] = pick(AXES[ax]); }
    if (rnd() < 0.5) spec.standard = 'routed';
    out.push({ ...ledgerOf(spec), spec });
  }
  return out;
}
const describe = (spec) => JSON.stringify(Object.fromEntries(Object.entries(spec).filter(([k, x]) => DEFAULT_SPEC[k] !== x)));
let FAMILY = null;
const family = () => (FAMILY ??= generateFamily());

test('the fixture judge reaches proven: the all-good ledger is four proven classes under both standards (every cell below starts here)', () => {
  for (const standard of ['provenance', 'routed']) {
    const { ledger, gen } = ledgerOf({ standard });
    const v = judge(ledger, standard);
    for (const C of CLASSES) assert.equal(v.classes[C].status, 'proven', `${standard}/${C}: ${JSON.stringify(toJson(v.classes[C].reasons))}`);
    assert.deepEqual(invariantViolations(v, ledger, { standard, gen }), []);
    assert.ok(CLASSES.every((C) => v.classes[C].count === 1), 'each class counts its one row — the all-good ledger is not the empty one');
  }
});

test('T-A — every verdict over a generated ledger family satisfies I1–I8, I11–I14; the family reaches every axis cell and both outcomes per class per standard', () => {
  const seen = Object.fromEntries(Object.keys(AXES).map((k) => [k, new Set()]));
  const outcomes = new Map();
  const failures = [];
  for (const { spec, ledger, gen, standard } of family()) {
    for (const k of Object.keys(AXES)) seen[k].add(spec[k]);
    const v = judge(ledger, standard);
    for (const C of CLASSES) { const key = `${C}|${standard}|${v.classes?.[C]?.status}`; outcomes.set(key, (outcomes.get(key) ?? 0) + 1); }
    const bad = invariantViolations(v, ledger, { standard, gen });
    if (bad.length) failures.push(`${describe(spec)} → ${bad.join('; ')}`);
  }
  // the generator guard: a family that stopped reaching a cell tests nothing there
  const missing = Object.entries(AXES).flatMap(([k, values]) => values.filter((x) => !seen[k].has(x)).map((x) => `${k}=${x}`));
  assert.deepEqual(missing, [], `seed ${SEED}: the family never reached these axis cells`);
  for (const C of CLASSES) for (const standard of ['provenance', 'routed']) for (const status of ['proven', 'indeterminate']) {
    assert.ok((outcomes.get(`${C}|${standard}|${status}`) ?? 0) > 0, `seed ${SEED}: no ${status} ${C} under the ${standard} standard — the family no longer straddles the verdict`);
  }
  assert.deepEqual(failures.slice(0, 12), [], `seed ${SEED}: ${failures.length} of ${FAMILY_SIZE} ledgers violate an invariant`);
});

test('T-A I10 — the verdict does not depend on the order of the observations', () => {
  const rnd = mulberry32(SEED ^ 0x10);
  const failures = [];
  let compared = 0;
  for (const [i, { spec, ledger, standard }] of family().entries()) {
    if (i % 7 || ledger.observations.length < 2) continue;
    compared += 1;
    const shuffled = structuredClone(ledger);
    for (let j = shuffled.observations.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [shuffled.observations[j], shuffled.observations[k]] = [shuffled.observations[k], shuffled.observations[j]]; }
    if (!isDeepStrictEqual(toJson(stripLedger(judge(shuffled, standard))), toJson(stripLedger(judge(ledger, standard))))) failures.push(describe(spec));
  }
  assert.ok(compared > 100, `only ${compared} ledger(s) had observations to reorder — the cell compares nothing`);
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} ledger(s) judged differently once their observations were reordered`);
});

/**
 * I9 — the judge's MONOTONE claim (see its header), at exactly this
 * granularity and no finer:
 *   - over every fifth ledger of the generated family, ONE instance of each
 *     kind of supporting read below is removed, alone, from a copy — the first
 *     instance no ledger has yet had removed, else the next in rotation;
 *   - after it, no class that was indeterminate is proven, and no class proven
 *     before and after carries a chain entry it did not carry before (entries
 *     compared as JSON, so an entry restated differently counts as added);
 *   - every instance of every kind is removed from at least one ledger that
 *     carried it, or the cell fails (an instance never reached is untested).
 * A removal deletes the read's record and what that read produced — the rows
 * read at a removed slot, the ids a removed range would have asked — as a
 * ledger without the read would hold them. The kinds and their instances are
 * SUPPORTING_KINDS. Every facet entry in the family is named by the cut
 * history, as every facet entry the collector writes is named by some writer
 * list, so "a facet entry" here is a named one. An instance removes EVERY
 * record of its key — every facet entry of an address, every reading at a
 * counter slot, every key naming a scope getter's host — which is the
 * granularity the header states, and no finer.
 *
 * REFUTING reads are not removed here, since removing one may restore a
 * proof: every observation (deleting the row that made a class indeterminate
 * describes a different Diamond — the cell holds only that it never proves
 * ANOTHER class), an address inside a writer list, a facet entry no writer
 * list names, a counter reading at a slot the table does not list, and a
 * SECOND record of a key already read (a second reading at one counter slot,
 * a second facet entry for one address, a second spelling of one host). The
 * next cell pins that boundary; T-D's breakers pin the rest.
 */
const PRIMARY_GETTERS = ['getBorrowerLifRebate', 'getFallbackSnapshot', 'getIntentCommit'];
/** Each scope role's getter name — the third key a ledger may name its host by. */
const SCOPE_GETTER = { fallback: 'getFallbackSnapshot', loan: 'getLoanDetails', token: 'getVPFIToken', intent: 'getIntentCommit' };
const COUNTER_KINDS = ['totalLoansEverCreated', 'intentLiveCommitCount'];
/** Whether a writer list of the provenance read names `a` — the cut history's addresses or initializers, the loupe, or a record. */
const namedWriter = (L, a) => [L.cutHistory?.addresses, L.cutHistory?.initializers, L.provenance?.loupe, (L.provenance?.recorded?.facets ?? []).map((f) => f?.address ?? f)].some((list) => Array.isArray(list) && list.includes(a));
const whole = (remove) => [['whole', remove]];
/** Each kind of supporting read, by instance: `[name, remove]`, where `remove(L)` returns false when L does not carry that read. */
const SUPPORTING_KINDS = {
  'the storage range': whole((L) => { if (!L.range.storage) return false; L.range.storage = null; L.range.storageUnavailable = 'removed'; L.observations = []; for (const g of Object.keys(L.idsAskedOfGetter)) L.idsAskedOfGetter[g] = ''; }),
  // the scan's own record of the ids it read — what discharges not-truncated (root-arrest review r1 P1)
  'the scanned ids': whole((L) => { if (!L.range.storage?.read) return false; delete L.range.storage.read.loansScanned; }),
  // the observations AS A LIST — the scan's record that it kept its rows (each entry is refuting, the list is not)
  'the observation list': whole((L) => { delete L.observations; }),
  'the counters record': whole((L) => { if (!L.range.storage) return false; L.range.storage.counters = {}; }),
  'an era slot the scan covered': Object.entries(STORAGE_READ.eraSlots).flatMap(([field, list]) => list.map(({ slot }) => [`${field}@${slot}`, (L) => {
    if (!L.range.storage?.read?.slotsScanned?.[field]) return false;
    L.range.storage.read.slotsScanned[field] = L.range.storage.read.slotsScanned[field].filter((x) => x !== slot);
    L.observations = L.observations.filter((o) => o.slot !== slot);
  }])),
  // HEAD's slot included: the zero bound and storage's range witness rest on it
  'a counter reading at a slot the table lists': COUNTER_KINDS.flatMap((f) => STORAGE_READ.eraSlots[f].map(({ slot }) => [`${f}@${slot}`, (L) => {
    if (!L.range.storage?.counters?.[f]?.some((x) => x.slot === slot)) return false;
    L.range.storage.counters[f] = L.range.storage.counters[f].filter((x) => x.slot !== slot);
  }])),
  // the code and Diamond answers discharge code-present and is-a-diamond (§1 — positive, never a missing flag)
  'the code and Diamond flags': whole((L) => { L.flags = {}; }),
  'the provenance read': whole((L) => { if (!L.provenance?.read) return false; L.provenance = { read: false, reason: 'removed' }; L.cutHistory = null; }),
  // a writer set nobody can read cannot be attributed — each list, as a list
  'a writer list, as a list': [
    ['provenance.facets', (L) => { if (!L.provenance?.read) return false; delete L.provenance.facets; }],
    ['provenance.loupe', (L) => { if (!L.provenance?.read) return false; delete L.provenance.loupe; }],
    ['provenance.recorded.facets', (L) => { if (!L.provenance?.recorded) return false; delete L.provenance.recorded.facets; }],
    ['cutHistory.addresses', (L) => { if (!L.cutHistory) return false; delete L.cutHistory.addresses; }],
    ['cutHistory.initializers', (L) => { if (!L.cutHistory) return false; delete L.cutHistory.initializers; }],
  ],
  // every code-hash entry for a writer a list names: deleted, the writer is unhashed; one entry's hash alone deleted, that entry is malformed
  'a named facet entry': Object.entries(A).map(([k, a]) => [k, (L) => {
    const of = (f) => String(f?.address).toLowerCase() === a;
    if (!L.provenance?.read || !L.provenance.facets?.some(of) || !namedWriter(L, a)) return false;
    L.provenance.facets = L.provenance.facets.filter((f) => !of(f));
  }]),
  'a named facet entry\'s code hash alone': Object.entries(A).map(([k, a]) => [k, (L) => {
    const f = L.provenance?.read ? L.provenance.facets?.find((x) => x.address === a) : null;
    if (!f || !namedWriter(L, a)) return false;
    delete f.codeHash;
  }]),
  'a routed getter\'s asked ids': PRIMARY_GETTERS.map((g) => [g, (L) => { if (L.surfaces[g] !== 'routed') return false; L.idsAskedOfGetter[g] = ''; }]),
  // a recorded "unrouted" discharges what a routed getter or a routed witness would owe — no answer discharges nothing
  'a custody getter\'s routing answer': PRIMARY_GETTERS.map((g) => [g, (L) => { if (!(g in L.surfaces)) return false; delete L.surfaces[g]; }]),
  'a metrics selector\'s routing answer': ['getProtocolStats', 'getAllLoansPaginated'].map((s) => [s, (L) => { if (!(s in L.surfaces)) return false; delete L.surfaces[s]; }]),
  // the corroboration RECORD (null when no walk was taken) — not its live ids, which refute
  'the corroboration record': whole((L) => { delete L.corroboration; }),
  // the token a row is filed against, and the hosts whose shared layout makes that filing sound
  'the token scope': whole((L) => { if (!L.scope?.vpfiToken) return false; L.scope = { vpfiToken: null, source: null }; L.backing = null; }),
  // every key that names it — the role, the selector the loupe answers and the getter's name
  'a scope getter\'s host': Object.keys(SELECTOR).map((role) => [role, (L) => { if (!L.hostOf?.[role]) return false; for (const k of [role, SELECTOR[role], SCOPE_GETTER[role]]) delete L.hostOf[k]; }]),
};
test('T-A I9 — removing a supporting read never moves a class to proven and never adds to a proof\'s chain, for every instance of every kind; removing an observation never moves ANOTHER class', () => {
  const failures = [];
  const reached = new Set();
  const turn = Object.fromEntries(Object.keys(SUPPORTING_KINDS).map((k) => [k, 0]));
  let provenBefore = 0;
  for (const [i, { spec, ledger, standard }] of family().entries()) {
    if (i % 5) continue;
    const before = judge(ledger, standard);
    provenBefore += CLASSES.filter((C) => before.classes[C].status === 'proven').length;
    for (const [kind, instances] of Object.entries(SUPPORTING_KINDS)) {
      // the first instance not yet removed anywhere, then the rotation — so the family reaches each
      const rotation = instances.map((_, k) => instances[(k + turn[kind]) % instances.length]);
      turn[kind] += 1;
      let removed = null;
      for (const [name, remove] of [...rotation.filter(([n]) => !reached.has(`${kind}: ${n}`)), ...rotation]) {
        const L = structuredClone(ledger);
        if (remove(L) !== false) { removed = { name, L }; break; }
      }
      if (!removed) continue;
      reached.add(`${kind}: ${removed.name}`);
      const what = `${kind} (${removed.name})`;
      const after = judge(removed.L, standard);
      for (const C of CLASSES) {
        const b = before.classes[C];
        const a = after.classes[C];
        if (b.status !== 'proven' && a.status === 'proven') failures.push(`${describe(spec)}: removing ${what} proved ${C}`);
        if (b.status === 'proven' && a.status === 'proven') {
          const was = new Set(chainOf(before, C).map((e) => JSON.stringify(toJson(e))));
          const added = chainOf(after, C).filter((e) => !was.has(JSON.stringify(toJson(e))));
          if (added.length) failures.push(`${describe(spec)}: removing ${what} added ${JSON.stringify(toJson(added))} to ${C}'s chain`);
        }
      }
    }
    ledger.observations.forEach((o, k) => {
      const L = structuredClone(ledger);
      L.observations.splice(k, 1);
      const after = judge(L, standard);
      for (const C of CLASSES) if (C !== o.class && before.classes[C].status !== 'proven' && after.classes[C].status === 'proven') failures.push(`${describe(spec)}: deleting a ${o.class} observation proved ${C}`);
    });
  }
  assert.ok(provenBefore > 100, `only ${provenBefore} proven class(es) to remove a read from — the cell tests nothing`);
  const unreached = Object.entries(SUPPORTING_KINDS).flatMap(([kind, list]) => list.map(([n]) => `${kind}: ${n}`)).filter((k) => !reached.has(k));
  assert.deepEqual(unreached, [], `seed ${SEED}: these supporting reads were never removed from a ledger that carried them — the family no longer reaches them`);
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} non-monotone derivation(s)`);
});

test('I9\'s boundary — an ENTRY inside a writer list, a facet entry no list names, a counter reading at a slot the table does not list and a SECOND record of a key already read are refuting: deleting each restores the proof it withheld, while deleting the facet entry of a NAMED writer, or its hash alone, does not', () => {
  const proven = (L) => CLASSES.every((C) => judge(L).classes[C].status === 'proven');
  // the classes each fixture's refuting read withholds: a provenance refusal is every class's; the live-commit counter is the intent class's alone
  const withheld = (L, classes = CLASSES) => classes.every((C) => judge(L).classes[C].status === 'indeterminate');
  // a writer the cut history names, its code empty: a cut proves it had code, so it refuses
  const emptyUnderCut = () => { const { ledger: L } = ledgerOf(); L.provenance.facets.push({ address: A.rogue, sources: ['record:live'], codeHash: EMPTY_CODE_HASH }); L.cutHistory.addresses.push(A.rogue); return L; };
  // a code-hash read of an address no writer list names, its code no era's — a ledger the collector does not write
  const orphan = () => { const { ledger: L } = ledgerOf(); L.provenance.facets.push({ address: A.rogue, sources: [], codeHash: H(0xbad) }); return L; };
  // the live-commit counter non-zero at a slot no era lists: a commit no read reached
  const offTable = () => { const { ledger: L } = ledgerOf(); L.range.storage.counters.intentLiveCommitCount.push({ slot: slotOf(300), value: 1n }); return L; };
  // a writer a list names, with code no era built
  const unattributed = () => { const { ledger: L } = ledgerOf(); L.provenance.facets.push({ address: A.rogue, sources: ['cut-history'], codeHash: H(0xbad) }); L.cutHistory.addresses.push(A.rogue); return L; };
  for (const [what, build, classes] of [['empty code under a cut', emptyUnderCut], ['an orphan facet entry', orphan], ['an off-table counter reading', offTable, ['liveIntentCommits']], ['a named, unattributed writer', unattributed]]) assert.ok(withheld(build(), classes), `${what}: the fixture withholds no proof — the cell compares nothing`);
  // refuting: the deletion restores the proof
  const L1 = emptyUnderCut(); L1.cutHistory.addresses = L1.cutHistory.addresses.filter((a) => a !== A.rogue);
  assert.ok(proven(L1), 'deleting the address from the cut history leaves empty code no cut named — the entry inside the list was refuting');
  const L2 = orphan(); L2.provenance.facets = L2.provenance.facets.filter((f) => f.address !== A.rogue);
  assert.ok(proven(L2), 'deleting a facet entry no list names restores the proof it withheld');
  const L3 = offTable(); L3.range.storage.counters.intentLiveCommitCount = L3.range.storage.counters.intentLiveCommitCount.filter((x) => x.slot !== slotOf(300));
  assert.ok(proven(L3), 'deleting a counter reading the table does not list restores the proof it withheld — no conjunct owes it');
  // supporting at the granularity I9 removes: the named writer's code-hash read, or its hash alone
  const L4 = unattributed(); L4.provenance.facets = L4.provenance.facets.filter((f) => f.address !== A.rogue);
  assert.ok(withheld(L4), 'deleting a NAMED writer\'s facet entry leaves the writer unhashed — still refused');
  const L5 = unattributed(); delete L5.provenance.facets.find((f) => f.address === A.rogue).codeHash;
  assert.ok(withheld(L5), 'deleting a NAMED writer\'s code hash alone leaves its entry malformed — still refused');
  // a SECOND record of a key already read: one key, one read, so the pair refuses whatever the records say, and
  // deleting the second record restores the proof — the header's REFUTING duplicates, at the granularity I9 does not remove
  const twice = [
    ['a second reading at HEAD\'s lifetime-counter slot', (L) => L.range.storage.counters.totalLoansEverCreated.push({ slot: SLOTS.fields.totalLoansEverCreated, value: 7n }), (L) => L.range.storage.counters.totalLoansEverCreated.pop(), CLASSES],
    ['a second facet entry for HEAD\'s facet, its code no era\'s', (L) => L.provenance.facets.push({ address: A.head, sources: ['loupe'], codeHash: H(0xbad) }), (L) => L.provenance.facets.pop(), CLASSES],
    ['a second facet entry for HEAD\'s facet, its hash the same', (L) => L.provenance.facets.push({ address: A.head, sources: ['loupe'], codeHash: CODE.head }), (L) => L.provenance.facets.pop(), CLASSES],
    ['a second facet entry for HEAD\'s facet, another era\'s catalogued hash', (L) => L.provenance.facets.push({ address: A.head, sources: ['loupe'], codeHash: CODE.old }), (L) => L.provenance.facets.pop(), CLASSES],
    ['the loan getter\'s role spelling naming an earlier era\'s facet beside its selector naming HEAD\'s', (L) => { L.hostOf.loan = A.old; }, (L) => { delete L.hostOf.loan; }, ['fallbackSnapshotCustody']],
    ['the loan getter\'s selector naming an earlier era\'s facet beside its role spelling naming HEAD\'s', (L) => { L.hostOf[SELECTOR.loan] = A.old; }, (L) => { delete L.hostOf[SELECTOR.loan]; }, ['fallbackSnapshotCustody']],
  ];
  for (const [what, add, drop, classes] of twice) {
    const L = ledgerOf().ledger;
    add(L);
    assert.ok(withheld(L, classes), `${what}: the pair withholds no proof — a key read twice was settled by one of its records`);
    drop(L);
    assert.ok(proven(L), `${what}: deleting the second record does not restore the proof — the cell compares nothing`);
  }
});

// ── T-B — the no-loans truth table ──────────────────────────────────────────
const shapeLabel = (r) => (r === 'absent' ? '(absent,absent)' : `(${r.stats},${typeof r.ids === 'string' ? r.ids : r.ids.length ? r.ids.join(',') : '∅'})`);
const idsLength = (ids) => (typeof ids === 'string' ? rangeTop(ids) : ids.length);
function bLedger({ routed, n, tlecZero, intentZero }, standard = 'provenance') {
  const { ledger } = ledgerOf({
    range: n === null ? 'unavailable' : n === 0n ? 'zero' : 'N',
    'rows.vpfiHeldCustody': 'none', 'rows.rebateRows': 'none', 'rows.fallbackSnapshotCustody': 'none', 'rows.liveIntentCommits': 'none',
    standard,
  });
  if (ledger.range.storage) {
    setHead(ledger, 'totalLoansEverCreated', tlecZero ? 0n : 5n);
    setHead(ledger, 'intentLiveCommitCount', intentZero ? 0n : 1n);
  }
  if (routed === 'absent') { ledger.range.routed = null; ledger.surfaces.getProtocolStats = 'unrouted'; ledger.surfaces.getAllLoansPaginated = 'unrouted'; }
  else { ledger.range.routed = { totalLoansEverCreated: routed.stats, enumeratedIds: routed.ids, reportedTotal: routed.stats }; ledger.surfaces.getProtocolStats = 'routed'; ledger.surfaces.getAllLoansPaginated = 'routed'; }
  return ledger;
}
const bCell = (cell, standard = 'provenance') => { const ledger = bLedger(cell, standard); return { ledger, v: judge(ledger, standard) }; };

test('T-B — the no-loans bound holds in exactly 2 of the 36 cells, and every other cell fails the obligation that names why', () => {
  const ROUTED = ['absent', { stats: 0n, ids: [] }, { stats: 0n, ids: '1..5' }, { stats: 5n, ids: [] }, { stats: 5n, ids: '1..5' }];
  // the two routed-vs-routed shapes the collector THROWS on (a lifetime counter
  // above zero beside an empty enumeration; an enumeration whose length is not
  // the reported total, which the table models as the stats figure) never
  // reach the judge — the deployment lands in failures[] with its partial ledger
  const reachesJudge = (r) => r === 'absent' || !((r.stats > 0n && idsLength(r.ids) === 0) || BigInt(idsLength(r.ids)) !== r.stats);
  const cells = [];
  for (const routed of ROUTED.filter(reachesJudge)) for (const n of [null, 0n, 5n]) for (const tlecZero of [true, false]) for (const intentZero of [true, false]) cells.push({ routed, n, tlecZero, intentZero });
  assert.equal(cells.length, 36, '3 routed shapes × 3 storage ranges × 2 × 2 counter states');
  let bound = 0;
  for (const standard of ['provenance', 'routed']) {
    for (const cell of cells) {
      const name = `${standard}: routed ${shapeLabel(cell.routed)}, storage ${cell.n ?? 'unavailable'}, totalLoansEverCreated ${cell.tlecZero ? 'zero' : 'non-zero'}, intentLiveCommitCount ${cell.intentZero ? 'zero' : 'non-zero'}`;
      const { v } = bCell(cell, standard);
      const holds = CLASSES.every((C) => v.classes[C].status === 'proven' && chainOf(v, C).some(isBoundEntry));
      const expected = cell.n === 0n && cell.tlecZero && cell.intentZero && (cell.routed === 'absent' || cell.routed.stats === 0n);
      assert.equal(holds, expected, `${name}: the zero-loans bound ${holds ? 'holds' : 'fails'}`);
      if (holds && standard === 'provenance') bound += 1;
      if (cell.n === 0n && !cell.intentZero) for (const C of CLASSES) assert.ok(v.classes[C].status === 'indeterminate' && reasonsOf(v, C).includes('range-nonempty-or-bound'), `${name}: ${C} must name range-nonempty-or-bound — an empty scan proves nothing beside a live commit count (S2-1)`);
      if (cell.n === 0n && cell.routed !== 'absent' && cell.routed.stats === 5n) for (const C of CLASSES) assert.ok(reasonsOf(v, C).includes('no-range-contradiction'), `${name}: ${C} must name no-range-contradiction`);
      if (cell.n === 5n) for (const C of CLASSES) assert.ok(!chainOf(v, C).some(isBoundEntry), `${name}: ${C} carries a zero-loans bound over five loans`);
      if (cell.n === 5n && cell.routed !== 'absent' && cell.routed.stats === 0n && !cell.tlecZero) assert.equal(routedAgrees(v), false, `${name}: a routed zero beside a HEAD counter of 5 is published as disagreeing (r28 P1)`);
      if (cell.n === null) for (const C of CLASSES) assert.ok(reasonsOf(v, C).includes('range-known'), `${name}: ${C} must name range-known`);
    }
  }
  assert.equal(bound, 2);
});

test('T-B — a vehicle-filtered enumeration is SOUND (S1-R2), an unrouted pagination is not agreement (S2-4)', () => {
  // HEAD facet, one internal vehicle (loan 3) among five ids: the lifetime
  // counter never counted it (4), the pagination skips it ({1,2,4,5}) and
  // reports nextLoanId − vehicles (4) — the figures the contract produces
  // (MetricsFacet.getAllLoansPaginated, LibMetricsHooks.onLoanInitialized)
  const vehicle = ledgerOf({ routed: 'subset' }).ledger;
  assert.deepEqual(toJson(vehicle.range.routed), { totalLoansEverCreated: '4', enumeratedIds: ['1', '2', '4', '5'], reportedTotal: '4' });
  assert.equal(String(vehicle.range.storage.nextLoanId), '5');
  assert.equal(String(vehicle.range.storage.counters.totalLoansEverCreated.find((r) => r.slot === SLOTS.fields.totalLoansEverCreated).value), '4', 'HEAD\'s counter never counted the vehicle');
  const v = judge(vehicle);
  assert.equal(routedAgrees(v), true, 'stats 4 === HEAD 4 ≤ 4 distinct ids, {1,2,4,5} ⊂ 1..5, 4 ≤ 5 — a subset witness, never a contradiction');
  for (const C of CLASSES) assert.equal(v.classes[C].status, 'proven', `${C}: ${JSON.stringify(toJson(v.classes[C].reasons))}`);
  const waived = ledgerOf({ routed: 'subset', provenance: 'unattributed', standard: 'routed' }).ledger;
  for (const C of CLASSES) assert.equal(judge(waived, 'routed').classes[C].status, 'proven', `${C}: the routed waiver stands on a vehicle-filtered enumeration`);
  // the shape the contract cannot produce: HEAD's counter (= the routed one) at
  // five beside four listed ids counts a loan the pagination does not list
  setHead(waived, 'totalLoansEverCreated', 5n);
  waived.range.routed.totalLoansEverCreated = 5n;
  const over = judge(waived, 'routed');
  assert.equal(routedAgrees(over), false, 'HEAD 5 = routed 5 beside four listed ids passed as agreement');
  assert.match(String(over.scanned.routedRangeDisagreement), /5 at 0x[0-9a-f]{64} \(HEAD's slot\)/);
  for (const C of CLASSES) assert.ok(over.classes[C].status === 'indeterminate' && reasonsOf(over, C).includes('provenance-attributed'), `${C}: the waiver was granted over a HEAD count the enumeration does not list`);

  // stats routed, pagination not: no enumeration, so nothing to waive with
  const noPage = ledgerOf({ routed: 'absent', provenance: 'unattributed', standard: 'routed' }).ledger;
  noPage.surfaces.getProtocolStats = 'routed';
  const w = judge(noPage, 'routed');
  assert.equal(noPage.range.routed, null);
  assert.equal(routedAgrees(w), false, 'an absent enumeration is not agreement');
  for (const C of CLASSES) assert.ok(w.classes[C].status === 'indeterminate' && reasonsOf(w, C).includes('provenance-attributed'), `${C}: the waiver is denied without a routed enumeration`);
});

/** The MID era's lifetime-counter slot: no current field occupies it, so a non-zero reading there is the old counter, unexplained. */
const ORPHAN_TLEC_SLOT = slotOf(MIDREL.totalLoansEverCreated);
/** The r28 P1b shape under the routed standard with a refused provenance: HEAD's counter at `head`, the MID era's at `earlier`, the routed range `routed`. */
const earlierCounterLedger = ({ head, earlier, at = ORPHAN_TLEC_SLOT, routed }) => {
  const { ledger } = ledgerOf({ standard: 'routed', provenance: 'unattributed' });
  setHead(ledger, 'totalLoansEverCreated', head);
  setAt(ledger, 'totalLoansEverCreated', at, earlier);
  ledger.range.routed = routed;
  return ledger;
};

test('T-B — the routed enumeration must list every loan an EARLIER era\'s lifetime counter counted (r28 P1b): an empty enumeration beside HEAD 0 and an unexplained earlier 3 is not agreement, so the routed waiver is denied; a migrated counter the ids cover stays sound', () => {
  assert.ok(STORAGE_READ.eraSlots.totalLoansEverCreated.some((e) => e.slot === ORPHAN_TLEC_SLOT), 'the MID era\'s counter slot is an era slot the table lists');
  assert.equal(OCCUPIED.some((o) => o.from === ORPHAN_TLEC_SLOT), false, 'no current field occupies it — a reading there is a counter, not an alias');
  const EMPTY = { totalLoansEverCreated: 0n, enumeratedIds: [], reportedTotal: 0n };

  // the probe: N 5, HEAD 0, routed (0, ∅, 0) — routed equals HEAD, ∅ ⊆ 1..5,
  // 0 ≤ 5 — and an earlier counter of 3 no current field explains: three
  // non-vehicle loans storage counted that the pagination does not list
  const L = earlierCounterLedger({ head: 0n, earlier: 3n, routed: EMPTY });
  const v = judge(L, 'routed');
  assert.deepEqual(v.scanned.counters.earlierUnexplained.map((u) => [u.which, u.slot, u.value]), [['totalLoansEverCreated', ORPHAN_TLEC_SLOT, '3']], 'the reading is published as an unexplained earlier counter');
  assert.equal(routedAgrees(v), false, 'storage counted three loans the enumeration does not list — that is disagreement');
  assert.ok(String(v.scanned.routedRangeDisagreement).includes(`3 at ${ORPHAN_TLEC_SLOT}`), `the disagreement names the reading: ${v.scanned.routedRangeDisagreement}`);
  for (const C of CLASSES) {
    assert.ok(v.classes[C].status === 'indeterminate' && reasonsOf(v, C).includes('provenance-attributed'), `${C}: the waiver was granted over an earlier counter the enumeration does not cover`);
    assert.match(v.classes[C].obligations['provenance-attributed'].detail, /waiver is denied/);
  }
  assert.deepEqual(invariantViolations(v, L, { standard: 'routed' }), [], 'the I5 oracle reads the same conjunct');
  // the routed view published beside a provenance-standard verdict moves with it
  const p = judge(L, 'provenance');
  assert.deepEqual(Object.values(p.scanned.provenance.withoutProvenanceRule), CLASSES.map(() => 'indeterminate'));
  // and the provenance standard itself never reads the routed agreement (recorded default 4)
  const attributed = earlierCounterLedger({ head: 0n, earlier: 3n, routed: EMPTY });
  attributed.provenance.facets = attributed.provenance.facets.filter((f) => f.address !== A.rogue);
  attributed.cutHistory.addresses = attributed.cutHistory.addresses.filter((a) => a !== A.rogue);
  for (const C of CLASSES) assert.equal(judge(attributed, 'provenance').classes[C].status, 'proven', `${C}: a stale routed witness revokes only the routed waiver`);

  // straddle the bound: three distinct ids listed cover an earlier 3, not an earlier 4
  const three = { totalLoansEverCreated: 2n, enumeratedIds: [1n, 2n, 3n], reportedTotal: 3n };
  for (const [earlier, sound] of [[3n, true], [4n, false]]) {
    const w = judge(earlierCounterLedger({ head: 2n, earlier, routed: three }), 'routed');
    assert.equal(routedAgrees(w), sound, `earlier ${earlier} beside three listed ids`);
    for (const C of CLASSES) assert.equal(w.classes[C].status, sound ? 'proven' : 'indeterminate', `earlier ${earlier}/${C}: ${JSON.stringify(toJson(w.classes[C].reasons))}`);
  }
  // a repeated id lists one loan, never three
  const repeated = judge(earlierCounterLedger({ head: 2n, earlier: 3n, routed: { totalLoansEverCreated: 2n, enumeratedIds: [1n, 1n, 1n], reportedTotal: 3n } }), 'routed');
  assert.equal(routedAgrees(repeated), false, 'ids [1,1,1] list one loan, not the three the earlier counter counted');
  // the honest migrated Diamond: the old counter 3, HEAD 2 since the move, ids 1..5 — each reading is bounded on its own, never their sum
  const migrated = judge(earlierCounterLedger({ head: 2n, earlier: 3n, routed: { totalLoansEverCreated: 2n, enumeratedIds: '1..5', reportedTotal: 5n } }), 'routed');
  assert.equal(routedAgrees(migrated), true, 'old 3 and HEAD 2 are both covered by five listed ids');
  for (const C of CLASSES) assert.equal(migrated.classes[C].status, 'proven', `migrated/${C}: ${JSON.stringify(toJson(migrated.classes[C].reasons))}`);
  // an earlier reading at a current VALUE field's slot reads that field, so the empty enumeration is not held to it — the residual §7b states
  const aliased = judge(earlierCounterLedger({ head: 0n, earlier: 7n, at: slotOf(OLDREL.totalLoansEverCreated), routed: EMPTY }), 'routed');
  assert.equal(routedAgrees(aliased), true, 'today\'s someCounterToday at the OLD counter slot is not a loan count');
  // a reading nobody can read cannot be shown listed
  const unreadable = judge(earlierCounterLedger({ head: 0n, earlier: 'x', routed: EMPTY }), 'routed');
  assert.equal(routedAgrees(unreadable), false, 'an unparseable earlier counter left the enumeration agreeing');
});

test('T-B — the bound reads every KEPT counter reading: an aliased earlier reading (a current value field\'s value at an old counter slot) leaves nextLoanId 0 four proven and is named in the evidence; the same value at a slot no field occupies withholds it', () => {
  const NO_ROWS = Object.fromEntries(CLASSES.map((C) => [`rows.${C}`, 'none']));
  const aliasedSlot = slotOf(OLDREL.totalLoansEverCreated); // today's someCounterToday — a VALUE field (OCCUPIED)
  const orphanSlot = slotOf(OLDREL.intentLiveCommitCount); // no current field occupies it
  assert.ok(STORAGE_READ.eraSlots.totalLoansEverCreated.some((e) => e.slot === aliasedSlot) && STORAGE_READ.eraSlots.intentLiveCommitCount.some((e) => e.slot === orphanSlot), 'both slots are era slots the table lists');
  for (const standard of ['provenance', 'routed']) {
    const L = ledgerOf({ range: 'zero', routed: 'absent', standard, ...NO_ROWS }).ledger;
    setAt(L, 'totalLoansEverCreated', aliasedSlot, 7n);
    const v = judge(L, standard);
    assert.deepEqual(v.scanned.counters.aliasedIgnored.map((x) => [x.which, x.slot, x.value, x.aliases]), [['totalLoansEverCreated', aliasedSlot, '7', 'someCounterToday']], `${standard}: the reading is set aside as the field it reads`);
    assert.equal(v.scanned.zeroBound, true, `${standard}: nextLoanId 0 with every kept reading zero is the bound`);
    for (const C of CLASSES) {
      assert.equal(v.classes[C].status, 'proven', `${standard}/${C}: ${JSON.stringify(toJson(v.classes[C].reasons))}`);
      const bound = chainOf(v, C).find((e) => /\bcounters zero\b/.test(e.detail));
      assert.ok(bound, `${standard}/${C}: no zero-counter witness in the chain`);
      assert.ok(bound.detail.includes(`totalLoansEverCreated@${aliasedSlot}=7`) && bound.detail.includes('someCounterToday'), `${standard}/${C}: the chain does not name what it set aside: ${bound.detail}`);
    }
    assert.deepEqual(invariantViolations(v, L, { standard }), [], `${standard}: the I7 oracle reads the same kept readings`);
    // the contrast: an earlier reading no current field explains is a counter, and withholds the bound
    const O = ledgerOf({ range: 'zero', routed: 'absent', standard, ...NO_ROWS }).ledger;
    setAt(O, 'intentLiveCommitCount', orphanSlot, 7n);
    const w = judge(O, standard);
    assert.equal(w.scanned.zeroBound, false);
    for (const C of CLASSES) assert.ok(w.classes[C].status === 'indeterminate' && reasonsOf(w, C).includes('range-nonempty-or-bound'), `${standard}/${C}: an unexplained earlier counter left the bound standing`);
  }
});

test('a counter reading\'s eras are the GIVEN table\'s answer for its slot — eras a ledger carries of its own are not read', () => {
  const L = ledgerOf().ledger;
  const slot = slotOf(OLDREL.intentLiveCommitCount);
  for (const r of L.range.storage.counters.intentLiveCommitCount) if (r.slot === slot) Object.assign(r, { value: 1n, eras: [{ commit: 'collector', date: 'read-time table' }] });
  const [u] = judge(L).scanned.counters.earlierUnexplained;
  assert.equal(u.slot, slot);
  assert.deepEqual(u.eras, STORAGE_READ.eraSlots.intentLiveCommitCount.find((e) => e.slot === slot).eras, 'the read-time eras the ledger carried were published instead of the table\'s');
});

test('a residual the design states (§7b, round 28 P1b): an EMPTY routed enumeration beside a storage range of five is sound when HEAD\'s lifetime counter and every earlier era\'s counter also read zero — the all-vehicle shape — so under the routed standard the waiver is granted on getters that read the storage range', () => {
  // pinned so the residual and its statement move together: a judge that closes it fails here, and the design's sentence goes with it
  const { ledger } = ledgerOf({ standard: 'routed', provenance: 'unattributed' });
  setHead(ledger, 'totalLoansEverCreated', 0n);
  ledger.range.routed = { totalLoansEverCreated: 0n, enumeratedIds: [], reportedTotal: 0n };
  const v = judge(ledger, 'routed');
  assert.equal(v.scanned.routedRangeAgrees, true, 'routed 0 = HEAD 0, ∅ ⊆ 1..5, 0 ≤ 5');
  for (const C of CLASSES) {
    assert.equal(v.classes[C].status, 'proven', `${C}: ${JSON.stringify(toJson(v.classes[C].reasons))}`);
    assert.equal(v.classes[C].obligations['provenance-attributed'].waived, true);
  }
  // the residual is ONLY the all-zero shape: an earlier counter no current field
  // explains is a count the empty enumeration must cover, and it denies the waiver
  setAt(ledger, 'totalLoansEverCreated', ORPHAN_TLEC_SLOT, 3n);
  assert.ok(CLASSES.every((C) => reasonsOf(judge(ledger, 'routed'), C).includes('provenance-attributed')), 'an unexplained earlier 3 beside the empty enumeration');
  setAt(ledger, 'totalLoansEverCreated', ORPHAN_TLEC_SLOT, 0n);
  // the same shape with HEAD's counter at five is the r28 P1 case: the waiver is denied
  setHead(ledger, 'totalLoansEverCreated', 5n);
  assert.ok(CLASSES.every((C) => reasonsOf(judge(ledger, 'routed'), C).includes('provenance-attributed')));
  // and with the routed counter at five too, agreeing with HEAD, the empty
  // enumeration still lists none of the five loans HEAD counted (round-3
  // review P1) — so neither the routed counter nor HEAD's can widen the residual
  ledger.range.routed.totalLoansEverCreated = 5n;
  for (const enumeratedIds of [[], [1n], [1n, 1n, 1n, 1n, 1n]]) {
    ledger.range.routed.enumeratedIds = enumeratedIds;
    const w = judge(ledger, 'routed');
    assert.equal(w.scanned.routedRangeAgrees, false, `HEAD 5 = routed 5 beside ids [${enumeratedIds}]`);
    assert.ok(CLASSES.every((C) => reasonsOf(w, C).includes('provenance-attributed')), `ids [${enumeratedIds}]: the waiver was granted`);
  }
});

// ── T-D — one breaker per obligation ────────────────────────────────────────
const HELD_REBATE = ['vpfiHeldCustody', 'rebateRows'];
const B = (why, apply, { classes = CLASSES, standards = ['provenance', 'routed'] } = {}) => ({ why, apply, classes, standards });
const addRogue = (L) => { L.provenance.facets.push({ address: A.rogue, sources: ['cut-history'], codeHash: H(0xbad) }); L.cutHistory.addresses.push(A.rogue); };
/**
 * A provenance read naming no writer at all — every writer list empty, the
 * population check satisfied — over which "every writer is attributed" holds
 * only vacuously. The Diamond's constructor installs the facet hosting
 * diamondCut, so the collector never writes this; the judge must still refuse it.
 */
const emptyPopulation = (L) => { L.provenance.facets = []; L.provenance.loupe = []; L.provenance.recorded.facets = []; L.cutHistory.addresses = []; L.cutHistory.initializers = []; };
/** A loan-getter host whose code hash the ledger records twice, in the order given — which entry is the facet's code is unknowable. */
const TWICE_READ_HOST = ADDR(0xd0b1e);
const loanHostReadTwice = (order) => (L) => { L.provenance.facets.push(...order.map((k) => ({ address: TWICE_READ_HOST, sources: ['cut-history'], codeHash: CODE[k] }))); L.cutHistory.addresses.push(TWICE_READ_HOST); setHost(L, 'loan', TWICE_READ_HOST); };
const dropOldFacet = (L) => { L.provenance.facets = L.provenance.facets.filter((f) => f.address !== A.old); L.cutHistory.addresses = L.cutHistory.addresses.filter((a) => a !== A.old); };
const storageOf = (L, cls) => L.observations.find((o) => o.class === cls && o.source === 'storage');
/** The held class's HEAD row and its routed twin both carry the amount `v` — null, absent, or a value that does not parse. */
const unreadableHeldAmounts = (L, v) => { storageOf(L, 'vpfiHeldCustody').amount = v; routedOf(L, 'vpfiHeldCustody').amount = v; };
/** The LIF getter unrouted: the held and rebate classes are read from storage alone. */
const unrouteLifGetter = (L) => {
  L.observations = L.observations.filter((o) => !(HELD_REBATE.includes(o.class) && o.source === 'routed-getter'));
  L.surfaces.getBorrowerLifRebate = 'unrouted';
  L.idsAskedOfGetter.getBorrowerLifRebate = '';
};
/** The rebate class's HEAD row and its routed twin both keyed by `id`. */
const rebateLoanId = (L, id) => { storageOf(L, 'rebateRows').loanId = id; routedOf(L, 'rebateRows').loanId = id; };
/**
 * The I4 shape of an unreadable twin: the dedup pairs two reads only where
 * `amountsAgree`, and an amount nobody can read agrees with nothing, so the
 * generator's account of the held class is TWO reads, each to land once.
 */
const unreadableTwin = (v = null) => {
  const { ledger, gen } = ledgerOf();
  unreadableHeldAmounts(ledger, v);
  return { ledger, gen: { ...gen, expected: { ...gen.expected, vpfiHeldCustody: 2 } } };
};
/** H1 — the held class's one storage row moves from HEAD's slot to the OLD era's, its routed twin unchanged: the getter returned a row storage holds only under an earlier layout. */
const moveHeldRowToOldSlot = (L) => { storageOf(L, 'vpfiHeldCustody').slot = slotAt('vpfiHeldCustody', 'old'); };
const zeroRange = (L) => {
  L.range.storage.nextLoanId = 0n;
  L.range.storage.read.loansScanned = 0;
  for (const f of ['totalLoansEverCreated', 'intentLiveCommitCount']) for (const r of L.range.storage.counters[f]) r.value = 0n;
  L.range.routed = null; L.surfaces.getProtocolStats = 'unrouted'; L.surfaces.getAllLoansPaginated = 'unrouted';
  L.observations = [];
  for (const g of Object.keys(L.idsAskedOfGetter)) L.idsAskedOfGetter[g] = '';
};
const BREAKERS = {
  'code-present': [
    B('no code at the Diamond', (L) => { L.flags.codeAbsent = true; L.flags.codeAbsentReason = 'fixture'; }),
    // positive (§1): an unreadable flags record is not "no problem recorded"
    B('the flags record is not an object', (L) => { L.flags = 'not an object'; }),
    B('the code read is not recorded', (L) => { delete L.flags.codeAbsent; }),
  ],
  'is-a-diamond': [
    B('the contract is not a Vaipakam Diamond', (L) => { L.flags.notADiamond = true; }),
    B('the Diamond check is not recorded', (L) => { delete L.flags.notADiamond; }),
  ],
  'range-known': [B('the storage read is unavailable', (L) => { L.range.storage = null; L.range.storageUnavailable = 'fixture: the era table was refused'; })],
  'era-coverage': [
    B('a table slot absent from slotsScanned (a regenerated table names a slot this run never read)', (L) => { L.range.storage.read.slotsScanned.borrowerLifRebate = L.range.storage.read.slotsScanned.borrowerLifRebate.filter((x) => x !== slotOf(OLDREL.borrowerLifRebate)); }, { classes: HELD_REBATE }),
    B('a counter era slot never read', (L) => { L.range.storage.counters.intentLiveCommitCount = L.range.storage.counters.intentLiveCommitCount.filter((x) => x.slot !== slotOf(OLDREL.intentLiveCommitCount)); }, { classes: ['liveIntentCommits'] }),
  ],
  'not-truncated': [
    B('the scan stopped at the cap', (L) => { L.range.storage.truncatedAt = 5000; }),
    // positive (§1): no truncation marker is not a complete scan — the scan's
    // own count of the ids it read must reach the range (root-arrest review r1 P1)
    B('the scan read fewer ids than the range with no truncation recorded', (L) => { L.range.storage.truncatedAt = null; L.range.storage.read.loansScanned = 0; }),
    B('the observations are not a list (the rows the scan read are not recorded)', (L) => { L.observations = 'not a list'; }),
  ],
  'no-range-contradiction': [
    B('HEAD totalLoansEverCreated 6 beside nextLoanId 5', (L) => setHead(L, 'totalLoansEverCreated', 6n)),
    B('an enumerated id 7 beside nextLoanId 5', (L) => { L.range.routed = { totalLoansEverCreated: 5n, enumeratedIds: [1n, 2n, 3n, 4n, 7n], reportedTotal: 5n }; }),
    // a witness that does not parse is not "no contradiction" — nobody can show it stays inside the range
    B('enumerated ids that do not parse as a range', (L) => { L.range.routed.enumeratedIds = '1..x'; }),
    B('enumerated ids that do not parse as a list', (L) => { L.range.routed.enumeratedIds = [{}]; }),
    B('a routed lifetime counter that does not parse', (L) => { L.range.routed.totalLoansEverCreated = 'five'; }),
    B('a counter reading whose value does not parse', (L) => setAt(L, 'totalLoansEverCreated', slotOf(OLDREL.totalLoansEverCreated), 'x')),
    B('both metrics selectors routed, but no routed witness recorded', (L) => { L.range.routed = null; }),
    // a witness the reads owe and the ledger does not carry discharges nothing (§1)
    B('HEAD\'s totalLoansEverCreated reading not recorded (storage\'s witness of the range is unread)', (L) => { L.range.storage.counters.totalLoansEverCreated = L.range.storage.counters.totalLoansEverCreated.filter((x) => x.slot !== SLOTS.fields.totalLoansEverCreated); }),
    B('no routed witness, and no routing answer recorded for the metrics selectors', (L) => { L.range.routed = null; delete L.surfaces.getProtocolStats; delete L.surfaces.getAllLoansPaginated; }),
    B('no routed witness, getProtocolStats routed and getAllLoansPaginated \'not-probed\' (no routing answer for it)', (L) => { L.range.routed = null; L.surfaces.getAllLoansPaginated = 'not-probed'; }),
    B('one counter slot read twice (which value is the counter is unknowable)', (L) => { L.range.storage.counters.totalLoansEverCreated.push({ slot: SLOTS.fields.totalLoansEverCreated, value: 7n }); }),
  ],
  'range-nonempty-or-bound': [
    B('nextLoanId 0 beside intentLiveCommitCount 1 (S2-1)', (L) => { zeroRange(L); setHead(L, 'intentLiveCommitCount', 1n); }),
    B('nextLoanId 0 beside a counter reading that does not parse (it cannot be shown zero)', (L) => { zeroRange(L); setAt(L, 'intentLiveCommitCount', slotOf(OLDREL.intentLiveCommitCount), 'x'); }),
    // the bound rests on readings PRESENT (§1): "every kept reading is zero"
    // holds of no readings at all, so each of these was the bound before
    B('nextLoanId 0 with a counters record carrying no reading at all (zero only vacuously)', (L) => { zeroRange(L); L.range.storage.counters = {}; }),
    B('nextLoanId 0 with one counter kind missing (no intentLiveCommitCount reading recorded)', (L) => { zeroRange(L); delete L.range.storage.counters.intentLiveCommitCount; }),
    B('nextLoanId 0 with HEAD\'s totalLoansEverCreated reading missing, every earlier reading zero', (L) => { zeroRange(L); L.range.storage.counters.totalLoansEverCreated = L.range.storage.counters.totalLoansEverCreated.filter((x) => x.slot !== SLOTS.fields.totalLoansEverCreated); }),
  ],
  'provenance-attributed': [
    B('the provenance read is absent', (L) => { L.provenance = { read: false, reason: 'fixture' }; L.cutHistory = null; }, { standards: ['provenance'] }),
    B('one unattributed facet', addRogue, { standards: ['provenance'] }),
    B('the facet population is incomplete', (L) => { L.cutHistory.constructorCutSeen = false; }, { standards: ['provenance'] }),
    // writer coverage (root-arrest review r1 P1): every writer the population
    // check vouches for must have its code hash read. Each breaker names the
    // rogue through ONE source only, and keeps the population check satisfied
    // (a loupe or recorded facet is the exempt cut host), so it is the
    // code-hash rule alone that refuses
    B('a cut-history address with no code-hash read', (L) => { L.cutHistory.addresses.push(A.rogue); }, { standards: ['provenance'] }),
    B('a cut-history initializer with no code-hash read', (L) => { L.cutHistory.initializers.push(A.rogue); }, { standards: ['provenance'] }),
    B('a loupe entry with no code-hash read', (L) => { L.provenance.loupe.push(A.rogue); L.provenance.cutFacetHost = A.rogue; }, { standards: ['provenance'] }),
    B('a recorded facet with no code-hash read', (L) => { L.provenance.recorded.facets.push(A.rogue); L.provenance.cutFacetHost = A.rogue; }, { standards: ['provenance'] }),
    // a code hash is a keccak256 word or no read at all (round-3 review P2):
    // the rogue sits in the loupe and the cut history, so the population is
    // complete, and its entry's hash is all that is wrong — a null or a number
    // once became "no code", which reads as "never wrote"
    B('a loupe and cut-history facet whose code hash is null', (L) => { L.provenance.facets.push({ address: A.rogue, sources: ['loupe', 'record:live'], codeHash: null }); L.provenance.loupe.push(A.rogue); L.cutHistory.addresses.push(A.rogue); }, { standards: ['provenance'] }),
    B('a loupe and cut-history facet whose code hash is a number', (L) => { L.provenance.facets.push({ address: A.rogue, sources: ['loupe', 'record:live'], codeHash: 12345 }); L.provenance.loupe.push(A.rogue); L.cutHistory.addresses.push(A.rogue); }, { standards: ['provenance'] }),
    // "named by the cut history" is membership in its lists, never the entry's
    // own label (round-3 review P2): empty code at an address a cut named is
    // unreadable, not "never wrote", whatever the entry says its sources were
    B('the empty-code hash at an address the cut history names, its entry\'s sources omitting the cut history', (L) => { L.provenance.facets.push({ address: A.rogue, sources: ['record:live'], codeHash: EMPTY_CODE_HASH }); L.cutHistory.addresses.push(A.rogue); }, { standards: ['provenance'] }),
    B('the empty-code hash at an initializer a cut delegatecalled, its entry\'s sources omitting the cut history', (L) => { L.provenance.facets.push({ address: A.rogue, sources: [], codeHash: EMPTY_CODE_HASH }); L.cutHistory.initializers.push(A.rogue); L.cutHistory.addresses.push(A.rogue); }, { standards: ['provenance'] }),
    // one address, one code-hash read (#2095 round-28 'duplicate reads'): which of
    // two entries is the facet's code is unknowable, so neither attributes it —
    // whatever the two hashes say, and however the address is spelled
    B('two code-hash entries for one address, the same catalogued hash', (L) => { L.provenance.facets.push({ address: A.head, sources: ['loupe'], codeHash: CODE.head }); }, { standards: ['provenance'] }),
    B('two code-hash entries for one address, two different catalogued hashes', (L) => { L.provenance.facets.push({ address: A.head, sources: ['loupe'], codeHash: CODE.old }); }, { standards: ['provenance'] }),
    B('two code-hash entries for one address, spelled in two cases', (L) => { L.provenance.facets.push({ address: `0x${A.head.slice(2).toUpperCase()}`, sources: ['loupe'], codeHash: CODE.head }); }, { standards: ['provenance'] }),
    // positive presence (§1): "every writer is attributed" is true of no writers at all
    B('an empty writer population: no list names a writer and no facet is attributed', emptyPopulation, { standards: ['provenance'] }),
    B('an empty writer population at nextLoanId 0, beside the zero bound', (L) => { zeroRange(L); emptyPopulation(L); }, { standards: ['provenance'] }),
    B('waiver denied: routed totalLoansEverCreated 0 beside HEAD 5 (r28 P1)', (L) => { addRogue(L); L.range.routed = { totalLoansEverCreated: 0n, enumeratedIds: [], reportedTotal: 0n }; }, { standards: ['routed'] }),
    B('waiver denied: no routed enumeration (S2-4)', (L) => { addRogue(L); L.range.routed = null; L.surfaces.getAllLoansPaginated = 'unrouted'; }, { standards: ['routed'] }),
    B('waiver denied: an earlier era\'s lifetime counter of 3 the empty enumeration does not list, beside HEAD 0 (r28 P1b)', (L) => { addRogue(L); setHead(L, 'totalLoansEverCreated', 0n); setAt(L, 'totalLoansEverCreated', ORPHAN_TLEC_SLOT, 3n); L.range.routed = { totalLoansEverCreated: 0n, enumeratedIds: [], reportedTotal: 0n }; }, { standards: ['routed'] }),
    // the listing bound's HEAD term (round-3 review P1): the routed counter
    // EQUALS HEAD's, so only the bound itself can see that the pagination
    // lists none — or one — of the five loans HEAD counted
    B('waiver denied: HEAD\'s lifetime counter 5, equal to the routed one, beside an EMPTY enumeration (r28 P1b, HEAD term)', (L) => { addRogue(L); L.range.routed = { totalLoansEverCreated: 5n, enumeratedIds: [], reportedTotal: 0n }; }, { standards: ['routed'] }),
    // the collector-reachable form: it throws on a non-zero counter beside no ids, or on ids ≠ the reported total — this shape trips neither
    B('waiver denied: HEAD\'s lifetime counter 5, equal to the routed one, beside ONE enumerated id that is the reported total (r28 P1b, HEAD term)', (L) => { addRogue(L); L.range.routed = { totalLoansEverCreated: 5n, enumeratedIds: [1n], reportedTotal: 1n }; }, { standards: ['routed'] }),
  ],
  'getter-coverage': [
    B('the rebate getter asked over 1..2 of 1..5 (C6)', (L) => { L.idsAskedOfGetter.getBorrowerLifRebate = '1..2'; }, { classes: HELD_REBATE }),
    // "unrouted" is a recorded answer (§1), never the absence of one
    B('the LIF getter returned no row and its routing answer reads \'not-probed\'', (L) => { unrouteLifGetter(L); L.surfaces.getBorrowerLifRebate = 'not-probed'; }, { classes: HELD_REBATE }),
    // an empty range is covered by a RECORDED asked set ('' for none), never by no record
    B('nextLoanId 0 with the rebate getter routed and no asked-ids record for it', (L) => { zeroRange(L); delete L.idsAskedOfGetter.getBorrowerLifRebate; }, { classes: ['rebateRows'] }),
  ],
  'getter-head-slot-agreement': [
    B('a HEAD-slot storage row with no routed twin', (L) => { L.observations = L.observations.filter((o) => !(o.class === 'vpfiHeldCustody' && o.source === 'routed-getter')); }, { classes: ['vpfiHeldCustody'] }),
    B('a routed amount the HEAD slot does not hold', (L) => { routedOf(L, 'fallbackSnapshotCustody').amount = 21n; }, { classes: ['fallbackSnapshotCustody'] }),
    B('a routed row storage holds only at an earlier era\'s slot (H1: the cut getter reads that era\'s layout)', moveHeldRowToOldSlot, { classes: ['vpfiHeldCustody'] }),
    B('the LIF getter returned no row and no routing answer is recorded for it', (L) => { unrouteLifGetter(L); delete L.surfaces.getBorrowerLifRebate; }, { classes: HELD_REBATE }),
  ],
  'asset-settled': [
    B('a routed row with no asset — getLoanDetails unrouted (r28 P2)', (L) => { routedOf(L, 'fallbackSnapshotCustody').assetAddr = null; L.surfaces.getLoanDetails = 'unrouted'; L.idsAskedOfGetter.getLoanDetails = ''; setHost(L, 'loan', null); }, { classes: ['fallbackSnapshotCustody'] }),
    B('the scope hosts do not share a layout, with rows only INCLUDED (r26)', (L) => setHost(L, 'loan', A.old), { classes: ['fallbackSnapshotCustody'] }),
    B('an artifact-sourced token with class-2 rows', (L) => { L.scope.source = 'artifact'; L.surfaces.getVPFIToken = 'unrouted'; setHost(L, 'token', null); }, { classes: ['fallbackSnapshotCustody'] }),
    // one key, one read: two spellings of one getter's host naming different
    // facets leave the host unknown — never settled by the spelling read first
    B('the loan getter\'s host spelled twice, differently (its selector names HEAD\'s facet, its role an earlier era\'s)', (L) => { L.hostOf.loan = A.old; }, { classes: ['fallbackSnapshotCustody'] }),
    B('the loan getter\'s host spelled twice, differently (its selector names an earlier era\'s facet, its role HEAD\'s)', (L) => { L.hostOf[SELECTOR.loan] = A.old; }, { classes: ['fallbackSnapshotCustody'] }),
    // ...and a host whose code was read twice is no attributed host, in either
    // order (the first matching entry once decided the layout it shares)
    B('the loan getter\'s host carries two code-hash entries, HEAD\'s catalogued hash first', loanHostReadTwice(['head', 'old']), { classes: ['fallbackSnapshotCustody'] }),
    B('the loan getter\'s host carries two code-hash entries, HEAD\'s catalogued hash second', loanHostReadTwice(['old', 'head']), { classes: ['fallbackSnapshotCustody'] }),
  ],
  'scope-known': [
    B('no VPFI token on a deployment with loans', (L) => { L.scope = { vpfiToken: null, source: null }; L.backing = null; L.surfaces.getVPFIToken = 'unrouted'; setHost(L, 'token', null); }),
    // the vacuous bound used to discharge this too (item: the bound needs HEAD's readings present)
    B('no VPFI token at nextLoanId 0 with no counter reading recorded (a vacuous zero bound)', (L) => { zeroRange(L); L.range.storage.counters = {}; L.scope = { vpfiToken: null, source: null }; L.backing = null; L.surfaces.getVPFIToken = 'unrouted'; setHost(L, 'token', null); }),
    B('an artifact-sourced token (classes 2/3 need an on-chain one)', (L) => { L.scope.source = 'artifact'; L.surfaces.getVPFIToken = 'unrouted'; setHost(L, 'token', null); }, { classes: ['fallbackSnapshotCustody', 'liveIntentCommits'] }),
    // a token is evidence only with its source: an unrecorded or unknown source resolves nothing
    B('a VPFI token whose source is neither on-chain nor the artifact', (L) => { L.scope.source = 'banana'; }),
    B('a VPFI token with no source recorded', (L) => { delete L.scope.source; }),
  ],
  'row-attributed': [
    B('an ambiguous earlier-era held row', (L) => L.observations.push(storageObs('vpfiHeldCustody', '5', 'mid', 3n)), { classes: ['vpfiHeldCustody'] }),
    B('a held row at a slot of an unattributed era', (L) => { L.observations.push(storageObs('vpfiHeldCustody', '5', 'old', 3n)); dropOldFacet(L); }, { classes: ['vpfiHeldCustody'] }),
    // one key, one read (root-arrest review r1 P2): a second read of a key the
    // reconciliation joins by loan id would silently replace the first
    B('a getter answer recorded twice for one loan', (L) => L.observations.push({ ...routedOf(L, 'vpfiHeldCustody'), amount: 100n }), { classes: ['vpfiHeldCustody'] }),
    B('one storage slot read twice for one loan', (L) => L.observations.push({ ...storageOf(L, 'fallbackSnapshotCustody'), amount: 99n }), { classes: ['fallbackSnapshotCustody'] }),
    // a read the judge cannot read is filed unknown and named, like a key read
    // twice — never normalised into a row nobody read (each was `proven` before)
    B('a held row and its routed twin whose amounts do not parse', (L) => unreadableHeldAmounts(L, 'x'), { classes: ['vpfiHeldCustody'] }),
    B('a storage-only rebate row whose amount does not parse (its getter unrouted)', (L) => { unrouteLifGetter(L); storageOf(L, 'rebateRows').amount = 'x'; }, { classes: ['rebateRows'] }),
    B('a loan id that does not parse', (L) => rebateLoanId(L, 'abc'), { classes: ['rebateRows'] }),
    B('a loan id beyond nextLoanId (no read of the range was asked about it)', (L) => rebateLoanId(L, '99'), { classes: ['rebateRows'] }),
    B('a read whose source is neither storage nor routed-getter', (L) => { storageOf(L, 'liveIntentCommits').source = 'banana'; }, { classes: ['liveIntentCommits'] }),
  ],
  'intent-counter-consistent': [
    B('HEAD intentLiveCommitCount 1 with zero candidates', (L) => { L.observations = L.observations.filter((o) => o.class !== 'liveIntentCommits'); }, { classes: ['liveIntentCommits'] }),
    B('an earlier-era intentLiveCommitCount reading 1', (L) => setAt(L, 'intentLiveCommitCount', slotOf(OLDREL.intentLiveCommitCount), 1n), { classes: ['liveIntentCommits'] }),
  ],
  'corroboration-consistent': [
    B('the logs say loan 3, the view says loan 4', (L) => { L.corroboration = { source: 'event-lifecycle', logsSeen: 2, liveLoanIdsFromLogs: ['3'] }; }, { classes: ['liveIntentCommits'] }),
    // "not taken" is the recorded null or an unavailable reason (§1), never a missing or empty record
    B('the corroboration key is absent (no outcome recorded)', (L) => { delete L.corroboration; }, { classes: ['liveIntentCommits'] }),
    B('a corroboration record with neither a list of live ids nor an unavailable reason', (L) => { L.corroboration = { source: 'event-lifecycle', logsSeen: 2 }; }, { classes: ['liveIntentCommits'] }),
    B('a corroboration record whose live ids are not a list', (L) => { L.corroboration = { source: 'event-lifecycle', logsSeen: 2, liveLoanIdsFromLogs: '4' }; }, { classes: ['liveIntentCommits'] }),
  ],
};

test('T-D — every obligation is broken by a registered breaker, and breaking it names it on every class it governs', () => {
  const unregistered = OBLIGATIONS.map((o) => o.name).filter((n) => !BREAKERS[n]?.length);
  assert.deepEqual(unregistered, [], 'an obligation no breaker breaks is a conjunct no test exercises — register one');
  const stale = Object.keys(BREAKERS).filter((n) => !OBLIGATIONS.some((o) => o.name === n));
  assert.deepEqual(stale, [], 'a breaker for an obligation the judge no longer lists');
  for (const o of OBLIGATIONS) {
    assert.ok(o.scope === 'deployment' || o.scope === 'class', `${o.name}: scope ${o.scope}`);
    assert.equal(typeof o.holds, 'function', `${o.name}: holds`);
    for (const b of BREAKERS[o.name]) for (const standard of b.standards) {
      const { ledger } = ledgerOf({ standard });
      b.apply(ledger);
      const v = judge(ledger, standard);
      for (const C of o.scope === 'deployment' ? CLASSES : b.classes) {
        assert.equal(v.classes[C].status, 'indeterminate', `${o.name} — ${b.why} (${standard}): ${C} stayed proven`);
        assert.ok(reasonsOf(v, C).includes(o.name), `${o.name} — ${b.why} (${standard}): ${C} names ${reasonsOf(v, C).join(', ') || 'nothing'}`);
      }
      assert.deepEqual(invariantViolations(v, ledger, { standard }), [], `${o.name} — ${b.why} (${standard})`);
    }
  }
});

test('H1 — a routed row storage holds ONLY at an earlier era\'s slot is one row for the count, but is not "agreed at HEAD": getter-head-slot-agreement fails naming that slot, under both standards', () => {
  const oldSlot = slotAt('vpfiHeldCustody', 'old');
  for (const standard of ['provenance', 'routed']) {
    const { ledger } = ledgerOf({ standard });
    moveHeldRowToOldSlot(ledger);
    const v = judge(ledger, standard);
    const c = v.classes.vpfiHeldCustody;
    assert.equal(c.status, 'indeterminate', `${standard}: the getter read an earlier layout and the class was certified`);
    assert.ok(reasonsOf(v, 'vpfiHeldCustody').includes('getter-head-slot-agreement'));
    const [m] = v.scanned.getterDisagreements.vpfiHeldCustody;
    assert.equal(m?.loanId, LOAN.vpfiHeldCustody);
    assert.ok(String(m?.storage).includes(oldSlot), `${standard}: the disagreement does not name the earlier slot it was found at: ${JSON.stringify(m)}`);
    assert.doesNotMatch(c.obligations['getter-head-slot-agreement'].detail, /agree on every loan id/);
    // absorbed (#2095 r7 P2): ONE physical row, counted once, at the slot storage found it
    assert.equal(c.count, 1);
    assert.deepEqual(c.unknownAssetRows.concat(c.rows).map((r) => [r.mappingSlot, r.era]), [[oldSlot, 'earlier']]);
    // the rebate class reads the same mapping with its own rows at HEAD — untouched
    assert.equal(v.classes.rebateRows.status, 'proven');
  }
  // under the routed standard the waiver needs the getter's HEAD agreement, so a refused provenance cannot rescue it
  const { ledger } = ledgerOf({ standard: 'routed', provenance: 'unattributed' });
  moveHeldRowToOldSlot(ledger);
  const v = judge(ledger, 'routed');
  assert.equal(v.classes.vpfiHeldCustody.status, 'indeterminate');
  assert.ok(reasonsOf(v, 'vpfiHeldCustody').includes('provenance-attributed'), 'the waiver was granted to a getter that disagrees with HEAD');
  assert.ok(!chainOf(v, 'vpfiHeldCustody').some((e) => /agreed at HEAD/.test(e.detail)));
});

test('one key, one read — a key read twice is filed unknown with the total withdrawn, is never reconciled, and never inflates the intent candidates', () => {
  // a getter answering twice for one loan (10 beside 100): the reconciliation keys by loan id, so one answer would silently replace the other
  const g = ledgerOf().ledger;
  g.observations.push({ ...routedOf(g, 'vpfiHeldCustody'), amount: 100n });
  const gv = judge(g).classes.vpfiHeldCustody;
  assert.equal(gv.status, 'indeterminate');
  assert.equal(gv.total, null, 'a total over a key read twice');
  assert.deepEqual(gv.unknownAssetRows.map((r) => [r.vpfiHeld, r.unknownBecause.split(':')[0]]).sort(), [['10', 'duplicateRead'], ['100', 'duplicateRead']]);
  assert.equal(gv.count, gv.rows.length + gv.unknownAssetRows.length);
  assert.ok(reasonsOf(judge(g), 'vpfiHeldCustody').includes('row-attributed'));
  // one storage slot read twice (10 and 99 — physically impossible at one slot for one loan)
  const s = ledgerOf().ledger;
  s.observations.push({ ...storageOf(s, 'fallbackSnapshotCustody'), amount: 99n });
  const sv = judge(s).classes.fallbackSnapshotCustody;
  assert.equal(sv.total, null);
  assert.equal(sv.unknownAssetRows.filter((r) => /^duplicateRead/.test(r.unknownBecause)).length, 2);
  // a repeated intent answer is not a second live commit: the protocol counter (1) is not exceeded by what was found twice
  const i = ledgerOf().ledger;
  i.observations.push({ ...routedOf(i, 'liveIntentCommits') });
  const iv = judge(i);
  assert.equal(iv.scanned.intentCandidatesFound, 1, 'a duplicate inflated the intent candidates the live-commit counter is checked against');
});

test('I4 — a HEAD row and its routed twin with no readable amount are two reads, each filed unknown once: never merged into one row, never agreed as two counted ones, and the class is not proven', () => {
  for (const v of [null, undefined, 'x']) {
    const label = v === undefined ? 'absent' : JSON.stringify(v);
    // the one predicate: the HEAD merge and the agreement check ask the same
    // question, and an amount nobody read answers "no" on both paths
    assert.equal(amountsAgree(v, v), false, `${label}: an unreadable amount agrees with itself`);
    assert.equal(getterAgreement({ headRows: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: v }] }, routed: { vpfiHeldCustody: [{ loanId: '1', vpfiHeld: v }] } }).vpfiHeldCustody.length, 1, `${label}: the agreement check pairs what the merge refuses`);
    const { ledger, gen } = unreadableTwin(v);
    const verdict = judge(ledger);
    const c = verdict.classes.vpfiHeldCustody;
    assert.equal(c.status, 'indeterminate', `${label}: one physical row read twice with no amount was certified`);
    assert.ok(reasonsOf(verdict, 'vpfiHeldCustody').includes('row-attributed'), `${label}: names ${reasonsOf(verdict, 'vpfiHeldCustody').join(', ')}`);
    assert.deepEqual(c.rows, [], `${label}: an unreadable read was counted`);
    assert.deepEqual(c.unknownAssetRows.map((r) => [r.source, r.unknownBecause.split(':')[0]]).sort(), [['routed-getter', 'unreadableRead'], ['storage', 'unreadableRead']]);
    assert.equal(c.count, 2);
    assert.equal(c.total, null);
    assert.deepEqual(invariantViolations(verdict, ledger, { standard: 'provenance', gen }), [], label);
    // the rebate class reads the same mapping with its own readable rows — untouched
    assert.equal(verdict.classes.rebateRows.status, 'proven');
  }
});

test('provenance-attributed is a CLASS obligation: under the routed standard its waiver turns on each class\'s own getter, so one refusal can withhold some classes and not others', () => {
  const { ledger } = ledgerOf({ standard: 'routed', provenance: 'unattributed', 'getter.getBorrowerLifRebate': 'unrouted' });
  const v = judge(ledger, 'routed');
  for (const C of HELD_REBATE) assert.ok(v.classes[C].status === 'indeterminate' && reasonsOf(v, C).includes('provenance-attributed'), `${C}: no routed getter read it, so the waiver is denied`);
  for (const C of ['fallbackSnapshotCustody', 'liveIntentCommits']) assert.equal(v.classes[C].status, 'proven', `${C}: ${JSON.stringify(toJson(v.classes[C].reasons))}`);
  assert.equal(OBLIGATIONS.find((o) => o.name === 'provenance-attributed').scope, 'class', 'an obligation whose outcome differs between classes is recorded per class');
  assert.equal('provenance-attributed' in v.scanned.deploymentObligations, false);
  // under the provenance standard the same refusal is one fact, alike for every class
  const p = judge(ledgerOf({ provenance: 'unattributed', 'getter.getBorrowerLifRebate': 'unrouted' }).ledger);
  assert.deepEqual(CLASSES.map((C) => p.classes[C].obligations['provenance-attributed'].ok), [false, false, false, false]);
});

test('a facet\'s code is read from what the ledger RECORDS: a code hash that is no keccak256 word is no read and names its writer unhashed, and an address the cut history lists is "named by a cut" whatever its entry\'s label (round-3 review P2)', () => {
  const withRogue = (entry, onto) => {
    const { ledger } = ledgerOf();
    ledger.provenance.facets.push({ address: A.rogue, ...entry });
    for (const list of onto) list(ledger).push(A.rogue);
    return judge(ledger).scanned.provenance;
  };
  const loupe = (L) => L.provenance.loupe;
  const added = (L) => L.cutHistory.addresses;
  const initializers = (L) => L.cutHistory.initializers;
  for (const codeHash of [null, 12345, '0x11']) {
    const p = withRogue({ sources: ['loupe', 'record:live'], codeHash }, [loupe, added]);
    assert.ok(p.malformed.some((m) => m.includes(A.rogue) && m.includes('no code-hash read')), `${JSON.stringify(codeHash)}: the entry is not named malformed: ${JSON.stringify(p.malformed)}`);
    assert.deepEqual(p.unhashedWriters, [A.rogue], `${JSON.stringify(codeHash)}: a writer the lists name, whose hash was never read`);
    assert.equal(p.noCode.includes(A.rogue), false, `${JSON.stringify(codeHash)}: a read nobody took was published as empty code`);
  }
  // the empty-code hash IS a read: a record-only address with it never wrote; one a cut named is unreadable
  assert.deepEqual(withRogue({ sources: ['record:live'], codeHash: EMPTY_CODE_HASH }, []).noCode, [A.rogue], 'the control: a record-only empty address never wrote');
  for (const [what, onto, source] of [['added by a cut', [added], 'cut-history'], ['delegatecalled by a cut', [added, initializers], 'cut-history:initializer']]) {
    const p = withRogue({ sources: ['record:live'], codeHash: EMPTY_CODE_HASH }, onto);
    assert.deepEqual([p.noCode.includes(A.rogue), p.unattributed.includes(A.rogue)], [false, true], `${what}: empty code at an address the cut history lists passed as "never wrote"`);
    assert.match(p.refusal, new RegExp(`${A.rogue} via record:live\\+${source}`), `${what}: the refusal does not say the cut history named it`);
  }
});

test('T-D — the outcome of every conjunct is recorded: broken obligations are all named, never short-circuited (I8)', () => {
  const { ledger } = ledgerOf();
  BREAKERS['not-truncated'][0].apply(ledger);
  BREAKERS['asset-settled'][0].apply(ledger);
  BREAKERS['getter-coverage'][0].apply(ledger);
  const v = judge(ledger);
  for (const n of ['not-truncated', 'asset-settled']) assert.ok(reasonsOf(v, 'fallbackSnapshotCustody').includes(n), `fallback names ${n}`);
  for (const n of ['not-truncated', 'getter-coverage']) assert.ok(reasonsOf(v, 'vpfiHeldCustody').includes(n), `held names ${n}`);
});

test('T-D — the aggregates: one unestablished class withdraws them (r27), and a non-on-chain scope never publishes a shortfall (I12)', () => {
  const { ledger } = ledgerOf();
  const clean = judge(ledger);
  assert.equal(String(clean.vpfiRowsTotal), String(10n + 4n + 20n + 7n), 'held + rebate + VPFI fallback + VPFI intent');
  assert.equal(String(clean.backingShortfall), '0', 'backing 100 covers 41');
  BREAKERS['asset-settled'][0].apply(ledger);
  const w = judge(ledger);
  assert.equal(w.classes.fallbackSnapshotCustody.count, 1, 'the unknown-asset row stays counted (r28 P2)');
  assert.equal(w.classes.fallbackSnapshotCustody.total, null);
  assert.equal(w.vpfiRowsTotal, null, 'a liability no class can total is not stated');
  assert.ok(w.vpfiRowsTotalUnavailable);
  assert.equal(w.backingShortfall, null, 'and no shortfall is computed against it');
  assert.ok(w.backingShortfallUnavailable);
  // a zero-bound deployment is fully proven, so only the scope term can withhold the shortfall
  const z = ledgerOf({ range: 'zero', scopeSource: 'artifact', routed: 'absent' }).ledger;
  z.backing = { token: VPFI, balance: 100n };
  const zv = judge(z);
  for (const C of CLASSES) assert.equal(zv.classes[C].status, 'proven', `${C}: the zero bound discharges scope-known`);
  assert.equal(zv.backingShortfall, null, 'an artifact-sourced token never scopes a backing figure (S1-R5)');
  assert.ok(zv.backingShortfallUnavailable);
});

// Judge step 4 (#2095 r7/r8/r20): one physical row is ONE entry across
// rows+unknown+excluded whichever reads saw it, and two physical rows are two
// even where a getter and an earlier-era slot report the same key.
test('dedup (judge step 4) — HEAD + routed merge; an earlier row is absorbed only by a same-amount routed row with no HEAD row beside it, at most once; intent rows never', () => {
  const physical = (ledger, cls) => { const c = judge(ledger).classes[cls]; return c.rows.length + c.unknownAssetRows.length + c.nonVpfiRowsExcluded.length; };
  const only = (obs) => { const { ledger } = ledgerOf(); ledger.observations = obs; return ledger; };
  const held = 'vpfiHeldCustody';
  assert.equal(physical(only([storageObs(held, '1', 'head', 5n), routedObs(held, '1', 5n)]), held), 1, 'the HEAD row and its routed twin are one row');
  assert.equal(physical(only([storageObs(held, '1', 'old', 5n), routedObs(held, '1', 5n)]), held), 1, 'an older getter already returned the earlier row');
  assert.equal(physical(only([storageObs(held, '1', 'head', 5n), routedObs(held, '1', 5n), storageObs(held, '1', 'old', 5n)]), held), 2, 'with a HEAD row the getter read HEAD: the older row is a distinct liability (r20 P1)');
  assert.equal(physical(only([storageObs(held, '1', 'old', 6n), routedObs(held, '1', 5n)]), held), 2, 'a different amount is a different row');
  assert.equal(physical(only([storageObs(held, '1', 'old', 5n), storageObs(held, '1', 'mid', 5n), routedObs(held, '1', 5n)]), held), 2, 'one routed row absorbs at most one earlier row');
  const fb = 'fallbackSnapshotCustody';
  assert.equal(physical(only([storageObs(fb, '3', 'old', 3n), routedObs(fb, '3', 3n, OTHER)]), fb), 1, 'a routed row filed non-VPFI absorbs its earlier twin too');
  const it = 'liveIntentCommits';
  assert.equal(physical(only([storageObs(it, '4', 'old', null), routedObs(it, '4', 7n, VPFI)]), it), 2, 'the intent getter exposes no orderHash: an earlier commit is never absorbed (r8 P1)');
});

test('reportVerdict — every class proven and empty across every deployment is the only "empty"; a partial run asserts nothing; a live producer keeps the migration', () => {
  const zero = judge(ledgerOf({ range: 'zero', routed: 'absent' }).ledger);
  const rows = judge(ledgerOf().ledger);
  const all = ['fixture-chain|live'];
  const empty = reportVerdict([zero], { allDeployed: all, failures: [], proofStandard: 'provenance' });
  assert.equal(empty.allClassesEmpty, true);
  assert.equal(empty.scope, 'all-deployed-chains');
  assert.equal(empty.migrationRetirable, false, 'producersMayBeLive on a Diamond that routes');
  assert.match(empty.migrationRetirableReason, /producers may be live/);
  assert.equal(reportVerdict([rows], { allDeployed: all, failures: [], proofStandard: 'provenance' }).allClassesEmpty, false, 'proven rows are not empty');
  const partial = reportVerdict([zero], { allDeployed: [...all, 'other|live'], failures: [], proofStandard: 'provenance' });
  assert.equal(partial.allClassesEmpty, null);
  assert.equal(partial.scope, 'partial');
  assert.equal(reportVerdict([zero], { allDeployed: all, failures: [{ chainSlug: 'x', deployment: 'live', error: 'e' }], proofStandard: 'provenance' }).allClassesEmpty, false);
  const broken = ledgerOf();
  BREAKERS['not-truncated'][0].apply(broken.ledger);
  const ind = reportVerdict([judge(broken.ledger)], { allDeployed: all, failures: [], proofStandard: 'provenance' });
  assert.equal(ind.allClassesEmpty, false);
  assert.equal(ind.indeterminateClasses.length, 4);
  assert.ok(ind.indeterminateClasses.every((i) => i.chainSlug === 'fixture-chain' && i.deployment === 'live' && CLASSES.includes(i.class)));
  // the statuses it reads must be the judge's own output (S1-R1 at the report)
  assert.throws(() => reportVerdict([toJson(zero)], { allDeployed: all, failures: [], proofStandard: 'provenance' }), /not verdicts/);
  assert.throws(() => reportVerdict([{ ...zero }], { allDeployed: all, failures: [], proofStandard: 'provenance' }), /not verdicts/);
});

// ── T-C — structural non-bypass ─────────────────────────────────────────────
/**
 * Two length-preserving views of a source file, comments blanked in both:
 * `kept` keeps every string, template and regex literal (the vocabulary grep
 * reads literals — a verdict word IS a string); `blank` blanks their contents
 * too, so a brace, a `return` or a call written inside a message cannot
 * unbalance a body or pose as code. Template literals are lexed with their
 * `${…}` expressions as code, because a nested template would otherwise end
 * the outer one early and every brace after it would be miscounted.
 */
function lex(src) {
  let i = 0;
  let kept = '';
  let blank = '';
  let prev = '';
  const put = (k, b = k) => { kept += k; blank += b; };
  const hollow = (s) => s.replace(/[^\n]/g, ' ');
  const regexMayStart = () => prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of|void|delete|throw|new|yield|await)\s*$/.test(blank);
  const code = (untilBrace) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (untilBrace && c === '}' && depth === 0) return;
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const stop = e === -1 ? src.length : e; put(hollow(src.slice(i, stop))); i = stop; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const stop = e === -1 ? src.length : e + 2; put(hollow(src.slice(i, stop))); i = stop; continue; }
      if (c === '\'' || c === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        const lit = src.slice(i, j + 1);
        put(lit, c + hollow(lit.slice(1, -1)) + lit.slice(-1));
        i = j + 1; prev = c; continue;
      }
      if (c === '`') { template(); prev = '`'; continue; }
      if (c === '/' && regexMayStart()) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; j++; }
        const lit = src.slice(i, j + 1);
        put(lit, '/' + hollow(lit.slice(1, -1)) + '/');
        i = j + 1; prev = '/'; continue;
      }
      if (untilBrace) { if (c === '{') depth++; else if (c === '}') depth--; }
      put(c);
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  };
  const template = () => {
    put('`'); i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { put(src.slice(i, i + 2), hollow(src.slice(i, i + 2))); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { put('${'); i += 2; prev = '{'; code(true); put('}'); i++; continue; }
      put(src[i], src[i] === '\n' ? '\n' : ' '); i++;
    }
    put('`'); i++;
  };
  code(false);
  return { kept, blank };
}
const LEXED = new Map();
const lexOf = (f) => { if (!LEXED.has(f)) LEXED.set(f, lex(readFileSync(join(SCRIPTS, f), 'utf8'))); return LEXED.get(f); };
/**
 * The body of a named function in a lexed file — `function NAME(…) {…}` or
 * `NAME = (async) (…) => …` — as `{ kept, blank }` slices, or null. An arrow
 * with an expression body yields that expression.
 */
function bodyOf(lexed, name) {
  const { blank } = lexed;
  const decl = blank.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(`));
  if (!decl) return null;
  let k = decl.index + decl[0].length - 1;
  for (let depth = 0; k < blank.length; k++) {
    if (blank[k] === '(') depth++;
    else if (blank[k] === ')' && --depth === 0) break;
  }
  const lead = blank.slice(k + 1).match(/^\s*(=>)?\s*/);
  const at = k + 1 + lead[0].length;
  let end = -1;
  if (blank[at] === '{') {
    for (let depth = 0, j = at; j < blank.length; j++) {
      if (blank[j] === '{') depth++;
      else if (blank[j] === '}' && --depth === 0) { end = j + 1; break; }
    }
  } else {
    for (let depth = 0, j = at; j < blank.length; j++) {
      if ('([{'.includes(blank[j])) depth++;
      else if (')]}'.includes(blank[j])) { if (depth === 0) { end = j; break; } depth--; }
      else if (blank[j] === ';' && depth === 0) { end = j; break; }
    }
  }
  return end < 0 ? null : { kept: lexed.kept.slice(at, end), blank: blank.slice(at, end), at, end };
}
/** The function's OWN returns (over a blank body) — a nested function's return says nothing about the exit its caller sees. */
function ownReturns(body) {
  if (!body.startsWith('{')) return [body.trim()];
  const out = [];
  const stack = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') { stack.push(/(?:=>|\bfunction\b[^{;]*)\s*$/.test(body.slice(Math.max(0, i - 200), i))); continue; }
    if (body[i] === '}') { stack.pop(); continue; }
    if (stack.some(Boolean)) continue;
    if (stack.length && body.startsWith('return', i) && !/[A-Za-z0-9_$]/.test(body[i - 1] ?? ' ') && !/[A-Za-z0-9_$]/.test(body[i + 6] ?? ' ')) {
      const end = body.indexOf(';', i);
      out.push(body.slice(i + 'return'.length, end).trim());
      i = end;
    }
  }
  return out;
}
/** Every local function a set of roots reaches by call, with its body — the closure a structural rule must hold over, not only the root's own text. */
function reachable(lexed, roots) {
  const seen = new Map();
  const visit = (name) => {
    if (seen.has(name)) return;
    const b = bodyOf(lexed, name);
    if (!b) return;
    seen.set(name, b);
    for (const [, callee] of b.blank.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) visit(callee);
  };
  roots.forEach(visit);
  return seen;
}
const CG = 'census-grandfathered-custody.mjs';

/** Every function body in a lexed file with its name and parameter list, for resolving what reaches a call site. */
function functionsOf(lexed) {
  const out = [];
  for (const m of lexed.blank.matchAll(/(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g)) {
    const name = m[1] ?? m[2];
    const b = bodyOf({ blank: lexed.blank.slice(m.index), kept: lexed.kept.slice(m.index) }, name);
    if (!b) continue;
    const params = lexed.blank.slice(m.index + m[0].length).split(')')[0].split(',').map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean);
    out.push({ name, params, at: m.index + b.at, end: m.index + b.end, blank: b.blank });
  }
  return out;
}
/** The expression starting at `from`, up to the first top-level `,`, `;` or closing bracket. */
const exprAt = (lexed, from) => {
  for (let depth = 0, j = from; j < lexed.blank.length; j++) {
    if ('([{'.includes(lexed.blank[j])) depth++;
    else if (')]}'.includes(lexed.blank[j])) { if (depth === 0) return lexed.blank.slice(from, j).trim(); depth--; }
    else if ((lexed.blank[j] === ',' || lexed.blank[j] === ';') && depth === 0) return lexed.blank.slice(from, j).trim();
  }
  return '';
};

/**
 * The structural rules over the collector, each returning the problems it
 * finds (never asserting), so the same rule runs over the checkout AND over a
 * deliberately broken copy — a rule never seen to fail is not trusted.
 */
const STRUCTURE = {
  /** (a) one results.push, and it is publish(); every censusDeployment exit is publish( and reaches the judge. */
  onePublishedExit(cg) {
    const out = [];
    const pushes = [...cg.blank.matchAll(/\bresults\.push\(/g)];
    if (pushes.length !== 1) out.push(`${pushes.length} results.push( sites — a second one is a path that publishes a result the judge did not brand (S1-R1: the reuse loop's spread copy)`);
    const publish = bodyOf(cg, 'publish');
    if (!publish) out.push('publish — the census\'s one exit — is not defined in the collector');
    else if (!/\bisVerdict\(/.test(publish.blank) || !/\bthrow\b/.test(publish.blank)) out.push('publish does not refuse what isVerdict does not recognise');
    for (const p of pushes) if (!cg.blank.startsWith('results.push(publish(', p.index) && !(publish && publish.at <= p.index && p.index < publish.end)) out.push(`a push \`${cg.blank.slice(p.index, p.index + 50)}…\` is neither publish( nor inside publish`);
    const census = bodyOf(cg, 'censusDeployment');
    if (!census) return [...out, 'censusDeployment has been renamed — re-point this rule rather than deleting it'];
    const exits = ownReturns(census.blank).filter(Boolean);
    if (!exits.length) out.push('censusDeployment returns nothing');
    for (const r of exits) if (!r.startsWith('publish(')) out.push(`censusDeployment exits through \`${r.slice(0, 50)}…\`, not publish(`);
    if (![...reachable(cg, ['censusDeployment']).values()].some((b) => /\bverdictFromEvidence\(/.test(b.blank))) out.push('censusDeployment never reaches verdictFromEvidence');
    return out;
  },
  /** (b) nothing collectEvidence or collectProvenance reaches carries a classes map, a status or a verdict literal. */
  noVerdictWordInCollection(cg) {
    const out = [];
    const bodies = reachable(cg, ['collectEvidence', 'collectProvenance']);
    for (const root of ['collectEvidence', 'collectProvenance']) if (!bodies.has(root)) out.push(`${root} is not defined in the collector`);
    if (bodies.size <= 3) out.push(`the closure reached only ${bodies.size} function(s) — the reads are not where this looked`);
    for (const [name, b] of bodies) {
      // `classes: CLASSES` is the storage scan's class LIST (a reader argument);
      // any other classes key, assignment or property is a verdict container
      for (const re of [/\.classes\b/, /\bclasses\s*[:=](?!\s*CLASSES\b)/, /\bstatus\s*:/]) if (re.test(b.blank)) out.push(`${name}: ${re}`);
      if (/['"`](proven|indeterminate)['"`]/.test(b.kept)) out.push(`${name}: a verdict literal`);
    }
    return out;
  },
  /** (f) every ledger the collector hands verdictFromEvidence passed last through ONE deep freezer; returns it as `freezer`. */
  judgedThroughFreezer(cg) {
    const fns = functionsOf(cg);
    // a freezer is a function that calls Object.freeze and recurses into what it froze
    const isFreezer = (name) => { const b = bodyOf(cg, name); return Boolean(b) && /\bObject\.freeze\(/.test(b.blank) && new RegExp(`\\b${name}\\(`).test(b.blank); };
    const enclosing = (index) => fns.filter((f) => f.at <= index && index < f.end).sort((x, y) => (x.end - x.at) - (y.end - y.at))[0] ?? null;
    /** The freezer an expression's value passed through last, resolving calls, const bindings and pass-through parameters; null when none. */
    const freezerOf = (expr, at, depth = 0) => {
      const e = expr.replace(/^await\s+/, '').trim();
      if (depth > 6) return null;
      const call = e.match(/^([A-Za-z_$][\w$]*)\(/);
      if (call) {
        if (isFreezer(call[1])) return call[1];
        const b = bodyOf(cg, call[1]);
        const exits = b ? ownReturns(b.blank).filter(Boolean) : [];
        const via = exits.map((r) => freezerOf(r, cg.blank.indexOf(b.blank), depth + 1));
        return exits.length && via.every((x) => x && x === via[0]) ? via[0] : null;
      }
      const id = e.match(/^[A-Za-z_$][\w$]*$/)?.[0];
      const fn = id ? enclosing(at) : null;
      if (!fn) return null;
      const binding = [...fn.blank.slice(0, at - fn.at).matchAll(new RegExp(`\\bconst\\s+${id}\\s*=\\s*`, 'g'))].pop();
      if (binding) return freezerOf(exprAt(cg, fn.at + binding.index + binding[0].length), fn.at + binding.index, depth + 1);
      // a parameter passed straight through: what every caller hands in
      const k = fn.params.indexOf(id);
      if (k < 0) return null;
      const callers = [...cg.blank.matchAll(new RegExp(`\\b${fn.name}\\(`, 'g'))].filter((m) => !(m.index >= fn.at - fn.name.length - 40 && m.index < fn.at));
      const via = callers.map((m) => {
        let from = m.index + m[0].length;
        for (let skip = 0; skip < k; skip++) from += exprAt(cg, from).length + 1;
        return freezerOf(exprAt(cg, from), m.index, depth + 1);
      });
      return callers.length && via.every((x) => x && x === via[0]) ? via[0] : null;
    };
    const sites = [...cg.blank.matchAll(/\bverdictFromEvidence\(/g)];
    const out = sites.length ? [] : ['the collector never calls the judge'];
    const freezers = new Set();
    for (const m of sites) {
      const arg = exprAt(cg, m.index + m[0].length);
      const f = freezerOf(arg, m.index);
      if (f) freezers.add(f);
      else out.push(`verdictFromEvidence(${arg.slice(0, 50)}…) judges a ledger no deep freezer produced`);
    }
    if (freezers.size > 1) out.push(`the judge's inputs pass through ${freezers.size} different freezers (${[...freezers].join(', ')}) — one rule, one implementation`);
    return Object.assign(out, { freezer: [...freezers][0] ?? null });
  },
  /** (h) every committed-artifact reader reaches the ONE throw for a schema-2 result without flat identity. */
  readersRefuseNestedIdentity(cg) {
    const out = [];
    const throwers = new Set();
    for (const reader of ['loadTargetSnapshot', 'loadPriorCommittedHeights', 'snapshotRegression']) {
      const bodies = reachable(cg, [reader]);
      if (!bodies.has(reader)) { out.push(`${reader} renamed — re-point this rule`); continue; }
      const t = [...bodies].filter(([, b]) => /\bschema\b[^;{]*>=\s*2/.test(b.blank) && /\bthrow\b/.test(b.blank)).map(([n]) => n);
      if (!t.length) out.push(`${reader} reaches no throw for a schema-2 result lacking chainSlug/atBlock — it would skip it`);
      t.forEach((n) => throwers.add(n));
    }
    // one shared thrower: snapshotRegression's BEHAVIOUR (below) then proves all three
    if (throwers.size > 1) out.push(`the readers refuse through ${throwers.size} different functions (${[...throwers].join(', ')}) — one rule, one implementation`);
    return out;
  },
  /**
   * C6 — the custody getters are asked over the STORAGE range, and each one's
   * coverage is recorded from the ids IT answered: the one loop that calls them
   * iterates `rangeIds` (never assigned from a routed figure), each getter
   * appends an id to its own answered list only after its read returned, and
   * `idsAskedOfGetter` is written at one site, from those lists. A loop over
   * the routed enumeration, or a record written from the range rather than the
   * answers, would discharge getter-coverage with a copy of the range.
   */
  getterCoverageFromTheLoop(cg) {
    const out = [];
    const host = bodyOf(cg, 'readDiamond');
    if (!host) return ['readDiamond renamed — re-point this rule'];
    const GETTERS = ['getBorrowerLifRebate', 'getFallbackSnapshot', 'getIntentCommit'];
    const loops = [...host.blank.matchAll(/\bfor\s*\(\s*const\s+(\w+)\s+of\s+([^{]+?)\)\s*\{/g)]
      .map((m) => {
        const open = m.index + m[0].length - 1;
        let end = open;
        for (let depth = 0; end < host.blank.length; end++) {
          if (host.blank[end] === '{') depth++;
          else if (host.blank[end] === '}' && --depth === 0) break;
        }
        return { id: m[1], over: m[2].trim(), text: cg.kept.slice(host.at + open, host.at + end + 1) };
      })
      .filter((l) => GETTERS.some((g) => l.text.includes(`read('${g}'`)));
    if (loops.length !== 1) return [`${loops.length} loop(s) in readDiamond ask the custody getters — the rule expects exactly one`];
    const [loop] = loops;
    if (loop.over !== 'rangeIds') out.push(`the custody getters are asked over \`${loop.over}\`, not the storage range \`rangeIds\` (C6)`);
    for (const m of host.blank.matchAll(/\brangeIds\s*=(?!=)/g)) {
      const rhs = exprAt(cg, host.at + m.index + m[0].length);
      if (/\b(loanIds|enumeratedIds|routed)\b/.test(rhs)) out.push(`rangeIds is assigned from \`${rhs.slice(0, 60)}\`, a routed figure — the range is storage's nextLoanId`);
    }
    for (const g of GETTERS) {
      const call = loop.text.indexOf(`read('${g}'`);
      const answered = loop.text.indexOf(`askedOf.${g}.push(${loop.id})`);
      if (call < 0) out.push(`the loop never asks ${g}`);
      else if (answered < 0) out.push(`the ids ${g} answered are not recorded in the loop`);
      else if (answered < call) out.push(`an id is recorded as answered by ${g} before ${g} is read`);
    }
    const writes = [...cg.blank.matchAll(/\bidsAskedOfGetter\b\s*(?:\[[^\]]*\])?\s*=(?!=)|Object\.assign\(\s*[\w.]*idsAskedOfGetter\b/g)];
    if (writes.length !== 1) out.push(`idsAskedOfGetter is written at ${writes.length} site(s) — one, from the answered lists`);
    for (const w of writes) {
      const rhs = exprAt(cg, w.index + w[0].length);
      if (!/\baskedOf\[/.test(rhs) || /\brangeIds\b/.test(rhs)) out.push(`idsAskedOfGetter is written from \`${rhs.slice(0, 60)}\`, not from the ids each getter answered`);
    }
    return out;
  },
  /** §3.3 — every failure row the census records keeps the ledger the collector attached to the error: what WAS read is the evidence of how far it got. */
  failureRowsKeepPartialLedger(cg) {
    const sites = [...cg.blank.matchAll(/\bfailures\.push\(/g)];
    if (!sites.length) return ['the census records no failure row — re-point this rule'];
    return sites
      .map((m) => exprAt(cg, m.index + m[0].length))
      .filter((row) => !/\bpartialLedger\s*:\s*err\.partialLedger\b/.test(row))
      .map((row) => `a failure row \`${row.replace(/\s+/g, ' ').slice(0, 60)}…\` drops the partial ledger the collector attached to the error`);
  },
};

test('T-C (a) — the census publishes through ONE push, and that push is publish(); censusDeployment\'s every exit is publish( over the judge', () => {
  assert.deepEqual(STRUCTURE.onePublishedExit(lexOf(CG)), []);
});

test('T-C — the custody getters are asked over the storage range, and idsAskedOfGetter is built from the ids each getter actually answered (C6)', () => {
  assert.deepEqual(STRUCTURE.getterCoverageFromTheLoop(lexOf(CG)), []);
});

test('T-C (b) — the collector writes no verdict word: nothing collectEvidence or collectProvenance reaches carries a classes map, a status or a verdict literal', () => {
  assert.deepEqual(STRUCTURE.noVerdictWordInCollection(lexOf(CG)), []);
});

const VOCAB = /status:\s*'(proven|indeterminate)'|'(proven|indeterminate)'|provenBy|evidence:\s*\[|vpfiRowsTotal:|backingShortfall:/;
const vocabularyHits = (name, lexed) => lexed.kept.split('\n').flatMap((line, i) => (VOCAB.test(line) ? [`${name}:${i + 1}: ${line.trim().slice(0, 100)}`] : []));

test('T-C (c) — no script but the judge spells a verdict, a proof label, an evidence chain or a liability aggregate (C1); the judge reads none off its input (C2)', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'census-verdict.mjs');
  assert.ok(files.includes(CG) && files.includes('census-storage-read.mjs'), 'the grep reaches the collector and the storage helpers');
  assert.deepEqual(files.flatMap((f) => vocabularyHits(f, lexOf(f))), []);
  const judgeSrc = lexOf('census-verdict.mjs');
  assert.ok(vocabularyHits('census-verdict.mjs', judgeSrc).length > 0, 'the judge spells the vocabulary — the grep finds it where it is (it is not vacuous)');
  assert.ok(!/\bprovenBy\b/.test(judgeSrc.kept), 'the judge spells provenBy');
  assert.ok(!/\b(ledger|L)\??\.(classes|status|provenBy)\b/.test(judgeSrc.blank), 'the judge reads a verdict field off its ledger');
});

test('T-C (d)(e)(g) — the judge exports exactly four names; a copy of a verdict is not a verdict; identity is flat', () => {
  assert.deepEqual(Object.keys(VERDICT).sort(), ['OBLIGATIONS', 'isVerdict', 'reportVerdict', 'verdictFromEvidence']);
  const { ledger } = ledgerOf();
  const v = judge(ledger);
  assert.equal(isVerdict(v), true);
  for (const [what, copy] of [['a spread copy', { ...v }], ['a structured clone', structuredClone(v)], ['a JSON round trip', toJson(v)], ['Object.assign', Object.assign({}, v)]]) {
    assert.equal(isVerdict(copy), false, `${what} of a verdict passes the brand — the reuse loop's spread (S1-R1) would publish`);
  }
  assert.equal(isVerdict(null), false);
  assert.equal(isVerdict({ schema: 2, classes: {} }), false);
  for (const k of IDENTITY_KEYS) assert.deepEqual(v[k], ledger.identity[k], `identity key ${k} is flat on the verdict (C7) — every committed-artifact reader reads it there`);
  assert.equal(v.identity, undefined, 'identity is spread, not nested');
  assert.equal(v.schema, 2);
  assert.equal(v.proofStandard, 'provenance');
  assert.equal(v.eraTableIdentity, 'fixture-era-table-1', 'the verdict stamps the table it judged with');
  assert.equal(v.verdictRule?.module, 'census-verdict.mjs');
  assert.match(String(v.verdictRule?.sha256), /^[0-9a-f]{64}$/);
});

test('T-C (f) — observe after the freeze throws; the freeze is deep; every ledger the judge receives in the collector passed through it', () => {
  const found = STRUCTURE.judgedThroughFreezer(lexOf(CG));
  assert.deepEqual([...found], []);
  const freeze = COLLECTOR[found.freezer];
  assert.equal(typeof freeze, 'function', `${found.freezer} — the freezer the collector judges through — is exported so this cell can run it`);
  const { ledger } = ledgerOf();
  const extra = storageObs('vpfiHeldCustody', '5', 'head', 1n);
  const open = structuredClone(ledger);
  observe(open, extra);
  assert.equal(open.observations.length, ledger.observations.length + 1, 'observe records a read while the ledger is open');
  const frozen = freeze(structuredClone(ledger));
  assert.throws(() => observe(frozen, extra), TypeError, 'a read recorded after the freeze would be published beside figures it never fed');
  assert.throws(() => { frozen.range.storage.counters.totalLoansEverCreated[0].value = 9n; }, TypeError, 'the freeze reaches every level');
  assert.throws(() => { frozen.provenance.facets[0].codeHash = '0x00'; }, TypeError);
  // the judge accepts a frozen ledger (it never writes its input) and hands the same evidence back
  const v = judge(frozen);
  assert.throws(() => v.ledger.observations.push(extra), TypeError);
  assert.equal(Object.isFrozen(v.classes.vpfiHeldCustody.rows), true, 'the published figures are frozen too');
});

test('T-C (h) — a schema-2 result without its identity is an error in every committed-artifact reader, never a skipped row (S3-1)', () => {
  const ok = { chainSlug: 'x', deployment: 'live', atBlock: '100', atBlockHash: H(1), diamond: '0xd1', vpfiToken: '0xt1' };
  const run = (current) => snapshotRegression({ current, results: [ok], ancestry: new Map(), acknowledged: new Set(), now: 't' });
  assert.throws(() => run({ results: [{ ...ok, schema: 2, chainSlug: undefined }] }), /chainSlug/, 'a nested identity read as no row would let a regression pass');
  assert.throws(() => run({ results: [{ ...ok, schema: 2, atBlock: undefined }] }), /atBlock/);
  assert.doesNotThrow(() => run({ results: [{ deployment: 'live' }] }), 'a pre-schema-2 row without identity is still tolerated');
  // the two file readers are not exported: they must reach the SAME throw, whose behaviour the calls above prove
  assert.deepEqual(STRUCTURE.readersRefuseNestedIdentity(lexOf(CG)), []);
});

test('T-C — every structural rule FAILS on a collector broken the way it forbids (in memory; the rules are not vacuous)', () => {
  const src = readFileSync(join(SCRIPTS, CG), 'utf8');
  const cg = lexOf(CG);
  const at = (name) => { const b = bodyOf(cg, name); assert.ok(b, `${name} — a defect below needs it; re-point the defect`); return b; };
  const splice = (i, j, text) => src.slice(0, i) + text + src.slice(j);
  /** The source with one exact passage replaced — the passage must occur once, or the defect breaks nothing it names. */
  const swap = (old, neu) => { assert.equal(src.split(old).length, 2, `\`${old.slice(0, 60)}…\` is not in the collector exactly once — re-point the defect`); return src.replace(old, neu); };
  const inBody = (name, needle) => { const b = at(name); const k = b.blank.indexOf(needle); assert.ok(k >= 0, `${name} has no \`${needle}\` — re-point the defect`); return b.at + k; };
  const freezer = STRUCTURE.judgedThroughFreezer(cg).freezer;
  const thrower = [...reachable(cg, ['snapshotRegression'])].find(([, b]) => /\bschema\b[^;{]*>=\s*2/.test(b.blank) && /\bthrow\b/.test(b.blank))?.[0];
  assert.ok(freezer && thrower, 'the checkout has a freezer and an identity thrower to break');
  const defects = {
    'a second, unbranded push': ['onePublishedExit', () => { const p = cg.blank.search(/\bresults\.push\(/); return splice(p, p, 'results.push({ ...{} });'); }],
    'an exit that skips publish': ['onePublishedExit', () => { const k = inBody('censusDeployment', 'publish('); return splice(k, k + 'publish'.length, ''); }],
    'a status written while collecting': ['noVerdictWordInCollection', () => { const b = at('collectEvidence'); return splice(b.at + 1, b.at + 1, " Object.assign({}, { status: 'proven' });"); }],
    'a classes map written while collecting': ['noVerdictWordInCollection', () => { const b = at('collectProvenance'); return splice(b.at + 1, b.at + 1, ' const classes = {};'); }],
    'a freezer that no longer freezes': ['judgedThroughFreezer', () => { const k = inBody(freezer, 'Object.freeze('); return splice(k, k + 'Object.freeze'.length, 'Object.isFrozen'); }],
    'a freezer that no longer recurses': ['judgedThroughFreezer', () => { const k = inBody(freezer, `${freezer}(`); return splice(k, k + freezer.length, 'void'); }],
    'a reader that skips the identity check': ['readersRefuseNestedIdentity', () => { const k = inBody('loadTargetSnapshot', `${thrower}(`); return splice(k, k + thrower.length, 'Boolean'); }],
    'a failure row without its partial ledger': ['failureRowsKeepPartialLedger', () => { const k = inBody('main', 'partialLedger: err.partialLedger'); return splice(k, k + 'partialLedger: err.partialLedger'.length, 'partialLedger: null'); }],
    'the getters looped over the routed enumeration': ['getterCoverageFromTheLoop', () => swap('for (const id of rangeIds) {', 'for (const id of enumeratedIds) {')],
    'the range taken from the routed enumeration': ['getterCoverageFromTheLoop', () => swap('rangeIds = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));', 'rangeIds = ledger.range.routed?.enumeratedIds ?? [];')],
    'coverage written from the range, not the answers': ['getterCoverageFromTheLoop', () => swap("askedOf[getter].length ? idRangeOf(askedOf[getter]) : ''", 'idRangeOf(rangeIds)')],
    'an id recorded as answered before the getter is read': ['getterCoverageFromTheLoop', () => swap("const [rebateAmount, vpfiHeld] = await read('getBorrowerLifRebate', [id]);\n      askedOf.getBorrowerLifRebate.push(id);", "askedOf.getBorrowerLifRebate.push(id);\n      const [rebateAmount, vpfiHeld] = await read('getBorrowerLifRebate', [id]);")],
    'a getter whose answers are never recorded': ['getterCoverageFromTheLoop', () => swap('askedOf.getFallbackSnapshot.push(id);', '')],
  };
  for (const [what, [rule, make]] of Object.entries(defects)) {
    assert.ok([...STRUCTURE[rule](cg)].length === 0, `${rule} already fails on the checkout`);
    assert.ok([...STRUCTURE[rule](lex(make()))].length > 0, `${rule} passes a collector with ${what}`);
  }
  assert.ok(vocabularyHits(CG, lex(`${src}\nconst leaked = { status: 'proven' };\n`)).length > 0, 'the vocabulary grep sees a verdict literal added to the collector');
});

// ── T-E — the artifact re-derives from its own ledger ───────────────────────
const ARTIFACT = join(REPO, 'docs', 'DesignsAndPlans', 'census', 'grandfathered-custody-census.json');
// Run 31's artifact predates the evidence ledger: it is the ONE ledger-less
// artifact allowed, by its exact generatedAt, until run 46 republishes it with
// ledgers — delete the skip then. Any other ledger-less artifact fails.
const RUN31_GENERATED_AT = '2026-09-11T09:05:43.945Z';
/** The checkout's own era table, prepared once — what the committed artifact is checked against and what the collector judges with. */
let CHECKOUT_READ = null;
const checkoutStorageRead = () => (CHECKOUT_READ ??= prepareStorageRead({ slots: loadSlots(), eras: loadEras() }));

/** A committed ledger re-judged as `--rejudge` re-judges it — through the collector's one preparation (`reviveLedger`): decimal strings where the run held bigints, which the judge reads identically, in a private deep-frozen copy. */
const rejudged = (r, proofStandard, storageRead) => verdictFromEvidence(COLLECTOR.reviveLedger(r.ledger), { proofStandard, storageRead });

/** Every way a published result can disagree with what its own ledger derives to, each naming the deployment (and class). */
function artifactProblems(r, { proofStandard, storageRead }) {
  const name = `${r?.chainSlug ?? r?.ledger?.identity?.chainSlug ?? '?'}/${r?.deployment ?? r?.ledger?.identity?.deployment ?? '?'}`;
  const out = [];
  if (!(Number(r?.schema) >= 2)) out.push(`${name}: schema ${r?.schema} — not a schema-2 result`);
  if (!r?.ledger) return [...out, `${name}: carries no ledger — its figures cannot be re-derived`];
  let again;
  try { again = rejudged(r, proofStandard, storageRead); } catch (err) { return [...out, `${name}: the judge threw on the recorded ledger (${err.message})`]; }
  // the rule's digest is provenance (a comment edit changes it); the table's
  // identity is not — a drift there means the figures were judged with another table
  if (again.eraTableIdentity !== r.eraTableIdentity) out.push(`${name}: judged with era table ${r.eraTableIdentity}, the checkout's is ${again.eraTableIdentity} — re-judge (--rejudge) or re-run`);
  const a = toJson(stripLedger(again));
  const b = toJson(stripLedger(r));
  for (const C of CLASSES) {
    if (!isDeepStrictEqual(a.classes?.[C], b.classes?.[C])) out.push(`${name}/${C}: published ${b.classes?.[C]?.status}/${b.classes?.[C]?.count}, its ledger derives ${a.classes?.[C]?.status}/${a.classes?.[C]?.count}`);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== 'classes' && !isDeepStrictEqual(a[k], b[k])) out.push(`${name}: ${k} differs from its ledger's derivation`);
  for (const x of invariantViolations(r, r.ledger, { standard: proofStandard, storageRead })) out.push(`${name}: ${x}`);
  return out;
}

/** The cron-slot gate's own cap (`MAX_SCAN_BYTES`, .github/scripts/check-cron-slots.mjs) — read from the gate, so the collector's refusal and this test cannot drift from what CI enforces. */
function cronScanCap() {
  const src = readFileSync(join(REPO, '.github', 'scripts', 'check-cron-slots.mjs'), 'utf8');
  const m = src.match(/\bconst MAX_SCAN_BYTES = ([\d\s*]+);/);
  assert.ok(m, 'the cron-slot gate no longer declares MAX_SCAN_BYTES as a product of integers — re-point this reader');
  return m[1].split('*').reduce((a, x) => a * Number(x.trim()), 1);
}

test('T-E — the committed artifact: every result re-derives from its own ledger with the checkout\'s judge and table; it and its ledger sidecar stay under the cron-slot scan cap', (t) => {
  assert.equal(COLLECTOR.MAX_ARTIFACT_BYTES, cronScanCap(), 'the collector refuses publication against a different cap than the gate enforces');
  const SIDECAR = ARTIFACT.replace(/\.json$/, '.ledgers.json');
  for (const f of [ARTIFACT, SIDECAR].filter((p) => existsSync(p))) assert.ok(statSync(f).size <= COLLECTOR.MAX_ARTIFACT_BYTES, `${f}: ${statSync(f).size} bytes — above MAX_SCAN_BYTES, so the cron-slot gate fails on it`);
  // the ONE reader of the published pair: each ledger joined back from the sidecar by its content address
  const report = COLLECTOR.loadCensusArtifact(ARTIFACT);
  const ledgerless = (report.results ?? []).filter((r) => !r.ledger);
  if (ledgerless.length) {
    if (report.generatedAt === RUN31_GENERATED_AT) { t.skip(`run 31's artifact (generatedAt ${RUN31_GENERATED_AT}) predates the evidence ledger; run 46 republishes it with ledgers — delete this skip then`); return; }
    assert.fail(`${ledgerless.length} result(s) carry no ledger in an artifact generated ${report.generatedAt} — only run 31's may (its figures cannot be re-derived)`);
  }
  assert.ok(Number(report.schema) >= 2, `artifact schema ${report.schema}`);
  const storageRead = checkoutStorageRead();
  assert.ok(storageRead.ok, storageRead.reason);
  const problems = report.results.flatMap((r) => artifactProblems(r, { proofStandard: report.proofStandard, storageRead }));
  assert.deepEqual(problems, []);
  // the report's own claims, from the re-derived (branded) verdicts
  const again = reportVerdict(report.results.map((r) => rejudged(r, report.proofStandard, storageRead)), { allDeployed: report.deploymentsDeployed, failures: report.chainsFailed, proofStandard: report.proofStandard });
  for (const k of ['allClassesEmpty', 'scope', 'migrationRetirable', 'migrationRetirableReason']) assert.deepEqual(toJson(again[k] ?? null), toJson(report[k] ?? null), `report ${k}`);
});

/**
 * Run 31's committed population, per deployment: the facets its provenance
 * read, how many no era built, how many the cut history, the loupe and the
 * records named, its cut blocks and its loans — measured from the committed
 * artifact (2,330 facets over 20 results; no class held a row). The size cell
 * below publishes a census of this shape through the real report builder and
 * the real writer, so the cap is checked on a census of the scale run 46 will
 * write, before that archive-RPC run rather than after it.
 */
const RUN31_POPULATION = [
  // [chainSlug, deployment, facets, unattributed, cutHistory, loupe, recorded, cutBlocks, loans]
  ['arb-sepolia', 'live', 531, 254, 530, 75, 70, 72, 13],
  ['arb-sepolia', 'archived 2026-05-10T02-37-43Z', 33, 0, 32, 32, 33, 4, 24],
  ['arb-sepolia', 'archived 2026-07-01T01-28-35Z', 34, 0, 33, 33, 34, 3, 37],
  ['arb-sepolia', 'archived 2026-07-01T01-36-25Z', 531, 254, 530, 75, 70, 72, 13],
  ['base-sepolia', 'live', 608, 254, 607, 84, 78, 85, 21],
  ['base-sepolia', 'archived 2026-05-10T01-28-54Z', 34, 0, 0, 33, 34, 0, 0],
  ['base-sepolia', 'archived 2026-05-11T02-10-48Z', 34, 0, 33, 33, 34, 3, 0],
  ['base-sepolia', 'archived 2026-06-30T23-56-49Z', 34, 0, 0, 33, 34, 0, 33],
  ['base-sepolia', 'archived 2026-07-01T00-15-58Z', 50, 50, 0, 0, 50, 1, 0],
  ['base-sepolia', 'archived 2026-07-01T00-27-51Z', 50, 50, 0, 0, 50, 1, 0],
  ['base-sepolia', 'archived 2026-07-01T00-39-00Z', 50, 50, 0, 0, 50, 1, 0],
  ['base-sepolia', 'archived 2026-07-01T00-54-13Z', 62, 62, 0, 61, 50, 0, 0],
  ['base-sepolia', 'archived 2026-07-01T01-03-39Z', 0, 0, 0, 0, 0, 0, 0],
  ['bnb-testnet', 'live', 75, 1, 0, 74, 70, 0, 4],
  ['bnb-testnet', 'archived 2026-07-01T01-54-09Z', 31, 27, 0, 30, 31, 0, 0],
  ['op-sepolia', 'live', 33, 0, 0, 32, 33, 0, 33],
  ['op-sepolia', 'archived prior-rehearsal-1778076638', 33, 0, 0, 32, 33, 0, 13],
  ['sepolia', 'live', 34, 0, 33, 33, 34, 3, 0],
  ['sepolia', 'archived 2026-05-10T13-02-26Z', 39, 0, 0, 35, 33, 0, 24],
  ['sepolia', 'archived 2026-05-11T04-15-49Z', 34, 0, 0, 33, 34, 0, 0],
];

/** A ledger of one RUN31_POPULATION row, shaped as the collector writes it, judged with the checkout's table. */
function populationLedger([slug, label, nFacets, nUnattributed, nCut, nLoupe, nRecorded, nBlocks, loans], i, table) {
  const catalogue = [...new Set(table.eras.flatMap((e) => Object.keys(e.bytecode ?? {})))];
  const address = (k) => ADDR(0x1_0000_0000n * BigInt(i + 1) + BigInt(k));
  const facets = Array.from({ length: nFacets }, (_, k) => ({
    address: address(k),
    // the unattributed ones carry code no era built; the rest a catalogued build's
    codeHash: k < nUnattributed ? H(0xdead_0000_0000n * BigInt(i + 1) + BigInt(k)) : catalogue[k % catalogue.length],
    sources: [...(k < nRecorded ? [`record:${label}`] : []), ...(k < nLoupe ? ['loupe'] : []), ...(k < nCut ? ['cut-history'] : [])],
  }));
  const blocks = Array.from({ length: nBlocks }, (_, j) => String(9_000_000 + j * 977));
  const cutAddresses = facets.filter((f) => f.sources.includes('cut-history')).map((f) => f.address);
  const blocksOf = Object.fromEntries(cutAddresses.map((a, k) => [a, [blocks[k % blocks.length]]]));
  const loupe = facets.filter((f) => f.sources.includes('loupe')).map((f) => f.address);
  const recorded = facets.filter((f) => f.sources.includes(`record:${label}`)).map((f) => f.address);
  const record = { slug, label, addresses: { diamond: ADDR(0xd1a0000n + BigInt(i)), chainId: 84532, deployBlock: 1_000_000 + i, vpfiToken: VPFI, deployedAt: '2026-07-01T00:00:00Z', facets: Object.fromEntries(recorded.map((a, k) => [`Facet${k}`, a])) } };
  const routed = loupe.length > 0;
  const asked = routed && loans ? `1..${loans}` : '';
  return {
    schema: 2,
    identity: { chainSlug: slug, deployment: label, chainId: 84532, diamond: record.addresses.diamond, atBlock: '31000000', atBlockHash: H(0xb10c000n + BigInt(i)), blockTag: 'finalized', rpcHost: `${slug}.rpc.example.invalid`, sourceRecord: { recorded: true, commit: 'c'.repeat(40), dirty: false, deployedAt: '2026-07-01T00:00:00Z' }, inventoryKey: COLLECTOR.inventoryKeyOf(record) },
    flags: { codeAbsent: false, codeAbsentReason: null, notADiamond: false, loupeRouted: routed, custodySurfaceUnrouted: !routed },
    scope: routed ? { vpfiToken: VPFI, source: 'on-chain' } : { vpfiToken: VPFI, source: 'artifact' },
    backing: { token: VPFI, balance: 0n },
    range: {
      storage: {
        nextLoanId: BigInt(loans),
        truncatedAt: null,
        counters: Object.fromEntries(['totalLoansEverCreated', 'intentLiveCommitCount'].map((f) => [f, table.eraSlots[f].map(({ slot }) => ({ slot, value: f === 'totalLoansEverCreated' && slot === table.headSlots[f] ? BigInt(loans) : 0n }))])),
        read: { ...structuredClone(table.evidence), slotsRead: 1 + loans * 21, loansScanned: loans, slotsScanned: Object.fromEntries(Object.entries(table.eraSlots).map(([f, list]) => [f, list.map((x) => x.slot)])) },
      },
      storageUnavailable: null,
      routed: routed ? { totalLoansEverCreated: BigInt(loans), enumeratedIds: loans ? `1..${loans}` : [], reportedTotal: BigInt(loans) } : null,
    },
    surfaces: Object.fromEntries(['getProtocolStats', 'getAllLoansPaginated', 'getBorrowerLifRebate', 'getFallbackSnapshot', 'getLoanDetails', 'getIntentCommit', 'getVPFIToken', 'commitSwapToRepayIntent', 'facets', 'facetAddress', 'facetAddresses'].map((s) => [s, routed ? 'routed' : 'unrouted'])),
    hostOf: Object.fromEntries(Object.values(SELECTOR).map((s) => [s, loupe[0] ?? null])),
    idsAskedOfGetter: routed ? { getBorrowerLifRebate: asked, getFallbackSnapshot: asked, getIntentCommit: asked } : {},
    observations: [],
    corroboration: null,
    cutHistory: {
      verdict: nBlocks ? 'read' : 'unreadable (fixture: no cut history at this scale)', cuts: nBlocks, constructorCutSeen: nBlocks > 0, constructorCutEvidence: nBlocks ? `the constructor's empty DiamondCut at block ${blocks[0]}` : null,
      addresses: cutAddresses, initializers: [], blocksOf, blockTimestamps: Object.fromEntries(blocks.map((b, j) => [b, { iso: new Date(Date.UTC(2026, 6, 1) + j * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'), estimated: false }])), unreadableBlocks: [],
    },
    provenance: { read: true, facets, loupe: routed ? loupe : null, loupeReadFailed: false, cutFacetHost: loupe[0] ?? null, recorded: { records: [`record:${label}`], facets: recorded, deployedAt: [{ record: `record:${label}`, iso: '2026-07-01T00:00:00Z' }] } },
  };
}

test('T-E — a census at run 31\'s committed scale (2,330 facets over 20 deployments), built by the real report builder and written by the real writer, stays under the cron-slot cap in both files and reads back whole', (t) => {
  const table = checkoutStorageRead();
  assert.ok(table.ok, table.reason);
  assert.equal(RUN31_POPULATION.reduce((a, r) => a + r[2], 0), 2330, 'the population table is run 31\'s');
  const results = RUN31_POPULATION.map((row, i) => verdictFromEvidence(COLLECTOR.deepFreeze(populationLedger(row, i, table)), { proofStandard: 'provenance', storageRead: table }));
  assert.equal(results.reduce((a, v) => a + v.scanned.provenance.facetsChecked, 0), 2330, 'the judge checked every facet of the population');
  assert.ok(results.some((v) => v.scanned.provenance.unattributed.length === 254), 'the unattributed lists the verdict publishes are at their committed length');
  const allDeployed = RUN31_POPULATION.map(([s, l]) => `${s}|${l}`);
  const { fileName, report } = COLLECTOR.censusReport({ results, failures: [], allDeployed, proofStandard: 'provenance', eraTableIdentity: table.evidence.eraTableIdentity });
  assert.equal(fileName, 'grandfathered-custody-census.json', 'a census of every deployment is the canonical artifact');
  const dir = mkdtempSync(join(tmpdir(), 'census-scale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, fileName);
  const texts = COLLECTOR.artifactTexts(report, outFile);
  const sizes = Object.fromEntries(Object.entries(texts).map(([p, text]) => [basename(p), Buffer.byteLength(text)]));
  t.diagnostic(`committed-scale sizes: ${JSON.stringify(sizes)} (cap ${COLLECTOR.MAX_ARTIFACT_BYTES})`);
  assert.equal(Object.keys(sizes).length, 2, 'the writer produces the artifact and its ledger sidecar');
  for (const [f, n] of Object.entries(sizes)) assert.ok(n <= COLLECTOR.MAX_ARTIFACT_BYTES, `${f} would be ${n} bytes at the committed scale — above the ${COLLECTOR.MAX_ARTIFACT_BYTES}-byte cap the cron-slot gate reads`);
  for (const [p, text] of Object.entries(texts)) writeFileSync(p, text);
  const read = COLLECTOR.loadCensusArtifact(outFile);
  assert.deepEqual(read.results.map((r) => r.ledger), toJson(results.map((v) => v.ledger)), 'a ledger did not come back from the sidecar as written');
});

test('T-E — the self-verification catches every published edit: a flipped status, an edited count, a deleted observation, a nested identity, a dropped schema', () => {
  const fixtures = [ledgerOf().ledger, (() => { const { ledger } = ledgerOf(); BREAKERS['asset-settled'][0].apply(ledger); ledger.identity.deployment = 'archived 2026-07-01'; return ledger; })()];
  // published as the artifact writer writes it: bigints as decimal strings
  const published = fixtures.map((L) => toJson(judge(L)));
  for (const r of published) assert.deepEqual(artifactProblems(r, { proofStandard: 'provenance', storageRead: STORAGE_READ }), [], 'an untouched result re-derives exactly from its serialised ledger (the checker is not vacuous the other way)');
  const mutations = {
    'a flipped status': (r) => { r.classes.rebateRows.status = r.classes.rebateRows.status === 'proven' ? 'indeterminate' : 'proven'; return /rebateRows/; },
    'an edited count': (r) => { r.classes.vpfiHeldCustody.count += 1; return /vpfiHeldCustody/; },
    'a deleted observation': (r) => { r.ledger.observations.splice(r.ledger.observations.findIndex((o) => o.class === 'liveIntentCommits' && o.source === 'routed-getter'), 1); return /liveIntentCommits/; },
    'a nested identity': (r) => { r.identity = {}; for (const k of IDENTITY_KEYS) { r.identity[k] = r[k]; delete r[k]; } return /identity|chainSlug/; },
    'a dropped schema': (r) => { delete r.schema; return /schema/; },
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    for (const base of published) {
      const r = structuredClone(base);
      const names = mutate(r);
      const problems = artifactProblems(r, { proofStandard: 'provenance', storageRead: STORAGE_READ });
      assert.ok(problems.length > 0, `${what} on ${base.deployment} passed the self-verification`);
      assert.ok(problems.some((p) => p.startsWith(`fixture-chain/${base.deployment}`) && names.test(p)), `${what}: ${problems.join(' | ')}`);
    }
  }
});

// ── T-G — a shell is an enumerable Diamond whose routed surfaces are unrouted ─
test('T-G — removing every routed observation keeps every row in evidence and never proves a class; with every surface unrouted too, the result is the bare shell\'s', () => {
  const failures = [];
  const keyset = (v) => [...new Set(CLASSES.flatMap((C) => [...v.classes[C].rows, ...v.classes[C].unknownAssetRows, ...v.classes[C].nonVpfiRowsExcluded].map((r) => `${C}|${r.loanId}`)))].sort();
  let compared = 0;
  for (const [i, { spec, ledger, gen, standard }] of family().entries()) {
    if (i % 3 || !ledger.range.storage || !gen.completeStorage) continue;
    if (ledger.observations.some((o) => o.source === 'routed-getter')) compared += 1;
    const before = judge(ledger, standard);
    const L = structuredClone(ledger);
    L.observations = L.observations.filter((o) => o.source !== 'routed-getter');
    const after = judge(L, standard);
    if (!isDeepStrictEqual(keyset(after), keyset(before))) failures.push(`${describe(spec)}: the rows in evidence changed`);
    for (const C of CLASSES) {
      // A getter row that disagrees with HEAD storage REFUTES the HEAD-layout
      // claim (the judge's header; I9 above), and a refuting read only ever
      // withdraws — what it held back (the agreement, and under the routed
      // standard the waiver that needs it) may come back once it is removed.
      // Every class whose routed reads did not disagree is held to the rule.
      const refuted = before.classes[C].flags.getterDisagreement === true;
      if (before.classes[C].status !== 'proven' && after.classes[C].status === 'proven' && !refuted) failures.push(`${describe(spec)}: ${C} proven once its routed observations were removed`);
      const counted = new Set(before.classes[C].rows.map((r) => String(r.loanId)));
      if (after.classes[C].rows.some((r) => !counted.has(String(r.loanId)))) failures.push(`${describe(spec)}: ${C} counts a row it did not count with the routed reads`);
    }
    // every surface unrouted as well: the same storage, as a getter-less shell's collector records it
    for (const k of Object.keys(L.surfaces)) if (!['facets', 'facetAddress', 'facetAddresses'].includes(k)) L.surfaces[k] = 'unrouted';
    L.range.routed = null;
    for (const g of Object.keys(L.idsAskedOfGetter)) L.idsAskedOfGetter[g] = '';
    if (L.provenance.read) for (const role of ['fallback', 'loan', 'token', 'intent']) setHost(L, role, null);
    if (L.scope.source === 'on-chain') L.scope.source = 'artifact';
    L.corroboration = null;
    const shell = { ...structuredClone(L), idsAskedOfGetter: {}, observations: [...L.observations].reverse() };
    if (!isDeepStrictEqual(toJson(judge(L, standard).classes), toJson(judge(shell, standard).classes))) failures.push(`${describe(spec)}: an all-unrouted Diamond and the bare shell of the same storage are judged differently`);
  }
  assert.ok(compared > 100, `only ${compared} ledger(s) carried routed observations to remove — the cell compares nothing`);
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} shell/enumerable divergence(s)`);
});

// ── copies of a script under os.tmpdir() (T-F, T-H) ─────────────────────────
/**
 * A script's source rewritten to run from anywhere: every import names the
 * module the original resolves (siblings by file URL, packages through this
 * file's resolver) and `import.meta.url` is the original's URL. A copy
 * written under os.tmpdir() therefore shares the real module graph — one
 * verdict brand, one era table — and reads every repo path the original
 * reads, so it differs from the checkout only by what a cell changes on
 * purpose. `redirect` swaps one sibling import, by its specifier, for another
 * module; a redirect that matches no import throws, since the cell relying on
 * it would then test the unredirected module.
 */
function rewiredSource(name, redirect = {}) {
  const file = join(SCRIPTS, name);
  const target = (spec) => redirect[spec] ?? (spec.startsWith('./') ? pathToFileURL(join(SCRIPTS, spec)).href : spec.startsWith('node:') ? spec : import.meta.resolve(spec));
  const out = readFileSync(file, 'utf8')
    .replace(/(\bfrom\s+)'([^']+)'(?=;?[ \t]*$)/gm, (_, from, spec) => `${from}'${target(spec)}'`)
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href));
  for (const [spec, url] of Object.entries(redirect)) if (!out.includes(`'${url}'`)) throw new Error(`${name} imports nothing from ${spec} — the redirect did not apply`);
  return out;
}

// ── T-F — source mutations of the judge, on a temp copy ─────────────────────
// Each mutant is the judge with ONE rule broken, written under os.tmpdir()
// with its relative imports pointed back at the real modules, so the mutant is
// the only changed file and the checkout is never touched. A mutation whose
// anchor no longer matches exactly once fails (a mutation that does not apply
// kills nothing); a killer that also flags the UNMUTATED judge proves nothing
// and fails; a mutant every killer passes fails the suite.
const viaJudge = (M, ledger, standard = 'provenance') => M.verdictFromEvidence(ledger, { proofStandard: standard, storageRead: STORAGE_READ });
const violation = (M, { ledger, gen, standard = 'provenance' }, re) => invariantViolations(viaJudge(M, ledger, standard), ledger, { standard, gen }).some((x) => re.test(x));
const withUnknownRow = () => { const { ledger } = ledgerOf(); BREAKERS['asset-settled'][0].apply(ledger); return { ledger }; };
/** A T-D breaker the judge M lets through (of those `which` selects): some class it governs stays proven or fails to name it. */
const breakerSurvives = (M, name, which = () => true) => BREAKERS[name].filter(which).some((b) => b.standards.some((standard) => {
  const { ledger } = ledgerOf({ standard });
  b.apply(ledger);
  const v = viaJudge(M, ledger, standard);
  return b.classes.some((C) => v.classes[C].status !== 'indeterminate' || !reasonsOf(v, C).includes(name));
}));
const MUTATIONS = [
  {
    name: 'an indeterminate class drops its unknown rows from the count (the r27 "already indeterminate" exemption)',
    find: 'count: c.rows.length + c.unknown.length,',
    replace: "count: status === 'proven' ? c.rows.length + c.unknown.length : c.rows.length,",
    killedBy: (M) => violation(M, withUnknownRow(), /I2/),
  },
  {
    name: 'a routed zero grants the zero bound (r28 P1)',
    find: 'const zero = known && N === 0n && COUNTER_FIELDS.every((f) => head[f] !== null) && nonZero.length === 0 && unreadableCounters.length === 0;',
    replace: 'const zero = (known && N === 0n && COUNTER_FIELDS.every((f) => head[f] !== null) && nonZero.length === 0 && unreadableCounters.length === 0) || big(L.range?.routed?.totalLoansEverCreated) === 0n;',
    killedBy: (M) => violation(M, { ledger: bLedger({ routed: { stats: 0n, ids: [] }, n: 5n, tlecZero: false, intentZero: true }) }, /I7/),
  },
  {
    name: 'the zero bound is granted over readings nobody took (every reading of an empty list is zero only vacuously)',
    find: 'N === 0n && COUNTER_FIELDS.every((f) => head[f] !== null) && nonZero.length === 0',
    replace: 'N === 0n && nonZero.length === 0',
    killedBy: (M) => breakerSurvives(M, 'range-nonempty-or-bound', (b) => /no reading at all|kind missing|reading missing/.test(b.why)),
  },
  {
    name: 'storage\'s own range witness may go unrecorded (no-range-contradiction discharged by its absence)',
    find: "if (headUnread.includes('totalLoansEverCreated')) {",
    replace: 'if (false) {',
    killedBy: (M) => breakerSurvives(M, 'no-range-contradiction', (b) => /witness of the range is unread/.test(b.why)),
  },
  {
    name: 'a metrics routing record that answers neither way is read as "unrouted" (no routed witness owed)',
    find: '} else if (!metricsUnrouted) {',
    replace: '} else if (false) {',
    killedBy: (M) => breakerSurvives(M, 'no-range-contradiction', (b) => /no routing answer/.test(b.why)),
  },
  {
    name: 'a getter with no recorded routing answer is read as unrouted',
    find: "const getterUnrouted = !getterRouted && surfaces[getter] === 'unrouted';",
    replace: 'const getterUnrouted = !getterRouted;',
    killedBy: (M) => breakerSurvives(M, 'getter-coverage', (b) => /routing answer/.test(b.why)) || breakerSurvives(M, 'getter-head-slot-agreement', (b) => /routing answer/.test(b.why)),
  },
  {
    name: 'a corroboration record with no outcome is read as "not taken"',
    find: "? 'unavailable' : 'unrecorded';",
    replace: "? 'unavailable' : 'not-taken';",
    killedBy: (M) => breakerSurvives(M, 'corroboration-consistent', (b) => /absent|neither a list|not a list/.test(b.why)),
  },
  {
    name: 'count = rows.length',
    find: 'count: c.rows.length + c.unknown.length,',
    replace: 'count: c.rows.length,',
    killedBy: (M) => violation(M, withUnknownRow(), /I2/),
  },
  {
    name: 'the total is kept beside unknown-asset rows',
    find: 'const total = unknown.length || nullAmounts ? null :',
    replace: 'const total = nullAmounts ? null :',
    killedBy: (M) => violation(M, withUnknownRow(), /I3/),
  },
  {
    name: 'the absorption branch is dropped (an older getter\'s row is counted twice, r7 P2)',
    find: 'if (c !== INTENT && !headLoanIds.has(e.loanId)) {',
    replace: 'if (false) {',
    killedBy: (M) => violation(M, ledgerOf({ 'rows.vpfiHeldCustody': 'earlier-with-twin' }), /I4/),
  },
  {
    name: 'the routed waiver is granted without a sound enumeration (the label-keyed STORAGE_ONLY_PROOFS shape, r28 P1)',
    find: 'if (!d.routed.sound) return { ok: false',
    replace: 'if (false) return { ok: false',
    killedBy: (M) => violation(M, ledgerOf({ routed: 'stale-counter', provenance: 'unattributed', standard: 'routed' }), /I5/),
  },
  {
    name: 'getter coverage accepts any asked id set (C6: the getters looped over the routed enumeration)',
    find: 'ok: range.known && covers(idSetOf(asked), range.N)',
    replace: 'ok: range.known',
    killedBy: (M) => breakerSurvives(M, 'getter-coverage'),
  },
  {
    name: 'the routed enumeration is not held to any lifetime counter reading (r28 P1b)',
    find: 'const unlisted = counted.filter((u) => BigInt(u.value) > listed);',
    replace: 'const unlisted = [];',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /r28 P1b/.test(b.why)),
  },
  {
    name: 'HEAD\'s lifetime counter is exempt from the listing bound because it equals the routed counter (round-3 review P1)',
    find: 'const counted = [head.totalLoansEverCreated, ...earlierCounted];',
    replace: 'const counted = [...earlierCounted];',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /HEAD term/.test(b.why)),
  },
  {
    name: 'an earlier era\'s lifetime counter is exempt from the listing bound (r28 P1b)',
    find: 'const counted = [head.totalLoansEverCreated, ...earlierCounted];',
    replace: 'const counted = [head.totalLoansEverCreated];',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /r28 P1b\)$/.test(b.why)),
  },
  {
    name: 'a repeated enumerated id counts as a loan listed (r28 P1b)',
    find: 'const listed = distinctSizeOf(routed.ids);',
    replace: 'const listed = sizeOf(routed.ids);',
    killedBy: (M) => {
      const L = earlierCounterLedger({ head: 2n, earlier: 3n, routed: { totalLoansEverCreated: 2n, enumeratedIds: [1n, 1n, 1n], reportedTotal: 3n } });
      return routedAgrees(viaJudge(M, L, 'routed'));
    },
  },
  {
    name: 'an absent routed enumeration counts as sound (S2-4)',
    find: 'const routedEnumerationSound = routed !== null && routedBecause === null;',
    replace: 'const routedEnumerationSound = routed === null || routedBecause === null;',
    killedBy: (M) => {
      const { ledger } = ledgerOf({ routed: 'absent', provenance: 'unattributed', standard: 'routed' });
      const v = viaJudge(M, ledger, 'routed');
      return routedAgrees(v) || CLASSES.some((C) => v.classes[C].status === 'proven');
    },
  },
  {
    name: 'the ambiguity test is dropped (S1-R3)',
    find: 'const why = o.ambiguous',
    replace: 'const why = false',
    killedBy: (M) => violation(M, ledgerOf({ 'rows.vpfiHeldCustody': 'ambiguous' }), /I13/),
  },
  {
    name: 'attribution covers only the facets whose code hash was read, not every writer the population check vouches for (root-arrest review r1 P1)',
    find: 'if (unhashed.length) refuse(',
    replace: 'if (false) refuse(',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /no code-hash read/.test(b.why)),
  },
  {
    name: 'an unreadable read also joins the reconciliation (filed unknown AND counted)',
    find: 'const readable = observations.filter((o) => o.unreadable === null);',
    replace: 'const readable = observations;',
    killedBy: (M) => violation(M, unreadableTwin(), /I4/),
  },
  {
    name: 'an amount that does not parse is read as a missing one (the merge and the agreement check then judge it by two rules)',
    find: 'if (amountRecorded && amount === null) why.push(',
    replace: 'if (false) why.push(',
    killedBy: (M) => breakerSurvives(M, 'row-attributed', (b) => /amount does not parse|amounts do not parse/.test(b.why)),
  },
  {
    name: 'a loan id beyond nextLoanId is read as a row',
    find: 'else if (range.known && id > range.N) why.push(',
    replace: 'else if (false) why.push(',
    killedBy: (M) => breakerSurvives(M, 'row-attributed', (b) => /beyond nextLoanId/.test(b.why)),
  },
  {
    name: 'an unknown source is read as storage',
    find: "const source = o.source === 'storage' || o.source === 'routed-getter' ? o.source : null;",
    replace: "const source = o.source === 'routed-getter' ? 'routed-getter' : 'storage';",
    killedBy: (M) => breakerSurvives(M, 'row-attributed', (b) => /source is neither/.test(b.why)),
  },
  {
    name: 'the cut-source rule is handed no cut history, so the entry\'s label alone decides what a cut named (round-3 review P2)',
    find: '{ addresses: arr(ch?.addresses), initializers: arr(ch?.initializers) }',
    replace: '{ addresses: [], initializers: [] }',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /empty-code hash/.test(b.why)),
  },
  {
    name: 'an unread provenance counts as attributed (the absence of a refusal read as a proof, S1-R8)',
    find: 'holds: refusals.length === 0 }',
    replace: 'holds: refusals.length === 0 || !provRead }',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed'),
  },
  {
    name: 'attribution holds over an empty writer population ("every writer is attributed" of no writers)',
    find: 'if (!namedAttributed) refuse(',
    replace: 'if (false) refuse(',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /empty writer population/.test(b.why)),
  },
  {
    name: 'an address with two code-hash entries is two reads, not a malformed one (#2095 round-28 duplicate reads)',
    find: 'const readTwice = new Set([...entriesOf].filter(([, n]) => n > 1).map(([a]) => a));',
    replace: 'const readTwice = new Set();',
    killedBy: (M) => breakerSurvives(M, 'provenance-attributed', (b) => /two code-hash entries/.test(b.why)),
  },
  {
    name: 'an address read twice still attributes, so the first entry decides the layout a scope host shares',
    find: "&& !readTwice.has(String(f.address ?? '').toLowerCase()))",
    replace: ')',
    killedBy: (M) => breakerSurvives(M, 'asset-settled', (b) => /two code-hash entries/.test(b.why)),
  },
  {
    name: 'a scope getter\'s host recorded twice, differently, is settled by the first form consulted',
    find: 'if (new Set(forms.map(([, h]) => h)).size > 1) {',
    replace: 'if (false) {',
    killedBy: (M) => breakerSurvives(M, 'asset-settled', (b) => /spelled twice/.test(b.why)),
  },
];

test('T-F — every source mutation of the judge is killed by its cell, and no killer flags the unmutated judge', async (t) => {
  assert.ok(MUTATIONS.length >= 10, 'the brief\'s ten mutations are registered');
  const source = readFileSync(join(SCRIPTS, 'census-verdict.mjs'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'census-verdict-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rewired = rewiredSource('census-verdict.mjs');
  assert.notEqual(rewired, source, 'the judge\'s relative imports were re-pointed at the real modules');
  for (const [k, m] of MUTATIONS.entries()) {
    const hits = rewired.split(m.find).length - 1;
    assert.equal(hits, 1, `mutation (${m.name}): its anchor matches ${hits} site(s) in census-verdict.mjs — re-point it at the rule it breaks`);
    assert.equal(m.killedBy(VERDICT), false, `mutation (${m.name}): its killer flags the UNMUTATED judge — it proves nothing about the mutant`);
    const file = join(dir, `mutant-${k}.mjs`);
    writeFileSync(file, rewired.split(m.find).join(m.replace));
    const mutant = await import(pathToFileURL(file).href);
    let killed;
    try { killed = m.killedBy(mutant); } catch (err) { assert.fail(`mutation (${m.name}): the mutant threw (${err.message}) — the mutation breaks the module, not the rule`); }
    assert.equal(killed, true, `mutation (${m.name}) survives its cell — the rule it breaks is untested`);
  }
});

// ── T-H — the collector's offline paths ─────────────────────────────────────
// What the census writes without a chain read: the failure row of a
// deployment whose collection threw, a duplicate record re-judged from the
// original's ledger, a committed ledger revived for `--rejudge`, the
// `--rejudge` gates themselves, and the build-candidate request the era tool
// acts on. Each decides what the artifact (or the candidates file) says, so a
// regression in one would ship with every judge cell above green.
//
// The collector exports each of these paths; they are reached in a copy
// (`rewiredSource`) that runs the collector's own code over the real module
// graph with TWO substitutions, both in the era-tool module it imports.
// `commitsAround` asks git for the commits around a moment, so a stub records
// each moment asked and answers one commit — whether a request is MADE is then
// checked identically in a full clone and in CI's shallow one, where git would
// answer nothing and the positive cell would prove nothing. `CANDIDATES_FILE`
// points at a temporary file, so a cell can watch the build-candidate request
// being written, or not, without the owner-gated file being at risk. The cell
// that publishes THROUGH the manifest lock runs in a second copy whose
// deployment inventory is a temporary directory too (`collectorWithInventory`),
// so neither the checkout's inventory nor its manifest lock is touched.
const OFFLINE_PATHS = ['censusDeployment', 'publish', 'rejudge', 'proposeBuildCandidates'];
let OFFLINE = null;
let OFFLINE_CANDIDATES_DIR = null;
after(() => { if (OFFLINE_CANDIDATES_DIR) rmSync(OFFLINE_CANDIDATES_DIR, { recursive: true, force: true }); });
async function collectorOffline() {
  if (OFFLINE) return OFFLINE;
  const dir = mkdtempSync(join(tmpdir(), 'census-collector-copy-'));
  OFFLINE_CANDIDATES_DIR = mkdtempSync(join(tmpdir(), 'census-candidates-'));
  const candidatesFile = join(OFFLINE_CANDIDATES_DIR, 'facet-build-candidates.json');
  try {
    const stub = join(dir, 'era-tool-stub.mjs');
    writeFileSync(stub, [
      `export * from '${pathToFileURL(join(SCRIPTS, 'storage-layout-eras.mjs')).href}';`,
      'export const ASKED = [];',
      "export function commitsAround(iso) { ASKED.push(iso); return [{ commit: `around-${iso}`, relation: 'fixture: around' }]; }",
      `export const CANDIDATES_FILE = ${JSON.stringify(candidatesFile)};`,
      '',
    ].join('\n'));
    const copy = join(dir, CG);
    writeFileSync(copy, rewiredSource(CG, { './storage-layout-eras.mjs': pathToFileURL(stub).href }));
    let M;
    try { M = await import(pathToFileURL(copy).href); } catch (err) { assert.fail(`the collector copy does not load (${err.message}) — an offline path T-H reaches was renamed or removed; re-point the cell`); }
    for (const n of OFFLINE_PATHS) assert.equal(typeof M[n], 'function', `${n} is not exported by the collector — re-point the cell`);
    const { ASKED } = await import(pathToFileURL(stub).href);
    OFFLINE = { ...Object.fromEntries(OFFLINE_PATHS.map((n) => [n, M[n]])), commitsAsked: ASKED, candidatesFile };
  } finally {
    // loaded modules stay in memory; the files must not outlive the load
    rmSync(dir, { recursive: true, force: true });
  }
  return OFFLINE;
}

/** A deployment record as the inventory lists it — the collector keys a ledger, a relabel and a re-judgement by it. */
const recordOf = (label) => ({ slug: 'fixture-chain', label, addresses: { diamond: ADDR(0xd1a), chainId: 31337, deployBlock: 1, vpfiToken: VPFI } });
const DUPLICATE = recordOf('archived 2026-07-01T01-36-25Z');

test('T-H — a collection that throws carries its ledger as far as it got, and every failure row the census records keeps it (§3.3)', async () => {
  // a record naming no Diamond throws before any RPC is resolved — the one
  // collector failure a unit test can reach without a chain
  const err = await COLLECTOR.collectEvidence({ slug: 'fixture-chain', label: 'live', addresses: {} }).then(() => null, (e) => e);
  assert.ok(err instanceof Error, 'a deployment record naming no Diamond was collected without error');
  assert.match(err.message, /carries no diamond address/);
  const L = err.partialLedger;
  assert.ok(L && typeof L === 'object', 'the error carries no partial ledger — its failure row would show nothing of what was read');
  assert.equal(L.schema, 2);
  assert.deepEqual([L.identity.chainSlug, L.identity.deployment], ['fixture-chain', 'live']);
  assert.ok(!('classes' in L) && !isVerdict(L), 'a partial ledger is evidence of the failure, never a verdict');
  assert.deepEqual(STRUCTURE.failureRowsKeepPartialLedger(lexOf(CG)), []);
});

test('T-H — a ledger written through the real writer and read back through the real reader judges exactly as the run judged it (`--rejudge` re-derives the run from its decimal strings, with no numeric revival)', (t) => {
  const { reviveLedger, artifactTexts, loadCensusArtifact } = COLLECTOR;
  // the collector's bigint-bearing extras and an explicit id list, which the family does not write
  const { ledger: shaped } = ledgerOf();
  for (const o of shaped.observations.filter((x) => x.source === 'routed-getter')) {
    if (o.class === 'fallbackSnapshotCustody') o.extra = { active: true, lenderPrincipalDue: 3n, treasuryPrincipalDue: 1n };
    if (o.class === 'liveIntentCommits') o.extra = { maker: ADDR(0xa11ce), deadline: 1_900_000_000n };
  }
  shaped.range.routed = { totalLoansEverCreated: 5n, enumeratedIds: [1n, 2n, 3n, 4n, 5n], reportedTotal: 5n };
  const cases = [{ ledger: shaped, standard: 'provenance', spec: { collectorShaped: true } }, ...family()];
  const verdicts = cases.map(({ ledger, standard }) => judge(ledger, standard));
  // one artifact pair holding every case, written and read the way a publication and `--rejudge` do
  const dir = mkdtempSync(join(tmpdir(), 'census-roundtrip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, 'grandfathered-custody-census.json');
  const report = { generatedAt: 'fixture', schema: 2, ledgers: { file: 'grandfathered-custody-census.ledgers.json' }, chainsFailed: [], results: verdicts };
  for (const [path, text] of Object.entries(artifactTexts(report, outFile))) writeFileSync(path, text);
  const read = loadCensusArtifact(outFile);
  assert.equal(read.results.length, cases.length);
  assert.equal(typeof read.results[0].ledger.range.storage.nextLoanId, 'string', 'the written ledger holds decimal strings where the run held bigints — and the judge is handed them as they are');
  const failures = [];
  cases.forEach(({ standard, spec }, i) => {
    const written = read.results[i].ledger;
    if (!isDeepStrictEqual(written, toJson(cases[i].ledger))) { failures.push(`${describe(spec)}: the ledger read back is not the one the run held`); return; }
    const revived = reviveLedger(written);
    if (revived === written || !Object.isFrozen(revived) || !Object.isFrozen(revived.observations)) { failures.push(`${describe(spec)}: the revived ledger is not a private, deep-frozen copy`); return; }
    if (!isDeepStrictEqual(toJson(stripLedger(judge(revived, standard))), toJson(stripLedger(verdicts[i])))) failures.push(`${describe(spec)}: the ledger read back judges differently`);
  });
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} ledger(s) do not survive the artifact round trip`);
});

test('T-H — a ledger and its write-then-revive twin publish the SAME verdict: a bigint and its decimal string render, sort and copy alike, so the detail text and the row order agree too', (t) => {
  const { reviveLedger, artifactTexts, loadCensusArtifact } = COLLECTOR;
  const { ledger: L } = ledgerOf();
  // Two answers of the intent getter for one loan, alike but for a bigint in
  // their extra whose two spellings sort in opposite orders: as decimals "1"
  // precedes "10", spelled "1n"/"10n" it follows it. Both are filed unknown
  // (one key, one read), so the published order is the sort's alone.
  const answer = routedOf(L, 'liveIntentCommits');
  answer.extra = { maker: ADDR(0xa11ce), deadline: 1n };
  L.observations.push({ ...answer, extra: { maker: ADDR(0xa11ce), deadline: 10n } });
  // a getter asked over an explicit bigint id list short of the range: getter-coverage's detail renders the list
  L.idsAskedOfGetter.getBorrowerLifRebate = [1n, 2n];
  const run = judge(L);
  // the twin, written by the real writer and read by the real reader, as `--rejudge` reads it
  const dir = mkdtempSync(join(tmpdir(), 'census-revive-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, 'grandfathered-custody-census.json');
  const report = { generatedAt: 'fixture', schema: 2, ledgers: { file: 'grandfathered-custody-census.ledgers.json' }, chainsFailed: [], results: [run] };
  for (const [path, text] of Object.entries(artifactTexts(report, outFile))) writeFileSync(path, text);
  const twin = reviveLedger(loadCensusArtifact(outFile).results[0].ledger);
  assert.equal(typeof twin.idsAskedOfGetter.getBorrowerLifRebate[0], 'string', 'the twin holds decimal strings where the run held bigints');
  const again = judge(twin);
  // the fixture is live: the verdict renders the bigint list, and orders two rows by the bigint alone
  const answers = (v) => v.classes.liveIntentCommits.unknownAssetRows.filter((r) => String(r.unknownBecause).startsWith('duplicateRead')).map((r) => r.extra?.deadline);
  assert.deepEqual(answers(again), ['1', '10'], 'the two answers are filed unknown and ordered by their deadlines as decimals');
  assert.match(again.classes.vpfiHeldCustody.obligations['getter-coverage'].detail, /asked over \["1","2"\]/, 'getter-coverage renders the asked list');
  // the published verdict, ledger aside, is one value — detail text, row order and every figure — with no bigint left in it …
  const { ledger: heldLedger, ...published } = run;
  const { ledger: twinLedger, ...publishedAgain } = again;
  assert.deepStrictEqual(publishedAgain, published);
  assert.deepStrictEqual(answers(run), ['1', '10']);
  // … and the full verdict, its ledger included, writes the same text
  assert.equal(JSON.stringify(toJson(again)), JSON.stringify(toJson(run)));
  assert.ok(heldLedger === L && twinLedger === twin, 'each verdict carries the ledger it was judged from');
});

test('T-H — a duplicate record is re-derived from the relabelled LEDGER through censusDeployment: branded, under its own label, the original named flat, the same classes, the original untouched (S1-R1)', async () => {
  const { censusDeployment, publish } = await collectorOffline();
  // censusDeployment judges with the checkout's table under the default standard; the original is judged the same way
  const original = publish(verdictFromEvidence(COLLECTOR.deepFreeze(ledgerOf().ledger), { proofStandard: 'provenance', storageRead: checkoutStorageRead() }));
  const dep = DUPLICATE;
  const dup = await censusDeployment(dep, original.ledger);
  assert.equal(isVerdict(dup), true, 'the duplicate is not a judged verdict');
  assert.notEqual(dup, original);
  assert.equal(dup.deployment, dep.label);
  assert.equal(dup.duplicateOfDeployment, 'live');
  assert.equal(toJson(dup).duplicateOfDeployment, 'live', 'the artifact names the original flat, beside the other identity keys (C7)');
  assert.deepEqual(dup.sourceRecord, { recorded: false }, 'the source record is resolved for the duplicate\'s own label, not carried from the original');
  assert.equal(dup.ledger.identity.inventoryKey, COLLECTOR.inventoryKeyOf(dep), 'the reads are re-keyed to the record they are now published for');
  for (const k of IDENTITY_KEYS.filter((x) => x !== 'deployment' && x !== 'sourceRecord')) assert.deepEqual(dup[k], original[k], `identity key ${k}`);
  assert.deepEqual(toJson(dup.classes), toJson(original.classes), 'the same reads judge to the same classes under another label');
  assert.ok(Object.isFrozen(dup.ledger) && Object.isFrozen(dup.ledger.identity), 'the relabelled ledger was judged unfrozen');
  assert.equal(original.ledger.identity.deployment, 'live', 'relabelling wrote into the original\'s ledger');
  assert.equal('duplicateOfDeployment' in original.ledger.identity, false);
  assert.throws(() => publish({ ...dup }), /refusing to publish/, 'a copy of the duplicate is published as if derived');
  assert.equal(publish(dup), dup);
});

test('T-H — the build-candidate request asks about what the judge found unattributed and nothing else, and never for an unread provenance or a duplicate record (S3-3)', async () => {
  const { proposeBuildCandidates, censusDeployment, commitsAsked } = await collectorOffline();
  const request = (results) => { commitsAsked.length = 0; const proposed = proposeBuildCandidates(results); return { proposed, asked: [...commitsAsked] }; };
  const { ledger } = ledgerOf({ provenance: 'unattributed' });
  // every writer's cut block is dated and the head facet's record has a
  // deployedAt: only the unattributed facet's moments may be asked about
  ledger.cutHistory.blockTimestamps = Object.fromEntries(Object.values(ledger.cutHistory.blocksOf).flat().map((n, i) => [n, { iso: `2026-08-0${i + 1}T00:00:00Z`, estimated: false }]));
  const rogue = ledger.provenance.facets.find((f) => f.address === A.rogue);
  rogue.sources = [...rogue.sources, 'record:archived 2026-07-01'];
  ledger.provenance.recorded.deployedAt.push({ record: 'record:archived 2026-07-01', iso: '2026-06-30T00:00:00Z' });
  const v = judge(ledger);
  assert.deepEqual(v.scanned.provenance.unattributed, [A.rogue], 'the fixture leaves exactly the rogue facet unattributed');
  const [block] = ledger.cutHistory.blocksOf[A.rogue];
  const cutAt = ledger.cutHistory.blockTimestamps[block].iso;
  const live = request([v]);
  assert.deepEqual(live.asked, [cutAt, '2026-06-30T00:00:00Z'], 'the request asks about the unattributed facet\'s cut and its record\'s deployedAt, and about no attributed facet');
  assert.deepEqual(live.proposed.map((c) => c.commit), [`around-${cutAt}`, 'around-2026-06-30T00:00:00Z']);
  assert.match(live.proposed[0].reasons.join(), new RegExp(`fixture-chain \\(live\\)'s cut at block ${block} \\(${cutAt}\\)`));
  assert.match(live.proposed[1].reasons.join(), /fixture-chain \(live\)'s record:archived 2026-07-01 deployedAt 2026-06-30T00:00:00Z/);
  // an estimated moment may be hours off: the request widens to ±6 h around it
  const estimated = structuredClone(ledger);
  estimated.cutHistory.blockTimestamps[block] = { iso: cutAt, estimated: true };
  const shifted = (h) => new Date(Date.parse(cutAt) + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const widened = request([judge(estimated)]);
  assert.deepEqual(widened.asked.slice(0, 3), [cutAt, shifted(-6), shifted(6)]);
  assert.match(widened.proposed[0].reasons.join(), /\(estimated /);
  // S3-3 — no provenance read, or no cut history: nothing to ask, whatever the list says
  assert.deepEqual(request([{ ...v, ledger: { ...v.ledger, provenance: { read: false, reason: 'storage read unavailable: fixture' } } }]), { proposed: [], asked: [] }, 'an unread provenance asked the era tool to catalogue its facets');
  assert.deepEqual(request([{ ...v, ledger: { ...v.ledger, cutHistory: null } }]), { proposed: [], asked: [] });
  // a duplicate's reads are its original's, which already asked — judged
  // with the checkout's table, every fixture facet is unattributed there
  const dup = await censusDeployment(DUPLICATE, v.ledger);
  assert.ok(dup.scanned.provenance.unattributed.length > 0, 'the duplicate carries unattributed facets to ask about');
  assert.deepEqual(request([dup]), { proposed: [], asked: [] }, 'a duplicate record asked again what its original asked');
  assert.ok(request([{ ...dup, duplicateOfDeployment: undefined }]).asked.length > 0, 'the same verdict unmarked asks — the duplicate mark, not an empty list, kept it quiet');
  assert.deepEqual(request([v, dup]), live, 'beside its original a duplicate adds nothing');
});

/**
 * A ledger whose storage read covered exactly the checkout table's era slots,
 * less `drop` — a Diamond with no loans and no provenance read, so the
 * coverage gate is the only one a dropped slot can move.
 */
function checkoutTableLedger(table, drop = null) {
  const slotsScanned = Object.fromEntries(Object.entries(table.eraSlots).map(([f, list]) => [f, list.map((e) => e.slot).filter((s) => !(drop && drop.field === f && drop.slot === s))]));
  const counter = (f) => table.eraSlots[f].map(({ slot }) => ({ slot, value: 0n }));
  return {
    schema: 2,
    identity: { chainSlug: 'fixture-chain', deployment: 'live', chainId: 31337, diamond: ADDR(0xd1a), atBlock: '1000', atBlockHash: H(0xb10c), blockTag: 'finalized', rpcHost: 'rpc.fixture.invalid', sourceRecord: { recorded: false }, inventoryKey: COLLECTOR.inventoryKeyOf(recordOf('live')) },
    flags: { codeAbsent: false, codeAbsentReason: null, notADiamond: false, loupeRouted: false, custodySurfaceUnrouted: true },
    scope: { vpfiToken: null, source: null },
    backing: null,
    range: {
      storage: { nextLoanId: 0n, truncatedAt: null, counters: { totalLoansEverCreated: counter('totalLoansEverCreated'), intentLiveCommitCount: counter('intentLiveCommitCount') }, read: { ...structuredClone(table.evidence), slotsRead: Object.values(slotsScanned).flat().length, loansScanned: 0, slotsScanned } },
      storageUnavailable: null,
      routed: null,
    },
    surfaces: Object.fromEntries(Object.keys(ledgerOf().ledger.surfaces).map((k) => [k, 'unrouted'])),
    hostOf: {},
    idsAskedOfGetter: {},
    observations: [],
    corroboration: null,
    cutHistory: null,
    provenance: { read: false, reason: 'fixture: provenance not read' },
  };
}

test('the command line is checked against ONE flag list before anything is read: an unknown flag, a value flag with no value, a stray argument or a repeat exits 2; --help lists every flag; the list and the reads cannot drift', () => {
  const { parseCliFlags, usage, CLI_FLAGS } = COLLECTOR;
  assert.deepEqual(parseCliFlags(['--rejudge', '--rejudge-from', 'x.json', '--chain', 'sepolia', '--rejudge-allow-coverage-gaps']), { help: false, problems: [] });
  const refused = {
    'a typo of an offline mode': [['--re-judge'], /unknown flag --re-judge/],
    'a value flag at the end': [['--chain'], /--chain needs a value/],
    'a value flag followed by a flag': [['--chain', '--rejudge'], /--chain needs a value/],
    'a stray argument': [['--rejudge', 'stray'], /unexpected argument "stray"/],
    'a repeated flag': [['--chain', 'a', '--chain', 'b'], /--chain is given more than once/],
    'the = spelling arg() does not read': [['--rpc=http://127.0.0.1:9'], /unknown flag --rpc=/],
  };
  for (const [what, [argv, re]] of Object.entries(refused)) assert.match(parseCliFlags(argv).problems.join('; '), re, what);
  assert.equal(parseCliFlags(['--help']).help, true);
  for (const [flag, spec] of Object.entries(CLI_FLAGS)) assert.ok(usage().includes(spec.value ? `${flag} ${spec.value}` : flag), `--help does not list ${flag}`);
  // every flag the collector reads goes through arg()/hasFlag() and is listed with its kind; every listed flag is read
  const cg = lexOf(CG);
  const reads = [...cg.kept.matchAll(/\b(arg|hasFlag)\('(--[a-z-]+)'/g)].map(([, how, flag]) => ({ how, flag }));
  assert.ok(reads.length >= 15, `only ${reads.length} flag read(s) found — the grep is not where the reads are`);
  assert.deepEqual(reads.filter(({ how, flag }) => !CLI_FLAGS[flag] || Boolean(CLI_FLAGS[flag].value) !== (how === 'arg')).map((r) => `${r.how}('${r.flag}')`), [], 'a flag the collector reads that the command line would refuse, or reads as the other kind');
  assert.deepEqual(Object.keys(CLI_FLAGS).filter((f) => f !== '--help' && !reads.some((r) => r.flag === f)), [], 'a listed flag nothing reads — the command line would accept it and ignore it');
  const readers = ['arg', 'hasFlag'].map((n) => bodyOf(cg, n));
  const raw = [...cg.blank.matchAll(/\bprocess\.argv\.(includes|indexOf)\(/g)].filter((m) => !readers.some((b) => b && b.at <= m.index && m.index < b.end));
  assert.deepEqual(raw.map((m) => cg.blank.slice(m.index, m.index + 40)), [], 'a flag read around arg()/hasFlag() escapes the list');
});

test('the CLI refuses an unknown flag with exit 2 before main() — a mistyped --rejudge never starts a census', () => {
  // `--chain` names no deployment directory: were the flags NOT checked, the
  // run would stop at the inventory with exit 1, before any endpoint — so even
  // a regressed check reads no chain and writes nothing here
  const run = (args) => spawnSync(process.execPath, [join(SCRIPTS, CG), ...args, '--chain', 'no-such-chain-fixture'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CENSUS_RPC_URL: 'http://127.0.0.1:9' } });
  const typo = run(['--re-judge']);
  assert.equal(typo.status, 2, `exit ${typo.status}: ${typo.stderr.slice(0, 300)}`);
  assert.match(typo.stderr, /unknown flag --re-judge — nothing was read or written/);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr.slice(0, 300));
  for (const flag of Object.keys(COLLECTOR.CLI_FLAGS)) assert.ok(help.stdout.includes(flag), `--help does not print ${flag}`);
});

test('the CLI refuses a companion flag without the mode it modifies — exit 2 naming both, never a fall-through to a full census (one spawned run per companion in CLI_FLAGS)', () => {
  const { CLI_FLAGS, parseCliFlags } = COLLECTOR;
  const companions = Object.entries(CLI_FLAGS).filter(([, s]) => s.requires !== undefined);
  // the four the collector reads only inside a mode: --rejudge's two, --write-archive-manifest's two
  assert.ok(companions.length >= 4, `only ${companions.length} companion flag(s) carry a parent in CLI_FLAGS — the cell would spawn too little`);
  for (const [flag, spec] of companions) {
    const mode = CLI_FLAGS[spec.requires];
    assert.ok(mode && mode.value === null && mode.requires === undefined, `${flag} requires ${spec.requires}, which is not a listed mode switch`);
    const withValue = (f, s) => (s.value ? [f, 'fixture-value'] : [f]);
    // with its mode it is accepted (pure: a spawn with --write-archive-manifest would rewrite the manifest)
    assert.deepEqual(parseCliFlags([spec.requires, ...withValue(flag, spec)]).problems, [], `${flag} beside ${spec.requires}`);
    // without it: the spawned CLI stops before main(). `--chain` names no
    // deployment directory, so a regressed check stops at the inventory with
    // exit 1 — reading no chain and writing nothing — and the exit code tells the two apart
    const r = spawnSync(process.execPath, [join(SCRIPTS, CG), ...withValue(flag, spec), '--chain', 'no-such-chain-fixture'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CENSUS_RPC_URL: 'http://127.0.0.1:9' } });
    assert.equal(r.status, 2, `${flag} without ${spec.requires}: exit ${r.status} — ${r.stderr.slice(0, 300)}`);
    assert.ok(r.stderr.includes(`${flag} is given without ${spec.requires}`), `the refusal does not name both ${flag} and ${spec.requires}:\n${r.stderr.slice(0, 400)}`);
    assert.match(r.stderr, /nothing was read or written/);
  }
});

/**
 * A sandbox `--rejudge` runs in: a source artifact it reads, and an output
 * directory holding a TRIPWIRE at every name the publication could replace.
 * Publishing first reads the file it replaces and refuses one it cannot parse,
 * so a run that gets past the gates stops there — at the first publication
 * guard, before the manifest lock or any write — and its error says it
 * reached publication. `run` captures the exit code and stderr and restores
 * both, and the argv, afterwards.
 */
async function rejudgeSandbox(t) {
  const { rejudge } = await collectorOffline();
  const table = checkoutStorageRead();
  assert.ok(table.ok, `the checkout's era table is refused (${table.reason}) — --rejudge refuses before every gate`);
  const dir = mkdtempSync(join(tmpdir(), 'census-rejudge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'committed.json');
  const outDir = join(dir, 'out');
  mkdirSync(outDir);
  const TRIPWIRE = 'tripwire: --rejudge reached publication';
  const tripwires = ['grandfathered-custody-census.json', 'grandfathered-custody-census.partial-fixture-chain.json'];
  for (const f of tripwires) writeFileSync(join(outDir, f), TRIPWIRE);
  const run = async (artifact, { flags = [], records = [recordOf('live')] } = {}) => {
    writeFileSync(sourcePath, typeof artifact === 'string' ? artifact : JSON.stringify(artifact));
    const saved = { exitCode: process.exitCode, write: process.stderr.write, argc: process.argv.length };
    let stderr = '';
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    process.argv.push(...flags);
    try {
      const outcome = await rejudge({ everything: records, deployments: records, outDir, sourcePath }).then((value) => ({ value }), (error) => ({ error }));
      return { ...outcome, message: outcome.error?.message ?? '', exitCode: process.exitCode, stderr };
    } finally {
      process.stderr.write = saved.write;
      process.exitCode = saved.exitCode;
      process.argv.length = saved.argc;
    }
  };
  /** The output directory holds the tripwires and nothing else, each unchanged — nothing was published. */
  const untouched = () => {
    assert.deepEqual(readdirSync(outDir).sort(), [...tripwires].sort(), 'a re-judgement wrote into the output directory');
    for (const f of tripwires) assert.equal(readFileSync(join(outDir, f), 'utf8'), TRIPWIRE);
  };
  const resultOf = (deployment, drop = null, edit = (L) => L) => { const L = checkoutTableLedger(table, drop); Object.assign(L.identity, { deployment, inventoryKey: COLLECTOR.inventoryKeyOf(recordOf(deployment)) }); edit(L); return toJson({ chainSlug: 'fixture-chain', deployment, schema: 2, ledger: L }); };
  const committed = (results, extra = {}) => ({ generatedAt: 'fixture', schema: 2, proofStandard: 'provenance', results, ...extra });
  return { run, sourcePath, table, untouched, resultOf, committed, reachedPublication: /is the snapshot this run would replace, and it cannot be read/ };
}

test('T-H — --rejudge refuses by name what it cannot re-derive, and stops with exit 2, publishing nothing, when the reads no longer describe the inventory or the table names a slot they never covered', async (t) => {
  const { run, sourcePath, table, untouched, resultOf, committed, reachedPublication } = await rejudgeSandbox(t);
  const { candidatesFile } = await collectorOffline();

  // refusals, each naming what it refuses, each before anything is judged
  assert.ok((await run('{ not json')).message.startsWith(`--rejudge: ${sourcePath}`), 'an unreadable source is refused naming it');
  for (const schema of [1, undefined]) assert.match((await run(committed([resultOf('live')], { schema }))).message, /is schema 1, which predates the evidence ledger/, `schema ${schema}`);
  const ledgerless = await run(committed([resultOf('live'), { chainSlug: 'fixture-chain', deployment: 'archived 2026-07-01', schema: 2 }]));
  assert.match(ledgerless.message, /without an evidence ledger \(fixture-chain\/archived 2026-07-01\)/);
  assert.doesNotMatch(ledgerless.message, /fixture-chain\/live/, 'the refusal names only the result it cannot re-derive');

  // the inventory stop: reads taken for a record corrected since describe a record that no longer exists
  const corrected = { ...recordOf('live'), addresses: { ...recordOf('live').addresses, deployBlock: 2 } };
  const drifted = await run(committed([resultOf('live')]), { records: [corrected] });
  assert.equal(drifted.error, undefined, drifted.message);
  assert.equal(drifted.exitCode, 2, 'reads of a corrected record were re-judged under its label');
  assert.match(drifted.stderr, /fixture-chain\|live/);
  assert.match(drifted.stderr, /nothing was published/);

  // the coverage stop: one table slot the reads never covered is named, exit 2, nothing published
  const fallbackSlots = table.eraSlots.fallbackSnapshot ?? [];
  assert.ok(fallbackSlots.length > 0, 'the checkout table lists no fallbackSnapshot slot to drop — re-point the cell');
  const drop = { field: 'fallbackSnapshot', slot: fallbackSlots.at(-1).slot };
  const gap = await run(committed([resultOf('live', drop)]));
  assert.equal(gap.error, undefined, gap.message);
  assert.equal(gap.exitCode, 2, 'a re-judgement owed a rerun exited as if it had published');
  assert.ok(gap.stderr.includes(`fixture-chain [live]: ${drop.field}@${drop.slot}`), `the slot never read is not named:\n${gap.stderr}`);
  assert.match(gap.stderr, /nothing was published/);
  // the same artifact with the slot read passes the gate (the gap, not the fixture, is what stopped it) …
  const whole = await run(committed([resultOf('live')]));
  assert.match(whole.message, reachedPublication, `a fully covered ledger did not reach publication: ${whole.message}`);
  assert.notEqual(whole.exitCode, 2);
  // … and the operator's override publishes the gap's classes as the judge states them
  assert.match((await run(committed([resultOf('live', drop)]), { flags: ['--rejudge-allow-coverage-gaps'] })).message, reachedPublication);

  untouched();
  assert.equal(existsSync(candidatesFile), false, 'a re-judgement wrote the build-candidates file');
});

test('T-H — --rejudge stops with exit 2, naming it, where the reads took no storage read on a Diamond with code because the era table was unusable at collection: their coverage cannot be computed, so a rerun is owed', async (t) => {
  const { run, untouched, resultOf, committed, reachedPublication } = await rejudgeSandbox(t);
  const unusable = 'the era table is INCOMPLETE — 1 era(s) could not be built (fixture01); a "zero at every era" claim needs every era';
  const skipped = (L) => { L.range.storage = null; L.range.storageUnavailable = unusable; L.provenance = { read: false, reason: `storage read unavailable: ${unusable}` }; };
  // the judge marks it, and only it: a no-code or non-Diamond address has nothing more to read
  const owed = judge(COLLECTOR.reviveLedger(resultOf('live', null, skipped).ledger)).scanned.eraCoverage;
  assert.equal(owed.rerunOwed, true);
  assert.match(owed.rerunOwedBecause, /unusable at collection/);
  for (const [what, edit] of [['no code', (L) => { skipped(L); L.flags.codeAbsent = true; L.range.storageUnavailable = 'not read: the recorded address has no code'; }], ['not a Diamond', (L) => { skipped(L); L.flags.notADiamond = true; L.range.storageUnavailable = 'not read: the contract at the recorded address is not a Vaipakam Diamond'; }]]) {
    assert.equal(judge(COLLECTOR.reviveLedger(resultOf('live', null, edit).ledger)).scanned.eraCoverage.rerunOwed, false, `${what}: a rerun would read nothing more there`);
  }
  const stop = await run(committed([resultOf('live', null, skipped)]));
  assert.equal(stop.error, undefined, stop.message);
  assert.equal(stop.exitCode, 2, 'a re-judgement of reads that never covered the table exited as if it had published');
  assert.match(stop.stderr, /fixture-chain \[live\]: no storage read was taken on this Diamond/);
  assert.match(stop.stderr, /unusable at collection/);
  assert.match(stop.stderr, /nothing was published/);
  assert.match((await run(committed([resultOf('live', null, skipped)]), { flags: ['--rejudge-allow-coverage-gaps'] })).message, reachedPublication, 'the operator\'s override did not reach publication');
  untouched();
});

test('T-H — the build-candidate request is written only after every publication guard passes: a malformed candidates file refuses before publication, and a publication a guard refuses leaves the file unwritten', async (t) => {
  const { run, untouched, resultOf, committed, reachedPublication } = await rejudgeSandbox(t);
  const { candidatesFile, commitsAsked } = await collectorOffline();
  // a ledger whose one writer carries code no era built, cut at a dated block: the judge leaves it unattributed, so the run asks about it
  const unattributed = (L) => {
    L.flags.loupeRouted = true;
    L.provenance = { read: true, facets: [{ address: A.rogue, sources: ['cut-history'], codeHash: H(0xbad) }], loupe: [], loupeReadFailed: false, cutFacetHost: null, recorded: { records: [], facets: [], deployedAt: [] } };
    L.cutHistory = { verdict: 'read', cuts: 1, constructorCutSeen: true, constructorCutEvidence: 'fixture', addresses: [A.rogue], initializers: [], blocksOf: { [A.rogue]: ['10'] }, blockTimestamps: { 10: { iso: '2026-08-01T00:00:00Z', estimated: false } }, unreadableBlocks: [] };
  };
  const artifact = committed([resultOf('live', null, unattributed)]);
  // a candidates file that cannot be read refuses the publication before any file is touched — and names the
  // stub's path, which is what proves the copy writes there and never to the owner-gated file
  writeFileSync(candidatesFile, 'not json');
  const malformed = await run(artifact);
  assert.ok(malformed.message.includes(candidatesFile) && /is present but malformed/.test(malformed.message), `a malformed candidates file did not refuse before publication: ${malformed.message}`);
  assert.equal(readFileSync(candidatesFile, 'utf8'), 'not json');
  rmSync(candidatesFile);
  // the run proposes, reaches the first publication guard, and is refused there: the request stays unwritten
  commitsAsked.length = 0;
  const refused = await run(artifact);
  assert.match(refused.message, reachedPublication, `the run did not reach publication: ${refused.message}`);
  assert.deepEqual(commitsAsked, ['2026-08-01T00:00:00Z'], 'the run proposed no build candidate — the cell would prove nothing');
  assert.equal(existsSync(candidatesFile), false, 'a publication the guards refused wrote the build-candidate request');
  untouched();
});

/**
 * A copy of the collector whose deployment inventory is a temporary
 * directory, so `--rejudge` can be driven THROUGH the manifest lock — the
 * inventory re-validation and the regression guard — with the checkout's
 * inventory, its archive manifest and that manifest's lock never touched.
 * Beyond collectorOffline's substitutions (the era-tool stub and its
 * candidates file), `DEPLOYMENTS` names the temporary inventory, and the copy
 * exports the start snapshot main() takes (`deployedDiamonds`), which the
 * re-validation compares against. `source` reads the collector's text — the
 * checkout's, unless a cell is checking a mutant of it.
 */
async function collectorWithInventory(t, source = () => rewiredSource(CG)) {
  const inventoryDir = mkdtempSync(join(tmpdir(), 'census-inventory-'));
  const candidatesDir = mkdtempSync(join(tmpdir(), 'census-candidates-'));
  const codeDir = mkdtempSync(join(tmpdir(), 'census-collector-inventory-copy-'));
  t.after(() => { for (const d of [inventoryDir, candidatesDir, codeDir]) rmSync(d, { recursive: true, force: true }); });
  const candidatesFile = join(candidatesDir, 'facet-build-candidates.json');
  const stub = join(codeDir, 'era-tool-stub.mjs');
  writeFileSync(stub, [
    `export * from '${pathToFileURL(join(SCRIPTS, 'storage-layout-eras.mjs')).href}';`,
    'export const ASKED = [];',
    "export function commitsAround(iso) { ASKED.push(iso); return [{ commit: `around-${iso}`, relation: 'fixture: around' }]; }",
    `export const CANDIDATES_FILE = ${JSON.stringify(candidatesFile)};`,
    '',
  ].join('\n'));
  const eraTool = `'${pathToFileURL(join(SCRIPTS, 'storage-layout-eras.mjs')).href}'`;
  const inventoryAnchor = "const DEPLOYMENTS = join(REPO, 'contracts/deployments');";
  const text = source();
  for (const [what, anchor] of [['the era-tool import', eraTool], ['the inventory root', inventoryAnchor]]) assert.equal(text.split(anchor).length - 1, 1, `${what} matches ${text.split(anchor).length - 1} site(s) in the collector — re-point the copy`);
  const copy = join(codeDir, CG);
  writeFileSync(copy, `${text.replace(eraTool, `'${pathToFileURL(stub).href}'`).replace(inventoryAnchor, `const DEPLOYMENTS = ${JSON.stringify(inventoryDir)};`)}\nexport const startSnapshot = () => deployedDiamonds();\n`);
  const M = await import(pathToFileURL(copy).href);
  const { ASKED } = await import(pathToFileURL(stub).href);
  const record = recordOf('live');
  /** The inventory as a deploy leaves it: the one live record, and a manifest at `liveGeneration`. */
  const writeInventory = ({ liveGeneration = 0, extraChain = false } = {}) => {
    mkdirSync(join(inventoryDir, record.slug), { recursive: true });
    writeFileSync(join(inventoryDir, record.slug, 'addresses.json'), JSON.stringify(record.addresses));
    writeFileSync(join(inventoryDir, 'archive-manifest.json'), JSON.stringify({ entries: [], liveGeneration }));
    if (extraChain) {
      mkdirSync(join(inventoryDir, 'fixture-chain-two'), { recursive: true });
      writeFileSync(join(inventoryDir, 'fixture-chain-two', 'addresses.json'), JSON.stringify({ ...record.addresses, diamond: ADDR(0xd1b) }));
    } else rmSync(join(inventoryDir, 'fixture-chain-two'), { recursive: true, force: true });
  };
  return { M, inventoryDir, candidatesFile, commitsAsked: ASKED, writeInventory };
}

test('T-H — the build-candidate request is left untouched by a publication the INVENTORY re-validation (a live artifact published, a record added) or the REGRESSION guard refuses; the same run with neither refusal writes it', async (t) => {
  const { M, candidatesFile, commitsAsked, writeInventory } = await collectorWithInventory(t);
  const table = checkoutStorageRead();
  assert.ok(table.ok, table.reason);
  const scratch = mkdtempSync(join(tmpdir(), 'census-candidates-guards-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // one writer with code no era built, cut at `iso`: the judge leaves it unattributed, so the run asks about the commits around `iso`
  const artifactCutAt = (iso) => {
    const L = checkoutTableLedger(table);
    L.flags.loupeRouted = true;
    L.provenance = { read: true, facets: [{ address: A.rogue, sources: ['cut-history'], codeHash: H(0xbad) }], loupe: [], loupeReadFailed: false, cutFacetHost: null, recorded: { records: [], facets: [], deployedAt: [] } };
    L.cutHistory = { verdict: 'read', cuts: 1, constructorCutSeen: true, constructorCutEvidence: 'fixture', addresses: [A.rogue], initializers: [], blocksOf: { [A.rogue]: ['10'] }, blockTimestamps: { 10: { iso, estimated: false } }, unreadableBlocks: [] };
    return toJson({ generatedAt: 'fixture', schema: 2, proofStandard: 'provenance', results: [{ chainSlug: 'fixture-chain', deployment: 'live', schema: 2, ledger: L }] });
  };
  /** One `--rejudge` as main() runs it: the start snapshot, then `between` (what changes while the run reads), then the re-judgement. */
  let n = 0;
  const run = async ({ iso, between = () => {}, outDirFiles = {} }) => {
    n += 1;
    const sourcePath = join(scratch, `committed-${n}.json`);
    writeFileSync(sourcePath, JSON.stringify(artifactCutAt(iso)));
    const outDir = join(scratch, `out-${n}`);
    mkdirSync(outDir);
    for (const [f, text] of Object.entries(outDirFiles)) writeFileSync(join(outDir, f), text);
    const everything = M.startSnapshot();
    between();
    const saved = { exitCode: process.exitCode, err: process.stderr.write, out: process.stdout.write };
    process.stderr.write = () => true;
    process.stdout.write = () => true;
    commitsAsked.length = 0;
    try {
      const outcome = await M.rejudge({ everything, deployments: everything, outDir, sourcePath }).then(() => ({ error: null }), (error) => ({ error }));
      return { message: outcome.error?.message ?? '', asked: [...commitsAsked], outDir };
    } finally {
      process.stderr.write = saved.err;
      process.stdout.write = saved.out;
      process.exitCode = saved.exitCode;
    }
  };
  const candidatesText = () => (existsSync(candidatesFile) ? readFileSync(candidatesFile, 'utf8') : null);

  // the control: no refusal — the artifact is published and the request written, so the harness reaches the write
  writeInventory();
  const kept = await run({ iso: '2026-08-01T00:00:00Z' });
  assert.equal(kept.message, '', `the control run was refused: ${kept.message}`);
  assert.ok(existsSync(join(kept.outDir, 'grandfathered-custody-census.json')), 'the control run published no artifact');
  const written = candidatesText();
  assert.ok(written?.includes('around-2026-08-01T00:00:00Z'), 'the control run wrote no build-candidate request — the refusals below would prove nothing');

  // each refusal proposes a commit the file does not hold, so a write would change it
  const refusals = [
    ['the inventory re-validation: a live artifact was published while the run read', { iso: '2026-08-02T00:00:00Z', between: () => writeInventory({ liveGeneration: 1 }) }, /a live artifact was published while this run was scanning/],
    ['the inventory re-validation: a record was added while the run read', { iso: '2026-08-03T00:00:00Z', between: () => writeInventory({ extraChain: true }) }, /the deployment inventory changed while this run was scanning \(added: fixture-chain-two/],
    // a newer census committed at the target: the ancestry walk has nothing to prove downward, so the regression guard is the one that refuses
    ['the regression guard: a newer census is already committed', { iso: '2026-08-04T00:00:00Z', outDirFiles: { 'grandfathered-custody-census.json': JSON.stringify({ schema: 2, results: [{ chainSlug: 'fixture-chain', deployment: 'live', schema: 2, atBlock: '2000', atBlockHash: H(0xb10d) }] }) } }, /refusing to replace .*a newer census is already committed there/],
  ];
  for (const [what, spec, refusedBy] of refusals) {
    writeInventory();
    const r = await run(spec);
    assert.match(r.message, refusedBy, `${what}: the run was not refused by that guard (${r.message || 'it published'})`);
    assert.deepEqual(r.asked, [spec.iso], `${what}: the run proposed no build candidate — the cell would prove nothing`);
    assert.equal(candidatesText(), written, `${what}: a publication that guard refused changed the build-candidate request`);
    assert.deepEqual(readdirSync(r.outDir).sort(), Object.keys(spec.outDirFiles ?? {}).sort(), `${what}: a refused publication wrote into the output directory`);
  }
});
