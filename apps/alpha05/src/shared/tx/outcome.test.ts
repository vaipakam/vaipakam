import { describe, expect, it } from 'vitest';
import { summarize } from './outcome';

describe('summarize', () => {
  it('is unknown with no legs or only unknown legs', () => {
    expect(summarize([], 1).verdict).toBe('unknown');
    expect(summarize([{ status: 'unknown', label: 'a', reason: 'r' }], 1).verdict).toBe('unknown');
  });
  it('is partial when some legs are done and some are not', () => {
    const out = summarize(
      [
        { status: 'done', label: 'approve' },
        { status: 'not-done', label: 'accept', reason: 'reverted' },
      ],
      1,
    );
    expect(out.verdict).toBe('partial');
  });
  it('is partial, never done, when a done leg sits beside an unknown one', () => {
    const out = summarize(
      [
        { status: 'done', label: 'a' },
        { status: 'unknown', label: 'b', reason: 'read failed' },
      ],
      1,
    );
    expect(out.verdict).toBe('partial');
  });
  it('is done only when every leg is done', () => {
    expect(summarize([{ status: 'done', label: 'a' }], 1).verdict).toBe('done');
  });
});
