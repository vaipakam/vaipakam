import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './lib/artifacts';

export default async function globalTeardown(): Promise<void> {
  const pidsFile = path.join(STATE_DIR, 'pids.json');
  try {
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[];
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no pids recorded */
  }
}
