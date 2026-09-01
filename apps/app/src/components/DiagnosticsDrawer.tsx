/**
 * Support drawer — the diagnostics + report-issue surface
 * (#1028 item 4, the lightweight port of defi's DiagnosticsDrawer).
 *
 * A small floating "Support" button opens a slide-over that answers
 * the naive user's real questions when something feels broken: is the
 * blockchain connection working, is the market-data cache fresh,
 * which network and build am I on — and gives two exits: a pre-filled
 * GitHub issue (redacted: shortened wallet, capped error text, no
 * user agent) and copy-to-clipboard for people without GitHub.
 *
 * Deliberately lighter than defi's: no journey-log timeline, no
 * advanced-mode gating — the button is there for everyone precisely
 * because the least technical users are the ones who need a "report a
 * problem" affordance.
 *
 * The missing JOURNEY LOG is a decision, not a gap (#1960 asked for it
 * to be recorded either way): the ring buffer was replaced by the
 * one-slot sink in `diagnostics/lastError.ts`, because this product
 * needs "what just broke" attached to a support report rather than a
 * forensic timeline. There is therefore nothing here to export.
 *
 * The missing CLIENT-STATE PURGE was a gap, and #1960 closed it
 * elsewhere: erasing local state is a data RIGHT, not a support tool,
 * so it lives on `/data-rights` where the consequences can be spelled
 * out before anyone presses anything — not behind a support button
 * whose other controls are all non-destructive.
 *
 * The probes live in DrawerPanel, which mounts ONLY while the drawer
 * is open: with the observers unmounted, gcTime 0 actually clears the
 * cached verdicts on close (an enabled:false toggle on a mounted
 * observer would keep them — round 2), so a reopen during an outage
 * starts from "Checking…", never a stale healthy block. Nothing
 * polls while closed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { LifeBuoy, X } from 'lucide-react';
import { copy } from '../content/copy';
import { SupportTicketCard } from './SupportTicketCard';
import { useLatestAttempt } from '../lib/useLatestAttempt';
import { useActiveChain } from '../chain/useActiveChain';
import { indexerConfigured, probeIndexerFreshness } from '../data/indexer';
import { readLastError } from '../diagnostics/lastError';
import { useNowSec } from '../hooks/useNowSec';
import {
  buildIssueUrl,
  buildSentPreview,
  redactAddress,
  redactCap,
} from '../diagnostics/reportIssue';

/** Same staleness bar as MarketFreshnessNote: a cache cursor older
 *  than this stops counting as "up to date". */
const INDEXER_STALE_AFTER_SEC = 30 * 60;
const RPC_POLL_MS = 15_000;
const INDEXER_POLL_MS = 30_000;

function formatAge(sec: number): string {
  if (sec < 90) return 'moments';
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

export function DiagnosticsDrawer() {
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  // Restore focus to the Support button when the dialog closes — a
  // tick later, so the panel's cleanup has removed `inert` from the
  // app root (an inert element refuses focus).
  const close = () => {
    setOpen(false);
    setTimeout(() => fabRef.current?.focus(), 0);
  };

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="diag-fab"
        aria-label={copy.diagnostics.open}
        title={copy.diagnostics.open}
        onClick={() => setOpen(true)}
      >
        <LifeBuoy aria-hidden />
      </button>
      {open ? <DrawerPanel onClose={close} /> : null}
    </>
  );
}

function DrawerPanel({ onClose }: { onClose: () => void }) {
  // Three states, not a boolean: "did not copy" and "copied" are not the only
  // outcomes, and the old boolean could only ever say nothing about the third.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const [showReport, setShowReport] = useState(false);
  const { pathname, search } = useLocation();
  const { address, isConnected, readChain, onSupportedChain } =
    useActiveChain();
  // The RAW wallet chain id — readChain deliberately falls back to
  // DEFAULT_CHAIN for unsupported wallets, and hiding that fallback
  // here would misstate the one fact support needs when writes are
  // blocked (round 5).
  const { chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Honour aria-modal for assistive tech, not just Tab: the app root
  // is made inert (and aria-hidden) while the panel — rendered into a
  // PORTAL outside it — is up, so screen readers can't wander the
  // obscured page (round 6). The Tab trap below stays as a fallback
  // for browsers without inert support.
  useEffect(() => {
    const appRoot = document.getElementById('root');
    if (!appRoot) return;
    appRoot.setAttribute('inert', '');
    appRoot.setAttribute('aria-hidden', 'true');
    return () => {
      appRoot.removeAttribute('inert');
      appRoot.removeAttribute('aria-hidden');
    };
  }, []);

  // Dialog semantics: initial focus lands inside, Escape closes, and
  // Tab is contained while aria-modal declares the page inert.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const nodes = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      // Wrap at the edges; re-enter the dialog if focus escaped.
      if (!drawerRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reachability = "did the latest block-number read succeed".
  const rpc = useQuery({
    queryKey: ['diag', 'rpc', readChain.chainId],
    enabled: Boolean(publicClient),
    refetchInterval: RPC_POLL_MS,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const block = await publicClient!.getBlockNumber();
      return { block: block.toString() };
    },
  });

  const freshness = useQuery({
    queryKey: ['diag', 'indexerFreshness', readChain.chainId],
    enabled: indexerConfigured(),
    refetchInterval: INDEXER_POLL_MS,
    retry: false,
    gcTime: 0,
    queryFn: () => probeIndexerFreshness(readChain.chainId),
  });

  // Error-first: a failed LATEST probe outranks a previously cached
  // block — "Working" must describe now, not thirty seconds ago.
  const rpcLine = rpc.error
    ? copy.diagnostics.rpcFailing
    : rpc.data
      ? copy.diagnostics.rpcOk(rpc.data.block)
      : copy.diagnostics.rpcChecking;
  const rpcTone = rpc.error ? 'warn' : rpc.data ? 'ok' : 'muted';

  // Ticks, so the age this drawer reports keeps counting while it is open
  // rather than freezing at whatever it read on the render that opened it.
  const nowSec = useNowSec();

  let indexerLine: string;
  let indexerTone: 'ok' | 'warn' | 'muted';
  if (!indexerConfigured()) {
    indexerLine = copy.diagnostics.indexerNotConfigured;
    indexerTone = 'muted';
  } else if (freshness.data?.kind === 'cursor') {
    const ageSec = Math.max(0, nowSec - freshness.data.freshness.updatedAt);
    if (ageSec < INDEXER_STALE_AFTER_SEC) {
      indexerLine = copy.diagnostics.indexerOk(formatAge(ageSec));
      indexerTone = 'ok';
    } else {
      indexerLine = copy.diagnostics.indexerStale(formatAge(ageSec));
      indexerTone = 'warn';
    }
  } else if (freshness.data?.kind === 'no-cursor') {
    // Reachable but this chain has no ingest cursor yet — a fresh
    // deployment, not an outage (round 2).
    indexerLine = copy.diagnostics.indexerNoCursor;
    indexerTone = 'muted';
  } else if (freshness.data?.kind === 'unreachable') {
    indexerLine = copy.diagnostics.indexerUnreachable;
    indexerTone = 'warn';
  } else {
    indexerLine = copy.diagnostics.rpcChecking;
    indexerTone = 'muted';
  }

  const buildHash = (import.meta.env.VITE_BUILD_HASH as string | undefined) ?? 'dev';
  const buildTime = import.meta.env.VITE_BUILD_TIME as string | undefined;
  const lastError = readLastError();
  // Search params carry the deep-link state (?offer=, ?chain=) that
  // reproduces route-specific problems; the builder redacts + caps.
  const page = pathname + search;

  // A connected wallet on an unsupported chain must be reported AS
  // that — readChain's DEFAULT_CHAIN fallback is a read-targeting
  // rule, not the wallet's actual network (round 5).
  const walletOnUnsupported = isConnected && !onSupportedChain;
  const networkLine = walletOnUnsupported
    ? copy.diagnostics.networkUnsupported(
        walletChainId === undefined ? copy.common.unknown : String(walletChainId),
        readChain.name,
        readChain.chainId,
      )
    : `${readChain.name} (${readChain.chainId})`;

  const reportCtx = useMemo(
    () => ({
      path: page,
      networkLine,
      walletRedacted: isConnected ? redactAddress(address) : 'not connected',
      rpcStatusLine: rpcLine,
      indexerStatusLine: indexerLine,
      buildHash,
      buildTime,
      lastError,
    }),
    [
      page,
      networkLine,
      isConnected,
      address,
      rpcLine,
      indexerLine,
      buildHash,
      buildTime,
      lastError,
    ],
  );
  const issueUrl = useMemo(() => buildIssueUrl(reportCtx), [reportCtx]);

  // #2023 — the report body is rendered locally, and the clipboard is a
  // convenience on top of it rather than the only way to see it.
  //
  // WHY THIS IS NOT A MISSING TOAST. Opening the report is a `<a href>` to a
  // pre-filled GitHub issue, so the diagnostics — last error, component
  // trace, route, network, redacted wallet — reach GitHub the MOMENT the form
  // opens, whether or not an issue is ever filed. The drawer's own summary is
  // partial (it shows 300 characters of the error and no trace at all, where
  // the report carries up to 1200 and 1000). So "copy it, read it, then
  // decide whether GitHub may have it" was the only ordering that let someone
  // check before disclosing — and `navigator.clipboard.writeText` REJECTS in
  // an insecure context, a hardened browser, or on a denied permission. The
  // old catch swallowed that: no clipboard content, no error, not even a
  // change of button label. The only remaining way to inspect the payload was
  // the action that discloses it.
  //
  // Its comment said so inadvertently — "the GitHub link still carries the
  // details" is true, and that link is precisely what the user was trying to
  // evaluate before taking it.
  // WHAT IS ACTUALLY SENT, not the untrimmed body (#2043 round 3 P2).
  // `buildIssueUrl` drops the component stack, then the whole error block,
  // whenever the encoded URL crosses its length ceiling — so on the largest
  // crashes the report GitHub receives is SHORTER than `buildReportBody`.
  // Previewing the untrimmed text showed content that would never travel and
  // made the Privacy Policy's "displays exactly what would be sent" false for
  // exactly the reports where it matters most. Both this and the link now
  // read the same trimming decision.
  const reportBody = useMemo(() => buildSentPreview(reportCtx), [reportCtx]);
  // The pending "copied" reset. Held so a later attempt can cancel it
  // (#2043 round 3 P2): the old timer fired unconditionally, so a copy
  // followed by a second attempt inside two seconds had the FIRST timer reset
  // the SECOND attempt's state — a failure message that vanished almost
  // immediately, or a confirmation cut to a fraction of its intended life.
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // AND an attempt generation (#2043 round 4 P2). Cancelling the reset timer
  // orders the TIMERS and does nothing about the promises: a double-click or
  // a retry leaves two clipboard writes in flight, and whichever settles last
  // wins regardless of which was started last. So a newer success could be
  // replaced by an older rejection — reporting failure and opening the
  // fallback over a clipboard that genuinely holds the report — or an older
  // success could hide a newer failure.
  //
  // Shared with three other call sites through `useLatestAttempt` (#2044):
  // #2043 fixed this same defect four times in two files, each fix its own,
  // which is what said the rule wanted to be a thing rather than a habit.
  const copyAttempt = useLatestAttempt();
  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );
  const copyDetails = async () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    const attempt = copyAttempt.begin();
    try {
      await navigator.clipboard.writeText(reportBody);
      if (!attempt.isCurrent()) return;
      setCopyState('copied');
      copyResetTimer.current = setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      if (!attempt.isCurrent()) return;
      // NOT SILENT, and not a dead end either: the failure is stated AND the
      // disclosure is opened, so the text the clipboard refused to take is
      // on screen and selectable. Telling someone it failed while leaving
      // them no way to read the report would fix the honesty and not the
      // problem.
      setCopyState('failed');
      setShowReport(true);
    }
  };

  // Portal to document.body: the panel must live OUTSIDE the app root
  // so making that root inert can't inert the dialog itself.
  return createPortal(
    <>
      <div className="diag-overlay" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="diag-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={copy.diagnostics.title}
      >
        <div className="diag-head">
          <h2 style={{ margin: 0 }}>{copy.diagnostics.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={copy.diagnostics.close}
            onClick={onClose}
          >
            <X aria-hidden />
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {copy.diagnostics.lede}
        </p>

        <dl className="diag-rows">
          <div className="diag-row">
            <dt>{copy.diagnostics.network}</dt>
            <dd className={walletOnUnsupported ? 'diag-warn' : undefined}>
              {networkLine}
            </dd>
          </div>
          <div className="diag-row">
            <dt>{copy.diagnostics.wallet}</dt>
            <dd>
              {isConnected
                ? redactAddress(address)
                : copy.diagnostics.walletNotConnected}
            </dd>
          </div>
          <div className="diag-row">
            <dt>{copy.diagnostics.rpc}</dt>
            <dd className={`diag-${rpcTone}`}>{rpcLine}</dd>
          </div>
          <div className="diag-row">
            <dt>{copy.diagnostics.indexer}</dt>
            <dd className={`diag-${indexerTone}`}>{indexerLine}</dd>
          </div>
          <div className="diag-row">
            <dt>{copy.diagnostics.build}</dt>
            <dd className="mono">
              {buildHash}
              {buildTime ? ` · ${buildTime}` : ''}
            </dd>
          </div>
          <div className="diag-row">
            <dt>{copy.diagnostics.lastErrorTitle}</dt>
            <dd>
              {lastError ? (
                // Same redaction AND cap as the report — the on-screen
                // row is part of the "full address appears nowhere"
                // contract (round 3), and a huge serialized error must
                // not make the panel unwieldy right when the user is
                // trying to report it (round 6).
                <span className="mono" style={{ fontSize: 12 }}>
                  {redactCap(lastError.message, 300)}
                </span>
              ) : (
                copy.diagnostics.noError
              )}
            </dd>
          </div>
        </dl>

        <div className="cluster" style={{ marginTop: 16 }}>
          <a
            className="btn btn-primary"
            href={issueUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.diagnostics.report}
          </a>
          <button type="button" className="btn btn-secondary" onClick={copyDetails}>
            {copyState === 'copied'
              ? copy.diagnostics.copied
              : copy.diagnostics.copyDetails}
          </button>
        </div>
        {copyState === 'failed' ? (
          <p className="muted" style={{ fontSize: 13 }} role="status">
            {copy.diagnostics.copyFailed}
          </p>
        ) : null}
        {/* The preview, and the reason the whole change exists: this is what
            travels to GitHub, readable BEFORE the link above is taken. Plain
            markup rather than a `<textarea>` — it is text to read, not to
            edit, and a read-only textarea sized to a 2 kB report either
            scrolls in a small box or dominates the drawer. */}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={showReport}
          aria-controls="diag-report-body"
          onClick={() => setShowReport((open) => !open)}
        >
          {showReport
            ? copy.diagnostics.hideReport
            : copy.diagnostics.showReport}
        </button>
        {showReport ? (
          // A READ-ONLY TEXTAREA, not a `<pre>` (#2043 round 2 P2). The
          // failure message tells the reader to select the report and copy it
          // by hand, and a `<pre>` is not in the tab order — so a
          // keyboard-only user tabbed straight past the thing they had just
          // been told to select, and the only route left was the action that
          // discloses the report to GitHub. That is the exact dead end this
          // whole change exists to remove, reintroduced for the people least
          // able to work around it.
          //
          // A textarea is focusable, selectable with Ctrl/Cmd-A once focused,
          // and announces itself. `readOnly` rather than `disabled`: a
          // disabled control is skipped by the tab order too, which would
          // reproduce the defect with different markup.
          <textarea
            id="diag-report-body"
            className="mono"
            readOnly
            value={reportBody}
            aria-label={copy.diagnostics.showReport}
            rows={12}
            style={{
              width: '100%',
              fontSize: 12,
              resize: 'vertical',
              whiteSpace: 'pre',
            }}
          />
        ) : null}
        <p className="muted" style={{ fontSize: 13 }}>
          {copy.diagnostics.reportHint}
        </p>

        {/* #1040 phase 1 — ticket capture with explicit attach
            consent. The chain id travels with EVERY ticket (the
            pre-send disclosure says so): on a supported network
            it's the read chain; on an unsupported one it's the
            wallet's RAW chain id — exactly the fact support needs
            for an unsupported-network report, and it must not
            depend on the diagnostics consent (Codex round-5 P2). */}
        <SupportTicketCard
          reportCtx={reportCtx}
          chainId={
            walletOnUnsupported ? (walletChainId ?? null) : readChain.chainId
          }
        />
      </aside>
    </>,
    document.body,
  );
}
