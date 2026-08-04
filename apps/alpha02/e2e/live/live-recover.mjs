// #1547 post-deploy live review — the unlisted /recover surface on
// production alpha02.
//
// What this can prove live, and why it is worth proving:
//
//  - DISCOVERABILITY GATE: /recover has no nav or Settings entry; the
//    only in-app path is the Help explainer's deep link. A regression
//    that added it to the nav would defeat the dust-poisoning gate.
//  - FAIL-SAFE BLOCKED STATE: the retail deploy ships the sanctions
//    oracle UNSET and recovery hard-requires it, so production must
//    present recovery as unavailable rather than offer a doomed form.
//    This is the one arm the fork CANNOT check honestly — the fork
//    spec has to install a mock oracle to drive the success path — so
//    production is where the shipped default is actually verified.
//    (When the oracle is later configured, this flips: the form
//    renders and this driver says so rather than failing, since both
//    are correct for their configuration.)
//  - GUIDE LINK: the signed declaration attests to reading the
//    Advanced User Guide section, so the link to it must resolve —
//    it pointed at a non-existent route until #1547 r11.
//  - ROBOTS: noindex,nofollow on the route, per the restricted-surface
//    policy.
//
// Read-only: no wallet writes. Recovery itself cannot be driven on
// production without real stuck dust, which is a manual exercise.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { ensureConnected, launch, SITE } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAMOND = JSON.parse(
  readFileSync(
    path.join(HERE, '../../../../packages/contracts/src/deployments.json'),
    'utf8',
  ),
)['84532'].diamond;
const ORACLE_ABI = parseAbi([
  'function getSanctionsOracle() view returns (address)',
]);
const pub = createPublicClient({
  transport: http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org'),
});
const ZERO = '0x0000000000000000000000000000000000000000';

const fails = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${label}`);
  if (!ok) fails.push(label);
};

const { page, done } = await launch({ role: 'borrower', readOnly: true });
try {
  // The live oracle setting decides which posture is CORRECT — read it
  // first so this driver checks the deployment it actually found.
  const oracle = await pub.readContract({
    address: DIAMOND,
    abi: ORACLE_ABI,
    functionName: 'getSanctionsOracle',
  });
  const oracleSet = oracle.toLowerCase() !== ZERO;
  console.log(`sanctions oracle: ${oracleSet ? 'configured' : 'UNSET'}`);

  // 1. Discoverability gate — in via Help only.
  await page.goto(SITE + '/help', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureConnected(page);
  const explainer = page.locator('#stuck-tokens');
  check(
    'help explainer section renders',
    await explainer.isVisible().catch(() => false),
  );
  const deepLink = page.getByRole('link', { name: /open the recovery flow/i });
  check('help links the recovery flow', (await deepLink.count()) > 0);

  // The guide the signed declaration attests to must be linked AND live.
  const guideHref = await page
    .getByRole('link', { name: /advanced user guide/i })
    .first()
    .getAttribute('href')
    .catch(() => null);
  check('help links the Advanced User Guide', Boolean(guideHref));
  if (guideHref) {
    const res = await fetch(guideHref).catch(() => null);
    check(`guide link resolves (${guideHref})`, Boolean(res && res.ok));
  }

  // 2. No nav/Settings entry anywhere — the gate is the whole point.
  await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  check(
    'no Settings entry for recovery',
    (await page.getByRole('link', { name: /recover/i }).count()) === 0,
  );

  // 3. The route itself, and the posture matching the live oracle.
  await page.goto(SITE + '/recover', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureConnected(page);
  await page.waitForTimeout(4000);
  const body = await page.locator('body').innerText();
  const formOffered = (await page.getByLabel(/token contract address/i).count()) > 0;
  if (oracleSet) {
    // Configured deployment: the form is the correct posture.
    check('oracle configured → form offered', formOffered);
  } else {
    // Shipped retail default: recovery must be presented as unavailable,
    // never as a form that could only produce a doomed signature.
    check('oracle unset → recovery presented as unavailable', /isn’t available|not available/i.test(body));
    check('oracle unset → no form offered', !formOffered);
  }

  // 4. Robots posture for the restricted surface.
  const robots = await page
    .locator('meta[name="robots"]')
    .getAttribute('content')
    .catch(() => null);
  check(`meta robots is noindex,nofollow (got ${robots})`, /noindex/.test(robots ?? '') && /nofollow/.test(robots ?? ''));
} finally {
  await done();
}

if (fails.length) {
  console.log('FAILED checks:', fails.join(' | '));
  process.exit(1);
}
console.log('live recover review: ALL CHECKS PASSED');
