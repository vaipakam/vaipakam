/**
 * `<LiveValue>` — renders a single governance-tunable protocol value
 * (fee BPS, discount tier, VPFI threshold, etc.) inline inside doc
 * markdown, via `useProtocolConfig`.
 *
 * ON THIS SURFACE THAT IS ALWAYS THE COMPILE-TIME DEFAULT. The
 * marketing site is deliberately wallet-free, so its `useProtocolConfig`
 * is a stub that reports no config and every knob below falls back to
 * `defaultValue`. The component is shared with connected-app surfaces
 * where the read is real; here it buys a single definition point for a
 * number that ten locale files would otherwise each hold a copy of.
 * That is worth having — #1352 retuned both fees and the copies drifted
 * — but it is not liveness, and marketing copy must not tell a reader
 * these figures come from the chain.
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
 * - A retune updates one definition rather than every sentence in
 *   every language that quotes the figure. On surfaces that read
 *   config, that update needs no deploy at all; here it needs one
 *   build, which is still nine fewer places to forget.
 * - Compile-time defaults are bundled in, so the page renders with
 *   sensible values before a chain read resolves, when the read fails
 *   (offline, RPC blip, no Diamond on this chain), and — on the
 *   marketing site — always.
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
    // 2% since the #1352 fee freeze (mirrors LibVaipakam.TREASURY_FEE_BPS).
    defaultValue: 200,
    read: (c) => (c ? c.treasuryFeeBps : null),
    format: 'percent',
  },
  loanInitiationFeeBps: {
    // 0.2% since the #1352 fee freeze (mirrors LibVaipakam.LOAN_INITIATION_FEE_BPS).
    defaultValue: 20,
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
  // The bail-out sits BELOW the hook (#1521). Two things to know:
  //
  // 1. As written before, this was a rules-of-hooks violation — `spec`
  //    comes from a prop, so the hook count depended on it.
  // 2. It was NOT, on its own, a crash. React tolerates a render that
  //    calls ZERO hooks, and the old bail-out preceded every hook here,
  //    so the transition was 0 <-> 1 and React accepted it. (Probed
  //    directly; the crash only occurs when a NON-zero count changes.)
  //
  // It is fixed anyway because the safety is accidental and one line
  // deep: add any hook above the bail-out — a `useTranslation` for the
  // error text, a context read — and the count becomes 1 <-> 2, which
  // aborts the page. The ordering below removes that trap rather than
  // relying on nobody springing it.
  //
  // This is the copy the docs actually render: Whitepaper, Overview,
  // UserGuide and AdminKnobsDocs all reach it via `markdownComponents()`.
  const { config } = useProtocolConfig();

  // Robustness: token typos (e.g. `{liveValue:treasuryFeebps}`) fall
  // through to inline code rendering so the bug is visible in the
  // page rather than rendering a silent misleading value.
  if (!spec) return <code>{`{liveValue:${knob}}`}</code>;

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
