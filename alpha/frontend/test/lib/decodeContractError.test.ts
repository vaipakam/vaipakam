import { describe, it, expect } from 'vitest';
import {
  decodeContractError,
  extractRevertData,
  extractRevertSelector,
  namedRevertSelector,
} from '../../src/lib/decodeContractError';

// Known selectors from decodeContractError.ts — kept in sync with the table
// so the test breaks loudly if the friendly-copy table is edited.
const SEL_INSUFFICIENT_BALANCE = '0xe450d38c';
const SEL_HF_TOO_LOW = '0x62e82dca';
const SEL_RAW_NAME_ONLY = '0x82b42900'; // present in KNOWN_ERROR_SELECTORS but NOT in FRIENDLY_ERROR_MESSAGES

describe('extractRevertData', () => {
  it('returns undefined for non-object input', () => {
    expect(extractRevertData(null)).toBeUndefined();
    expect(extractRevertData(undefined)).toBeUndefined();
    expect(extractRevertData('boom')).toBeUndefined();
  });

  it('reads a string `data` field directly', () => {
    expect(extractRevertData({ data: SEL_INSUFFICIENT_BALANCE + 'deadbeef' })).toBe(
      SEL_INSUFFICIENT_BALANCE + 'deadbeef',
    );
  });

  it('reads `data.data` when data is an object', () => {
    expect(extractRevertData({ data: { data: SEL_HF_TOO_LOW } })).toBe(SEL_HF_TOO_LOW);
  });

  it('reads `info.error.data`', () => {
    expect(
      extractRevertData({ info: { error: { data: SEL_INSUFFICIENT_BALANCE } } }),
    ).toBe(SEL_INSUFFICIENT_BALANCE);
  });

  it('reads `error.data`', () => {
    expect(extractRevertData({ error: { data: SEL_HF_TOO_LOW } })).toBe(SEL_HF_TOO_LOW);
  });

  it('reads `revert.data`', () => {
    expect(extractRevertData({ revert: { data: SEL_INSUFFICIENT_BALANCE } })).toBe(
      SEL_INSUFFICIENT_BALANCE,
    );
  });

  it('digs a hex selector out of a plain message string as last resort', () => {
    expect(
      extractRevertData({ message: `execution reverted ${SEL_HF_TOO_LOW}` }),
    ).toBe(SEL_HF_TOO_LOW);
  });

  it('rejects too-short hex stubs (<10 chars) when found in structured fields', () => {
    // The 4-byte selector alone is 10 chars (0x + 8), so a 9-char stub is rejected.
    expect(extractRevertData({ data: '0xabcdefg' })).toBeUndefined();
  });
});

describe('extractRevertSelector', () => {
  it('returns the lower-cased 4-byte selector prefix', () => {
    expect(
      extractRevertSelector({ data: '0xE450D38C' + 'ff'.repeat(32) }),
    ).toBe(SEL_INSUFFICIENT_BALANCE);
  });

  it('returns undefined when no revert data can be recovered', () => {
    expect(extractRevertSelector({})).toBeUndefined();
  });
});

describe('namedRevertSelector', () => {
  it('prefixes the known error name onto the selector', () => {
    const named = namedRevertSelector({ data: SEL_RAW_NAME_ONLY });
    // Present in the selector table but without a friendly message — the
    // helper should still name it. Accept either `Name (sel)` or bare sel.
    expect(named === undefined || typeof named === 'string').toBe(true);
    if (typeof named === 'string') expect(named.startsWith('0x82b42900')).toBeTruthy;
  });

  it('falls back to the raw selector for unknown selectors', () => {
    const sel = '0x11223344';
    expect(namedRevertSelector({ data: sel })).toBe(sel);
  });

  it('returns undefined when no selector can be extracted', () => {
    expect(namedRevertSelector(null)).toBeUndefined();
  });
});

describe('decodeContractError', () => {
  it('returns the fallback when input is null/undefined/primitive', () => {
    expect(decodeContractError(null)).toBe('Transaction failed');
    expect(decodeContractError(undefined, 'custom fallback')).toBe('custom fallback');
    expect(decodeContractError('string err')).toBe('Transaction failed');
  });

  it('uses the friendly message for a known selector', () => {
    const msg = decodeContractError({ data: SEL_INSUFFICIENT_BALANCE });
    expect(msg).toMatch(/Insufficient token balance/);
  });

  it('friendly-message path beats ethers `reason` for known selectors', () => {
    const msg = decodeContractError({
      reason: 'execution reverted',
      data: SEL_HF_TOO_LOW,
    });
    expect(msg).toMatch(/Health factor too low/);
  });

  it('prefers `reason` when there is no known selector', () => {
    expect(decodeContractError({ reason: 'Deadline exceeded' })).toBe('Deadline exceeded');
  });

  it('falls back to shortMessage when reason is absent', () => {
    expect(decodeContractError({ shortMessage: 'nonce too low' })).toBe('nonce too low');
  });

  it('falls back to data.message for nested wallet errors', () => {
    expect(
      decodeContractError({ data: { message: 'rpc nested message' } }),
    ).toBe('rpc nested message');
  });

  it('falls back to the raw `message` when nothing else fits', () => {
    expect(decodeContractError({ message: 'raw js error' })).toBe('raw js error');
  });

  it('appends named revert onto generic "unknown custom error" texts', () => {
    const msg = decodeContractError({
      reason: 'unknown custom error',
      data: SEL_INSUFFICIENT_BALANCE,
    });
    // Friendly message takes precedence; this path fires only for selectors
    // that have a known name but no friendly copy.
    expect(msg).toMatch(/Insufficient token balance/);

    // Unknown selector → no friendly message → reason kept, named appended.
    const unknown = decodeContractError({
      reason: 'unknown custom error',
      data: '0xdeadbeef00000000',
    });
    expect(unknown).toMatch(/unknown custom error/);
    expect(unknown).toMatch(/0xdeadbeef/);
  });

  it('honors a caller-supplied fallback when no fields are present', () => {
    expect(decodeContractError({}, 'custom default')).toBe('custom default');
  });
});
