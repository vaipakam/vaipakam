/**
 * Guard: every `{liveValue:...}` default published on the marketing site
 * still matches the protocol constant it claims to mirror (#1612).
 *
 * Why this exists
 * ---------------
 * The marketing site makes no chain read — `useProtocolConfig` is a
 * deliberate stub — so every fee and tier figure on the public pages is
 * the value bundled into `lib/liveValueKnobs.ts` at build time. Nothing
 * tied those bundled values to the protocol's own constants. They were
 * correct only by maintenance: `treasuryFeeBps: 200` carries the comment
 * "mirrors LibVaipakam.TREASURY_FEE_BPS", and staying true depended on
 * whoever next retunes a fee remembering this file exists.
 *
 * That has already gone wrong once. #1352 retuned both fees and the copies
 * that quoted them drifted, which is the reason the shared registry was
 * introduced in the first place. A registry removes the NINE-copies
 * problem; it does not, on its own, notice when its single copy goes
 * stale. This does.
 *
 * Why the Solidity constants, and not a chain read
 * ------------------------------------------------
 * A chain read was the obvious candidate and is the wrong anchor today:
 *
 *  - There is no mainnet deployment, so the only readable Diamond is on a
 *    testnet, whose values are legitimately retuned for testing. Gating
 *    published copy on it would fail the build for reasons that say
 *    nothing about what the protocol ships.
 *  - It would make a deterministic check depend on a public RPC — a
 *    flaky gate is a gate people learn to re-run rather than read.
 *
 * The constants in `LibVaipakam.sol` ARE what the pages claim to state,
 * and reading them needs no network, so this runs in the ordinary
 * typecheck alongside `check-live-value-render.tsx`.
 *
 * What this deliberately does NOT cover: a governance retune on a live
 * deployment. Those knobs are storage-overridable (`0 ⇒ <constant>`), so a
 * retuned chain can diverge from the constant while this check stays
 * green. Closing that needs either real reads on the marketing site or an
 * ops job watching a deployment — both are decisions to make once there is
 * a deployment worth watching. Recorded in #1612 rather than implied here.
 *
 * Failure mode discipline: an anchor that cannot be FOUND fails, it does
 * not skip. A guard that silently covers nothing when its parsing
 * assumption breaks is worse than no guard, because it reports success.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KNOB_DEFAULTS, type KnobName } from '../src/lib/liveValueKnobs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '../../../contracts/src/libraries/LibVaipakam.sol');

/**
 * How each published knob is anchored to a protocol constant.
 *
 * `scale`:
 *  - `bps`      — the constant is a bare basis-points integer.
 *  - `tokens18` — the constant is `<N> * 1e18` wei and the published
 *                 figure is the whole-token count `N`.
 */
interface Anchor {
  constant: string;
  scale: 'bps' | 'tokens18';
  /** Only where the published NAME and the constant's name disagree. */
  note?: string;
}

const ANCHORS: Record<KnobName, Anchor> = {
  treasuryFeeBps: { constant: 'TREASURY_FEE_BPS', scale: 'bps' },
  loanInitiationFeeBps: { constant: 'LOAN_INITIATION_FEE_BPS', scale: 'bps' },
  tier1Min: { constant: 'VPFI_TIER1_MIN', scale: 'tokens18' },
  tier2Min: { constant: 'VPFI_TIER2_MIN', scale: 'tokens18' },
  tier3Min: { constant: 'VPFI_TIER3_MIN', scale: 'tokens18' },
  tier4Min: {
    constant: 'VPFI_TIER4_THRESHOLD',
    scale: 'tokens18',
    // The names disagree on purpose, so record it rather than let a
    // reader assume a typo. Tier 4 starts STRICTLY ABOVE this figure —
    // exactly 20,000 VPFI is Tier 3 — so the constant is Tier 3's
    // inclusive ceiling, and the doc tables use the token that way
    // ("tier3Min – tier4Min", then "Above tier4Min"). Renaming the knob
    // would churn ten locale files for no reader-visible gain.
    note: 'T4 starts strictly above this; the value is T3\'s inclusive ceiling',
  },
  tier1DiscountBps: { constant: 'VPFI_TIER1_DISCOUNT_BPS', scale: 'bps' },
  tier2DiscountBps: { constant: 'VPFI_TIER2_DISCOUNT_BPS', scale: 'bps' },
  tier3DiscountBps: { constant: 'VPFI_TIER3_DISCOUNT_BPS', scale: 'bps' },
  tier4DiscountBps: { constant: 'VPFI_TIER4_DISCOUNT_BPS', scale: 'bps' },
};

/**
 * The library source with COMMENTS REMOVED (Codex #1623 r1).
 *
 * The declaration match scans raw text, so a refactor that comments out
 * an old declaration while renaming the live one — `// uint256 constant
 * TREASURY_FEE_BPS = 100;` — would match the commented text and compare
 * the registry against a value no longer compiled. The guard would then
 * report success about a constant that does not exist, which is the
 * opposite of the fail-closed behaviour its own header promises.
 *
 * String literals are not a concern here: these are numeric constant
 * declarations, and a `//` or block-comment sequence inside a Solidity
 * string in this file would have to appear on the same line as one of the
 * anchored declarations to matter. Block comments are stripped first so a
 * `//` inside one cannot terminate the wrong thing.
 */
const source = readFileSync(LIB, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, '');
const failures: string[] = [];

/**
 * Read one `constant <NAME> = <expr>;` from the library source.
 *
 * Returns the whole-token / bare integer value, or a string explaining
 * why it could not — never a fallback. Only the two literal forms the
 * anchored constants actually use are accepted; anything else is
 * reported rather than guessed at, so a future constant written as an
 * expression (`A * B / C`) fails loudly instead of being mis-read.
 */
function readConstant(name: string, scale: Anchor['scale']): number | string {
  // Anchored to a declaration, so a mention in a comment or another
  // identifier that merely ENDS with this name cannot match.
  const decl = new RegExp(`\\bconstant\\s+${name}\\s*=\\s*([^;]+);`);
  const m = decl.exec(source);
  if (!m) return `no \`constant ${name} = …;\` declaration found in ${path.basename(LIB)}`;

  const expr = m[1].trim().replace(/_/g, '');
  if (scale === 'bps') {
    if (!/^\d+$/.test(expr)) return `expected a bare integer, found \`${m[1].trim()}\``;
    return Number(expr);
  }
  const tokens = /^(\d+)\s*\*\s*1e18$/.exec(expr);
  if (!tokens) return `expected \`<N> * 1e18\`, found \`${m[1].trim()}\``;
  return Number(tokens[1]);
}

// Both directions of the KNOB_DEFAULTS ↔ ANCHORS correspondence are
// checked AT RUNTIME, and that is not belt-and-braces over the type
// system — nothing type-checks this file. `scripts/**` is outside every
// tsconfig `include` (tsconfig.app.json takes `src/**` only), and the
// `tsx` runner strips types without checking them, so the
// `Record<KnobName, Anchor>` annotation below constrains nothing at
// build time. Deleting either loop would silently drop coverage.
for (const knob of Object.keys(KNOB_DEFAULTS) as KnobName[]) {
  const anchor = ANCHORS[knob];
  if (!anchor) {
    failures.push(
      `${knob}: published in KNOB_DEFAULTS but not anchored to a protocol` +
        ` constant — add it to ANCHORS in this script.`,
    );
    continue;
  }

  const actual = readConstant(anchor.constant, anchor.scale);
  if (typeof actual === 'string') {
    failures.push(`${knob} → ${anchor.constant}: ${actual}`);
    continue;
  }

  // The display FORMAT is part of what gets published, not just the
  // number (Codex #1623 r1). Flipping `treasuryFeeBps` from `percent` to
  // `count` leaves `200 === TREASURY_FEE_BPS` true and every value check
  // green, while the page renders "200" where it should read "2". Each
  // anchor already knows whether its constant is BPS or whole tokens, so
  // the correspondence is checkable rather than assumed.
  const expectedFormat = anchor.scale === 'bps' ? 'percent' : 'count';
  if (KNOB_DEFAULTS[knob].format !== expectedFormat) {
    failures.push(
      `${knob}: ${anchor.constant} is ${anchor.scale}, so the registry should` +
        ` format it as "${expectedFormat}" — it says "${KNOB_DEFAULTS[knob].format}".` +
        `\n    → the value would render at the wrong scale even though the` +
        ` number matches.`,
    );
  }

  const published = KNOB_DEFAULTS[knob].defaultValue;
  if (published !== actual) {
    failures.push(
      `${knob}: the site publishes ${published} but ${anchor.constant} is` +
        ` ${actual}${anchor.note ? ` (${anchor.note})` : ''}` +
        `\n    → update defaultValue in apps/www/src/lib/liveValueKnobs.ts,` +
        ` and check the surrounding prose in apps/www/src/content/**` +
        ` still reads correctly at the new figure.`,
    );
  }
}

// The reverse: an anchor for a knob the site no longer publishes. Not
// itself a reader-visible fault, but it means this script's count line
// overstates what it covered, and a stale anchor is the residue of a
// rename that may have left the real knob unanchored.
for (const knob of Object.keys(ANCHORS)) {
  if (!(knob in KNOB_DEFAULTS)) {
    failures.push(
      `${knob}: anchored in this script but absent from KNOB_DEFAULTS —` +
        ` remove the stale anchor, and check the knob it was renamed to` +
        ` has one.`,
    );
  }
}

if (failures.length) {
  console.error(
    `\ncheck-knob-defaults-vs-contracts: ${failures.length} published` +
      ` figure(s) no longer match the protocol constants they mirror:\n`,
  );
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    `\nThese figures appear in public documentation. Fix the registry` +
      ` rather than this check.\n`,
  );
  process.exit(1);
}

console.log(
  `check-knob-defaults-vs-contracts: ${Object.keys(ANCHORS).length} published` +
    ` figures match their protocol constants`,
);
