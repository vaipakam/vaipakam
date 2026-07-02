import type { DiamondHandle, TxResponse } from '../diamondClient.js';

export async function repayLoanFull(opts: {
  diamond: DiamondHandle;
  loanId: bigint;
}) {
  const tx = (await opts.diamond.repayLoan(opts.loanId)) as TxResponse;
  await tx.wait();
  return tx.hash;
}