// Tier-2 HF-swap liquidation of loan #8. Drops tLIQ (feed + pool in
// lockstep so it stays LIQUID while HF<1), funds the MockSwapAdapter
// with WETH output, triggers liquidation, verifies loan terminal.
import { clientsFor, addressOf } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';
import fs from 'node:fs';

const { pub, wallet } = clientsFor(84532);
const lender = wallet('lender');
const acct = (await import('viem/accounts')).privateKeyToAccount(JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8')).lender.privateKey);
const log = (...a) => console.log('[liq8]', ...a);

const FEED = '0x534e488390520C595239A9157a6c19CCc3eBf87b';   // tLIQ/USD
const POOL = '0x7Ef3a00810cA3F978B9A82f72cE22feAE310AE74';   // tLIQ/WETH
const ADAPTER = '0xad7f437b8f7183F6fF09f4b3504F56efbad60D47';
const WETH = '0x4200000000000000000000000000000000000006';
const risk = abiOf('RiskFacet');
const oracle = abiOf('OracleFacet');

const feedAbi = [{ name: 'setPrice', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'int256' }], outputs: [] }];
const poolAbi = [{ name: 'setSqrtPriceX96', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint160' }], outputs: [] }];
const adAbi = [{ name: 'setOutputMultiplierBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] }];
const wethAbi = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const send = async (to, abi, fn, args) => {
  for (let i = 0; i < 5; i++) {
    try {
      const h = await lender.writeContract({ address: to, abi, functionName: fn, args, account: acct, chain: lender.chain });
      await pub.waitForTransactionReceipt({ hash: h });
      return h;
    } catch (e) {
      if (i === 4) throw e;
      log(`  retry ${fn} (${(e.shortMessage ?? e.message ?? '').slice(0, 40)})`);
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
};
const hf = () => pub.readContract({ address: DIAMOND, abi: risk, functionName: 'calculateHealthFactor', args: [8n] });
const liq = () => pub.readContract({ address: DIAMOND, abi: oracle, functionName: 'checkLiquidity', args: ['0x9d2a1acF65Ed12716Ca67Beb7D108890ccDa49f8'] });

log('BEFORE  HF', (Number(await hf()) / 1e18).toFixed(2), '| tLIQ liquidity', await liq());

// 1. fund adapter with WETH output (transfer from lender's WETH)
const adBal = await pub.readContract({ address: WETH, abi: wethAbi, functionName: 'balanceOf', args: [ADAPTER] });
if (adBal < 5000000000000000n) { await send(WETH, wethAbi, 'transfer', [ADAPTER, 5000000000000000n]); log('funded adapter 0.005 WETH'); }
else log('adapter WETH ok', (Number(adBal) / 1e18).toFixed(4));
// 2. adapter output rate: 1 tLIQ input -> ~0.003 WETH (bps 30) covers the ~0.0025 expected
await send(ADAPTER, adAbi, 'setOutputMultiplierBps', [30n]); log('set adapter bps=30');

// 3. drop tLIQ to $5 (feed) + pool sqrtPriceX96 to ratio 400 tLIQ/WETH (lockstep → stays liquid)
await send(FEED, feedAbi, 'setPrice', [5n * 10n ** 8n]);
await send(POOL, poolAbi, 'setSqrtPriceX96', [20n * 79228162514264337593543950336n]);
log('dropped tLIQ feed->$5 + pool ratio->400');
await new Promise((r) => setTimeout(r, 2000));
log('AFTER   HF', (Number(await hf()) / 1e18).toFixed(4), '| tLIQ liquidity', await liq(), '(0=Liquid)');

// 4. trigger liquidation (permissionless caller = lender)
try {
  const sim = await pub.simulateContract({ address: DIAMOND, abi: risk, functionName: 'triggerLiquidation', args: [8n, [{ adapterIdx: 0n, data: '0x' }]], account: acct.address });
  log('liquidation sim OK');
  const h = await send(DIAMOND, risk, 'triggerLiquidation', [8n, [{ adapterIdx: 0n, data: '0x' }]]);
  log('triggerLiquidation mined', h);
} catch (e) { log('LIQUIDATION FAILED:', e.shortMessage?.split('\n')[0] ?? e.message); }

// 5. loan 8 status after
const d = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [8n] });
log('loan 8 status AFTER:', Number(d.status), '(0=Active,2=Repaid,3=Defaulted,4=Liquidated — see enum)');
fs.writeFileSync('state-liq8-status.json', JSON.stringify({ status: Number(d.status) }));

// 6. restore tLIQ to $2000 + 1:1 pool so the faucet demo stays liquid
await send(FEED, feedAbi, 'setPrice', [2000n * 10n ** 8n]);
await send(POOL, poolAbi, 'setSqrtPriceX96', [79228162514264337593543950336n]);
await send(ADAPTER, adAbi, 'setOutputMultiplierBps', [10000n]);
log('restored tLIQ feed->$2000 + pool 1:1 + adapter bps=10000');
