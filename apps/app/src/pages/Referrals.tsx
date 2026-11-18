/**
 * #3727 — the inviter's page (ReferralFeeShareDesign.md section 6.1).
 *
 * Needs only a connected wallet: an inviter needs no vault. Everything
 * below the invite link is read from the indexer's record of the two
 * referral events, and each figure says only what an event stated:
 *  - a wallet's end time is its binding's; whether it has passed is
 *    compared with the chain's latest block, not this browser's clock;
 *  - a share sent to the reserve carries the reason its event gave;
 *  - totals are per asset, never one figure across assets, and are
 *    withheld rather than shown when the indexer could not sum them all.
 * The page states the block it is current to, and says so when that
 * block trails the chain. Amounts are "received", never earnings.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Share2, Users } from 'lucide-react';
import { useModal } from 'connectkit';
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useTokenMeta } from '../contracts/erc20';
import { useChainClock, useReferralSettings } from '../contracts/useReferral';
import {
  REFERRAL_LAG_NOTE_SEC,
  bindingWindow,
  fetchInviterReferrals,
  inviteLink,
  recordLagSec,
  type InviterReferrals,
  type ReferralOutcome,
  type ReferralShareRow,
} from '../data/referrals';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { CopyAddress } from '../components/CopyAddress';
import { formatDate, formatExactSpan, formatTokenAmount, shortAddress } from '../lib/format';
import { useLatestAttempt } from '../lib/useLatestAttempt';

const REASON: Record<Exclude<ReferralOutcome, 'paid' | 'no-share'>, () => string> = {
  'inviter-flagged': () => copy.referrals.reasonFlagged,
  'payment-failed': () => copy.referrals.reasonPaymentFailed,
  'delivered-short': () => copy.referrals.reasonDeliveredShort,
};

export function Referrals() {
  const { isConnected, address, readChain } = useActiveChain();
  const { setOpen } = useModal();
  const settings = useReferralSettings();
  const record = useQuery({
    queryKey: ['inviterReferrals', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: 60_000,
    queryFn: () => fetchInviterReferrals(readChain.chainId, address!),
  });
  const data = record.data ?? null;
  const clock = useChainClock(data?.indexedThroughBlock);

  return (
    <div>
      <h1 className="page-title">{copy.referrals.title}</h1>
      <p className="page-lede">{copy.referrals.lede}</p>

      {!isConnected || !address ? (
        <EmptyState
          icon={Users}
          title={copy.wallet.connectFirst}
          body={copy.referrals.connectBody}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : (
        <div className="stack">
          <InviteLinkCard inviter={address} />
          <p className="muted" style={{ margin: 0 }}>
            {settings.data && settings.data.periodDays > 0
              ? copy.referrals.inviterSentence(settings.data.periodDays)
              : copy.referrals.inviterSentenceNoPeriod}
          </p>
          {record.isLoading ? (
            <EmptyState icon={LoaderCircle} title={copy.referrals.loading} />
          ) : record.isError || data === null ? (
            <UnavailableState body={copy.referrals.unavailable} />
          ) : data.indexedThroughBlock === null ? (
            <UnavailableState body={copy.referrals.notStarted} />
          ) : (
            <RecordView
              data={data}
              explorer={readChain.blockExplorer}
              headTimestamp={clock.data?.headTimestamp ?? null}
              indexedTimestamp={clock.data?.indexedTimestamp ?? null}
            />
          )}
        </div>
      )}
    </div>
  );
}

function InviteLinkCard({ inviter }: { inviter: string }) {
  const link = inviteLink(window.location.origin, inviter);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useLatestAttempt();
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copied = copiedFor === link;

  return (
    <section className="card">
      <h2 className="card-title">{copy.referrals.linkTitle}</h2>
      <p className="mono referral-link">{link}</p>
      <div className="cluster">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={async () => {
            const a = attempt.begin();
            if (timer.current) clearTimeout(timer.current);
            setCopiedFor(null);
            try {
              await navigator.clipboard.writeText(link);
              if (!a.isCurrent()) return;
              setCopiedFor(link);
              timer.current = setTimeout(() => setCopiedFor(null), 1500);
            } catch {
              /* clipboard refused: the link stays visible to copy by hand */
            }
          }}
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? copy.referrals.copied : copy.referrals.copyLink}
        </button>
        {canShare ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              navigator.share({ title: copy.referrals.shareText, url: link }).catch(() => {
                /* dismissed */
              });
            }}
          >
            <Share2 size={16} aria-hidden />
            {copy.referrals.shareLink}
          </button>
        ) : null}
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {copy.referrals.linkHint}
      </p>
    </section>
  );
}

function RecordView({
  data,
  explorer,
  headTimestamp,
  indexedTimestamp,
}: {
  data: InviterReferrals;
  explorer: string;
  headTimestamp: number | null;
  indexedTimestamp: number | null;
}) {
  const lag = recordLagSec(headTimestamp, indexedTimestamp);
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        {copy.referrals.currentTo(String(data.indexedThroughBlock))}
      </p>
      {lag !== null && lag > REFERRAL_LAG_NOTE_SEC ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-body">{copy.referrals.behind(formatExactSpan(lag))}</span>
        </div>
      ) : null}

      <section className="card">
        <h2 className="card-title">{copy.referrals.invitedTitle}</h2>
        {data.invited.rows.length === 0 ? (
          <p className="muted">{copy.referrals.invitedEmpty}</p>
        ) : (
          <div className="row-list">
            {data.invited.rows.map((w) => {
              const win = headTimestamp === null ? null : bindingWindow(w.endsAt, headTimestamp);
              return (
                <div key={w.wallet} className="item-row">
                  <div className="row-main">
                    <div className="row-title">
                      <CopyAddress address={w.wallet} explorerBase={explorer} />
                    </div>
                    <div className="row-sub">
                      {copy.referrals.colJoined}: {formatDate(w.boundAt)} · {copy.referrals.colLoans}:{' '}
                      {w.loansWithShare}
                    </div>
                  </div>
                  <span className={`badge ${win && !win.ended ? 'badge-info' : 'badge-neutral'}`}>
                    {win === null
                      ? copy.referrals.endsOn(formatDate(w.endsAt))
                      : win.ended
                        ? copy.referrals.ended
                        : copy.referrals.daysLeft(win.daysLeft)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {data.invited.truncated ? (
          <p className="muted">{copy.referrals.truncated(data.invited.rows.length)}</p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">{copy.referrals.receivedTitle}</h2>
        {data.received.rows.length === 0 ? (
          <p className="muted">{copy.referrals.receivedEmpty}</p>
        ) : (
          <>
            {data.received.totals === null ? (
              <p className="muted">{copy.referrals.totalsWithheld}</p>
            ) : (
              <div className="referral-totals">
                <div className="row-sub">{copy.referrals.totalsTitle}</div>
                {data.received.totals.map((t) => (
                  <div key={t.asset} className="row-title">
                    <AssetAmount asset={t.asset} amount={t.amount} />
                  </div>
                ))}
              </div>
            )}
            <ShareRows rows={data.received.rows} explorer={explorer} />
          </>
        )}
        {data.received.truncated ? (
          <p className="muted">{copy.referrals.truncated(data.received.rows.length)}</p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">{copy.referrals.reserveTitle}</h2>
        <p className="muted">{copy.referrals.reserveLede}</p>
        {data.sentToReserve.rows.length === 0 ? (
          <p className="muted">{copy.referrals.reserveEmpty}</p>
        ) : (
          <ShareRows rows={data.sentToReserve.rows} explorer={explorer} withReason />
        )}
        {data.sentToReserve.truncated ? (
          <p className="muted">{copy.referrals.truncated(data.sentToReserve.rows.length)}</p>
        ) : null}
      </section>
    </>
  );
}

function ShareRows({
  rows,
  explorer,
  withReason = false,
}: {
  rows: ReferralShareRow[];
  explorer: string;
  withReason?: boolean;
}) {
  return (
    <div className="row-list">
      {rows.map((r) => (
        <div key={`${r.txHash}-${r.loanId}`} className="item-row">
          <div className="row-main">
            <div className="row-title">
              <AssetAmount asset={r.asset} amount={r.share} />
            </div>
            <div className="row-sub">
              {copy.referrals.loanLabel(r.loanId)} · {formatDate(r.settledAt)} ·{' '}
              {shortAddress(r.newUser)}
            </div>
            {withReason && r.outcome !== 'paid' && r.outcome !== 'no-share' ? (
              <div className="row-sub">
                {copy.referrals.colReason}: {REASON[r.outcome]()}
              </div>
            ) : null}
          </div>
          <a
            className="btn btn-ghost btn-sm"
            href={`${explorer}/tx/${r.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {copy.referrals.viewTx}
          </a>
        </div>
      ))}
    </div>
  );
}

/** An amount in the asset it was paid in. An asset whose details cannot
 *  be read is named by address and its amount is not shown, rather than
 *  shown in units the reader cannot interpret. */
function AssetAmount({ asset, amount }: { asset: `0x${string}`; amount: string }) {
  const meta = useTokenMeta(asset);
  if (meta.data) {
    return (
      <>
        {formatTokenAmount(amount, meta.data.decimals)} {meta.data.symbol}
      </>
    );
  }
  if (meta.isError) {
    return (
      <>
        {copy.referrals.assetUnknown} ({shortAddress(asset)})
      </>
    );
  }
  return <LoaderCircle size={14} className="spin" aria-label={copy.referrals.loading} />;
}
