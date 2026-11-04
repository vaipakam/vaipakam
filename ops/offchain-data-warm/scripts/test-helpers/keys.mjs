/**
 * Generated RSA-4096 key pairs for the archive-format tests (#1463). The
 * committed recipients' private keys are offline and never in a test, so a
 * test that decrypts uses keys made here, each in a set of its own.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';

/** A key pair and the recipient entry its public key would be committed as. */
export function testRecipient(name) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65537 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    recipient: { name, fingerprint: createHash('sha256').update(der).digest('hex'), spki: der.toString('base64') },
  };
}

/** A recipients file holding `sets`, each `{effectiveFrom, recipients}`. */
export function recipientsFile(sets) {
  return {
    kind: 'vaipakam-backup-recipients',
    version: 1,
    sets: sets.map((s, i) => ({ set: i + 1, effectiveFrom: s.effectiveFrom, recipients: s.recipients })),
  };
}
