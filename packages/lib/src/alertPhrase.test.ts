import { describe, expect, it } from 'vitest';
import { normaliseAlertPhrase, withAlertPhrase } from './alertPhrase';

describe('normaliseAlertPhrase (#3346)', () => {
  it('trims, collapses spaces and keeps letters in any script', () => {
    expect(normaliseAlertPhrase('  blue   heron 7 ')).toBe('blue heron 7');
    expect(normaliseAlertPhrase('நீல நாரை')).toBe('நீல நாரை');
    expect(normaliseAlertPhrase("Ravi's kite!")).toBe("Ravi's kite!");
  });

  it('refuses too short, too long, links, handles and markup', () => {
    expect(normaliseAlertPhrase('ab')).toBeNull();
    expect(normaliseAlertPhrase('x'.repeat(33))).toBeNull();
    expect(normaliseAlertPhrase('https://evil.example')).toBeNull();
    expect(normaliseAlertPhrase('@vaipakam')).toBeNull();
    expect(normaliseAlertPhrase('<b>hi</b>')).toBeNull();
    expect(normaliseAlertPhrase('...')).toBeNull();
    expect(normaliseAlertPhrase(42)).toBeNull();
  });

  it('puts the phrase line first, or leaves the text alone', () => {
    expect(withAlertPhrase('Alert', 'blue heron')).toBe('Your Vaipakam phrase: blue heron\n\nAlert');
    expect(withAlertPhrase('Alert', null)).toBe('Alert');
  });
});
