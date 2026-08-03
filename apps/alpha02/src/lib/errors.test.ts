/**
 * The contract-revert copy is owned (in English) by @vaipakam/lib, but must
 * localize on the alpha02 frontend: `submitErrorText` passes lib a `translate`
 * hook that resolves `contractError.<stableKey>` from the active locale bundle,
 * falling back to the lib English when a locale hasn't translated that key.
 * This pins that wiring — the same access-time-resolution contract the copy
 * proxy has (see reactiveCopy.test.ts).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import i18n from 'i18next';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  IntegerOutOfRangeError,
  TimeoutError,
} from 'viem';
import { isContractAnswered, submitErrorText } from './errors';

// A revert carrying only the decoded error NAME (no selector bytes) — the
// decoder keys it by the name, which is what the locale bundle mirrors.
const MAX_LENDING_REVERT = { revert: { name: 'MaxLendingAboveCeiling' } };

describe('submitErrorText — localized contract errors', () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }
  });

  it('serves the lib English by default (no locale override present)', () => {
    expect(submitErrorText(MAX_LENDING_REVERT)).toMatch(/collateral is too low/i);
  });

  it('lets a locale bundle override the message by its stable key', async () => {
    i18n.addResourceBundle('es', 'translation', {
      contractError: { MaxLendingAboveCeiling: 'Tu garantía es demasiado baja.' },
    });
    await i18n.changeLanguage('es');
    expect(submitErrorText(MAX_LENDING_REVERT)).toBe('Tu garantía es demasiado baja.');

    // A key the locale hasn't translated still falls back to lib English.
    const untranslated = submitErrorText({ revert: { name: 'PartialRepayNotAllowed' } });
    expect(untranslated).toMatch(/allow partial repayment/i);

    await i18n.changeLanguage('en');
    expect(submitErrorText(MAX_LENDING_REVERT)).toMatch(/collateral is too low/i);
  });
});

/**
 * `isContractAnswered` is the discriminator every OPTIONAL read uses to
 * decide whether its fallback is safe (Codex #1547 r15/r16) — the
 * stuck-token recovery form's `symbol()` / `decimals()` reads today.
 *
 * The two directions are asymmetric on purpose and BOTH are load-bearing:
 *  - a legacy `bytes32` symbol (MKR and friends) fails to DECODE something
 *    the node answered, and must read as "metadata unavailable" so the
 *    token stays recoverable behind the short-address fallback;
 *  - anything the node did NOT answer must not, because reading it as
 *    "this token has no decimals" once let an 18-decimal token parse as
 *    raw base units — a user typing `1` would sign for one base unit.
 *
 * The POSITIVE shape (recognise a contract answer, default unreadable)
 * is itself load-bearing: r15 used a denylist of transport names and
 * that silently re-opened the r10 bug, because viem also reports
 * node-side failures as RpcRequestError / InternalRpcError /
 * LimitExceededRpcError / ResourceUnavailableRpcError. The unknown-name
 * case below pins the safe default.
 *
 * Built from REAL viem errors rather than hand-shaped objects, so the
 * name list is pinned against the library it classifies.
 */
describe('isContractAnswered — optional-read fallback discriminator', () => {
  const execError = (cause: BaseError) =>
    new ContractFunctionExecutionError(cause, {
      abi: [],
      functionName: 'symbol',
    });

  it('accepts a bytes32 symbol() — the decoder failed, not the node', () => {
    const decodeFailure = new IntegerOutOfRangeError({
      max: '1',
      min: '0',
      signed: false,
      size: 32,
      value: '2',
    });
    expect(isContractAnswered(execError(decodeFailure))).toBe(true);
  });

  it('accepts the contract-level absences (revert / zero data)', () => {
    expect(
      isContractAnswered(
        execError(new ContractFunctionZeroDataError({ functionName: 'symbol' })),
      ),
    ).toBe(true);
  });

  it('rejects a transport failure however deeply it is wrapped', () => {
    const http = new HttpRequestError({ url: 'https://rpc.example', details: 'boom' });
    expect(isContractAnswered(http)).toBe(false);
    expect(isContractAnswered(execError(http))).toBe(false);
    // The shape a real read produces: contract -> call -> transport.
    expect(
      isContractAnswered({
        name: 'ContractFunctionExecutionError',
        cause: { name: 'CallExecutionError', cause: http },
      }),
    ).toBe(false);
    expect(
      isContractAnswered(new TimeoutError({ body: {}, url: 'https://rpc.example' })),
    ).toBe(false);
  });

  it('rejects node-side JSON-RPC failures — the r16 regression', () => {
    // A rate limit / unavailable resource / internal node error is NOT a
    // contract answer; the r15 denylist let all of these through.
    for (const name of [
      'RpcRequestError',
      'InternalRpcError',
      'LimitExceededRpcError',
      'ResourceUnavailableRpcError',
    ]) {
      expect(
        isContractAnswered({
          name: 'ContractFunctionExecutionError',
          cause: { name: 'CallExecutionError', cause: { name } },
        }),
      ).toBe(false);
    }
  });

  it('defaults to unreadable for anything it does not recognise', () => {
    // The safe default: an unknown failure is NOT license to take a
    // metadata fallback.
    expect(isContractAnswered(new Error('reverted'))).toBe(false);
    expect(isContractAnswered({ name: 'SomeFutureViemError' })).toBe(false);
    expect(isContractAnswered(null)).toBe(false);
    expect(isContractAnswered(undefined)).toBe(false);
    expect(isContractAnswered('HttpRequestError')).toBe(false);
  });

  it('a node failure vetoes even when a contract-shaped name is also present', () => {
    expect(
      isContractAnswered({
        name: 'ContractFunctionZeroDataError',
        cause: { name: 'LimitExceededRpcError' },
      }),
    ).toBe(false);
  });
});
