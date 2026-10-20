/**
 * The keeper scenarios' chain, built once per run and restarted fresh for
 * every scenario.
 *
 * {@link prepareFixture} runs in vitest's global setup: it spawns a bare anvil,
 * deploys the repository's CURRENT contracts onto it from source (the same
 * `deployFromSource` the connected app's e2e tier uses — compile, etch the
 * canonical contracts, run `contracts/script/e2e/DeployE2EFixture.s.sol`,
 * present the chain as Base Sepolia, 84532), and stops it with its state
 * dumped to `.state/chain.json`. It then publishes, under `.state/`:
 *
 *   - `deployments.json` — the committed bundle with its 84532 entry replaced
 *     by this deployment. `e2e/vitest.config.ts` redirects the one import of
 *     the bundle (`packages/contracts/src/deployments.ts`) to it, so the
 *     keeper's own chain list (`getChainConfigs`) and deploy-block floors
 *     resolve the local Diamond with no code change in the keeper;
 *   - `fixture.json` — the addresses and the run's ephemeral admin key, for
 *     the scenarios' own setup calls.
 *
 * Each scenario then starts its OWN node from the dumped state
 * ({@link startScenarioChain}), so no scenario sees another's transactions or
 * time travel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  bundleWith,
  compileScript,
  DEPLOY_CHAIN_ID,
  deployFromSource,
  E2E_CHAIN_ID,
  readContractsJson,
  runForgeScript,
} from '@vaipakam/anvil-harness/fixture';
import { spawnAnvil, type SpawnedAnvil } from '@vaipakam/anvil-harness/process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.resolve(HERE, '..', '.state');
export const BUNDLE_PATH = path.join(STATE_DIR, 'deployments.json');
const CHAIN_STATE_PATH = path.join(STATE_DIR, 'chain.json');
const FIXTURE_PATH = path.join(STATE_DIR, 'fixture.json');

/** The port the build node listens on; each scenario takes its own above it. */
const FIXTURE_PORT = Number(process.env.KEEPER_E2E_ANVIL_PORT ?? 8645);

export { E2E_CHAIN_ID };

/** The script that makes the fixture a canonical reward deployment. */
const REWARDS_SCRIPT = 'script/e2e/ConfigureKeeperRewardsFixture.s.sol';
const REWARDS_OUT = 'deployments/.forge-test/e2e/keeper/rewards.json';
/** VPFI the seed puts behind the live fresh row: far above anything the
 *  scenarios' few reward days can owe, so funding never gates a claim. */
export const REWARD_POOL_FUND = 1_000_000n * 10n ** 18n;

/** What the reward seed created (see the script's header). */
export interface KeeperRewardsSeed {
  vpfiToken: `0x${string}`;
  sanctionsOverlay: `0x${string}`;
  interactionLaunchTimestamp: number;
  rewardPoolFunded: string;
}

export interface KeeperFixture {
  diamond: `0x${string}`;
  admin: `0x${string}`;
  adminKey: Hex;
  deployerKey: Hex;
  /** The block the Diamond was deployed at (the keeper's ledger floor). */
  deployBlock: number;
  /** Every address the fixture artifact records (mocks under `testnetMocks`),
   *  plus the reward seed's `vpfiToken`. */
  artifact: Record<string, unknown>;
  /** The canonical reward posture the seed configured. */
  rewards: KeeperRewardsSeed;
}

/** Build the chain and publish `.state/` — vitest global setup. */
export async function prepareFixture(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of [BUNDLE_PATH, CHAIN_STATE_PATH, FIXTURE_PATH]) fs.rmSync(f, { force: true });
  const node = await spawnAnvil({
    url: `http://127.0.0.1:${FIXTURE_PORT}`,
    chainId: DEPLOY_CHAIN_ID,
    dumpStatePath: CHAIN_STATE_PATH,
  });
  try {
    const log = (l: string) => console.log(l.replace('[e2e]', '[keeper-e2e]'));
    const d = await deployFromSource(node.url, { log });
    // The canonical reward posture, built by the protocol's own entry points
    // (the script's header lists the operator script each step reproduces).
    log('[keeper-e2e] configuring the canonical reward deployment…');
    compileScript(REWARDS_SCRIPT);
    runForgeScript(REWARDS_SCRIPT, node.url, {
      ADMIN_PRIVATE_KEY: d.adminKey,
      DIAMOND_ADDRESS: d.diamond,
      REWARD_POOL_FUND_WEI: REWARD_POOL_FUND.toString(),
    });
    const rewards = readContractsJson<KeeperRewardsSeed>(REWARDS_OUT);
    const artifact = { ...d.artifact, vpfiToken: rewards.vpfiToken };
    const fixture: KeeperFixture = {
      diamond: d.diamond,
      admin: d.admin,
      adminKey: d.adminKey,
      deployerKey: d.deployerKey,
      deployBlock: Number(d.artifact.deployBlock ?? 0),
      artifact,
      rewards,
    };
    fs.writeFileSync(BUNDLE_PATH, JSON.stringify(bundleWith(artifact), null, 2));
    // Last: a scenario that finds this file finds a complete fixture.
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  } finally {
    // Exiting is what writes the state dump.
    await node.stop();
  }
  if (!fs.existsSync(CHAIN_STATE_PATH)) throw new Error(`anvil wrote no state dump at ${CHAIN_STATE_PATH}`);
}

/** The fixture global setup published. */
export function loadFixture(): KeeperFixture {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`${FIXTURE_PATH} is missing — run the scenarios through e2e/vitest.config.ts, whose global setup builds it`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as KeeperFixture;
}

let nextPort = FIXTURE_PORT + 1;

/** A fresh node carrying the fixture's state, presenting 84532. */
export async function startScenarioChain(): Promise<SpawnedAnvil> {
  return spawnAnvil({
    url: `http://127.0.0.1:${nextPort++}`,
    chainId: E2E_CHAIN_ID,
    loadStatePath: CHAIN_STATE_PATH,
  });
}
