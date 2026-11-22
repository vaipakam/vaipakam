/**
 * #3306 — a governance timelock on the fixture chain, with two changes
 * queued in it, so the governance page (#3237) is driven end to end.
 *
 * The Timelock is deployed by the operator's own `DeployTimelock` script,
 * through its e2e wrapper (`contracts/script/e2e/E2EDeployTimelock.s.sol`),
 * which records it in a scratch artifact rather than the committed one.
 * Global setup adds it to the bundle the app reads, as `timelock`, and the
 * changes are queued the way a proposer would queue them:
 *
 *   1. a BATCH of two calls: raise the Timelock's own minimum wait to two
 *      hours, then pause the Diamond; queued with a 400-day wait;
 *   2. a single call that unpauses the Diamond, set to run only after the
 *      batch (its predecessor); queued with an 800-day wait.
 *
 * Both are queued in ONE block, so both waits count from one timestamp and
 * the spec can state each "can run" time exactly. The waits are long because
 * other specs move the shared chain's clock forward (a reward spec by about
 * seventy days): the timelock must still call both changes not ready
 * whenever the governance spec runs, so the BROWSER's clock alone decides
 * which wait has passed. Nothing here executes: the Diamond is never paused,
 * and the queue only shows what would happen.
 */
import fs from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, toBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileScript, readContractsJson, REPO_ROOT, runForgeScript } from '@vaipakam/anvil-harness/fixture';
import type { AnvilControl } from '@vaipakam/anvil-harness/rpc';

const TIMELOCK_SCRIPT = 'script/e2e/E2EDeployTimelock.s.sol';
/** The scratch root the wrapper writes its artifact under (gitignored). */
const ARTIFACT_ROOT = 'deployments/.forge-test/e2e-governance';
/** The chain the fixture node presents once the Diamond is deployed. */
const ARTIFACT = `${ARTIFACT_ROOT}/base-sepolia/addresses.json`;

/** The Timelock's minimum wait (the testnet floor `DeployTimelock` allows). */
export const MIN_DELAY = 3_600;
/** The batch's own wait, and the dependent change's (see the header). */
export const BATCH_DELAY = 400 * 86_400;
export const DEPENDENT_DELAY = 800 * 86_400;
/** The minimum wait the batch's first call would set. */
export const BATCH_NEW_DELAY = 7_200;

const ZERO_ID = `0x${'0'.repeat(64)}` as Hex;
/* The few calls this module makes, by signature. The committed ABI bundle
 * imports its JSON without an import attribute, which Playwright's Node
 * loader refuses at global setup, so it is not imported here. A wrong
 * signature fails loudly: the id read back would not match, or the call
 * would revert. */
const timelockAbi = parseAbi([
  'function updateDelay(uint256 newDelay)',
  'function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
  'function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
]);
const diamondAbi = parseAbi(['function pause()', 'function unpause()']);

/** What global setup records for the spec. */
export interface GovernanceFixture {
  timelock: Hex;
  batchId: Hex;
  dependentId: Hex;
  /** The timestamp of the block both changes were queued in. */
  queuedAt: number;
}

export async function deployGovernanceFixture(opts: {
  url: string;
  control: AnvilControl;
  diamond: Hex;
  /** A funded key that deploys the Timelock and acts as its proposer. */
  proposerKey: Hex;
}): Promise<GovernanceFixture> {
  const { url, control, diamond, proposerKey } = opts;
  const proposer = privateKeyToAccount(proposerKey);
  // The independent canceller must differ from the proposer; nothing here
  // cancels, so a fresh address with no key kept is enough.
  const canceller = privateKeyToAccount(generatePrivateKey()).address;

  fs.rmSync(`${REPO_ROOT}/contracts/${ARTIFACT_ROOT}`, { recursive: true, force: true });
  // The script reads the chain's Diamond from the artifact (#3828): it is the
  // only target of the timelock's restart list, and the deploy refuses a
  // Diamond that does not route every restart call to its pause facet.
  const artifactPath = `${REPO_ROOT}/contracts/${ARTIFACT}`;
  fs.mkdirSync(artifactPath.slice(0, artifactPath.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify({ diamond }, null, 2)}\n`);
  compileScript(TIMELOCK_SCRIPT);
  runForgeScript(TIMELOCK_SCRIPT, url, {
    E2E_ARTIFACT_ROOT: ARTIFACT_ROOT,
    DEPLOYER_PRIVATE_KEY: proposerKey,
    TIMELOCK_MIN_DELAY: String(MIN_DELAY),
    TIMELOCK_PROPOSER: proposer.address,
    PAUSER_ADDRESS: canceller,
  });
  const timelock = readContractsJson<{ timelock?: Hex }>(ARTIFACT).timelock;
  if (!timelock) throw new Error(`${TIMELOCK_SCRIPT} recorded no timelock in ${ARTIFACT}`);

  const pub = createPublicClient({ transport: http(url) });
  const wallet = createWalletClient({ account: proposer, transport: http(url) });

  const targets = [timelock, diamond];
  const values = [0n, 0n];
  const payloads = [
    encodeFunctionData({ abi: timelockAbi, functionName: 'updateDelay', args: [BigInt(BATCH_NEW_DELAY)] }),
    encodeFunctionData({ abi: diamondAbi, functionName: 'pause' }),
  ];
  const batchSalt = keccak256(toBytes('vaipakam.e2e.governance.batch'));
  const batchId = await pub.readContract({
    address: timelock,
    abi: timelockAbi,
    functionName: 'hashOperationBatch',
    args: [targets, values, payloads, ZERO_ID, batchSalt],
  });
  const unpause = encodeFunctionData({ abi: diamondAbi, functionName: 'unpause' });
  const dependentSalt = keccak256(toBytes('vaipakam.e2e.governance.dependent'));
  const dependentId = await pub.readContract({
    address: timelock,
    abi: timelockAbi,
    functionName: 'hashOperation',
    args: [diamond, 0n, unpause, batchId, dependentSalt],
  });

  // One block for both: automine off, send, mine once, automine back on.
  const nonce = await pub.getTransactionCount({ address: proposer.address, blockTag: 'pending' });
  await control.rpc('evm_setAutomine', [false]);
  let hashes: Hex[];
  try {
    hashes = [
      await wallet.writeContract({
        chain: null,
        address: timelock,
        abi: timelockAbi,
        functionName: 'scheduleBatch',
        args: [targets, values, payloads, ZERO_ID, batchSalt, BigInt(BATCH_DELAY)],
        nonce,
        gas: 1_000_000n,
      }),
      await wallet.writeContract({
        chain: null,
        address: timelock,
        abi: timelockAbi,
        functionName: 'schedule',
        args: [diamond, 0n, unpause, batchId, dependentSalt, BigInt(DEPENDENT_DELAY)],
        nonce: nonce + 1,
        gas: 1_000_000n,
      }),
    ];
    await control.rpc('evm_mine');
  } finally {
    await control.rpc('evm_setAutomine', [true]);
  }
  const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  for (const r of receipts) {
    if (r.status !== 'success') throw new Error(`queuing a governance change reverted (${r.transactionHash})`);
  }
  if (receipts[0].blockNumber !== receipts[1].blockNumber) throw new Error('the two governance changes were not queued in one block');
  const block = await pub.getBlock({ blockNumber: receipts[0].blockNumber });
  return { timelock, batchId, dependentId, queuedAt: Number(block.timestamp) };
}
