// Faucet page review — drives /faucet on the branch preview, mints all
// three mock assets to the connected wallet, and verifies balances move
// on-chain. Run: SITE_URL=<preview> ROLE=borrower node s-faucet.mjs
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';

const role = process.env.ROLE ?? 'borrower';
const { page, shot, done, consoleErrors } = await launch({ role });
const { pub } = clientsFor(84532);
const me = addressOf(role);

const tLIQ = '0x9d2a1acF65Ed12716Ca67Beb7D108890ccDa49f8';
const tILQ = '0x2AffacDEA8119E38D9754b2C2c15EC79aF360807';
const vRENT = '0xE435bDcFb59c4026d1607c8D498EF3EcCa51D837';
const erc20 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

const bal = (t) => pub.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [me] });

function log(...a) { console.log('[faucet]', ...a); }

async function connect() {
  const btn = page.getByRole('button', { name: /connect/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1500);
    for (const name of [/vaipakam test wallet/i, /metamask/i, /browser wallet/i, /injected/i]) {
      const opt = page.getByRole('button', { name }).first();
      if (await opt.isVisible().catch(() => false)) { await opt.click(); break; }
    }
    await page.waitForTimeout(3000);
  }
}

await page.goto(SITE + '/faucet', { waitUntil: 'networkidle' }).catch((e) => log('goto err', e.message));
await page.waitForTimeout(2500);
log('url', page.url(), '| title', await page.title());
await shot('faucet-1-preconnect');
const preBody = await page.textContent('body');
log('shows faucet title "Get test assets":', preBody.includes('Get test assets'));
log('shows testnet note:', /test network/i.test(preBody));

await connect();
await page.waitForTimeout(2000);
await shot('faucet-2-connected');
const body = await page.textContent('body');
log('tLIQ card present:', /Liquid test token/i.test(body));
log('tILQ card present:', /Illiquid test token/i.test(body));
log('vRENT card present:', /Rental test NFT/i.test(body));

// Mint tLIQ
const before = { tLIQ: await bal(tLIQ), tILQ: await bal(tILQ) };
log('before: tLIQ', (Number(before.tLIQ) / 1e18).toFixed(0), 'tILQ', (Number(before.tILQ) / 1e18).toFixed(0));

async function clickMint(label) {
  const btn = page.getByRole('button', { name: label }).first();
  if (!(await btn.isVisible().catch(() => false))) { log('BUTTON NOT FOUND:', label); return false; }
  await btn.click();
  // wait for the tx to mine + done banner
  await page.waitForTimeout(9000);
  return true;
}

await clickMint(/Mint 10,000 tLIQ/i);
await shot('faucet-3-after-tliq');
await clickMint(/Mint 1,000 tILQ/i);
await shot('faucet-4-after-tilq');
await clickMint(/Mint a test NFT/i);
await shot('faucet-5-after-nft');

await page.waitForTimeout(3000);
const after = { tLIQ: await bal(tLIQ), tILQ: await bal(tILQ) };
log('after:  tLIQ', (Number(after.tLIQ) / 1e18).toFixed(0), 'tILQ', (Number(after.tILQ) / 1e18).toFixed(0));
log('tLIQ delta:', (Number(after.tLIQ - before.tLIQ) / 1e18).toFixed(0), '(expect 10000)');
log('tILQ delta:', (Number(after.tILQ - before.tILQ) / 1e18).toFixed(0), '(expect 1000)');

// NFT: count balanceOf on the 721
const nft721 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const nftBal = await pub.readContract({ address: vRENT, abi: nft721, functionName: 'balanceOf', args: [me] }).catch((e) => 'ERR ' + e.shortMessage);
log('vRENT balance (expect >=1):', String(nftBal));

const doneBanner = await page.textContent('body');
log('shows a "Minted" confirmation:', /Minted/i.test(doneBanner));
log('console errors:', JSON.stringify(consoleErrors.slice(0, 6)));
await done();
