import { useRef, useState, type FormEvent } from 'react';
import { useConfig } from 'wagmi';
import { sendWrite } from '../../shared/tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { requireSelector } from '../../shared/capability/types';
import { selectorOf, useCapabilities } from '../../shared/capability/CapabilityContext';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { actionsLine, keeperName, keeperReceipt } from '../../shared/keepers/keeperReceipt';
import {
  ALL_ACTIONS,
  CHANGE_SIGNATURES,
  KEEPER_ACTIONS,
  MAX_KEEPERS,
  PROFILE_ABI,
  changeCall,
  changeLanded,
  changeMoved,
  changeRefusal,
  networkKeeper,
  readKeeperSettings,
  widens,
  type KeeperChange,
  type KeeperSettings,
} from '../../shared/keepers/keepers';
import { AddressEntry, entryReady } from '../../shared/address/AddressEntry';
import { useAddressBook } from '../../shared/address/AddressBook';
import { useKnownAddresses } from '../../shared/address/knownAddresses';
import { classifyCandidate } from '../../shared/address/lookalike';
import { readPosture, usePosture } from '../../shared/reads/posture';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { readTerms } from '../../shared/terms/terms';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { simulateCall } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue } from '../../shared/tx/txStore';
import { useMounted } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

const SIDE_KEY = { lender: 'keepers.sideLender', borrower: 'keepers.sideBorrower', account: 'keepers.sideAccount' } as const;

interface Reviewed {
  change: KeeperChange;
  settings: KeeperSettings;
  readAt: number;
  identity: string;
}

/**
 * Settings › Keepers (ACC-34, RB-KEEPERS). The master switch, the keepers
 * this wallet approved (at most five) and the actions each may drive, with
 * whose side each action drives. Everything is off until the wallet turns it
 * on, and a grant alone lets no keeper act: the loan or offer must also name
 * the keeper. Taking a permission away is offered in either mode and never
 * asks for the Terms; giving one is Advanced and asks for them where a
 * version is in force. The protocol's pause closes every change, which is
 * stated rather than offered.
 */
export function Keepers({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const copy = useCopy();
  const { text, format } = copy;
  const { isAdvanced } = useMode();
  const config = useConfig();
  const { caps } = useCapabilities();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const mounted = useMounted();
  const network = networkKeeper(chain.chainId);
  const status = useOwnRead(['keepers', diamond], (c) => readKeeperSettings(c, diamond, account));
  const posture = usePosture(diamond);
  const terms = useTerms();
  const termsGate = useTermsGate('settings.keepers.terms', chain, own);
  const [reviewed, setReviewed] = useStoredValue<Reviewed>('settings.keepers:review');
  /** The change waiting on a Terms acceptance before its review opens. */
  const [pending, setPending] = useStoredValue<KeeperChange>('settings.keepers:pending');
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Which opening read is current: a read for a review since cancelled or
   *  replaced is dropped, never shown under the newer one. */
  const openSeq = useRef(0);

  const tx = useTrackedTx({
    key: 'settings.keepers',
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!reviewed) throw new Error('no keeper change under review');
      const call = changeCall(reviewed.change);
      return sendWrite(config, { address: diamond, abi: PROFILE_ABI, functionName: call.functionName, args: call.args, chainId: chain.chainId, account });
    },
    measure: async (_receipt, at) => {
      if (!reviewed) return [];
      const after = await at.read((c, b) => readKeeperSettings(c, diamond, account, b.blockNumber));
      const label = legLabel(reviewed.change);
      return changeLanded(reviewed.change, after) ? [{ status: 'done', label }] : [{ status: 'not-done', label, reason: text('keepers.legMissing') }];
    },
  });

  function legLabel(c: KeeperChange): string {
    switch (c.kind) {
      case 'access':
        return text(c.on ? 'keepers.legOn' : 'keepers.legOff');
      case 'approve':
        return format('keepers.legApproved', { keeper: keeperName(c.keeper, network, chain.name, copy) });
      case 'actions':
        return format('keepers.legActions', { keeper: keeperName(c.keeper, network, chain.name, copy) });
      case 'revoke':
        return format('keepers.legRevoked', { keeper: keeperName(c.keeper, network, chain.name, copy) });
    }
  }

  // Opening reads the settings again, so the receipt stands on a read taken
  // now, never on the page's last poll.
  const openReview = (change: KeeperChange) => {
    if (tx.phase.kind !== 'idle') tx.reset();
    setReviewed(null);
    setLoadError(null);
    tx.review();
    const seq = ++openSeq.current;
    const live = () => mounted.current && seq === openSeq.current;
    void own.read((c) => readKeeperSettings(c, diamond, account)).then(
      ({ value }) => {
        if (live()) setReviewed({ change, settings: value, readAt: Date.now(), identity });
      },
      (e: unknown) => {
        if (live()) setLoadError(refusalFromError(e).reason);
      },
    );
  };

  const choose = (change: KeeperChange) => {
    if (status.data && widens(change, status.data) && terms.data?.kind === 'needed') {
      setPending(change);
      termsGate.start(terms.data);
      return;
    }
    openReview(change);
  };

  const close = () => {
    openSeq.current++;
    const k = tx.phase.kind;
    if (k === 'review' || k === 'measured' || k === 'failed' || k === 'superseded') tx.reset();
    setReviewed(null);
    setPending(null);
    setLoadError(null);
    termsGate.end();
  };

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    const routed = requireSelector(caps, selectorOf(CHANGE_SIGNATURES[reviewed.change.kind]), text('keepers.capabilityName'));
    if (!routed.ok) return { kind: 'refused', refusal: { code: 'NotRouted', reason: routed.reason, reopensAt: null, remedy: null } };
    let now: KeeperSettings;
    try {
      const [s, p, t] = await Promise.all([
        own.read((c) => readKeeperSettings(c, diamond, account)).then((r) => r.value),
        own.read((c) => readPosture(c, diamond)).then((r) => r.value),
        widens(reviewed.change, reviewed.settings) ? own.read((c) => readTerms(c, diamond, account)).then((r) => r.value) : Promise.resolve(null),
      ]);
      if (p.paused) return { kind: 'refused', refusal: { code: 'EnforcedPause', reason: text('keepers.paused'), reopensAt: null, remedy: null } };
      if (t !== null && t.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('keepers.termsNewer'), reopensAt: null, remedy: null } };
      now = s;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const refusal = changeRefusal(reviewed.change, now);
    if (refusal !== null) return { kind: 'refused', refusal: { code: 'KeeperChangeRefused', reason: text(refusal), reopensAt: null, remedy: null } };
    if (changeMoved(reviewed.change, reviewed.settings, now)) {
      if (current()) setReviewed({ ...reviewed, settings: now, readAt: Date.now() });
      return { kind: 'changed', what: text('keepers.changedWhat') };
    }
    const call = changeCall(reviewed.change);
    return simulateCall(own, { address: diamond, abi: PROFILE_ABI, functionName: call.functionName, args: call.args });
  };

  const termsOpen = termsGate.session !== null;
  const flowOpen = !termsOpen && (tx.phase.kind === 'review' || holdsFlow(tx.phase));
  const s = status.data;
  const paused = posture.data?.paused === true;

  return (
    <section className="home-section" aria-labelledby="settings-keepers" data-testid="settings-keepers">
      <h2 id="settings-keepers">{text('keepers.title')}</h2>
      {s === null && status.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('keepers.failed', { reason: status.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={status.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {s === null && status.state !== 'failed' && <p className="tier-b">{text('keepers.reading')}</p>}
      {s !== null && (
        <div data-testid="settings-keepers-state" data-access={s.access ? 'on' : 'off'} data-count={s.keepers.length}>
          <p className="tier-a">{text(s.access ? 'keepers.stateOn' : 'keepers.stateOff')}</p>
          <p className="tier-b">{s.keepers.length === 0 ? text('keepers.noneApproved') : format('keepers.countApproved', { count: String(s.keepers.length), max: String(MAX_KEEPERS) })}</p>
          <p className="tier-a">{text('keepers.inertAlone')}</p>
          <p className="tier-a">{text('keepers.neverFunds')}</p>
          <p className="tier-a">{text('keepers.followHolder')}</p>
          {posture.data?.keepersPaused && <p className="tier-a">{text('keepers.keepersPaused')}</p>}
          {status.error !== null && <p className="tier-b">{format('keepers.stale', { reason: status.error })}</p>}
        </div>
      )}
      {s !== null && paused && !flowOpen && !termsOpen && (
        <Notice tone="danger" tier="A">
          {text('keepers.paused')}
        </Notice>
      )}
      {s !== null && !flowOpen && !termsOpen && (
        <KeeperControls s={s} advanced={isAdvanced} paused={paused} network={network} chainName={chain.name} chainId={chain.chainId} diamond={diamond} account={account} onChoose={choose} />
      )}
      {termsOpen && termsGate.session && (
        <TermsPrompt
          asker={text('keepers.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={chain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            const next = pending;
            setPending(null);
            if (next) openReview(next);
          }}
          onClose={close}
        />
      )}
      {flowOpen && (
        <div className="risk-step" data-testid="settings-keepers-flow">
          {loadError !== null && (
            <Notice tone="warn" tier="A">
              {format('keepers.failed', { reason: loadError })}{' '}
              <button type="button" className="btn" onClick={close}>
                {text('keepers.back')}
              </button>
            </Notice>
          )}
          <ActionFlow
            tx={tx}
            identity={identity}
            reviewedFor={reviewed?.identity ?? tx.frozen?.identity ?? identity}
            receipt={reviewed ? keeperReceipt(reviewed.change, reviewed.settings, copy, { chain: chain.name, network, readAt: reviewed.readAt }) : null}
            recheck={recheck}
            describeAsset={() => null}
            explorer={chain.blockExplorer}
            next={null}
            after={() => (
              <p className="actions">
                <button type="button" className="btn btn-primary" onClick={close} data-testid="settings-keepers-done">
                  {text('keepers.back')}
                </button>
              </p>
            )}
            onClose={close}
          />
        </div>
      )}
      <WhyLink summaryKey="keepers.whySummary" detailKey="keepers.why" />
    </section>
  );
}

/** The switch, each approved keeper with its actions, and adding one.
 *  Taking away is offered in either mode; giving is Advanced. Under the
 *  protocol's pause the approved keepers are still listed, with no change
 *  offered: the pause closes changes, not reads. */
function KeeperControls({
  s,
  advanced,
  paused,
  network,
  chainName,
  chainId,
  diamond,
  account,
  onChoose,
}: {
  s: KeeperSettings;
  advanced: boolean;
  paused: boolean;
  network: Hex | null;
  chainName: string;
  chainId: number;
  diamond: Hex;
  account: Hex;
  onChoose: (c: KeeperChange) => void;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  return (
    <>
      {!paused && (s.access || advanced) && (
        <p className="actions">
          <button type="button" className="btn" onClick={() => onChoose({ kind: 'access', on: !s.access })} data-testid="settings-keepers-access">
            {text(s.access ? 'keepers.turnOff' : 'keepers.turnOn')}
          </button>
        </p>
      )}
      {s.keepers.length > 0 && (
        <ul className="approval-rows" data-testid="settings-keepers-list">
          {s.keepers.map((k) => (
            <li key={k.keeper} data-keeper={k.keeper.toLowerCase()} data-actions={k.actions} data-testid="settings-keeper-row">
              <p className="tier-a">{keeperName(k.keeper, network, chainName, copy)}</p>
              <p className="tier-b">{actionsLine(k.actions, copy)}</p>
              {advanced && !paused && <ActionPicker initial={k.actions} submitKey="keepers.saveActions" onSubmit={(actions) => onChoose({ kind: 'actions', keeper: k.keeper, actions })} />}
              {!paused && (
                <p className="actions">
                  <button type="button" className="btn" onClick={() => onChoose({ kind: 'revoke', keeper: k.keeper })} data-testid="settings-keeper-revoke">
                    {text('keepers.revoke')}
                  </button>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {!paused && advanced && s.keepers.length < MAX_KEEPERS && <AddKeeper s={s} network={network} chainName={chainName} chainId={chainId} diamond={diamond} account={account} onChoose={onChoose} />}
      {!paused && advanced && s.keepers.length >= MAX_KEEPERS && <p className="tier-b">{format('keepers.fullNote', { max: String(MAX_KEEPERS) })}</p>}
      {!paused && !advanced && <p className="tier-b">{text('keepers.basicPointer')}</p>}
    </>
  );
}

/** One checkbox per action, with whose side it drives. */
function ActionPicker({ initial, submitKey, onSubmit, testId }: { initial: number; submitKey: 'keepers.saveActions' | 'keepers.approve'; onSubmit: (mask: number) => void; testId?: string }) {
  const { text } = useCopy();
  const [mask, setMask] = useState(initial);
  return (
    <fieldset className="keeper-actions" data-testid={testId ?? 'settings-keeper-actions'}>
      <legend className="sr-only">{text('keepers.rowActions')}</legend>
      {KEEPER_ACTIONS.map((a) => (
        <label key={a.bit} className="keeper-action">
          <input type="checkbox" checked={(mask & a.bit) !== 0} onChange={(e) => setMask(e.target.checked ? mask | a.bit : mask & ~a.bit)} data-bit={a.bit} />
          <span>
            {text(a.key)}{' '}
            <span className="tier-b">
              ({text(SIDE_KEY[a.side])}; {text(a.scope === 'loan' ? 'keepers.scopeLoan' : 'keepers.scopeAccount')})
            </span>
          </span>
        </label>
      ))}
      <p className="actions">
        <button type="button" className="btn" disabled={mask === 0 || (mask & ~ALL_ACTIONS) !== 0 || mask === initial} onClick={() => onSubmit(mask)}>
          {text(submitKey)}
        </button>
      </p>
    </fieldset>
  );
}

/** Adding a keeper (#3415, RB-ADDRESS-GUARD): the address is shown in
 *  full, a look-alike of an address this wallet already uses is refused,
 *  and a first-time address waits for "I checked the full address". Every
 *  address the wallet uses counts as already used (one list for every box,
 *  knownAddresses.ts), and nothing can be added until it is all read. A
 *  keeper receives nothing, so no signature from it is asked. */
function AddKeeper({
  s,
  network,
  chainName,
  chainId,
  diamond,
  account,
  onChoose,
}: {
  s: KeeperSettings;
  network: Hex | null;
  chainName: string;
  chainId: number;
  diamond: Hex;
  account: Hex;
  onChoose: (c: KeeperChange) => void;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const book = useAddressBook(chainId, account);
  const networkFree = network !== null && !s.keepers.some((k) => k.keeper.toLowerCase() === network.toLowerCase());
  const [address, setAddress] = useState(networkFree ? network : '');
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const known = useKnownAddresses({ chainId, chainName, diamond, account, book });
  const parsed = entryReady(classifyCandidate(address, known.list), checked, known);
  const onSubmit = (e: FormEvent) => e.preventDefault();
  return (
    <form className="approval-add" onSubmit={onSubmit} data-testid="settings-keepers-add">
      {network !== null ? (
        <p className="tier-b">{format('keepers.networkHint', { chain: chainName, address: network })}</p>
      ) : (
        <p className="tier-b">{format('keepers.noNetworkKeeper', { chain: chainName })}</p>
      )}
      <AddressEntry
        id="keepers-add-input"
        label={text('keepers.addLabel')}
        value={address}
        onChange={(v) => {
          setAddress(v);
          setNote(null);
        }}
        known={known}
        checked={checked}
        onChecked={setChecked}
        testId="settings-keepers-add-entry"
      />
      <ActionPicker
        initial={0}
        submitKey="keepers.approve"
        testId="settings-keepers-add-actions"
        onSubmit={(actions) => {
          if (parsed === null) {
            setNote(text('approvals.addInvalid'));
            return;
          }
          const refusal = changeRefusal({ kind: 'approve', keeper: parsed, actions }, s);
          if (refusal !== null) {
            setNote(text(refusal));
            return;
          }
          onChoose({ kind: 'approve', keeper: parsed, actions });
        }}
      />
      {parsed !== null && <p className="tier-b">{keeperName(parsed, network, chainName, copy)}</p>}
      {note !== null && (
        <p className="tier-b" role="status" data-testid="settings-keepers-add-note">
          {note}
        </p>
      )}
    </form>
  );
}
