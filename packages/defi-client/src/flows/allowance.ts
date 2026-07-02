import {
  type Address,
  type PublicClient,
  type WalletClient,
  erc20Abi,
} from 'viem';

export async function ensureErc20Allowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: Address;
  spender: Address;
  amount: bigint;
}) {
  const owner = opts.walletClient.account?.address;
  if (!owner) throw new Error('Wallet not connected');

  const current = (await opts.publicClient.readContract({
    address: opts.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, opts.spender],
  })) as bigint;

  if (current >= opts.amount) return;

  const account = opts.walletClient.account;
  if (!account) throw new Error('Wallet has no account');

  const hash = await opts.walletClient.writeContract({
    address: opts.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [opts.spender, opts.amount],
    account,
    chain: opts.walletClient.chain,
  });

  await opts.publicClient.waitForTransactionReceipt({ hash });
}