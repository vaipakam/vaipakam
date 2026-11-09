import { useState, type FormEvent } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { readApprovals, readApprovalSubjects, readRow, revokeCall, rowKey, type ApprovalRow } from '../../shared/approvals/approvals';
import { revokeReceipt, rowAsset, rowReach } from '../../shared/approvals/approvalReceipt';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { parsePasted } from '../../shared/offers/assets';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { useTokenMeta } from '../../shared/reads/tokens';
import { simulateCall } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue } from '../../shared/tx/txStore';
import { useMounted } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

/** The approval under review, with the identity it was read under. */
interface Reviewed {
  row: ApprovalRow;
  readAt: number;
  identity: string;
}

/**
 * Settings › Approvals (ACC-32, RB-APPROVALS). The standing approvals this
 * wallet gives the protocol on this network, each with one step that
 * withdraws it. The list is built from what the chain records for this
 * wallet here plus any token the reader adds, so the page states what it
 * checked and never reads a missing row as "no approval".
 */
export function Approvals({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const mounted = useMounted();
  const [added, setAdded] = useStoredValue<Hex[]>(`settings.approvals:added:${chain.chainId}`);
  const extra = added ?? [];
  const scan = useOwnRead(['approvals', diamond, ...extra.map((a) => a.toLowerCase())], async (c) => {
    const subjects = await readApprovalSubjects(c, diamond, account, chain, extra);
    return readApprovals(c, diamond, account, subjects);
  });
  const s = scan.data;
  const meta = useTokenMeta((s?.rows ?? []).map((r) => r.asset)).data;
  const [reviewed, setReviewed] = useStoredValue<Reviewed>('settings.approvals:review');
  const [paste, setPaste] = useState('');
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  const tx = useTrackedTx({
    key: 'settings.approvals',
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!reviewed) throw new Error('no approval under review');
      const call = revokeCall(reviewed.row, diamond);
      return writeContract(config, { ...call, chainId: chain.chainId, account });
    },
    measure: async (_receipt, at) => {
      if (!reviewed) return [];
      const label = format('approvals.leg', { asset: rowAsset(reviewed.row, meta ?? null, copy) });
      const after = await at.read((c, b) => readRow(c, diamond, account, reviewed.row, b.blockNumber));
      return after === null ? [{ status: 'done', label }] : [{ status: 'not-done', label, reason: format('approvals.legStill', { reach: rowReach(after, meta ?? null, copy) }) }];
    },
  });

  // Opening reads the row again, so the receipt stands on a read taken now,
  // never on the list's last poll.
  const [loadError, setLoadError] = useState<string | null>(null);
  const open = (row: ApprovalRow) => {
    if (tx.phase.kind !== 'idle') tx.reset();
    setReviewed(null);
    setLoadError(null);
    tx.review();
    void own.read((c) => readRow(c, diamond, account, row)).then(
      ({ value }) => {
        if (!mounted.current) return;
        if (value === null) setLoadError(text('approvals.already'));
        else setReviewed({ row: value, readAt: Date.now(), identity });
      },
      (e: unknown) => {
        if (mounted.current) setLoadError(refusalFromError(e).reason);
      },
    );
  };

  const close = () => {
    const k = tx.phase.kind;
    if (k === 'review' || k === 'measured' || k === 'failed' || k === 'superseded') tx.reset();
    setReviewed(null);
    setLoadError(null);
    scan.refetch();
  };

  // RB-REVIEW: the row read again right before the wallet opens; withdrawn
  // already, or changed, stops the signature; then the call is simulated.
  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    let now: ApprovalRow | null;
    try {
      now = (await own.read((c) => readRow(c, diamond, account, reviewed.row))).value;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (now === null) return { kind: 'refused', refusal: { code: 'AlreadySet', reason: text('approvals.already'), reopensAt: null, remedy: null } };
    if (now.amount !== reviewed.row.amount || now.expiration !== reviewed.row.expiration) {
      if (current()) setReviewed({ ...reviewed, row: now, readAt: Date.now() });
      return { kind: 'changed', what: text('approvals.changedWhat') };
    }
    return simulateCall(own, revokeCall(reviewed.row, diamond));
  };

  const addToken = async (e: FormEvent) => {
    e.preventDefault();
    const a = parsePasted(paste);
    if (a === null) {
      setPasteNote(text('approvals.addInvalid'));
      return;
    }
    if (extra.some((x) => x.toLowerCase() === a.toLowerCase())) {
      setPasteNote(text('approvals.addAlready'));
      return;
    }
    try {
      const code = (await own.read((c) => c.getCode({ address: a }))).value;
      if (code === undefined || code === '0x') {
        setPasteNote(format('approvals.addNoCode', { chain: chain.name }));
        return;
      }
    } catch (err) {
      setPasteNote(format('approvals.addFailed', { reason: refusalFromError(err).reason }));
      return;
    }
    setAdded([...extra, a]);
    setPaste('');
    setPasteNote(text('approvals.addDone'));
  };

  const flowOpen = tx.phase.kind === 'review' || holdsFlow(tx.phase);

  return (
    <section className="home-section" aria-labelledby="settings-approvals" data-testid="settings-approvals">
      <h2 id="settings-approvals">{text('approvals.title')}</h2>
      <p className="tier-b">{format('approvals.lead', { chain: chain.name })}</p>
      {s === null && scan.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('approvals.failed', { reason: scan.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={scan.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {s === null && scan.state !== 'failed' && <p className="tier-b">{text('approvals.reading')}</p>}
      {s !== null && !flowOpen && (
        <>
          {s.rows.length > 0 ? (
            <ul className="approval-rows" data-testid="settings-approval-rows">
              {s.rows.map((r) => (
                <li key={rowKey(r)} data-kind={r.kind} data-asset={r.asset.toLowerCase()} data-testid="settings-approval-row">
                  <p className="tier-a">{rowAsset(r, meta ?? null, copy)}</p>
                  <p className="tier-b">{rowReach(r, meta ?? null, copy)}</p>
                  <p className="actions">
                    <button type="button" className="btn" onClick={() => open(r)} data-testid="settings-approval-revoke">
                      {text('approvals.revoke')}
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tier-a" data-testid="settings-approvals-none">
              {format('approvals.none', { count: String(s.checked) })}
            </p>
          )}
          <p className="tier-b" data-testid="settings-approvals-scope">
            {format('approvals.scope', { count: String(s.checked) })}
          </p>
          {!s.complete && <Notice tone="warn" tier="A">{text('approvals.incomplete')}</Notice>}
          {s.unreadable > 0 && <Notice tone="warn" tier="A">{format('approvals.unreadable', { count: String(s.unreadable) })}</Notice>}
          {!s.permit2 && <p className="tier-b">{text('approvals.noPermit2')}</p>}
          {scan.error !== null && <p className="tier-b">{format('approvals.stale', { reason: scan.error })}</p>}
          <form className="approval-add" onSubmit={(e) => void addToken(e)} data-testid="settings-approvals-add">
            <label htmlFor="approvals-add-input">{text('approvals.addLabel')}</label>
            <div className="approval-add-row">
              <input
                id="approvals-add-input"
                value={paste}
                onChange={(e) => {
                  setPaste(e.target.value);
                  setPasteNote(null);
                }}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="btn">
                {text('approvals.addButton')}
              </button>
            </div>
            {pasteNote !== null && (
              <p className="tier-b" role="status" data-testid="settings-approvals-add-note">
                {pasteNote}
              </p>
            )}
          </form>
        </>
      )}
      {flowOpen && (
        <div className="risk-step" data-testid="settings-approvals-flow">
          {loadError !== null && (
            <Notice tone="warn" tier="A">
              {loadError}{' '}
              <button type="button" className="btn" onClick={close}>
                {text('approvals.back')}
              </button>
            </Notice>
          )}
          <ActionFlow
            tx={tx}
            identity={identity}
            reviewedFor={reviewed?.identity ?? tx.frozen?.identity ?? identity}
            receipt={reviewed ? revokeReceipt(reviewed.row, meta ?? null, copy, { chain: chain.name, readAt: reviewed.readAt }) : null}
            recheck={recheck}
            describeAsset={() => null}
            explorer={chain.blockExplorer}
            next={null}
            after={() => (
              <p className="actions">
                <button type="button" className="btn btn-primary" onClick={close} data-testid="settings-approvals-done">
                  {text('approvals.back')}
                </button>
              </p>
            )}
            onClose={close}
          />
        </div>
      )}
      <WhyLink summaryKey="approvals.whySummary" detailKey="approvals.why" />
    </section>
  );
}
