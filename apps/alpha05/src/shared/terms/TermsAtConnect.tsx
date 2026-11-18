import { useEffect } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useDisconnect } from 'wagmi';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { PAGES } from '../../routes/pageMap';
import { useCopy } from '../copy/useCopy';
import { useOwnRead } from '../reads/useOwnRead';
import { useStoredValue } from '../tx/txStore';
import { formatFigureText } from '../ui/format';
import { Notice } from '../ui/Notice';
import { acceptTermsCall } from './terms';
import { TermsPrompt } from './TermsPrompt';
import { useTerms } from './useTerms';
import { useTermsGate, type NeededTerms, type TermsGate } from './useTermsGate';

/** The key the app's transaction store holds this step under. */
export const CONNECT_TERMS_KEY = 'terms.connect';

/** Margin over the estimated network fee, in percent: gas prices move
 *  between the estimate and the wallet's own. */
const FEE_MARGIN_PCT = 150n;

/**
 * Where a connected wallet stands on the Terms of the network it is on.
 * - `none`: no wallet on a served network; nothing to say.
 * - `open`: no Terms in force, or this wallet has accepted them.
 * - `checking` / `unreadable`: not known yet; the app shows nothing of the
 *   wallet's own until it is (a failed read is never "accepted").
 * - `locked`: not accepted; the acceptance is asked, and nothing else of the
 *   connected app is shown.
 * - `exits`: not accepted, and the wallet chose to use only what the Terms
 *   never stand between it and (design section 3.2).
 */
export type TermsAccess =
  | { kind: 'none' }
  | { kind: 'open' }
  | { kind: 'checking' }
  | { kind: 'unreadable'; reason: string; retry: () => void }
  | { kind: 'locked'; terms: NeededTerms; key: string }
  | { kind: 'exits'; terms: NeededTerms; key: string };

interface ConnectTerms {
  access: TermsAccess;
  own: OwnStateClient | null;
  chain: SupportedChain | null;
  gate: TermsGate;
  /** The wallet, network and version a choice below was made for. */
  dismissed: string | null;
  setDismissed: (key: string | null) => void;
  setExits: (key: string | null) => void;
}

function useConnectTerms(): ConnectTerms {
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const terms = useTerms();
  const gate = useTermsGate(CONNECT_TERMS_KEY, chain, own);
  const [exits, setExits] = useStoredValue<string>(`${CONNECT_TERMS_KEY}:exits`);
  const [dismissed, setDismissed] = useStoredValue<string>(`${CONNECT_TERMS_KEY}:dismissed`);

  let access: TermsAccess;
  if (!own || !chain) access = { kind: 'none' };
  else if (terms.state === 'failed' && !terms.data) access = { kind: 'unreadable', reason: terms.error ?? 'no answer', retry: terms.refetch };
  else if (!terms.data) access = { kind: 'checking' };
  else if (terms.data.kind !== 'needed') access = { kind: 'open' };
  else {
    const key = `${own.chainId}:${own.account.toLowerCase()}:${terms.data.version}:${terms.data.hash}`;
    access = exits === key ? { kind: 'exits', terms: terms.data, key } : { kind: 'locked', terms: terms.data, key };
  }
  return { access, own, chain, gate, dismissed, setDismissed, setExits: (k) => setExits(k) };
}

/** Whether the page at this location shows nothing of the connected app
 *  until the Terms are settled: every page but the public ones. */
function isPublicPage(pathname: string): boolean {
  const page = PAGES.find((p) => matchPath(p.path, pathname) !== null);
  return page?.tier === 'public';
}

/** The page body is held back while the wallet's Terms are not settled. */
export function useTermsHoldsPage(): boolean {
  const { access } = useConnectTerms();
  const { pathname } = useLocation();
  return (access.kind === 'checking' || access.kind === 'unreadable' || access.kind === 'locked') && !isPublicPage(pathname);
}

/** The network fee the acceptance needs and what the wallet holds for it. */
function useAcceptFee(own: OwnStateClient | null, chain: SupportedChain | null, terms: NeededTerms | null) {
  return useOwnRead(
    ['terms-accept-fee', terms?.version ?? 0, terms?.hash ?? '0x', terms?.alsoAnnounced?.version ?? 0],
    async (c) => {
      const account = own!.account;
      const [balance, gas, price] = await Promise.all([
        c.getBalance({ address: account }),
        c.estimateContractGas({ address: chain!.diamondAddress, ...acceptTermsCall(terms!), account }),
        c.getGasPrice(),
      ]);
      return { balance, need: (gas * price * FEE_MARGIN_PCT) / 100n };
    },
    { enabled: own !== null && chain !== null && terms !== null },
  );
}

/**
 * #3734 — the acceptance right after a wallet connects. Owner decision
 * 2026-11-18: the wallet records it itself, by its own paid `acceptTerms`
 * transaction on the network it is on, and nothing records it for anyone
 * else. So once a wallet is connected on a served network whose Terms it has
 * not accepted (a first connection, another network, a new version), the
 * Terms review opens by itself, ready to send, and the page body waits
 * (`useTermsHoldsPage`) until the acceptance is read back from the chain.
 *
 * Declining costs nothing and keeps the wallet out of the connected app,
 * with one exception the platform must never take away (design section
 * 3.2): it may still repay, close, add collateral, claim, withdraw and
 * cancel. Choosing that shows the pages again with a standing notice; every
 * action that takes on a position keeps its own Terms gate, and the
 * contract refuses it as well. A wallet without enough gas for the fee is
 * told the amount before it tries.
 */
export function TermsAtConnect() {
  const { text, format } = useCopy();
  const { access, own, chain, gate, dismissed, setDismissed, setExits } = useConnectTerms();
  const needed = access.kind === 'locked' ? access.terms : null;
  const key = access.kind === 'locked' ? access.key : null;
  const open = gate.session !== null;
  const fee = useAcceptFee(own, chain, needed);

  // Open the review once per wallet, network and version; closing it leaves
  // the choice panel in its place rather than reopening at once.
  useEffect(() => {
    if (!needed || !key || open || dismissed === key) return;
    gate.start(needed);
    // `gate.start` is a fresh function each render; the open session is
    // the guard against a second start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, dismissed]);

  if (!own || !chain) return null;

  if (gate.session) {
    const short = fee.data && fee.data.balance < fee.data.need ? fee.data : null;
    return (
      <TermsPrompt
        asker={text('connectTerms.asker')}
        gate={gate}
        session={gate.session}
        chain={chain}
        own={own}
        notice={
          short ? (
            <Notice tone="warn" tier="A">
              <span data-testid="connect-terms-no-gas">
                {format(chain.testnet ? 'connectTerms.noGasTestnet' : 'connectTerms.noGas', {
                  chain: chain.name,
                  gas: chain.nativeGasSymbol,
                  need: formatFigureText(short.need, 18),
                  have: formatFigureText(short.balance, 18),
                })}
              </span>
            </Notice>
          ) : null
        }
        onAccepted={() => gate.end()}
        onClose={() => {
          if (key) setDismissed(key);
          gate.end();
        }}
      />
    );
  }

  if (access.kind !== 'exits') return null;
  return (
    <Notice tone="warn" tier="A">
      <span data-testid="connect-terms-exits">{format('connectTerms.exits', { chain: chain.name, version: String(access.terms.version) })}</span>{' '}
      <button
        type="button"
        className="btn"
        onClick={() => {
          setExits(null);
          setDismissed(null);
        }}
      >
        {text('connectTerms.acceptNow')}
      </button>
    </Notice>
  );
}

/**
 * What stands in for the page body while the wallet's Terms are not
 * settled: the reading state, an unreadable answer with its retry, or the
 * choice a wallet that has not accepted has: accept, use only the close-out
 * actions, or disconnect.
 */
export function TermsHold() {
  const { text, format } = useCopy();
  const { disconnect } = useDisconnect();
  const { access, chain, gate, setDismissed, setExits } = useConnectTerms();
  if (!chain) return null;
  return (
    <section className="card terms-hold" data-testid="terms-hold" data-state={access.kind} aria-labelledby="terms-hold-title">
      <h1 id="terms-hold-title">{text('connectTerms.holdTitle')}</h1>
      {access.kind === 'checking' && (
        <p className="tier-b" role="status">
          {format('connectTerms.checking', { chain: chain.name })}
        </p>
      )}
      {access.kind === 'unreadable' && (
        <>
          <Notice tone="danger" tier="A">
            {format('connectTerms.unreadable', { chain: chain.name, reason: access.reason })}
          </Notice>
          <p className="actions">
            <button type="button" className="btn" onClick={access.retry}>
              {text('connectTerms.retry')}
            </button>
          </p>
        </>
      )}
      {access.kind === 'locked' && (
        <>
          <p className="tier-a">{format('connectTerms.locked', { chain: chain.name, version: String(access.terms.version) })}</p>
          <p className="actions">
            <button type="button" className="btn btn-primary" disabled={gate.session !== null} onClick={() => setDismissed(null)}>
              {text('connectTerms.acceptNow')}
            </button>
            <button type="button" className="btn" disabled={gate.session !== null} onClick={() => setExits(access.key)} data-testid="terms-hold-exits">
              {text('connectTerms.exitsOnly')}
            </button>
          </p>
        </>
      )}
      <p className="actions">
        <button type="button" className="btn" onClick={() => disconnect()}>
          {text('wallet.disconnect')}
        </button>
      </p>
    </section>
  );
}
