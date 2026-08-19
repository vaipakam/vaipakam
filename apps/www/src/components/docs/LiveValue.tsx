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
 * `<LiveValue knob="..." />`. Each token resolves to either a registered
 * knob (`KNOB_DEFAULTS`) or a figure derived from one or more knobs
 * (`DERIVED_FIGURES`) — the token syntax does not distinguish them, and
 * neither does the resolver.
 *
 * Why a single component (vs. raw text):
 * - A retune updates one definition rather than every sentence in
 *   every language that quotes the figure — and now needs no deploy at
 *   all, since the figure follows the published configuration.
 * - Compile-time defaults are bundled in, so the page renders with
 *   sensible values before the snapshot resolves and when it cannot be
 *   reached (indexer redeploying, chain absent from the snapshot, a row
 *   too stale to trust). A docs page must render for whoever arrives
 *   during any of those. Those defaults still have to be RIGHT — they
 *   are what a reader sees on every failure path — so
 *   `scripts/check-knob-defaults-vs-contracts.ts` (#1623) keeps them
 *   pinned to the protocol's own constants. Wiring the snapshot does
 *   not retire that guard; it makes it the fallback's correctness
 *   check rather than the only thing standing between the page and a
 *   stale figure.
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
 * default. NOT "current as of its build": the defaults are pinned to
 * the protocol's compiled starting rates, and a governance retune moves
 * live configuration rather than those rates, so the exports do not
 * follow a retune even across rebuilds (#1664 item 3 — whether they
 * should fetch the snapshot at build time is a deliberate open
 * decision).
 */

import { DOCS_CHAIN_LABEL, useProtocolConfig } from '../../hooks/useProtocolConfig';
import {
  formatKnob,
  resolveLiveValue,
  type LiveValueName,
} from '../../lib/liveValueKnobs';

/**
 * Adding a value to the docs is now entirely a registry edit: add the
 * name to `KnobName` (or `DerivedName`), its default and format to
 * `KNOB_DEFAULTS` (or its inputs and formula to `DERIVED_FIGURES`), and
 * its config read to `KNOB_READS` — all in `lib/liveValueKnobs.ts` —
 * then use `{liveValue:<name>}` in markdown. Nothing is added here.
 *
 * The per-knob config reads used to live in this file, which is why the
 * search index could not use them and substituted bundled defaults
 * unconditionally (#1664 item 2). They are in the registry now, beside
 * the names and formats they describe.
 */
interface LiveValueProps {
  knob: LiveValueName;
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

  // ONE resolver for knobs and derived figures alike (#1664 item 2).
  // The mapping from config field to token used to live here; the search
  // index needed the same mapping, and a second copy of it is exactly the
  // drift this registry exists to prevent.
  const resolved = resolveLiveValue(knob, config);

  // Robustness: token typos (e.g. `{liveValue:treasuryFeebps}`) fall
  // through to inline code rendering so the bug is visible in the page
  // rather than rendering a silent misleading value.
  if (!resolved) return <code>{`{liveValue:${knob}}`}</code>;

  const { value, isLive, format } = resolved;

  const display = formatKnob(value, format, locale);

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
          ? // Named per chain, derived from the configured id (#1664
            // item 4): every supported network runs an independent
            // Diamond with independently tunable knobs, so an
            // unqualified "the published configuration" tells a reader
            // on any other deployment the wrong figure is theirs the
            // moment two chains are retuned apart.
            `Live value from the published ${DOCS_CHAIN_LABEL} configuration`
          : chainReads
            ? `Value shipped with this page — published ${DOCS_CHAIN_LABEL} configuration not loaded`
            : // A surface that makes no read at all: neither "not loaded"
              // nor "pending" is true, and saying either describes a
              // failure that never happened (#1612). This branch is not
              // reachable on the marketing site now that the snapshot is
              // wired, and is kept because the component is what any
              // future read-free surface would render — the wording is
              // the one #1623 settled on for exactly that case.
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
