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
        cumulative: { ...series().cumulative, absorbedPreLaunch: '4200' },
      }),
    );
    render(<RecyclingAccount chainId={8453} />);
    await waitFor(() =>
      expect(screen.getByTestId('recycling-prelaunch').textContent).toBe('4200'),
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
    mockSeries(series({ daily: [day({ stamped: false })] }));
    render(<RecyclingAccount chainId={8453} />);
    await screen.findByTestId('recycling-no-days');
  });
});
