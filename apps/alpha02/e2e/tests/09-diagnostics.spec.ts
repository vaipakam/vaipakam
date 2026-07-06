/** #1028 item 4 — the Support drawer, on Anvil.
 *
 *  Asserts the three load-bearing behaviours: (1) the health rows
 *  render truthful states against a working fork (RPC reachable with
 *  a block number, indexer stub fresh); (2) the pre-filled GitHub
 *  report carries the drawer's context but NEVER the full wallet
 *  address (the redaction contract); (3) the drawer behaves like a
 *  dialog (Escape closes it).
 *
 *  The crash → last-error → report path has no clean production
 *  trigger (it needs a deliberate render crash), so it is exercised
 *  here by seeding the sessionStorage sink directly — the same slot
 *  the ErrorBoundary writes — and asserting the drawer surfaces it.
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';

/** Decode the pre-filled report out of the issue-form URL.
 *  URLSearchParams is the right decoder here — the builder encodes
 *  with it, and plain decodeURIComponent would leave its
 *  `+`-for-space encoding in place (the first CI run failed exactly
 *  there). The builder targets the bug issue FORM, so the report is
 *  spread across the form's field params. */
function reportTextOf(href: string): string {
  const params = new URL(href).searchParams;
  return ['title', 'surface', 'chain', 'env', 'extra']
    .map((k) => params.get(k) ?? '')
    .join('\n');
}

test('support drawer reports healthy connections and a redacted report', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('lender');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  const dialog = page.getByRole('dialog', { name: /support/i });
  await expect(dialog).toBeVisible();

  // Truthful health rows against the fork: RPC reachable with a real
  // block number; the stub's freshness cursor tracks the fork head so
  // the cache row must read up-to-date (never stale/unreachable).
  await expect(dialog.getByText(/Working — latest block \d+/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.getByText(/Up to date \(refreshed/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.getByText('Base Sepolia (84532)')).toBeVisible();
  await expect(dialog.getByText(/no errors recorded/i)).toBeVisible();

  // Redaction contract: the shortened wallet renders; the FULL
  // address appears nowhere in the drawer or the report URL.
  const full = account.address.toLowerCase();
  const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  await expect(dialog.getByText(short)).toBeVisible();
  expect((await dialog.innerText()).toLowerCase()).not.toContain(full);

  const report = dialog.getByRole('link', { name: /report an issue/i });
  const href = await report.getAttribute('href');
  expect(href).toBeTruthy();
  expect(href!).toContain('github.com/vaipakam/vaipakam/issues/new');
  const reportText = reportTextOf(href!);
  expect(reportText).toContain('Base Sepolia (84532)');
  expect(reportText).toContain(short);
  expect(reportText.toLowerCase()).not.toContain(full);

  // Dialog semantics: Escape closes.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a recorded error surfaces in the drawer and its report', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Seed the ErrorBoundary's sink slot directly (see header). The
  // message embeds a full address on purpose: crash text is the
  // classic leak vector, and BOTH the on-screen row and the report
  // must show only the shortened form (round 3).
  const embedded = '0x1111222233334444555566667777888899990000';
  await page.evaluate((addr) => {
    sessionStorage.setItem(
      'vaipakam.alpha02.lastError',
      JSON.stringify({
        message: `E2E seeded render crash for ${addr}`,
        componentStack: 'CrashCulprit\nSomePage',
        path: '/lend',
        at: Date.now(),
      }),
    );
  }, embedded);

  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  const dialog = page.getByRole('dialog', { name: /support/i });
  await expect(dialog.getByText(/E2E seeded render crash/)).toBeVisible();
  expect((await dialog.innerText()).toLowerCase()).not.toContain(
    embedded.toLowerCase(),
  );

  const href = await dialog
    .getByRole('link', { name: /report an issue/i })
    .getAttribute('href');
  const reportText = reportTextOf(href!);
  expect(reportText).toContain('E2E seeded render crash');
  expect(reportText).toContain('CrashCulprit');
  expect(reportText.toLowerCase()).not.toContain(embedded.toLowerCase());
  expect(reportText).toContain(`${embedded.slice(0, 6)}…${embedded.slice(-4)}`);
});
