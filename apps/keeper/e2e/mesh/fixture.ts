/**
 * The keeper's TWO-chain scenarios' fixture (#2516): a canonical reward chain
 * and a mirror, each the repository's CURRENT contracts deployed from source
 * onto its own anvil, joined by a local CCIP lane — built once per run and
 * restarted fresh for every scenario.
 *
 * {@link prepareMeshFixture} runs in the mesh config's global setup. Each
 * node is deployed the way the single-chain fixture deploys its one
 * (`deployFromSource`), presenting Base Sepolia (84532) and Sepolia
 * (11155111). It then wires the two the way an operator wires a live
 * Base/mirror pair, by running the OPERATOR SCRIPTS themselves — not
 * restatements of them — through `contracts/script/e2e/E2EOperatorScripts.s.sol`,
 * which redirects only where each writes its artifact:
 *
 *   1. a local CCIP lane on each node (`DeployE2ELocalCcip`): the real
 *      router, RMN and token admin registry, and the two ramps the relay
 *      drives (`packages/anvil-harness/src/ccipLane.ts`);
 *   2. `DeployVPFIToken` on Base (initial supply to the admin, who funds the
 *      reward pool from it in step 8);
 *   3. `DeployCrosschain` on both: messenger, VPFI pool (lock/release on
 *      Base, burn/mint over a fresh mirror token on the mirror), rate
 *      governor, reward messenger, the remittance receivers;
 *   4. `ConfigureVPFIToken` on both;
 *   5. `ConfigureCcip` on both, each naming the other as its one lane;
 *   6. `ConfigureRewardReporter` on both: Base canonical, expecting reports
 *      from both chains; the mirror reporting to Base;
 *   7. `SetInteractionLaunch` on both, with ONE launch timestamp (every
 *      chain of a mesh must share day 0);
 *   8. the admin steps no script performs (`ConfigureKeeperMeshFixture`):
 *      reward custody activated on both, the reward pool funded on Base, the
 *      keeper authorized to remit there.
 *
 * Each node's artifact lives under the gitignored
 * `contracts/deployments/.forge-test/e2e-keeper-mesh/<slug>/`, which is where
 * every script reads its own chain's addresses and `ConfigureCcip` reads the
 * other's. The bundle published under `.state/mesh/` carries both chains.
 *
 * Every key is minted for the run (deployer, admin, the relay's) or an Anvil
 * well-known development key (the keeper's), so nothing outlives the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  bundleWithChains,
  compileScript,
  DEPLOY_CHAIN_ID,
  deployFromSource,
  PRESENTED_CHAIN_SLUGS,
  readContractsJson,
  REPO_ROOT,
  runForgeScript,
  type FixtureDeployment,
} from '@vaipakam/anvil-harness/fixture';
import { compileLocalLane, deployLocalLane, type LocalLane } from '@vaipakam/anvil-harness/ccipLane';
import { anvilControl } from '@vaipakam/anvil-harness/rpc';
import { spawnAnvil, type SpawnedAnvil } from '@vaipakam/anvil-harness/process';
import { ANVIL_DEV_KEYS } from '../harness/devKeys';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MESH_STATE_DIR = path.resolve(HERE, '..', '.state', 'mesh');
export const MESH_BUNDLE_PATH = path.join(MESH_STATE_DIR, 'deployments.json');
const FIXTURE_PATH = path.join(MESH_STATE_DIR, 'fixture.json');

/** The canonical reward chain and the mirror, by the ids their nodes present. */
export const BASE_ID = 84532;
export const MIRROR_ID = 11155111;
const STATE_PATHS: Record<number, string> = {
  [BASE_ID]: path.join(MESH_STATE_DIR, 'base-chain.json'),
  [MIRROR_ID]: path.join(MESH_STATE_DIR, 'mirror-chain.json'),
};

/** The ports the two build nodes listen on; scenario nodes take theirs above. */
const FIXTURE_PORT = Number(process.env.KEEPER_E2E_MESH_ANVIL_PORT ?? 8745);

/** The artifact root every script of the mesh reads and writes (relative to
 *  `contracts/`; `ArtifactRootBase` admits only `deployments/.forge-test/`). */
const ARTIFACT_ROOT = 'deployments/.forge-test/e2e-keeper-mesh';
const OPERATOR_SCRIPTS = 'script/e2e/E2EOperatorScripts.s.sol';
const MESH_SCRIPT = 'script/e2e/ConfigureKeeperMeshFixture.s.sol';

/** VPFI the admin forwards to Base's live fresh row: far above anything a
 *  scenario's few days can remit, so funding never gates one. */
export const MESH_REWARD_POOL_FUND = 1_000_000n * 10n ** 18n;
/** The native fee each lane's on-ramp quotes (and the sender pays) per message. */
export const LANE_NATIVE_FEE = 10n ** 15n;
/** The reward reporter's grace, as the single-chain fixture sets it. */
const GRACE_SECONDS = 3600;

/** One chain of the mesh, as a scenario needs it (`ChainFixture`-shaped). */
export interface MeshChainFixture {
  chainId: number;
  diamond: Address;
  admin: Address;
  adminKey: Hex;
  deployerKey: Hex;
  /** The block the Diamond was deployed at (the keeper's ledger floor). */
  deployBlock: number;
  /** The chain's artifact after every script ran (crosschain keys included). */
  artifact: Record<string, unknown>;
  lane: LocalLane;
  rewards: { interactionLaunchTimestamp: number };
}

export interface MeshFixture {
  base: MeshChainFixture;
  mirror: MeshChainFixture;
  /** The key both off-ramps accept messages from (the relay's). */
  relayerKey: Hex;
  /** Base's canonical VPFI token. */
  vpfiToken: Address;
  /** The mirror's VPFI (the burn/mint CCT `DeployCrosschain` deployed). */
  vpfiMirror: Address;
  interactionLaunchTimestamp: number;
}

function contractsFile(relative: string): string {
  return path.join(REPO_ROOT, 'contracts', relative);
}

function artifactRelative(chainId: number): string {
  return `${ARTIFACT_ROOT}/${PRESENTED_CHAIN_SLUGS[chainId]}/addresses.json`;
}

/** Publish a fresh deploy's artifact as the chain's own, under the mesh root.
 *  The deploy ran on 31337, so its header names that chain; the node now
 *  presents `chainId`, and every script reads the artifact as that chain's. */
function seedArtifact(chainId: number, d: FixtureDeployment): void {
  const file = contractsFile(artifactRelative(chainId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...d.artifact, chainId, chainSlug: PRESENTED_CHAIN_SLUGS[chainId] }, null, 2));
}

/** Build both chains and publish `.state/mesh/` — the mesh config's global setup. */
export async function prepareMeshFixture(): Promise<void> {
  fs.mkdirSync(MESH_STATE_DIR, { recursive: true });
  for (const f of [MESH_BUNDLE_PATH, FIXTURE_PATH, ...Object.values(STATE_PATHS)]) fs.rmSync(f, { force: true });
  // A previous run's artifacts must not be read as this run's.
  fs.rmSync(contractsFile(ARTIFACT_ROOT), { recursive: true, force: true });

  const log = (l: string) => console.log(l.replace('[e2e]', '[keeper-e2e mesh]'));
  const nodes: Record<number, SpawnedAnvil> = {};
  try {
    nodes[BASE_ID] = await spawnAnvil({ url: `http://127.0.0.1:${FIXTURE_PORT}`, chainId: DEPLOY_CHAIN_ID, dumpStatePath: STATE_PATHS[BASE_ID] });
    nodes[MIRROR_ID] = await spawnAnvil({ url: `http://127.0.0.1:${FIXTURE_PORT + 1}`, chainId: DEPLOY_CHAIN_ID, dumpStatePath: STATE_PATHS[MIRROR_ID] });
    const baseUrl = nodes[BASE_ID].url;
    const mirrorUrl = nodes[MIRROR_ID].url;

    // Each deploy writes the shared fixture artifact, so they run one after
    // the other and each is copied out before the next starts.
    log('[keeper-e2e mesh] deploying the canonical chain (presents 84532)…');
    const base = await deployFromSource(baseUrl, { log, presentAs: BASE_ID });
    seedArtifact(BASE_ID, base);
    log('[keeper-e2e mesh] deploying the mirror chain (presents 11155111)…');
    const mirror = await deployFromSource(mirrorUrl, { log, presentAs: MIRROR_ID });
    seedArtifact(MIRROR_ID, mirror);

    log('[keeper-e2e mesh] compiling the lane, the operator-script wrappers and the mesh seed…');
    compileLocalLane();
    compileScript(OPERATOR_SCRIPTS);
    compileScript(MESH_SCRIPT);

    // 1. The local lane. One relay key, accepted by both off-ramps.
    const relayerKey = generatePrivateKey();
    const relayer = privateKeyToAccount(relayerKey).address;
    for (const url of [baseUrl, mirrorUrl]) await anvilControl(url).setBalance(relayer, 10n ** 21n);
    log('[keeper-e2e mesh] deploying the local CCIP lane on both chains…');
    const lanes: Record<number, LocalLane> = {
      [BASE_ID]: deployLocalLane(baseUrl, {
        deployerKey: base.deployerKey,
        remoteChainId: MIRROR_ID,
        relayer,
        nativeFeeWei: LANE_NATIVE_FEE,
        outRelative: `${ARTIFACT_ROOT}/${PRESENTED_CHAIN_SLUGS[BASE_ID]}/ccip.json`,
      }),
      [MIRROR_ID]: deployLocalLane(mirrorUrl, {
        deployerKey: mirror.deployerKey,
        remoteChainId: BASE_ID,
        relayer,
        nativeFeeWei: LANE_NATIVE_FEE,
        outRelative: `${ARTIFACT_ROOT}/${PRESENTED_CHAIN_SLUGS[MIRROR_ID]}/ccip.json`,
      }),
    };

    const op = (contract: string, url: string, env: Record<string, string>) =>
      runForgeScript(OPERATOR_SCRIPTS, url, { E2E_ARTIFACT_ROOT: ARTIFACT_ROOT, ...env }, { targetContract: contract });
    const each = [
      { id: BASE_ID, url: baseUrl, d: base, remote: MIRROR_ID },
      { id: MIRROR_ID, url: mirrorUrl, d: mirror, remote: BASE_ID },
    ];

    // 2. The canonical VPFI token, its supply to the admin.
    log('[keeper-e2e mesh] DeployVPFIToken (Base)…');
    op('E2EDeployVPFIToken', baseUrl, {
      DEPLOYER_PRIVATE_KEY: base.deployerKey,
      ADMIN_ADDRESS: base.admin,
      TREASURY_ADDRESS: base.admin,
    });

    // 3–4. The cross-chain stack, and the VPFI registration (the mirror's
    // token exists only once its stack is deployed).
    for (const c of each) {
      log(`[keeper-e2e mesh] DeployCrosschain + ConfigureVPFIToken (${c.id})…`);
      op('E2EDeployCrosschain', c.url, {
        DEPLOYER_PRIVATE_KEY: c.d.deployerKey,
        ADMIN_ADDRESS: c.d.admin,
        CCIP_ROUTER: lanes[c.id].router,
        CCIP_RMN_PROXY: lanes[c.id].rmnProxy,
        ...(c.id === MIRROR_ID ? { BASE_CHAIN_ID: String(BASE_ID) } : {}),
      });
      op('E2EConfigureVPFIToken', c.url, { ADMIN_PRIVATE_KEY: c.d.adminKey });
    }

    // 5. CCIP wiring: needs BOTH chains' stacks in their artifacts.
    for (const c of each) {
      log(`[keeper-e2e mesh] ConfigureCcip (${c.id})…`);
      op('E2EConfigureCcip', c.url, {
        ADMIN_PRIVATE_KEY: c.d.adminKey,
        CCIP_TOKEN_ADMIN_REGISTRY: lanes[c.id].tokenAdminRegistry,
        CCIP_REGISTRY_MODULE_OWNER_CUSTOM: lanes[c.id].registryModuleOwnerCustom,
        CCIP_LANE_CHAIN_IDS: String(c.remote),
        // The incident guardian: the admin, as on a testnet with no separate
        // guardian key.
        CCIP_GUARDIAN: c.d.admin,
        ...(c.id === MIRROR_ID ? { BASE_CHAIN_ID: String(BASE_ID) } : {}),
      });
    }

    // 6. The reward mesh.
    log('[keeper-e2e mesh] ConfigureRewardReporter (both)…');
    op('E2EConfigureRewardReporter', baseUrl, {
      ADMIN_PRIVATE_KEY: base.adminKey,
      BASE_CHAIN_ID: String(BASE_ID),
      REWARD_GRACE_SECONDS: String(GRACE_SECONDS),
      REWARD_EXPECTED_SOURCE_CHAIN_IDS: `${BASE_ID},${MIRROR_ID}`,
      MIRROR_REWARD_DEPLOYMENTS: `${MIRROR_ID}:${mirror.diamond}`,
    });
    op('E2EConfigureRewardReporter', mirrorUrl, {
      ADMIN_PRIVATE_KEY: mirror.adminKey,
      BASE_CHAIN_ID: String(BASE_ID),
      REWARD_GRACE_SECONDS: String(GRACE_SECONDS),
      BASE_REWARD_DEPLOYMENT: base.diamond,
    });

    // 7. One day 0 for the whole mesh: the later of the two heads.
    const launch = Math.max(
      await anvilControl(baseUrl).latestTimestamp(),
      await anvilControl(mirrorUrl).latestTimestamp(),
    );
    for (const c of each) {
      op('E2ESetInteractionLaunch', c.url, { ADMIN_PRIVATE_KEY: c.d.adminKey, INTERACTION_LAUNCH_TIMESTAMP: String(launch) });
    }

    // 8. Custody on both; Base's pool funded and its remitter authorized.
    const baseArtifactNow = readContractsJson<Record<string, unknown>>(artifactRelative(BASE_ID));
    const vpfiToken = baseArtifactNow.vpfiToken as Address;
    log('[keeper-e2e mesh] custody, funding and the remitter (ConfigureKeeperMeshFixture)…');
    runForgeScript(MESH_SCRIPT, baseUrl, {
      ADMIN_PRIVATE_KEY: base.adminKey,
      DIAMOND_ADDRESS: base.diamond,
      VPFI_TOKEN: vpfiToken,
      REWARD_POOL_FUND_WEI: MESH_REWARD_POOL_FUND.toString(),
      REWARD_REMITTANCE_KEEPER: privateKeyToAccount(ANVIL_DEV_KEYS.keeper).address,
    });
    runForgeScript(MESH_SCRIPT, mirrorUrl, { ADMIN_PRIVATE_KEY: mirror.adminKey, DIAMOND_ADDRESS: mirror.diamond });

    const chainFixture = (id: number, d: FixtureDeployment): MeshChainFixture => {
      const artifact = readContractsJson<Record<string, unknown>>(artifactRelative(id));
      return {
        chainId: id,
        diamond: d.diamond,
        admin: d.admin,
        adminKey: d.adminKey,
        deployerKey: d.deployerKey,
        deployBlock: Number(d.artifact.deployBlock ?? 0),
        artifact,
        lane: lanes[id],
        rewards: { interactionLaunchTimestamp: launch },
      };
    };
    const fixture: MeshFixture = {
      base: chainFixture(BASE_ID, base),
      mirror: chainFixture(MIRROR_ID, mirror),
      relayerKey,
      vpfiToken,
      vpfiMirror: readContractsJson<Record<string, unknown>>(artifactRelative(MIRROR_ID)).vpfiMirror as Address,
      interactionLaunchTimestamp: launch,
    };
    fs.writeFileSync(
      MESH_BUNDLE_PATH,
      JSON.stringify(bundleWithChains({ [BASE_ID]: fixture.base.artifact, [MIRROR_ID]: fixture.mirror.artifact }), null, 2),
    );
    // Last: a scenario that finds this file finds a complete fixture.
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  } finally {
    // Exiting is what writes each state dump.
    await Promise.all(Object.values(nodes).map((n) => n.stop()));
  }
  for (const p of Object.values(STATE_PATHS)) {
    if (!fs.existsSync(p)) throw new Error(`anvil wrote no state dump at ${p}`);
  }
}

/** The fixture global setup published. */
export function loadMeshFixture(): MeshFixture {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`${FIXTURE_PATH} is missing — run the two-chain scenarios through e2e/vitest.mesh.config.ts, whose global setup builds it`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as MeshFixture;
}

let nextPort = FIXTURE_PORT + 2;

/** A fresh node carrying `chainId`'s fixture state, presenting `chainId`. */
export async function startMeshNode(chainId: number): Promise<SpawnedAnvil> {
  return spawnAnvil({ url: `http://127.0.0.1:${nextPort++}`, chainId, loadStatePath: STATE_PATHS[chainId] });
}
