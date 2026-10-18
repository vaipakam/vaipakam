/**
 * #2497 r19 — the operator documents are pinned to the code they describe, so
 * a setting or a private table added to the keeper cannot be left out of the
 * runbooks silently. Four Codex rounds each found one more hand-kept list that
 * had drifted (a table missing from the inventory, a flag missing from the
 * machine runbook, a stale count); one test over the code's own lists ends
 * the class, and the documents carry no counts to go stale.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_SETTINGS } from '../host/hostEnv';
import { PLAIN_VAR_KEYS, SECRET_BINDING_KEYS } from '../src/env';

const keeperDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(keeperDir, '..', '..');
const readme = readFileSync(join(keeperDir, 'README.md'), 'utf8');
const machineRunbook = readFileSync(join(repoDir, 'docs', 'ops', 'KeeperMachine.md'), 'utf8');

/** Every private table the keeper's migrations create. */
function privateTables(): string[] {
  const dir = join(keeperDir, 'migrations');
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) names.add(m[1]);
  }
  return [...names];
}

/** The README's private-state inventory: the paragraph that introduces `KEEPER_DB`. */
function privateInventory(): string {
  const start = readme.indexOf('**`KEEPER_DB`');
  expect(start, 'the README names the private binding').toBeGreaterThan(0);
  return readme.slice(start, readme.indexOf('\n\n', start));
}

describe('the keeper README documents every setting the keeper reads', () => {
  it.each([...PLAIN_VAR_KEYS, ...SECRET_BINDING_KEYS])('%s', (key) => {
    expect(readme).toContain('`' + key + '`');
  });
});

describe('the machine runbook names every host-only setting', () => {
  it.each(Object.values(HOST_SETTINGS))('%s', (key) => {
    expect(machineRunbook).toContain('`' + key + '`');
  });

  it('points at the README for the settings the keeper itself reads, rather than keeping a second list', () => {
    expect(machineRunbook).toContain('apps/keeper/README.md');
  });
});

describe("the README's private-state inventory names every private table", () => {
  const inventory = privateInventory();
  it.each(privateTables())('%s', (table) => {
    expect(inventory).toContain('`' + table + '`');
  });

  it('carries no table count to go stale', () => {
    expect(inventory).not.toMatch(/\b(nine|ten|eleven|twelve|thirteen|\d+) (private )?tables\b/i);
  });
});
