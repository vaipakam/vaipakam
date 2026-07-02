import type { DiamondHandle, TxResponse } from '../diamondClient.js';

export async function claimAsLender(opts: { diamond: DiamondHandle; loanId: bigint }) {
  const tx = (await opts.diamond.claimAsLender(opts.loanId)) as TxResponse;
  await tx.wait();
  return tx.hash;
}

export async function claimAsBorrower(opts: { diamond: DiamondHandle; loanId: bigint }) {
  const tx = (await opts.diamond.claimAsBorrower(opts.loanId)) as TxResponse;
  await tx.wait();
  return tx.hash;
}