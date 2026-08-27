import { describe, expect, it } from 'vitest';

import { redactUrl } from './redact.mjs';

/**
 * The live-review workflow pastes a drive's output into a public PR
 * thread, so anything this function lets through is published. Round 19
 * added the redaction and verified it with a throwaway script; round 20
 * found three provider key shapes it printed in full. These cases are
 * the shapes themselves, so the next unanticipated one is a test failure
 * rather than a leaked credential.
 */

const ALCHEMY = 'https://base-sepolia.g.alchemy.com/v2/kQ1bZ8xR4tYw7nM2pL9vC3sD6fH0jK5a';
const BLAST = 'https://base-sepolia.blastapi.io/12345678-9abc-def0-1234-56789abcdef0';
const CHAINSTACK = 'https://base-sepolia.core.chainstack.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SHORT_KEY = 'https://rpc.example.com/k/ab12cd34ef56';

describe('redactUrl — the RPC origin is handled categorically', () => {
  // The load-bearing case: whatever shape the key takes, a URL on the
  // RPC's own origin never prints its path. This is what makes the
  // function safe for a provider nobody has configured yet.
  for (const [name, url] of [
    ['alchemy path key', ALCHEMY],
    ['blast uuid key', BLAST],
    ['chainstack uuid key', CHAINSTACK],
    ['short hex key', SHORT_KEY],
  ]) {
    it(`discards the path for ${name} when it is the RPC`, () => {
      const origin = new URL(url).origin;
      const out = redactUrl(url, origin);
      expect(out).toBe(`${origin}/***`);
    });
  }

  it('masks a key even on an origin shape never seen before', () => {
    const url = 'https://rpc.made-up-provider.example/tenant/Zz9!weird~key';
    const origin = new URL(url).origin;
    expect(redactUrl(url, origin)).toBe(`${origin}/***`);
  });
});

describe('redactUrl — other hosts keep a legible path', () => {
  it('leaves an ordinary site path readable', () => {
    const url = 'https://app.vaipakam.com/positions/borrow/12';
    expect(redactUrl(url, 'https://sepolia.base.org')).toBe(url);
  });

  // Second-line defence: a non-RPC host might still carry a key.
  for (const [name, url, secret] of [
    ['alchemy-shaped', ALCHEMY, 'kQ1bZ8xR4tYw7nM2pL9vC3sD6fH0jK5a'],
    ['uuid-shaped', BLAST, '12345678-9abc-def0-1234-56789abcdef0'],
    ['uuid-shaped (chainstack)', CHAINSTACK, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
    ['short hex', SHORT_KEY, 'ab12cd34ef56'],
  ]) {
    it(`masks a ${name} segment on a third-party host`, () => {
      const out = redactUrl(url, 'https://sepolia.base.org');
      expect(out).not.toContain(secret);
      expect(out).toContain('***');
    });
  }
});

describe('redactUrl — credentials outside the path', () => {
  it('masks basic-auth credentials', () => {
    const out = redactUrl('https://user:s3cr3tpassword@rpc.example.com/', null);
    expect(out).not.toContain('s3cr3tpassword');
    expect(out).not.toContain('user');
  });

  it('masks query values but keeps the names', () => {
    const out = redactUrl('https://rpc.example.com/base?apikey=abcd1234efgh5678', null);
    expect(out).not.toContain('abcd1234efgh5678');
    expect(out).toContain('apikey=');
  });

  it('never echoes an unparseable url back', () => {
    expect(redactUrl('not a url at all ?key=secret', null)).toBe('(unparseable url)');
  });
});
