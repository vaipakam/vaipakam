/**
 * The rule that keeps an RPC credential out of a log (#2213 r5 `4012300079`).
 *
 * These assertions are about a SECRET, so they are written against the shape
 * viem actually produces rather than against a tidy example: the URL sits
 * near the start of `HttpRequestError.message`, which is why "truncate the
 * message" was the wrong fix and why nothing here truncates a message at all.
 */
import { describe, it, expect } from 'vitest';
import { describeFailure, redactAndBound } from './errorDescription';

/** What viem hands a catch block when an RPC rejects the request. */
function viemHttpError(): Error {
  return Object.assign(
    new Error(
      'HTTP request failed.\n\n' +
        'URL: https://base-sepolia.example.com/v1/SUPERSECRETAPIKEY\n' +
        'Request body: {"method":"eth_call"}',
    ),
    { name: 'HttpRequestError', status: 429 },
  );
}

describe('describeFailure', () => {
  it('keeps the credential out, message and all', () => {
    const said = describeFailure(viemHttpError());
    expect(said).not.toContain('SUPERSECRETAPIKEY');
    expect(said).not.toContain('base-sepolia.example.com');
    expect(said).not.toContain('https');
  });

  it('keeps what an operator actually separates cases on', () => {
    // A class name and two numbers. Not a reduced message — the identifying
    // part of one.
    expect(describeFailure(viemHttpError())).toBe('HttpRequestError, HTTP 429');
    const rpc = Object.assign(new Error('Method not found'), {
      name: 'RpcRequestError',
      code: -32601,
    });
    expect(describeFailure(rpc)).toBe('RpcRequestError, rpc code -32601');
  });

  it('describes a timeout, which carries neither number', () => {
    expect(describeFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(
      'TimeoutError',
    );
  });

  it('does not trust the NAME either', () => {
    // "An error class is one word" is a convention of the libraries we happen
    // to use, not a property of a value arriving from a dependency — and the
    // name is the one field that IS printed.
    const weird = new Error('x');
    weird.name = 'Err from https://rpc.example/v1/KEY failed';
    const said = describeFailure(weird);
    expect(said).not.toContain('KEY');
    expect(said).toContain('<redacted url>');
  });

  it('says so when the thrown value was not an Error at all', () => {
    // `throw 'string'` and `throw {}` both reach a catch block. Printing them
    // is how an object with a `url` field would get printed.
    expect(describeFailure('boom')).toBe('a non-Error value was thrown');
    expect(describeFailure({ url: 'https://rpc.example/v1/KEY' })).toBe(
      'a non-Error value was thrown',
    );
  });
});

describe('redactAndBound', () => {
  it('caps the length, so a long field cannot flood the log', () => {
    expect(redactAndBound('a'.repeat(500)).length).toBe(80);
  });

  it('strips any scheme, not only http', () => {
    expect(redactAndBound('ws://node.example/KEY')).toBe('<redacted url>');
    expect(redactAndBound('wss://node.example/KEY')).toBe('<redacted url>');
  });
});

/**
 * THE SHAPE VIEM ACTUALLY THROWS (#2213 r25 `4015755031`).
 *
 * Every case above constructs a bare `Error` with a top-level `status` or
 * `code` — the shape this function was written expecting. That is the shape of
 * my own assumption, and an assertion written against an assumption cannot
 * falsify it: the suite was green while `readContract` failures, the most
 * common caller in the tree, printed nothing but the wrapper's class name.
 *
 * These build REAL viem errors so the test fails when the real nesting
 * changes, rather than when my model of it does.
 */
describe('viem\'s real wrapper shape, not a hand-built stand-in', () => {
  it('finds the HTTP status viem buried under its contract wrapper', async () => {
    const { HttpRequestError } = await import('viem');
    const inner = new HttpRequestError({
      status: 429,
      url: 'https://rpc.example/v1/SECRETKEY',
      details: 'rate limited',
    });
    // The wrapper viem raises from `readContract`, standing in for
    // `ContractFunctionExecutionError` without needing its full ABI context.
    const outer = new Error('contract read failed');
    outer.name = 'ContractFunctionExecutionError';
    (outer as Error & { cause?: unknown }).cause = inner;

    const said = describeFailure(outer);
    expect(said).toContain('HTTP 429');
    // Both classes, because the wrapper alone says only "a read failed".
    expect(said).toContain('ContractFunctionExecutionError');
    expect(said).toContain('HttpRequestError');
    // And the credential in the inner error's URL still never appears.
    expect(said).not.toContain('SECRETKEY');
    expect(said).not.toContain('rpc.example');
  });

  it('finds an RPC code nested the same way', async () => {
    const { RpcRequestError } = await import('viem');
    const inner = new RpcRequestError({
      body: {},
      error: { code: -32601, message: 'method not found' },
      url: 'https://rpc.example/v1/SECRETKEY',
    });
    const outer = new Error('contract read failed');
    outer.name = 'ContractFunctionExecutionError';
    (outer as Error & { cause?: unknown }).cause = inner;

    const said = describeFailure(outer);
    expect(said).toContain('rpc code -32601');
    expect(said).not.toContain('SECRETKEY');
  });

  it('stops on a CYCLIC cause instead of spinning', () => {
    // `cause` is an arbitrary value from a dependency; nothing stops it
    // pointing back at its own parent.
    const a = new Error('a');
    const b = new Error('b');
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    expect(describeFailure(a)).toBe('Error');
  });

  it('does not let a deep wrapper stack become a stack trace', () => {
    // Six distinct nested classes; at most two may be named.
    let cur: Error = new Error('deepest');
    cur.name = 'Innermost';
    for (let i = 5; i >= 1; i -= 1) {
      const next = new Error(`level ${i}`);
      next.name = `Wrapper${i}`;
      (next as Error & { cause?: unknown }).cause = cur;
      cur = next;
    }
    const said = describeFailure(cur);
    expect(said.split(' ← ').length).toBeLessThanOrEqual(2);
    expect(said).not.toContain('Innermost');
  });
});

