import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown(): Promise<void> {
  const pidsFile = path.join(HERE, '.state', 'pids.json');
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
