/**
 * The erasure message's format is FROZEN (#2002): every signature
 * ever collected was made over these exact bytes, and the agent
 * Worker reconstructs the message verbatim to recover the signer —
 * a drifted character rejects every request. Pinned verbatim so any
 * edit to the builder fails here first.
 */
import { describe, expect, it } from 'vitest';
import { buildErasureMessage } from './erasureMessage';

describe('buildErasureMessage', () => {
  it('produces the frozen byte sequence, verbatim', () => {
    expect(
      buildErasureMessage('0x1DAefA360ED370285f003Fa2d92DB75628088282', 1747000000),
    ).toBe(
      'Vaipakam — Erase my error-diagnostics records\n' +
        '\n' +
        'I request erasure of the server-side error-capture records\n' +
        'associated with the wallet below. Signing this message proves\n' +
        'ownership of the wallet. It is not a transaction and costs no gas.\n' +
        '\n' +
        'Wallet: 0x1daefa360ed370285f003fa2d92db75628088282\n' +
        'Issued at (unix): 1747000000',
    );
  });

  it('lower-cases the wallet so checksummed and lowercase spellings sign identically', () => {
    const a = buildErasureMessage('0x1DAefA360ED370285f003Fa2d92DB75628088282', 1);
    const b = buildErasureMessage('0x1daefa360ed370285f003fa2d92db75628088282', 1);
    expect(a).toBe(b);
  });
});
