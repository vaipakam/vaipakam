/**
 * #1529 review round 21 — the page-RPC failure classifier.
 *
 * Extracted and tested rather than checked by hand, on round 20's
 * lesson: round 19 verified the predicate this replaces with a throwaway
 * script, and three bypasses shipped behind a comment claiming they were
 * covered.
 *
 * The errors here are shaped the way viem delivers them — the provider's
 * code and data on an INNER cause, reachable through `walk` — because
 * testing the top-level object is precisely the mistake round 20 found.
 */
import { describe, expect, it } from 'vitest';
import { classifyRpcFailure } from './rpc-verdict.mjs';

/** A viem-shaped wrapper: the useful fields sit on a cause, and `walk`
 *  is how viem exposes the chain. */
function viemError({ code, data } = {}) {
  const inner = { code, data };
  const err = new Error('rpc failed');
  err.cause = inner;
  err.walk = (fn) => (fn(err) ? err : fn(inner) ? inner : null);
  return err;
}

describe('classifyRpcFailure', () => {
  it('reads a revert off the error chain, not the top level', () => {
    expect(classifyRpcFailure(viemError({ code: 3 }))).toBe('answered');
  });

  it('accepts revert bytes carried under a provider-specific code', () => {
    // Some providers label a genuine revert -32000; the bytes decide.
    expect(
      classifyRpcFailure(viemError({ code: -32000, data: '0x7e273289' })),
    ).toBe('answered');
  });

  it('does not treat an empty 0x as revert bytes', () => {
    expect(classifyRpcFailure(viemError({ code: -32603, data: '0x' }))).toBe(
      'unreachable',
    );
  });

  it('calls invalid params a client fault, not an unreachable endpoint', () => {
    // The round-21 finding: the provider RECEIVED and rejected the page's
    // request. Filing this as "could not fetch" exits 2 and hides an app
    // defect behind an infrastructure verdict.
    expect(classifyRpcFailure(viemError({ code: -32602 }))).toBe('client-fault');
  });

  it('covers the other two malformed-request codes', () => {
    expect(classifyRpcFailure(viemError({ code: -32700 }))).toBe('client-fault');
    expect(classifyRpcFailure(viemError({ code: -32600 }))).toBe('client-fault');
  });

  it('leaves method-not-found as infrastructure', () => {
    // -32601 describes what the SERVER implements, not whether the
    // request was well formed. A provider lacking a method is a fact
    // about that endpoint, so it must not be blamed on the app.
    expect(classifyRpcFailure(viemError({ code: -32601 }))).toBe('unreachable');
  });

  it.each([
    ['rate limited', -32005],
    ['unavailable', -32002],
    ['internal', -32603],
  ])('keeps %s unreachable', (_label, code) => {
    expect(classifyRpcFailure(viemError({ code }))).toBe('unreachable');
  });

  it('treats a transport failure with no code as unreachable', () => {
    const err = new Error('fetch failed');
    expect(classifyRpcFailure(err)).toBe('unreachable');
  });

  it('survives an error with no walk at all', () => {
    expect(classifyRpcFailure({ code: -32602 })).toBe('client-fault');
    expect(classifyRpcFailure(undefined)).toBe('unreachable');
  });
});
