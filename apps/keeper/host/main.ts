/**
 * apps/keeper — the always-on machine runtime.
 *
 * Runs the same tick the Worker runs (`src/tick.ts`), on a minute clock in
 * one long-lived Node process, so the keeper can be hosted off Cloudflare
 * Workers without forking what it does. See `host/README.md` for how to run
 * it, what it needs, and what changes against the Worker.
 *
 *   pnpm --filter @vaipakam/keeper start:host
 *
 * Configuration is environment variables only (see `hostEnv.ts`). Run
 * exactly ONE copy per keeper key: two copies sign with the same key, and
 * the per-network send ordering (#2486) holds only within one process.
 *
 * SIGTERM / SIGINT stop the clock and wait for the tick in flight, so a
 * restart does not cut a send off between signing and broadcast.
 *
 * Each tick first confirms the shared database's schema (`hostTick.ts`),
 * because on a machine there is no deploy step to do it.
 */

import { buildHostEnv } from './hostEnv';
import { createHostTick } from './hostTick';
import { createTickRunner, minuteFloor, msUntilNextMinute } from './scheduler';

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

function main(): void {
  const { missingD1 } = buildHostEnv(process.env);
  if (missingD1.length > 0) {
    // Not fatal, and the tick says so too: with no database every tick
    // declines as a maintenance build. Said here once, at start-up, naming
    // the settings, so the cause is not left to be inferred from the tick.
    log(`[keeper-host] no D1 database: ${missingD1.join(', ')} unset; every tick will decline`);
  }

  const runner = createTickRunner({
    runTick: createHostTick({ vars: () => process.env, log }),
    log,
  });

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      if (stopping) return;
      runner.fire(minuteFloor(Date.now()));
      schedule();
    }, msUntilNextMinute(Date.now()));
  };

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (timer !== undefined) clearTimeout(timer);
    const inFlight = runner.inFlight();
    log(
      `[keeper-host] ${signal}: no further ticks; waiting for ${inFlight.length > 0 ? inFlight.join(', ') : 'nothing in flight'}`,
    );
    void runner.idle().then(() => {
      log('[keeper-host] stopped');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  log(`[keeper-host] started pid=${process.pid}; first tick at the next minute boundary`);
  schedule();
}

main();
