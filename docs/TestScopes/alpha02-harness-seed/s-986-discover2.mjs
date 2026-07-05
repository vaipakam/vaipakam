import './proxy-setup.mjs';
import { clientsFor } from './driver.mjs';
import { DIAMOND } from './verify.mjs';
import fs from 'node:fs';

const oldAbi = (n) => JSON.parse(fs.readFileSync(`./old-abis/${n}.json`, 'utf8'));
const W = JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8'));
const roles = Object.fromEntries(Object.entries(W).map(([k, v]) => [v.address.toLowerCase(), k]));
const { pub } = clientsFor(84532);
const Z = '0x0000000000000000000000000000000000000000';

for (let i = 1n; i <= 20n; i++) {
  try {
    const l = await pub.readContract({ address: DIAMOND, abi: oldAbi('LoanFacet'), functionName: 'getLoanDetails', args: [i] });
    if (l.lender === Z && l.borrower === Z) continue;
    if (Number(l.status) !== 0) continue;
    console.log(`loan #${i}: lender=${roles[l.lender.toLowerCase()] ?? l.lender} borrower=${roles[l.borrower.toLowerCase()] ?? l.borrower}`,
      `asset=${l.lendingAsset} principal=${l.principal} rate=${l.interestRateBps} dur=${l.durationDays}d`);
  } catch (e) { console.log(`loan #${i}: read error - ${e.shortMessage?.split('\n')[0]}`); }
}
