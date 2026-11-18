/** #3733 — while the indexer states it is rebuilding a network's records,
 *  the market lists say so, whatever the cursor's age.
 *
 *  The stub's cursor is always young (it serves the fork live), which is
 *  exactly the reading a rebuild produces on the real Worker: it scans every
 *  few seconds. So an age-based note would stay silent here, and the only
 *  thing that can raise it is the indexer's own `ingest` statement, set
 *  through the stub's `POST /__ingest`.
 *
 *  Asserted contract:
 *  1. Not replaying, young cursor: no note (the list is never called fresh,
 *     it simply carries no warning).
 *  2. Replaying: the note says the figures are being rebuilt and may be
 *     incomplete.
 *  3. Not replaying but more blocks behind than the caught-up cut: the note
 *     states the gap in blocks.
 */
import { test, expect } from '../lib/wallet-fixture';
import { copySource as copy } from '../../src/content/copy';

const STUB = `http://127.0.0.1:${Number(process.env.APP_E2E_STUB_PORT ?? 8788)}`;

async function setIngest(body: Record<string, unknown> | null): Promise<void> {
  const res = await fetch(`${STUB}/__ingest`, {
    method: 'POST',
    body: body === null ? '' : JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
}

test('a rebuilding index is stated on the market list, never read as fresh', async ({ launchWallet }) => {
  const { page } = await launchWallet('borrower');
  try {
    // 1 — the default statement: not replaying, caught up.
    await setIngest(null);
    await page.goto('/offers', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: copy.offers.title })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('market-freshness-note')).toHaveCount(0);

    // 2 — the indexer says it is rebuilding after a deployment.
    await setIngest({ replaying: true, reason: 'deployment', lagBlocks: 48_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const note = page.getByTestId('market-freshness-note');
    await expect(note).toHaveAttribute('data-reading', 'rebuilding', { timeout: 30_000 });
    await expect(note).toContainText(copy.offers.rebuildingList);

    // 3 — the replay ended, but the index is more blocks behind than the cut.
    await setIngest({ replaying: false, reason: null, lagBlocks: 5_000, caughtUpWithinBlocks: 2000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(note).toHaveAttribute('data-reading', 'behind-blocks', { timeout: 30_000 });
    await expect(note).toContainText(/5[,. ]?000 blocks behind/);
  } finally {
    await setIngest(null);
  }
});
