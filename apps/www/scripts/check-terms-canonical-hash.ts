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
 * 4. Registry versions are positive integers in the on-chain route
 *    domain (`setCurrentTos` takes a uint32, and
 *    `parseTermsVersionSlug` addresses only `v<positive integer>` —
 *    a fractional or out-of-range entry would publish a version the
 *    acceptance gate could never name; #2010 round 2 P2), unique and
 *    strictly ascending, so the "current = last entry" rule the
 *    pages rely on is sound.
 * 5. Each frozen source's OWN header (`**Version:** N` /
 *    `**Effective:** date`) matches its registry entry (#2010 round
 *    2 P1): hashing alone would pass a v2 file whose embedded header
 *    still says "Version 1" — a pinned page identifying itself as a
 *    different version than the one the gate asks the user to
 *    accept.
 * 6. Each frozen archive is a REGULAR file whose working-tree bytes
 *    equal its git-index blob (#2010 rounds 3+5 P2): a symlink, or a
 *    `.gitattributes` filter transforming the checkout, would let
 *    the rendered/hashed/deployed bytes drift from the blob the
 *    base-diff immutability step actually compares.
 *
 * So a Terms edit that forgets the registry, a registry bump that
 * forgets the frozen file, or an edit to a published frozen file all
 * fail `pnpm --filter @vaipakam/www typecheck` — which CI runs for
 * `docs/Terms/` changes too (the workspaces change detector names
 * that path; #2010 round 1 P1) — instead of shipping a page whose
 * published fingerprint no longer covers its own text.
 *
 * What this script deliberately does NOT do: prove a published
 * `v<N>.md` never changes across commits. Both sides of every
 * comparison here live in the same PR-editable tree, so a rewrite
 * that updates the file AND its registered hash together passes all
 * of the above. That immutability is enforced against the PR's BASE
 * by the "Published Terms archives are unchanged from the base" step
 * inside CI's REQUIRED `workspaces` job (#2010 rounds 2–3 P1), which
 * fails any pull request that modifies or deletes a `v<N>.md` that
 * already exists on the base branch.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
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

// (4) Registry shape: every version a positive integer within the
// uint32 domain `setCurrentTos` accepts and the `v<N>` route can
// address; unique, strictly ascending, last = current.
const UINT32_MAX = 0xffffffff;
for (const meta of TERMS_VERSION_METAS) {
  if (
    !Number.isInteger(meta.version) ||
    meta.version < 1 ||
    meta.version > UINT32_MAX
  ) {
    fail(
      `registry version ${meta.version} is outside the addressable domain — ` +
        `must be an integer in [1, 2^32-1]: LegalFacet.setCurrentTos takes a ` +
        `uint32 and parseTermsVersionSlug addresses only v<positive integer>, ` +
        `so this entry could never be named by the acceptance gate`,
    );
  }
}
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
  // A frozen archive must be a REGULAR file (#2010 round 3 P2): a
  // symlink hashes (and renders) its target's bytes, so it would pass
  // publication-time checks while the CI immutability job later sees
  // only the unchanged link path — a PR could then edit the TARGET and
  // silently change the "frozen" route without ever touching v<N>.md.
  // lstat (not stat) so the link itself is what gets judged.
  try {
    if (!lstatSync(frozenPath).isFile()) {
      fail(
        `v${meta.version}: ${frozenPath} is not a regular file — a frozen ` +
          `archive must hold its own bytes, never link to another file`,
      );
      continue;
    }
  } catch {
    fail(
      `v${meta.version} is registered but its frozen source ` +
        `${frozenPath} does not exist — the pinned route would render ` +
        `the not-published fallback for a version the registry claims`,
    );
    continue;
  }
  const bytes = readFileSync(frozenPath);
  // The WORKING-TREE bytes must equal the GIT-INDEX blob (#2010
  // round 5 P2): a later `.gitattributes` change (e.g. `eol=crlf` on
  // these paths) transforms the checkout — which is what the page
  // renders, this guard hashes, and the deploy ships — while the
  // blob and pathname the base-diff immutability step compares stay
  // untouched, so a registry-hash update alongside it would pass
  // every check while the deployed route publishes bytes different
  // from what existing acceptances recorded. Anchoring tree bytes to
  // the blob makes any checkout transform of a frozen archive loud.
  // A file git does not know yet (a NEW version being authored,
  // before `git add`) has no blob to compare — that state cannot
  // reach CI, whose checkout only contains committed files.
  const repoRelative = relative(resolve(here, '../../..'), frozenPath).replaceAll(
    '\\',
    '/',
  );
  try {
    const blob = execFileSync('git', ['show', `:${repoRelative}`], {
      cwd: resolve(here, '../../..'),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!blob.equals(bytes)) {
      fail(
        `v${meta.version}: the checked-out bytes of ${repoRelative} differ ` +
          `from its git blob — something (a .gitattributes filter such as ` +
          `eol, or an uncommitted edit) is transforming a frozen archive ` +
          `between the repository and the tree that gets rendered, hashed ` +
          `and deployed`,
      );
    }
  } catch {
    console.log(
      `[check-terms-canonical-hash] note: v${meta.version} is not in the ` +
        `git index yet (new version being authored) — blob anchoring is ` +
        `checked once it is added`,
    );
  }
  // (5) The document's own header must agree with the registry — a
  // byte-perfect copy of the WRONG version's text hashes fine, and a
  // page that says "Version 1" while the gate asks for version 2
  // defeats the whole point of the pinned route.
  const text = bytes.toString('utf8');
  const headerVersion = /^\*\*Version:\*\*\s+(\d+)\s*$/m.exec(text);
  const headerEffective = /^\*\*Effective:\*\*\s+(\S+)\s*$/m.exec(text);
  if (!headerVersion || Number(headerVersion[1]) !== meta.version) {
    fail(
      `v${meta.version}: the frozen source's own "**Version:**" header is ` +
        `${headerVersion ? headerVersion[1] : 'missing'} — it must state ` +
        `${meta.version}, the version its pinned route and registry entry ` +
        `identify it as`,
    );
  }
  if (!headerEffective || headerEffective[1] !== meta.effective) {
    fail(
      `v${meta.version}: the frozen source's own "**Effective:**" header is ` +
        `${headerEffective ? headerEffective[1] : 'missing'} — it must state ` +
        `${meta.effective}, the date its registry entry advertises`,
    );
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
