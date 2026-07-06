// #1040 phase 1 live review — the "Contact support" ticket widget on
// the deployed site, against the REAL agent Worker + D1 + ops
// Telegram. Sends one clearly-marked automated probe ticket per run.
//
// Two legitimate terminal states, both PASS (the widget's honesty is
// what's under test, not the operator's provisioning state):
//   - CONFIGURED: a `VPK-…` ticket number renders, and the follow-up
//     mail link carries it.
//   - NOT PROVISIONED YET: the Worker answers 503 (migration 0028 not
//     applied) and the widget shows the plain-words unavailable line
//     with the always-available mail link — never a fake success.
// FAIL is reserved for dishonest states: no ticket number AND no
// failure banner, a failure banner without the mail escape hatch, or
// the pre-send disclosure missing the stored page/network mention.
import { launch, SITE } from './driver.mjs';

const { page, done, shot } = await launch({ role: 'lender' });
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// The ticket card lives inside the Support drawer (FAB on every page).
await page.getByRole('button', { name: /support and connection check/i }).click();
const dialog = page.getByRole('dialog', { name: /support/i });
await dialog.waitFor({ state: 'visible', timeout: 10000 });

const preText = await dialog.innerText();
if (preText.includes('The support inbox isn’t connected in this build')) {
  // Honest not-configured state (VITE_AGENT_ORIGIN absent) — assert
  // the mail path is still offered, then stop: nothing to send.
  const mail = await dialog.getByRole('link', { name: /email support/i }).getAttribute('href');
  check('not-configured state offers mailto', (mail ?? '').startsWith('mailto:support@vaipakam.com'));
  await shot('support-ticket-live');
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
  await done();
  process.exit(fails === 0 ? 0 : 1);
}

// Pre-send disclosure must name everything that travels without the
// diagnostics consent: message, page, network, optional reply email.
check(
  'pre-send disclosure covers page + network',
  preText.includes('the page you sent it from and the network you were on'),
);
const attachBox = dialog.locator('input[type="checkbox"]').last();
check('attach consent defaults unchecked', !(await attachBox.isChecked()));

await dialog.locator('#support-message').fill(
  'Automated live-review probe (run-live-batch) — safe to close.',
);
await dialog.getByRole('button', { name: /send to support/i }).click();

// Poll for either terminal state.
let body = '';
const deadline = Date.now() + 20000;
for (;;) {
  body = await dialog.innerText();
  if (/VPK-[A-Z0-9]{8}/.test(body) || (await dialog.locator('[role="alert"]').count()) > 0) break;
  if (Date.now() > deadline) break;
  await page.waitForTimeout(1000);
}

const ticket = body.match(/VPK-[A-Z0-9]{8}/)?.[0];
if (ticket) {
  console.log('  ticket issued:', ticket);
  const mail = await dialog.getByRole('link', { name: /email support/i }).getAttribute('href');
  check('follow-up mail link carries the ticket id', (mail ?? '').includes(encodeURIComponent(ticket)) || (mail ?? '').includes(ticket));
  check('success names the ticket number', body.includes(`Your ticket number is ${ticket}`));
} else {
  const banner = await dialog.locator('[role="alert"]').innerText().catch(() => '');
  console.log('  failure banner:', banner.slice(0, 200) || 'NONE');
  check('failure branch shown honestly', banner.length > 0);
  check(
    'failure branch names its cause in plain words',
    /couldn’t take the message right now|didn’t go through|wait a minute and try again/.test(banner),
  );
  const mail = await dialog.getByRole('link', { name: /email support/i }).getAttribute('href');
  check('failure branch ends at mailto', (mail ?? '').startsWith('mailto:support@vaipakam.com'));
}

await shot('support-ticket-live');
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
await done();
process.exit(fails === 0 ? 0 : 1);
