import { describe, expect, it } from 'vitest';
import { buildSourceTime } from './buildTime.mjs';

const noGit = () => {
  throw new Error('not a git repository');
};

describe('buildSourceTime (#3236)', () => {
  it('takes SOURCE_DATE_EPOCH first', () => {
    const t = buildSourceTime({ env: { SOURCE_DATE_EPOCH: '1767225600' }, git: () => '1' });
    expect(t).toEqual({ iso: '2026-01-01T00:00:00.000Z', source: 'SOURCE_DATE_EPOCH', reproducible: true });
  });

  it('refuses a SOURCE_DATE_EPOCH that is not whole seconds', () => {
    expect(() => buildSourceTime({ env: { SOURCE_DATE_EPOCH: '2026-01-01' } })).toThrow(/whole seconds/);
  });

  it('otherwise reads the commit time, the same on every call', () => {
    const git = (args: string[]) => {
      expect(args).toEqual(['log', '-1', '--format=%ct', 'HEAD']);
      return '1767225600\n';
    };
    const a = buildSourceTime({ env: {}, git });
    const b = buildSourceTime({ env: {}, git, now: () => new Date(0) });
    expect(a).toEqual({ iso: '2026-01-01T00:00:00.000Z', source: 'commit', reproducible: true });
    expect(b).toEqual(a);
  });

  it('falls back to the clock and says the build is not reproducible', () => {
    const t = buildSourceTime({ env: {}, git: noGit, now: () => new Date('2026-11-07T00:00:00Z') });
    expect(t.iso).toBe('2026-11-07T00:00:00.000Z');
    expect(t.source).toBe('clock');
    expect(t.reproducible).toBe(false);
    expect(t.reason).toMatch(/not a git repository/);
  });

  it('treats an empty git answer as no commit time', () => {
    const t = buildSourceTime({ env: {}, git: () => '', now: () => new Date(0) });
    expect(t.source).toBe('clock');
    expect(t.reason).toMatch(/no commit time/);
  });
});
