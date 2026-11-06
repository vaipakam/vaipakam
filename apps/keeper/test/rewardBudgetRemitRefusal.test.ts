import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeErrorResult,
  parseAbi,
} from 'viem';
import {
  REMIT_REFUSAL_REPEAT_SEC,
  remitRefusal,
  remitRefusalKey,
  remitRefusalText,
} from '../src/rewardBudgetRemit';

/**
 * #3253 — a remit the Diamond refuses is retried every run, and on
 * 2026-11-06 an unfunded delivered-fresh bound refused every Base remit for
 * hours with nothing in the ops chat. These pin which failures alert.
 */
const ABI = parseAbi([
  'function remitRewardBudget(uint32 dstChainId, uint256[] dayIds, uint256 partCap) payable',
  'error DeliveredFreshBoundExceeded(uint256 fresh, uint256 remaining)',
  'error NothingToRemit()',
]);

function refused(errorName: 'DeliveredFreshBoundExceeded' | 'NothingToRemit', args: readonly bigint[] = []) {
  const data = encodeErrorResult({ abi: ABI, errorName, args: args as never });
  const cause = new ContractFunctionRevertedError({ abi: ABI, data, functionName: 'remitRewardBudget' });
  return new ContractFunctionExecutionError(cause, { abi: ABI, functionName: 'remitRewardBudget', args: [97, [1n], 1n] });
}

describe('remit refusal alert (#3253)', () => {
  it('alerts on the refusal seen on Base on 2026-11-06, with its figures', () => {
    const r = remitRefusal(refused('DeliveredFreshBoundExceeded', [41095890410960n, 0n]));
    expect(r).toEqual({ name: 'DeliveredFreshBoundExceeded', args: ['41095890410960', '0'] });
    const text = remitRefusalText(84532, 97, r!);
    expect(text).toContain('DeliveredFreshBoundExceeded(41095890410960, 0)');
    expect(text).toContain('84532 → 97');
    expect(text).toContain(`${REMIT_REFUSAL_REPEAT_SEC / 3600} h`);
  });

  it('does not alert on NothingToRemit, which a re-plan clears', () => {
    expect(remitRefusal(refused('NothingToRemit'))).toBeUndefined();
  });

  it('does not alert on a transport failure, which says nothing about the call', () => {
    const err = new HttpRequestError({ url: 'https://rpc.example/KEY', status: 503 });
    expect(remitRefusal(err)).toBeUndefined();
  });

  it('keys one standing refusal per lane', () => {
    expect(remitRefusalKey(84532, 97)).toBe('remit-refused/84532/97');
    expect(remitRefusalKey(84532, 421614)).not.toBe(remitRefusalKey(84532, 97));
  });
});
