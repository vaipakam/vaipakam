/**
 * The decoder's behavioural suite (#1964).
 *
 * These cases lived in `apps/defi/test/lib/decodeContractError.test.ts`
 * and were deleted with that app in #1854 without being ported, while
 * `apps/app` went on consuming every function they covered. For a
 * while they were the ONLY coverage of `extractRevertData`,
 * `extractRevertSelector`, `namedRevertSelector`, the decoder's
 * fallback precedence, cause-chain walking, the #780 gas-cap branches
 * and most friendly-error paths — the two suites that survived here
 * (`.drift` and `.i18n`) are deliberately narrower. Wallet-specific
 * revert extraction could regress and pass the gate.
 *
 * They belong in this package: the logic never moved, only the test
 * did. Nothing here encoded app-specific wiring, so the port is the
 * import path plus the `namedRevertSelector` fixes noted below.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeContractError,
  extractRevertData,
  extractRevertSelector,
  namedRevertSelector,
  friendlyContractError,
  humanizeErrorName,
  KNOWN_ERROR_SELECTORS,
} from './decodeContractError';

// Known selectors from decodeContractError.ts — kept in sync with the table
// so the test breaks loudly if the friendly-copy table is edited.
const SEL_INSUFFICIENT_BALANCE = '0xe450d38c';
const SEL_HF_TOO_LOW = '0x62e82dca';

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

  // #2017 round 2 P2: "last resort" was only asserted by ABSENCE — with no
  // structured bytes present, the case passes even if the message regex is
  // consulted FIRST. A wallet that keeps the authoritative payload in a
  // structured field while its wrapper message quotes a different
  // selector-shaped blob is the shape that breaks: the wrong error would
  // be chosen and unrelated friendly copy shown. Each structured candidate
  // is therefore raced against a competing message blob.
  it('prefers every structured candidate OVER a selector in the message', () => {
    const decoy = `execution reverted ${SEL_INSUFFICIENT_BALANCE}`;
    expect(extractRevertData({ data: SEL_HF_TOO_LOW, message: decoy })).toBe(
      SEL_HF_TOO_LOW,
    );
    expect(
      extractRevertData({ data: { data: SEL_HF_TOO_LOW }, message: decoy }),
    ).toBe(SEL_HF_TOO_LOW);
    expect(
      extractRevertData({ info: { error: { data: SEL_HF_TOO_LOW } }, message: decoy }),
    ).toBe(SEL_HF_TOO_LOW);
    expect(extractRevertData({ error: { data: SEL_HF_TOO_LOW }, message: decoy })).toBe(
      SEL_HF_TOO_LOW,
    );
    expect(extractRevertData({ revert: { data: SEL_HF_TOO_LOW }, message: decoy })).toBe(
      SEL_HF_TOO_LOW,
    );
    expect(extractRevertData({ raw: SEL_HF_TOO_LOW, message: decoy })).toBe(
      SEL_HF_TOO_LOW,
    );
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
  it('prefixes the known error signature onto the selector', () => {
    // Ported with a REAL assertion (#1964). The original asserted
    // `named === undefined || typeof named === 'string'` — a tautology —
    // and then `expect(...).toBeTruthy` without calling it, so the case
    // could never fail. It also named `0x82b42900` as "present in
    // KNOWN_ERROR_SELECTORS", which is no longer true; nothing noticed,
    // because nothing was being checked.
    //
    // The selector is taken FROM the table so this cannot go stale the
    // same way, while the format — `<signature> (<selector>)` — is what
    // the case actually pins.
    const [selector, signature] = Object.entries(KNOWN_ERROR_SELECTORS)[0]!;
    expect(namedRevertSelector({ data: selector })).toBe(
      `${signature} (${selector})`,
    );
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

  // #2017 round 1 P2: the four cases above each supply ONE candidate
  // field, so a reordered chain (shortMessage ahead of reason, say)
  // would leave every one of them green. Precedence is only actually
  // pinned by inputs where the candidates COMPETE — each stage below
  // removes the winner and asserts the next one takes over.
  it('resolves the fallback chain in order when the fields compete', () => {
    const all = {
      reason: 'from reason',
      shortMessage: 'from shortMessage',
      data: { message: 'from data.message' },
      message: 'from message',
    };
    expect(decodeContractError(all, 'from fallback')).toBe('from reason');

    const { reason: _r, ...noReason } = all;
    expect(decodeContractError(noReason, 'from fallback')).toBe('from shortMessage');

    const { shortMessage: _s, ...noShort } = noReason;
    expect(decodeContractError(noShort, 'from fallback')).toBe('from data.message');

    const { data: _d, ...noData } = noShort;
    expect(decodeContractError(noData, 'from fallback')).toBe('from message');

    const { message: _m, ...noMessage } = noData;
    expect(decodeContractError(noMessage, 'from fallback')).toBe('from fallback');
  });

  it('lets a known selector\u2019s friendly copy beat every text field', () => {
    // The friendly path returns BEFORE the chain is consulted, so the
    // richest competing input must still surface curated copy.
    expect(
      decodeContractError({
        data: SEL_HF_TOO_LOW,
        reason: 'from reason',
        shortMessage: 'from shortMessage',
        message: 'from message',
      }),
    ).toMatch(/Health factor too low/i);
  });

  // #2017 round 2 P2: the case above carries a STRING `data`, so it cannot
  // also carry the `data.message` competitor — and a regression narrowing
  // the decoder to top-level string selectors would leave it green while
  // injected wallets (which nest the payload) showed the raw RPC message
  // instead of curated guidance. This is that shape, with every competing
  // field present and the exact curated copy asserted.
  it('decodes a NESTED selector ahead of the sibling data.message', () => {
    expect(
      decodeContractError({
        data: { data: SEL_HF_TOO_LOW, message: 'rpc message' },
        reason: 'from reason',
        shortMessage: 'from shortMessage',
        message: 'from message',
      }),
    ).toBe('Health factor too low. Add collateral to bring it above 1.5.');
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

    // #2017 round 1 P2: the case above returns through the friendly-copy
    // path before the `!sel` guard is ever evaluated, so deleting that
    // guard would leave it green. This is the input that actually
    // reaches it — a gas-cap message carrying a concrete selector the
    // local tables do not know. The selector proves a real revert was
    // decoded, so the misleading rewrite must be suppressed even though
    // there is no friendly copy to show instead.
    it('suppresses the rewrite for an UNKNOWN selector too — the guard itself', () => {
      const msg = decodeContractError({
        message: 'execution reverted: exceeds max transaction gas limit',
        data: '0xdeadbeef' + 'ff'.repeat(32),
      });
      expect(msg).not.toMatch(/could not estimate/i);
      expect(msg).not.toMatch(/NOT a real gas shortage/i);
      // The untouched base message is what surfaces.
      expect(msg).toBe('execution reverted: exceeds max transaction gas limit');
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

    // #2017 round 2 P2: `extractRevertName` excludes BOTH generic shapes,
    // but only `Error` was exercised — dropping `Panic` from that guard
    // left every case green while a Panic revert humanized to the useless
    // string "Panic", hiding the diagnostic the base message carries.
    it('keeps the base message for a generic Panic revert', () => {
      expect(
        decodeContractError({
          revert: { name: 'Panic' },
          reason: 'arithmetic underflow or overflow',
        }),
      ).toBe('arithmetic underflow or overflow');
      // Same exclusion through viem's cause-chain spelling.
      expect(
        decodeContractError({
          cause: { data: { errorName: 'Panic' } },
          reason: 'division by zero',
        }),
      ).toBe('division by zero');
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
    // #2017 round 1 P2: `/Health factor too low/i` alone proves nothing
    // here — that is EXACTLY what `HealthFactorTooLow` humanizes to, so
    // dropping the curated message (or resolving the name ahead of the
    // selector) would keep the old assertion green while silently losing
    // the actionable half. The curated copy's ADVICE is the part worth
    // pinning, and it cannot come from humanizing a name.
    expect(viaSelector).toBe('Health factor too low. Add collateral to bring it above 1.5.');
    expect(viaSelector).toMatch(/add collateral/i);
    expect(viaSelector).not.toBe(humanizeErrorName('HealthFactorTooLow'));
    // Identical to what the write-path decoder surfaces for that selector,
    // so the dry-run footer and the submit banner speak one voice.
    expect(viaSelector).toBe(decodeContractError({ data: SEL_HF_TOO_LOW }));
  });

  it('lets the SELECTOR win when a conflicting name is supplied', () => {
    // The resolution order is the point: a caller passing a name that
    // disagrees with the selector must still get the selector's curated
    // guidance, not the other error's copy or a humanized fallback.
    expect(
      friendlyContractError({
        name: 'MaxLendingAboveCeiling',
        selector: SEL_HF_TOO_LOW,
      }),
    ).toBe('Health factor too low. Add collateral to bring it above 1.5.');
  });

  it('returns null when nothing identifies the error', () => {
    expect(friendlyContractError({})).toBeNull();
    expect(friendlyContractError({ selector: '0x00000000' })).toBeNull();
  });
});
