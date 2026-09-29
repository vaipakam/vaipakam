/**
 * Custom-error selector -> signature, with no chain dependency.
 *
 * Lives apart from `errors.mjs` because BOTH sides need it and only one of
 * them can talk to the node: `errors.mjs` decodes a simulated call's revert,
 * and `chain.mjs`'s `tx()` decodes a *sent* transaction's. Keeping the lookup
 * here is what lets `tx()` use it without importing the RPC module that
 * imports this one back.
 *
 * That split is the point. The decoder used to live only on the simulate
 * path, so a state-changing call that reverted came back as raw hex — and a
 * scenario that can only report `0x5c9e11e8` cannot tell an expected refusal
 * from a defect, which is the whole reason the decoding exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAbiParameters, toFunctionSelector } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI_DIR = path.resolve(HERE, '../../../../packages/contracts/src/abis');
const SRC_DIR = path.resolve(HERE, '../../../src');

/** selector -> `ErrorName(type,type)` across the whole exported ABI surface. */
export const ERROR_INDEX = (() => {
  const index = {};
  for (const file of fs.readdirSync(ABI_DIR).filter((f) => f.endsWith('.json'))) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(ABI_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (entry.type !== 'error') continue;
      const sig = `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(',')})`;
      try {
        index[toFunctionSelector(sig)] = sig;
      } catch {
        /* unencodable signature — skip */
      }
    }
  }
  return index;
})();

/**
 * Fallback: scan the Solidity SOURCE for an `error` declaration matching a
 * selector the exported ABIs do not carry. The export covers the facets an
 * app consumes, which is a subset of the Diamond.
 *
 * Built lazily and only on a miss, so the common path pays nothing. It reads
 * declarations rather than compiled output, so it resolves a NAME and not a
 * guarantee the selector came from that contract — two errors sharing a
 * signature share a selector either way.
 */
let sourceIndex = null;
function fromSource(selector) {
  if (sourceIndex === null) {
    sourceIndex = {};
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.sol')) continue;
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/error\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g)) {
          const types = m[2].trim() ? m[2].split(',').map((a) => a.trim().split(/\s+/)[0]) : [];
          const sig = `${m[1]}(${types.join(',')})`;
          try {
            sourceIndex[toFunctionSelector(sig)] ??= sig;
          } catch {
            /* unencodable signature — skip */
          }
        }
      }
    };
    walk(SRC_DIR);
  }
  return sourceIndex[selector] ?? null;
}

/**
 * Decode a custom error's ARGUMENTS as well as its name, where the payload
 * carries them. `OfferTermsMismatch(uint8 field)` is the case that makes this
 * worth having: the name alone says "some term disagreed", while the argument
 * says WHICH, and the difference is a debugging session.
 */
export function describeRevertData(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  const sig = nameSelector(data.slice(0, 10));
  if (!sig) return null;
  const types = sig.slice(sig.indexOf('(') + 1, -1);
  if (!types) return sig;
  try {
    const values = decodeAbiParameters(
      types.split(',').map((type) => ({ type })),
      `0x${data.slice(10)}`,
    );
    return `${sig.slice(0, sig.indexOf('('))}(${values.map((v) => String(v)).join(', ')})`;
  } catch {
    return sig;
  }
}

/** Name a 4-byte custom-error selector, or return null. */
export function nameSelector(selector) {
  if (typeof selector !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(selector)) return null;
  return ERROR_INDEX[selector] ?? fromSource(selector) ?? null;
}

/**
 * Pull the first plausible custom-error selector out of an arbitrary revert
 * payload — viem nests the data differently for a call, an estimate and a
 * send — and name it.
 */
export function nameRevert(error) {
  const seen = new Set();
  const candidates = [];
  const visit = (node, depth) => {
    if (node == null || depth > 6 || seen.has(node)) return;
    if (typeof node === 'object') seen.add(node);
    if (typeof node === 'string') {
      for (const m of node.matchAll(/0x[0-9a-fA-F]{8,}/g)) candidates.push(m[0].slice(0, 10));
      return;
    }
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }
    if (typeof node === 'object') for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(error?.data ?? null, 0);
  visit(error?.cause ?? null, 0);
  visit(error?.details ?? null, 0);
  visit(error?.shortMessage ?? null, 0);
  visit(error?.message ?? null, 0);
  for (const c of candidates) {
    const named = nameSelector(c);
    if (named) return named;
  }
  return null;
}
