import { useRef, useState, type FormEvent } from 'react';
import { useConfig } from 'wagmi';
import { sendWrite } from '../../shared/tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { readApprovals, readApprovalSubjects, readOverlap, readRow, revokeCall, rowKey, sameOverlap, type ApprovalRow, type Overlap } from '../../shared/approvals/approvals';
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
  /** The other approvals of the same asset, read at the same block. */
  overlap: Overlap;
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
      return sendWrite(config, { ...call, chainId: chain.chainId, account });
    },
    measure: async (_receipt, at) => {
      if (!reviewed) return [];
      const label = format('approvals.leg', { asset: rowAsset(reviewed.row, meta ?? null, copy) });
      const after = await at.read((c, b) => readRow(c, diamond, account, reviewed.row, b.blockNumber));
      return after === null ? [{ status: 'done', label }] : [{ status: 'not-done', label, reason: format('approvals.legStill', { reach: rowReach(after, meta ?? null, copy) }) }];
    },
  });

  // The row and the other approvals of its asset, read at one block.
  const readReview = (c: Parameters<Parameters<typeof own.read>[0]>[0], row: ApprovalRow) =>
    c.getBlockNumber({ cacheTime: 0 }).then(async (block) => {
      const now = await readRow(c, diamond, account, row, block);
      if (now === null) return null;
      return { row: now, overlap: await readOverlap(c, diamond, account, now, s?.rows ?? [], block) };
    });

  // Opening reads the row again, so the receipt stands on a read taken now,
  // never on the list's last poll. Each opening has its own number: closing
  // or opening another retires it, so a late answer for an approval the
  // reader moved away from never replaces the one under review.
  const [loadError, setLoadError] = useState<string | null>(null);
  const opening = useRef(0);
  const open = (row: ApprovalRow) => {
    if (tx.phase.kind !== 'idle') tx.reset();
    setReviewed(null);
    setLoadError(null);
    tx.review();
    const mine = ++opening.current;
    const live = () => mounted.current && opening.current === mine;
    void own.read((c) => readReview(c, row)).then(
      ({ value }) => {
        if (!live()) return;
        if (value === null) setLoadError(text('approvals.already'));
        else setReviewed({ ...value, readAt: Date.now(), identity });
      },
      (e: unknown) => {
        if (live()) setLoadError(refusalFromError(e).reason);
      },
    );
  };

  const close = () => {
    opening.current++;
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
    let now: { row: ApprovalRow; overlap: Overlap } | null;
    try {
      now = (await own.read((c) => readReview(c, reviewed.row))).value;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (now === null) return { kind: 'refused', refusal: { code: 'AlreadySet', reason: text('approvals.already'), reopensAt: null, remedy: null } };
    if (now.row.amount !== reviewed.row.amount || now.row.expiration !== reviewed.row.expiration || !sameOverlap(now.overlap, reviewed.overlap)) {
      if (current()) setReviewed({ ...reviewed, ...now, readAt: Date.now() });
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
            receipt={reviewed ? revokeReceipt(reviewed.row, reviewed.overlap, meta ?? null, copy, { chain: chain.name, readAt: reviewed.readAt }) : null}
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
