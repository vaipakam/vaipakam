// On-chain verification helpers (chunked getLogs, offer/loan reads).
import './proxy-setup.mjs';
import fs from 'node:fs';
import { clientsFor } from './driver.mjs';

export const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const ABIDIR = '/home/user/vaipakam/packages/contracts/src/abis';
export const abiOf = (facet) => JSON.parse(fs.readFileSync(`${ABIDIR}/${facet}.json`, 'utf8'));
export const DIAMOND_ABI = ['OfferCreateFacet','OfferCancelFacet','OfferAcceptFacet','LoanFacet','RepayFacet','PrecloseFacet','RefinanceFacet','EarlyWithdrawalFacet','ClaimFacet','VaipakamNFTFacet','ProfileFacet','VaultFactoryFacet','ConfigFacet'].flatMap(abiOf);

export async function scanLogs(chainId, { event, args, blocks = 6000n }) {
  const { pub } = clientsFor(chainId);
  const head = await pub.getBlockNumber();
  const out = [];
  for (let from = head - blocks; from <= head; from += 1999n) {
    const to = from + 1998n > head ? head : from + 1998n;
    out.push(...await pub.getLogs({ address: DIAMOND, event, args, fromBlock: from, toBlock: to }));
  }
  return out;
}

export function fmt(obj) {
  return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? String(v) : v, 1);
}
