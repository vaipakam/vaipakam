/**
 * #3894 — the deploy rehearsal's off-chain stage: the rules that decide what
 * it runs and how it reads a result (`e2e/rehearsal/plan.ts`), and the fetch
 * narrowing (`e2e/rehearsal/outbound.ts`). The stage itself runs only against
 * a rehearsal's forks.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASS_ARMING_FLAGS } from '../src/keeper';
import { KEEPER_PASSES } from '../src/passSchedule';
import { armedFlagsFor, classifyPass, healthVerdict, localD1File, readRehearsalInputs, redactUrl, stagePassed } from '../e2e/rehearsal/plan';
import { captureConsole, narrowFetchTo } from '../e2e/rehearsal/outbound';
import { openSqliteD1 } from './helpers/sqliteD1';
// @ts-expect-error — plain ESM script, no type declarations.
import { dryRunWorkers } from '../e2e/rehearsal/publishDryRuns.mjs';

const contractsDir = '/repo/contracts';
const desired = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-desired-'));
  const p = join(dir, 'testnets.desired.json');
  writeFileSync(p, '{}');
  return p;
})();
const base = {
  VAIPAKAM_REHEARSAL: '1',
  VAIPAKAM_REHEARSAL_ROOT: 'deployments/.forge-test/rehearsal/run-1',
  VAIPAKAM_REHEARSAL_RPC_URL: 'http://127.0.0.1:8545',
  VAIPAKAM_REHEARSAL_DESIRED_STATE: desired,
};

describe('rehearsal off-chain stage — inputs', () => {
  it('reads the driver\'s variables into the run folder\'s paths', () => {
    expect(readRehearsalInputs(base, { contractsDir })).toEqual({
      root: '/repo/contracts/deployments/.forge-test/rehearsal/run-1',
      persistTo: '/repo/contracts/deployments/.forge-test/rehearsal/run-1/d1',
      deploymentsPath: '/repo/contracts/deployments/.forge-test/rehearsal/run-1/.bundle/contracts-pkg/src/deployments.json',
      rpcUrl: 'http://127.0.0.1:8545',
      desiredStatePath: desired,
    });
  });

  it('runs only as a driver step', () => {
    expect(() => readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL: undefined }, { contractsDir })).toThrow(/driver/);
  });

  it('refuses a root outside the rehearsal prefix', () => {
    expect(() => readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL_ROOT: 'deployments/base-sepolia' }, { contractsDir })).toThrow();
  });

  it('drives only a fork on loopback, and never echoes the URL', () => {
    const remote = 'https://base-sepolia.example/v2/SECRETKEY';
    let message = '';
    try {
      readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL_RPC_URL: remote }, { contractsDir });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/loopback/);
    expect(message).not.toContain('SECRETKEY');
    expect(() => readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL_RPC_URL: undefined }, { contractsDir })).toThrow(/not set/);
  });

  it('needs the desired-state file', () => {
    expect(() => readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL_DESIRED_STATE: undefined }, { contractsDir })).toThrow(/not set/);
    expect(() => readRehearsalInputs({ ...base, VAIPAKAM_REHEARSAL_DESIRED_STATE: '/no/such/file.json' }, { contractsDir })).toThrow(/names no file/);
  });
});

describe('rehearsal off-chain stage — the arming list', () => {
  const file = (armed: unknown) => ({ keeper: { armed } });

  it('reads one chain\'s flags from keeper.armed', () => {
    expect(armedFlagsFor(file({ 'base-sepolia': ['GRACE_DEFAULT_ENABLED', 'PRICE_CHECKPOINT_ENABLED'] }), 'base-sepolia')).toEqual([
      'GRACE_DEFAULT_ENABLED',
      'PRICE_CHECKPOINT_ENABLED',
    ]);
  });

  it('reads an empty list as nothing armed, and a missing chain as an error', () => {
    expect(armedFlagsFor(file({ 'bnb-testnet': [] }), 'bnb-testnet')).toEqual([]);
    expect(() => armedFlagsFor(file({}), 'bnb-testnet')).toThrow(/no entry for bnb-testnet/);
  });

  it('refuses a flag no pass reads, by name', () => {
    expect(() => armedFlagsFor(file({ x: ['GRACE_DEFAULT_ENABLE'] }), 'x')).toThrow(/GRACE_DEFAULT_ENABLE\b/);
    expect(() => armedFlagsFor(file({ x: ['KEEPER_ENABLED'] }), 'x')).toThrow(/KEEPER_ENABLED/);
  });

  it('refuses a malformed file or list, and a repeated flag', () => {
    expect(() => armedFlagsFor({}, 'x')).toThrow(/keeper\.armed/);
    expect(() => armedFlagsFor(file(['GRACE_DEFAULT_ENABLED']), 'x')).toThrow(/keeper\.armed/);
    expect(() => armedFlagsFor(file({ x: 'GRACE_DEFAULT_ENABLED' }), 'x')).toThrow(/not a list/);
    expect(() => armedFlagsFor(file({ x: ['GRACE_DEFAULT_ENABLED', 'GRACE_DEFAULT_ENABLED'] }), 'x')).toThrow(/more than once/);
  });

  it('knows every flag the keeper reads (one list, not a copy)', () => {
    expect(PASS_ARMING_FLAGS.length).toBeGreaterThan(30);
    expect(new Set(PASS_ARMING_FLAGS).size).toBe(PASS_ARMING_FLAGS.length);
  });
});

describe('rehearsal off-chain stage — the local shared database', () => {
  const dirs: string[] = [];
  const persist = (files: string[]) => {
    const p = mkdtempSync(join(tmpdir(), 'rehearsal-d1-'));
    dirs.push(p);
    const dir = join(p, 'v3', 'd1', 'miniflare-D1DatabaseObject');
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), '');
    return { p, dir };
  };

  it('finds the one database file beside wrangler\'s metadata', () => {
    const { p, dir } = persist(['metadata.sqlite', 'abc123.sqlite']);
    expect(localD1File(p)).toBe(join(dir, 'abc123.sqlite'));
  });

  it('refuses none, more than one, or no folder at all', () => {
    expect(() => localD1File(persist(['metadata.sqlite']).p)).toThrow(/found 0/);
    expect(() => localD1File(persist(['a.sqlite', 'b.sqlite']).p)).toThrow(/found 2/);
    expect(() => localD1File('/no/such/folder')).toThrow(/migrate:rehearsal/);
  });

  it('opens an existing file and never creates one', () => {
    expect(() => openSqliteD1('/no/such/db.sqlite')).toThrow(/no database file/);
  });
});

describe('rehearsal off-chain stage — reading a pass', () => {
  it('a pass that finished ran', () => {
    expect(classifyPass('matcher', 5, null, [], ['[keeper] matcher start'])).toEqual({ pass: 'matcher', result: 'ran', ms: 5 });
  });

  it('a pass that gated itself off is not armed, with its reason', () => {
    expect(classifyPass('graceDefault', 1, null, [], ['[keeper] graceDefault skipped: GRACE_DEFAULT_ENABLED unset'])).toEqual({
      pass: 'graceDefault',
      result: 'not-armed',
      ms: 1,
      detail: 'GRACE_DEFAULT_ENABLED unset',
    });
  });

  it('a pass that tried a service off the fork is not rehearsed, whether or not it threw', () => {
    expect(classifyPass('assetRankings', 2, { message: 'refused' }, ['https://api.example', 'https://api.example'])).toEqual({
      pass: 'assetRankings',
      result: 'not-rehearsed',
      ms: 2,
      services: ['https://api.example'],
      detail: 'refused',
    });
    expect(classifyPass('watcher', 2, null, ['https://agent.example']).result).toBe('not-rehearsed');
  });

  it('a pass that threw with nothing refused failed, and fails the stage', () => {
    const o = classifyPass('liquidator', 3, { message: 'boom' }, []);
    expect(o).toEqual({ pass: 'liquidator', result: 'failed', ms: 3, detail: 'boom' });
    expect(stagePassed([o])).toBe(false);
    expect(stagePassed([classifyPass('matcher', 1, null, [])])).toBe(true);
  });

  it('a pass that caught and logged its own failure failed, even though it returned', () => {
    const line = '[keeper] runLiquidityConfidence chain=84532 failed: execution reverted';
    const o = classifyPass('liquidityConfidence', 4, null, [], [line], [line]);
    expect(o).toEqual({ pass: 'liquidityConfidence', result: 'failed', ms: 4, detail: `reported failure: ${line}` });
    expect(stagePassed([o])).toBe(false);
  });

  it('an error line outweighs a skip line, and many error lines are summarised', () => {
    const skip = '[keeper] graceDefault skipped: GRACE_DEFAULT_ENABLED unset';
    expect(classifyPass('graceDefault', 1, null, [], [skip, 'x'], ['x']).result).toBe('failed');
    const errs = ['a', 'b', 'c', 'd', 'e'];
    expect(classifyPass('matcher', 1, null, [], errs, errs)).toMatchObject({ result: 'failed', detail: 'reported failure: a | b | c (and 2 more)' });
  });

  it('a refused outside service still reads as not rehearsed when the pass also logged an error', () => {
    expect(classifyPass('watcher', 2, null, ['https://agent.example'], ['e'], ['e']).result).toBe('not-rehearsed');
  });

  it('every scheduled pass has a distinct name to read its skip line by', () => {
    const names = KEEPER_PASSES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('rehearsal off-chain stage — the health route', () => {
  const diamond = '0xAbC0000000000000000000000000000000000001';
  const healthy = {
    schema: { state: 'current' },
    configured: { chains: [84532] },
    chains: [{ chainId: 84532, lastBlock: 10, deployment: { diamond: diamond.toLowerCase(), resetPending: false } }],
  };

  it('passes when the new Diamond is adopted, current and scanning', () => {
    expect(healthVerdict(200, healthy, 84532, diamond)).toEqual({ ok: true, problems: [] });
  });

  it('names each unmet requirement', () => {
    const r = healthVerdict(
      503,
      { schema: { state: 'pending', missing: ['0119_x.sql'] }, configured: { chains: [] }, chains: [{ chainId: 84532, lastBlock: null, deployment: { diamond: '0x01', resetPending: true } }] },
      84532,
      diamond,
    );
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/503/);
    expect(r.problems.join('\n')).toMatch(/0119_x\.sql/);
    expect(r.problems.join('\n')).toMatch(/configured/);
    expect(r.problems.join('\n')).toMatch(/adopted 0x01/);
    expect(r.problems.join('\n')).toMatch(/reset pending/);
    expect(r.problems.join('\n')).toMatch(/no cursor/);
    expect(healthVerdict(200, { ...healthy, chains: [] }, 84532, diamond).problems).toEqual(['chain 84532 has no ingest row']);
  });
});

describe('rehearsal off-chain stage — outbound requests', () => {
  const saved = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = saved;
  });

  it('reaches the fork, refuses and records anything else by origin only', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('ok');
    }) as typeof fetch;
    const n = narrowFetchTo('http://127.0.0.1:8545');
    await globalThis.fetch('http://127.0.0.1:8545/');
    await expect(globalThis.fetch('https://api.0x.org/swap?apiKey=SECRET')).rejects.toThrow(/https:\/\/api\.0x\.org refused/);
    expect(calls).toEqual(['http://127.0.0.1:8545/']);
    expect(n.take()).toEqual(['https://api.0x.org']);
    expect(n.take()).toEqual([]);
    n.restore();
    await globalThis.fetch('https://elsewhere.example');
    expect(calls).toHaveLength(2);
  });

  it('captures a pass\'s console lines and its error', async () => {
    const r = await captureConsole(async () => {
      console.log('[keeper] matcher start', { n: 1n });
      throw new Error('x');
    });
    expect(r.lines).toEqual(['[keeper] matcher start {"n":"1"}']);
    expect((r.error as Error).message).toBe('x');
  });

  it('redacts the fork URL from anything written', () => {
    expect(redactUrl('error at http://127.0.0.1:9 and http://127.0.0.1:9', 'http://127.0.0.1:9')).toBe(
      'error at $VAIPAKAM_REHEARSAL_RPC_URL and $VAIPAKAM_REHEARSAL_RPC_URL',
    );
  });
});

describe('rehearsal — the Worker publish dry runs', () => {
  it('finds every Worker with a dry run, the shared-database three among them', () => {
    const names = (dryRunWorkers() as { name: string; script: string }[]).map((w) => w.name);
    for (const w of ['@vaipakam/indexer', '@vaipakam/keeper', '@vaipakam/agent']) expect(names).toContain(w);
    for (const w of dryRunWorkers() as { script: string }[]) expect(w.script).toMatch(/--dry-run/);
  });
});
