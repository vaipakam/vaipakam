/** Entry point of the machine runner — see machine/run.ts. */
import { main } from './run';

main().catch((err) => {
  console.error('[keeper-machine] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
