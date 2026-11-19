import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { routesSelector } from './routes';

const D = '0x00000000000000000000000000000000000000dd' as const;
const client = (answer: () => Promise<unknown>) => ({ readContract: answer }) as unknown as PublicClient;

describe('routesSelector', () => {
  it('reads "no facet" as not routed and a facet as routed', async () => {
    expect(await routesSelector(client(async () => '0x0000000000000000000000000000000000000000'), D, '0x12345678')).toBe(false);
    expect(await routesSelector(client(async () => '0x00000000000000000000000000000000000000f1'), D, '0x12345678')).toBe(true);
  });

  it('throws a failed read instead of answering "not routed"', async () => {
    await expect(
      routesSelector(
        client(async () => {
          throw new Error('rpc down');
        }),
        D,
        '0x12345678',
      ),
    ).rejects.toThrow('rpc down');
  });
});
