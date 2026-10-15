import { describe, expect, it } from 'vitest';
import { createSubrequestBudget, SubrequestBudgetExhausted } from '../src/subrequestBudget';

describe('createSubrequestBudget', () => {
  it('passes requests through up to the limit, then refuses before any network call', async () => {
    let calls = 0;
    const inner = (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof fetch;
    const budget = createSubrequestBudget(2, inner);
    await budget.fetch('https://rpc.example');
    await budget.fetch('https://rpc.example');
    expect(budget.exhausted()).toBe(false);
    await expect(budget.fetch('https://rpc.example')).rejects.toBeInstanceOf(SubrequestBudgetExhausted);
    await expect(budget.fetch('https://rpc.example')).rejects.toBeInstanceOf(SubrequestBudgetExhausted);
    expect(calls).toBe(2);
    expect(budget.spent()).toBe(2);
    expect(budget.exhausted()).toBe(true);
  });

  it('charges a request that fails on the network: it was still made', async () => {
    const inner = (async () => {
      throw new Error('connection reset');
    }) as typeof fetch;
    const budget = createSubrequestBudget(1, inner);
    await expect(budget.fetch('https://rpc.example')).rejects.toThrow('connection reset');
    expect(budget.spent()).toBe(1);
    expect(budget.exhausted()).toBe(false);
    await expect(budget.fetch('https://rpc.example')).rejects.toBeInstanceOf(SubrequestBudgetExhausted);
  });
});
