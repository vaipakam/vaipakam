import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import type { CreateOfferForm } from '../types/offers.js';
import { toCreateOfferPayload } from '../offers/schema.js';

export async function createLenderOffer(opts: {
  diamond: DiamondHandle;
  form: CreateOfferForm;
}) {
  const payload = toCreateOfferPayload(opts.form);
  const tx = (await opts.diamond.createOffer(payload)) as TxResponse;
  await tx.wait();
  return tx.hash;
}