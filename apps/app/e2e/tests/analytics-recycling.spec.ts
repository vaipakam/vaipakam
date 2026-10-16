/** #1218 / #1349 M5 — the public recycling account and loop closure on
 *  `/analytics`, driven against the indexer stub's FIXED responses.
 *
 *  WHY FIXTURES. Production derives both reads from a cron-captured D1
 *  history (day stamps, a scheduled backing reading) that a freshly deployed
 *  e2e chain has none of, so a chain-hydrated stub could only ever show the
 *  empty posture. The page's job is the non-empty ones, and those are what
 *  this spec drives: `e2e/lib/recycling-fixture.mjs` documents each fixture
 *  day and variant. The capture itself is the Live-only half (COVERAGE.md).
 *
 *  WALLET-FREE ON PURPOSE. The page's claim is that a visitor who has never
 *  connected can read and reproduce every figure, so the spec uses a bare
 *  Playwright page — no injected provider at all, the honest first-arrival
 *  posture — rather than the wallet fixture.
 *
 *  WHAT IS ASSERTED, and the display rule each one pins
 *  (TokenomicsTechSpec, recycling transparency series):
 *    - the section renders for a visitor, under the page's own title;
 *    - recycling days are labelled by the programme day index and NO
 *      calendar date appears in that table (programme days do not roll at
 *      UTC midnight, so a date would make the page a second authority on
 *      where a day begins);
 *    - an unarmed day is an estimate and an unfinalized day has no pool;
 *    - a positive amount below display precision is labelled as such, never
 *      shown as zero;
 *    - a share rounds DOWN — the 0.999999 day never reads as fully
 *      self-funded;
 *    - the backing verdict is the indexer's answer on whichever relation
 *      the reading's custody state selects: HOLDER after activation (a
 *      short holder reported with the indexer's shortfall) and DIAMOND
 *      before it (backed, or short by the indexer's shortfall) — the
 *      pre-activation posture is the one every live chain shows today;
 *    - a not-determinable answer carries its reason, an older reading's
 *      missing reservations read as predating the figure (never 0), and a
 *      withheld reading is withheld whole, with its reason;
 *    - loop closure renders and a zero-distribution day reads as not
 *      applicable, never 0; the day the record stops in reads as still
 *      being recorded, with no proportion; a day the record has not
 *      reached reads as not yet recorded, never 0 or "nothing paid out";
 *      and the series states the moment its record reaches.
 *
 *  And one assertion about the FIXTURE rather than the page: every backing
 *  variant the stub serves states the verdict the shared
 *  `recycleBackingVerdict` returns for its operands. The stub is plain .mjs
 *  and cannot import that TypeScript module on CI's Node, so it carries the
 *  verdicts as literals; this check is what stops a literal drifting from the
 *  one relation every consumer shares.
 *
 *  SELECTORS. By role and by the app's own English copy, imported from the
 *  catalog (`copySource`) rather than retyped, so a wording change moves the
 *  spec with it instead of breaking it — and a spec that asserted a
 *  paraphrase would pass against a page that no longer says it. Rows are
 *  found inside each table by its caption, so a day label can only match
 *  the table it belongs to.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { recycleBackingVerdict } from '../../../../packages/contracts/src/recycleBacking';
import { copySource as copy } from '../../src/content/copy';
import { RECYCLING_FIXTURE_VARIANTS } from '../lib/recycling-fixture.mjs';

const STUB_ORIGIN = `http://127.0.0.1:${Number(process.env.APP_E2E_STUB_PORT ?? 8788)}`;
const CHAIN_ID = 84532;

/** Any ISO calendar date — the recycling day table must render none. */
const CALENDAR_DATE = /\b20\d\d-\d\d-\d\d\b/;

/**
 * Serve a non-default backing variant to THIS page only, by appending the
 * stub's `recyclingFixture` switch to the app's own request. The request
 * still reaches the stub, so the body is the stub's — the spec never
 * fabricates a response the stub would not serve.
 */
async function useBackingVariant(page: Page, variant: string) {
  await page.route('**/metrics/recycling?**', (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('recyclingFixture', variant);
    return route.continue({ url: url.toString() });
  });
}

async function openAnalytics(page: Page) {
  await page.goto('/analytics', { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: copy.recycling.title }),
  ).toBeVisible({ timeout: 30_000 });
  return page.getByRole('table', { name: copy.recycling.tableCaption });
}

/** The recycling table's row for one programme day. */
const dayRow = (table: Locator, dayId: number) =>
  table.getByRole('row').filter({ hasText: copy.recycling.dayLabel(dayId) });

test('every backing variant the stub serves states the shared verdict for its operands', async ({
  request,
}) => {
  // The stub's own variant list, not a retyped one: a variant added there
  // is checked here without anyone remembering to add it.
  for (const variant of RECYCLING_FIXTURE_VARIANTS) {
    const res = await request.get(
      `${STUB_ORIGIN}/metrics/recycling?chainId=${CHAIN_ID}&recyclingFixture=${variant}`,
    );
    expect(res.status(), `${variant}: served`).toBe(200);
    const { backing } = await res.json();
    if (variant === 'withheld') {
      // The route's whole-block refusal: no verdict, a reason, no figures.
      expect(backing.backed, 'withheld: no verdict').toBeNull();
      expect(backing.unavailableReason).toBe('snapshot-stale');
      expect(backing.vpfiBalance).toBeNull();
      continue;
    }
    expect(backing.backed, `${variant}: literal = shared verdict`).toEqual(
      recycleBackingVerdict(backing),
    );
  }
  // A typo'd switch is refused, never silently served as the default.
  const bad = await request.get(
    `${STUB_ORIGIN}/metrics/recycling?chainId=${CHAIN_ID}&recyclingFixture=nope`,
  );
  expect(bad.status()).toBe(400);
});

test('recycling account: day index labels, estimates, below-precision amounts, round-down share, holder verdict', async ({
  page,
}) => {
  const table = await openAnalytics(page);
  // A visitor lands on the page itself, not the in-shell not-found (#1959's
  // live run caught exactly that title regression).
  await expect(page).toHaveTitle('Analytics — Vaipakam');
  await expect(table).toBeVisible();

  // Days by programme index, never by calendar date. The fixture's window
  // is days 3–7 (30-day default request; coverage starts at day 3).
  for (const dayId of [3, 4, 5, 6, 7]) {
    await expect(dayRow(table, dayId), `day ${dayId} row`).toHaveCount(1);
  }
  await expect(table).not.toContainText(CALENDAR_DATE);

  // Day 4 closed before the governor was armed: an estimate, nothing
  // committed as drawn. Day 3 (armed) carries neither marker.
  await expect(dayRow(table, 4)).toContainText(copy.recycling.estimateBadge);
  await expect(dayRow(table, 4)).toContainText(copy.recycling.cellNotCommitted);
  await expect(dayRow(table, 3)).not.toContainText(copy.recycling.estimateBadge);
  // Day 7 has not closed: no pool, rather than a pool of zero.
  await expect(dayRow(table, 7)).toContainText(copy.recycling.cellNoPool);

  // Day 5's mirror absorption is 1000 wei — positive, far below the page's
  // four-decimal precision. It is LABELLED as below it, never shown as 0;
  // the whole-token day 3 carries no such label, so the check discriminates.
  const below = copy.recycling.belowPrecision('0.0001');
  await expect(dayRow(table, 5)).toContainText(below);
  await expect(dayRow(table, 3)).not.toContainText(below);

  // Day 6's self-funded share is 0.999999: rounded DOWN it is 99.9%, and it
  // must never read as fully self-funded.
  // Matched per CELL: a row's text is its cells run together, so a figure
  // ending in "1" followed by "00%" would read as 100% at row level.
  await expect(
    dayRow(table, 6).getByRole('cell', { name: copy.recycling.sharePct('99.9'), exact: true }),
  ).toHaveCount(1);
  await expect(
    dayRow(table, 6).getByRole('cell', { name: copy.recycling.sharePct('100'), exact: true }),
  ).toHaveCount(0);

  // The backing answer is the indexer's HOLDER-relation verdict, stated
  // with the comparison that decided it and where custody is held.
  await expect(page.getByText(copy.recycling.backedYesHolder)).toBeVisible();
  await expect(page.getByText(copy.recycling.comparisonHolder)).toBeVisible();
  await expect(page.getByText(copy.recycling.custodyHolder)).toBeVisible();
  // Never the pre-activation comparison on an activated reading.
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toHaveCount(0);
});

test('recycling account: a short holder is reported with the indexer\'s shortfall', async ({
  page,
}) => {
  await useBackingVariant(page, 'holder-short');
  await openAnalytics(page);
  // The holder leg misses by exactly 25 VPFI in the fixture; the page states
  // the indexer's figure rather than computing one, and does not call it
  // backed.
  await expect(page.getByText(copy.recycling.backedShortHolder('25'))).toBeVisible();
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
});

test('recycling account: before activation the verdict is the Diamond relation, backed', async ({
  page,
}) => {
  await useBackingVariant(page, 'diamond-backed');
  await openAnalytics(page);
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toBeVisible();
  await expect(page.getByText(copy.recycling.comparisonDiamond)).toBeVisible();
  await expect(page.getByText(copy.recycling.custodyDiamond)).toBeVisible();
  // Never the holder comparison on a pre-activation reading.
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
  await expect(page.getByText(copy.recycling.comparisonHolder)).toHaveCount(0);
});

test('recycling account: a short Diamond is reported with the indexer\'s shortfall', async ({
  page,
}) => {
  await useBackingVariant(page, 'diamond-short');
  await openAnalytics(page);
  // 630 VPFI against 600 + 40 + 25: short by 35, a figure equal to no
  // operand. The retired `vpfiBalance >= bucket` check would have said
  // backed here (630 >= 600).
  await expect(page.getByText(copy.recycling.comparisonDiamond)).toBeVisible();
  await expect(page.getByText(copy.recycling.backedShortDiamond('35'))).toBeVisible();
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
});

test('recycling account: an older reading shows its missing figures as predating it, and no relation', async ({
  page,
}) => {
  await useBackingVariant(page, 'older-reading');
  await openAnalytics(page);
  // Both reservations predate this reading — each says so, never 0.
  await expect(page.getByTestId('recycling-stranded-recovery')).toHaveText(
    copy.recycling.olderReading,
  );
  await expect(page.getByTestId('recycling-recovery-position')).toHaveText(
    copy.recycling.olderReading,
  );
  // No custody state recorded: neither relation is chosen or assumed.
  await expect(page.getByText(copy.recycling.custodyUnknown)).toBeVisible();
  await expect(page.getByText(copy.recycling.backedCustodyUnknown)).toBeVisible();
  await expect(page.getByTestId('recycling-comparison')).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
});

test('recycling account: a not-determinable verdict carries its reason', async ({ page }) => {
  await useBackingVariant(page, 'holder-unknown');
  await openAnalytics(page);
  await expect(page.getByText(copy.recycling.backedHolderBalanceUnknown)).toBeVisible();
  // Not determinable is neither backed nor short.
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toHaveCount(0);
});

test('recycling account: an unread holder is not determinable even when the Diamond leg is short', async ({
  page,
}) => {
  // Activated, holder balance unreadable, Diamond 30 < 40 stranded. The
  // relation needs BOTH legs read, so the page states "cannot be
  // determined" with the holder reason — never "No" with the Diamond leg's
  // shortfall standing in for the whole answer (the withdrawn per-leg rule
  // rendered exactly that).
  await useBackingVariant(page, 'holder-unread-diamond-short');
  await openAnalytics(page);
  const verdict = page.getByTestId('recycling-backed');
  await expect(verdict).toHaveAttribute('data-verdict', 'undetermined');
  await expect(verdict).toHaveText(copy.recycling.backedHolderBalanceUnknown);
  await expect(page.getByTestId('recycling-short-diamond')).toHaveCount(0);
  await expect(page.getByTestId('recycling-short-holder')).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
});

test('recycling account: a withheld reading is withheld whole, with its reason', async ({
  page,
}) => {
  await useBackingVariant(page, 'withheld');
  const table = await openAnalytics(page);
  await expect(page.getByText(copy.recycling.backingUnavailable)).toBeVisible();
  await expect(page.getByText(copy.recycling.backingReasonStale)).toBeVisible();
  // The counter-derived half is never shown alone, and no verdict is given.
  await expect(
    page.getByText(copy.recycling.platformRetained, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesHolder)).toHaveCount(0);
  await expect(page.getByText(copy.recycling.backedYesDiamond)).toHaveCount(0);
  // The day series is unaffected by the reading's failure.
  await expect(dayRow(table, 3)).toHaveCount(1);
});

test('loop closure renders: a quiet day is not applicable, and an unfinished or unreached day is never zero', async ({
  page,
}) => {
  await page.goto('/analytics', { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: copy.loopClosure.title }),
  ).toBeVisible({ timeout: 30_000 });
  const table = page.getByRole('table', { name: copy.loopClosure.tableCaption });
  await expect(table).toBeVisible();

  // Percentages are matched by pattern, not catalog entry: the loop table
  // formats its proportion through the shared rounded-down percent helper,
  // and pinning which catalog key that helper reads would test the wiring
  // rather than what a reader sees.
  //
  // Loop closure is bucketed by the UTC calendar day value left the
  // platform — a different "day" from the recycling account's, which is why
  // the calendar-date check above is scoped to the recycling table only.
  //
  // Rows are found by content, never by a day computed from this host's
  // clock: the route anchors its window on Date.now(), so a midnight
  // rollover between the stub's answer and an assertion would move it.

  // Days with nothing paid out read as not applicable — never 0%.
  await expect(
    table.getByRole('row').filter({ hasText: copy.loopClosure.notApplicable }).first(),
  ).toBeVisible();
  // Per CELL, for the reason given in the recycling test: no share cell
  // anywhere in the table reads 0% (the fixture has no genuine 0% day).
  await expect(
    table.getByRole('cell').filter({ hasText: /^\s*0(?:[.,]0+)?\s*%\s*$/ }),
  ).toHaveCount(0);

  // The fixture's distribution days carry real shares (0.75 and 0.2), so the
  // not-applicable rows are not simply every row.
  await expect(
    table.getByRole('cell').filter({ hasText: /^\s*75(?:[.,]0+)?\s*%\s*$/ }),
  ).toHaveCount(1);
  // Its 1000-wei absorption is labelled below precision here too.
  await expect(
    table.getByRole('row').filter({ hasText: copy.recycling.belowPrecision('0.0001') }),
  ).toHaveCount(1);

  // #1349 M5 — which days are KNOWN. The fixture's record stops partway
  // through yesterday, so exactly one row is still being recorded (its
  // amount so far shown, no proportion) and exactly one — today — is not
  // yet recorded in every cell. Neither reads as "nothing paid out".
  const partial = table.getByRole('row').filter({ hasText: copy.loopClosure.dayPartial });
  await expect(partial).toHaveCount(1);
  await expect(partial.getByRole('cell').filter({ hasText: copy.loopClosure.ratioNotFinal })).toHaveCount(1);
  await expect(partial.getByRole('cell').filter({ hasText: /^\s*5\s*$/ })).toHaveCount(2);
  await expect(partial).not.toContainText(copy.loopClosure.notApplicable);
  const unrecorded = table.getByRole('row').filter({ hasText: copy.loopClosure.notRecorded });
  await expect(unrecorded).toHaveCount(1);
  await expect(unrecorded.getByRole('cell').filter({ hasText: copy.loopClosure.notRecorded })).toHaveCount(4);
  await expect(unrecorded).not.toContainText(copy.loopClosure.notApplicable);
  // The as-of moment is stated: the stub's record reaches 06:00 UTC
  // yesterday. Matched through the catalog template with the instant as a
  // pattern, not a date from this host's clock (see the rollover note).
  const AT = '@@AT@@';
  const asOf = copy.loopClosure
    .recordedBefore(AT)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(AT, '\\d{4}-\\d{2}-\\d{2}T06:00:00\\.000Z');
  await expect(page.getByText(new RegExp(`^${asOf}$`))).toBeVisible();
});
