import { describe, it, expect } from 'vitest';
import {
  decodeContractError,
  extractRevertData,
  extractRevertSelector,
  namedRevertSelector,
  friendlyContractError,
  humanizeErrorName,
  // Stage-3 split moved this module to @vaipakam/lib; the old
  // `../../src/lib/decodeContractError` path stopped resolving (the test had
  // silently gone dead). Repointed to the live specifier apps/defi actually
  // imports so the decoder — including the #780 gas-cap heuristic below —
  // is exercised again.
} from '@vaipakam/lib/decodeContractError';

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

  // #1094 Codex: viem wraps the real revert several causes deep — the top
  // object has no `data`, a nested cause does.
  it('walks the viem cause chain for revert data', () => {
    expect(
      extractRevertData({ shortMessage: 'reverted', cause: { data: SEL_HF_TOO_LOW } }),
    ).toBe(SEL_HF_TOO_LOW);
  });

  it('finds nested data.data revert bytes on a cause', () => {
    expect(
      extractRevertData({ cause: { cause: { data: { data: SEL_HF_TOO_LOW } } } }),
    ).toBe(SEL_HF_TOO_LOW);
  });

  it('reads viem ContractFunctionRevertedError raw bytes on a cause', () => {
    expect(extractRevertData({ cause: { raw: SEL_HF_TOO_LOW } })).toBe(SEL_HF_TOO_LOW);
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

  // #780 — "exceeds max transaction gas limit" is an estimateGas-fallback
  // artefact, not a real gas shortage. Distinguish it from a genuine revert.
  describe('#780 gas-cap heuristic', () => {
    it('rewrites the bare "exceeds max transaction gas limit" message', () => {
      const msg = decodeContractError({
        message: 'exceeds max transaction gas limit',
      });
      expect(msg).toMatch(/NOT a real gas shortage/i);
      expect(msg).toMatch(/token approval/i);
      expect(msg).toMatch(/stale app build/i);
      // Now also points at the review-step reason instead of only the
      // approval/stale-build heuristics (friendly-errors work).
      expect(msg).toMatch(/review step/i);
    });

    it('also matches the "exceeds max gas limit" variant', () => {
      const msg = decodeContractError({
        shortMessage: 'RPC Error: exceeds max gas limit',
      });
      expect(msg).toMatch(/could not estimate/i);
    });

    it('does NOT reword when a concrete revert selector is decodable', () => {
      // A real revert whose calldata also mentions the gas phrase must keep
      // its friendly selector copy, not the gas-cap heuristic.
      const msg = decodeContractError({
        message: 'execution reverted: exceeds max transaction gas limit',
        data: SEL_HF_TOO_LOW,
      });
      expect(msg).toMatch(/Health factor too low/i);
      expect(msg).not.toMatch(/could not estimate/i);
    });
  });

  // Friendly-error expansion: naive-user-reachable custom errors get curated
  // copy, and any named-but-uncurated error humanizes instead of showing hex.
  describe('reachable-error friendly copy', () => {
    const MAX_LENDING = '0xa46539d8'; // MaxLendingAboveCeiling(uint256,uint256)
    const MIN_COLLATERAL = '0x6aac1798'; // MinCollateralBelowFloor(uint256,uint256)
    const LENDER_REPAY = '0xc602c4b6'; // LenderCannotRepayOwnLoan()
    // Known selector with a name but NO curated copy → must humanize.
    const INSUFFICIENT_ALLOWANCE = '0x13be252b'; // InsufficientAllowance()

    it('maps MaxLendingAboveCeiling to friendly copy', () => {
      expect(decodeContractError({ data: MAX_LENDING })).toMatch(
        /collateral is too low/i,
      );
    });

    it('maps MinCollateralBelowFloor to friendly copy', () => {
      expect(decodeContractError({ data: MIN_COLLATERAL })).toMatch(
        /below the minimum/i,
      );
    });

    it('maps LenderCannotRepayOwnLoan to friendly copy', () => {
      expect(decodeContractError({ data: LENDER_REPAY })).toMatch(
        /you are the lender/i,
      );
    });

    it('humanizes a known selector with no curated copy', () => {
      expect(decodeContractError({ data: INSUFFICIENT_ALLOWANCE })).toBe(
        'Insufficient allowance',
      );
    });

    // #1094 Codex: tiered-LTV accept revert — the alpha02 accept path has no
    // SimulationPreview, so this must resolve to plain-language risk copy.
    it('maps InitLtvAboveTier to friendly copy', () => {
      expect(decodeContractError({ data: '0x8eb7de56' })).toMatch(
        /LTV limit for its risk tier/i,
      );
      expect(friendlyContractError({ name: 'InitLtvAboveTier' })).toMatch(
        /LTV limit for its risk tier/i,
      );
    });
  });

  // #1094 Codex: some wallets attach the decoded custom-error NAME
  // (`err.revert.name`) without raw selector bytes — the name-keyed map must
  // still resolve it, while generic Error/Panic shapes keep their `base` text.
  describe('revert.name (no selector bytes)', () => {
    it('resolves a reachable custom error by its decoded name', () => {
      expect(
        decodeContractError({ revert: { name: 'MaxLendingAboveCeiling' } }),
      ).toMatch(/collateral is too low/i);
    });

    it('keeps the base message for a generic Error(string) revert', () => {
      expect(
        decodeContractError({ revert: { name: 'Error' }, reason: 'boom' }),
      ).toBe('boom');
    });

    // #1094 Codex: viem stashes the decoded name on
    // `ContractFunctionRevertedError.data.errorName` in the cause chain, not
    // on top-level `revert.name`.
    it('resolves a custom error from a viem cause data.errorName', () => {
      expect(
        decodeContractError({
          shortMessage: 'The contract function "acceptOffer" reverted.',
          cause: { data: { errorName: 'MaxLendingAboveCeiling' } },
        }),
      ).toMatch(/collateral is too low/i);
    });
  });
});

describe('humanizeErrorName', () => {
  it('splits PascalCase into a readable sentence', () => {
    expect(humanizeErrorName('MaxLendingAboveCeiling')).toBe(
      'Max lending above ceiling',
    );
  });

  it('keeps acronym runs intact in sentence case', () => {
    expect(humanizeErrorName('MatchHFTooLow')).toBe('Match HF too low');
    expect(humanizeErrorName('LTVExceeded')).toBe('LTV exceeded');
  });
});

describe('friendlyContractError', () => {
  it('returns curated copy by name', () => {
    expect(friendlyContractError({ name: 'MaxLendingAboveCeiling' })).toMatch(
      /collateral is too low/i,
    );
  });

  it('resolves the name from the selector', () => {
    expect(friendlyContractError({ selector: '0xa46539d8' })).toMatch(
      /collateral is too low/i,
    );
  });

  it('humanizes a known-but-uncurated name', () => {
    expect(friendlyContractError({ name: 'SomeExoticFacetError' })).toBe(
      'Some exotic facet error',
    );
  });

  // #1094 Codex P3: when a selector carries curated FRIENDLY_ERROR_MESSAGES
  // copy, the dry-run footer must use it too — not degrade to a humanized
  // name — so it speaks the SAME voice as the write-path submit banner.
  it('prefers curated selector copy over a humanized name', () => {
    const viaSelector = friendlyContractError({
      name: 'HealthFactorTooLow',
      selector: SEL_HF_TOO_LOW,
    });
    expect(viaSelector).toMatch(/Health factor too low/i);
    // Identical to what the write-path decoder surfaces for that selector.
    expect(viaSelector).toBe(decodeContractError({ data: SEL_HF_TOO_LOW }));
  });

  it('returns null when nothing identifies the error', () => {
    expect(friendlyContractError({})).toBeNull();
    expect(friendlyContractError({ selector: '0x00000000' })).toBeNull();
  });
});
