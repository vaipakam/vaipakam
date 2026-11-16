import { describe, expect, it } from 'vitest';
import { replacementArgs, VAULT_REPLACE } from './vaultProtectionAuth';

const NOMINEE = '0x00000000000000000000000000000000000000a1';

describe('replacementArgs', () => {
  it('names the live proposal’s nominee for an approval and a cancel (Codex #3489 r3)', () => {
    expect(replacementArgs('cancel', NOMINEE)).toEqual([VAULT_REPLACE.cancel, NOMINEE]);
    expect(replacementArgs('approve', NOMINEE)).toEqual([VAULT_REPLACE.approve, NOMINEE]);
    expect(replacementArgs('propose', NOMINEE)).toEqual([VAULT_REPLACE.propose, NOMINEE]);
  });
});
