import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { readTokenMeta } from './tokens';

const A = ('0x' + 'a'.repeat(40)) as `0x${string}`;

/** A client whose token answers `symbol` with `sym` and `decimals` with 6. */
function client(sym: unknown): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'symbol') {
        if (sym instanceof Error) throw sym;
        return sym;
      }
      return 6;
    },
  } as unknown as PublicClient;
}

describe('readTokenMeta (the shared token label rule)', () => {
  it('cleans a symbol before any surface sees it: no bidi, zero-width or control characters, one line, capped', async () => {
    const m = await readTokenMeta(client('US‮DC​\nx'), [A]);
    expect(m[A.toLowerCase()]).toEqual({ symbol: 'USDC x', decimals: 6 });
    const long = await readTokenMeta(client('S'.repeat(50)), [A]);
    expect(Array.from(long[A.toLowerCase()]!.symbol!)).toHaveLength(20);
  });

  it('reads a symbol that cleans to nothing, or a failed read, as unanswered', async () => {
    expect((await readTokenMeta(client('​‮'), [A]))[A.toLowerCase()]!.symbol).toBeNull();
    expect((await readTokenMeta(client(new Error('reverted')), [A]))[A.toLowerCase()]).toEqual({ symbol: null, decimals: 6 });
  });
});
