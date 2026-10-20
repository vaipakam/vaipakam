/**
 * Per-file setup for both Anvil suites (Codex #2604 r2): whatever a scenario's
 * setup or tests reached, every node it spawned is stopped when its file
 * ends. A scenario whose `beforeAll` failed part-way never got a handle to
 * stop the nodes it had already started; the harness's own registry has one.
 */
import { afterAll } from 'vitest';
import { stopAllAnvils } from '@vaipakam/anvil-harness/process';

afterAll(async () => {
  await stopAllAnvils();
});
