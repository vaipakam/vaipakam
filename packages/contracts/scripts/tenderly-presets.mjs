#!/usr/bin/env node
/**
 * Check the Tenderly alert presets in `ops/tenderly/alerts.yaml` before any
 * per-chain manifest is written (#2869).
 *
 * A preset names its signal by signature, and a signature that has drifted
 * from the contract matches nothing: Tenderly accepts the alert and it never
 * fires. Three presets had drifted that way unnoticed, so
 * `contracts/script/exportTenderlyAlerts.sh` runs this first and publishes
 * nothing when it fails.
 *
 * The template is PARSED as YAML, not read line by line (#2979 r1): a check
 * keyed on indentation recognised no presets after a valid re-indent and then
 * passed. Here a template whose `alerts` is not a non-empty list, or a preset
 * that is not a mapping, is refused rather than skipped.
 *
 * Every preset must carry an `id` (unique), a `contract`, and exactly one of
 * `event` or `error`. A preset on the Diamond (`contract` is the literal
 * `${DIAMOND_ADDRESS}` placeholder the export substitutes) must name a
 * signature the committed combined Diamond ABI carries, in canonical form:
 * struct parameters are written as their component tuples, with any array
 * suffix kept, e.g. `DiamondCut((address,uint8,bytes4[])[],address,bytes)`.
 *
 * What this proves, and what it does not: the signature EXISTS on the
 * Diamond. It cannot prove that a code path emits it. A preset on any other
 * contract has no committed ABI to check against; it is returned as
 * unchecked, and the export prints it by name instead of passing it silently.
 *
 * Usage: node tenderly-presets.mjs <alerts.yaml> <diamondAbi.json>
 *   exit 0: prints one `UNCHECKED <id> (<contract>: <kind> <signature>)` line
 *           per preset it could not check
 *   exit 1: prints each refusal to stderr
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const DIAMOND_PLACEHOLDER = '${DIAMOND_ADDRESS}';

/**
 * The canonical type of one ABI parameter: a tuple is written as its
 * components in parentheses, keeping the array suffix (`tuple[2][]` →
 * `(…)[2][]`). This is the form a selector or topic hash is computed over.
 */
export function canonicalType(param) {
  const m = /^tuple((?:\[\d*\])*)$/.exec(param.type);
  if (!m) return param.type;
  return `(${(param.components ?? []).map(canonicalType).join(',')})${m[1]}`;
}

/** `event Name(types)` / `error Name(types)` for every event and error. */
export function diamondSignatures(abi) {
  const sigs = new Set();
  for (const item of abi) {
    if (item.type !== 'event' && item.type !== 'error') continue;
    sigs.add(`${item.type} ${item.name}(${(item.inputs ?? []).map(canonicalType).join(',')})`);
  }
  return sigs;
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Check the template text against the Diamond ABI.
 * @returns {{ bad: string[], unchecked: string[], count: number }}
 */
export function checkPresets(templateText, diamondAbi) {
  let doc;
  try {
    doc = yaml.load(templateText);
  } catch (e) {
    return { bad: [`the template is not valid YAML: ${e.message}`], unchecked: [], count: 0 };
  }
  const alerts = doc && typeof doc === 'object' ? doc.alerts : undefined;
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return { bad: ['the template has no `alerts` list, or it is empty'], unchecked: [], count: 0 };
  }

  const sigs = diamondSignatures(diamondAbi);
  const bad = [];
  const unchecked = [];
  const seen = new Set();
  alerts.forEach((preset, i) => {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      bad.push(`alerts[${i}] is not a mapping`);
      return;
    }
    const id = nonEmptyString(preset.id) ? preset.id : `alerts[${i}]`;
    if (!nonEmptyString(preset.id)) bad.push(`${id} has no id`);
    else if (seen.has(id)) bad.push(`${id} is listed twice`);
    seen.add(id);

    const kinds = ['event', 'error'].filter((k) => preset[k] !== undefined);
    if (kinds.length !== 1 || !nonEmptyString(preset[kinds[0]])) {
      bad.push(`${id} must name exactly one event or error signature`);
      return;
    }
    const kind = kinds[0];
    const sig = preset[kind];
    if (!nonEmptyString(preset.contract)) {
      bad.push(`${id} names no contract`);
    } else if (preset.contract === DIAMOND_PLACEHOLDER) {
      if (!sigs.has(`${kind} ${sig}`)) bad.push(`${id} (${kind} ${sig} is not in the Diamond ABI)`);
    } else {
      unchecked.push(`${id} (${preset.contract}: ${kind} ${sig})`);
    }
  });
  return { bad, unchecked, count: alerts.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [templatePath, abiPath] = process.argv.slice(2);
  if (!templatePath || !abiPath) {
    console.error('usage: tenderly-presets.mjs <alerts.yaml> <diamondAbi.json>');
    process.exit(2);
  }
  const { bad, unchecked } = checkPresets(
    readFileSync(templatePath, 'utf8'),
    JSON.parse(readFileSync(abiPath, 'utf8')),
  );
  if (bad.length > 0) {
    for (const b of bad) console.error(`  - ${b}`);
    process.exit(1);
  }
  for (const u of unchecked) console.log(`UNCHECKED ${u}`);
}
