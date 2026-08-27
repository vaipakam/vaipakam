/**
 * Fork-tier bootstrap, in order:
 *   1. spawn `anvil --fork-url <base-sepolia> --chain-id 84532`
 *   2. spawn the indexer stub (fork-hydrated, zero-lag)
 *   3. generate + fund the four ephemeral role wallets
 *   4. seed their WETH + tLIQ balances
 * PIDs land in e2e/.state/pids.json for global-teardown. The fork URL
 * comes from APP_E2E_FORK_URL (defaults to the public endpoint —
 * fine on CI runners; use a keyed RPC locally if the public one
 * throttles).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANVIL_URL, waitForAnvil } from './lib/anvil';
import { createAndFundWallets } from './lib/wallets';
import { seedRoleAssets } from './lib/seed';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATE_DIR = path.join(HERE, '.state');
const PIDS_FILE = path.join(STATE_DIR, 'pids.json');
const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`service not ready: ${url}`);
}

/** Readiness probes can't tell OUR fresh child from a stale process
 *  already squatting the port (the child dies with EADDRINUSE while
 *  the probe happily answers) — and a stale anvil/stub means the run
 *  silently uses non-disposable state. Fail closed BEFORE spawning:
 *  anything answering on the port is fatal. */
async function assertNothingListening(url: string, what: string): Promise<void> {
  let responded = false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    responded = true;
  } catch {
    /* connection refused / timeout — port is free, good */
  }
  if (responded) {
    throw new Error(
      `${what} port already has a listener at ${url} — kill the stale process; the fork tier needs a fresh disposable instance`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pids: number[] = [];
  // Truncate the PID file FIRST, before anything that can throw. A stale
  // list from an earlier run is not merely useless — teardown kills every
  // PID it finds, and the OS reuses those numbers, so an unrelated
  // process can be killed. Several checks below (the two stale-listener
  // guards, the attempts validation) exit before the first real write, so
  // clearing here is what makes them safe rather than each one
  // remembering to.
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));

  const forkUrl =
    process.env.APP_E2E_FORK_URL ?? 'https://sepolia.base.org';
  await assertNothingListening(ANVIL_URL, 'anvil');
  await assertNothingListening(`http://127.0.0.1:${STUB_PORT}/`, 'indexer stub');
  // Spawn on the SAME endpoint every helper (and the browser via
  // playwright.config's VITE_BASE_SEPOLIA_RPC_URL) resolves from
  // APP_E2E_ANVIL_URL — a fixed port here would split the suite
  // across two RPCs the moment someone overrides the URL.
  const anvilEndpoint = new URL(ANVIL_URL);

  // Retry ONLY the transient class: anvil forks at HEAD, so the upstream
  // can advertise a block whose state a load-balanced peer cannot serve
  // yet, and anvil exits during genesis with "Unknown block". That is an
  // RPC hiccup, not a repo defect — but it fails the whole job and lands
  // as a red required check on whatever PR happens to be in flight
  // (#1973). A fast exit is retryable; a readiness TIMEOUT is not, since
  // that indicates something structurally wrong rather than a bad
  // moment, and retrying it would triple the wait before reporting.
  // Validate rather than trusting Number(): '' and 'abc' both yield a
  // loop that never runs, '2.5' never reaches the terminal branch, and
  // 'Infinity' retries forever. A typo in CI config must fail loudly
  // here, not manifest as a skipped or hanging startup.
  const attemptsRaw = process.env.APP_E2E_ANVIL_ATTEMPTS;
  const attempts = attemptsRaw === undefined ? 3 : Number(attemptsRaw);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error(
      `APP_E2E_ANVIL_ATTEMPTS must be an integer in 1..10 (got ` +
        `${JSON.stringify(attemptsRaw)}). Use 1 to disable retries.`,
    );
  }
  // A genesis failure kills anvil in seconds. Anything that survives
  // this long and THEN dies is not the transient class, so it is fatal
  // on the spot — otherwise three near-timeout attempts would take
  // ~360s while claiming to stay near 120s.
  const FAST_EXIT_MS = 30_000;
  let anvilStarted = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const spawnedAt = Date.now();
    const anvil = spawn(
      'anvil',
      [
        '--fork-url', forkUrl,
        '--chain-id', '84532',
        '--host', anvilEndpoint.hostname,
        '--port', anvilEndpoint.port || '8545',
        '--silent',
        // Generous gas + instant mining keep UI waits short.
        '--gas-limit', '60000000',
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], detached: false },
    );
    if (anvil.pid) pids.push(anvil.pid);
    // Record the PID IMMEDIATELY: if a readiness wait below throws while
    // the child is alive, teardown must still find something to kill —
    // otherwise the orphan squats the port and every following run dies
    // on the stale-listener guard.
    fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
    // Resolves with the exit code rather than rejecting, because the code
    // is a VALUE this loop branches on — fast exit vs slow exit vs final
    // attempt — not an error condition. (This comment used to say the
    // resolve-don't-reject shape was what stopped a losing entrant
    // becoming an unhandled rejection. It isn't: see the note below,
    // where that belief was tested and found false. Kept the shape,
    // fixed the reason.)
    const anvilDied = new Promise<number>((resolve) =>
      anvil.on('exit', (code) => resolve(code ?? -1)),
    );
    // A readiness TIMEOUT is fatal and never retried: waitForAnvil
    // throws, that rejection propagates out of the race and past this
    // loop, and the message it carries includes the last RPC error —
    // which is exactly what you want to read. Retrying a timeout would
    // multiply the wait without recovering anything.
    //
    // The abandoned promise is NOT a leak, and this was verified rather
    // than assumed (it looks like one). Promise.race attaches handlers
    // to every input and they stay attached after another input wins, so
    // a later waitForAnvil rejection is observed by the race's own
    // now-inert reject — no unhandled rejection, confirmed under
    // `--unhandled-rejections=strict`. Do not "fix" this by catching the
    // timeout into a sentinel: that discards lastErr and fixes nothing.
    const anvilOutcome = await Promise.race([
      waitForAnvil(120_000).then(() => 'ready' as const),
      anvilDied,
    ]);
    if (anvilOutcome === 'ready') {
      anvilStarted = true;
      break;
    }
    // The child is confirmed dead. Drop its PID before doing anything
    // else, including throwing: teardown kills every recorded PID, and
    // catching ESRCH only covers a number that stays unused — the OS can
    // REASSIGN it during a long run, at which point teardown would kill
    // an unrelated process. Recording it at spawn is still right (a live
    // child must always be killable); it just has to come back out the
    // moment the exit is observed, on every path.
    const deadIdx = anvil.pid ? pids.indexOf(anvil.pid) : -1;
    if (deadIdx !== -1) pids.splice(deadIdx, 1);
    fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));

    const elapsed = Date.now() - spawnedAt;
    if (elapsed >= FAST_EXIT_MS) {
      throw new Error(
        `anvil ran for ${Math.round(elapsed / 1000)}s and then exited ` +
          `(code ${anvilOutcome}). That is not the fast genesis failure ` +
          `retrying is for, so it is fatal on the first occurrence; ` +
          `retrying would only multiply the wait. See #1973.`,
      );
    }
    if (attempt === attempts) {
      throw new Error(
        `anvil exited before ready (code ${anvilOutcome}) after ${attempts} ` +
          `attempt(s). If the log above says "failed to create genesis" / ` +
          `"Unknown block", the fork RPC could not serve state for the head ` +
          `block; see #1973.`,
      );
    }
    // Say it out loud. A silent retry turns a degrading RPC into an
    // invisible slowdown, and the next person debugging a slow job has
    // no way to know it happened.
    console.warn(
      `[e2e] anvil exited before ready (code ${anvilOutcome}) — ` +
        `attempt ${attempt}/${attempts}, retrying`,
    );
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
    // The dead child released the port; re-assert it is free so a retry
    // cannot silently attach to something else that grabbed it.
    await assertNothingListening(ANVIL_URL, 'anvil');
  }
  // Unreachable: `attempts` is validated >= 1, so the loop always runs
  // and either breaks on ready or throws. Kept as a type-level guard.
  if (!anvilStarted) {
    throw new Error('anvil did not start');
  }
  console.log('[e2e] anvil fork ready (chainId 84532)');

  const stub = spawn(
    process.execPath,
    [path.join(HERE, 'lib', 'indexer-stub.mjs')],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env },
      cwd: path.join(HERE, '..'),
    },
  );
  if (stub.pid) pids.push(stub.pid);
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForHttp(`http://127.0.0.1:${STUB_PORT}/offers/stats?chainId=84532`);
  if (stub.exitCode !== null) {
    throw new Error(`indexer stub exited early (code ${stub.exitCode})`);
  }
  console.log('[e2e] indexer stub ready');

  await createAndFundWallets();
  await seedRoleAssets();
  console.log('[e2e] role wallets funded + seeded');
}
