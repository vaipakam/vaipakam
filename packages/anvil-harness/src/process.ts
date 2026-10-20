/**
 * Spawning a local anvil node and knowing whether it is still running.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { anvilControl, type AnvilControl } from './rpc';

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
  /** Where it listens, e.g. `http://127.0.0.1:8545`. */
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
  readonly url: string;
  readonly child: ChildProcess;
  readonly control: AnvilControl;
  /** Kill the node and wait for it to exit. Idempotent. */
  stop(): Promise<void>;
}

/** Spawn anvil and resolve once it answers with `chainId`; rejects if it exits first. */
export async function spawnAnvil(opts: SpawnAnvilOptions): Promise<SpawnedAnvil> {
  const endpoint = new URL(opts.url);
  await assertNothingListening(opts.url, 'anvil');
  const args = [
    '--chain-id', String(opts.chainId),
    '--host', endpoint.hostname,
    '--port', endpoint.port || '8545',
    '--gas-limit', String(opts.gasLimit ?? 60_000_000),
  ];
  if (opts.genesisNumber !== undefined) args.push('--number', String(opts.genesisNumber));
  if (opts.loadStatePath) args.push('--load-state', opts.loadStatePath);
  if (opts.dumpStatePath) args.push('--dump-state', opts.dumpStatePath);
  if (!opts.verbose) args.push('--silent');
  const child = spawn('anvil', args, { stdio: ['ignore', 'inherit', 'inherit'], detached: false });
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  const control = anvilControl(opts.url);
  const outcome = await Promise.race([control.waitForChainId(opts.chainId, 60_000).then(() => 'ready' as const), exited]);
  if (outcome !== 'ready') throw new Error(`anvil exited with code ${outcome} before it was ready at ${opts.url}`);
  return {
    url: opts.url,
    child,
    control,
    async stop() {
      if (childHasExited(child)) return;
      child.kill('SIGTERM');
      await exited;
    },
  };
}
