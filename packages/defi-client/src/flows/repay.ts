import type { Address, PublicClient, WalletClient } from 'viem';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import type { IndexedLoan } from '../types/loans.js';
import { ASSET_TYPE_ERC20 } from '../types/offers.js';
import { ensureErc20Allowance } from './allowance.js';

export async function repayLoanFull(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  loan: IndexedLoan;
}) {
  if (opts.loan.assetType === ASSET_TYPE_ERC20) {
    const totalDue = (await opts.diamond.calculateRepaymentAmount(
      BigInt(opts.loan.loanId),
    )) as bigint;
    if (totalDue > 0n) {
      await ensureErc20Allowance({
        publicClient: opts.publicClient,
        walletClient: opts.walletClient,
        token: opts.loan.lendingAsset as Address,
        spender: opts.diamondAddress,
        amount: totalDue,
      });
    }
  }

  const tx = (await opts.diamond.repayLoan(BigInt(opts.loan.loanId))) as TxResponse;
  await tx.wait();
  return tx.hash;
}