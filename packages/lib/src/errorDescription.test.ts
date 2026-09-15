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
