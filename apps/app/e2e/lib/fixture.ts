/**
 * The e2e chain, built from source (#2334).
 *
 * The suite used to fork live Base Sepolia, which meant it tested the
 * bytecode and state the TESTNET held at the block the job started — not the
 * contracts in the change under review, and not a fixed state. A spec could
 * fail on live state that moved between two runs of one commit, and a
 * contract change was invisible to the suite until an operator redeployed the
 * testnet. Now each run deploys the repository's current contracts onto a
 * bare anvil, so a run's inputs are the commit and nothing else.
 *
 * In order:
 *   1. compile the fixture script (`contracts/script/e2e/DeployE2EFixture.s.sol`);
 *   2. etch the three contracts the app expects at canonical addresses —
 *      WETH9 at Base's predeploy, Multicall3, Permit2 — which a bare chain
 *      does not have and the fixture script checks for;
 *   3. run the fixture script: the Diamond, then the faucet and oracle mocks;
 *   4. switch the chain id to Base Sepolia's, so the app's per-chain wiring
 *      (curated WETH, loan-sale chains, the chain registry) applies unchanged;
 *   5. write `.state/deployments.json`: the committed bundle with its 84532
 *      entry replaced by this deployment, then stamp it with this run's id.
 *      The app (through a vite hook, APP_E2E only), the harness and the
 *      indexer stub all read it, and the first two accept it only under
 *      this run's id.
 *
 * WHY THE SWITCH IS STEP 4. `Deployments` lets a script redirect its artifact
 * only on Anvil's own id, 31337 — on any other id its writes target the
 * committed per-chain file, which is exactly what must never happen from a
 * test. So the deploy happens as 31337 and the chain presents 84532
 * afterwards. Every contract involved reads `block.chainid` at call time, so
 * each EIP-712 domain follows the switch.
 *
 * Deployer and admin are fresh keys per run, funded here, like the role
 * wallets: no key outlives the run.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ANVIL_URL, anvilRpc, setBalance } from './anvil';
import { E2E_BUNDLE, E2E_BUNDLE_RUN_ID, e2eRunId } from './artifacts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const CONTRACTS_DIR = path.join(REPO, 'contracts');
const FIXTURE_SCRIPT = 'script/e2e/DeployE2EFixture.s.sol';
/** Where the fixture script's artifact lands — the gitignored scratch root
 *  `Deployments` permits a redirect to, under Anvil's slug. */
const FIXTURE_ARTIFACT_DIR = path.join(CONTRACTS_DIR, 'deployments', '.forge-test', 'e2e');
const FIXTURE_ARTIFACT = path.join(FIXTURE_ARTIFACT_DIR, 'anvil', 'addresses.json');
const COMMITTED_BUNDLE = path.join(REPO, 'packages', 'contracts', 'src', 'deployments.json');

/** The id the deploy runs on, and the id the chain presents afterwards. */
const DEPLOY_CHAIN_ID = 31337;
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

/** Run a Foundry command in `contracts/`, failing with its output. */
function foundry(args: string[], env: Record<string, string> = {}): string {
  const ambient: Record<string, string> = {};
  for (const k of AMBIENT_ENV) {
    const v = process.env[k];
    if (v !== undefined) ambient[k] = v;
  }
  const res = spawnSync(args[0], args.slice(1), {
    cwd: CONTRACTS_DIR,
    // `default` explicitly: an exported `quick` from an inner loop skips
    // `script/`, and the fixture would not compile at all.
    env: { ...ambient, FOUNDRY_PROFILE: 'default', ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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

/** Put `c` at its canonical address — see `CANONICAL` for why the two
 *  install kinds differ. */
async function installCanonical(c: Canonical, deployerKey: `0x${string}`): Promise<void> {
  if (c.install === 'code') {
    await anvilRpc('anvil_setCode', [c.address, c.code()]);
    return;
  }
  const { creation } = compiledArtifact(c.source, c.contract);
  const account = privateKeyToAccount(deployerKey);
  const wallet = createWalletClient({
    account,
    chain: { id: DEPLOY_CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ANVIL_URL] } } },
    transport: http(ANVIL_URL),
  });
  const hash = await wallet.sendTransaction({ data: creation, to: null });
  // WAIT for the receipt. Reading it straight after sending races the
  // mining and reads null — observed as an intermittent setup failure.
  const receipt = await createPublicClient({ transport: http(ANVIL_URL) }).waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`constructing ${c.name} for the canonical copy reverted (tx ${hash})`);
  }
  const built = receipt.contractAddress;
  const code = await anvilRpc<`0x${string}`>('eth_getCode', [built, 'latest']);
  await anvilRpc('anvil_setCode', [c.address, code]);
  for (let slot = 0; slot < CLONED_SLOTS; slot++) {
    const key = `0x${slot.toString(16).padStart(64, '0')}`;
    const value = await anvilRpc<`0x${string}`>('eth_getStorageAt', [built, key, 'latest']);
    await anvilRpc('anvil_setStorageAt', [c.address, key, value]);
  }
}

/** A canonical WETH9 that cannot be read as 18-decimal WETH would make the
 *  app parse every amount as 0 — assert it before anything runs on it. */
async function assertCanonicalWeth(address: `0x${string}`): Promise<void> {
  const decimals = await anvilRpc<string>('eth_call', [
    { to: address, data: '0x313ce567' },
    'latest',
  ]);
  if (BigInt(decimals) !== 18n) {
    throw new Error(`WETH9 at ${address} reports ${BigInt(decimals)} decimals after installation, not 18`);
  }
}

async function fundedKey(): Promise<`0x${string}`> {
  const pk = generatePrivateKey();
  await setBalance(privateKeyToAccount(pk).address, 10n ** 21n);
  return pk;
}

export interface FixtureResult {
  diamond: `0x${string}`;
  admin: `0x${string}`;
}

export async function deployFixture(): Promise<FixtureResult> {
  const chainId = Number(await anvilRpc<string>('eth_chainId'));
  if (chainId !== DEPLOY_CHAIN_ID) {
    throw new Error(`the fixture deploys on a bare anvil (${DEPLOY_CHAIN_ID}); this one is ${chainId}`);
  }

  console.log('[e2e] compiling the fixture (current contracts)…');
  foundry(['forge', 'build', FIXTURE_SCRIPT]);

  const installerKey = await fundedKey();
  for (const c of CANONICAL) {
    await installCanonical(c, installerKey);
  }
  await assertCanonicalWeth('0x4200000000000000000000000000000000000006');

  // A previous run's artifact must not be read as this run's: the deploy
  // writes the file, and a failure part-way would otherwise leave the
  // earlier addresses in place for step 5 to publish.
  fs.rmSync(FIXTURE_ARTIFACT_DIR, { recursive: true, force: true });

  const deployerKey = await fundedKey();
  const adminKey = await fundedKey();
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  console.log('[e2e] deploying the Diamond and the testnet mocks…');
  // `--slow`, as the operator deploy passes it: one transaction per receipt.
  // Without it forge sends the batch at once and anvil can leave the
  // remainder pending with nothing to mine it (#2347/#2348).
  foundry(['forge', 'script', FIXTURE_SCRIPT, '--rpc-url', ANVIL_URL, '--broadcast', '--slow'], {
    DEPLOYER_PRIVATE_KEY: deployerKey,
    ADMIN_PRIVATE_KEY: adminKey,
    TREASURY_ADDRESS: treasury,
  });

  const artifact = JSON.parse(fs.readFileSync(FIXTURE_ARTIFACT, 'utf8')) as Record<string, unknown>;
  const diamond = artifact.diamond as `0x${string}` | undefined;
  if (!diamond || !artifact.testnetMocks || !artifact.weth) {
    throw new Error(`the fixture artifact at ${FIXTURE_ARTIFACT} lacks diamond / testnetMocks / weth`);
  }
  const code = await anvilRpc<string>('eth_getCode', [diamond, 'latest']);
  if (!code || code === '0x') {
    throw new Error(`the fixture artifact names ${diamond} as the Diamond, but it has no code on this chain`);
  }

  await anvilRpc('anvil_setChainId', [E2E_CHAIN_ID]);

  const bundle = JSON.parse(fs.readFileSync(COMMITTED_BUNDLE, 'utf8')) as Record<string, unknown>;
  bundle[String(E2E_CHAIN_ID)] = {
    ...artifact,
    chainId: E2E_CHAIN_ID,
    chainSlug: 'base-sepolia',
  };
  fs.mkdirSync(path.dirname(E2E_BUNDLE), { recursive: true });
  fs.writeFileSync(E2E_BUNDLE, JSON.stringify(bundle, null, 2));
  // The stamp goes LAST: a reader waits for it, so it must not appear
  // before the bundle it vouches for is complete.
  fs.writeFileSync(E2E_BUNDLE_RUN_ID, e2eRunId());

  return { diamond, admin: artifact.admin as `0x${string}` };
}
