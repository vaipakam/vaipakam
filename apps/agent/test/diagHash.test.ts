import { describe, it, expect } from 'vitest';
import { isHexAddress, walletHash } from '../src/diagHash';

const KEY = 'unit-test-hmac-key';
// Two distinct addresses that REDACT to the same `0x…abcd` display
// (`0x1111…1111`) — the exact collision the keyed hash exists to
// defeat. They must hash to different values.
const COLLIDING_A = '0x1111000000000000000000000000000000001111';
const COLLIDING_B = '0x1111ffffffffffffffffffffffffffffffff1111';

describe('isHexAddress', () => {
  it('accepts a well-formed address', () => {
    expect(isHexAddress('0x' + 'a'.repeat(40))).toBe(true);
  });

  it('rejects wrong length, missing prefix, non-hex, non-strings', () => {
    expect(isHexAddress('0x' + 'a'.repeat(39))).toBe(false);
    expect(isHexAddress('0x' + 'a'.repeat(41))).toBe(false);
    expect(isHexAddress('a'.repeat(40))).toBe(false);
    expect(isHexAddress('0x' + 'z'.repeat(40))).toBe(false);
    expect(isHexAddress(null)).toBe(false);
    expect(isHexAddress(42)).toBe(false);
  });
});

describe('walletHash', () => {
  it('is deterministic for the same wallet + key', async () => {
    const a = await walletHash(COLLIDING_A, KEY);
    const b = await walletHash(COLLIDING_A, KEY);
    expect(a).toBe(b);
    // SHA-256 HMAC → 64 hex chars.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case-insensitive on the wallet (checksummed == lowercase)', async () => {
    const lower = await walletHash(COLLIDING_A.toLowerCase(), KEY);
    const upper = await walletHash(COLLIDING_A.toUpperCase().replace('0X', '0x'), KEY);
    expect(lower).toBe(upper);
  });

  it('separates wallets that share a redacted display', async () => {
    // The load-bearing property: a redacted-wallet collision must
    // NOT become a hash collision.
    const a = await walletHash(COLLIDING_A, KEY);
    const b = await walletHash(COLLIDING_B, KEY);
    expect(a).not.toBe(b);
  });

  it('is key-dependent — a different secret yields a different hash', async () => {
    const withKey1 = await walletHash(COLLIDING_A, 'key-one');
    const withKey2 = await walletHash(COLLIDING_A, 'key-two');
    expect(withKey1).not.toBe(withKey2);
  });

  it('throws on an empty key so a misconfigured Worker fails loudly', async () => {
    await expect(walletHash(COLLIDING_A, '')).rejects.toThrow();
  });
});
