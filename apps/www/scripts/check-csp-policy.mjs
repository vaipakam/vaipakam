#!/usr/bin/env node
/**
 * #43 (ET-017) — the marketing site's Content-Security-Policy, checked
 * before a build.
 *
 * `public/_headers` carries the policy. Its `script-src` must be exactly
 * `'self'` plus the placeholder the build replaces with the hashes of the
 * built page's inline boot scripts, no script directive may carry an
 * `unsafe` keyword, and the site may not be framed. Its `connect-src` must
 * be exactly `'self'` plus the placeholder the build replaces with the
 * indexer origin, so no scheme source (`https:`) can creep back in. And the
 * committed policy must complete against the real page and the default
 * origin: the boot script is found, and nothing of either placeholder is
 * left.
 *
 * What this cannot do is run the policy. No local step applies `_headers`;
 * the prerender checks every snapshot against the completed policy, and the
 * live check after a deploy reads the policy the host actually sends.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INDEXER_ORIGIN } from '../src/lib/indexerOrigin.ts';
import {
  CONNECT_SOURCES_PLACEHOLDER,
  applyConnectSources,
  policyConnectSources,
} from '@vaipakam/lib/cspConnectSources';
import {
  SCRIPT_HASHES_PLACEHOLDER,
  applyScriptHashes,
  inlineScriptBodies,
  policyScriptSources,
  scriptHashSources,
} from '@vaipakam/lib/cspScriptHashes';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headers = readFileSync(resolve(root, 'public', '_headers'), 'utf8');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

const problems = [];

/** Every directive of the one policy line, by name. */
const line = headers
  .split('\n')
  .map((l) => l.trim())
  .find((l) => l.startsWith('Content-Security-Policy:'));
const directives = new Map();
for (const part of (line ?? '').slice('Content-Security-Policy:'.length).split(';')) {
  const [name, ...values] = part.trim().split(/\s+/);
  if (name) directives.set(name, values);
}

const scriptSrc = policyScriptSources(headers);
if (JSON.stringify(scriptSrc) !== JSON.stringify(["'self'", SCRIPT_HASHES_PLACEHOLDER])) {
  problems.push(
    `script-src must be exactly 'self' ${SCRIPT_HASHES_PLACEHOLDER}; found ${scriptSrc.join(' ')}`,
  );
}
for (const [name, values] of directives) {
  if (!name.startsWith('script-src')) continue;
  const unsafe = values.filter((v) => /unsafe/i.test(v));
  if (unsafe.length > 0) problems.push(`${name} carries ${unsafe.join(' ')}`);
}
const connectSrc = policyConnectSources(headers);
if (JSON.stringify(connectSrc) !== JSON.stringify(["'self'", CONNECT_SOURCES_PLACEHOLDER])) {
  problems.push(
    `connect-src must be exactly 'self' ${CONNECT_SOURCES_PLACEHOLDER}; found ${connectSrc.join(' ')}`,
  );
}
if (JSON.stringify(directives.get('frame-ancestors')) !== JSON.stringify(["'none'"])) {
  problems.push(`frame-ancestors must be 'none'; found ${(directives.get('frame-ancestors') ?? []).join(' ')}`);
}

// Calibration against the real page: the theme and language boot script is
// found. An extractor that stopped finding it would produce an empty hash
// list and a policy that blocks it.
const bodies = inlineScriptBodies(indexHtml);
if (bodies.length !== 1 || !bodies[0].includes('vaipakam_lang')) {
  problems.push(
    `expected one inline boot script (theme, language) in index.html; found ${bodies.length}`,
  );
}
try {
  const built = applyConnectSources(
    applyScriptHashes(headers, scriptHashSources(indexHtml)),
    [DEFAULT_INDEXER_ORIGIN],
  );
  if (built.includes(SCRIPT_HASHES_PLACEHOLDER) || built.includes(CONNECT_SOURCES_PLACEHOLDER)) {
    problems.push('the completed policy still carries a placeholder');
  }
} catch (err) {
  problems.push(err.message);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[csp-policy] ${p}`);
  process.exit(1);
}
console.log(
  `[csp-policy] ok: scripts 'self' plus ${bodies.length} boot-script hash, no unsafe keyword;` +
    ` connect 'self' plus the build's indexer origin; not frameable`,
);
