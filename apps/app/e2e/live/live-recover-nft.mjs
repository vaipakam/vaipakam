// #3096 post-deploy live review — untracked NFTs on the adoption page.
//
// What this proves on the deployed app against the live Base Sepolia
// Diamond, and why each part is worth proving live:
//
//  - ERC-721: a token minted straight into the wallet's VAULT is untracked.
//    The vault card names it and links /recover with the kind, collection and
//    token id filled in, and NOTHING else: the declared source and the amount
//    are the user's own declaration, so a link that carried them would sign
//    a statement the user never typed. Adopting it credits the tracked
//    ledger by exactly one (`getTrackedHolding` read back from the chain).
//  - ERC-1155: five copies minted into the vault, three adopted through the
//    blank form under kind "Multi-token". Tracked reads 3, untracked 2. Then
//    "Disown it" on the vault card: the card's figure must be the
//    `observedAmount` the contract emitted (2), and the tracked holding must
//    not move, because disowning is event-only.
//  - WRONG STANDARD: /recover with kind ERC-721 and an address that is not an
//    ERC-721 (the ERC-1155 mock, and the VPFI ERC-20) must refuse by name
//    rather than read "nothing untracked", which would tell the user an asset
//    they can see in the vault is not there.
//
// Seeding: the two collections are the repository's own mocks
// (`contracts/test/mocks`), deployed from their compiled artifacts by this
// drive. Build them first with
//   (cd contracts && forge build test/mocks/ERC1155Mock.sol test/mocks/MockRentableNFT721.sol)
// or pass LIVE_NFT721 / LIVE_NFT1155 to reuse earlier deployments, and
// LIVE_ID721 / LIVE_ID1155 to reuse tokens an earlier run already minted into
// the vault (still untracked: 1 and 5) instead of minting new ones. The
// ERC-1155 seed uses the mock's `forceMint`, not `mint`: the vault's receive
// hook refuses an ERC-1155 delivered by any operator other than the Diamond
// or another vault (`UnauthorizedNFTSender`), so a plain mint into the vault
// reverts. The ERC-721 mock's `mint` is `_mint`, which calls no hook.
//
// Writes, all from the `lender` dev test wallet (testnet only, no admin call,
// no Diamond config): the two mock deploys, two mints into its own vault, two
// adoptions and one disowning through the app. RPCs come from
// BASE_SEPOLIA_RPC (driver.mjs); screenshots land in shots/ at 2x.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, parseEventLogs } from 'viem';
import {
  blocked,
  blockedSync,
  clientsFor,
  ensureConnected,
  exitWithVerdict,
  launch,
  requireSigningRole,
  requireSiteUrl,
  visit,
} from './driver.mjs';

requireSiteUrl();
const ROLE = 'lender';
requireSigningRole(ROLE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../../../..');
const CHAIN_ID = 84532;
const KIND = { ERC20: 0, ERC721: 1, ERC1155: 2 };

/** The Base Sepolia stanza of the shipped deployments bundle: the Diamond
 *  under review and the canonical VPFI token (an ERC-20 for the
 *  wrong-standard probe). BLOCKED when absent: nothing can be judged. */
function readDeployment() {
  const file = path.join(REPO, 'packages/contracts/src/deployments.json');
  let row;
  try {
    row = JSON.parse(fs.readFileSync(file, 'utf8'))[String(CHAIN_ID)];
  } catch (err) {
    blockedSync(`cannot read the deployments bundle\n  path: ${file}\n  ${err.message}`);
  }
  const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (!isAddr(row?.diamond) || !isAddr(row?.vpfiToken)) {
    blockedSync(`the deployments bundle's ${CHAIN_ID} stanza lacks a diamond or vpfiToken address\n  path: ${file}`);
  }
  return row;
}
const DEPLOYMENT = readDeployment();
const DIAMOND = DEPLOYMENT.diamond;
/** ERC-20s probed as an NFT kind: the bundle's VPFI, plus any the operator
 *  names (LIVE_ERC20_PROBES, comma-separated), e.g. an earlier deploy's. */
const ERC20_PROBES = [
  DEPLOYMENT.vpfiToken,
  ...String(process.env.LIVE_ERC20_PROBES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

const DIAMOND_ABI = parseAbi([
  // The VIEW. `getUserVault` / `getOrCreateUserVault` create lazily, so an
  // eth_call of either answers with the address a vault WOULD get — the
  // Diamond's next CREATE address, which is whoever creates a vault next.
  'function getUserVaultAddress(address user) view returns (address)',
  'function getOrCreateUserVault(address user) returns (address)',
  'function getSanctionsOracle() view returns (address)',
  'function getTrackedHolding(address user, address asset, uint256 tokenId) view returns (uint256)',
  'function untrackedHolding(address user, uint8 kind, address asset, uint256 tokenId) view returns (uint256)',
  'event UntrackedAdopted(address indexed account, address indexed asset, address indexed declaredSource, uint8 kind, uint256 tokenId, uint256 amount, uint256 nonce)',
  'event UntrackedDisowned(address indexed account, address indexed asset, uint256 tokenId, uint256 observedAmount, uint256 blockNumber)',
]);
const MOCK_ABI = parseAbi([
  'function mint(address to, uint256 tokenId)',
  'function forceMint(address to, uint256 id, uint256 amount)',
]);

const { pub, wallet } = clientsFor(CHAIN_ID);
const signer = wallet(ROLE);
const A = signer.account.address;

const fails = [];
const report = { site: process.env.SITE_URL, diamond: DIAMOND, wallet: A, steps: {}, txs: {}, shots: [] };
const check = (step, label, ok, detail = '') => {
  console.log(`${ok ? 'ok ' : 'FAIL'} [${step}] ${label}${detail ? ` — ${detail}` : ''}`);
  (report.steps[step] ??= []).push({ label, ok, detail });
  if (!ok) fails.push(`[${step}] ${label}`);
};

/** A setup write: sent, mined and successful, or the drive is BLOCKED
 *  (the chain refused our seeding, so nothing about the app was judged). */
async function setupTx(what, send) {
  let hash;
  try {
    hash = await send();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== 'success') throw new Error(`reverted (${hash})`);
    report.txs[what] = hash;
    console.log(`tx  ${what}: ${hash}`);
    return r;
  } catch (err) {
    await blocked(`setup transaction failed: ${what}${hash ? ` (${hash})` : ''}`, err);
  }
}

/** A mock collection: reused from the env, or deployed from its artifact. */
async function mockCollection(envName, artifact) {
  const reuse = process.env[envName];
  if (reuse) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(reuse)) blockedSync(`${envName} is not an address: ${reuse}`);
    console.log(`reusing ${artifact} at ${reuse} (${envName})`);
    return reuse;
  }
  const file = path.join(REPO, `contracts/out/${artifact}.sol/${artifact}.json`);
  let bytecode;
  try {
    bytecode = JSON.parse(fs.readFileSync(file, 'utf8')).bytecode.object;
  } catch (err) {
    blockedSync(`no compiled ${artifact} artifact — build the mocks first (see the header)\n  ${file}\n  ${err.message}`);
  }
  const r = await setupTx(`deploy ${artifact}`, () => signer.deployContract({ abi: [], bytecode }));
  console.log(`deployed ${artifact} at ${r.contractAddress}`);
  return r.contractAddress;
}

/** Re-read until `read()` returns `want` or 30 s pass, and return the last
 *  value. The public RPC is load-balanced, so a read right after a receipt
 *  can come from a node one block behind; a mismatch that outlasts the
 *  window is real. */
async function settles(read, want) {
  const until = Date.now() + 30_000;
  let got = await read();
  while (got !== want && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    got = await read();
  }
  return got;
}
const reads = (label, read, want) =>
  settles(read, want).then((got) => ({ ok: got === want, detail: `${label} = ${got}` }));

const tracked = (asset, id) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getTrackedHolding', args: [A, asset, id] });
const untracked = (kind, asset, id) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'untrackedHolding', args: [A, kind, asset, id] });

// ── Preconditions ─────────────────────────────────────────────────────────
// A read that fails before the browser opens inspected no app behaviour, so
// it is a BLOCKED precondition (exit 2), never an uncaught throw (exit 1,
// which the batch reads as a product FAIL). Every chain read up to the
// browser goes through this, not only the first.
async function precondition(what, read) {
  try {
    return await read();
  } catch (err) {
    return blocked(`could not read ${what}`, err);
  }
}

let vault;
try {
  const oracle = await pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getSanctionsOracle' });
  if (/^0x0{40}$/i.test(oracle)) {
    blockedSync('the Diamond has no sanctions oracle, so /recover shows its unavailable state and nothing can be adopted');
  }
  vault = await pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getUserVaultAddress', args: [A] });
} catch (err) {
  await blocked('could not read the Diamond', err);
}
if (/^0x0{40}$/i.test(vault)) {
  // Step 1 of the review: the wallet needs a vault before anything can be
  // minted into it. Created here (the wallet's own call, no admin) and read
  // back from the view, never taken from a simulation.
  await setupTx('create the vault', () =>
    signer.writeContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getOrCreateUserVault', args: [A] }),
  );
  vault = await precondition('the vault address after creating it', () =>
    pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getUserVaultAddress', args: [A] }),
  );
  if (/^0x0{40}$/i.test(vault)) await blocked(`the vault for ${A} still reads as absent after creating it`);
}
report.vault = vault;
console.log(`wallet ${A}, vault ${vault}`);

// ── Seeding ───────────────────────────────────────────────────────────────
const NFT721 = await mockCollection('LIVE_NFT721', 'MockRentableNFT721');
const NFT1155 = await mockCollection('LIVE_NFT1155', 'ERC1155Mock');
// Ids unique per run, so a reused collection never collides, unless the
// operator names tokens an earlier run left untracked in the vault.
const RUN = BigInt(Date.now());
const reuseId = (name) => {
  const v = process.env[name];
  if (v === undefined) return null;
  if (!/^\d+$/.test(v)) blockedSync(`${name} is not a token id: ${v}`);
  return BigInt(v);
};
const ID721 = reuseId('LIVE_ID721') ?? RUN;
const ID1155 = reuseId('LIVE_ID1155') ?? RUN;
report.assets = { NFT721, NFT1155, ID721: ID721.toString(), ID1155: ID1155.toString() };

if (reuseId('LIVE_ID721') === null) {
  await setupTx('mint ERC-721 into the vault', () =>
    signer.writeContract({ address: NFT721, abi: MOCK_ABI, functionName: 'mint', args: [vault, ID721] }),
  );
}
if (reuseId('LIVE_ID1155') === null) {
  await setupTx('mint 5 ERC-1155 into the vault', () =>
    signer.writeContract({ address: NFT1155, abi: MOCK_ABI, functionName: 'forceMint', args: [vault, ID1155, 5n] }),
  );
}
const seed721 = await precondition('the seeded ERC-721 holding', async () => [
  await settles(() => untracked(KIND.ERC721, NFT721, ID721), 1n),
  await settles(() => tracked(NFT721, ID721), 0n),
]);
const seed1155 = await precondition('the seeded ERC-1155 holding', async () => [
  await settles(() => untracked(KIND.ERC1155, NFT1155, ID1155), 5n),
  await settles(() => tracked(NFT1155, ID1155), 0n),
]);
check('seed', 'ERC-721 reads untracked 1, tracked 0', seed721[0] === 1n && seed721[1] === 0n);
check('seed', 'ERC-1155 reads untracked 5, tracked 0', seed1155[0] === 5n && seed1155[1] === 0n);

// ── Browser ───────────────────────────────────────────────────────────────
// A throwaway profile: a stored attempt record from an earlier run would put
// /recover on its "pending" card instead of the form.
const session = await launch({ role: ROLE, freshProfile: true, deviceScaleFactor: 2 });
const { page } = session;
const shot = async (name) => {
  const file = await session.shot(`recover-nft-${name}`);
  report.shots.push(file);
};
const visible = (locator, timeout = 30_000) =>
  locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

/** Fill the vault card's asset fields. */
async function fillVaultCard(kind, asset, id) {
  await visit(page, '/vault');
  await ensureConnected(page);
  await page.locator('#dep-kind').waitFor({ state: 'visible', timeout: 45_000 });
  await page.locator('#dep-kind').selectOption(String(kind));
  await page.locator('#dep-asset').fill(asset);
  await page.locator('#dep-id').fill(id.toString());
}

/** Open /recover and wait for the form (the oracle is configured). */
async function openRecoverForm(pathname = '/recover') {
  await visit(page, pathname);
  await ensureConnected(page);
  return visible(page.locator('#recover-kind'), 60_000);
}

/** Review, type CONFIRM, sign; returns the tx hash from the success card. */
async function signAdoption(step) {
  await page.getByRole('button', { name: /review recovery/i }).click();
  await page.locator('#recover-confirm').fill('CONFIRM');
  await page.getByRole('button', { name: /sign & add to vault/i }).click();
  const ok = await visible(page.getByText(/tokens added to your vault/i), 150_000);
  check(step, 'the page shows the adoption succeeded', ok);
  const href = ok
    ? await page.getByRole('link', { name: /view the transaction/i }).first().getAttribute('href').catch(() => null)
    : null;
  const hash = href?.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;
  if (hash) {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const [ev] = parseEventLogs({ abi: DIAMOND_ABI, eventName: 'UntrackedAdopted', logs: r.logs });
    check(step, 'the receipt carries UntrackedAdopted for this wallet', ev?.args.account === A,
      ev ? `amount ${ev.args.amount}, source ${ev.args.declaredSource}` : 'no event');
  }
  return hash;
}

try {
  // ── Step 2: ERC-721, from the vault card link ──────────────────────────
  {
    const S = '721';
    await fillVaultCard(KIND.ERC721, NFT721, ID721);
    const link = page.getByRole('link', { name: /add it to your vault/i });
    check(S, 'the vault card shows the untracked note with a link', await visible(link, 45_000));
    await shot('721-vault-card');
    const href = (await link.first().getAttribute('href').catch(() => null)) ?? '';
    const params = new URL(href, 'https://x.invalid').searchParams;
    check(S, 'the link names kind 1, the collection and the token id',
      params.get('kind') === '1' && params.get('asset')?.toLowerCase() === NFT721.toLowerCase() && params.get('tokenId') === ID721.toString(),
      href);
    check(S, 'the link carries no source and no amount',
      [...params.keys()].every((k) => ['kind', 'asset', 'tokenId'].includes(k)), href);
    await link.first().click();
    const formUp = await visible(page.locator('#recover-kind'), 60_000);
    check(S, '/recover opens on the form', formUp);
    if (formUp) {
      check(S, 'prefilled: kind ERC-721', (await page.locator('#recover-kind').inputValue()) === '1');
      check(S, 'prefilled: collection',
        (await page.locator('#recover-token').inputValue()).toLowerCase() === NFT721.toLowerCase());
      check(S, 'prefilled: token id', (await page.locator('#recover-token-id').inputValue()) === ID721.toString());
      check(S, 'not prefilled: source', (await page.locator('#recover-source').inputValue()) === '');
      check(S, 'no amount field for an ERC-721', (await page.locator('#recover-amount').count()) === 0);
      check(S, 'the page shows recoverable 1', await visible(page.getByText(/recoverable: 1\b/i)));
      await shot('721-recover-prefilled');
      await page.locator('#recover-source').fill(A);
      report.txs['adopt ERC-721 (app)'] = await signAdoption(S);
      await shot('721-adopted');
      check(S, 'getTrackedHolding reads 1', (await settles(() => tracked(NFT721, ID721), 1n)) === 1n);
      check(S, 'untrackedHolding reads 0', (await settles(() => untracked(KIND.ERC721, NFT721, ID721), 0n)) === 0n);
    }
  }

  // ── Step 3: ERC-1155, adopt 3 of 5 then disown the rest ────────────────
  {
    const S = '1155';
    const formUp = await openRecoverForm();
    check(S, '/recover opens on the form', formUp);
    if (formUp) {
      await page.locator('#recover-kind').selectOption(String(KIND.ERC1155));
      await page.locator('#recover-token').fill(NFT1155);
      await page.locator('#recover-token-id').fill(ID1155.toString());
      check(S, 'the page shows recoverable 5', await visible(page.getByText(/recoverable: 5\b/i)));
      await page.locator('#recover-source').fill(A);
      await page.locator('#recover-amount').fill('3');
      await shot('1155-recover-form');
      report.txs['adopt 3 ERC-1155 (app)'] = await signAdoption(S);
      await shot('1155-adopted');
      check(S, 'getTrackedHolding reads 3', (await settles(() => tracked(NFT1155, ID1155), 3n)) === 3n);
      check(S, 'untrackedHolding reads 2', (await settles(() => untracked(KIND.ERC1155, NFT1155, ID1155), 2n)) === 2n);
    }

    const D = 'disown';
    const fromBlock = await pub.getBlockNumber();
    await fillVaultCard(KIND.ERC1155, NFT1155, ID1155);
    const btn = page.getByRole('button', { name: /^disown it$/i });
    check(D, 'the vault card offers "Disown it"', await visible(btn, 45_000));
    await shot('1155-vault-card');
    await btn.first().click();
    const doneLine = page.getByText(/recorded on-chain: you disowned/i);
    const done = await visible(doneLine, 150_000);
    check(D, 'the card reports the disowning', done);
    const text = done ? await doneLine.first().innerText() : '';
    check(D, 'the card reports the observed amount 2', /you disowned 2 of/i.test(text), text);
    await shot('1155-disowned');
    const logs = await pub.getContractEvents({
      address: DIAMOND,
      abi: DIAMOND_ABI,
      eventName: 'UntrackedDisowned',
      args: { account: A, asset: NFT1155 },
      fromBlock,
    });
    const ev = logs.find((l) => l.args.tokenId === ID1155);
    report.txs['disown ERC-1155 (app)'] = ev?.transactionHash ?? null;
    check(D, 'the chain recorded UntrackedDisowned with observedAmount 2', ev?.args.observedAmount === 2n,
      ev ? `${ev.transactionHash}, observed ${ev.args.observedAmount}` : 'no event');
    check(D, 'getTrackedHolding still reads 3', (await settles(() => tracked(NFT1155, ID1155), 3n)) === 3n);
    check(D, 'untrackedHolding still reads 2 (nothing moved)', (await settles(() => untracked(KIND.ERC1155, NFT1155, ID1155), 2n)) === 2n);
  }

  // ── Step 4: wrong-standard refusal ─────────────────────────────────────
  {
    const S = 'wrong-standard';
    const probes = [
      { name: 'ERC-1155 mock as ERC-721', kind: KIND.ERC721, asset: NFT1155, standard: 'ERC-721' },
      ...ERC20_PROBES.map((a) => ({ name: `ERC-20 ${a} as ERC-721`, kind: KIND.ERC721, asset: a, standard: 'ERC-721' })),
      ...ERC20_PROBES.map((a) => ({ name: `ERC-20 ${a} as ERC-1155`, kind: KIND.ERC1155, asset: a, standard: 'ERC-1155' })),
      { name: 'ERC-721 mock as ERC-1155', kind: KIND.ERC1155, asset: NFT721, standard: 'ERC-1155' },
    ];
    for (const [i, p] of probes.entries()) {
      if (!(await openRecoverForm())) {
        check(S, `${p.name}: /recover opens on the form`, false);
        continue;
      }
      await page.locator('#recover-kind').selectOption(String(p.kind));
      await page.locator('#recover-token').fill(p.asset);
      await page.locator('#recover-token-id').fill('1');
      const refusal = page.getByText(new RegExp(`doesn[’']t report itself as ${p.standard}`, 'i'));
      const refused = await visible(refusal, 45_000);
      check(S, `${p.name}: refused by name`, refused);
      check(S, `${p.name}: no "recoverable" figure shown`, (await page.getByText(/recoverable: /i).count()) === 0);
      check(S, `${p.name}: Review stays disabled`,
        await page.getByRole('button', { name: /review recovery/i }).isDisabled());
      await shot(`wrong-standard-${i + 1}`);
    }
  }
} catch (err) {
  console.log(`FAIL drive aborted: ${err.message.split('\n')[0]}`);
  fails.push(`drive aborted: ${err.message.split('\n')[0]}`);
  await shot('aborted').catch(() => {});
}

check('page', 'no wallet request was refused', session.blockedRequests.length === 0,
  session.blockedRequests.map((b) => b.reason).join('; '));
await session.done();
report.verdict = fails.length ? 'FAIL' : 'PASS';
report.fails = fails;
fs.mkdirSync(path.join(HERE, 'shots'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'shots', 'recover-nft-report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.verdict}${fails.length ? `: ${fails.length} check(s) failed` : ''}`);
await exitWithVerdict(fails.length ? 1 : 0);
