/**
 * Vitest global setup for the keeper's Anvil scenarios: build the fixture
 * chain once per run (`fixture.ts`). Set `KEEPER_E2E_REUSE_FIXTURE=1` to keep
 * a `.state/` an earlier run built — an inner-loop convenience only; CI always
 * builds afresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareFixture, STATE_DIR } from './fixture';

export default async function setup(): Promise<void> {
  if (process.env.KEEPER_E2E_REUSE_FIXTURE === '1' && fs.existsSync(path.join(STATE_DIR, 'fixture.json'))) {
    console.log('[keeper-e2e] reusing the fixture under .state/ (KEEPER_E2E_REUSE_FIXTURE=1)');
    return;
  }
  await prepareFixture();
}
