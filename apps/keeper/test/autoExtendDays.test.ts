import { describe, expect, it } from 'vitest';
import { extensionDays, fitExtensionFee } from '../src/autoLifecycle';

const DAY = 86_400n;
const NOW = 1_000_000n;

describe('extensionDays', () => {
  it('refuses an unset expiry cap on either side (0 is "not set", never "no limit")', () => {
    expect(extensionDays(0n, NOW + 400n * DAY, NOW)).toBe('an expiry cap is not set');
    expect(extensionDays(NOW + 400n * DAY, 0n, NOW)).toBe('an expiry cap is not set');
  });

  it('fits inside the tighter cap, in whole days', () => {
    expect(extensionDays(NOW + 10n * DAY + 5n, NOW + 400n * DAY, NOW)).toBe(10n);
  });

  it('refuses a passed cap and a cap with no whole day left', () => {
    expect(extensionDays(NOW, NOW + 400n * DAY, NOW)).toBe('the expiry cap has passed');
    expect(extensionDays(NOW + DAY - 1n, NOW + 400n * DAY, NOW)).toBe('no whole day fits inside the expiry cap');
  });
});

describe('fitExtensionFee (#3649 stage 2)', () => {
  // A fee that steps up every 10 days of added term, 100 a step.
  const stepped = (days: bigint) => ((days + 9n) / 10n) * 100n;
  const quoting = () => {
    const asked: bigint[] = [];
    return { asked, feeFor: async (d: bigint) => (asked.push(d), stepped(d)) };
  };

  it('keeps the chosen term when its fee is within the limit, reading one quote', async () => {
    const q = quoting();
    expect(await fitExtensionFee(q.feeFor, 30n, 300n)).toEqual({ days: 30n, fee: 300n });
    expect(q.asked).toEqual([30n]);
  });

  it('shortens to the longest term the limit admits', async () => {
    expect(await fitExtensionFee(quoting().feeFor, 30n, 200n)).toEqual({ days: 20n, fee: 200n });
    expect(await fitExtensionFee(quoting().feeFor, 30n, 150n)).toEqual({ days: 10n, fee: 100n });
  });

  it('refuses when even one day is above the limit, naming both', async () => {
    expect(await fitExtensionFee(quoting().feeFor, 30n, 0n)).toBe("the added initiation fee of even a one-day extension (100) is above the borrower's limit of 0");
  });

  it('admits a zero limit when the extension adds no fee', async () => {
    expect(await fitExtensionFee(async () => 0n, 30n, 0n)).toEqual({ days: 30n, fee: 0n });
  });

  it('lets an unread fee throw, so the loan waits', async () => {
    await expect(fitExtensionFee(async () => { throw new Error('rpc'); }, 30n, 10n)).rejects.toThrow('rpc');
  });
});
