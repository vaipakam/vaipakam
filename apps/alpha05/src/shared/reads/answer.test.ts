import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { answerOrNull, isContractAnswer } from './answer';

const revert = () => new ContractFunctionRevertedError({ abi: [], functionName: 'getLoanDetails' });
const outage = () => new ContractFunctionExecutionError(new HttpRequestError({ url: 'https://rpc.example', status: 429 }), { abi: [], functionName: 'getLoanDetails' });

describe('a contract read with no answer', () => {
  it('reads a revert as the contract’s answer, and nothing else', () => {
    expect(isContractAnswer(revert())).toBe(true);
    expect(isContractAnswer(outage())).toBe(false);
    expect(isContractAnswer(new Error('plain'))).toBe(false);
  });

  it('returns the value, null for a revert, and throws a failed source so the rail moves on', async () => {
    await expect(answerOrNull(Promise.resolve(7))).resolves.toBe(7);
    await expect(answerOrNull(Promise.reject(revert()))).resolves.toBeNull();
    await expect(answerOrNull(Promise.reject(outage()))).rejects.toBeInstanceOf(ContractFunctionExecutionError);
  });
});
