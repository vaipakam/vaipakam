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
 * A scheduled GitHub Actions run needs neither, and a failed run notifies
 * the repository owner by GitHub's own channels.
 *
 * WHAT FAILS (exit 1), each named in the output:
 *   - a watched chain whose diamond cursor has not advanced for longer than
 *     the threshold, or that the route does not report at all;
 *   - the schema gate reporting `pending` (naming the missing migrations —
 *     the 0056 incident) or `unknown` (the migration record unreadable);
 *   - the route unreachable, non-200, or answering something that is not
 *     the documented shape — a probe that cannot read the facts is not a
 *     healthy answer.
 *
 * WHAT IT DOES NOT JUDGE: chains outside the watched list (the route also
 * reports chains no longer scanned, whose cursor stands still forever), and
 * whether the data ingested is correct — only that ingest is moving.
 *
 *   INDEXER_ORIGIN=https://indexer.vaipakam.com \
 *   INGEST_CHAINS=84532,421614 INGEST_STALE_SECONDS=900 \
 *     node .github/scripts/check-ingest-health.mjs
 *   node .github/scripts/check-ingest-health.mjs --selftest
 */

/**
 * The verdict on one `/health/ingest` answer. Pure, so the selftest pins it.
 *
 * @param {unknown} body the parsed response
 * @param {{ chains: number[], staleSeconds: number }} opts
 * @returns {{ key: string, text: string }[]} problems, empty when healthy. The
 *   `key` is STABLE across runs while the condition is unchanged (no ages or
 *   timestamps in it), so the workflow can tell a continuing stall from a
 *   changed one; `text` is what the operator reads.
 */
export function judgeIngestHealth(body, { chains, staleSeconds }) {
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
    add('gate-unknown', 'schema gate UNKNOWN — the indexer could not read d1_migrations, so scheduled ingest is declining.');
  } else if (schema.state !== 'current') {
    add('gate-state', `schema gate state "${String(schema.state).replace(/[^0-9A-Za-z_-]/g, '?').slice(0, 40)}" is not one this probe knows`);
  }
  for (const id of chains) {
    const c = body.chains.find((x) => x && x.chainId === id);
    if (!c) {
      add(`missing:${id}`, `chain ${id}: no diamond cursor reported — it has never been scanned`);
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
  return problems;
}

/** A non-negative finite number — every count and unix time the route reports. */
function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Parse the watched chain list; refuses an empty or malformed one rather
 *  than watching nothing and passing. */
export function parseChains(raw) {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || !ids.every((s) => /^\d+$/.test(s))) {
    throw new Error(`INGEST_CHAINS must be a comma-separated list of chain ids, got "${raw ?? ''}"`);
  }
  return ids.map(Number);
}

function selftest() {
  const ok = (cond, what) => {
    if (!cond) throw new Error(`selftest: ${what}`);
  };
  const opts = { chains: [84532, 421614], staleSeconds: 900 };
  const healthy = {
    checkedAt: 1000,
    schema: { state: 'current' },
    chains: [
      { chainId: 97, lastBlock: 1, scannedAt: 0, ageSeconds: 999_999 }, // not watched
      { chainId: 421614, lastBlock: 5, scannedAt: 920, ageSeconds: 80 },
      { chainId: 84532, lastBlock: 9, scannedAt: 919, ageSeconds: 81 },
    ],
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
  let threw = false;
  try {
    parseChains('');
  } catch {
    threw = true;
  }
  ok(threw, 'an empty chain list is refused, never "watch nothing"');
  ok(JSON.stringify(parseChains('84532, 421614')) === '[84532,421614]', 'the chain list parses');
  console.log('check-ingest-health selftest: OK');
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const origin = process.env.INDEXER_ORIGIN;
  if (!origin) throw new Error('INDEXER_ORIGIN is required');
  const chains = parseChains(process.env.INGEST_CHAINS);
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
      problems = judgeIngestHealth(body, { chains, staleSeconds });
    }
  } catch (err) {
    problems = [{ key: 'unreachable', text: `${url} unreachable: ${String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}` }];
  }
  if (body?.chains) {
    for (const c of body.chains) {
      const watched = chains.includes(c.chainId) ? '' : ' (not watched)';
      console.log(`chain ${c.chainId}: block ${c.lastBlock}, ${c.ageSeconds}s ago${watched}`);
    }
    console.log(`schema gate: ${body.schema?.state}`);
  }
  if (problems.length === 0) {
    console.log('ingest healthy');
    return;
  }
  for (const p of problems) console.log(`::error title=Indexer ingest::${p.text}`);
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
