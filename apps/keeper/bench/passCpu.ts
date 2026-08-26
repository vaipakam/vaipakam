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
  // Held so a timed-out pass can be SETTLED before the next one is profiled.
  // `Promise.race` abandons the waiter, it does not cancel the work: the
  // abandoned pass kept burning process-wide CPU and mutating the mock's
  // counters while later samples were taken, so those deltas were not
  // isolated (Codex #1945 r1).
  const work = fn().then(
    () => 'ok' as const,
    () => 'ok' as const,
  );
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === 'timeout') {
      // The call budget does NOT guarantee `work` terminates: an RPC failure
      // whose retry sits on a backoff timer keeps the pass pending without
      // ever issuing (and so exhausting) another call, and an unconditional
      // `await work` then hung the whole harness — `BENCH_TIMEOUT_S=2` still
      // needed SIGTERM after 15s (Codex #1945 r3). Bound the post-timeout
      // settle: give the abandoned pass a short grace to unwind on its own
      // (which keeps the r1 isolation for the common budget-bounded case),
      // then proceed regardless. The runner breaks its REPS loop on the first
      // hang, so at most one pass per run is left un-settled, and it is
      // reported as hung/NOT-measured either way.
      const grace = new Promise<void>((res) => {
        const g = setTimeout(res, Math.min(5, TIMEOUT_S) * 1000);
        // Do not keep the event loop alive for the grace timer alone.
        (g as unknown as { unref?: () => void }).unref?.();
      });
      await Promise.race([work.then(() => undefined), grace]);
      return null;
    }
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
  /** Failures during the untimed warm-up — a pass that only ever fails. */
  warmUpErrors: number;
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
  const realWarn = console.warn;

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

    // Daily-cadence passes gate on the WALL CLOCK: `runDailyOracleSnapshot`
    // returns at `minutesIntoDay >= 10` before touching D1 or an RPC, so
    // profiling one at any other minute measures the gate, not the pass — and
    // more than 99% of possible run times fall outside its 00:00–00:09 UTC
    // window (Codex #1945 r3). Pin `Date.now` inside the window for the pass's
    // whole profile. This moves only the wall clock, never the CPU meter
    // (`process.cpuUsage`), and it is restored before the next pass.
    const realNow = Date.now;
    if (pass.dailyWindow) {
      const midnightUtc = Math.floor(realNow() / 86_400_000) * 86_400_000;
      const inWindow = midnightUtc + 5 * 60 * 1000; // 00:05 UTC
      Date.now = () => inWindow;
    }

    // BOTH streams. Several passes report caught RPC failures through
    // console.WARN — preGraceWatcher warns on count, page and offer-hydration
    // failures — so intercepting only console.error let a partially executed
    // pass print its failures and still report err/run = 0.0 with no floor
    // marker (Codex #1945 r1).
    const count = (...args: unknown[]) => {
      errors += 1;
      if (process.env.BENCH_VERBOSE) realError('   ', ...args);
    };
    console.error = count;
    console.warn = count;

    // WARM-UP, untimed. Populates the mock's response cache so the measured
    // interval pays a Map lookup rather than an ABI encode + JSON.stringify —
    // work a real RPC server does remotely, not work the Worker does
    // (Codex #1945 r1). Its own errors are counted, so a pass that only fails
    // is still marked.
    resetPages();
    resetD1();
    await cpuMs(() => pass.run(makeEnv()));

    // Counters start AFTER the warm-up. Including it double-counted every
    // figure — `watcher` reported 3,120 calls for a pass that makes 1,560,
    // exactly 2x — which is the same shape of self-inflicted wrong number
    // this harness keeps producing, so it is fixed before the numbers are
    // published rather than after.
    const warmUpErrors = errors;
    errors = 0;
    const rpcBefore = rpcStats.calls;

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
    console.warn = realWarn;
    Date.now = realNow;
    samples.sort((a, b) => a - b);
    rows.push({
      name: pass.name,
      // True median: the average of the two middle samples for an even count,
      // not the upper-middle one. BENCH_REPS is a documented knob and an even
      // value (2, 4) otherwise systematically overstates every median and can
      // reorder the ranking (Codex #1945 r8).
      median: samples.length
        ? samples.length % 2 === 1
          ? samples[(samples.length - 1) / 2]
          : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2
        : 0,
      max: samples.length ? samples[samples.length - 1] : 0,
      rpc: (rpcStats.calls - rpcBefore) / Math.max(samples.length, 1),
      errors: errors / Math.max(samples.length, 1),
      hung,
      unbounded,
      warmUpErrors,
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

  // Daily-window passes (dailyWindow: true) share the 1-minute cadence but
  // return immediately outside 00:00–00:09 UTC; the runner pins the clock INTO
  // that window to measure the active path. Their full cost is a once-a-day
  // PEAK, not what an ordinary minute pays, so it is excluded from the
  // cadence-1 total and reported on its own line (Codex #1945 r7).
  const everyTick = rows.filter(
    (r) =>
      r.rpc > 0 &&
      KEEPER_PASSES.find(
        (p) => p.name === r.name && p.cadenceMinutes === 1 && !p.dailyWindow,
      ),
  );
  const tickTotal = everyTick.reduce((s, r) => s + r.median, 0);
  const windowPasses = rows.filter(
    (r) =>
      r.rpc > 0 &&
      KEEPER_PASSES.find(
        (p) => p.name === r.name && p.cadenceMinutes === 1 && p.dailyWindow,
      ),
  );
  const windowTotal = windowPasses.reduce((s, r) => s + r.median, 0);
  console.log(
    `\ntotal across all passes        ${total.toFixed(1)} ms CPU\n` +
      `the ${everyTick.length} cadence-1 passes alone  ${tickTotal.toFixed(1)} ms CPU  ` +
      `— MEASURED cadence-1 passes only (excludes daily-window)\n` +
      (windowPasses.length > 0
        ? `${windowPasses.length} daily-window pass(es)        ${windowTotal.toFixed(1)} ms CPU  ` +
          `— ${windowPasses
            .map((r) => r.name)
            .join(', ')}, measured in-window; a once-a-day peak, NOT part of an ordinary minute\n`
        : ''),
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

  const warmOnly = rows.filter((r) => r.errors === 0 && r.warmUpErrors > 0);
  if (warmOnly.length > 0) {
    console.log(
      'PASSES THAT FAILED ONLY DURING WARM-UP (still a floor — the warm-up is\n' +
        'a real invocation, and a pass that fails there did not do its work):\n  ' +
        warmOnly.map((r) => `${r.name} (${r.warmUpErrors})`).join('\n  ') +
        '\n',
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

// Exit explicitly once the table is printed. A pass abandoned at the timeout
// (see `cpuMs`) can leave RPC-retry timers on the event loop that would keep
// the process alive for tens of seconds after the results are already out —
// which is the very "BENCH_TIMEOUT_S is ineffective" symptom this harness is
// meant to avoid. The measurement is complete at this point, so a hard exit is
// correct rather than lossy — but DRAIN both streams first: when the output is
// piped or redirected, `process.exit` can otherwise truncate the results table
// still buffered in the pipe (Codex #1945 r4).
function flushAndExit(code: number): void {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

main().then(
  () => flushAndExit(0),
  (err) => {
    console.error(err);
    flushAndExit(1);
  },
);
