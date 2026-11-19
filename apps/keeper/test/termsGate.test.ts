// apps/keeper/test/termsGate.test.ts — #3734: the keeper names a wallet the
// Terms rule stopped, once, and passes over its later pairs for the run.

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { TermsGate, termsCurrentReader } from '../src/termsGate';

const A = '0x00000000000000000000000000000000000000aa' as Address;
const B = '0x00000000000000000000000000000000000000bb' as Address;

function gate(standing: Record<string, boolean | null>) {
  const lines: string[] = [];
  const reads: string[] = [];
  const g = new TermsGate(async (w) => {
    reads.push(w.toLowerCase());
    return standing[w.toLowerCase()] ?? null;
  }, (l) => lines.push(l));
  return { g, lines, reads };
}

describe('TermsGate (#3734)', () => {
  it('marks and names the wallet not current, once', async () => {
    const { g, lines, reads } = gate({ [A]: false, [B]: true });
    expect(await g.refused('match 1x2', [A, B])).toEqual([A]);
    expect(g.blocks(A)).toBe(true);
    expect(g.blocks(B)).toBe(false);
    expect(g.count).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(A);
    expect(lines[0]).toContain('has not accepted the Terms in force');

    // A later refusal naming the same wallets reads nothing and logs nothing.
    expect(await g.refused('match 1x3', [A, B])).toEqual([]);
    expect(reads).toEqual([A, B]);
    expect(lines).toHaveLength(1);
  });

  it('marks nobody when a standing does not read, and retries it later', async () => {
    const { g, lines, reads } = gate({ [A]: null });
    expect(await g.refused('intent 7', [A])).toEqual([]);
    expect(g.blocks(A)).toBe(false);
    expect(lines[0]).toContain('1 party standing(s) not read');
    await g.refused('intent 8', [A]);
    expect(reads).toEqual([A, A]);
  });

  it('says so when every party reads as current now', async () => {
    const { g, lines } = gate({ [A]: true, [B]: true });
    expect(await g.refused('match 4x5', [A, B])).toEqual([]);
    expect(lines[0]).toContain('no party reads as not current now');
  });

  it('the reader turns a failed read into null', async () => {
    const read = termsCurrentReader(
      { readContract: async () => { throw new Error('no route'); } } as never,
      A,
    );
    expect(await read(B)).toBeNull();
    const ok = termsCurrentReader({ readContract: async () => false } as never, A);
    expect(await ok(B)).toBe(false);
  });
});
