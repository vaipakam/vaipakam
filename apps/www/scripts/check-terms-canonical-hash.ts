/**
 * Guard: every published Terms version's FROZEN source matches its
 * registered fingerprint, and the current one matches the canonical
 * document (#1998, hardened per #2010 round 1).
 *
 * Why this exists
 * ---------------
 * `/terms/v<N>` exists so the connected app's acceptance gate can
 * link a wallet to the EXACT text its on-chain (version, hash) pair
 * pins. Each version's page renders `src/pages/terms/v<N>.md` — a
 * frozen byte-copy of the canonical `docs/Terms/TermsOfService.md`
 * at the commit that published the version — and displays its
 * keccak256 as the version's `canonicalMdKeccak256` fingerprint, the
 * derivation the governance runbook proposes for `setCurrentTos`.
 *
 * The first cut of this feature transcribed the document into JSX by
 * hand and hashed only the Markdown — and review found the
 * transcription had ALREADY drifted from the canonical text (#2010
 * round 1 P1): the guard was green while the pinned page showed a
 * different document than the one hashed. The page now renders the
 * frozen Markdown itself, and this guard pins the whole chain:
 *
 * 1. For EVERY registry entry: `src/pages/terms/v<N>.md` exists and
 *    keccak256(its bytes) equals the entry's `canonicalMdKeccak256`.
 *    The rendered text IS the frozen file, so this binds what the
 *    reader sees to the fingerprint the page publishes — for old
 *    versions too, which must never change after publication.
 * 2. No orphan `v*.md` exists without a registry entry — a frozen
 *    file the registry does not know is unreachable text waiting to
 *    confuse the next audit.
 * 3. The CURRENT (last) entry's frozen file is byte-identical to
 *    `docs/Terms/TermsOfService.md` — the working tree's canonical
 *    document and the published page cannot diverge while a version
 *    is current. (Older versions' canonical files are superseded in
 *    `docs/` by design; their frozen copies are the record.)
 * 4. Registry versions are unique and strictly ascending, so the
 *    "current = last entry" rule the pages rely on is sound.
 *
 * So a Terms edit that forgets the registry, a registry bump that
 * forgets the frozen file, or an edit to a published frozen file all
 * fail `pnpm --filter @vaipakam/www typecheck` — which CI runs for
 * `docs/Terms/` changes too (the workspaces change detector names
 * that path; #2010 round 1 P1) — instead of shipping a page whose
 * published fingerprint no longer covers its own text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import {
  CURRENT_TERMS_VERSION,
  TERMS_VERSION_METAS,
} from '../src/pages/terms/versions';

const here = dirname(fileURLToPath(import.meta.url));
const frozenDir = resolve(here, '../src/pages/terms');
const canonicalPath = resolve(here, '../../../docs/Terms/TermsOfService.md');

let failed = false;
const fail = (msg: string) => {
  console.error(`[check-terms-canonical-hash] FAIL: ${msg}`);
  failed = true;
};

// (4) Registry shape: unique, strictly ascending, last = current.
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

// (1) Every registry entry's frozen source exists and hashes to its
// registered fingerprint. The page renders these bytes, so this is
// the reader-sees ↔ fingerprint bond.
for (const meta of TERMS_VERSION_METAS) {
  const frozenPath = resolve(frozenDir, `v${meta.version}.md`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(frozenPath);
  } catch {
    fail(
      `v${meta.version} is registered but its frozen source ` +
        `${frozenPath} does not exist — the pinned route would render ` +
        `the not-published fallback for a version the registry claims`,
    );
    continue;
  }
  const computed = keccak256(bytes);
  if (computed !== meta.canonicalMdKeccak256) {
    fail(
      `v${meta.version}: registered fingerprint ${meta.canonicalMdKeccak256} ` +
        `does not match keccak256(${frozenPath}) = ${computed}. ` +
        (meta.version === CURRENT_TERMS_VERSION
          ? `If the Terms text changed, that is a NEW version: freeze the new ` +
            `text as v${meta.version + 1}.md, add its versions.ts entry, and ` +
            `take it through a governance version bump — never edit a ` +
            `published file or entry.`
          : `v${meta.version} is a PUBLISHED version — its frozen source must ` +
            `never change. Revert the edit.`),
    );
  }
}

// (2) No frozen source without a registry entry.
const registered = new Set(TERMS_VERSION_METAS.map((m) => `v${m.version}.md`));
for (const name of readdirSync(frozenDir)) {
  if (/^v\d+\.md$/.test(name) && !registered.has(name)) {
    fail(
      `${name} exists in ${frozenDir} but has no versions.ts entry — ` +
        `either register it or remove it`,
    );
  }
}

// (3) While a version is current, the canonical document and its
// frozen copy are the same bytes.
const canonicalBytes = readFileSync(canonicalPath);
const frozenCurrent = readFileSync(resolve(frozenDir, `v${last.version}.md`));
if (!canonicalBytes.equals(frozenCurrent)) {
  fail(
    `docs/Terms/TermsOfService.md is not byte-identical to the current ` +
      `frozen source v${last.version}.md. If the canonical text changed, ` +
      `that is a NEW version (freeze it as v${last.version + 1}.md + new ` +
      `registry entry + governance bump); if the frozen copy drifted, ` +
      `restore it from the canonical document.`,
  );
}

if (failed) process.exit(1);
console.log(
  `[check-terms-canonical-hash] OK — ${TERMS_VERSION_METAS.length} published ` +
    `version(s): every frozen source matches its registered fingerprint, and ` +
    `v${last.version} matches the canonical document byte for byte.`,
);
