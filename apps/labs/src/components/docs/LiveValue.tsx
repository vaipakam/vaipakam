/**
 * `<LiveValue>` — renders a single governance-tunable protocol value
 * (fee BPS, discount tier, VPFI threshold, etc.) inline inside doc
 * markdown, sourced live from the chain via `useProtocolConfig`.
 *
 * Markdown integration: doc content uses inline-code tokens like
 *   `{liveValue:treasuryFeeBps}`
 *   `{liveValue:tier1Min}`
 *   `{liveValue:tier3DiscountBps}`
 * which the custom `code` component in `markdownToc.tsx` rewrites to
 * `<LiveValue knob="..." />`. Each token resolves to a registered knob
 * in {@link KNOB_REGISTRY} below.
 *
 * Why a single component (vs. raw text):
 * - Numbers stay accurate when governance retunes a knob — no doc PR
 *   needed to keep the marketing pages in sync with on-chain truth.
 * - Compile-time defaults are still bundled in, so the page renders
 *   with sensible fallbacks before the chain read resolves AND when
 *   the read fails (offline, RPC blip, no Diamond on this chain).
 * - The `<span title="...">` tooltip names the source so a reader
 *   curious about provenance can hover to confirm the value comes
 *   from the chain rather than a hardcoded marketing claim.
 *
 * The component is a React hook caller — must be invoked from the
 * React tree (i.e. inside the markdown render of a doc page that
 * mounted `useProtocolConfig`'s deps via `<DiamondReadProvider>`).
 */

import { useProtocolConfig } from '../../hooks/useProtocolConfig';

/**
 * Registered knob names. Adding a new value to the docs:
 *   1. Add a `KnobName` entry here.
 *   2. Add a `KNOB_REGISTRY` entry mapping it to the live-read +
 *      compile-time-default + render formatter.
 *   3. Use `{liveValue:<knobName>}` in markdown.
 */
export type KnobName =
  | 'treasuryFeeBps'
  | 'loanInitiationFeeBps'
  | 'tier1Min'
  | 'tier2Min'
  | 'tier3Min'
  | 'tier4Min'
  | 'tier1DiscountBps'
  | 'tier2DiscountBps'
  | 'tier3DiscountBps'
  | 'tier4DiscountBps';

interface KnobSpec {
  /** Compile-time default value used while the read is pending OR when
   *  the chain read fails. Matches the on-chain library default. */
  defaultValue: number;
  /** Resolves the live value from `useProtocolConfig`. Returns `null`
   *  when config isn't ready so the renderer can fall back. */
  read: (config: ReturnType<typeof useProtocolConfig>['config']) => number | null;
  /** Formatter — turns a raw number into a display string.
   *  - `percent`: BPS in, "x.y%" out (no `%` sign — caller adds it
   *    in markdown so doc localization controls placement).
   *  - `count`: integer, locale-formatted (`1,000`).
   */
  format: 'percent' | 'count';
}

const KNOB_REGISTRY: Record<KnobName, KnobSpec> = {
  treasuryFeeBps: {
    defaultValue: 100,
    read: (c) => (c ? c.treasuryFeeBps : null),
    format: 'percent',
  },
  loanInitiationFeeBps: {
    defaultValue: 10,
    read: (c) => (c ? c.loanInitiationFeeBps : null),
    format: 'percent',
  },
  tier1Min: {
    defaultValue: 100,
    read: (c) => (c ? c.tierThresholdsTokens[0] : null),
    format: 'count',
  },
  tier2Min: {
    defaultValue: 1_000,
    read: (c) => (c ? c.tierThresholdsTokens[1] : null),
    format: 'count',
  },
  tier3Min: {
    defaultValue: 5_000,
    read: (c) => (c ? c.tierThresholdsTokens[2] : null),
    format: 'count',
  },
  tier4Min: {
    defaultValue: 20_000,
    read: (c) => (c ? c.tierThresholdsTokens[3] : null),
    format: 'count',
  },
  tier1DiscountBps: {
    defaultValue: 1_000,
    read: (c) => (c ? c.tierDiscountBps[0] : null),
    format: 'percent',
  },
  tier2DiscountBps: {
    defaultValue: 1_500,
    read: (c) => (c ? c.tierDiscountBps[1] : null),
    format: 'percent',
  },
  tier3DiscountBps: {
    defaultValue: 2_000,
    read: (c) => (c ? c.tierDiscountBps[2] : null),
    format: 'percent',
  },
  tier4DiscountBps: {
    defaultValue: 2_400,
    read: (c) => (c ? c.tierDiscountBps[3] : null),
    format: 'percent',
  },
};

/**
 * Format a BPS value as a percentage figure WITHOUT the `%` sign —
 * `100` → `"1"`, `10` → `"0.1"`, `2400` → `"24"`, `1050` → `"10.5"`.
 * The `%` lives in the markdown so doc translators can place it
 * (some locales — French — put a non-breaking space before).
 */
function bpsAsPct(bps: number): string {
  if (bps % 100 === 0) return (bps / 100).toString();
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '');
}

interface LiveValueProps {
  knob: KnobName;
}

export function LiveValue({ knob }: LiveValueProps) {
  const spec = KNOB_REGISTRY[knob];
  // Robustness: token typos (e.g. `{liveValue:treasuryFeebps}`) fall
  // through to inline code rendering so the bug is visible in the
  // page rather than rendering a silent misleading value.
  if (!spec) return <code>{`{liveValue:${knob}}`}</code>;

  const { config } = useProtocolConfig();
  const live = spec.read(config);
  const value = live ?? spec.defaultValue;
  const isLive = live !== null;

  const display =
    spec.format === 'percent' ? bpsAsPct(value) : value.toLocaleString('en-US');

  return (
    <span
      title={
        isLive
          ? 'Live value from on-chain protocol config'
          : 'Compile-time default — chain read pending or unavailable'
      }
      style={{
        // Subtle styling so live values don't visually shout — the
        // intent is "trustworthy data from chain", not "click here".
        // Still distinguishable from surrounding prose for readers
        // who want to know what's dynamic.
        borderBottom: isLive ? '1px dotted var(--brand)' : '1px dashed var(--text-muted, #888)',
        textDecorationSkipInk: 'auto',
      }}
    >
      {display}
    </span>
  );
}
