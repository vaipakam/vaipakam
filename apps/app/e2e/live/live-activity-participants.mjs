/**
 * WATCH-ONLY live review of the Activity page's admission rule (#2703).
 *
 * The claim under review: a wallet's Activity page shows an event when it
 * concerns one of the wallet's loans, or the wallet is one of its
 * participants by the shared rule (`@vaipakam/lib/activityParticipants`),
 * and never merely because the wallet's address appears somewhere in the
 * event's args. The unit tests prove the rule; only the deployed page,
 * reading the deployed indexer, can show that the page applies it.
 *
 * How:
 *   1. Read each chain's public activity feed (the same window the page
 *      scans) and pick wallets worth observing: the one the feed names most
 *      often WITHOUT admitting it (a keeper being permitted, a role being
 *      granted), and the one it admits most often.
 *   2. Open `/activity` connected as each, through a WATCH-ONLY wallet:
 *      the page sees the wallet connected, this process holds no key for
 *      it, and every signing or sending request is refused and recorded.
 *   3. Expand the feed fully, read every row's transaction link, and judge
 *      it against the bodies THE PAGE ITSELF received from the indexer (its
 *      own `/activity` scan and its own participation read), so a feed that
 *      moved during the visit cannot be mistaken for a defect.
 *
 * Findings (exit 1): a rendered transaction no event admits (named
 * separately when the retired address-in-args rule would have shown it); an
 * admitted transaction the page did not render; the page reading another
 * chain than the wallet's; the page showing its unavailable state over
 * answers that arrived; the page attempting a write.
 *
 * BLOCKED (exit 2): the feed could not be read, no wallet worth observing,
 * the page never settled on its input, or the run did not exercise BOTH
 * halves of the claim (a wallet's admitted rows rendered, AND a transaction
 * naming a wallet without admitting it left out). A run that checked only
 * one half says which, and does not pass.
 *
 * No secrets and no wallet file:
 *
 *   SITE_URL=https://app.vaipakam.com node live-activity-participants.mjs
 *   ACTIVITY_CHAIN_IDS=84532 node live-activity-participants.mjs
 *   ACTIVITY_ADDRESSES=0xabc…,0xdef… node live-activity-participants.mjs
 *   ACTIVITY_MAX_WALLETS=3 node live-activity-participants.mjs
 *
 * The rule is the TypeScript library itself, loaded through tsx at run
 * time, so this drive never carries a copy of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, isAddress } from 'viem';
import {
  CHAINS,
  LiveSetupError,
  blocked,
  blockedSync,
  ensureConnected,
  exitWithVerdict,
  indexerOrigin,
  launch,
  precondition,
  requireSiteUrl,
} from './driver.mjs';
import {
  compareRendered,
  expectedRows,
  lastChain,
  lastScan,
  namedAddresses,
  pickCandidates,
  renderedRows,
} from './activityAdmission.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = requireSiteUrl().replace(/\/+$/, '');
const INDEXER = indexerOrigin();

// ── Configuration, refused before anything runs ─────────────────────────
const CHAIN_IDS = (process.env.ACTIVITY_CHAIN_IDS ?? '84532,421614')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
for (const id of CHAIN_IDS) {
  if (!CHAINS[id]) blockedSync(`ACTIVITY_CHAIN_IDS names chain ${id}, which the driver has no RPC for`);
}
if (CHAIN_IDS.length === 0) blockedSync('ACTIVITY_CHAIN_IDS selected no chains — nothing to review');
const MAX_WALLETS = Number(process.env.ACTIVITY_MAX_WALLETS ?? '2');
if (!Number.isInteger(MAX_WALLETS) || MAX_WALLETS < 1) {
  blockedSync(`ACTIVITY_MAX_WALLETS must be a whole number of at least 1 (got ${process.env.ACTIVITY_MAX_WALLETS})`);
}
const ADDRESSES = (process.env.ACTIVITY_ADDRESSES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const a of ADDRESSES) {
  if (!isAddress(a, { strict: false }))
    blockedSync(`ACTIVITY_ADDRESSES carries ${JSON.stringify(a)}, which is not an address`);
}

// The page's own scan: up to five pages of 100 (Activity.tsx). Discovery
// reads the same window, so a candidate's rows are the ones the page sees.
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const SETTLE_MS = 90_000;
const QUIET_MS = 3_000;
const MAX_HARVESTS = 3;

const copy = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../src/i18n/locales/en.json'), 'utf8')).copy.activity;

// ── The rule, from the library ──────────────────────────────────────────
let participants;
try {
  const { register } = await import('tsx/esm/api');
  register();
  ({ activityParticipants: participants } = await import('@vaipakam/lib/activityParticipants'));
} catch (err) {
  blockedSync(`cannot load the participants rule (@vaipakam/lib through tsx): ${err.message}`);
}

// ── Discovery: the public feed, the same window the page scans ──────────
async function readFeed(chainId) {
  const events = [];
  let before = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ chainId: String(chainId), limit: String(PAGE_LIMIT) });
    if (before) params.set('before', before);
    const res = await fetch(`${INDEXER}/activity?${params}`);
    if (!res.ok) throw new Error(`${INDEXER}/activity answered HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.events)) throw new Error('the activity body carries no events array');
    events.push(...body.events);
    if (body.nextBefore === null || body.nextBefore === undefined) break;
    before = body.nextBefore;
  }
  return events;
}

/** Whether an address can be a wallet: no code, or an EIP-7702 delegation
 *  (an EOA whose code is the 0xef0100 designator). */
async function walletsAmong(chainId, addresses) {
  const { chain, rpc } = CHAINS[chainId];
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const out = new Set();
  for (const address of addresses) {
    const code = await pub.getCode({ address });
    if (!code || code === '0x' || code.toLowerCase().startsWith('0xef0100')) out.add(address);
  }
  return out;
}

// ── One observation ─────────────────────────────────────────────────────
const findings = [];
const observations = [];
let firstVisitDone = false;

function finding(chainId, address, what, detail) {
  findings.push({ chainId, address, what, detail });
  console.log(`FAIL [${chainId} ${address}] ${what}${detail ? ' — ' + detail : ''}`);
}

/** The page's own indexer traffic, by kind, in arrival order: the feed
 *  scan, and the three loan legs its participation filter is built from
 *  (`Activity.tsx`: the historical participation ids, and `useMyLoansFull`'s
 *  lender and borrower lists; its fourth leg, the chain's own enumeration, is
 *  an RPC read, see `expectedRows`). */
function watchIndexer(page) {
  const activity = [];
  const participation = [];
  const indexedLoans = { lender: [], borrower: [] };
  const reads = new Set();
  const failures = [];
  let lastStart = Date.now();
  let inFlight = 0;
  // The page's own data requests only (fetch / XHR), never a document
  // navigation: the site's `/activity` route shares the feed's pathname, and
  // its HTML is not an indexer answer.
  const kindOf = (req) => {
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return null;
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return null;
    }
    if (u.pathname === '/activity') return { kind: 'activity', u };
    if (u.pathname === '/loans/by-participant') return { kind: 'participation', u };
    const side = /^\/loans\/by-(lender|borrower)\/(0x[0-9a-fA-F]{40})$/.exec(u.pathname);
    if (side) return { kind: 'indexedLoans', side: side[1], wallet: side[2].toLowerCase(), u };
    return null;
  };
  page.on('request', (req) => {
    if (!kindOf(req)) return;
    inFlight += 1;
    lastStart = Date.now();
  });
  const finished = (req) => {
    if (kindOf(req)) inFlight = Math.max(0, inFlight - 1);
  };
  page.on('requestfailed', (req) => {
    if (!kindOf(req)) return;
    finished(req);
    failures.push(`${req.url().slice(0, 200)} — ${req.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (res) => {
    const k = kindOf(res.request());
    if (!k) return;
    const read = (async () => {
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* recorded as an unreadable body */
      }
      const entry = { status: res.status(), json, at: Date.now() };
      if (k.kind === 'activity') {
        activity.push({
          ...entry,
          before: k.u.searchParams.get('before'),
          chainId: Number(k.u.searchParams.get('chainId')),
          events: Array.isArray(json?.events) ? json.events : [],
          nextBefore: json?.nextBefore ?? null,
        });
      } else if (k.kind === 'indexedLoans') {
        indexedLoans[k.side].push({
          ...entry,
          wallet: k.wallet,
          before: k.u.searchParams.get('before'),
          chainId: Number(k.u.searchParams.get('chainId')),
          loanIds: Array.isArray(json?.loans) ? json.loans.map((l) => Number(l?.loanId)) : [],
          nextBefore: json?.nextBefore ?? null,
        });
      } else {
        participation.push({ ...entry, wallet: k.u.searchParams.get('wallet') });
      }
    })().finally(() => finished(res.request()));
    reads.add(read);
  });
  return {
    activity,
    participation,
    indexedLoans,
    failures,
    async quiet(budgetMs) {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        await Promise.allSettled([...reads]);
        if (inFlight === 0 && Date.now() - lastStart >= QUIET_MS) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    },
    startedSince: (t) => lastStart > t,
  };
}

/** Which terminal state the page shows, or null while it is still loading. */
async function pageState(page) {
  return page.evaluate(
    ({ empty, truncatedEmpty, unavailable }) => {
      const text = document.body.innerText;
      if (text.includes(unavailable)) return 'unavailable';
      if (document.querySelector('.row-list .activity-row')) return 'rows';
      if (text.includes(empty) || text.includes(truncatedEmpty)) return 'empty';
      return null;
    },
    { empty: copy.empty, truncatedEmpty: copy.truncatedEmpty, unavailable: copy.unavailable },
  );
}

async function harvest(page) {
  // Reveal every row: the feed shows 25 at a time behind "Load older activity".
  for (let i = 0; i < 60; i++) {
    const more = page.getByRole('button', { name: copy.loadMore });
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click();
    await page.waitForTimeout(150);
  }
  return page.$$eval('.row-list .activity-row', (rows) =>
    rows.map((r) => ({
      observation: r.getAttribute('data-testid') === 'activity-repair-observation',
      href: r.querySelector('a.activity-tx')?.getAttribute('href') ?? null,
    })),
  );
}

async function observe(chainId, address, picked) {
  const me = address.toLowerCase();
  const tag = `${chainId} ${me}`;
  let session;
  try {
    session = await launch({
      role: `watch-${chainId}`,
      watchAddress: address,
      startChainId: chainId,
      freshProfile: true,
      onSetupFailure: 'throw',
    });
  } catch (err) {
    if (err instanceof LiveSetupError) {
      observations.push({ chainId, address: me, blocked: err.message });
      console.log(`BLOCKED [${tag}] ${err.message}`);
      return;
    }
    throw err;
  }
  const { page, blockedRequests, done } = session;
  const traffic = watchIndexer(page);
  const record = { chainId, address: me, picked };
  observations.push(record);
  try {
    if (!firstVisitDone) {
      await precondition('opening /activity', async () => {
        const resp = await page.goto(`${SITE}/activity`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (resp && resp.status() >= 400) throw new Error(`${SITE}/activity answered HTTP ${resp.status()}`);
      });
      firstVisitDone = true;
    } else {
      const resp = await page.goto(`${SITE}/activity`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (resp && resp.status() >= 400) {
        finding(chainId, me, '/activity did not load', `HTTP ${resp.status()}`);
        return;
      }
    }
    await ensureConnected(page);

    let state = null;
    const until = Date.now() + SETTLE_MS;
    while (Date.now() < until && state === null) {
      state = await pageState(page);
      if (state === null) await page.waitForTimeout(500);
    }
    if (state === null) {
      record.blocked = 'the page never left its loading state';
      console.log(`BLOCKED [${tag}] ${record.blocked}`);
      return;
    }

    // Judge the page by the scan it rendered: wait for its indexer traffic
    // to go quiet, read the rows, and start over if a refetch began while
    // they were being read.
    let rows = null;
    for (let attempt = 0; attempt < MAX_HARVESTS && rows === null; attempt++) {
      if (!(await traffic.quiet(30_000))) continue;
      const mark = Date.now();
      const read = await harvest(page);
      if (!traffic.startedSince(mark)) rows = read;
    }
    if (rows === null) {
      record.blocked = 'the page kept refetching its feed while it was being read';
      console.log(`BLOCKED [${tag}] ${record.blocked}`);
      return;
    }
    state = await pageState(page);

    const scan = lastScan(traffic.activity);
    const participation = traffic.participation.at(-1) ?? null;
    const legs = { lender: lastChain(traffic.indexedLoans.lender), borrower: lastChain(traffic.indexedLoans.borrower) };
    const answeredOk = (r) => r.status === 200 && r.json !== null;
    if (state === 'unavailable') {
      // Every indexer read the page made answered, so the page had what it
      // needed. Conservative: one failed read anywhere in the visit and the
      // unavailable state is not judged (the chain leg alone cannot make the
      // page unavailable while the indexer legs answer — useMyLoansFull).
      const answered =
        scan !== null &&
        legs.lender !== null &&
        legs.borrower !== null &&
        traffic.activity.every(answeredOk) &&
        traffic.participation.length > 0 &&
        traffic.participation.every((r) => answeredOk(r) && Array.isArray(r.json.loanIds)) &&
        [...traffic.indexedLoans.lender, ...traffic.indexedLoans.borrower].every(answeredOk);
      if (answered) finding(chainId, me, 'the page showed its unavailable state over answers that arrived');
      else {
        record.blocked = `the indexer did not answer the page${traffic.failures.length ? ': ' + traffic.failures.join('; ') : ''}`;
        console.log(`BLOCKED [${tag}] ${record.blocked}`);
      }
      return;
    }
    if (
      scan === null ||
      participation === null ||
      !Array.isArray(participation.json?.loanIds) ||
      legs.lender === null ||
      legs.borrower === null ||
      ![...legs.lender, ...legs.borrower].every(answeredOk)
    ) {
      record.blocked = 'the page rendered without a readable scan and loan legs to judge it by';
      console.log(`BLOCKED [${tag}] ${record.blocked}`);
      return;
    }
    if (scan.chainIds.some((id) => id !== chainId) || Number(participation.json.chainId) !== chainId) {
      finding(
        chainId,
        me,
        'the page read another chain than the connected wallet’s',
        `activity ${scan.chainIds.join(',')}, participation ${participation.json.chainId}`,
      );
      return;
    }
    const legPages = [...legs.lender, ...legs.borrower];
    if (participation.wallet !== me || legPages.some((r) => r.wallet !== me)) {
      finding(
        chainId,
        me,
        'the page read another wallet’s loans',
        [participation.wallet, ...legPages.map((r) => r.wallet)].join(', '),
      );
      return;
    }
    if (legPages.some((r) => r.chainId !== chainId)) {
      finding(chainId, me, 'the page read another chain’s loans', legPages.map((r) => r.chainId).join(', '));
      return;
    }

    // The loan set the oracle can see: every indexer leg the page read.
    const loanIds = new Set(
      [...participation.json.loanIds, ...legPages.flatMap((r) => r.loanIds)].filter((v) => Number.isInteger(v)),
    );
    const expected = expectedRows({ events: scan.events, me, loanIds, participants });
    const rendered = renderedRows(rows);
    const cmp = compareRendered(expected, rendered);
    Object.assign(record, {
      state,
      scanPages: scan.pages,
      scanEvents: scan.events.length,
      loanIds: [...loanIds],
      admitted: expected.admitted.size,
      namedOnly: expected.namedOnly.size,
      namedOnlyKinds: [...new Set([...expected.namedOnly.values()].flatMap((r) => r.kinds))],
      renderedTx: rendered.tx.size,
      undetermined: cmp.undetermined,
      renderedWithoutTx: rendered.withoutTx,
      repairObservations: rendered.observations,
      compare: cmp,
    });
    console.log(
      `[${tag}] ${state}: ${rendered.tx.size} transaction row(s) rendered, ${expected.admitted.size} admitted by the rule over the page's own scan ` +
        `(${scan.events.length} events, ${scan.pages} page(s)); ${expected.namedOnly.size} transaction(s) name this wallet without admitting it` +
        (record.namedOnlyKinds.length ? ` (${record.namedOnlyKinds.join(', ')})` : ''),
    );
    for (const tx of cmp.namedShown) finding(chainId, me, 'a row the address-in-args rule would show is rendered', tx);
    for (const tx of cmp.unexpected.filter((t) => !cmp.namedShown.includes(t))) {
      finding(chainId, me, 'a rendered row that no event admits', tx);
    }
    for (const tx of cmp.missing) finding(chainId, me, 'an admitted transaction is not rendered', tx);
    if (cmp.withoutTxMismatch) {
      finding(
        chainId,
        me,
        'rows without a transaction link do not match admitted events without a hash',
        JSON.stringify(cmp.withoutTxMismatch),
      );
    }
    for (const href of cmp.unreadable) finding(chainId, me, 'a transaction link this review could not read', href);
    if (cmp.undetermined.length > 0) {
      console.log(
        `UNDETERMINED [${tag}] ${cmp.undetermined.length} rendered row(s) only a loan outside the indexer legs could admit` +
          ' (the page also adds the loans the wallet holds on chain, which this review does not read)',
      );
    }
  } finally {
    // On EVERY exit, the early ones included: a write the page attempted is
    // a finding whatever else stopped the observation. After `done()`, which
    // lets in-flight requests land first.
    await done().catch(() => {});
    if (blockedRequests.length > 0) {
      finding(
        chainId,
        me,
        'the page attempted a write in a watch-only session',
        blockedRequests.map((b) => b.reason).join('; '),
      );
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────
// Every chain's targets are settled BEFORE any browser opens, so a feed that
// cannot be read stops the run while nothing has been observed, rather than
// discarding a finding an earlier chain already made.
const plan = [];
for (const chainId of CHAIN_IDS) {
  if (ADDRESSES.length > 0) {
    for (const address of ADDRESSES) plan.push({ chainId, address: address.toLowerCase(), picked: 'given' });
    continue;
  }
  const events = await precondition(`reading chain ${chainId}'s activity feed`, () => readFeed(chainId));
  const wallets = await precondition(`telling wallets from contracts on chain ${chainId}`, () =>
    walletsAmong(chainId, [...namedAddresses(events)]),
  );
  const picks = pickCandidates({ events, participants, isWallet: (a) => wallets.has(a), max: MAX_WALLETS });
  if (picks.length === 0) console.log(`[${chainId}] no wallet in the feed's window to observe`);
  for (const c of picks) {
    plan.push({ chainId, address: c.address, picked: `feed: ${c.admitted} admitted, ${c.namedOnly} named only` });
  }
}
for (const t of plan) await observe(t.chainId, t.address, t.picked);

// ── Verdict ─────────────────────────────────────────────────────────────
const judged = observations.filter((o) => o.compare);
const admittedShown = judged.reduce((n, o) => n + o.compare.admittedShown.length, 0);
const exclusionsHeld = judged.reduce((n, o) => n + o.compare.exclusionsHeld.length, 0);
const report = {
  site: SITE,
  indexer: INDEXER,
  chains: CHAIN_IDS,
  observations,
  findings,
  admittedShown,
  exclusionsHeld,
};
const outDir = path.join(HERE, 'shots', 'activity-participants');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log(
  `\n${judged.length} of ${observations.length} wallet page(s) judged; ${admittedShown} admitted transaction row(s) rendered; ` +
    `${exclusionsHeld} transaction(s) naming a wallet without admitting it left out. Report: shots/activity-participants/report.json`,
);
if (findings.length > 0) {
  console.log(`${findings.length} finding(s)`);
  await exitWithVerdict(1);
}
const notJudged = [
  ...observations.filter((o) => o.blocked),
  ...judged
    .filter((o) => o.undetermined.length > 0)
    .map((o) => ({
      ...o,
      blocked: `${o.undetermined.length} rendered row(s) could not be judged: only a loan outside the indexer legs could admit them`,
    })),
];
if (notJudged.length > 0) {
  await blocked(
    `${notJudged.length} wallet page(s) could not be judged: ` +
      notJudged.map((o) => `${o.chainId} ${o.address}: ${o.blocked}`).join('; '),
  );
}
if (admittedShown === 0 || exclusionsHeld === 0) {
  await blocked(
    `the run did not exercise both halves of the rule: ` +
      `${admittedShown === 0 ? 'no admitted row was rendered' : 'admission checked'}, ` +
      `${exclusionsHeld === 0 ? 'no transaction naming a wallet without admitting it was in view' : 'exclusion checked'}`,
  );
}
console.log('PASS');
await exitWithVerdict(0);
