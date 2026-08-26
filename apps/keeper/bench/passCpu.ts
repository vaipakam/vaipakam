/**
 * Per-pass CPU profile for the keeper (#1896).
 *
 * `wrangler tail` cannot answer the question this issue is stuck on. Every
 * pass is launched independently through `ctx.waitUntil`, and `timedPass`
 * measures WALL time — so a pass blocked on an RPC round-trip looks expensive
 * while costing nothing against a CPU limit, and the invocation can die of
 * `exceededCpu` with every pass having logged `done`. That is exactly what
 * production showed, which is why the original attribution to `watcher` and
 * `liquidityConfidence` was withdrawn during the #1924 review.
 *
 * This measures CPU directly — `process.cpuUsage()`, user+system, around one
 * pass at a time, in isolation, against a mock RPC that returns real
 * ABI-encoded results so the decode work is real.
 *
 * Run:  pnpm --filter @vaipakam/keeper run bench:cpu
 * Knobs: BENCH_ARRAY_LEN (array size in results, default 25)
 *        BENCH_REPS      (repetitions per pass, default 5)
 *        BENCH_VERBOSE   (print the errors a pass logged)
 *
 * The chain set is NOT a knob: it is whichever chains have a recorded
 * deployment, because that is what `getChainConfigs` will resolve in
 * production too.
 */
import { KEEPER_PASSES } from '../src/passSchedule';
import { getChainConfigs, type Env } from '../src/env';
import { installRpcMock, rpcStats, resetPages, budget, CALL_BUDGET, ARRAY_LEN } from './rpcMock';
import { d1Stub, resetD1, d1Stats, ROWS } from './d1Stub';

const REPS = Number(process.env.BENCH_REPS ?? 5);
/** Seconds one pass may take before it is recorded as hung rather than slow. */
const TIMEOUT_S = Number(process.env.BENCH_TIMEOUT_S ?? 30);


/**
 * ARMED on purpose. The gated passes return immediately at `passIsArmed`
 * when the flags are off, so profiling them disarmed would measure the gate
 * and report every fund-moving pass as free — the same false-cheap reading
 * this harness exists to prevent. The key is a well-known Anvil test key;
 * it signs against a mock RPC and touches nothing real.
 */
// ONLY chains that have a recorded deployment. `getChainConfigs` drops any
// chain with no `contracts/deployments/<slug>/addresses.json`, so setting an
// RPC for a chain that has none resolves to ZERO chains and every pass
// profiles as free — the first run of this harness did exactly that and
// reported a confident, meaningless ranking.
//
// That these are the only three is itself a finding for #1896: production is
// exceeding its CPU budget against THREE chains, not the eleven the env
// supports.
const RPC_KEYS = ['RPC_BASE_SEPOLIA', 'RPC_ARB_SEPOLIA', 'RPC_BNB_TESTNET'] as const;

function makeEnv(): Env {
  const env: Record<string, unknown> = {
    DB: d1Stub() as Env['DB'],
    KEEPER_ENABLED: 'true',
    REWARD_REMIT_ENABLED: 'true',
    REWARD_COMMIT_ENABLED: 'true',
    KEEPER_PRIVATE_KEY:
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    TG_BOT_TOKEN: 'test:token',
    TG_BOT_USERNAME: 'VaipakamBot',
    FRONTEND_ORIGIN: 'https://defi.vaipakam.com',
  };
  for (const k of RPC_KEYS) {
    env[k] = `https://mock-rpc.invalid/${k}`;
  }
  return env as unknown as Env;
}

/**
 * ms of CPU (user+system) consumed by `fn`, or `null` if it hung.
 *
 * The timeout is not defensive padding. An unbounded pass is exactly what a
 * fixture bug produces — a paginated read whose pages never empty, or a count
 * answered as 1e18 — and the first working run of this harness sat for twenty
 * minutes producing nothing rather than saying so. A hang has to be a
 * reported result, not silence.
 */
async function cpuMs(fn: () => Promise<void>): Promise<number | null> {
  const before = process.cpuUsage();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TIMEOUT_S * 1000);
  });
  try {
    const outcome = await Promise.race([fn().then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const d = process.cpuUsage(before);
  return (d.user + d.system) / 1000;
}

type Row = {
  name: string;
  median: number;
  max: number;
  rpc: number;
  errors: number;
  hung: number;
  unbounded: boolean;
};

async function main(): Promise<void> {
  const restore = installRpcMock();

  // Refuse to profile nothing. Every pass loops over `getChainConfigs`, so a
  // fixture that resolves no chains produces a table of zeros that looks like
  // an answer.
  const resolved = getChainConfigs(makeEnv());
  if (resolved.length === 0) {
    restore();
    throw new Error(
      'fixture resolved 0 chains — every pass would profile as free. ' +
        'Check that RPC_KEYS name chains with deployments in ' +
        'packages/contracts/src/deployments.json.',
    );
  }
  console.log(
    `fixture chains: ${resolved.length} — ${resolved
      .map((c) => `${c.name}(${c.id})`)
      .join(', ')}`,
  );

  const rows: Row[] = [];

  // A pass that fails early does almost no work and therefore profiles as
  // CHEAP. Counting stderr per pass is what stops this harness reporting a
  // broken pass as an innocent one — the single most repeated defect class in
  // the #1924 review.
  const realError = console.error;

  const only = process.env.BENCH_ONLY;
  const selected = only
    ? KEEPER_PASSES.filter((p) => p.name === only)
    : KEEPER_PASSES;
  if (selected.length === 0) {
    restore();
    throw new Error(`BENCH_ONLY=${only} matches no pass`);
  }

  for (const pass of selected) {
    const samples: number[] = [];
    let errors = 0;
    const rpcBefore = rpcStats.calls;

    console.error = (...args: unknown[]) => {
      errors += 1;
      if (process.env.BENCH_VERBOSE) realError('   ', ...args);
    };

    let hung = 0;
    let unbounded = false;
    for (let i = 0; i < REPS; i += 1) {
      resetPages();
      resetD1();
      const env = makeEnv();
      // eslint-disable-next-line no-await-in-loop
      const ms = await cpuMs(() => pass.run(env));
      if (ms === null) {
        hung += 1;
        break; // a hung pass will hang again; do not spend REPS × timeout on it
      }
      samples.push(ms);
      if (budget.exceeded) {
        unbounded = true;
        break;
      }
    }

    console.error = realError;
    samples.sort((a, b) => a - b);
    rows.push({
      name: pass.name,
      median: samples.length ? samples[Math.floor(samples.length / 2)] : 0,
      max: samples.length ? samples[samples.length - 1] : 0,
      rpc: (rpcStats.calls - rpcBefore) / Math.max(samples.length, 1),
      errors: errors / Math.max(samples.length, 1),
      hung,
      unbounded,
    });
  }

  restore();

  rows.sort((a, b) => b.median - a.median);
  const total = rows.reduce((s, r) => s + r.median, 0);

  console.log(
    `\nkeeper per-pass CPU — arrays of ${ARRAY_LEN}, ` +
      `median of ${REPS} runs, Node (not workerd)\n`,
  );
  console.log(
    `${'pass'.padEnd(22)}${'CPU ms'.padStart(9)}${'max'.padStart(9)}` +
      `${'rpc/run'.padStart(9)}${'err/run'.padStart(9)}   share`,
  );
  for (const r of rows) {
    const share = total > 0 ? (r.median / total) * 100 : 0;
    const bar = '█'.repeat(Math.round(share / 2));
    console.log(
      `${r.name.padEnd(22)}${r.median.toFixed(1).padStart(9)}` +
        `${r.max.toFixed(1).padStart(9)}${r.rpc.toFixed(0).padStart(9)}` +
        `${r.errors.toFixed(1).padStart(9)}   ${share.toFixed(1).padStart(5)}% ${bar}`,
    );
  }

  const wild = rows.filter((r) => r.unbounded);
  if (wild.length > 0) {
    console.log(
      `PASSES THAT EXHAUSTED THE ${CALL_BUDGET}-CALL BUDGET (unbounded against ` +
        `the fixture — their CPU number is a FLOOR):\n  ` +
        wild.map((r) => r.name).join('\n  ') +
        '\n',
    );
  }

  const everyTick = rows.filter(
    (r) =>
      r.rpc > 0 &&
      KEEPER_PASSES.find((p) => p.name === r.name && p.cadenceMinutes === 1),
  );
  const tickTotal = everyTick.reduce((s, r) => s + r.median, 0);
  console.log(
    `\ntotal across all passes        ${total.toFixed(1)} ms CPU\n` +
      `the ${everyTick.length} cadence-1 passes alone  ${tickTotal.toFixed(1)} ms CPU  ` +
      `— MEASURED cadence-1 passes only\n`,
  );

  const unmeasured = rows.filter((r) => r.rpc === 0 && r.hung === 0);
  if (unmeasured.length > 0) {
    console.log(
      'NOT MEASURED — these passes issued ZERO RPC calls, so their number is\n' +
        'not a cost, it is an absence. Almost always the D1 fixture: a pass\n' +
        'whose work list comes from a table this stub does not seed returns\n' +
        'immediately. Seed the table in bench/d1Stub.ts to measure them.\n  ' +
        unmeasured.map((r) => r.name).join('\n  ') +
        '\n',
    );
  }
  if (rows.every((r) => r.rpc === 0)) {
    throw new Error(
      'NO pass issued a single RPC call — nothing here was measured at all.',
    );
  }
  if (d1Stats.unseeded.size > 0) {
    console.log(
      `tables read but not seeded (${ROWS} rows each where seeded): ` +
        [...d1Stats.unseeded].filter(Boolean).join(', ') +
        '\n',
    );
  }

  const stuck = rows.filter((r) => r.hung > 0);
  if (stuck.length > 0) {
    console.log(
      `PASSES THAT HUNG past ${TIMEOUT_S}s (recorded as 0, NOT measured):\n  ` +
        stuck.map((r) => r.name).join('\n  ') +
        '\n  Almost always a fixture bug — an unbounded loop the mock feeds ' +
        'forever — not a slow pass.\n',
    );
  }

  const noisy = rows.filter((r) => r.errors > 0);
  if (noisy.length > 0) {
    console.log(
      'PASSES THAT LOGGED ERRORS (their numbers are a FLOOR, not a measurement):\n  ' +
        noisy.map((r) => `${r.name} (${r.errors.toFixed(1)}/run)`).join('\n  ') +
        '\n  Re-run with BENCH_VERBOSE=1 to see them.\n',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
