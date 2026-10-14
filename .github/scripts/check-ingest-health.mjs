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
 * @returns {string[]} problems, empty when healthy
 */
export function judgeIngestHealth(body, { chains, staleSeconds }) {
  const problems = [];
  if (!body || typeof body !== 'object' || !Array.isArray(body.chains) || !body.schema) {
    return ['the route answered, but not with the documented shape (schema + chains)'];
  }
  const { schema } = body;
  if (schema.state === 'pending') {
    const missing = Array.isArray(schema.missing) ? schema.missing.join(', ') : '(unnamed)';
    problems.push(
      `schema gate PENDING — scheduled ingest is declining until these D1 migrations are applied: ${missing}. ` +
        'Apply them (cd apps/indexer && npx wrangler d1 migrations apply vaipakam-warm --remote); ingest resumes on the next tick.',
    );
  } else if (schema.state === 'unknown') {
    problems.push('schema gate UNKNOWN — the indexer could not read d1_migrations, so scheduled ingest is declining.');
  } else if (schema.state !== 'current') {
    problems.push(`schema gate state "${schema.state}" is not one this probe knows`);
  }
  for (const id of chains) {
    const c = body.chains.find((x) => x && x.chainId === id);
    if (!c) {
      problems.push(`chain ${id}: no diamond cursor reported — it has never been scanned`);
    } else if (typeof c.ageSeconds !== 'number' || !Number.isFinite(c.ageSeconds)) {
      problems.push(`chain ${id}: the route reported no usable age`);
    } else if (c.ageSeconds > staleSeconds) {
      problems.push(
        `chain ${id}: ingest STALE — the cursor last advanced ${Math.round(c.ageSeconds / 60)} min ago ` +
          `(block ${c.lastBlock}), over the ${Math.round(staleSeconds / 60)} min threshold`,
      );
    }
  }
  return problems;
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
  ok(s.length === 1 && s[0].includes('84532') && s[0].includes('STALE'), 'a watched chain past the threshold fails, named');
  const pending = { ...healthy, schema: { state: 'pending', missing: ['0058_init_terms_unbacked.sql'] } };
  ok(judgeIngestHealth(pending, opts).some((p) => p.includes('0058_init_terms_unbacked.sql')), 'a pending gate fails, naming the migration');
  ok(judgeIngestHealth({ ...healthy, schema: { state: 'unknown' } }, opts).length === 1, 'an unknown gate fails');
  const missing = { ...healthy, chains: healthy.chains.filter((c) => c.chainId !== 421614) };
  ok(judgeIngestHealth(missing, opts).some((p) => p.includes('421614')), 'a watched chain absent from the answer fails');
  ok(judgeIngestHealth({ error: 'x' }, opts).length === 1, 'an answer of the wrong shape fails');
  ok(judgeIngestHealth(null, opts).length === 1, 'no answer fails');
  ok(judgeIngestHealth({ ...healthy, chains: [{ chainId: 84532 }, { chainId: 421614, ageSeconds: 1 }] }, opts).length === 1, 'a chain with no age fails');
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
      problems = [`${url} answered HTTP ${res.status}: ${text.slice(0, 200)}`];
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      problems = judgeIngestHealth(body, { chains, staleSeconds });
    }
  } catch (err) {
    problems = [`${url} unreachable: ${err.message}`];
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
  for (const p of problems) console.log(`::error title=Indexer ingest::${p}`);
  // For the workflow's optional Telegram step and its job summary.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `problems<<__END__\n${problems.join('\n')}\n__END__\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
