/**
 * `<LiveValue>` — renders a single governance-tunable protocol value
 * (fee BPS, discount tier, VPFI threshold, etc.) inline inside doc
 * markdown, via `useProtocolConfig`.
 *
 * ON THIS SURFACE THAT IS ALWAYS THE COMPILE-TIME DEFAULT. The
 * marketing site is deliberately wallet-free, so its `useProtocolConfig`
 * is a stub that reports no config — and says so explicitly via
 * `chainReads: false`, which the tooltip below reads rather than
 * inferring from a null config (#1612). Every knob falls back to
 * `defaultValue`.
 *
 * What that buys is a single definition point for a number that ten
 * locale files would otherwise each hold a copy of. That is worth having
 * — #1352 retuned both fees and the copies drifted — but it is not
 * liveness, and marketing copy must not tell a reader these figures come
 * from the chain. `scripts/check-knob-defaults-vs-contracts.ts` keeps the
 * single copy honest against the protocol's own constants, since a
 * registry fixes the ten-copies problem but cannot notice its one copy
 * going stale.
 *
 * The live branch is retained, not dead weight: it is the whole reason
 * wiring real reads here would need no change to this component. Note it
 * is NOT shared code with the connected app — `apps/defi` carries its own
 * copy of this file, which nothing renders and #1603 deletes. Do not
 * assume an edit here reaches any other surface.
 *
 * Markdown integration: doc content uses inline-code tokens like
 *   `{liveValue:treasuryFeeBps}`
 *   `{liveValue:tier1Min}`
 *   `{liveValue:tier3DiscountBps}`
 * which the custom `code` component in `markdownToc.tsx` rewrites to
 * `<LiveValue knob="..." />`. Each token resolves to a registered knob
 * in {@link KNOB_DEFAULTS}.
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
 *
 * Defaults, display format and the formatter itself live in
 * `lib/liveValueKnobs.ts`, NOT here (#1606 review). The build script that
 * publishes the machine-readable docs substitutes the same tokens, and
 * two copies of "what does this token mean" would drift. This file owns
 * only the chain reads, which are the part the build script cannot do.
 */

import { useProtocolConfig } from '../../hooks/useProtocolConfig';
import { KNOB_DEFAULTS, formatKnob, type KnobName } from '../../lib/liveValueKnobs';

export type { KnobName };

/**
 * Chain reads only — one per knob.
 *
 * The default value and display format come from {@link KNOB_DEFAULTS}.
 * Adding a value to the docs means: add the name to `KnobName` and an
 * entry to `KNOB_DEFAULTS` (both in `lib/liveValueKnobs.ts`), add its
 * read here, then use `{liveValue:<knobName>}` in markdown.
 */
type ChainRead = (config: ReturnType<typeof useProtocolConfig>['config']) => number | null;

const KNOB_READS: Record<KnobName, ChainRead> = {
  treasuryFeeBps: (c) => (c ? c.treasuryFeeBps : null),
  loanInitiationFeeBps: (c) => (c ? c.loanInitiationFeeBps : null),
  tier1Min: (c) => (c ? c.tierThresholdsTokens[0] : null),
  tier2Min: (c) => (c ? c.tierThresholdsTokens[1] : null),
  tier3Min: (c) => (c ? c.tierThresholdsTokens[2] : null),
  tier4Min: (c) => (c ? c.tierThresholdsTokens[3] : null),
  tier1DiscountBps: (c) => (c ? c.tierDiscountBps[0] : null),
  tier2DiscountBps: (c) => (c ? c.tierDiscountBps[1] : null),
  tier3DiscountBps: (c) => (c ? c.tierDiscountBps[2] : null),
  tier4DiscountBps: (c) => (c ? c.tierDiscountBps[3] : null),
};

interface LiveValueProps {
  knob: KnobName;
  /**
   * Locale of the DOCUMENT this value appears in — not the UI language
   * (#1610 review round 5).
   *
   * These differ, and using the UI language was wrong. `Whitepaper` and
   * `AdminKnobsDocs` always resolve the `.en.md` source whatever the
   * route, so on `/de/help/technical` the prose is English; formatting a
   * threshold as `20.000` there contradicts the sentence around it, and
   * on an Arabic route the digits themselves changed script inside
   * English text. `Overview` and `UserGuide` fall back to English when a
   * translation is missing, so their document locale is not the route
   * locale either. The caller knows which document it resolved; this
   * component cannot infer it.
   */
  locale: string;
}

export function LiveValue({ knob, locale }: LiveValueProps) {
  const spec = KNOB_DEFAULTS[knob];
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
  const { config, chainReads } = useProtocolConfig();

  // Robustness: token typos (e.g. `{liveValue:treasuryFeebps}`) fall
  // through to inline code rendering so the bug is visible in the
  // page rather than rendering a silent misleading value.
  if (!spec) return <code>{`{liveValue:${knob}}`}</code>;

  const live = KNOB_READS[knob]?.(config) ?? null;
  const value = live ?? spec.defaultValue;
  const isLive = live !== null;

  const display = formatKnob(value, spec.format, locale);

  return (
    <span
      title={
        isLive
          ? 'Live value from on-chain protocol config'
          : chainReads
            ? 'Compile-time default — chain read pending or unavailable'
            : // The marketing surface makes no chain read, so neither
              // "pending" nor "unavailable" is true here (#1612). Saying
              // so described a transient failure to every reader who
              // hovered a fee figure, and invited them to refresh and
              // wait for a number that was already the right one.
              'Published value — bundled into this site at release, not read live from the chain'
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
