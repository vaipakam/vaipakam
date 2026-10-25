/**
 * Per-file setup: whatever a scenario's setup or tests reached, every node it
 * spawned is stopped when its file ends — including one whose `beforeAll`
 * failed before it held a handle to stop.
 */
import { afterAll } from 'vitest';
import { stopAllAnvils } from '@vaipakam/anvil-harness/process';

afterAll(async () => {
  await stopAllAnvils();
});
