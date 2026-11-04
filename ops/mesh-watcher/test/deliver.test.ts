import { describe, expect, it } from 'vitest';
import { ALERT_SEPARATOR, packAlerts } from '../src/deliver';
import type { Finding, Severity } from '../src/finding';

function finding(code: string, severity: Severity, size = 100): Finding {
  return {
    key: `${code}/x:97`,
    fingerprint: code,
    code,
    variant: 'x',
    severity,
    chainId: 97,
    title: code,
    detail: 'd'.repeat(size),
  };
}
const format = (f: Finding) => `${f.code}:${f.detail}`;

describe('packAlerts — few messages per tick', () => {
  it('packs every finding of one severity into one message when it fits', () => {
    const batches = packAlerts(
      [finding('a', 'critical'), finding('b', 'critical'), finding('c', 'critical')],
      format,
      4096,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.silent).toBe(false);
    expect(batches[0]!.findings.map((f) => f.code)).toEqual(['a', 'b', 'c']);
    expect(batches[0]!.text.split(ALERT_SEPARATOR)).toHaveLength(3);
  });

  it('never mixes criticals and advisories, and sends criticals first', () => {
    const batches = packAlerts(
      [finding('adv', 'advisory'), finding('crit', 'critical'), finding('adv2', 'advisory')],
      format,
      4096,
    );
    expect(batches.map((b) => [b.silent, b.findings.map((f) => f.code)])).toEqual([
      [false, ['crit']],
      [true, ['adv', 'adv2']],
    ]);
  });

  it('starts a new message at the limit and never exceeds it when packing', () => {
    const findings = ['a', 'b', 'c', 'd', 'e'].map((c) => finding(c, 'critical', 1500));
    const batches = packAlerts(findings, format, 4096);
    expect(batches.flatMap((b) => b.findings.map((f) => f.code))).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const b of batches) {
      if (b.findings.length > 1) expect(b.text.length).toBeLessThanOrEqual(4096);
    }
    expect(batches.map((b) => b.findings.length)).toEqual([2, 2, 1]);
  });

  it('gives an oversized finding a message of its own instead of cutting it', () => {
    const batches = packAlerts(
      [finding('small', 'critical'), finding('huge', 'critical', 5000), finding('tail', 'critical')],
      format,
      4096,
    );
    expect(batches.map((b) => b.findings.map((f) => f.code))).toEqual([['small'], ['huge'], ['tail']]);
    expect(batches[1]!.text).toBe(format(finding('huge', 'critical', 5000)));
  });

  it('returns nothing to send for no findings', () => {
    expect(packAlerts([], format, 4096)).toEqual([]);
  });
});
