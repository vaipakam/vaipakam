import { useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { requireSelector } from '../../shared/capability/types';
import { selectorOf, useCapabilities } from '../../shared/capability/CapabilityContext';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { PLAN_SIGNATURES, RISK_ACCESS_ABI, STRICT_SIGNATURE, readRiskSettings, type RiskSettings as Settings } from '../../shared/risk/riskAccess';
import { levelName } from '../../shared/risk/riskReceipt';
import { changeCall, changeMoved, changeOffered, changeReceipt, levelChoices, strictState, type LevelChoice, type RiskChange } from '../../shared/risk/riskSettings';
import { simulateCall } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue } from '../../shared/tx/txStore';
import { useMounted } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import type { LegOutcome } from '../../shared/tx/outcome';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';
import { formatUtc } from '../../shared/ui/format';

const LEVEL_HELP = ['riskSettings.helpBlueChip', 'riskSettings.helpLiquid', 'riskSettings.helpAny'] as const;
const CHOICE_BUTTON = { raise: 'riskSettings.chooseRaise', lower: 'riskSettings.chooseLower', reaffirm: 'risk.reaffirm' } as const;

/** The change under review, with the settings it was read with and the
 *  identity it was read under (RB-REVIEW). */
interface Reviewed {
  change: RiskChange;
  settings: Settings;
  readAt: number;
  identity: string;
}

/**
 * Settings › Risk access (ACC-33, RB-RISK-SETTINGS). The level that counts
 * for this wallet on this network, in words, with why it differs from the
 * level chosen (a raise still waiting, or a risk-terms change since), whether
 * this network enforces it at all, and strict mode. Advanced offers each
 * change as one signed transaction through the shared signing flow; a raise
 * still in its waiting period is never offered again, and a choice a
 * risk-terms change stopped is confirmed in one step, in either mode.
 * Per-pair agreements stay in the flows that need them (RB-RISK-STEP).
 */
export function RiskSettings({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const copy = useCopy();
  const { text, format } = copy;
  const { isAdvanced } = useMode();
  const config = useConfig();
  const { caps } = useCapabilities();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const mounted = useMounted();
  const status = useOwnRead(['riskSettings', diamond], (c) => readRiskSettings(c, diamond, account), { perBlock: true });
  const [reviewed, setReviewed] = useStoredValue<Reviewed>('settings.risk:review');
  const [loadError, setLoadError] = useState<string | null>(null);

  const tx = useTrackedTx({
    key: 'settings.risk',
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!reviewed) throw new Error('no risk-access change under review');
      const call = changeCall(reviewed.change, reviewed.settings);
      return writeContract(config, { address: diamond, abi: RISK_ACCESS_ABI, functionName: call.functionName, args: call.args, chainId: chain.chainId, account });
    },
    measure: async (_receipt, at) => {
      if (!reviewed) return [];
      const change = reviewed.change;
      const after = await at.read((c, b) => readRiskSettings(c, diamond, account, b.blockNumber));
      const legs: LegOutcome[] = [];
      if (change.kind === 'level') {
        const label = format('risk.legLevel', { level: levelName(change.level, copy) });
        if (after.held !== change.level || after.stale) return [{ status: 'not-done', label, reason: text('risk.legLevelMissing') }];
        legs.push({ status: 'done', label });
        legs.push({ status: 'done', label: after.effective === change.level ? text('risk.legNow') : format('risk.legAt', { when: formatUtc(Number(after.unlockAt)) }) });
        return legs;
      }
      const label = text(change.on ? 'riskSettings.legStrictOn' : 'riskSettings.legStrictOff');
      if (after.strict !== change.on) return [{ status: 'not-done', label, reason: text('riskSettings.legStrictMissing') }];
      legs.push({ status: 'done', label });
      const st = strictState(after);
      if (st.kind === 'lingering') legs.push({ status: 'done', label: format('riskSettings.legStrictUntil', { when: formatUtc(Number(st.until)) }) });
      return legs;
    },
  });

  // Opening a change reads the settings again, so the receipt stands on a
  // read taken now, never on the page's last poll.
  const open = (change: RiskChange) => {
    if (tx.phase.kind !== 'idle') tx.reset();
    setReviewed(null);
    setLoadError(null);
    tx.review();
    void own.read((c) => readRiskSettings(c, diamond, account)).then(
      ({ value }) => {
        if (mounted.current) setReviewed({ change, settings: value, readAt: Date.now(), identity });
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
  };

  // RB-REVIEW: the settings read again through the own rail, the change
  // still one the page would offer, nothing the receipt states moved, then
  // the call simulated as the sender.
  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!reviewed) return { kind: 'unreadable', reason: text('flow.reading') };
    const signature = reviewed.change.kind === 'level' ? PLAN_SIGNATURES.tier : STRICT_SIGNATURE;
    const routed = requireSelector(caps, selectorOf(signature), text('risk.capabilityName'));
    if (!routed.ok) return { kind: 'refused', refusal: { code: 'NotRouted', reason: routed.reason, reopensAt: null, remedy: null } };
    let now: Settings;
    try {
      now = (await own.read((c) => readRiskSettings(c, diamond, account))).value;
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (!changeOffered(now, reviewed.change)) return { kind: 'refused', refusal: { code: 'AlreadySet', reason: text('riskSettings.already'), reopensAt: null, remedy: null } };
    if (changeMoved(reviewed.change, reviewed.settings, now)) {
      if (current()) setReviewed({ ...reviewed, settings: now, readAt: Date.now() });
      return { kind: 'changed', what: text('risk.changedWhat') };
    }
    const call = changeCall(reviewed.change, reviewed.settings);
    return simulateCall(own, { address: diamond, abi: RISK_ACCESS_ABI, functionName: call.functionName, args: call.args });
  };

  // Open from the moment a change is chosen until it is left: the review,
  // a transaction still out, or its outcome. Held in the app's store, so a
  // page that mounts again shows it instead of offering the change twice.
  const flowOpen = tx.phase.kind === 'review' || holdsFlow(tx.phase);
  const s = status.data;

  return (
    <section className="home-section" aria-labelledby="settings-risk" data-testid="settings-risk">
      <h2 id="settings-risk">{text('riskSettings.title')}</h2>
      {s === null && status.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('risk.failed', { reason: status.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={status.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {s === null && status.state !== 'failed' && <p className="tier-b">{text('risk.reading')}</p>}
      {s !== null && <RiskState s={s} chainName={chain.name} />}
      {s !== null && status.error !== null && <p className="tier-b">{format('riskSettings.stale', { reason: status.error })}</p>}

      {s !== null && !flowOpen && (
        <RiskChoices s={s} advanced={isAdvanced} onChoose={open} />
      )}

      {flowOpen && (
        <div className="risk-step" data-testid="settings-risk-flow">
          {loadError !== null && (
            <Notice tone="warn" tier="A">
              {format('risk.failed', { reason: loadError })}{' '}
              <button type="button" className="btn" onClick={close}>
                {text('riskSettings.back')}
              </button>
            </Notice>
          )}
          <ActionFlow
            tx={tx}
            identity={identity}
            reviewedFor={reviewed?.identity ?? tx.frozen?.identity ?? identity}
            receipt={reviewed ? changeReceipt(reviewed.change, reviewed.settings, copy, { chain: chain.name, readAt: reviewed.readAt }) : null}
            recheck={recheck}
            describeAsset={() => null}
            explorer={chain.blockExplorer}
            next={null}
            after={() => (
              <p className="actions">
                <button type="button" className="btn btn-primary" onClick={close} data-testid="settings-risk-done">
                  {text('riskSettings.back')}
                </button>
              </p>
            )}
            onClose={close}
          />
        </div>
      )}
      <WhyLink summaryKey="risk.whySummary" detailKey="risk.why" />
    </section>
  );
}

/** The level that counts, why it differs from the choice, whether this
 *  network enforces it, and strict mode, from one block's reads. */
function RiskState({ s, chainName }: { s: Settings; chainName: string }) {
  const copy = useCopy();
  const { text, format } = copy;
  const strict = strictState(s);
  return (
    <div data-testid="settings-risk-state" data-effective={s.effective} data-held={s.held} data-stale={s.stale ? 'yes' : 'no'} data-strict={strict.kind} data-gate={s.gateOn ? 'on' : 'off'}>
      <p className="tier-a">{format('riskSettings.levelNow', { chain: chainName, level: levelName(s.effective, copy) })}</p>
      {s.stale && <p className="tier-a">{format('risk.needStale', { held: levelName(s.held, copy), base: levelName(0, copy) })}</p>}
      {!s.stale && s.held > s.effective && s.unlockAt > s.chainNow && (
        <p className="tier-a">{format('riskSettings.levelWaiting', { held: levelName(s.held, copy), when: formatUtc(Number(s.unlockAt)) })}</p>
      )}
      <p className="tier-b">{format(s.gateOn ? 'riskSettings.gateOn' : 'riskSettings.gateOff', { chain: chainName })}</p>
      <p className="tier-b" data-testid="settings-risk-strict">
        {strict.kind === 'on' && text('riskSettings.strictOn')}
        {strict.kind === 'off' && text('riskSettings.strictOff')}
        {strict.kind === 'lingering' && format('riskSettings.strictLingering', { when: formatUtc(Number(strict.until)) })}
      </p>
    </div>
  );
}

/** The changes on offer. A choice a risk-terms change stopped is confirmed
 *  in either mode; changing the level or strict mode is Advanced. */
function RiskChoices({ s, advanced, onChoose }: { s: Settings; advanced: boolean; onChoose: (c: RiskChange) => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const choices = levelChoices(s);
  const reaffirm = choices.find((c) => c.choice.kind === 'reaffirm');
  if (!advanced) {
    return (
      <>
        {reaffirm && (
          <p className="actions">
            <button type="button" className="btn btn-primary" onClick={() => onChoose({ kind: 'level', level: reaffirm.level })} data-testid="settings-risk-reaffirm">
              {text('risk.reaffirm')}
            </button>
          </p>
        )}
        <p className="tier-b">{text('riskSettings.basicPointer')}</p>
      </>
    );
  }
  const strict = strictState(s);
  return (
    <>
      <ul className="risk-levels" data-testid="settings-risk-levels">
        {choices.map(({ level, choice }) => (
          <li key={level} data-level={level} data-choice={choice.kind}>
            <p className="tier-a">{levelName(level, copy)}</p>
            <p className="tier-b">{text(LEVEL_HELP[level] ?? LEVEL_HELP[2])}</p>
            <ChoiceLine level={level} choice={choice} onChoose={onChoose} />
          </li>
        ))}
      </ul>
      <div className="settings-row" data-testid="settings-risk-strict-row">
        <p className="tier-b">{text('riskSettings.strictWhat')}</p>
        <p className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => onChoose({ kind: 'strict', on: !s.strict })}
            data-testid="settings-risk-strict-toggle"
          >
            {text(s.strict ? 'riskSettings.strictTurnOff' : 'riskSettings.strictTurnOn')}
          </button>
        </p>
        {s.strict && <p className="tier-b">{text('riskSettings.strictOffWarn')}</p>}
        {strict.kind === 'lingering' && <p className="tier-b">{format('riskSettings.strictOnAgain', { when: formatUtc(Number(strict.until)) })}</p>}
      </div>
    </>
  );
}

function ChoiceLine({ level, choice, onChoose }: { level: number; choice: LevelChoice; onChoose: (c: RiskChange) => void }) {
  const { text, format } = useCopy();
  if (choice.kind === 'current') return <p className="tier-b">{text('riskSettings.isCurrent')}</p>;
  if (choice.kind === 'waiting') return <p className="tier-b">{format('riskSettings.isWaiting', { when: formatUtc(Number(choice.until)) })}</p>;
  return (
    <p className="actions">
      <button type="button" className="btn" onClick={() => onChoose({ kind: 'level', level })} data-testid={`settings-risk-choose-${level}`}>
        {text(CHOICE_BUTTON[choice.kind])}
      </button>
    </p>
  );
}
