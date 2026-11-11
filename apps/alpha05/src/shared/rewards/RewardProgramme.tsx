import type { ReactNode } from 'react';
import { useMode } from '../../app/ModeContext';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { FullAddress } from '../address/AddressEntry';
import { selectorOf, useCapabilities } from '../capability/CapabilityContext';
import { readVpfiToken } from '../claims/rewards';
import { useCopy } from '../copy/useCopy';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { WhyLink } from '../help/WhyLink';
import { useChainRead } from '../reads/chainRead';
import { usePosture } from '../reads/posture';
import { tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { formatFigureText, formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { OwnStamp } from '../ui/OwnStamp';
import { useNow } from '../ui/useNow';
import { PROGRAMME_SIGNATURES, programmeHeadline, readProgramme, type ProgrammeFact } from './programme';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * RW-43, RW-44 — whether the reward programme runs on the wallet's network,
 * at the top of the Rewards page.
 *
 * Basic leads with one sentence: running and funded, running with nothing
 * held to pay rewards, not started, starting at a stated time, left the
 * reward network, or unknown when a deciding fact could not be read (never
 * shown as running). A global pause is stated by name with what stays open,
 * and an unreadable pause is stated too. Advanced lists every fact behind
 * the sentence: the network's reward role (and, once retired, where its
 * leftover reward VPFI goes and how much went), the start time, the VPFI
 * held to pay rewards now (delivered and recycled, net of what is reserved),
 * where reward VPFI is held, and whether unclaimed rewards can be removed.
 * A fact the contracts do not offer says so; one that did not answer says
 * it could not be read. Whether the daily close runs is not read here, and
 * the card says so. Rewards are usage rebates, never yield (RL-6).
 */
export function RewardProgramme({ chain }: { chain: SupportedChain }) {
  const { text, format } = useCopy();
  const { mode } = useMode();
  const { caps } = useCapabilities();
  const diamond = chain.diamondAddress;
  const nowSec = Math.floor(useNow() / 1000);
  const prog = useOwnRead(['rewards', 'programme', diamond], (c) => readProgramme(c, diamond));
  const posture = usePosture(diamond);
  const tokenRead = useChainRead(['vpfiToken', diamond], (c) => readVpfiToken(c, diamond), { immutable: true });
  const token = tokenRead.data && tokenRead.data.toLowerCase() !== ZERO ? tokenRead.data : null;
  const meta = useTokenMeta(token ? [token] : []).data ?? null;

  const name = chain.name;
  const networkName = (id: number) => getSupportedChain(id)?.name ?? format('rewardsProgramme.network', { id: String(id) });
  const vpfi = (v: bigint) => (token ? tokenAmount(v, token, meta, format) : `${formatFigureText(v, 18)} VPFI`);
  const routed = (fact: ProgrammeFact) => caps?.routedSelectors?.has(selectorOf(PROGRAMME_SIGNATURES[fact])) !== false;
  const missing = (fact: ProgrammeFact): ReactNode => (
    <span data-fact-missing={routed(fact) ? 'unread' : 'unrouted'}>{text(routed(fact) ? 'rewardsProgramme.unread' : 'rewardsProgramme.unrouted')}</span>
  );

  const r = prog.data;
  const headline = r ? programmeHeadline(r) : null;
  const base = r?.baseChainId ? networkName(r.baseChainId) : null;
  const sentence = (): string => {
    switch (headline!.kind) {
      case 'live':
        return format('rewardsProgramme.live', { chain: name });
      case 'unfunded':
        return headline!.mirror && base !== null
          ? format('rewardsProgramme.unfundedMirror', { chain: name, base })
          : format('rewardsProgramme.unfunded', { chain: name });
      case 'not-started':
        return format('rewardsProgramme.notStarted', { chain: name });
      case 'starts':
        return format('rewardsProgramme.starts', { chain: name, when: formatUtc(headline!.at) });
      case 'left':
        return format('rewardsProgramme.left', { chain: name });
      default:
        return format('rewardsProgramme.unknown', { chain: name });
    }
  };

  const p = posture.data;
  const pauseUnread = posture.state === 'failed' || (posture.state !== 'reading' && (!p || posture.error !== null));

  return (
    <section className="home-section" aria-labelledby="rewards-programme-title" data-testid="rewards-programme">
      <h2 id="rewards-programme-title">{format('rewardsProgramme.title', { chain: name })}</h2>
      <WhyLink summaryKey="rewardsProgramme.lead" detailKey="rewardsProgramme.why" />
      {prog.state === 'failed' && r === null && (
        <p className="tier-a" data-testid="rewards-programme-failed">
          {format('rewardsProgramme.failed', { reason: prog.error ?? 'no answer' })}
        </p>
      )}
      {r === null && prog.state !== 'failed' && <p className="tier-b">{text('rewardsProgramme.reading')}</p>}
      {headline !== null && (
        <p className="tier-a" data-testid="rewards-programme-now" data-programme={headline.kind}>
          {sentence()}
        </p>
      )}
      {pauseUnread && (
        <Notice tone="warn" tier="A">
          <span data-testid="rewards-programme-pause" data-pause="unread">
            {format('rewardsProgramme.pauseUnread', { chain: name, reason: posture.error ?? 'no answer' })}
          </span>
        </Notice>
      )}
      {!pauseUnread && p?.paused === true && (
        <Notice tone="danger" tier="A">
          <span data-testid="rewards-programme-pause" data-pause="paused">
            {format('rewardsProgramme.paused', { chain: name, staysOpen: SWITCH_EFFECTS['2'].staysOpen })}
          </span>
          {p.pausedUntil > BigInt(nowSec) && <p className="tier-b">{format('home.statusPausedUntil', { when: formatUtc(Number(p.pausedUntil)) })}</p>}
        </Notice>
      )}
      {mode === 'advanced' && r !== null && (
        <>
          <h3 id="rewards-programme-facts-title">{text('rewardsProgramme.factsTitle')}</h3>
          <dl className="facts" aria-labelledby="rewards-programme-facts-title" data-testid="rewards-programme-facts">
            <dt className="tier-b">{text('rewardsProgramme.factRole')}</dt>
            <dd data-testid="rewards-programme-role" data-role={r.role ?? ''}>
              {r.role === null
                ? missing('role')
                : r.role === 'canonical'
                  ? text('rewardsProgramme.roleCanonical')
                  : r.role === 'mirror'
                    ? base === null
                      ? text('rewardsProgramme.roleMirrorHome')
                      : format('rewardsProgramme.roleMirror', { base })
                    : r.role === 'unconfigured'
                      ? text('rewardsProgramme.roleUnconfigured')
                      : text('rewardsProgramme.roleDetached')}
            </dd>
            {r.role === 'detached' && r.retirement === null && (
              <>
                <dt className="tier-b">{text('rewardsProgramme.factRetired')}</dt>
                <dd>{missing('retirement')}</dd>
              </>
            )}
            {r.retirement?.retired === true && (
              <>
                <dt className="tier-b">{text('rewardsProgramme.factRetired')}</dt>
                <dd data-testid="rewards-programme-retired">
                  {format('rewardsProgramme.retired', { base: networkName(r.retirement.returnChainId), amount: vpfi(r.retirement.returned) })}{' '}
                  <FullAddress address={r.retirement.returnDeployment} testId="rewards-programme-return" />
                </dd>
              </>
            )}
            <dt className="tier-b">{text('rewardsProgramme.factLaunch')}</dt>
            <dd>{r.launch === null ? missing('launch') : r.launch === 0n ? text('rewardsProgramme.launchNone') : formatUtc(Number(r.launch))}</dd>
            <dt className="tier-b">{text('rewardsProgramme.factFresh')}</dt>
            <dd className="value-amount" data-testid="rewards-programme-fresh">
              {r.funding === null ? missing('funding') : r.funding.noToken ? text('rewardsProgramme.noToken') : vpfi(r.funding.fresh)}
            </dd>
            <dt className="tier-b">{text('rewardsProgramme.factRecycled')}</dt>
            <dd className="value-amount" data-testid="rewards-programme-recycled">
              {r.funding === null ? missing('funding') : r.funding.noToken ? text('rewardsProgramme.noToken') : vpfi(r.funding.recycled)}
            </dd>
            <dt className="tier-b">{text('rewardsProgramme.factCustody')}</dt>
            <dd data-testid="rewards-programme-custody">
              {r.custodyActivated === null ? missing('custody') : text(r.custodyActivated ? 'rewardsProgramme.custodyOn' : 'rewardsProgramme.custodyOff')}
            </dd>
            <dt className="tier-b">{text('rewardsProgramme.factHorizon')}</dt>
            <dd data-testid="rewards-programme-horizon">
              {r.horizonDays === null
                ? missing('horizon')
                : r.horizonDays === 0
                  ? text('rewardsProgramme.horizonOff')
                  : format('rewardsProgramme.horizonOn', { days: String(r.horizonDays) })}
            </dd>
            <dt className="tier-b">{text('rewardsProgramme.factClose')}</dt>
            <dd>{text('rewardsProgramme.closeUnread')}</dd>
          </dl>
        </>
      )}
      <OwnStamp reads={[prog]} />
    </section>
  );
}
