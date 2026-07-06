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
 * client-state purge, no advanced-mode gating — the button is there
 * for everyone precisely because the least technical users are the
 * ones who need a "report a problem" affordance. Probes only run
 * while the drawer is OPEN (nothing polls in the background).
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { LifeBuoy, X } from 'lucide-react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import {
  fetchIndexerFreshness,
  indexerConfigured,
} from '../data/indexer';
import { readLastError } from '../diagnostics/lastError';
import {
  buildIssueUrl,
  buildReportBody,
  redactAddress,
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
  const [copied, setCopied] = useState(false);
  const { pathname } = useLocation();
  const { address, isConnected, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  // Close on Escape — the drawer is a dialog and must behave like one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Reachability = "did the latest block-number read succeed". Only
  // polled while the drawer is open; gcTime 0 drops the cached answer
  // when it closes, so a reopen during an outage starts from
  // "Checking…" instead of a stale healthy block.
  const rpc = useQuery({
    queryKey: ['diag', 'rpc', readChain.chainId],
    enabled: open && Boolean(publicClient),
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
    enabled: open && indexerConfigured(),
    refetchInterval: INDEXER_POLL_MS,
    retry: false,
    gcTime: 0,
    queryFn: () => fetchIndexerFreshness(readChain.chainId),
  });

  // Error-first: a failed LATEST probe outranks a previously cached
  // block — "Working" must describe now, not thirty seconds ago.
  const rpcLine = rpc.error
    ? copy.diagnostics.rpcFailing
    : rpc.data
      ? copy.diagnostics.rpcOk(rpc.data.block)
      : copy.diagnostics.rpcChecking;
  const rpcTone = rpc.error ? 'warn' : rpc.data ? 'ok' : 'muted';

  let indexerLine: string;
  let indexerTone: 'ok' | 'warn' | 'muted';
  if (!indexerConfigured()) {
    indexerLine = copy.diagnostics.indexerNotConfigured;
    indexerTone = 'muted';
  } else if (freshness.data) {
    const ageSec = Math.max(
      0,
      Math.floor(Date.now() / 1000) - freshness.data.updatedAt,
    );
    if (ageSec < INDEXER_STALE_AFTER_SEC) {
      indexerLine = copy.diagnostics.indexerOk(formatAge(ageSec));
      indexerTone = 'ok';
    } else {
      indexerLine = copy.diagnostics.indexerStale(formatAge(ageSec));
      indexerTone = 'warn';
    }
  } else if (freshness.isFetched) {
    indexerLine = copy.diagnostics.indexerUnreachable;
    indexerTone = 'warn';
  } else {
    indexerLine = copy.diagnostics.rpcChecking;
    indexerTone = 'muted';
  }

  const buildHash = (import.meta.env.VITE_BUILD_HASH as string | undefined) ?? 'dev';
  const buildTime = import.meta.env.VITE_BUILD_TIME as string | undefined;
  const lastError = open ? readLastError() : null;

  const reportCtx = useMemo(
    () => ({
      path: pathname,
      chainName: readChain.name,
      chainId: readChain.chainId,
      walletRedacted: isConnected ? redactAddress(address) : 'not connected',
      rpcStatusLine: rpcLine,
      indexerStatusLine: indexerLine,
      buildHash,
      buildTime,
      lastError,
    }),
    [
      pathname,
      readChain.name,
      readChain.chainId,
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

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(buildReportBody(reportCtx));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard blocked — the GitHub link still carries the details */
    }
  };

  return (
    <>
      <button
        type="button"
        className="diag-fab"
        aria-label={copy.diagnostics.open}
        title={copy.diagnostics.open}
        onClick={() => setOpen(true)}
      >
        <LifeBuoy aria-hidden />
      </button>

      {open ? (
        <>
          <div className="diag-overlay" onClick={() => setOpen(false)} />
          <aside
            className="diag-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={copy.diagnostics.title}
          >
            <div className="diag-head">
              <h2 style={{ margin: 0 }}>{copy.diagnostics.title}</h2>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={copy.diagnostics.close}
                onClick={() => setOpen(false)}
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
                <dd>
                  {readChain.name} ({readChain.chainId})
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
                    <span className="mono" style={{ fontSize: 12 }}>
                      {lastError.message}
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
              <button
                type="button"
                className="btn btn-secondary"
                onClick={copyDetails}
              >
                {copied ? copy.diagnostics.copied : copy.diagnostics.copyDetails}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              {copy.diagnostics.reportHint}
            </p>
          </aside>
        </>
      ) : null}
    </>
  );
}
