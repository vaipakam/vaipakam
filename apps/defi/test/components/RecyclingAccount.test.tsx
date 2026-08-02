/**
 * M5 (#1218 / #1349) — the recycling account surface.
 *
 * These tests pin the HONESTY properties, not the layout. The read surface
 * spends a lot of effort refusing to publish figures it cannot stand
 * behind; the whole value of that is lost if the page renders a refusal as
 * a zero or a dash. Each test below is one way that could happen.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import RecyclingAccount from '../../src/components/RecyclingAccount';
import * as indexerClient from '../../src/lib/indexerClient';
import type { RecyclingSeries } from '../../src/lib/indexerClient';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Render the KEY plus any interpolated values, so a test asserting
    // "the reason is shown" cannot pass on an empty string.
    t: (k: string, o?: Record<string, unknown>) =>
      o && typeof o === 'object' && !('defaultValue' in o)
        ? `${k}:${Object.values(o).join(',')}`
        : k,
  }),
}));

/** Whole-token amount as a wei string — i.e. a figure large enough to
 *  actually render at the surface's four-decimal precision. */
const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString();

const day = (over: Partial<RecyclingSeries['daily'][number]> = {}) => ({
  dayId: 1,
  stamped: true,
  armed: true,
  estimate: false,
  origin: 'event' as const,
  scheduleFloor: '1000',
  recycledBudget: '250',
  aBar: '10',
  marginBps: 1000,
  freshDrawdown: '900',
  netEmission: '900',
  selfFundingRatio: 0.2,
  absorbedLocal: '5',
  absorbedMirror: '0',
  absorbed: '5',
  ...over,
});

const series = (over: Partial<RecyclingSeries> = {}): RecyclingSeries => ({
  chainId: 8453,
  days: 30,
  fromDay: 1,
  toDay: 1,
  scope: 'global',
  coverageFromDay: 1,
  daily: [day()],
  backing: {
    vpfiBalance: tok(100),
    bucket: tok(40),
    unearmarked: tok(60),
    outstandingRecycled: tok(10),
    paidOutRecycled: tok(2),
    keeperBudget: tok(5),
    platformRetained: tok(25),
    releasedRemitStranded: '0',
    unavailableReason: null,
    asOf: '2026-08-03T00:00:00.000Z',
  },
  cumulative: {
    absorbed: '5',
    absorbedPreLaunch: '0',
    absorbedLocal: '5',
    absorbedMirror: '0',
    freshDrawdown: '900',
    recycledBudget: '250',
    runwayExtensionDays: 3,
    runwayUnavailableReason: null,
    selfFunded: false,
  },
  ...over,
});

function mockSeries(s: RecyclingSeries | null) {
  vi.spyOn(indexerClient, 'fetchRecyclingSeries').mockResolvedValue(s);
}

beforeEach(() => vi.restoreAllMocks());

describe('RecyclingAccount — refusals must survive rendering', () => {
  it('shows nothing rather than zeros when the read fails', async () => {
    mockSeries(null);
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByText('recycling.unavailable');
    // A zeroed account would look like a quiet programme, which is a
    // claim we have not earned.
    expect(screen.queryByTestId('recycling-absorbed')).toBeNull();
  });

  it('leaves an UNARMED day\'s drawn cell EMPTY, never 0', async () => {
    mockSeries(
      series({
        daily: [day({ dayId: 7, armed: false, estimate: true, netEmission: null })],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() => expect(screen.getByTestId('drawn-7')).toBeDefined());
    // Printing 0 would assert a commitment that was never made.
    expect(screen.getByTestId('drawn-7').textContent).toBe('');
    expect(screen.getByTestId('estimate-7')).toBeDefined();
  });

  it('leaves a PARTIAL day\'s absorbed cell EMPTY, never 0', async () => {
    mockSeries(series({ daily: [day({ dayId: 9, absorbed: null })] }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() => expect(screen.getByTestId('absorbed-9')).toBeDefined());
    expect(screen.getByTestId('absorbed-9').textContent).toBe('');
  });

  it('renders the REASON a runway is withheld, not a dash', async () => {
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          runwayExtensionDays: null,
          runwayUnavailableReason: 'backfilled-mirror-absorption-not-decomposable',
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-runway').textContent).toContain(
        'backfilled-mirror-absorption-not-decomposable',
      ),
    );
    // "—" would read as zero runway, which is the opposite of "cannot say".
    expect(screen.getByTestId('recycling-runway').textContent).not.toBe('—');
  });

  it('says so when this deployment has finalized no day itself', async () => {
    mockSeries(series({ scope: 'local-only' }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-scope-note');
  });

  it('publishes the pre-launch stock as its own figure', async () => {
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          absorbedPreLaunch: (42n * 10n ** 18n).toString(),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-prelaunch').textContent).toBe('42'),
    );
  });

  it('states where the records begin rather than implying quiet days', async () => {
    mockSeries(series({ coverageFromDay: 300 }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-coverage').textContent).toContain('300'),
    );
  });

  it('says no day has closed rather than rendering an empty table silently', async () => {
    mockSeries(series({ daily: [] }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-no-days');
  });
});

describe('RecyclingAccount — M5 content requirements', () => {
  it('formats wei rather than printing the raw integer', async () => {
    mockSeries(
      series({
        daily: [day({ dayId: 1, scheduleFloor: (1234n * 10n ** 18n).toString() })],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-day-1').textContent).toContain('1,234'),
    );
    // The raw wei string must not appear anywhere.
    expect(screen.getByTestId('recycling-day-1').textContent).not.toContain(
      '1234000000000000000000',
    );
  });

  it('WITHHOLDS global totals on a local-only deployment', async () => {
    mockSeries(
      series({
        scope: 'local-only',
        cumulative: {
          ...series().cumulative,
          absorbed: '0',
          freshDrawdown: '0',
          absorbedLocal: (7n * 10n ** 18n).toString(),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-scope-note');
    // A zero here is exactly the "looks like a quiet programme" failure.
    expect(screen.queryByTestId('recycling-absorbed')).toBeNull();
    expect(screen.queryByTestId('recycling-drawn')).toBeNull();
    // …while what WAS observed locally is shown.
    expect(screen.getByTestId('recycling-absorbed-local').textContent).toBe('7');
  });

  it('publishes the local / mirror split, not just a combined figure', async () => {
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          absorbedLocal: (3n * 10n ** 18n).toString(),
          absorbedMirror: (4n * 10n ** 18n).toString(),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() => {
      expect(screen.getByTestId('recycling-absorbed-local').textContent).toBe('3');
      expect(screen.getByTestId('recycling-absorbed-mirror').textContent).toBe('4');
    });
  });

  it('LISTS an unfinalized day so its live absorption is visible', async () => {
    mockSeries(
      series({
        daily: [
          day({
            dayId: 11,
            stamped: false,
            scheduleFloor: null,
            recycledBudget: null,
            netEmission: null,
            absorbed: null,
            selfFundingRatio: null,
            absorbedLocal: (2n * 10n ** 18n).toString(),
          }),
        ],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    // Filtering it out hid absorption the endpoint deliberately serves live.
    await waitFor(() => expect(screen.getByTestId('recycling-day-11')).toBeDefined());
    expect(screen.getByTestId('drawn-11').textContent).toBe('');
    // The COMBINED figure is withheld until the day closes…
    expect(screen.getByTestId('absorbed-11').textContent).toBe('');
    // …but the live component is the whole reason the row is listed. r1
    // listed the row and then showed nothing in it.
    expect(screen.getByTestId('absorbed-local-11').textContent).toBe('2');
  });

  it('WITHHOLDS the mirror component until the day closes', async () => {
    // Another reward chain reports a day only once its own clock has
    // passed it, so before finalization this cell is structurally absent.
    // r2 published it: a rendered 0 under "Absorbed on other reward
    // chains" states that no other chain absorbed anything, which is the
    // one thing this deployment cannot know yet.
    mockSeries(
      series({
        daily: [
          day({
            dayId: 12,
            stamped: false,
            absorbed: null,
            absorbedLocal: (2n * 10n ** 18n).toString(),
            absorbedMirror: '0',
          }),
        ],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('absorbed-mirror-12')).toBeDefined(),
    );
    expect(screen.getByTestId('absorbed-mirror-12').textContent).toBe('');
    // …while the local term stays live, which is the asymmetry itself.
    expect(screen.getByTestId('absorbed-local-12').textContent).toBe('2');
  });

  it('shows the mirror component once the day HAS closed', async () => {
    // The withholding above must be about finalization, not a blanket
    // hiding of the column.
    mockSeries(
      series({
        daily: [
          day({
            dayId: 13,
            stamped: true,
            absorbedMirror: (9n * 10n ** 18n).toString(),
          }),
        ],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('absorbed-mirror-13').textContent).toBe('9'),
    );
  });

  it('marks a recomputed day as reconstructed, not recorded', async () => {
    mockSeries(series({ daily: [day({ dayId: 4, origin: 'backfill' })] }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recomputed-4');
  });

  it('shows the self-funded share the endpoint already computes', async () => {
    mockSeries(series({ daily: [day({ dayId: 5, selfFundingRatio: 0.25 })] }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('selffunded-5').textContent).toContain('25'),
    );
  });

  it('states the drawn figure\'s limits ON THIS SURFACE', async () => {
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    // The ratified spec: a caveat kept elsewhere is one a reader over-trusts.
    await screen.findByTestId('recycling-drawn-bounds');
  });

  it('discloses that the table is a window, not the whole programme', async () => {
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-window').textContent).toContain('30'),
    );
  });
});

describe('RecyclingAccount — a positive figure is never rendered as zero', () => {
  it('marks a small nonzero amount below the display threshold', async () => {
    // 1 wei formats to "0" at four fractional digits. On an accounting
    // surface that is a false statement, not a rounding artefact: it is
    // indistinguishable from a programme that absorbed nothing.
    mockSeries(
      series({
        cumulative: { ...series().cumulative, absorbedPreLaunch: '1' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-prelaunch').textContent).toBe(
        'recycling.belowThreshold',
      ),
    );
  });

  it('still renders a genuine zero as zero', async () => {
    // The marker must mean "small", not "unknown" — a true zero is a fact
    // the platform can state.
    mockSeries(
      series({
        cumulative: { ...series().cumulative, absorbedPreLaunch: '0' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-prelaunch').textContent).toBe('0'),
    );
  });

  it('never rounds a partially self-funded day up to 100%', async () => {
    // Math.round(0.9995) reaches 100%, presenting a day that still drew a
    // fresh floor as fully self-funded — and contradicting the runway
    // card, whose selfFunded state is exact.
    mockSeries(series({ daily: [day({ dayId: 8, selfFundingRatio: 0.9995 })] }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() => expect(screen.getByTestId('selffunded-8')).toBeDefined());
    expect(screen.getByTestId('selffunded-8').textContent).not.toContain('100');
    expect(screen.getByTestId('selffunded-8').textContent).toContain('99.9');
  });

  it('shows 100% only when the day genuinely reached it', async () => {
    mockSeries(series({ daily: [day({ dayId: 10, selfFundingRatio: 1 })] }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('selffunded-10').textContent).toContain('100'),
    );
  });
});

describe('RecyclingAccount — a corrupt payload degrades narrowly', () => {
  it('falls back to unavailable rather than throwing through the boundary', async () => {
    // BigInt('') throws during render, and the only error boundary wraps
    // the whole routed surface — so one bad field would replace all of
    // /analytics with the app-crash fallback.
    mockSeries(
      series({
        cumulative: { ...series().cumulative, absorbedLocal: 'not-a-number' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByText('recycling.unavailable');
  });

  it('rejects a corrupt DAILY amount too, not only a cumulative one', async () => {
    mockSeries(series({ daily: [day({ dayId: 3, scheduleFloor: '12,34' })] }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByText('recycling.unavailable');
  });

  it('does NOT substitute a zero for the corrupt field', async () => {
    // Coercing a detected corruption into a confident figure is worse
    // than refusing: it is the failure this whole surface prevents.
    mockSeries(
      series({
        cumulative: { ...series().cumulative, absorbedLocal: 'x' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByText('recycling.unavailable');
    expect(screen.queryByTestId('recycling-absorbed-local')).toBeNull();
  });
});

describe('RecyclingAccount — per-day provenance and scope', () => {
  it('keeps the daily table scrollable on a narrow viewport', async () => {
    // Without its own scroller the eight-column table expands the
    // DOCUMENT, pushing the drawn and absorbed columns off-screen.
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    const wrap = await screen.findByTestId('recycling-table-wrap');
    expect(wrap.className).toContain('pd-table-wrap');
    expect(wrap.querySelector('table.recycling-days')).not.toBeNull();
  });

  it('shows each day\'s local and mirror components, not only the combined', async () => {
    mockSeries(
      series({
        daily: [
          day({
            dayId: 6,
            absorbedLocal: (3n * 10n ** 18n).toString(),
            absorbedMirror: (4n * 10n ** 18n).toString(),
            absorbed: (7n * 10n ** 18n).toString(),
          }),
        ],
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() => {
      expect(screen.getByTestId('absorbed-local-6').textContent).toBe('3');
      expect(screen.getByTestId('absorbed-mirror-6').textContent).toBe('4');
      expect(screen.getByTestId('absorbed-6').textContent).toBe('7');
    });
  });

  it('explains the difference WHEN the parts exceed the combined total', async () => {
    // The endpoint folds EVERY row into the components and only FINALIZED
    // rows into the combined total, so during live operation the two
    // legitimately disagree. Adjacency without that note invites a reader
    // to treat the difference as an error.
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          absorbed: tok(5),
          absorbedLocal: tok(5),
          absorbedMirror: tok(3), // an open day has already absorbed
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-split-scope');
  });

  it('does NOT claim a divergence when the figures agree', async () => {
    // A standing caveat explaining a difference that is not on screen
    // teaches a reader to distrust the figures that are.
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          absorbed: tok(8),
          absorbedLocal: tok(5),
          absorbedMirror: tok(3),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-absorbed');
    expect(screen.queryByTestId('recycling-split-scope')).toBeNull();
  });

  it('does NOT claim a divergence too small to SEE', async () => {
    // The note asserts something about the rendered figures, so a
    // reader must be able to check it by looking. An excess below the
    // display threshold leaves all three cells reading the same, and
    // the note would then point at a discrepancy nothing on screen
    // supports — the unconditional-caveat defect, one order down.
    mockSeries(
      series({
        cumulative: {
          ...series().cumulative,
          absorbed: '5',
          absorbedLocal: '5',
          absorbedMirror: '3', // 3 wei — invisible at four decimals
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-absorbed');
    expect(screen.queryByTestId('recycling-split-scope')).toBeNull();
  });

  it('does NOT explain a combined total it is not showing', async () => {
    // Under local-only scope the combined total is deliberately withheld,
    // so a note describing how to reconcile with it describes nothing.
    mockSeries(
      series({
        scope: 'local-only',
        cumulative: {
          ...series().cumulative,
          absorbed: '0',
          absorbedLocal: tok(5),
          absorbedMirror: tok(3),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-scope-note');
    expect(screen.queryByTestId('recycling-absorbed')).toBeNull();
    expect(screen.queryByTestId('recycling-split-scope')).toBeNull();
  });
});

describe('RecyclingAccount — the reserve is never published alone', () => {
  const noBacking = (reason: string) => ({
    vpfiBalance: null,
    bucket: null,
    unearmarked: null,
    outstandingRecycled: null,
    paidOutRecycled: null,
    keeperBudget: null,
    platformRetained: null,
    releasedRemitStranded: null,
    unavailableReason: reason,
    asOf: null,
  });

  it('publishes the retained reserve WITH the balance actually behind it', async () => {
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-retained').textContent).toBe('25'),
    );
    // The pair is the whole requirement: every other figure on this page is
    // counter-derived, and a counter cannot notice the tokens have left.
    expect(screen.getByTestId('recycling-balance').textContent).toBe('100');
    expect(screen.getByTestId('recycling-unearmarked').textContent).toBe('60');
    expect(screen.getByTestId('recycling-bucket').textContent).toBe('40');
  });

  it('withholds the reserve ENTIRELY when the chain could not be read', async () => {
    mockSeries(series({ backing: noBacking('read-failed: timeout') }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-backing-unavailable');
    // Not a zero, not a dash, and above all not the reserve on its own.
    expect(screen.queryByTestId('recycling-retained')).toBeNull();
    expect(screen.queryByTestId('recycling-balance')).toBeNull();
  });

  it('states WHY the reserve is missing, since a dash reads as zero', async () => {
    mockSeries(series({ backing: noBacking('no-rpc-endpoint-configured') }));
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('recycling-backing-unavailable').textContent,
      ).toContain('no-rpc-endpoint-configured'),
    );
  });

  it('degrades rather than crashing when an older indexer omits the block', async () => {
    // A rolling deploy legitimately serves a response without `backing`.
    // Destructuring it blind took the whole /analytics surface down.
    const s = series();
    delete (s as unknown as Record<string, unknown>).backing;
    mockSeries(s);
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('recycling-backing-unavailable').textContent,
      ).toContain('not-served-by-this-indexer'),
    );
    // …and the rest of the account still renders.
    expect(screen.getByTestId('recycling-absorbed-local')).toBeDefined();
  });

  it('rejects a corrupt BACKING amount, like any other amount family', async () => {
    // A new family of amounts that skipped the validator would render
    // unvalidated — nothing else notices an omission from that list.
    mockSeries(
      series({
        backing: { ...series().backing, platformRetained: 'not-a-number' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByText('recycling.unavailable');
  });
});

describe('RecyclingAccount — a floored figure must not hide a shortfall', () => {
  it('says the pool is SHORT when the balance is below the bucket', async () => {
    // `unearmarked` is `balance − bucket` floored at zero, so a bucket
    // exactly consumed and one in breach render identically. The lens
    // documentation says the zero is ambiguous by construction and
    // directs a reader to compare balance against bucket — so the page
    // states the comparison rather than leaving it to be inferred.
    mockSeries(
      series({
        backing: {
          ...series().backing,
          vpfiBalance: tok(95),
          bucket: tok(100),
          unearmarked: '0', // floored — looks identical to fully consumed
          outstandingRecycled: tok(90),
          keeperBudget: '0',
          platformRetained: tok(10),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-backed').textContent).toContain(
        'backedShort',
      ),
    );
    // The shortfall is quantified, not merely flagged.
    expect(screen.getByTestId('recycling-backed').textContent).toContain('5');
  });

  it('says the pool IS backed when the balance covers it', async () => {
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-backed').textContent).toContain(
        'backedYes',
      ),
    );
  });

  it('does not distinguish exactly-consumed from short by the floored value alone', async () => {
    // Both render `unearmarked` 0; only the verdict separates them.
    mockSeries(
      series({
        backing: {
          ...series().backing,
          vpfiBalance: tok(100),
          bucket: tok(100),
          unearmarked: '0',
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-unearmarked').textContent).toBe('0'),
    );
    expect(screen.getByTestId('recycling-backed').textContent).toContain(
      'backedYes',
    );
  });

  it('withholds the WHOLE block when any displayed member is null', async () => {
    // A partial payload — retained present, balance null — passed the
    // earlier two-field gate and rendered the reserve with an empty
    // balance cell, breaking all-or-nothing on the untrusted-payload path
    // the validator exists to cover.
    mockSeries(
      series({
        backing: { ...series().backing, vpfiBalance: null },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-backing-unavailable');
    expect(screen.queryByTestId('recycling-retained')).toBeNull();
  });

  it('withholds the block when the BUCKET is null, not just the balance', async () => {
    // Same rule, other member — the gate must cover every displayed
    // field rather than a representative sample.
    mockSeries(series({ backing: { ...series().backing, bucket: null } }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-backing-unavailable');
    expect(screen.queryByTestId('recycling-retained')).toBeNull();
  });

  it('never claims a shortfall of ZERO for a real shortfall', async () => {
    // A gap under 0.0001 truncates to "short by 0 VPFI" — a false
    // quantified claim, and worse than the bare verdict it decorates.
    mockSeries(
      series({
        backing: {
          ...series().backing,
          vpfiBalance: (100n * 10n ** 18n).toString(),
          bucket: (100n * 10n ** 18n + 3n).toString(), // 3 wei short
          unearmarked: '0',
          outstandingRecycled: '0',
          keeperBudget: '0',
          platformRetained: (100n * 10n ** 18n + 3n).toString(),
        },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-backed').textContent).toContain(
        'backedShort',
      ),
    );
    const text = screen.getByTestId('recycling-backed').textContent!;
    expect(text).toContain('recycling.belowThreshold');
    expect(text).not.toMatch(/short by 0\b/);
  });

  it('publishes stranded value so it does not read as a depleted reserve', async () => {
    // `restoreReleasedRemit` returns the commitment WITHOUT re-crediting
    // the bucket, so the reserve falls — and can floor to zero — while
    // the value is neither lost nor spent, merely in flight.
    mockSeries(
      series({
        backing: { ...series().backing, releasedRemitStranded: tok(7) },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-stranded').textContent).toBe('7'),
    );
  });

  it('omits the stranded row entirely when there is none', async () => {
    // A permanent "stranded: 0" is a caveat whose condition is absent.
    mockSeries(series());
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-backed');
    expect(screen.queryByTestId('recycling-stranded')).toBeNull();
  });
});
