/**
 * #3722 — where an invite link lands: `/invite/:inviter`.
 *
 * The binding is the new user's own transaction (`bindInviter`), made
 * once and never changeable, so the page states first what it carries,
 * with the rates read from the chain at that moment
 * (ReferralFeeShareDesign.md section 6), and asks before binding. When the
 * cut is zero it says nothing is taken off rather than describe a benefit.
 * Opening the link records nothing; nothing about the visit is kept.
 *
 * The page refuses what the contract would refuse, before a signature:
 * an invalid link, the inviter's own wallet, a wallet already bound, and
 * a wallet that has opened a loan as borrower. Anything else the contract
 * refuses (the platform's own addresses, an integrator) comes back as the
 * transaction's error.
 */
import { useState } from 'react';
import { LoaderCircle, UserPlus } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useModal } from 'connectkit';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { isAddressLike } from '../contracts/erc20';
import {
  ZERO_ADDRESS,
  useChainClock,
  useReferralSettings,
  useWalletReferral,
  walletReferralKey,
} from '../contracts/useReferral';
import { bindingWindow } from '../data/referrals';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { CopyAddress } from '../components/CopyAddress';
import { formatBpsAsPercent, formatDate, shortAddress } from '../lib/format';
import { submitErrorText } from '../lib/errors';

export function Invite() {
  const { inviter: raw = '' } = useParams();
  const valid = isAddressLike(raw);
  const { isConnected, address, readChain, onSupportedChain } = useActiveChain();
  const { setOpen } = useModal();
  const settings = useReferralSettings();
  const mine = useWalletReferral(valid ? address : undefined);
  const clock = useChainClock(null);
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const header = (
    <h1 className="page-title" style={{ marginBottom: 'var(--space-4)' }}>
      {copy.invite.title}
    </h1>
  );

  if (!valid) {
    return (
      <div>
        {header}
        <UnavailableState body={copy.invite.invalid} />
      </div>
    );
  }
  const inviter = raw as `0x${string}`;
  const inviterChip = <CopyAddress address={inviter} explorerBase={readChain.blockExplorer} />;

  if (!isConnected || !address) {
    return (
      <div>
        {header}
        <section className="card">
          <p style={{ margin: 0 }}>
            {copy.invite.invitedBy} {inviterChip}
          </p>
        </section>
        <EmptyState
          icon={UserPlus}
          title={copy.wallet.connectFirst}
          body={copy.invite.connectBody}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      </div>
    );
  }

  if (address.toLowerCase() === inviter.toLowerCase()) {
    return (
      <div>
        {header}
        <div className="banner banner-info" role="status">
          <span className="banner-body">{copy.invite.selfInvite}</span>
        </div>
      </div>
    );
  }

  if (mine.isLoading || settings.isLoading) {
    return (
      <div>
        {header}
        <EmptyState icon={LoaderCircle} title={copy.invite.loading} />
      </div>
    );
  }
  if (!mine.data || !settings.data) {
    return (
      <div>
        {header}
        <UnavailableState body={copy.invite.unavailable} />
      </div>
    );
  }

  const bound = mine.data.inviter.toLowerCase() !== ZERO_ADDRESS;
  if (bound || done) {
    const win = clock.data ? bindingWindow(mine.data.endsAt, clock.data.headTimestamp) : null;
    const boundInviter = shortAddress(mine.data.inviter);
    return (
      <div>
        {header}
        {done ? (
          <div className="banner banner-info" role="status">
            <span className="banner-body">{copy.invite.done}</span>
          </div>
        ) : null}
        {bound ? (
          <section className="card">
            <p style={{ margin: 0 }}>
              {win?.ended
                ? copy.invite.alreadyBoundEnded(boundInviter, formatDate(mine.data.endsAt))
                : copy.invite.alreadyBound(boundInviter, formatDate(mine.data.endsAt))}
            </p>
            {!done && mine.data.inviter.toLowerCase() !== inviter.toLowerCase() ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                {copy.invite.alreadyBoundOther}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    );
  }

  if (mine.data.hasBorrowed) {
    return (
      <div>
        {header}
        <div className="banner banner-info" role="status">
          <span className="banner-body">{copy.invite.hasBorrowed}</span>
        </div>
      </div>
    );
  }

  const s = settings.data;
  const sentence =
    s.cutBps > 0
      ? copy.invite.sentence(shortAddress(inviter), s.periodDays, formatBpsAsPercent(s.cutBps))
      : copy.invite.nothingOff(shortAddress(inviter), s.periodDays);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await write('bindInviter', [inviter]);
      setDone(true);
      await queryClient.invalidateQueries({
        queryKey: walletReferralKey(readChain.chainId, address),
      });
    } catch (e) {
      setError(submitErrorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {header}
      <section className="card">
        <p style={{ marginTop: 0 }}>
          {copy.invite.invitedBy} {inviterChip}
        </p>
        <p>{sentence}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void confirm()}
          disabled={submitting || !onSupportedChain}
        >
          {submitting ? copy.invite.confirming : copy.invite.confirm}
        </button>
        {!onSupportedChain ? <p className="muted">{copy.invite.wrongNetwork}</p> : null}
        {error ? (
          <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}
      </section>
    </div>
  );
}
