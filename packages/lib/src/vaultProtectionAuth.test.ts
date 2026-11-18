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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import {
  RECOVERY_PROOF_TYPES,
  parseRecoveryProof,
  parseRecoveryRequest,
  recoveryProofAuth,
  recoveryProofParams,
  recoveryRequestParams,
  recoveryProofTypedData,
  type RecoveryProof,
} from './vaultProtectionAuth';

/** The contract's own type string, read from VaultProtectionBase.sol. */
function contractTypeString(constant: string): string {
  const src = readFileSync(
    fileURLToPath(new URL('../../../contracts/src/vault/VaultProtectionBase.sol', import.meta.url)),
    'utf8',
  );
  const m = new RegExp(`${constant}\\s*=\\s*keccak256\\(\\s*"([^"]*)"\\s*\\)`).exec(src);
  if (!m) throw new Error(`${constant} not found`);
  return m[1];
}

describe('recovery address proof (#3246 part 2)', () => {
  it('signs exactly the vault’s RecoveryProof type', () => {
    const derived =
      'RecoveryProof(' + RECOVERY_PROOF_TYPES.RecoveryProof.map((f) => `${f.type} ${f.name}`).join(',') + ')';
    expect(derived).toBe(contractTypeString('RECOVERY_PROOF_TYPEHASH'));
    expect(keccak256(stringToHex(derived))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('round-trips a signed proof through its link, and the signature recovers the recovery wallet', async () => {
    // A throwaway key generated for this test only.
    const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const req = {
      chainId: 84532,
      vault: '0x00000000000000000000000000000000000000b1' as const,
      account: '0x00000000000000000000000000000000000000a1' as const,
      diamond: '0x00000000000000000000000000000000000000d1' as const,
      nonce: 3n,
      expiry: 1_900_000_000n,
    };
    const sig = await wallet.signTypedData(recoveryProofTypedData(req));
    const proof: RecoveryProof = { ...req, recovery: wallet.address, sig };
    const back = parseRecoveryProof(new URLSearchParams(new URLSearchParams(recoveryProofParams(proof)).toString()));
    expect(back).not.toBeNull();
    expect(back!.recovery).toBe(wallet.address.toLowerCase());
    expect(back!.nonce).toBe(3n);
    expect(
      await recoverTypedDataAddress({ ...recoveryProofTypedData({ ...back! }), signature: back!.sig }),
    ).toBe(wallet.address);
    expect(hashTypedData(recoveryProofTypedData(req))).toMatch(/^0x/);
    expect(recoveryProofAuth(back!)).toEqual({ key: back!.recovery, expiry: 1_900_000_000n, sig });
  });

  it('round-trips the request link', () => {
    const req = {
      chainId: 84532,
      account: '0x00000000000000000000000000000000000000A1' as const,
      recovery: '0x00000000000000000000000000000000000000c1' as const,
    };
    const back = parseRecoveryRequest(new URLSearchParams(recoveryRequestParams(req)));
    expect(back).toEqual({ ...req, account: req.account.toLowerCase() });
  });

  it('refuses a link that is not a well-formed one', () => {
    expect(parseRecoveryProof(new URLSearchParams(''))).toBeNull();
    expect(parseRecoveryRequest(new URLSearchParams('rr_chain=1&rr_account=0x1&rr_recovery=0x2'))).toBeNull();
    const ok = {
      rp_chain: '1',
      rp_vault: '0x00000000000000000000000000000000000000b1',
      rp_account: '0x00000000000000000000000000000000000000a1',
      rp_diamond: '0x00000000000000000000000000000000000000d1',
      rp_recovery: '0x00000000000000000000000000000000000000c1',
      rp_nonce: '0',
      rp_expiry: '1',
      rp_sig: '0x00',
    };
    expect(parseRecoveryProof(new URLSearchParams(ok))).not.toBeNull();
    expect(parseRecoveryProof(new URLSearchParams({ ...ok, rp_vault: '0x1' }))).toBeNull();
    expect(parseRecoveryProof(new URLSearchParams({ ...ok, rp_expiry: (1n << 64n).toString() }))).toBeNull();
    expect(parseRecoveryProof(new URLSearchParams({ ...ok, rp_sig: 'zz' }))).toBeNull();
  });
});
