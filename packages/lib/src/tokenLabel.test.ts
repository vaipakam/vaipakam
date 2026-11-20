import { describe, expect, it } from 'vitest';
import { TOKEN_NAME_MAX, TOKEN_SYMBOL_MAX, cleanTokenLabel, tokenLabelForExport } from './tokenLabel';

describe('cleanTokenLabel — hostile token names', () => {
  it('keeps an ordinary symbol and name unchanged', () => {
    expect(cleanTokenLabel('USDC')).toBe('USDC');
    expect(cleanTokenLabel('Wrapped Ether', 'name')).toBe('Wrapped Ether');
    expect(cleanTokenLabel('δΣ€')).toBe('δΣ€');
  });

  it('removes bidi overrides, embeddings, isolates and marks', () => {
    const hostile = 'USDC‮0x1234‬⁦x⁩‎‏؜';
    expect(cleanTokenLabel(hostile, 'name')).toBe('USDC0x1234x');
  });

  it('removes C0, DEL and C1 controls, and zero-width and other format characters', () => {
    expect(cleanTokenLabel('U\u0000S\u0007D\u007fC\u009b')).toBe('USDC');
    expect(cleanTokenLabel('US​DC‌‍⁠﻿­')).toBe('USDC');
    expect(cleanTokenLabel('USDC\u{E0041}\u{E0042}')).toBe('USDC');
  });

  it('turns line breaks and tabs into one space and trims the ends', () => {
    expect(cleanTokenLabel('  USD\r\n\tCoin   X  ', 'name')).toBe('USD Coin X');
  });

  it('caps the length in code points, so emoji are never cut in half', () => {
    expect(cleanTokenLabel('A'.repeat(500))).toBe('A'.repeat(TOKEN_SYMBOL_MAX));
    expect(cleanTokenLabel('B'.repeat(500), 'name')).toBe('B'.repeat(TOKEN_NAME_MAX));
    const emoji = '😀'.repeat(30);
    const out = cleanTokenLabel(emoji);
    expect(Array.from(out)).toHaveLength(TOKEN_SYMBOL_MAX);
    expect(out).toBe('😀'.repeat(TOKEN_SYMBOL_MAX));
  });

  it('returns plain text for a link- or markup-looking name (callers never linkify it)', () => {
    expect(cleanTokenLabel('https://claim.example/x', 'name')).toBe('https://claim.example/x');
    expect(cleanTokenLabel('<a href="x">y</a>', 'name')).toBe('<a href="x">y</a>');
  });

  it('returns empty for a name that is only controls, and for a non-string', () => {
    expect(cleanTokenLabel('‮​\u0000 \n')).toBe('');
    expect(cleanTokenLabel(undefined)).toBe('');
    expect(cleanTokenLabel(42)).toBe('');
    expect(cleanTokenLabel(null, 'name')).toBe('');
  });
});

describe('tokenLabelForExport — formula injection', () => {
  it.each(['=HYPERLINK("https://x","claim")', '+1+1', '-2+3', '@SUM(A1)'])('makes a leading formula character harmless: %s', (raw) => {
    const out = tokenLabelForExport(raw, 'name');
    expect(out.startsWith("'")).toBe(true);
    expect(out.slice(1)).toBe(cleanTokenLabel(raw, 'name'));
  });

  it('checks the lead AFTER cleaning, so a hidden control cannot shield the formula', () => {
    expect(tokenLabelForExport('​=1+1')).toBe("'=1+1");
    expect(tokenLabelForExport('\t =1+1')).toBe("'=1+1");
    expect(tokenLabelForExport('\r\n@cmd')).toBe("'@cmd");
  });

  it('leaves an ordinary label alone', () => {
    expect(tokenLabelForExport('USDC')).toBe('USDC');
    expect(tokenLabelForExport('Wrapped Ether', 'name')).toBe('Wrapped Ether');
    expect(tokenLabelForExport('')).toBe('');
  });
});
