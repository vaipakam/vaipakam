/**
 * Guard: the Terms version registry's canonical-source hash matches
 * the canonical Markdown it claims to cover (#1998).
 *
 * Why this exists
 * ---------------
 * `/terms/v<N>` exists so the connected app's acceptance gate can
 * link a wallet to the EXACT text its on-chain (version, hash) pair
 * pins, and each published version's page displays a
 * `canonicalMdKeccak256` fingerprint — the keccak256 over the exact
 * committed bytes of `docs/Terms/TermsOfService.md` at the commit
 * that published the version, which is the derivation the governance
 * runbook proposes for `setCurrentTos`. That fingerprint is a
 * hand-written constant in `src/pages/terms/versions.ts`, and a
 * hand-written hash that nothing recomputes is correct only by
 * maintenance — the exact failure mode (#1612's drifting fee copies)
 * that this repo's other check scripts exist to close.
 *
 * What it checks
 * --------------
 * 1. The CURRENT (last) registry entry's `canonicalMdKeccak256`
 *    equals keccak256 of the working tree's
 *    `docs/Terms/TermsOfService.md`. Only the current entry: older
 *    versions' canonical files are superseded in `docs/` by design,
 *    and their frozen hashes are the historical record of what was
 *    published — nothing in the tree can (or should) re-derive them.
 * 2. Registry versions are unique and strictly ascending, so the
 *    "current = last entry" rule the pages rely on is sound.
 *
 * So a Terms edit that forgets the registry (or a registry bump that
 * forgets the canonical file) fails `pnpm --filter @vaipakam/www
 * typecheck` instead of shipping a page whose published fingerprint
 * no longer covers its own text.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import {
  CURRENT_TERMS_VERSION,
  TERMS_VERSION_METAS,
} from '../src/pages/terms/versions';

const here = dirname(fileURLToPath(import.meta.url));
const canonicalPath = resolve(here, '../../../docs/Terms/TermsOfService.md');

let failed = false;
const fail = (msg: string) => {
  console.error(`[check-terms-canonical-hash] FAIL: ${msg}`);
  failed = true;
};

// (2) Registry shape: unique, strictly ascending, last = current.
for (let i = 1; i < TERMS_VERSION_METAS.length; i++) {
  if (TERMS_VERSION_METAS[i]!.version <= TERMS_VERSION_METAS[i - 1]!.version) {
    fail(
      `registry versions must be strictly ascending — entry ${i} ` +
        `(v${TERMS_VERSION_METAS[i]!.version}) does not exceed entry ${i - 1} ` +
        `(v${TERMS_VERSION_METAS[i - 1]!.version})`,
    );
  }
}
const last = TERMS_VERSION_METAS[TERMS_VERSION_METAS.length - 1]!;
if (last.version !== CURRENT_TERMS_VERSION) {
  fail(
    `CURRENT_TERMS_VERSION (${CURRENT_TERMS_VERSION}) is not the last ` +
      `registry entry (v${last.version})`,
  );
}

// (1) The current entry's hash covers the canonical Markdown as it
// stands in the tree.
const canonicalBytes = readFileSync(canonicalPath);
const computed = keccak256(canonicalBytes);
if (computed !== last.canonicalMdKeccak256) {
  fail(
    `current Terms v${last.version}: registry hash ${last.canonicalMdKeccak256} ` +
      `does not match keccak256(${canonicalPath}) = ${computed}. ` +
      `If the canonical Terms text changed, that is a NEW version: add a ` +
      `frozen TermsV<N>Body, a new versions.ts entry with this hash, and a ` +
      `governance version bump — never edit a published entry.`,
  );
}

if (failed) process.exit(1);
console.log(
  `[check-terms-canonical-hash] OK — v${last.version} fingerprint matches ` +
    `the canonical Markdown (${TERMS_VERSION_METAS.length} published version(s)).`,
);
