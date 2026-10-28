#!/usr/bin/env node
/**
 * Is the indexer's scheduled ingest advancing? (#2469)
 *
 * WHY THIS EXISTS. A stalled ingest is silent. When Workers Builds published
 * an indexer build ahead of migration 0056, the schema gate did its job —
 * every scheduled tick declined, by name, until the migration was applied —
 * and the only place it said so was the Worker's own logs. The stall was
 * found by a stale screen. The indexer now answers `GET /health/ingest`
 * with the facts (apps/indexer/src/healthRoutes.ts); this script is the
 * prober that reads them from OUTSIDE the Worker and fails, loudly, when
 * they say ingest has stopped.
 *
 * WHY HERE AND NOT IN A WORKER. The account's Cloudflare cron triggers are
 * all spoken for (docs/ops/CloudflareCronSlots.md), and a watcher inside the
 * indexer could not report the indexer's own crash or a removed trigger.
 * A scheduled GitHub Actions run needs neither.
 *
 * A FAILED RUN IS NOT THE ALERT. GitHub notifies only the account that last
 * edited the cron line, and only if it has Actions notifications on. The
 * dependable path is the workflow's `alert` job: an issue assigned to the
 * operator (plus an optional ops-chat post). Do not remove that job on the
 * assumption that a red run reaches someone (#2482 r6).
 *
 * WHAT FAILS (exit 1), each named in the output:
 *   - a watched chain whose diamond cursor has not advanced for longer than
 *     the threshold, or that the route does not report at all;
 *   - the schema gate reporting `pending` (naming the missing migrations —
 *     the 0056 incident) or `unknown` (the migration record unreadable);
 *   - the route unreachable, non-200, or answering something that is not
 *     the documented shape — a probe that cannot read the facts is not a
 *     healthy answer;
 *   - (#2337) any loan-status announcement the indexer recorded as
 *     disagreeing with the status diagram (`lifecycle` on the route — a
 *     contract defect or an indexer drifted from the contracts), on ANY
 *     chain the route reports, unless it is listed in
 *     LIFECYCLE_ACKNOWLEDGED; or the route not reporting that check at all.
 *
 * ACKNOWLEDGING A LIFECYCLE VIOLATION. A recorded violation stays recorded:
 * it is the indexer's record of something the chain announced, and nothing
 * on the route forgets it. Once an operator has investigated one, they list
 * it in the workflow's LIFECYCLE_ACKNOWLEDGED as `chainId:txHash:logIndex`
 * (comma-separated), in a reviewed commit, and the probe stops paging on
 * that one. A violation beyond the route's named list cannot be
 * acknowledged, because it cannot be named, and always counts.
 *
 * WHICH CHAINS ARE WATCHED (#2498): the set the indexer reports it is
 * CONFIGURED to scan (`configured.chains` — a deployment artifact and an RPC
 * binding present), minus INGEST_IDLE_CHAINS, the explicit opt-out for a
 * chain that is configured but intentionally idle. This script keeps no list
 * of its own, so activating or restoring a chain in the indexer puts it under
 * watch with no workflow edit. An answer that does not report the set, or
 * that leaves nothing to watch, fails rather than passing on nothing.
 *
 * WHAT IT DOES NOT JUDGE: chains outside the watched set (the route also
 * reports cursors of chains no longer scanned, which stand still forever), and
 * whether the data ingested is correct — only that ingest is moving.
 *
 *   INDEXER_ORIGIN=https://indexer.vaipakam.com \
 *   INGEST_IDLE_CHAINS= INGEST_STALE_SECONDS=900 LIFECYCLE_ACKNOWLEDGED= \
 *     node .github/scripts/check-ingest-health.mjs
 *   node .github/scripts/check-ingest-health.mjs --selftest
 */

/**
 * The verdict on one `/health/ingest` answer. Pure, so the selftest pins it.
 *
 * @param {unknown} body the parsed response
 * @param {{ idle: number[], staleSeconds: number, acknowledged?: Set<string> }} opts
 *   `acknowledged` holds `chainId:txHash:logIndex` keys (parseAcknowledged).
 * @returns {{ key: string, text: string }[]} problems, empty when healthy. The
 *   `key` is STABLE across runs while the condition is unchanged (no ages or
 *   timestamps in it), so the workflow can tell a continuing stall from a
 *   changed one; `text` is what the operator reads.
 */
export function judgeIngestHealth(body, { idle, staleSeconds, acknowledged = new Set() }) {
  const problems = [];
  const add = (key, text) => problems.push({ key, text });
  if (!body || typeof body !== 'object' || !Array.isArray(body.chains) || !body.schema || !isCount(body.checkedAt)) {
    return [{ key: 'shape', text: 'the route answered, but not with the documented shape (checkedAt + schema + chains)' }];
  }
  const { schema } = body;
  if (schema.state === 'pending') {
    // Migration FILE NAMES only — the value came over the network and travels
    // into workflow outputs and the alert issue.
    const missing = Array.isArray(schema.missing)
      ? schema.missing.map((m) => (typeof m === 'string' && /^[0-9A-Za-z_.-]{1,80}$/.test(m) ? m : '(unprintable name)')).join(', ')
      : '(unnamed)';
    add(
      `pending:${missing}`,
      `schema gate PENDING — scheduled ingest is declining until these D1 migrations are applied: ${missing}. ` +
        'Apply them (cd apps/indexer && npx wrangler d1 migrations apply vaipakam-warm --remote); ingest resumes on the next tick.',
    );
  } else if (schema.state === 'unknown') {
    // Unknown to THIS request, not a confirmed outage (#2482 r7): the route's
    // own d1_migrations read failed, and a separate cron invocation may have
    // read it fine. The cursor ages below say whether ingest actually stopped.
    add('gate-unknown', 'schema gate UNCONFIRMED — this health request could not read d1_migrations, so whether scheduled ingest is declining is not known from it; the per-chain cursor ages are the evidence.');
  } else if (schema.state !== 'current') {
    add('gate-state', `schema gate state "${String(schema.state).replace(/[^0-9A-Za-z_-]/g, '?').slice(0, 40)}" is not one this probe knows`);
  }
  const chains = watchedChains(body, idle);
  if (chains === null) {
    add('configured-unreported', 'the route did not report the chains it is configured to scan, so which chains to watch is not known');
  } else if (chains.length === 0) {
    add('watch-nothing', 'no configured chain is left to watch (all are opted out, or none is configured) — a probe watching nothing is not a healthy answer');
  }
  for (const id of chains ?? []) {
    const c = body.chains.find((x) => x && x.chainId === id);
    if (!c) {
      // Absent says only that no cursor is recorded NOW: a never-scanned chain
      // and a cursor deleted to replay a chain look the same here (#2482 r6).
      add(`missing:${id}`, `chain ${id}: no diamond cursor is recorded — whether it was never scanned or its cursor was reset is not known from here`);
    } else if (typeof c.ageSeconds === 'number' && c.ageSeconds < 0) {
      add(`ahead:${id}`, `chain ${id}: the cursor's timestamp is ${-c.ageSeconds}s AHEAD of the indexer's clock — its freshness is unknown`);
    } else if (!isCount(c.ageSeconds) || !isCount(c.lastBlock) || !isCount(c.scannedAt)) {
      // A defaulted or corrupt row (a negative age, a missing block) must not
      // read as fresh: every documented field is a non-negative finite number.
      add(`invalid:${id}`, `chain ${id}: the route reported an incomplete or invalid cursor row`);
    } else if (c.ageSeconds > staleSeconds) {
      add(
        `stale:${id}`,
        `chain ${id}: ingest STALE — the cursor last advanced ${Math.round(c.ageSeconds / 60)} min ago ` +
          `(block ${c.lastBlock}), over the ${Math.round(staleSeconds / 60)} min threshold`,
      );
    }
  }
  judgeLifecycle(body.lifecycle, acknowledged, add);
  return problems;
}

const TX_HASH = /^0x[0-9a-f]{64}$/;
/** The reasons the indexer records; anything else is not echoed. */
const LIFECYCLE_REASONS = ['edge', 'continuity', 'reinitiated'];

/**
 * #2337 — the loan-status check. Every chain the route reports is judged,
 * watched or not: a violation is a fact about what a chain announced, and a
 * chain that has stopped scanning still carries it.
 */
function judgeLifecycle(lifecycle, acknowledged, add) {
  if (lifecycle === undefined || lifecycle === null) {
    add(
      'lifecycle-unreported',
      'the route did not report the loan-status check (an indexer older than #2337, or migration 0080 not applied), so whether any loan moved outside the status diagram is not known',
    );
    return;
  }
  if (typeof lifecycle !== 'object' || !Array.isArray(lifecycle.chains)) {
    add('lifecycle-shape', 'the route reported the loan-status check, but not in the documented shape');
    return;
  }
  for (const c of lifecycle.chains) {
    if (!c || !Number.isInteger(c.chainId) || c.chainId <= 0 || !isCount(c.violations) || !Array.isArray(c.listed)) {
      add('lifecycle-shape', 'the route reported the loan-status check, but not in the documented shape');
      return;
    }
    if (c.violations === 0) continue;
    const named = c.listed.filter((v) => v && TX_HASH.test(v.txHash) && isCount(v.logIndex));
    // A row that cannot be named cannot be acknowledged, so it counts.
    const open = named.filter((v) => !acknowledged.has(`${c.chainId}:${v.txHash}:${v.logIndex}`));
    const unnamed = Math.max(0, c.violations - named.length);
    const n = open.length + unnamed;
    if (n === 0) continue;
    const first = open[0];
    const detail = first
      ? ` — first: loan ${isCount(first.loanId) ? first.loanId : '?'}, status ${fmtStatus(first.from)} → ${fmtStatus(first.to)}` +
        ` (${(Array.isArray(first.reasons) ? first.reasons : []).map((r) => (LIFECYCLE_REASONS.includes(r) ? r : '(unknown reason)')).join(', ') || 'no reason given'})` +
        ` in block ${isCount(first.blockNumber) ? first.blockNumber : '?'}, tx ${first.txHash} log ${first.logIndex}`
      : ' — none of them could be named by the route';
    add(
      `lifecycle:${c.chainId}:${n}`,
      `chain ${c.chainId}: ${n} loan-status announcement(s) disagree with the status diagram and are not acknowledged${detail}. ` +
        'A contract defect or an indexer drifted from the contracts; investigate, then acknowledge it in LIFECYCLE_ACKNOWLEDGED.',
    );
  }
}

/** A status number from the network, printed only as a number. */
function fmtStatus(v) {
  return Number.isInteger(v) && v >= 0 && v < 1000 ? String(v) : '?';
}

/** Parse LIFECYCLE_ACKNOWLEDGED — investigated violations, as
 *  `chainId:txHash:logIndex`. A malformed entry is refused rather than
 *  silently acknowledging nothing. */
export function parseAcknowledged(raw) {
  const out = new Set();
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([1-9]\d*):(0x[0-9a-fA-F]{64}):(\d+)$/.exec(entry);
    if (!m) throw new Error(`LIFECYCLE_ACKNOWLEDGED entries must be chainId:txHash:logIndex, got "${entry}"`);
    out.add(`${m[1]}:${m[2].toLowerCase()}:${Number(m[3])}`);
  }
  return out;
}

/** A non-negative finite number — every count and unix time the route reports. */
function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** The chains to judge: the configured set the route reports, minus the
 *  opted-out ones. Null when the route reports no well-formed set. */
export function watchedChains(body, idle) {
  const set = body?.configured?.chains;
  if (!Array.isArray(set) || !set.every((id) => Number.isInteger(id) && id > 0)) return null;
  return set.filter((id) => !idle.includes(id));
}

/** Parse INGEST_IDLE_CHAINS — the explicit opt-out. Empty is the normal case
 *  (watch every configured chain); a malformed value is refused rather than
 *  read as "opt out of nothing". */
export function parseIdleChains(raw) {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.every((s) => /^\d+$/.test(s))) {
    throw new Error(`INGEST_IDLE_CHAINS must be a comma-separated list of chain ids, got "${raw ?? ''}"`);
  }
  return ids.map(Number);
}

function selftest() {
  const ok = (cond, what) => {
    if (!cond) throw new Error(`selftest: ${what}`);
  };
  const opts = { idle: [], staleSeconds: 900 };
  const healthy = {
    checkedAt: 1000,
    schema: { state: 'current' },
    configured: { chains: [84532, 421614], basis: 'x' },
    chains: [
      { chainId: 97, lastBlock: 1, scannedAt: 0, ageSeconds: 999_999 }, // not watched
      { chainId: 421614, lastBlock: 5, scannedAt: 920, ageSeconds: 80 },
      { chainId: 84532, lastBlock: 9, scannedAt: 919, ageSeconds: 81 },
    ],
    lifecycle: { basis: 'x', listLimit: 50, chains: [{ chainId: 84532, trackedLoans: 3, trackedFromInitiation: 3, violations: 0, listed: [], truncated: false }] },
  };
  ok(judgeIngestHealth(healthy, opts).length === 0, 'a current gate and fresh watched chains pass, an unwatched stale chain is ignored');
  const stale = { ...healthy, chains: healthy.chains.map((c) => (c.chainId === 84532 ? { ...c, ageSeconds: 3600 } : c)) };
  const s = judgeIngestHealth(stale, opts);
  ok(s.length === 1 && s[0].key === 'stale:84532' && s[0].text.includes('STALE'), 'a watched chain past the threshold fails, named');
  const hostile = { ...healthy, schema: { state: 'pending', missing: ['0058_ok.sql', 'x\nEOF\nevil=1'] } };
  ok(judgeIngestHealth(hostile, opts).every((p) => !p.text.includes('\n') && !p.text.includes('evil') && !p.key.includes('evil')), 'a migration name that is not a file name is never echoed');
  const pending = { ...healthy, schema: { state: 'pending', missing: ['0058_init_terms_unbacked.sql'] } };
  ok(judgeIngestHealth(pending, opts).some((p) => p.text.includes('0058_init_terms_unbacked.sql')), 'a pending gate fails, naming the migration');
  ok(judgeIngestHealth({ ...healthy, schema: { state: 'unknown' } }, opts).length === 1, 'an unknown gate fails');
  const missing = { ...healthy, chains: healthy.chains.filter((c) => c.chainId !== 421614) };
  ok(judgeIngestHealth(missing, opts).some((p) => p.text.includes('421614')), 'a watched chain absent from the answer fails');
  ok(judgeIngestHealth({ error: 'x' }, opts).length === 1, 'an answer of the wrong shape fails');
  ok(judgeIngestHealth(null, opts).length === 1, 'no answer fails');
  ok(judgeIngestHealth({ ...healthy, chains: [{ chainId: 84532 }, ...healthy.chains.filter((c) => c.chainId === 421614)] }, opts).length === 1, 'a chain with no age fails');
  const partial = { ...healthy, chains: [{ chainId: 84532, ageSeconds: 0 }, ...healthy.chains.filter((c) => c.chainId === 421614)] };
  ok(judgeIngestHealth(partial, opts).some((p) => p.text.includes('84532')), 'a partial row (age only) fails rather than reading as fresh');
  const negative = { ...healthy, chains: healthy.chains.map((c) => (c.chainId === 84532 ? { ...c, ageSeconds: -1 } : c)) };
  ok(judgeIngestHealth(negative, opts).some((p) => p.text.includes('84532') && p.text.includes('AHEAD')), 'a negative age fails, as unknown freshness');
  const { checkedAt: _omit, ...noChecked } = healthy;
  ok(judgeIngestHealth(noChecked, opts).length === 1, 'an answer without checkedAt fails');
  const later = { ...stale, checkedAt: 2000, chains: stale.chains.map((c) => (c.chainId === 84532 ? { ...c, ageSeconds: 4200 } : c)) };
  ok(
    JSON.stringify(judgeIngestHealth(later, opts).map((p) => p.key)) === JSON.stringify(s.map((p) => p.key)),
    'a continuing stall keeps the same key while its age grows',
  );
  const both = { ...stale, schema: { state: 'pending', missing: ['0059_x.sql'] } };
  ok(judgeIngestHealth(both, opts).map((p) => p.key).join(',') !== s.map((p) => p.key).join(','), 'a changed condition changes the keys');
  // #2498 — the watched set is the indexer's configured set.
  const added = { ...healthy, configured: { chains: [84532, 421614, 97], basis: 'x' } };
  ok(judgeIngestHealth(added, opts).some((p) => p.key === 'stale:97'), 'a chain the indexer starts scanning is watched with no list edit');
  ok(judgeIngestHealth(added, { ...opts, idle: [97] }).length === 0, 'an opted-out idle chain is not judged');
  const { configured: _c, ...unreported } = healthy;
  ok(judgeIngestHealth(unreported, opts).some((p) => p.key === 'configured-unreported'), 'an answer without the configured set fails');
  ok(
    judgeIngestHealth({ ...healthy, configured: { chains: ['84532'] } }, opts).some((p) => p.key === 'configured-unreported'),
    'a malformed configured set fails',
  );
  ok(
    judgeIngestHealth(healthy, { ...opts, idle: [84532, 421614] }).some((p) => p.key === 'watch-nothing'),
    'opting every chain out fails, never "watch nothing" and pass',
  );
  // #2337 — the loan-status check.
  const tx = `0x${'ab'.repeat(32)}`;
  const violation = { txHash: tx, logIndex: 4, loanId: 7, blockNumber: 105, event: 'LoanStatusChanged', from: 1, to: 3, expected: 2, reasons: ['continuity'], blockTime: 1 };
  const bad = (chainId, extra = {}) => ({
    ...healthy,
    lifecycle: { ...healthy.lifecycle, chains: [{ chainId, trackedLoans: 1, trackedFromInitiation: 1, violations: 1, listed: [violation], truncated: false, ...extra }] },
  });
  const v = judgeIngestHealth(bad(97), opts);
  ok(v.length === 1 && v[0].key === 'lifecycle:97:1' && v[0].text.includes('loan 7') && v[0].text.includes(tx), 'a violation fails on any reported chain, watched or not, naming the loan and tx');
  ok(judgeIngestHealth(bad(97), { ...opts, acknowledged: parseAcknowledged(`97:${tx.toUpperCase().replace('0X', '0x')}:4`) }).length === 0, 'an acknowledged violation no longer fails');
  ok(judgeIngestHealth(bad(97), { ...opts, acknowledged: parseAcknowledged(`84532:${tx}:4`) }).length === 1, 'an acknowledgement is per chain');
  const beyond = judgeIngestHealth(bad(97, { violations: 60, truncated: true }), { ...opts, acknowledged: parseAcknowledged(`97:${tx}:4`) });
  ok(beyond.length === 1 && beyond[0].key === 'lifecycle:97:59', 'a violation beyond the named list cannot be acknowledged and counts');
  ok(judgeIngestHealth(bad(97, { violations: 2 }), opts)[0].key !== v[0].key, 'a new violation changes the key, so it notifies again');
  const hostileV = bad(97, { listed: [{ ...violation, reasons: ['edge\nevil'], from: 'x' }] });
  ok(judgeIngestHealth(hostileV, opts).every((p) => !p.text.includes('\n') && !p.text.includes('evil')), 'network text in a violation is never echoed');
  const { lifecycle: _l, ...noLifecycle } = healthy;
  ok(judgeIngestHealth(noLifecycle, opts).some((p) => p.key === 'lifecycle-unreported'), 'an answer without the loan-status check fails');
  ok(judgeIngestHealth({ ...healthy, lifecycle: null }, opts).some((p) => p.key === 'lifecycle-unreported'), 'a check the route could not read fails');
  ok(judgeIngestHealth({ ...healthy, lifecycle: { chains: [{ chainId: 97 }] } }, opts).some((p) => p.key === 'lifecycle-shape'), 'a malformed check fails');
  let ackThrew = false;
  try {
    parseAcknowledged('97:0x12:4');
  } catch {
    ackThrew = true;
  }
  ok(ackThrew, 'a malformed acknowledgement is refused');
  ok(parseAcknowledged('').size === 0, 'no acknowledgements parse as none');
  ok(JSON.stringify(parseIdleChains('')) === '[]', 'an empty opt-out list parses as none');
  ok(JSON.stringify(parseIdleChains('97, 11155111')) === '[97,11155111]', 'the opt-out list parses');
  let threw = false;
  try {
    parseIdleChains('97,abc');
  } catch {
    threw = true;
  }
  ok(threw, 'a malformed opt-out list is refused');
  console.log('check-ingest-health selftest: OK');
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const origin = process.env.INDEXER_ORIGIN;
  if (!origin) throw new Error('INDEXER_ORIGIN is required');
  const idle = parseIdleChains(process.env.INGEST_IDLE_CHAINS);
  const acknowledged = parseAcknowledged(process.env.LIFECYCLE_ACKNOWLEDGED);
  const staleSeconds = Number(process.env.INGEST_STALE_SECONDS ?? 900);
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) throw new Error('INGEST_STALE_SECONDS must be a positive number');
  const url = new URL('/health/ingest', origin);
  let problems;
  let body = null;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (res.status !== 200) {
      // The status only: the body is the network's text, and it would travel
      // into workflow outputs, the issue and the chat message.
      problems = [{ key: `http:${res.status}`, text: `${url} answered HTTP ${res.status}` }];
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      problems = judgeIngestHealth(body, { idle, staleSeconds, acknowledged });
    }
  } catch (err) {
    problems = [{ key: 'unreachable', text: `${url} unreachable: ${String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}` }];
  }
  // Diagnostic print only — guarded so a malformed answer (`chains` not an
  // array) keeps its verdict instead of throwing past it (#2482 r6).
  if (Array.isArray(body?.chains)) {
    const watched = watchedChains(body, idle) ?? [];
    console.log(`watching: ${watched.join(', ') || '(none)'}${idle.length ? ` — opted out: ${idle.join(', ')}` : ''}`);
    for (const c of body.chains) {
      const note = watched.includes(c.chainId) ? '' : ' (not watched)';
      console.log(`chain ${c.chainId}: block ${c.lastBlock}, ${c.ageSeconds}s ago${note}`);
    }
    console.log(`schema gate: ${body.schema?.state}`);
    for (const c of Array.isArray(body.lifecycle?.chains) ? body.lifecycle.chains : []) {
      console.log(`chain ${c?.chainId}: loan-status check tracks ${c?.trackedLoans} loan(s), ${c?.trackedFromInitiation} from initiation; ${c?.violations} violation(s) recorded`);
    }
  }
  if (problems.length === 0) {
    console.log('ingest healthy');
    return;
  }
  for (const p of problems) console.log(`::error title=Indexer health::${p.text}`);
  // For the workflow's summary, alert issue and Telegram steps. Every line is
  // made single-line, and the heredoc delimiter is random, so no text in a
  // problem — some of it derived from the network — can end the value early
  // and write a second output.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const delimiter = `EOF_${randomUUID()}`;
    const lines = problems.map((p) => p.text.replace(/[\r\n]+/g, ' ').slice(0, 500));
    // The stable condition, one line: what the alert issue is keyed on.
    const keys = problems.map((p) => p.key.replace(/[^0-9A-Za-z_.:,-]/g, '?')).sort().join(',');
    appendFileSync(process.env.GITHUB_OUTPUT, `problems<<${delimiter}\n${lines.join('\n')}\n${delimiter}\nkeys=${keys}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
