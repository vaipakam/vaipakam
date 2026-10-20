/**
 * Spawning a local anvil node and knowing whether it is still running.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { anvilControl, localEndpoint, type AnvilControl } from './rpc';

/**
 * Has the spawned anvil already exited? (#2019 round 1 P2.)
 *
 * The answer decides whether its PID stays in a teardown list, and getting it
 * wrong in the "already dead" direction means signalling a number the OS may
 * have REASSIGNED to an unrelated process. So it errs deliberately toward
 * "still running": Node sets these fields when it processes the exit event,
 * and a process that has died without that event yet reads as running here —
 * teardown then signals a stale PID and catches ESRCH, which is the harmless
 * outcome. The opposite mistake is not harmless.
 */
export function childHasExited(child: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Refuse a port something already answers on. A readiness probe cannot tell a
 * fresh child from a stale process squatting the port (the child dies with
 * EADDRINUSE while the probe happily answers), and a stale node means a run
 * silently uses state it did not build.
 */
export async function assertNothingListening(url: string, what: string): Promise<void> {
  let responded = false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    responded = true;
  } catch {
    /* connection refused / timeout — the port is free */
  }
  if (responded) {
    throw new Error(`${what} port already has a listener at ${url} — kill the stale process; a disposable instance is required`);
  }
}

export interface SpawnAnvilOptions {
  /** Where it listens, e.g. `http://127.0.0.1:8545` — a loopback address
   *  with its port written out (see {@link localEndpoint}). */
  url: string;
  /** The chain id it presents from genesis. */
  chainId: number;
  /** Genesis block number (see the app's global setup for why it starts high). */
  genesisNumber?: number;
  /** A state file a previous node wrote with `dumpStatePath`, to start from. */
  loadStatePath?: string;
  /** Write the node's whole state here when it exits ({@link SpawnedAnvil.stop}),
   *  so later nodes can start from it with `loadStatePath`. */
  dumpStatePath?: string;
  /** Block gas limit. */
  gasLimit?: number;
  /** Inherit anvil's stdout/stderr instead of `--silent`. */
  verbose?: boolean;
}

export interface SpawnedAnvil {
  /** Where the node listens, as {@link localEndpoint} wrote it (use this,
   *  not the option: `localhost` reads as `127.0.0.1` here). */
  readonly url: string;
  readonly child: ChildProcess;
  readonly control: AnvilControl;
  /** Kill the node and wait for it to exit. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Every node this process spawned that has not exited (Codex #2604 r2). The
 * harness OWNS its nodes: a scenario whose setup fails part-way — the second
 * of two nodes cannot start, a readiness wait times out — never got a handle
 * to stop what it had already started, so per-path cleanup cannot reach them.
 * One registry and {@link stopAllAnvils} can.
 */
const live = new Set<ChildProcess>();

/** Kill `child` and wait for it to exit. Idempotent. */
async function stopChild(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (childHasExited(child)) return;
  child.kill('SIGTERM');
  await exited;
}

const exitOf = new WeakMap<ChildProcess, Promise<number>>();

/**
 * Stop every node this process spawned and has not stopped, whatever state its
 * scenario reached. Suites call it from one `afterAll` (the keeper's e2e
 * setup file), so no failure path leaves a node holding a port or keeping the
 * runner alive.
 */
export async function stopAllAnvils(): Promise<void> {
  await Promise.all([...live].map((c) => stopChild(c, exitOf.get(c) ?? Promise.resolve())));
}

/** Spawn anvil and resolve once it answers with `chainId`; rejects if it exits
 *  first, and stops it before rejecting if it never becomes ready. */
export async function spawnAnvil(opts: SpawnAnvilOptions): Promise<SpawnedAnvil> {
  // Before anything reaches the URL: the listener probe and the spawn both
  // act on it, and a node started on a non-local address would have no handle.
  // From here on, the bind address and every client URL come from this one
  // reading, so anvil and its probe cannot disagree about where it listens.
  const endpoint = localEndpoint(opts.url);
  await assertNothingListening(endpoint.url, 'anvil');
  const args = [
    '--chain-id', String(opts.chainId),
    '--host', endpoint.host,
    '--port', String(endpoint.port),
    '--gas-limit', String(opts.gasLimit ?? 60_000_000),
  ];
  if (opts.genesisNumber !== undefined) args.push('--number', String(opts.genesisNumber));
  if (opts.loadStatePath) args.push('--load-state', opts.loadStatePath);
  if (opts.dumpStatePath) args.push('--dump-state', opts.dumpStatePath);
  if (!opts.verbose) args.push('--silent');
  const child = spawn('anvil', args, { stdio: ['ignore', 'inherit', 'inherit'], detached: false });
  // `close` is the one event Node emits on every way a child ends, including a
  // spawn that never started (no binary on PATH: `error` then `close`, and no
  // `exit`). Keying on `exit` left a failed launch looking alive until the
  // readiness deadline, and an `error` with no listener would have crashed the
  // runner (Codex #2604 r3).
  let launchError: Error | undefined;
  child.on('error', (err) => {
    launchError ??= err;
  });
  const exited = new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? -1)));
  live.add(child);
  exitOf.set(child, exited);
  void exited.then(() => live.delete(child));
  const control = anvilControl(endpoint.url);
  // The readiness wait ends with the race: a child that exits first must not
  // leave the probe loop polling a dead port until its own deadline.
  const waiting = new AbortController();
  const ready = control.waitForChainId(opts.chainId, 60_000, waiting.signal).then(() => 'ready' as const);
  ready.catch(() => {}); // a wait cancelled after the child won the race rejects unobserved
  let outcome: 'ready' | number;
  try {
    outcome = await Promise.race([ready, exited]);
  } catch (err) {
    // Alive but never ready (a slow state load, a wrong chain id): it is
    // stopped here, since the caller never receives a handle to stop it.
    await stopChild(child, exited);
    throw err;
  } finally {
    waiting.abort();
  }
  if (outcome !== 'ready') {
    const why = launchError ? `could not start (${launchError.message})` : `exited with code ${outcome}`;
    throw new Error(`anvil ${why} before it was ready at ${endpoint.url}`);
  }
  return {
    url: endpoint.url,
    child,
    control,
    stop: () => stopChild(child, exited),
  };
}
