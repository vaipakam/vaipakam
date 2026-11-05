import { Link } from 'react-router-dom';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { RewardClaim, pendingText } from '../../shared/claims/RewardClaim';
import { inFinalNotice, readEffectiveTier, readHeldRewards, readPendingRewards, readRewardLowerBound, readSoonestExpiry, readVpfiToken } from '../../shared/claims/rewards';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { useChainRead } from '../../shared/reads/chainRead';
import { tokenAmount, useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { useNow } from '../../shared/ui/useNow';

type Hex = `0x${string}`;

/**
 * RW-71 — the rewards and VPFI summary on Home. In Basic, on the widget:
 * what a claim pays now, labelled exact (the claim run as a preview) or a
 * lower bound (the protocol's conservative view, when the preview cannot
 * run, with the claim withheld), with the claim through the shared flow
 * (RB-CLAIM); the soonest removal estimate, with its final notice and its
 * incomplete-check state (RW-33); and a held balance with its state and
 * release (RW-36). The effective tier is a supporting line; the fee-discount
 * setting is its own section below. Lifetime claimed needs an index route
 * that does not exist yet (#3216), so it is not shown rather than guessed. Rewards
 * are usage rebates, never yield (RL-6).
 */
export function RewardsWidget() {
  const copy = useCopy();
  const { text, format } = copy;
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const enabled = chain !== null;
  const nowMs = useNow(60_000);

  const pending = useOwnRead(['rewardsPending', diamond], (c) => readPendingRewards(c, diamond, account), { enabled });
  // The labelled lower bound, read only when the preview itself cannot run.
  const lower = useOwnRead(['rewardsLowerBound', diamond], (c) => readRewardLowerBound(c, diamond, account), { enabled: enabled && pending.state === 'failed' && pending.data === null });
  const held = useOwnRead(['rewardsHeld', diamond], (c) => readHeldRewards(c, diamond, account), { enabled });
  const expiry = useOwnRead(['rewardsExpiry', diamond], (c) => readSoonestExpiry(c, diamond, account), { enabled });
  const tier = useOwnRead(['rewardsTier', diamond], (c) => readEffectiveTier(c, diamond, account), { enabled });
  const vpfi = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), { enabled });
  const token = vpfi.data && vpfi.data !== '0x0000000000000000000000000000000000000000' ? vpfi.data : null;
  const meta = useTokenMeta(token ? [token] : []).data ?? null;

  if (!own || !chain) return null;
  const amount = (a: bigint) => (token ? tokenAmount(a, token, meta, format) : format('asset.baseUnits', { amount: a.toString(), token: 'VPFI' }));

  // The headline, by one verdict: the exact preview; its refusal, named;
  // or, when no source could run it, the labelled lower bound.
  let headline;
  const p = pending.data;
  if (p?.kind === 'exact') {
    headline = (
      <>
        {/* An exact zero is a claim that still makes progress: the protocol
            refuses a claim that would do nothing, so the claim is offered
            with what it does instead of being withheld (RW-27). */}
        <p className="rewards-figure" data-testid="rewards-pending" data-figure="exact" data-amount={p.amount.toString()}>
          {p.amount > 0n
            ? format('rewards.pendingExact', { amount: amount(p.amount) })
            : format('rewards.pendingZero', { from: p.fromDay.toString(), to: p.toDay.toString() })}
        </p>
        {p.amount > 0n && <p className="tier-b">{format('rewards.pendingDays', { from: p.fromDay.toString(), to: p.toDay.toString() })}</p>}
      </>
    );
  } else if (p) {
    const sentence = pendingText(p, copy);
    headline =
      p.kind === 'none' || p.kind === 'not-started' ? (
        <p className="tier-b" data-testid="rewards-pending" data-figure={p.kind}>
          {sentence}
        </p>
      ) : (
        <Notice tone={p.kind === 'barred' || p.kind === 'refused' ? 'danger' : 'warn'} tier="A">
          <span data-testid="rewards-pending" data-figure={p.kind}>
            {sentence}
          </span>
        </Notice>
      );
  } else if (pending.state === 'failed') {
    headline =
      lower.data !== null ? (
        <Notice tone="warn" tier="A">
          <span data-testid="rewards-pending" data-figure="lower-bound">
            {format('rewards.pendingLower', { amount: amount(lower.data.amount), reason: pending.error ?? 'no answer' })}
          </span>
        </Notice>
      ) : lower.state === 'reading' ? (
        <p className="tier-b">{text('rewards.reading')}</p>
      ) : (
        <Notice tone="warn" tier="A">
          {format('rewards.pendingUnknown', { reason: pending.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={pending.refetch}>
            {text('rewards.retry')}
          </button>
        </Notice>
      );
  } else {
    headline = <p className="tier-b">{text('rewards.reading')}</p>;
  }

  // RW-33: never a date where the network removes nothing, and never "none"
  // where not every reward could be checked.
  let removal = null;
  const e = expiry.data;
  if (e?.kind === 'dark') removal = <p className="tier-b">{text('rewards.expiryDark')}</p>;
  else if (e?.kind === 'none') removal = <p className="tier-b">{text('rewards.expiryNone')}</p>;
  else if (e?.kind === 'incomplete') removal = <Notice tone="warn" tier="A">{text('rewards.expiryIncomplete')}</Notice>;
  else if (e?.kind === 'date') {
    const when = formatUtc(e.at);
    removal = (
      <>
        {inFinalNotice(e.at, Math.floor(nowMs / 1000)) ? (
          <Notice tone="danger" tier="A">
            <span data-final="true">{format('rewards.expiryFinal', { when })}</span>
          </Notice>
        ) : (
          <p className="tier-b">{format('rewards.expiryDate', { when })}</p>
        )}
        {!e.complete && <Notice tone="warn" tier="A">{text('rewards.expiryPartial')}</Notice>}
      </>
    );
  } else if (expiry.state === 'failed') removal = <Notice tone="warn" tier="A">{format('rewards.expiryFailed', { reason: expiry.error ?? 'no answer' })}</Notice>;

  // RW-36: shown only when something is held; a read failure is stated.
  let heldBlock = null;
  const h = held.data;
  if (h && h.held > 0n) {
    heldBlock =
      h.decision === 'deliver' ? (
        <Notice tone="info" tier="A">
          <span data-testid="rewards-held" data-held="ready">
            {format('rewards.heldReady', { amount: amount(h.held) })}
          </span>
        </Notice>
      ) : (
        <Notice tone="warn" tier="A">
          <span data-testid="rewards-held" data-held={h.decision}>
            {format('rewards.heldHolding', { amount: amount(h.held) })}
            {h.decision === 'confirmed' && <> {text('rewards.heldConfirmed')}</>}
          </span>
        </Notice>
      );
  } else if (held.state === 'failed' && h === null) {
    heldBlock = <Notice tone="warn" tier="A">{format('rewards.heldFailed', { reason: held.error ?? 'no answer' })}</Notice>;
  }

  // Every read the section shows, and only those, carries the freshness:
  // a figure kept from an earlier read after a failed refresh is stated as
  // such and counted by the stamp, the tier included (it is a fee claim).
  // The lower bound counts only while it is the headline.
  const shown = [pending, held, expiry, tier, ...(p ? [] : [lower])];
  const stale = shown.some((r) => r.error !== null && r.data !== null);

  return (
    <section className="home-section rewards" aria-labelledby="rewards-title" data-testid="rewards-widget">
      <h2 id="rewards-title">{text('rewards.title')}</h2>
      <WhyLink summaryKey="rewards.rebate" detailKey="rewards.why" vars={{ chain: chain.name }} />
      {headline}
      <RewardClaim kind="interaction" ready={p?.kind === 'exact' ? p : null} token={token} meta={meta} />
      <h3>{text('rewards.expiryTitle')}</h3>
      <div data-testid="rewards-expiry" data-expiry={e?.kind ?? expiry.state}>
        {removal ?? (expiry.state === 'reading' ? <p className="tier-b">{text('rewards.reading')}</p> : null)}
      </div>
      <WhyLink summaryKey="rewards.expiryHow" detailKey="rewards.expiryWhy" />
      {heldBlock && (
        <>
          <h3>{text('rewards.heldTitle')}</h3>
          {heldBlock}
          {h && h.held > 0n && <WhyLink summaryKey="rewards.heldHow" detailKey="rewards.heldWhy" />}
        </>
      )}
      {/* Always mounted: a held claim still open (or just finished) stays on
          screen after the balance it paid has gone to zero. */}
      <RewardClaim kind="held" ready={h && h.held > 0n && h.decision === 'deliver' ? { amount: h.held, fromDay: 0n, toDay: 0n } : null} token={token} meta={meta} />
      <p className="tier-b">{tier.data !== null ? format('rewards.tier', { tier: String(tier.data) }) : tier.state === 'failed' ? text('rewards.tierFailed') : null}</p>
      {stale && <p className="tier-b">{text('rewards.stale')}</p>}
      <OwnStamp reads={shown} />
      <p>
        <Link to="/rewards">{text('rewards.open')}</Link>
      </p>
    </section>
  );
}
