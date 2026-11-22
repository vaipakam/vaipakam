/**
 * The deploy rehearsal's off-chain stage for ONE chain (#3894,
 * DeployRehearsalDesign §7 and §16). The rehearsal driver runs it once per
 * fork, after the readback, with `pnpm --filter @vaipakam/keeper run
 * rehearsal:offchain`; the inputs are described in `plan.ts`. It is a vitest
 * file only so the deployments redirect (`../bundleRedirect.ts`) points the
 * keeper and the indexer at the run's scratch bundle, as the keeper's
 * scenarios do; it is never part of `vitest run`.
 *
 * In order:
 *
 *   1. The fork carries the rehearsal marker; its chain id picks the bundle's
 *      entry, and so the Diamond, deploy block and chain slug.
 *   2. The indexer: the REAL per-chain pass, against the local shared
 *      database the indexer's own deploy path built under the run folder
 *      (`migrate:rehearsal`), from the deploy block until the cursor reaches
 *      the head. Then the Worker's own `/health/ingest` handler must report
 *      the new Diamond adopted on this chain.
 *   3. The bot keys made for the run, funded, each granted its bot role.
 *   4. The keeper: the real tick's setup (the one-runner lease, the keeper's
 *      own deployment epochs, the epoch fence read from the shared database,
 *      the submission routes and the signing guard), then ONE run of every
 *      pass in the schedule, with the arming flags `keeper.armed` lists for
 *      this chain. A pass that throws fails the stage; one that tried a
 *      service off the fork is reported as not rehearsed, by name.
 *   5. The report, `<root>/reports/offchain-<slug>.json`.
 *
 * Outbound requests are narrowed to the fork for steps 2 and 4. The keeper's
 * private database is an in-memory one built from its migrations, and the
 * report says so: the rehearsal has no deployed private database to stand in
 * for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, type Address } from 'viem';
import { expect, it } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { anvilControl } from '@vaipakam/anvil-harness/rpc';
import { configuredScanChains, getChainConfigs as indexerChains, rpcBindingFor, type Env as IndexerEnv } from '../../../indexer/src/env';
import { handleIngestHealth } from '../../../indexer/src/healthRoutes';
import { getChainConfigs as keeperChains, type Env, type WorkerEnv } from '../../src/env';
import { KEEPER_PASSES, runDeadline } from '../../src/passSchedule';
import { runKeeperTick } from '../../src/tick';
import { disarmEpochFence } from '../../src/epochFence';
import { createKeeperD1 } from '../../test/helpers/schemas';
import { openSqliteD1 } from '../../test/helpers/sqliteD1';
import { indexToHead } from '../harness/indexer';
import { checkFork, grantBotRoles, type BotKeys } from './forkNode';
import { captureConsole, narrowFetchTo } from './outbound';
import { armedFlagsFor, classifyPass, healthVerdict, localD1File, readRehearsalInputs, redactUrl, stagePassed, type PassOutcome } from './plan';

/** The lease holder name the stage's keeper claims under. */
const RUNNER_ID = 'deploy-rehearsal';

it('rehearses the indexer and every keeper pass on this fork', async () => {
  const inputs = readRehearsalInputs(process.env);
  const url = inputs.rpcUrl;
  const chainId = await checkFork(url);
  const dep = getDeployment(chainId);
  if (!dep) throw new Error(`rehearsal: the run's bundle has no entry for chain ${chainId}`);
  const slug = dep.chainSlug;
  const diamond = dep.diamond as Address;
  const flags = armedFlagsFor(JSON.parse(readFileSync(inputs.desiredStatePath, 'utf8')), slug);
  const binding = rpcBindingFor(chainId);
  if (!binding) throw new Error(`rehearsal: no RPC binding is known for chain ${chainId}`);
  const shared = openSqliteD1(localD1File(inputs.persistTo));
  const client = createPublicClient({ transport: http(url) });
  const control = anvilControl(url);
  let mined = 0;
  const node = {
    async mineBlocks(n: number) {
      await control.mine(n);
      mined += n;
    },
    blockNumber: () => client.getBlockNumber(),
  };

  const narrowed = narrowFetchTo(url);
  const report: Record<string, unknown> = {
    stage: 'offchain',
    chainId,
    slug,
    diamond,
    deployBlock: dep.deployBlock,
    armedFlags: flags,
    sharedDatabase: 'the local database the indexer deploy path built under the run folder',
    keeperPrivateDatabase: 'in memory, built from apps/keeper/migrations; the rehearsal has no deployed private database',
  };
  let bots: BotKeys | null = null;
  const outcomes: PassOutcome[] = [];
  const failures: string[] = [];
  try {
    // 2. The indexer, then its health route.
    const indexerEnv = { DB: shared.d1, [binding.binding]: url, fetchFn: globalThis.fetch /* the narrowed one, installed above */ } as unknown as IndexerEnv;
    const ichains = indexerChains(indexerEnv);
    if (ichains.length !== 1 || ichains[0].id !== chainId) {
      throw new Error(`rehearsal: the indexer resolves ${ichains.map((c) => c.id).join(', ') || 'no chain'}, not chain ${chainId} alone`);
    }
    const indexed = await indexToHead(indexerEnv, ichains[0], node);
    const health = await handleIngestHealth(shared.d1 as never, configuredScanChains(indexerEnv));
    const body: unknown = await health.json();
    const verdict = healthVerdict(health.status, body, chainId, diamond);
    report.indexer = { lastPass: indexed, outboundRefused: narrowed.take(), health: body, healthProblems: verdict.problems };
    if (!verdict.ok) failures.push(...verdict.problems.map((p) => `indexer: ${p}`));

    // 3. The bot keys.
    bots = await grantBotRoles(url, diamond, [dep.admin as Address, dep.timelock as Address | undefined]);

    // 4. The keeper: the tick's real setup, then each pass once.
    const keeperDb = createKeeperD1();
    const env = {
      DB: shared.d1,
      KEEPER_DB: keeperDb.d1,
      [binding.binding]: url,
      KEEPER_ENABLED: 'true',
      KEEPER_PRIVATE_KEY: bots.keeperKey,
      KEEPER_RUNNER_ID: RUNNER_ID,
      ...Object.fromEntries(flags.map((f) => [f, 'true'])),
    } as unknown as WorkerEnv;
    const kchains = keeperChains(env as unknown as Env);
    if (kchains.length !== 1 || kchains[0].id !== chainId) {
      throw new Error(`rehearsal: the keeper resolves ${kchains.map((c) => c.id).join(', ') || 'no chain'}, not chain ${chainId} alone`);
    }
    const launched: string[] = [];
    const setup = await captureConsole(() => runKeeperTick(env, Date.now(), (name) => void launched.push(name)));
    // The tick launches its rebroadcast step only once every setup step above
    // it succeeded; a declined tick returns early and launches nothing.
    if (setup.error !== undefined || !launched.includes('privateRebroadcast')) {
      throw new Error(`rehearsal: the keeper tick's setup declined: ${setup.lines.filter((l) => /declined|failed/.test(l)).join(' | ') || String(setup.error)}`);
    }
    narrowed.take();
    for (const pass of KEEPER_PASSES) {
      const now = Date.now();
      const started = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const run = await captureConsole(() => pass.run(env as unknown as Env, { scheduledTimeMs: now, deadlineMs: runDeadline(pass, now) }));
      const threw = run.error === undefined ? null : { message: redactUrl(String((run.error as Error)?.message ?? run.error), url) };
      outcomes.push(classifyPass(pass.name, Date.now() - started, threw, narrowed.take(), run.lines));
    }
    for (const o of outcomes) if (o.result === 'failed') failures.push(`keeper pass ${o.pass}: ${o.detail}`);
  } catch (err) {
    failures.push(redactUrl(String((err as Error)?.message ?? err), url));
  } finally {
    narrowed.restore();
    disarmEpochFence();
  }

  report.forkChanges = {
    blocksMined: mined,
    botKeys: bots ? { funded: bots.funded, roleGrants: bots.grants } : null,
  };
  report.keeper = { passes: outcomes };
  report.failures = failures;
  report.passed = failures.length === 0 && stagePassed(outcomes);
  mkdirSync(join(inputs.root, 'reports'), { recursive: true });
  writeFileSync(join(inputs.root, 'reports', `offchain-${slug}.json`), `${redactUrl(JSON.stringify(report, null, 2), url)}\n`);
  expect(failures, failures.join('\n')).toEqual([]);
});
