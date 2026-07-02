import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  erc20Abi,
} from 'viem';

async function assertApprovalReceipt(
  publicClient: PublicClient,
  hash: Hex,
  label: string,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} transaction reverted on-chain`);
  }
}

async function readAllowance(
  publicClient: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint;
}

export async function ensureErc20Allowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: Address;
  spender: Address;
  amount: bigint;
}) {
  const owner = opts.walletClient.account?.address;
  if (!owner) throw new Error('Wallet not connected');

  const current = await readAllowance(opts.publicClient, opts.token, owner, opts.spender);

  if (current >= opts.amount) return;

  const account = opts.walletClient.account;
  if (!account) throw new Error('Wallet has no account');

  // USDT-style tokens require zeroing a stale partial allowance before raising it.
  if (current > 0n) {
    const resetHash = await opts.walletClient.writeContract({
      address: opts.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [opts.spender, 0n],
      account,
      chain: opts.walletClient.chain,
    });
    await assertApprovalReceipt(opts.publicClient, resetHash, 'Allowance reset');
    const afterReset = await readAllowance(opts.publicClient, opts.token, owner, opts.spender);
    if (afterReset !== 0n) {
      throw new Error('Allowance reset did not clear the prior approval');
    }
  }

  const hash = await opts.walletClient.writeContract({
    address: opts.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [opts.spender, opts.amount],
    account,
    chain: opts.walletClient.chain,
  });

  await assertApprovalReceipt(opts.publicClient, hash, 'Approval');
  const updated = await readAllowance(opts.publicClient, opts.token, owner, opts.spender);
  if (updated < opts.amount) {
    throw new Error('Approval confirmed but allowance is still below the required amount');
  }
}