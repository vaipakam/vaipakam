import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig } from 'wagmi';
import { signTypedData } from 'wagmi/actions';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../../shared/copy/useCopy';
import {
  identityOf,
  listSignedOrder,
  readSignReview,
  refusalSentence,
  signBlockers,
  signNewReceipt,
  type SignBlocker,
  type SignDraft,
  type SignedRecord,
} from '../../shared/desk/signNew';
import { SIGNED_OFFER_TYPES, signedOfferDomain, typedMessage, type BookAnswer } from '../../shared/desk/signedOrder';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { GUIDE_ORIGIN, guideUrl } from '../../shared/help/guide';
import { RISK_GUIDE } from '../../shared/post/postCopy';
import { worldKey } from '../../shared/reads/identityKey';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { termsUrl, type TermsState } from '../../shared/terms/terms';
import { useStoredValue } from '../../shared/tx/txStore';
import { useMounted } from '../../shared/tx/useReviewRefresh';
import { Notice } from '../../shared/ui/Notice';
import { Receipt } from '../../shared/ui/Receipt';
import { shortAddress } from '../../shared/ui/format';
import { useNow } from '../../shared/ui/useNow';
import { useMode } from '../../app/ModeContext';

type Hex = `0x${string}`;

/** Where the page's own step stands: the review, the wallet asked, or the
 *  wallet's refusal. */
type Phase = { kind: 'review' } | { kind: 'signing' } | { kind: 'not-signed'; reason: string };

/** The book's side of the flow, kept above the router with the signed
 *  order: a page left while the book is asked finds it there again, and its
 *  answer, when it comes back. */
type BookStep = { orderHash: Hex; step: 'listing' } | { orderHash: Hex; step: 'answered'; answer: BookAnswer };

const BLOCKER_TEXT: Readonly<Record<SignBlocker, Parameters<CopyAccess['text']>[0]>> = {
  'no-book': 'signNew.noBook',
  identity: 'signNew.identityMoved',
  lapsed: 'signNew.lapsed',
};

/**
 * OFF-59 — the review and the signature for a new signed order from the
 * desk's ticket. The receipt states the order the wallet signs, that
 * nothing is set aside, what a fill draws from the signer's own vault and
 * what the vault holds free of it now, and that only an on-chain cancel
 * stops the order before it lapses. One consent to the Risk Disclosures and
 * Terms (the signature is the maker's consent at fill), one wallet prompt,
 * then one POST to the offer book, whose answer is stated as it came:
 * listed, refused with its reason, or unknown with a way to send it again.
 */
export function SignOrder({
  flowKey,
  sign,
  chain,
  own,
  meta,
  terms,
  copy,
  onEdit,
  onClose,
}: {
  flowKey: string;
  sign: SignDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  copy: CopyAccess;
  onEdit: () => void;
  /** `listed`: the book listed the order, so the ticket starts afresh. */
  onClose: (listed: boolean) => void;
}) {
  const { text, format } = copy;
  const config = useConfig();
  const world = useWorldRail();
  const queryClient = useQueryClient();
  const { mode } = useMode();
  const nowMs = useNow();
  const mounted = useMounted();
  const diamond = chain.diamondAddress as Hex;
  const identity = identityOf(own.chainId, own.account);
  const [record, setRecord] = useStoredValue<SignedRecord>(`${flowKey}:signed`);
  const [consentFor, setConsentFor] = useStoredValue<string>(`${flowKey}:signConsent`);
  const [stored, setBook] = useStoredValue<BookStep>(`${flowKey}:signBook`);
  const book = stored !== null && stored.orderHash === sign.orderHash ? stored : null;
  const [phase, setPhase] = useState<Phase>({ kind: 'review' });
  const busy = phase.kind === 'signing' || book?.step === 'listing';

  const read = useOwnRead(['deskSign', sign.orderHash], (c) => readSignReview(c, diamond, sign.order), { enabled: identity === sign.identity });
  const review = read.data;
  const blockers = signBlockers(sign, review, { identity, bookConfigured: world.indexer.origin !== null });
  const consented = consentFor === sign.orderHash;

  const amount = (asset: Hex, v: bigint, exact = false) => tokenAmount(v, asset, meta, format, exact);
  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  // The book's answer is the end of the flow for that order: a listing or a
  // refusal drops the kept signature; an unknown answer keeps it to resend.
  // Both writes go to the store, so they land whether or not this page is
  // still shown.
  const list = async (rec: SignedRecord) => {
    setBook({ orderHash: rec.orderHash, step: 'listing' });
    const answer = await listSignedOrder(world.indexer, rec);
    if (answer.kind !== 'unknown') setRecord(null);
    if (answer.kind === 'listed') void queryClient.invalidateQueries({ queryKey: worldKey(sign.chainId, 'mySignedOrders') });
    setBook({ orderHash: rec.orderHash, step: 'answered', answer });
  };

  const signAndList = async () => {
    if (!consented || blockers.length > 0 || review == null || busy) return;
    setPhase({ kind: 'signing' });
    let signature: Hex;
    try {
      signature = await signTypedData(config, {
        account: own.account,
        domain: signedOfferDomain(sign.chainId, diamond),
        types: SIGNED_OFFER_TYPES,
        primaryType: 'SignedOffer',
        message: typedMessage(sign.order),
      });
    } catch (e) {
      if (mounted.current) setPhase({ kind: 'not-signed', reason: refusalFromError(e).reason });
      return;
    }
    const rec: SignedRecord = { identity: sign.identity, chainId: sign.chainId, order: sign.order, orderHash: sign.orderHash, signature };
    setRecord(rec);
    if (mounted.current) setPhase({ kind: 'review' });
    await list(rec);
  };

  // Leaving the flow while the book's answer is unknown keeps nothing here:
  // whether the order was listed is then read under Your signed orders.
  const close = (listed: boolean) => {
    setRecord(null);
    setConsentFor(null);
    setBook(null);
    onClose(listed);
  };

  const firstFocus = useRef<HTMLHeadingElement>(null);
  const answered = book?.step === 'answered';
  useEffect(() => {
    if (answered) firstFocus.current?.focus();
  }, [answered]);

  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, RISK_GUIDE[sign.draft.side]);

  if (book?.step === 'answered') {
    const a = book.answer;
    return (
      <div className="repay-loan" data-testid="desk-sign-result" data-kind={a.kind}>
        <h3 ref={firstFocus} tabIndex={-1}>
          {text(a.kind === 'listed' ? 'signNew.listedTitle' : a.kind === 'refused' ? 'signNew.refusedTitle' : 'signNew.unknownTitle')}
        </h3>
        {a.kind === 'listed' && (
          <Notice tone="ok" tier="A">
            {text(a.fresh ? 'signNew.listed' : 'signNew.alreadyListed')} {format('signNew.orderHash', { hash: shortAddress(a.orderHash) })}
          </Notice>
        )}
        {a.kind === 'refused' && (
          <Notice tone="danger" tier="A">
            {refusalSentence(a.code, copy)} {text('signNew.refusedForgotten')}
          </Notice>
        )}
        {a.kind === 'unknown' && (
          <Notice tone="warn" tier="A">
            {format('signNew.unknown', { reason: a.reason })}
          </Notice>
        )}
        <p className="actions">
          {a.kind === 'unknown' && record !== null && (
            <button type="button" className="btn btn-primary" onClick={() => void list(record)} data-testid="desk-sign-resend">
              {text('signNew.resend')}
            </button>
          )}
          {a.kind === 'refused' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setBook(null);
                onEdit();
              }}
              data-testid="desk-sign-edit"
            >
              {text('signNew.edit')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => close(a.kind === 'listed')} data-testid="desk-sign-done">
              {text('signNew.done')}
            </button>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="repay-loan" data-testid="desk-sign-review">
      {read.state === 'reading' && review == null && <p className="tier-b">{text('signNew.reading')}</p>}
      {read.state === 'failed' && review == null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: read.error ?? 'no answer' })}
        </Notice>
      )}
      {review != null && <Receipt receipt={signNewReceipt(sign, review, amount, copy)} describeAsset={describeAsset} nowMs={nowMs} />}
      {blockers.map((b) => (
        <Notice key={b} tone="danger" tier="A">
          {text(BLOCKER_TEXT[b])}
        </Notice>
      ))}
      {phase.kind === 'not-signed' && (
        <Notice tone="danger" tier="A">
          {format('signNew.notSigned', { reason: phase.reason })}
        </Notice>
      )}
      {review != null && blockers.length === 0 && (
        <p className="consent tier-a">
          <label>
            <input
              type="checkbox"
              checked={consented}
              disabled={busy}
              onChange={(e) => setConsentFor(e.target.checked ? sign.orderHash : null)}
              data-testid="desk-sign-consent"
            />
            <span>
              {text('accept.consentLead')}
              <a href={riskLink} target="_blank" rel="noreferrer">
                {text('accept.consentRisk')}
              </a>
              {text('accept.consentAnd')}
              <a href={termsLink} target="_blank" rel="noreferrer">
                {text('accept.consentTerms')}
              </a>
              {text('accept.consentEnd')}
            </span>
          </label>
        </p>
      )}
      {busy && (
        <p className="tier-b" aria-live="polite" data-testid="desk-sign-step">
          {text(phase.kind === 'signing' ? 'signNew.stepSign' : 'signNew.stepList')}
        </p>
      )}
      <div className="thumb-action">
        <div className="thumb-buttons">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!consented || blockers.length > 0 || review == null || busy}
            onClick={() => void signAndList()}
            data-testid="desk-sign-submit"
          >
            {text('signNew.submit')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onEdit} data-testid="desk-sign-edit">
            {text('signNew.edit')}
          </button>
        </div>
        {review != null && blockers.length === 0 && !consented && <p className="tier-b">{text('accept.consentNeeded')}</p>}
      </div>
    </div>
  );
}
