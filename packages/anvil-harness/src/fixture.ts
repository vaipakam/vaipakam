/**
 * The e2e chain, built from source (#2334) — shared by every local-Anvil tier.
 *
 * The connected app's suite used to fork live Base Sepolia, which meant it
 * tested the bytecode and state the TESTNET held at the block the job started
 * — not the contracts in the change under review, and not a fixed state. Each
 * run now deploys the repository's current contracts onto a bare anvil, so a
 * run's inputs are the commit and nothing else. The keeper's Anvil scenarios
 * (apps/keeper/e2e) build their chain the same way, through this module.
 *
 * In order, {@link deployFromSource}:
 *   1. compiles the fixture script (`contracts/script/e2e/DeployE2EFixture.s.sol`);
 *   2. etches the three contracts the app expects at canonical addresses —
 *      WETH9 at Base's predeploy, Multicall3, Permit2 — which a bare chain
 *      does not have and the fixture script checks for;
 *   3. runs the fixture script: the Diamond, then the faucet and oracle mocks;
 *   4. switches the chain id to Base Sepolia's, so per-chain wiring keyed on
 *      84532 (the app's curated WETH and chain registry; the keeper's chain
 *      list and the canonical reward role) applies unchanged.
 *
 * What it does NOT do is publish the result: each tier writes its own
 * deployments bundle where its own readers look (the app through a vite hook,
 * the keeper through a vitest one), with {@link bundleWith} building the
 * content.
 *
 * WHY THE SWITCH IS STEP 4. `Deployments` lets a script redirect its artifact
 * only on Anvil's own id, 31337 — on any other id its writes target the
 * committed per-chain file, which is exactly what must never happen from a
 * test. So the deploy happens as 31337 and the chain presents 84532
 * afterwards. Every contract involved reads `block.chainid` at call time, so
 * each EIP-712 domain follows the switch.
 *
 * Deployer and admin are fresh keys per run, funded here: no key outlives the
 * run. They are RETURNED so a tier that must act as the admin (the keeper's
 * scenarios configure reward knobs the way an operator would) signs with the
 * key the deploy granted the role to, rather than impersonating it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toBytes, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { explainMinedRevert } from './minedRevert';
import { anvilControl, assertLoopbackUrl, type AnvilControl } from './rpc';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The monorepo root (this file is packages/anvil-harness/src/fixture.ts). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
// Absolute: Foundry runs from an empty directory (see `isolatedCwd`).
const FIXTURE_SCRIPT = path.join(CONTRACTS_DIR, 'script', 'e2e', 'DeployE2EFixture.s.sol');
/** Where the fixture script's artifact lands — the gitignored scratch root
 *  `Deployments` permits a redirect to, under Anvil's slug. */
const FIXTURE_ARTIFACT_DIR = path.join(CONTRACTS_DIR, 'deployments', '.forge-test', 'e2e');
const FIXTURE_ARTIFACT = path.join(FIXTURE_ARTIFACT_DIR, 'anvil', 'addresses.json');
/** The committed deployments bundle every app reads in production. */
export const COMMITTED_BUNDLE = path.join(REPO_ROOT, 'packages', 'contracts', 'src', 'deployments.json');

/**
 * The local-node marker: code at a keyless address that only a dev node's
 * `anvil_setCode` can place, so no real chain can carry it. A script may
 * redirect its artifact on a node presenting a real chain id only when the
 * marker is there (`contracts/script/lib/ArtifactRoot.sol`,
 * `LOCAL_NODE_MARKER`; the two copies must match byte for byte, and a
 * mismatch fails closed). It opens with INVALID, so a call to it reverts.
 */
export const LOCAL_NODE_MARKER = {
  address: getAddress(`0x${keccak256(toBytes('vaipakam.e2e.local-node-marker')).slice(-40)}`),
  code: '0xfe76616970616b616d20653265206c6f63616c206e6f6465' as Hex,
} as const;

/** The id the deploy runs on, and the id the chain presents afterwards. */
export const DEPLOY_CHAIN_ID = 31337;
export const E2E_CHAIN_ID = 84532;

/**
 * Canonical addresses a bare chain lacks, and how each is put there.
 *
 * Copying runtime code alone installs a contract WITHOUT anything its
 * constructor wrote to storage. That is fine for Multicall3 and Permit2,
 * which keep no constructor state (Permit2's chain id and domain live in
 * immutables, inside the code). It is NOT fine for WETH9, whose `name`,
 * `symbol` and `decimals` are storage variables: an etched copy reports 0
 * decimals, and the app then parses every amount the user types as 0. So
 * WETH9 is CONSTRUCTED normally first and then cloned, code and storage.
 */
type Canonical =
  | { name: string; address: `0x${string}`; install: 'code'; code: () => `0x${string}` }
  | { name: string; address: `0x${string}`; install: 'construct'; source: string; contract: string };

const CANONICAL: ReadonlyArray<Canonical> = [
  {
    name: 'WETH9',
    address: '0x4200000000000000000000000000000000000006',
    install: 'construct',
    source: 'lib/chainlink-evm/contracts/src/v0.8/vendor/canonical-weth/WETH9.sol',
    contract: 'WETH9',
  },
  {
    // The real Multicall3, not `Multicall3Mock`: the mock implements only
    // `aggregate3`, and the app also reads `getBlockNumber()` through it
    // (the forced-close card's provenance), which then never resolves.
    name: 'Multicall3',
    address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    install: 'code',
    code: () => committedRuntime('Multicall3.runtime.hex'),
  },
  {
    // The real Permit2, not `MockPermit2`: spec 12 relies on it verifying
    // signatures. Its runtime is committed because its source is not in the
    // tree; see the provenance note beside the file.
    name: 'Permit2',
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    install: 'code',
    code: () => committedRuntime('Permit2.runtime.hex'),
  },
];

/** A canonical runtime committed beside the fixture script, because its
 *  source is not in the tree — see `contracts/script/e2e/README.md`. */
function committedRuntime(file: string): `0x${string}` {
  return fs.readFileSync(path.join(CONTRACTS_DIR, 'script', 'e2e', file), 'utf8').trim() as `0x${string}`;
}

/** How many leading storage slots a constructed contract's clone copies.
 *  Fixed-layout state variables occupy the low slots; mappings and dynamic
 *  data live at hashed slots, which a freshly constructed contract has not
 *  written. WETH9 uses slots 0–2; the margin is deliberate and cheap. */
const CLONED_SLOTS = 16;

/** The only ambient variables Foundry receives. Everything else the
 *  fixture needs it passes explicitly, so the chain is built from the
 *  checkout and nothing else (#2351 r1). An allowlist rather than a list
 *  of known overrides: the deploy scripts honour dozens of optional
 *  variables — every `FAUCET_*` mock address, price-feed overrides, the
 *  chain-prefixed address overrides the deployment readers consult, and
 *  `FOUNDRY_*` settings such as an output directory that would move the
 *  artifacts this file reads — and a new one would slip past a denylist
 *  the day it is added. What passes is what a process needs to run and
 *  reach the network (the compiler download goes through the proxy). */
const AMBIENT_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/**
 * An empty working directory for Foundry, so it reads no `.env` file.
 *
 * The allowlist above covers the inherited environment, but Foundry adds a
 * second source itself: at startup it loads `.env` from its working
 * directory and from the project root it finds by walking up from there
 * (#2351 r2). Run inside `contracts/`, that is the developer's gitignored
 * `contracts/.env` — deployment overrides and `FOUNDRY_*` settings, loaded
 * after the environment was cleaned. Foundry has no switch to turn this
 * off, so the fixture runs it from a fresh empty directory and names the
 * project with `--root`, which does not trigger the load (checked with a
 * canary `.env`).
 *
 * That only holds if the walk up finds no project: an ancestor carrying
 * `foundry.toml` or `.git` would become the root whose `.env` is read. So
 * the directory is refused, loudly, when one does.
 */
function isolatedCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaipakam-e2e-forge-'));
  for (let d = path.dirname(dir); ; d = path.dirname(d)) {
    for (const marker of ['foundry.toml', '.git']) {
      if (fs.existsSync(path.join(d, marker))) {
        throw new Error(
          `the temp directory ${dir} sits under ${path.join(d, marker)}, so Foundry ` +
            `would treat ${d} as its project and load its .env — point TMPDIR outside any project`,
        );
      }
    }
    if (path.dirname(d) === d) break;
  }
  return dir;
}

/** Run a Foundry command against `contracts/`, failing with its output.
 *  Its environment is the allowlist plus `env`, and it reads no `.env`. */
function foundry(args: string[], env: Record<string, string> = {}): string {
  const ambient: Record<string, string> = {};
  for (const k of AMBIENT_ENV) {
    const v = process.env[k];
    if (v !== undefined) ambient[k] = v;
  }
  const cwd = isolatedCwd();
  const res = spawnSync(args[0], [...args.slice(1), '--root', CONTRACTS_DIR], {
    cwd,
    // `default` explicitly: an exported `quick` from an inner loop skips
    // `script/`, and the fixture would not compile at all.
    env: { ...ambient, FOUNDRY_PROFILE: 'default', ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  if (res.error) throw new Error(`${args.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `${args.slice(0, 2).join(' ')} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  return res.stdout;
}

/**
 * Creation and runtime bytecode from the artifact the fixture compile just
 * wrote. Read from `out/` rather than through `forge inspect`, which
 * resolves a target against the whole project and can trigger a full,
 * test-inclusive compile. The artifact's own compilation target is checked,
 * so a same-named file from another library can never be installed in its
 * place.
 */
function compiledArtifact(
  source: string,
  contract: string,
): { creation: `0x${string}`; runtime: `0x${string}` } {
  const file = path.join(CONTRACTS_DIR, 'out', path.basename(source), `${contract}.json`);
  const art = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    bytecode?: { object?: string };
    deployedBytecode?: { object?: string };
    metadata?: { settings?: { compilationTarget?: Record<string, string> } };
  };
  const target = art.metadata?.settings?.compilationTarget ?? {};
  if (target[source] !== contract) {
    throw new Error(`${file} was compiled from ${JSON.stringify(target)}, not ${source}:${contract}`);
  }
  const hex = (v: string | undefined, what: string): `0x${string}` => {
    if (!v || !/^0x[0-9a-fA-F]+$/.test(v) || v.length <= 2) {
      throw new Error(`${file} carries no ${what} bytecode`);
    }
    return v as `0x${string}`;
  };
  return {
    creation: hex(art.bytecode?.object, 'creation'),
    runtime: hex(art.deployedBytecode?.object, 'runtime'),
  };
}

/** The ABI of a contract the fixture compile (or a {@link compileScript})
 *  built, read from its artifact under `out/` — for a harness that drives a
 *  script-side contract (the local CCIP lane's ramps) with no TypeScript ABI
 *  of its own. `source` is relative to `contracts/`. */
export function compiledAbi(source: string, contract: string): Abi {
  const file = path.join(CONTRACTS_DIR, 'out', path.basename(source), `${contract}.json`);
  const art = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    abi?: Abi;
    metadata?: { settings?: { compilationTarget?: Record<string, string> } };
  };
  const target = art.metadata?.settings?.compilationTarget ?? {};
  if (target[source] !== contract) {
    throw new Error(`${file} was compiled from ${JSON.stringify(target)}, not ${source}:${contract}`);
  }
  if (!art.abi) throw new Error(`${file} carries no ABI`);
  return art.abi;
}

/** Put `c` at its canonical address — see `CANONICAL` for why the two
 *  install kinds differ. */
async function installCanonical(anvil: AnvilControl, c: Canonical, deployerKey: `0x${string}`): Promise<void> {
  if (c.install === 'code') {
    await anvil.rpc('anvil_setCode', [c.address, c.code()]);
    return;
  }
  const { creation } = compiledArtifact(c.source, c.contract);
  const account = privateKeyToAccount(deployerKey);
  const wallet = createWalletClient({
    account,
    chain: { id: DEPLOY_CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } },
    transport: http(anvil.url),
  });
  const hash = await wallet.sendTransaction({ data: creation, to: null });
  // WAIT for the receipt. Reading it straight after sending races the
  // mining and reads null — observed as an intermittent setup failure.
  const pub = createPublicClient({ transport: http(anvil.url) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    const why = await explainMinedRevert(pub, anvil.rpc, receipt, [compiledAbi(c.source, c.contract)]);
    throw new Error(`constructing ${c.name} for the canonical copy reverted when mined (tx ${hash}): ${why}`);
  }
  if (!receipt.contractAddress) {
    throw new Error(`constructing ${c.name} for the canonical copy left no contract address (tx ${hash})`);
  }
  const built = receipt.contractAddress;
  const code = await anvil.rpc<`0x${string}`>('eth_getCode', [built, 'latest']);
  await anvil.rpc('anvil_setCode', [c.address, code]);
  for (let slot = 0; slot < CLONED_SLOTS; slot++) {
    const key = `0x${slot.toString(16).padStart(64, '0')}`;
    const value = await anvil.rpc<`0x${string}`>('eth_getStorageAt', [built, key, 'latest']);
    await anvil.rpc('anvil_setStorageAt', [c.address, key, value]);
  }
}

/** A canonical WETH9 that cannot be read as 18-decimal WETH would make the
 *  app parse every amount as 0 — assert it before anything runs on it. */
async function assertCanonicalWeth(anvil: AnvilControl, address: `0x${string}`): Promise<void> {
  const decimals = await anvil.rpc<string>('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']);
  if (BigInt(decimals) !== 18n) {
    throw new Error(`WETH9 at ${address} reports ${BigInt(decimals)} decimals after installation, not 18`);
  }
}

async function fundedKey(anvil: AnvilControl): Promise<Hex> {
  const pk = generatePrivateKey();
  await anvil.setBalance(privateKeyToAccount(pk).address, 10n ** 21n);
  return pk;
}

export interface FixtureDeployment {
  diamond: `0x${string}`;
  /** The Diamond's admin — holds ADMIN_ROLE and ownership. */
  admin: `0x${string}`;
  /** The admin's ephemeral key, minted for this run (see the header). */
  adminKey: Hex;
  /** The deployer's ephemeral key, minted for this run; holds the mocks' supply. */
  deployerKey: Hex;
  /** The fixture artifact as the deploy script wrote it (every address it records). */
  artifact: Record<string, unknown>;
}

/** Compile the fixture script — the whole Diamond and its mocks, viaIR. The
 *  only slow step; a CI job runs it as its own step so its time and any
 *  compile error stay out of the suite's log. */
export function compileFixture(): void {
  foundry(['forge', 'build', FIXTURE_SCRIPT]);
}

/** A script under `contracts/`, given relative to it (e.g.
 *  `script/e2e/ConfigureKeeperRewardsFixture.s.sol`), as an absolute path. */
function contractsPath(relative: string): string {
  const abs = path.resolve(CONTRACTS_DIR, relative);
  if (!abs.startsWith(CONTRACTS_DIR + path.sep)) throw new Error(`${relative} is not under contracts/`);
  return abs;
}

/** Compile one more script under `contracts/` (a tier's own setup script).
 *  The fixture's compile has already built the Diamond, so this pays only
 *  for what the script adds. */
export function compileScript(relative: string): void {
  foundry(['forge', 'build', contractsPath(relative)]);
}

/**
 * Broadcast a script under `contracts/` against the anvil at `url`, under the
 * same isolation as the fixture deploy: an empty working directory, the
 * ambient allowlist plus `env`, no `.env`. Returns the script's stdout.
 */
export function runForgeScript(
  relative: string,
  url: string,
  env: Record<string, string>,
  opts: { targetContract?: string } = {},
): string {
  // `--tc` picks one contract of a file that declares several (the e2e
  // wrappers of the operator scripts, `script/e2e/E2EOperatorScripts.s.sol`).
  const target = opts.targetContract ? ['--tc', opts.targetContract] : [];
  // A broadcast signs with the scenario's keys: local nodes only.
  assertLoopbackUrl(url);
  return foundry(['forge', 'script', contractsPath(relative), ...target, '--rpc-url', url, '--broadcast', '--slow'], env);
}

/** A file the scripts wrote under `contracts/` (e.g. under the gitignored
 *  `deployments/.forge-test/`), parsed as JSON. */
export function readContractsJson<T = Record<string, unknown>>(relative: string): T {
  return JSON.parse(fs.readFileSync(contractsPath(relative), 'utf8')) as T;
}

/**
 * Deploy the repository's current contracts onto the bare anvil at `url`
 * (which must present Anvil's own id, 31337) and switch it to present
 * `opts.presentAs` — 84532 unless a caller building a second chain names
 * another (the keeper's two-chain scenarios present one node as Sepolia).
 * Steps 1–4 of the header; the caller publishes the result.
 */
export async function deployFromSource(
  url: string,
  opts: { log?: (line: string) => void; presentAs?: number } = {},
): Promise<FixtureDeployment> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const presentAs = opts.presentAs ?? E2E_CHAIN_ID;
  const anvil = anvilControl(url);
  const chainId = Number(await anvil.rpc<string>('eth_chainId'));
  if (chainId !== DEPLOY_CHAIN_ID) {
    throw new Error(`the fixture deploys on a bare anvil (${DEPLOY_CHAIN_ID}); this one is ${chainId}`);
  }

  log('[e2e] compiling the fixture (current contracts)…');
  compileFixture();

  const installerKey = await fundedKey(anvil);
  for (const c of CANONICAL) {
    await installCanonical(anvil, c, installerKey);
  }
  await assertCanonicalWeth(anvil, '0x4200000000000000000000000000000000000006');

  // A previous run's artifact must not be read as this run's: the deploy
  // writes the file, and a failure part-way would otherwise leave the
  // earlier addresses in place for the caller to publish.
  fs.rmSync(FIXTURE_ARTIFACT_DIR, { recursive: true, force: true });

  const deployerKey = await fundedKey(anvil);
  const adminKey = await fundedKey(anvil);
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  log('[e2e] deploying the Diamond and the testnet mocks…');
  // `--slow`, as the operator deploy passes it: one transaction per receipt.
  // Without it forge sends the batch at once and anvil can leave the
  // remainder pending with nothing to mine it (#2347/#2348).
  foundry(['forge', 'script', FIXTURE_SCRIPT, '--rpc-url', url, '--broadcast', '--slow'], {
    DEPLOYER_PRIVATE_KEY: deployerKey,
    ADMIN_PRIVATE_KEY: adminKey,
    TREASURY_ADDRESS: treasury,
  });

  const artifact = JSON.parse(fs.readFileSync(FIXTURE_ARTIFACT, 'utf8')) as Record<string, unknown>;
  const diamond = artifact.diamond as `0x${string}` | undefined;
  if (!diamond || !artifact.testnetMocks || !artifact.weth) {
    throw new Error(`the fixture artifact at ${FIXTURE_ARTIFACT} lacks diamond / testnetMocks / weth`);
  }
  const code = await anvil.rpc<string>('eth_getCode', [diamond, 'latest']);
  if (!code || code === '0x') {
    throw new Error(`the fixture artifact names ${diamond} as the Diamond, but it has no code on this chain`);
  }

  // The node is about to present a real chain id: mark it as local first, so
  // the operator scripts later run on it may redirect their artifacts.
  await anvil.rpc('anvil_setCode', [LOCAL_NODE_MARKER.address, LOCAL_NODE_MARKER.code]);
  await anvil.rpc('anvil_setChainId', [presentAs]);

  return { diamond, admin: artifact.admin as `0x${string}`, adminKey, deployerKey, artifact };
}

/**
 * The committed deployments bundle with its 84532 entry replaced by `artifact`
 * — the content each tier publishes for its own readers, so every consumer of
 * `@vaipakam/contracts/deployments` in that tier resolves the local chain.
 */
export function bundleWith(artifact: Record<string, unknown>): Record<string, unknown> {
  return bundleWithChains({ [E2E_CHAIN_ID]: artifact });
}

/** The committed slug of each chain id a local node can present — the slug
 *  `contracts/script/lib/Deployments.sol` files that chain's artifact under. */
export const PRESENTED_CHAIN_SLUGS: Readonly<Record<number, string>> = {
  84532: 'base-sepolia',
  11155111: 'sepolia',
};

/** {@link bundleWith} for several local chains at once: each entry of
 *  `artifacts` (keyed by the chain id its node presents) replaces that
 *  chain's entry in the committed bundle. */
export function bundleWithChains(artifacts: Readonly<Record<number, Record<string, unknown>>>): Record<string, unknown> {
  const bundle = JSON.parse(fs.readFileSync(COMMITTED_BUNDLE, 'utf8')) as Record<string, unknown>;
  for (const [id, artifact] of Object.entries(artifacts)) {
    const chainId = Number(id);
    const chainSlug = PRESENTED_CHAIN_SLUGS[chainId];
    if (!chainSlug) throw new Error(`no committed slug is known for chain ${chainId}`);
    bundle[String(chainId)] = { ...artifact, chainId, chainSlug };
  }
  return bundle;
}
