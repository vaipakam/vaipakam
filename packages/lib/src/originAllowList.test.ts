import { describe, expect, it } from 'vitest';
import { isListedOrigin, parseOriginList } from './originAllowList';

describe('originAllowList', () => {
  it('parses a comma-separated list, dropping empty entries', () => {
    expect(parseOriginList(' https://a.example, ,https://b.example,')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseOriginList(undefined)).toEqual([]);
  });

  it('matches only an exact listed origin', () => {
    const csv = 'https://app.example,https://b.example';
    expect(isListedOrigin('https://app.example', csv)).toBe(true);
    expect(isListedOrigin('https://app.example.evil', csv)).toBe(false);
    expect(isListedOrigin('', 'https://app.example,')).toBe(false);
    expect(isListedOrigin(null, csv)).toBe(false);
    expect(isListedOrigin('https://app.example', undefined)).toBe(false);
  });
});
