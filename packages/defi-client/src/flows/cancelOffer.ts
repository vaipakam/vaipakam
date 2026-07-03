import type { DiamondHandle, TxResponse } from '../diamondClient.js';

export async function cancelOffer(opts: { diamond: DiamondHandle; offerId: bigint }) {
  const tx = (await opts.diamond.cancelOffer(opts.offerId)) as TxResponse;
  await tx.wait();
  return tx.hash;
}