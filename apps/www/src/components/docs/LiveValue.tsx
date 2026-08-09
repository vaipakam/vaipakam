/**
 * `<LiveValue>` — renders a single governance-tunable protocol value
 * (fee BPS, discount tier, VPFI threshold, etc.) inline inside doc
 * markdown, via `useProtocolConfig`.
 *
 * On this surface the value comes from the indexer's published config
 * snapshot (#1612), not from a chain client — the site stays wallet-
 * free and carries no ABI. The bundled default is the fallback, used
 * before the snapshot resolves and on every failure path, so a page
 * always renders a figure.
 *
 * The distinction the tooltip draws is therefore real and worth
 * keeping honest: a dotted underline means the number followed the last
 * governance retune, a dashed one means it is the number shipped with
 * this build. Until #1612 the second was ALWAYS the case while the
 * tooltip described a failed chain read, which told readers something
 * was broken on a page that was working exactly as designed.
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
 *   every language that quotes the figure — and now needs no deploy at
 *   all, since the figure follows the published configuration.
 * - Compile-time defaults are bundled in, so the page renders with
 *   sensible values before the snapshot resolves and when it cannot be
 *   reached (indexer redeploying, chain absent from the snapshot, a row
 *   too stale to trust). A docs page must render for whoever arrives
 *   during any of those.
 * - The `<span title="...">` tooltip names the source, so a reader
 *   curious about provenance can tell a figure that tracks the protocol
 *   from one baked into this build.
 *
 * The component is a React hook caller — must be invoked from the
 * React tree (i.e. inside the markdown render of a doc page). It needs
 * no provider here: `useProtocolConfig` is a module-level store doing
 * one `fetch` per page load, shared by every token on the page.
 *
 * Defaults, display format and the formatter itself live in
 * `lib/liveValueKnobs.ts`, NOT here (#1606 review). The build script that
 * publishes the machine-readable docs substitutes the same tokens, and
 * two copies of "what does this token mean" would drift. This file owns
 * only the live read, which is the part the build script cannot do —
 * the published markdown has no runtime, so it substitutes the bundled
 * default and is current as of its build.
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
  const { config } = useProtocolConfig();

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
      // A stable structural marker for "this figure came from a knob".
      // The render guard used to identify these spans by matching their
      // TOOLTIP COPY, so rewording the tooltip broke a check about
      // structure — the same fact written in two places, one of them a
      // sentence meant for humans. The attribute is the fact; the
      // tooltip is prose. It also names WHICH knob, so the guard and a
      // live-review driver can assert a specific figure rather than
      // "some span exists".
      data-live-value={knob}
      data-live-value-source={isLive ? 'published' : 'bundled'}
      title={
        isLive
          ? 'Live value from the published protocol configuration'
          : 'Value shipped with this page — published configuration not loaded'
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
