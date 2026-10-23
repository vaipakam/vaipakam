/**
 * Protocol Console — public, read-only view of the governance-tunable
 * parameters the indexer publishes (#1959).
 *
 * A SUBSET, AND IT SAYS SO. This renders the configuration bundle plus
 * every protocol-wide setting with a single-value getter (#2071). Settings
 * that differ per asset or per chain, the reward and recycling settings,
 * and a few protocol-wide ones readable only inside a multi-value getter
 * (#2680) are not here. The lede says so, because an incomplete view
 * asserting completeness is worse than an incomplete one, and
 * `protocolConsoleDocCoverage.ts` records, for every setting in the
 * canonical reference, whether it is shown and if not why — a check fails
 * when the reference gains one this page has not accounted for.
 *
 * THE SNAPSHOT WHILE IT IS CURRENT, THE CHAIN OTHERWISE (#2074). The
 * indexer's snapshot is read first; when it is missing, behind, undated,
 * unlabelled or incomplete the page reads the same values from the
 * contracts (`protocolConsoleRead.ts`), and the provenance line says which
 * source it used and why. A snapshot that is not current is shown only
 * when that read fails too, and then with its warnings.
 *
 * WHY IT LIVES HERE. `/protocol-console` was served by the retired
 * `apps/defi` and was the second of two surfaces the #1854 cutover did
 * not port. Together with `/analytics` it is why `defi.vaipakam.com`
 * could not be retired: the marketing site links to both.
 *
 * WHAT IS *NOT* HERE, DELIBERATELY. The prose reference already lives on
 * the marketing apex at `vaipakam.com/protocol-console/docs`, alongside
 * the Whitepaper and Overview, so the public-read explainer content
 * indexes together. This surface owns only the live VALUES. Duplicating
 * the runbook here would create a second copy to drift — the marketing
 * mirror is already pinned byte-for-byte against `docs/ops/` by
 * `check-admin-knobs-mirror.mjs`, and a third copy would not be.
 *
 * NAMED, NOT POSITIONAL. Values come from the indexer's named `values`
 * object, never the positional `bundle`. The release record carries an
 * incident where hand-typed tuples silently shifted field positions; a
 * governance parameter displayed against the wrong label is worse than
 * one not displayed at all, because it looks authoritative.
 *
 * PUBLIC BY DEFAULT, AND WALLET-FREE. Anyone can read the published
 * parameters without connecting — the same posture the retired console had, and the
 * one every major protocol has settled on. Operators who would rather
 * not surface it (a pre-launch deploy mid-tuning, or the industrial fork
 * where parameter visibility is itself restricted) set
 * `VITE_ADMIN_DASHBOARD_PUBLIC=false`.
 *
 * READ-ONLY. There are no write controls here and none are planned on
 * this route: governance changes go through the timelock and the admin
 * multisig, not a web form.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { copy } from '../content/copy';
import { SlidersHorizontal, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import { usePublicClient } from 'wagmi';
import { hexToString, type Hex } from 'viem';
import {
  fetchProtocolKnobs,
  CLOCK_SKEW_ALLOWANCE_SEC,
  type ProtocolKnobSnapshot,
  type ProtocolKnobValues,
} from '../data/indexer';
import { resolveSnapshotAge } from '../data/snapshotAge';
import {
  loadProtocolConsole,
  readProtocolConsoleLive,
  type ConsoleReading,
  type SnapshotGap,
} from '../data/protocolConsoleRead';
import { CONSOLE_SECTIONS, type ConsoleRow } from '../data/protocolConsoleRows';
import { EVENTLESS_PROTOCOL_KNOBS } from '@vaipakam/lib/protocolKnobs';
import { useActiveChain } from '../chain/useActiveChain';
import { exactAmountString, localeDecimalString, localeNumber } from '../lib/format';
import { VPFI_DECIMALS } from '../data/vpfi';
import { useNowSec } from '../hooks/useNowSec';
import { idleAware } from '../lib/idle';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';

/** Where the prose lives. Kept as one constant so the link cannot drift
 *  apart across the cards below. */
const DOCS_URL = 'https://vaipakam.com/protocol-console/docs';

/** The three value formatters, bound to the app's selected language.
 *
 *  ROUND 65 P2 — a factory rather than a `locale` parameter on each,
 *  because there are thirteen call sites and threading an argument
 *  through every one of them is how one gets missed. Built once per
 *  render from `i18n.resolvedLanguage`; `LanguageRemount` re-keys the
 *  tree on a language change, so the binding cannot go stale. */
function makeFormatters(locale: string | undefined) {
  const num = (n: number, opts?: Intl.NumberFormatOptions): string =>
    localeNumber(n, locale, opts);

  /** bps → percent, without pretending to more precision than we have.
   *
   *  ROUND 66 P2 — the parenthetical raw bps is formatted too. Round
   *  65 localised the percentage and left the figure beside it in
   *  brackets raw, which is the worst of the three available states:
   *  one sentence, two conventions, and no way for the reader to tell
   *  which one the page meant. */
  function bps(v: string | undefined): string {
    if (v === undefined) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    return copy.protocolConsole.bpsValue(num(n / 100, { maximumFractionDigits: 2 }), num(n));
  }

  /** ROUND 66 P2 — every placeholder, not only the leading one. These
   *  templates carry the converted unit AND the raw seconds, and both
   *  are figures the reader is being shown. */
  function seconds(v: string | undefined): string {
    if (v === undefined) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    if (n % 3600 === 0) return copy.protocolConsole.hoursValue(num(n / 3600), num(n));
    if (n % 60 === 0) return copy.protocolConsole.minutesValue(num(n / 60), num(n));
    return copy.protocolConsole.secondsValue(num(n));
  }

  function plain(v: string | undefined, unit = ''): string {
    return v === undefined ? '—' : `${num(Number(v))}${unit}`;
  }

  /** A `uint256` threshold, formatted for the locale WITHOUT a numeric
   *  round-trip — see `localeDecimalString`. `localeNumber(Number(s))`
   *  would round an 18-decimal figure the page exists to let a reader
   *  check. */
  function exactDecimal(v: string): string {
    return localeDecimalString(v, locale);
  }

  const ZERO_ADDRESS = /^0x0{40}$/i;
  const ZERO_WORD = /^0x0{64}$/i;

  /** #2071 — one row's value, written the way its format says. A value
   *  the source did not report is `—`, which the row marks "not reported";
   *  a value that IS reported but unset says "not set", never a dash. */
  function rowValue(row: ConsoleRow, values: ProtocolKnobValues): string {
    const v = values[row.key];
    if (v === undefined) return '—';
    const str = String(v);
    switch (row.format) {
      case 'bps':
        return bps(str);
      case 'seconds':
        return seconds(str);
      case 'secondsOrDefault':
        if (str !== '0') return seconds(str);
        return row.documentedDefaultSeconds === undefined
          ? copy.protocolConsole.notSet
          : copy.protocolConsole.unsetDefault(seconds(String(row.documentedDefaultSeconds)));
      case 'days':
        return plain(str, ` ${copy.protocolConsole.days}`);
      case 'flag':
        return flag(typeof v === 'boolean' ? v : undefined);
      case 'pause':
        return typeof v !== 'boolean' ? '—' : v ? copy.protocolConsole.paused : copy.protocolConsole.running;
      case 'address':
        return ZERO_ADDRESS.test(str) ? copy.protocolConsole.notSet : str;
      case 'bytes32':
        return ZERO_WORD.test(str) ? copy.protocolConsole.notSet : str;
      case 'symbol': {
        const n = numeraireOf(str);
        if (n === null) return str;
        return n.isDefault ? copy.protocolConsole.numeraireDefault(n.symbol) : n.symbol;
      }
      case 'wad':
        return exactDecimal(exactAmountString(BigInt(str), 18));
      case 'numeraireAmount': {
        const amount = exactDecimal(exactAmountString(BigInt(str), 18));
        const n = values.numeraireSymbol === undefined ? null : numeraireOf(values.numeraireSymbol);
        return n === null ? copy.protocolConsole.numeraireUnits(amount) : `${amount} ${n.symbol}`;
      }
    }
  }

  return { bps, exactDecimal, rowValue };
}

/** The empty word's meaning, as the contracts and the canonical parameter
 *  reference both state it: a deployment where governance never set the
 *  numeraire runs on USD. */
const DEFAULT_NUMERAIRE = 'USD';

/**
 * The active reference currency from its packed 32-byte symbol (Codex #2683
 * r1). The empty word is not "unset" in the sense of "none": the protocol
 * reads it as its USD default, so the page says USD and that it is the
 * default. A word that is not printable text is returned as null, and the
 * caller shows the raw word rather than invent a name for it.
 */
function numeraireOf(word: string): { symbol: string; isDefault: boolean } | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  if (/^0x0{64}$/.test(word)) return { symbol: DEFAULT_NUMERAIRE, isDefault: true };
  try {
    // With a size, viem trims the trailing zero bytes itself.
    const text = hexToString(word as Hex, { size: 32 });
    return /^[\x20-\x7e]+$/.test(text) ? { symbol: text.toUpperCase(), isDefault: false } : null;
  } catch {
    return null;
  }
}

/** Why the page read the chain instead of the snapshot, in the reader's words. */
function chainWhy(gap: SnapshotGap): string {
  switch (gap) {
    case 'missing':
      return copy.protocolConsole.chainWhyMissing;
    case 'known-stale':
      return copy.protocolConsole.chainWhyKnownStale;
    case 'undated':
      return copy.protocolConsole.chainWhyUndated;
    case 'old':
      return copy.protocolConsole.chainWhyOld;
    case 'unlabelled':
      return copy.protocolConsole.chainWhyUnlabelled;
    case 'incomplete':
      return copy.protocolConsole.chainWhyIncomplete;
  }
}

/** Snapshot age, against a caller-supplied ticking clock (never
 *  `Date.now()` in render — that freezes the reading). */
function ageText(updatedAtSec: number, nowSec: number): string {
  const secs = nowSec - updatedAtSec;
  // Same rule as the analytics page, and it has to be the same rule:
  // two surfaces disagreeing about whether a timestamp is usable is how
  // one calls a reading fresh while the other calls it unknown (review
  // round 22 P2).
  if (secs < -CLOCK_SKEW_ALLOWANCE_SEC) return copy.analytics.unknown;
  if (secs < 0) return copy.analytics.ageSeconds(0);
  if (secs < 90) return copy.analytics.ageSeconds(secs);
  if (secs < 5400) return copy.analytics.ageMinutes(Math.round(secs / 60));
  return copy.analytics.ageHours(Math.round(secs / 3600));
}


function flag(v: boolean | undefined): string {
  if (v === undefined) return '—';
  return v ? copy.protocolConsole.enabled : copy.protocolConsole.disabled;
}

function Row({ label, value, notes = [] }: { label: string; value: string; notes?: readonly string[] }) {
  const reported = value !== '—';
  return (
    <div className="pc-row">
      <div className="pc-row-label">{label}</div>
      <div className="pc-row-value" data-reported={reported}>
        {value}
        {!reported && <span className="pc-row-note"> {copy.protocolConsole.notReported}</span>}
      </div>
      {notes.map((n) => (
        <div key={n} className="pc-row-hint">
          {n}
        </div>
      ))}
    </div>
  );
}

export function ProtocolConsole() {
  // READ CHAIN, not `useChainId()`. This page is a marketing deep-link
  // target, so most arrivals have NO wallet — and `useChainId()` reports
  // mainnet (1) for them, which is not a chain this deployment indexes.
  // The result was an empty page for exactly the audience it is for.
  // `readChain` is the app's "where reads land when disconnected"
  // resolution, honouring VITE_DEFAULT_CHAIN_ID.
  const { readChain } = useActiveChain();
  const chainId = readChain.chainId;
  // #2074 — the same chain's public client, for the direct read the page
  // falls back to when the snapshot is not current. No wallet involved.
  const publicClient = usePublicClient({ chainId });
  // ROUND 65 P2 — number formatting follows the APP's language, not the
  // device's. `LanguageRemount` re-keys the tree on a change, so these
  // formatters are rebuilt with it.
  const { i18n } = useTranslation();
  const { bps, exactDecimal, rowValue } = makeFormatters(i18n.resolvedLanguage);
  // Ticks, so the snapshot age below advances instead of freezing at
  // whenever React last rendered.
  const nowSec = useNowSec();

  // useQuery, not useEffect+setState — matches every other async surface
  // here, and the effect form trips `react-hooks/set-state-in-effect`,
  // whose point is that a synchronous setState in an effect body
  // cascades renders.
  //
  // NOT FETCHED IN THE HIDDEN POSTURE (review round 23 P2). The hidden
  // return sits a few lines below, but the query above it ran anyway —
  // so a deployment that had decided not to show these values still
  // pulled them into the page and the React Query cache, where anyone
  // with developer tools could read them. A page that withholds
  // something should not first go and fetch it.
  //
  // Being exact about what this flag is, because the fix should not be
  // mistaken for more than it is: `/config` is a PUBLIC, keyless,
  // open-CORS endpoint — the same one the transparency dashboard reads
  // and any third party may call — and the contracts are public too. The
  // flag decides whether THIS DEPLOYMENT PRESENTS the values, not whether
  // they can be obtained. So this is the page keeping its own word, not
  // an access-control boundary, and it must not be described as one.
  const knobs = useQuery({
    queryKey: ['protocol-knobs', chainId],
    enabled: isProtocolConsolePublic(),
    // AUTO-REFRESH, at the same `cool` tier the transparency dashboard
    // uses (review round 54 P2).
    //
    // This page had no interval at all, so a reader who left it open on
    // a focused tab kept the snapshot it loaded with. The age sentence
    // beneath it advances on its own clock and the stale banner arrives
    // after a day, which covers the case of a WEDGED refresh rail — but
    // not the ordinary one: governance retunes a fee or flips a flag,
    // and the console goes on presenting the superseded value as
    // current, with nothing on the page qualifying it, for as long as
    // the tab stays open. Stating an age correctly is not the same as
    // showing the current value, and this page's stated purpose is the
    // second.
    //
    // `idleAware` is how every polling surface here honours "pause while
    // hidden, back off while abandoned, catch up on focus".
    refetchInterval: idleAware(180_000),
    // #2074 — the snapshot while it can stand in for the chain, the
    // contracts otherwise. `loadProtocolConsole` makes that call and
    // records which source answered and why.
    queryFn: () =>
      loadProtocolConsole({
        fetchSnapshot: () => fetchProtocolKnobs(chainId),
        readChain: () => {
          if (!publicClient) throw new Error('no client for this chain');
          return readProtocolConsoleLive(publicClient, chainId, readChain.diamondAddress);
        },
        nowSec: () => Math.floor(Date.now() / 1000),
      }),
  });

  const reading: ConsoleReading | null = knobs.data ?? null;
  const unavailable = knobs.isError;

  if (!isProtocolConsolePublic()) {
    return (
      <div className="pc-page">
        <h1>{copy.protocolConsole.title}</h1>
        {/*
          NO DOCS LINK IN THIS POSTURE. The reference page on the
          marketing site reads the SAME `VITE_ADMIN_DASHBOARD_PUBLIC`
          flag and redirects to its home page when it is off, so linking
          there from here promised the reader something the very flag
          that produced this state had already taken away.
        */}
        <p role="status">{copy.protocolConsole.hiddenBody}</p>
      </div>
    );
  }

  // The snapshot, when the snapshot is what is shown. A snapshot that
  // could stand in for the chain carries none of the warnings below; they
  // fire only for one shown because the chain read failed too.
  const snap: ProtocolKnobSnapshot | null = reading?.source === 'snapshot' ? reading.snap : null;
  const fallbackGap = reading?.source === 'snapshot' ? (reading.chainReadFailed ?? null) : null;
  const v: ProtocolKnobValues | undefined =
    reading === null ? undefined : reading.source === 'chain' ? reading.values : reading.snap.values;
  const labelsUnavailable = snap?.labelsUnavailable === true;
  // A snapshot older than a day means the refresh rail is wedged. Saying
  // so is the point of the console; quietly rendering day-old governance
  // parameters as current would be the failure this guard exists for.
  //
  // BUT ONLY A REAL AGE EARNS THAT SENTENCE (review round 38 P2). This
  // was `!protocolConfigFresh(...)`, which is equally false for a stamp
  // in the FUTURE — so a skewed producer had the banner assert "more
  // than a day old" beside a provenance line reporting the age as
  // unknown. `resolveSnapshotAge` separates the two, off the same
  // ticking clock the age sentence uses.
  const ageState = snap === null ? null : resolveSnapshotAge(snap.updatedAt, nowSec);
  const stale = ageState === 'stale';
  // UNDATED IS NOT FRESH (review round 3 P2). `fetchProtocolKnobs`
  // deliberately accepts a response with no `updatedAt`, and that case
  // must not read as current. Silence about age is the one thing this
  // page must not do: it exists so a reader knows what they are looking
  // at.
  //
  // ZERO IS A SENTINEL, NOT A TIMESTAMP (review round 8 P2).
  // `markStaleBelow` zeroes `updated_at` when a catch-up scan saw a
  // governance event the row predates, and the endpoint emits
  // `stale: true` alongside it. The honest reading of the sentinel is
  // that the capture time is UNKNOWN and the values are known-behind.
  //
  // AND KNOWN-STALE IS NOT MERELY UNDATED (review round 10 P2). The
  // indexer sets `stale` when a catch-up scan saw a governance event
  // this snapshot predates. That is a positive verdict — the values ARE
  // behind — and strictly stronger than "we cannot tell how old this
  // is".
  const knownStale = snap?.stale === true;
  //
  // AND A FUTURE STAMP BELONGS HERE, NOT UNDER `stale` (round 38 P2).
  // It is a capture time that cannot be one, so the age is unknown —
  // the same thing a missing stamp means and the same advice.
  const undated = !knownStale && ageState === 'unusable-stamp';
  // #2074 — older than the indexer's regular refresh but not yet a day:
  // the day-old banner says nothing yet, and the page must not imply the
  // snapshot is current when it could not check it against the chain.
  const old = fallbackGap === 'old' && !stale;

  return (
    <div className="pc-page">
      <header className="pc-head">
        <h1>
          <SlidersHorizontal aria-hidden="true" /> {copy.protocolConsole.title}
        </h1>
        <p className="pc-sub">
          {copy.protocolConsole.lede(chainId)}
        </p>
        <div className="pc-actions">
          <button type="button" onClick={() => void knobs.refetch()}>
            <RefreshCw aria-hidden="true" /> {copy.protocolConsole.refresh}
          </button>
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            {copy.protocolConsole.reference} <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </header>

      {unavailable && (
        <p className="pc-unavailable" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.unavailable}
        </p>
      )}

      {/* #2074 — the snapshot below was not current and the contracts
          could not be read in its place. Said first, so every warning
          after it reads as a reason the values may be behind. */}
      {fallbackGap !== null && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.chainReadFailed}
        </p>
      )}

      {/* ROUND 65 P2 — a snapshot EXISTS and its numbers cannot be
          trusted to their names. Distinct from `unavailable`, which says
          nothing is there: here the age, the block and the staleness
          verdict below are all real and worth reading, and the values
          are withheld deliberately rather than missing. */}
      {labelsUnavailable && (
        <p className="pc-unavailable" role="status">
          <AlertTriangle aria-hidden="true" />{' '}
          {copy.protocolConsole.labelsUnavailable}
        </p>
      )}

      {knownStale && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.knownStale}
        </p>
      )}

      {undated && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.undated}
        </p>
      )}

      {stale && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.stale}
        </p>
      )}

      {old && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.oldSnapshot}
        </p>
      )}

      {!unavailable && !labelsUnavailable && v && (
        <>
          {/* #2071 — every section and row comes from one list, which the
              coverage check holds against the canonical knob reference. */}
          {CONSOLE_SECTIONS.map((section) => (
            <section key={section.id} className="pc-section" aria-labelledby={section.id}>
              <h2 id={section.id}>{copy.protocolConsole[section.heading]}</h2>
              {section.rows.map((row) => (
                <Row
                  key={row.key}
                  label={copy.protocolConsole[row.label]}
                  value={rowValue(row, v)}
                  notes={[
                    ...(row.hint ? [copy.protocolConsole[row.hint]] : []),
                    // Codex #2683 r3 — a setting whose change emits no event
                    // can lag in the snapshot; the chain read cannot.
                    ...(reading?.source === 'snapshot' && EVENTLESS_PROTOCOL_KNOBS.has(row.key)
                      ? [copy.protocolConsole.eventlessSnapshotNote]
                      : []),
                  ]}
                />
              ))}
            </section>
          ))}

          <section className="pc-section" aria-labelledby="pc-tiers">
            <h2 id="pc-tiers">{copy.protocolConsole.tiersHeading}</h2>
            {/*
              Thresholds are 18-decimal amounts far beyond
              Number.MAX_SAFE_INTEGER, so they are rendered as the strings
              the API sent. Parsing them to floats to "tidy" the display
              would round the very figures this page exists to report.
            */}
            {(v.tierThresholds ?? []).length === 0 ? (
              <Row label={copy.protocolConsole.tiers} value="—" />
            ) : (
              (v.tierThresholds ?? []).map((t, i) => (
                <Row
                  // KEYED BY TIER INDEX, NOT BY VALUE. `ConfigFacet`
                  // permits `e3 <= e4`, so two thresholds may be equal —
                  // a valid governance configuration that gave two rows
                  // the same React key, producing a duplicate-key error
                  // and letting React reuse the wrong row when a later
                  // snapshot changes. On a page whose purpose is
                  // identifying each governance value precisely, the
                  // identity is the tier, not the number in it.
                  key={`tier-${i}`}
                  label={copy.protocolConsole.tierThreshold(i + 1)}
                  value={copy.protocolConsole.tierValue(
                    // BASE UNITS IN, TOKEN UNITS OUT (review round 5 P2),
                    // WITHOUT ROUNDING (round 8 P2). `tierThresholds`
                    // arrives as 18-decimal VPFI base-unit STRINGS, and a
                    // threshold is an arbitrary `uint256` a person chose:
                    // a page that exists so figures can be checked must
                    // not quietly round the figure being checked.
                    // `exactAmountString` is `formatUnits` with no
                    // numeric round-trip.
                    exactDecimal(exactAmountString(BigInt(t), VPFI_DECIMALS)),
                    bps(v.tierDiscountBps?.[i]),
                  )}
                />
              ))
            )}
          </section>
        </>
      )}

      {/* ROUND 66 P2 — OUTSIDE the value-label guard, so a snapshot that
          arrived without labels still states its block and its age.

          #2074 — and it names the source. A chain read states its block,
          when it was taken, and why the snapshot was not used. */}
      {reading?.source === 'chain' && (
        <p className="pc-provenance">
          {copy.protocolConsole.chainProvenance(
            localeNumber(Number(reading.blockNumber), i18n.resolvedLanguage),
            ageText(reading.readAtSec, nowSec),
          )}{' '}
          {chainWhy(reading.why)}
        </p>
      )}
      {snap && (
        <p className="pc-provenance">
          {copy.protocolConsole.provenance}
          {typeof snap.sourceBlock === 'number'
            ? copy.protocolConsole.provenanceBlock(
                localeNumber(snap.sourceBlock, i18n.resolvedLanguage),
              )
            : ''}
          {/* The age rides in the provenance sentence, so it is read
              whenever the source is — not only when a day-old
              threshold trips a warning. */}
          {ageState !== 'unusable-stamp' && typeof snap.updatedAt === 'number'
            ? copy.protocolConsole.provenanceAge(ageText(snap.updatedAt, nowSec))
            : copy.protocolConsole.provenanceAgeUnknown}
          {copy.protocolConsole.provenanceTail}
        </p>
      )}
    </div>
  );
}
