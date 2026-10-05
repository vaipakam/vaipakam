/**
 * #2409 r2 — the shared-D1 Workers' deploy wrapper applies migrations BEFORE
 * publishing, and a run that publishes nothing changes nothing remote.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations.
import { deployPlan } from '../scripts/migrate-then-deploy.mjs';

const MIGRATE = ['pnpm', ['--filter', '@vaipakam/indexer', 'run', 'migrate']];

describe('migrate-then-deploy', () => {
  it('migrates first, then deploys with the given arguments', () => {
    expect(deployPlan(['--keep-vars']).steps).toEqual([MIGRATE, ['wrangler', ['deploy', '--keep-vars']]]);
  });

  it('a dry run (or help) applies NO remote migration', () => {
    for (const flag of ['--dry-run', '--help', '-h']) {
      const p = deployPlan(['--keep-vars', flag]);
      expect(p.deploys).toBe(false);
      expect(p.steps).toEqual([['wrangler', ['deploy', '--keep-vars', flag]]]);
    }
  });
});
