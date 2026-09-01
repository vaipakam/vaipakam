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
      'vaipakam.app.lastError',
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

/** #2023 — the report must be readable BEFORE the link that discloses it.
 *
 *  Opening the report is an `<a href>` to a pre-filled GitHub issue, so the
 *  diagnostics reach GitHub the moment the form opens. The drawer's own rows
 *  are a partial view — 300 characters of the error and no component trace —
 *  while the report carries up to 1200 and 1000. "Copy details" was therefore
 *  the only way to inspect the payload first, and it failed silently whenever
 *  the Clipboard API was unavailable or denied: no content, no error, not even
 *  a change of button label. The remaining way to see the report was the act
 *  of sending it.
 *
 *  Both arms below seed the same crash the case above uses, because the
 *  disclosure has to show the parts the drawer summary omits — a preview that
 *  only repeats what is already on screen would not close the gap.
 */
test('the full report can be read in the drawer without sending it', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    sessionStorage.setItem(
      'vaipakam.app.lastError',
      JSON.stringify({
        message: 'E2E preview crash',
        componentStack: 'PreviewCulprit\nSomePage',
        path: '/lend',
        at: Date.now(),
      }),
    );
  });
  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  const dialog = page.getByRole('dialog', { name: /support/i });

  // Collapsed by default — the drawer stays a summary until asked.
  const toggle = dialog.getByRole('button', { name: /show full report/i });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.locator('#diag-report-body')).toBeHidden();

  await toggle.click();
  const body = dialog.locator('#diag-report-body');
  await expect(body).toBeVisible();
  // The component trace is the part the drawer's rows never render, so it is
  // what proves this is the REPORT rather than a restatement of the summary.
  // `toHaveValue`, not `toContainText`: the disclosure is a read-only
  // textarea (round 2 P2 — a `<pre>` is not in the tab order, so the
  // keyboard-only user the failure message instructs could not reach it), and
  // a textarea carries its content as its VALUE with empty text content.
  await expect(body).toHaveValue(/PreviewCulprit/);
  await expect(body).toHaveValue(/E2E preview crash/);
  // ...and the preview honours the same redaction contract as the report.
  expect((await body.inputValue()).toLowerCase()).not.toContain(
    '0x1111222233334444555566667777888899990000',
  );

  await dialog.getByRole('button', { name: /hide full report/i }).click();
  await expect(dialog.locator('#diag-report-body')).toBeHidden();
});

test('a blocked clipboard is reported, and opens the report instead', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
  // A hardened browser, an insecure context or a denied permission all reach
  // the app the same way: `writeText` rejects. Installed before any app code
  // runs so the drawer never sees the real implementation.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error('denied')),
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    sessionStorage.setItem(
      'vaipakam.app.lastError',
      JSON.stringify({
        message: 'E2E clipboard-denied crash',
        componentStack: 'DeniedCulprit\nSomePage',
        path: '/lend',
        at: Date.now(),
      }),
    );
  });
  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  const dialog = page.getByRole('dialog', { name: /support/i });

  await dialog.getByRole('button', { name: /copy details/i }).click();

  // Said, not swallowed...
  await expect(dialog.getByText(/would not let the app use the clipboard/i)).toBeVisible();
  // ...and NOT a dead end: the text the clipboard refused is now on screen.
  // Reporting the failure while leaving no way to read the report would fix
  // the honesty and not the problem.
  await expect(dialog.locator('#diag-report-body')).toBeVisible();
  await expect(dialog.locator('#diag-report-body')).toHaveValue(
    /DeniedCulprit/,
  );
  // The button must NOT claim success.
  await expect(dialog.getByRole('button', { name: /^copy details$/i })).toBeVisible();
});
