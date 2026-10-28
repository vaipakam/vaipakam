import { describe, expect, it } from 'vitest';
import { fragmentId } from './useScrollToFragment';

describe('fragmentId', () => {
  it('reads the id a fragment names', () => {
    expect(fragmentId('#approvals')).toBe('approvals');
    expect(fragmentId('#caf%C3%A9')).toBe('café');
  });

  it('keeps a malformed escape as written', () => {
    expect(fragmentId('#bad%E0')).toBe('bad%E0');
  });

  it('answers null when there is no fragment', () => {
    expect(fragmentId('')).toBeNull();
    expect(fragmentId('#')).toBeNull();
    expect(fragmentId('approvals')).toBeNull();
  });
});
