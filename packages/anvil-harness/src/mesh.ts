/**
 * A TWO-chain fixture: a canonical reward chain and a mirror, each the
 * repository's CURRENT contracts deployed from source onto its own anvil,
 * joined by a local CCIP lane — built once per suite run and restarted fresh
 * for every scenario. Shared by the keeper's two-chain scenarios
 * (`apps/keeper/e2e/mesh`, #2516) and the protocol's (`packages/protocol-e2e`,
 * #848); each suite owns one {@link MeshFixtureStore}, with its own state
 * directory, artifact root and ports, so the two never read each other's
 * build.
 *
 * {@link MeshFixtureStore.prepare} deploys each node the way the single-chain
 * fixtures deploy theirs (`deployFromSource`), presenting Base Sepolia (84532)
 * and Sepolia (11155111). It then wires the two the way an operator wires a
 * live Base/mirror pair, by running the OPERATOR SCRIPTS themselves — not
 * restatements of them — through `contracts/script/e2e/E2EOperatorScripts.s.sol`,
 * which redirects only where each writes its artifact:
 *
 *   1. a local CCIP lane on each node (`DeployE2ELocalCcip`): the real
 *      router, RMN and token admin registry, and the two ramps the relay
 *      drives (`ccipLane.ts`);
 *   2. `DeployVPFIToken` on Base (initial supply to the admin, who funds the
 *      reward pool from it in step 8);
 *   3. `DeployCrosschain` on both: messenger, VPFI pool (lock/release on
 *      Base, burn/mint over a fresh mirror token on the mirror), rate
 *      governor, reward messenger, the remittance receivers;
 *   4. `ConfigureVPFIToken` on both;
 *   5. `ConfigureCcip` on both, each naming the other as its one lane, with
 *      the admin as the incident guardian;
 *   6. `ConfigureRewardReporter` on both: Base canonical, expecting reports
 *      from both chains; the mirror reporting to Base;
 *   7. `SetInteractionLaunch` on both, with ONE launch timestamp (every
 *      chain of a mesh must share day 0);
 *   8. the admin steps no script performs (`ConfigureMeshRewardsFixture`):
 *      reward custody activated on both; on Base, the reward pool funded and
 *      the suite's named remitter authorized to remit.
 *
 * Each node's artifact lives under the store's gitignored artifact root in
 * `contracts/deployments/.forge-test/`, which is where every script reads its
 * own chain's addresses and `ConfigureCcip` reads the other's. The bundle the
 * store publishes carries both chains.
 *
 * Every key is minted for the run (deployer, admin, the relay's) or an Anvil
 * well-known development key (the remitter a suite names), so nothing
 * outlives the run.
 */
import fs from 'node:fs';
import path from 'node:path';
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
} from './fixture';
import { compileLocalLane, deployLocalLane, type LocalLane } from './ccipLane';
import { anvilControl } from './rpc';
import { spawnAnvil, type SpawnedAnvil } from './process';

/** The canonical reward chain and the mirror, by the ids their nodes present. */
export const BASE_ID = 84532;
export const MIRROR_ID = 11155111;

const OPERATOR_SCRIPTS = 'script/e2e/E2EOperatorScripts.s.sol';
const MESH_SCRIPT = 'script/e2e/ConfigureMeshRewardsFixture.s.sol';
/** The scripts a mesh build compiles (a CI job may compile them in a step of its own). */
export const MESH_SCRIPTS = ['script/e2e/DeployE2ELocalCcip.s.sol', OPERATOR_SCRIPTS, MESH_SCRIPT] as const;

/** VPFI the admin forwards to Base's live fresh row: far above anything a
 *  scenario's few days can owe or remit, so funding never gates one. */
export const MESH_REWARD_POOL_FUND = 1_000_000n * 10n ** 18n;
/** The native fee each lane's on-ramp quotes (and the sender pays) per message. */
export const LANE_NATIVE_FEE = 10n ** 15n;
/** The reward reporter's grace on both chains. */
const GRACE_SECONDS = 3600;

/** One chain of the mesh, as a scenario needs it (`ChainFixture`-shaped). */
export interface MeshChainFixture {
  chainId: number;
  diamond: Address;
  admin: Address;
  adminKey: Hex;
  deployerKey: Hex;
  /** The block the Diamond was deployed at. */
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
  /** The address Base authorized to call `remitRewardBudget`. */
  rewardRemitter: Address;
  interactionLaunchTimestamp: number;
}

export interface MeshFixtureStoreOptions {
  /** Where the dumps, the bundle and the completion marker go. */
  stateDir: string;
  /** The artifact root, relative to `contracts/`, under `deployments/.forge-test/`
   *  (`ArtifactRootBase` admits nothing else). */
  artifactRoot: string;
  /** The first of the ports the store's nodes listen on: the two build nodes
   *  take `port` and `port + 1`, scenario nodes the ones above. */
  port: number;
  /** The tag the build's log lines carry. */
  label: string;
}

/** What a suite asks of the mesh seed beyond the shared wiring. */
export interface MeshSeed {
  /** The address Base authorizes to call `remitRewardBudget`. */
  rewardRemitter: Address;
}

/** One suite's two-chain fixture: building it, loading it, starting its nodes. */
export class MeshFixtureStore {
  readonly bundlePath: string;
  private readonly fixturePath: string;
  private readonly statePaths: Record<number, string>;
  private nextPort: number;

  constructor(private readonly opts: MeshFixtureStoreOptions) {
    if (!opts.artifactRoot.startsWith('deployments/.forge-test/')) {
      throw new Error(`mesh artifact root must sit under deployments/.forge-test/, not ${opts.artifactRoot}`);
    }
    this.bundlePath = path.join(opts.stateDir, 'deployments.json');
    this.fixturePath = path.join(opts.stateDir, 'fixture.json');
    this.statePaths = {
      [BASE_ID]: path.join(opts.stateDir, 'base-chain.json'),
      [MIRROR_ID]: path.join(opts.stateDir, 'mirror-chain.json'),
    };
    this.nextPort = opts.port + 2;
  }

  /** True when a complete build is in place (the completion marker exists). */
  isBuilt(): boolean {
    return fs.existsSync(this.fixturePath);
  }

  private contractsFile(relative: string): string {
    return path.join(REPO_ROOT, 'contracts', relative);
  }

  private artifactRelative(chainId: number): string {
    return `${this.opts.artifactRoot}/${PRESENTED_CHAIN_SLUGS[chainId]}/addresses.json`;
  }

  /** Publish a fresh deploy's artifact as the chain's own, under the root.
   *  The deploy ran on 31337, so its header names that chain; the node now
   *  presents `chainId`, and every script reads the artifact as that chain's. */
  private seedArtifact(chainId: number, d: FixtureDeployment): void {
    const file = this.contractsFile(this.artifactRelative(chainId));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...d.artifact, chainId, chainSlug: PRESENTED_CHAIN_SLUGS[chainId] }, null, 2));
  }

  /** Build both chains and publish the state directory — a suite's global setup. */
  async prepare(seed: MeshSeed): Promise<void> {
    const { stateDir, artifactRoot, port, label } = this.opts;
    fs.mkdirSync(stateDir, { recursive: true });
    // The completion marker goes first, so no interruption can leave it
    // standing over parts that are already gone.
    for (const f of [this.fixturePath, this.bundlePath, ...Object.values(this.statePaths)]) fs.rmSync(f, { force: true });
    // A previous run's artifacts must not be read as this run's.
    fs.rmSync(this.contractsFile(artifactRoot), { recursive: true, force: true });

    const log = (l: string) => console.log(l.replace('[e2e]', `[${label}]`));
    const nodes: Record<number, SpawnedAnvil> = {};
    let fixture: MeshFixture;
    try {
      nodes[BASE_ID] = await spawnAnvil({ url: `http://127.0.0.1:${port}`, chainId: DEPLOY_CHAIN_ID, dumpStatePath: this.statePaths[BASE_ID] });
      nodes[MIRROR_ID] = await spawnAnvil({ url: `http://127.0.0.1:${port + 1}`, chainId: DEPLOY_CHAIN_ID, dumpStatePath: this.statePaths[MIRROR_ID] });
      const baseUrl = nodes[BASE_ID].url;
      const mirrorUrl = nodes[MIRROR_ID].url;

      // Each deploy writes the shared fixture artifact, so they run one after
      // the other and each is copied out before the next starts.
      log(`[${label}] deploying the canonical chain (presents ${BASE_ID})…`);
      const base = await deployFromSource(baseUrl, { log, presentAs: BASE_ID });
      this.seedArtifact(BASE_ID, base);
      log(`[${label}] deploying the mirror chain (presents ${MIRROR_ID})…`);
      const mirror = await deployFromSource(mirrorUrl, { log, presentAs: MIRROR_ID });
      this.seedArtifact(MIRROR_ID, mirror);

      log(`[${label}] compiling the lane, the operator-script wrappers and the mesh seed…`);
      compileLocalLane();
      compileScript(OPERATOR_SCRIPTS);
      compileScript(MESH_SCRIPT);

      // 1. The local lane. One relay key, accepted by both off-ramps.
      const relayerKey = generatePrivateKey();
      const relayer = privateKeyToAccount(relayerKey).address;
      for (const url of [baseUrl, mirrorUrl]) await anvilControl(url).setBalance(relayer, 10n ** 21n);
      log(`[${label}] deploying the local CCIP lane on both chains…`);
      const lanes: Record<number, LocalLane> = {
        [BASE_ID]: deployLocalLane(baseUrl, {
          deployerKey: base.deployerKey,
          remoteChainId: MIRROR_ID,
          relayer,
          nativeFeeWei: LANE_NATIVE_FEE,
          outRelative: `${artifactRoot}/${PRESENTED_CHAIN_SLUGS[BASE_ID]}/ccip.json`,
        }),
        [MIRROR_ID]: deployLocalLane(mirrorUrl, {
          deployerKey: mirror.deployerKey,
          remoteChainId: BASE_ID,
          relayer,
          nativeFeeWei: LANE_NATIVE_FEE,
          outRelative: `${artifactRoot}/${PRESENTED_CHAIN_SLUGS[MIRROR_ID]}/ccip.json`,
        }),
      };

      const op = (contract: string, url: string, env: Record<string, string>) =>
        runForgeScript(OPERATOR_SCRIPTS, url, { E2E_ARTIFACT_ROOT: artifactRoot, ...env }, { targetContract: contract });
      const each = [
        { id: BASE_ID, url: baseUrl, d: base, remote: MIRROR_ID },
        { id: MIRROR_ID, url: mirrorUrl, d: mirror, remote: BASE_ID },
      ];

      // 2. The canonical VPFI token, its supply to the admin.
      log(`[${label}] DeployVPFIToken (Base)…`);
      op('E2EDeployVPFIToken', baseUrl, {
        DEPLOYER_PRIVATE_KEY: base.deployerKey,
        ADMIN_ADDRESS: base.admin,
        TREASURY_ADDRESS: base.admin,
      });

      // 3–4. The cross-chain stack, and the VPFI registration (the mirror's
      // token exists only once its stack is deployed).
      for (const c of each) {
        log(`[${label}] DeployCrosschain + ConfigureVPFIToken (${c.id})…`);
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
        log(`[${label}] ConfigureCcip (${c.id})…`);
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
      log(`[${label}] ConfigureRewardReporter (both)…`);
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
      const baseArtifactNow = readContractsJson<Record<string, unknown>>(this.artifactRelative(BASE_ID));
      const vpfiToken = baseArtifactNow.vpfiToken as Address;
      log(`[${label}] custody, funding and the remitter (ConfigureMeshRewardsFixture)…`);
      runForgeScript(MESH_SCRIPT, baseUrl, {
        ADMIN_PRIVATE_KEY: base.adminKey,
        DIAMOND_ADDRESS: base.diamond,
        VPFI_TOKEN: vpfiToken,
        REWARD_POOL_FUND_WEI: MESH_REWARD_POOL_FUND.toString(),
        REWARD_REMITTANCE_KEEPER: seed.rewardRemitter,
      });
      runForgeScript(MESH_SCRIPT, mirrorUrl, { ADMIN_PRIVATE_KEY: mirror.adminKey, DIAMOND_ADDRESS: mirror.diamond });

      const chainFixture = (id: number, d: FixtureDeployment): MeshChainFixture => {
        const artifact = readContractsJson<Record<string, unknown>>(this.artifactRelative(id));
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
      fixture = {
        base: chainFixture(BASE_ID, base),
        mirror: chainFixture(MIRROR_ID, mirror),
        relayerKey,
        vpfiToken,
        vpfiMirror: readContractsJson<Record<string, unknown>>(this.artifactRelative(MIRROR_ID)).vpfiMirror as Address,
        rewardRemitter: seed.rewardRemitter,
        interactionLaunchTimestamp: launch,
      };
      fs.writeFileSync(
        this.bundlePath,
        JSON.stringify(bundleWithChains({ [BASE_ID]: fixture.base.artifact, [MIRROR_ID]: fixture.mirror.artifact }), null, 2),
      );
    } finally {
      // Exiting is what writes each state dump.
      await Promise.all(Object.values(nodes).map((n) => n.stop()));
    }
    for (const p of Object.values(this.statePaths)) {
      if (!fs.existsSync(p)) throw new Error(`anvil wrote no state dump at ${p}`);
    }
    // Last, once both nodes have exited and both dumps exist: this file is the
    // fixture's completion marker, so finding it means every part is in place
    // (a run interrupted earlier leaves none, and the next run rebuilds).
    fs.writeFileSync(this.fixturePath, JSON.stringify(fixture, null, 2));
  }

  /** The fixture {@link prepare} published. */
  load(): MeshFixture {
    if (!this.isBuilt()) {
      throw new Error(`${this.fixturePath} is missing — run the suite through its vitest config, whose global setup builds it`);
    }
    return JSON.parse(fs.readFileSync(this.fixturePath, 'utf8')) as MeshFixture;
  }

  /** A fresh node carrying `chainId`'s fixture state, presenting `chainId`. */
  startNode(chainId: number): Promise<SpawnedAnvil> {
    return spawnAnvil({ url: `http://127.0.0.1:${this.nextPort++}`, chainId, loadStatePath: this.statePaths[chainId] });
  }
}
