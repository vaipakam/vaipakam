import { describe, expect, it } from 'vitest';
import { withAddendum } from './addendum';
import type { Receipt } from './types';

const r = { title: 't', rows: [], consequences: ['own'], prompts: 1, readAt: 0 } as unknown as Receipt;

describe('receipt addendum (#3769)', () => {
  it('puts the page statement first among the consequences', () => {
    expect(withAddendum(r, ['for someone'])?.consequences).toEqual(['for someone', 'own']);
  });
  it('leaves the receipt as it is with no statement, and an unread one unread', () => {
    expect(withAddendum(r, [])).toBe(r);
    expect(withAddendum(null, ['x'])).toBeNull();
  });
});
