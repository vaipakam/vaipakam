import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { EVENTLESS_PROTOCOL_KNOBS } from '@vaipakam/lib/protocolKnobs';
import type { SupportedChain } from '../../chain/chains';
import { SETTINGS, SETTING_GROUPS, isSettingKey, settingLabel, writeValue, type SettingGroup, type SettingKey } from '../../shared/console/catalogue';
import { readDirect, readPauseAt, type PauseRead } from '../../shared/console/direct';
import { readConfigSnapshot, type SettingValues } from '../../shared/console/snapshot';
import { ageOf, settleSettings, type ConsoleSettings } from '../../shared/console/source';
import { SWITCHES, switchEffect, switchName, switchState, type SwitchClass } from '../../shared/console/switches';
import { useCopy, type CopyAccess, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { useChainRead, useScreenChain, type ChainRead } from '../../shared/reads/chainRead';
import { IndexerUnavailable } from '../../shared/reads/world/indexerClient';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { formatAge, formatSpan, formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';

/**
 * The Protocol Console (RW-76, RW-77): the protocol's settings and switches
 * on the screen's network, read-only and public. No wallet, no controls,
 * reachable by direct link. The settings come from the index's snapshot
 * while it may be shown, else from one direct read of the chain, and the
 * page always says which, how old, and why (`source.ts`). The global pause
 * is read live at one block, since it lapses with the clock.
 */
export function ConsolePage() {
  const chain = useScreenChain();
  const world = useWorldRail();
  const settings = useChainRead(['console', 'settings', chain.diamondAddress, world.indexer.origin], (client, c) =>
    settleSettings({
      snapshot: () =>
        world.indexer.origin === null
          ? Promise.reject(new IndexerUnavailable('not-configured', 'This build has no index.'))
          : readConfigSnapshot(world.indexer, c.chainId),
      direct: () => readDirect(client, c.diamondAddress, getDeployment(c.chainId)?.facets),
      nowSec: () => Math.floor(Date.now() / 1000),
    }),
  );
  const pause = useChainRead(['console', 'pause', chain.diamondAddress], (client, c) => readPauseAt(client, c.diamondAddress));
  const nowSec = Math.floor(useNow() / 1000);
  return <ConsoleView chain={chain} settings={settings} pause={pause} nowSec={nowSec} />;
}

type Read<T> = Pick<ChainRead<T>, 'data' | 'state' | 'error' | 'refetch'>;

/** The page body for one read of each source: pure, so every state renders
 *  the same in a unit test as on the page. */
export function ConsoleView({
  chain,
  settings,
  pause,
  nowSec,
}: {
  chain: SupportedChain;
  settings: Read<ConsoleSettings>;
  pause: Read<PauseRead>;
  nowSec: number;
}) {
  const { text, format } = useCopy();
  const s = settings.data;
  const values = s && s.source !== 'unknown' ? s.values : null;
  return (
    <main className="page console" aria-labelledby="console-title">
      <h1 id="console-title">{text('console.title')}</h1>
      <p className="tier-a">{format('console.intro', { chain: chain.name })}</p>
      <p className="tier-b">
        <Link to="/governance">{text('console.governanceLink')}</Link>
      </p>
      {settings.state === 'reading' || !s ? (
        <p className="tier-b">{format('console.reading', { chain: chain.name })}</p>
      ) : (
        <Provenance chain={chain} s={s} nowSec={nowSec} refetch={settings.refetch} />
      )}
      <PauseSection chain={chain} pause={pause} values={values} known={s !== null} nowSec={nowSec} />
      <SwitchesSection values={values} known={s !== null} />
      {s && s.source !== 'unknown' && <SettingsSection chain={chain} s={s} />}
      <p className="tier-a">{text('console.perLoan')}</p>
      <p className="tier-b">{text('console.runningTotals')}</p>
      <p className="tier-a" data-testid="console-subset">
        {text('console.subset')}
      </p>
    </main>
  );
}

function Provenance({ chain, s, nowSec, refetch }: { chain: SupportedChain; s: ConsoleSettings; nowSec: number; refetch: () => void }) {
  const { text, format } = useCopy();
  const attrs = { 'data-testid': 'console-source', 'data-source': s.source, 'data-why': s.source === 'snapshot' ? undefined : s.why };
  const whyLine = s.source === 'snapshot' ? null : <WhyLine chain={chain} why={s.why} indexError={s.indexError} />;
  if (s.source === 'unknown') {
    return (
      <div {...attrs}>
        {whyLine}
        <Notice tone="warn" tier="A">
          {s.failure.kind === 'read'
            ? format('console.unknownRead', { chain: chain.name, reason: s.failure.reason })
            : format('console.unknownBehind', { chain: chain.name, direct: String(s.failure.directBlock), snapshot: String(s.failure.snapshotBlock) })}{' '}
          <button type="button" className="link" onClick={refetch}>
            {text('rail.refresh')}
          </button>
        </Notice>
      </div>
    );
  }
  const age = ageOf(s.asOf, nowSec);
  const vars = { block: String(s.block), time: formatUtc(s.asOf), age: age.kind === 'known' ? formatAge(age.seconds) : '' };
  let line: string;
  if (s.source === 'snapshot') line = format('console.sourceSnapshot', vars);
  else line = format(age.kind === 'known' ? 'console.sourceChain' : 'console.sourceChainUndated', vars);
  return (
    <div {...attrs} data-block={String(s.block)}>
      <p className="tier-b stamp">
        {line}{' '}
        <button type="button" className="link" onClick={refetch}>
          {text('rail.refresh')}
        </button>
      </p>
      <WhyLink summaryKey="console.sourceSummary" detailKey="console.sourceWhy" />
      {whyLine}
      {age.kind === 'unknown' && (
        <Notice tone="warn" tier="A">
          {text('console.ageUnknown')}
        </Notice>
      )}
      {age.kind === 'known' && age.old && (
        <Notice tone="warn" tier="A">
          {text('console.ageOld')}
        </Notice>
      )}
      {s.source === 'chain' && s.bundleIssue?.kind === 'codeChanged' && (
        <Notice tone="warn" tier="A">
          <span data-testid="console-code-changed">{text('console.codeChanged')}</span>
        </Notice>
      )}
      {s.source === 'chain' && s.bundleIssue?.kind === 'unreadable' && (
        <Notice tone="warn" tier="A">
          {format('console.bundleUnreadable', { reason: s.bundleIssue.reason })}
        </Notice>
      )}
    </div>
  );
}

const WHY_KEY = {
  unreachable: 'console.why.unreachable',
  none: 'console.why.none',
  unlabelled: 'console.why.unlabelled',
  behind: 'console.why.behind',
  undated: 'console.why.undated',
  future: 'console.why.future',
  old: 'console.why.old',
} as const satisfies Record<Exclude<ConsoleSettings, { source: 'snapshot' }>['why'], CopyKey>;

const INDEX_REASON = {
  'not-configured': 'console.index.notConfigured',
  network: 'console.index.network',
  status: 'console.index.status',
  shape: 'console.index.shape',
} as const satisfies Record<IndexerUnavailable['why'], CopyKey>;

/** Why the index's snapshot could not be read, worded for this page: the
 *  offer book's reasons name the offer index, which this page does not read. */
function consoleIndexReason(e: Error, text: CopyAccess['text']): string {
  return e instanceof IndexerUnavailable ? text(INDEX_REASON[e.why]) : e.message;
}

function WhyLine({ chain, why, indexError }: { chain: SupportedChain; why: keyof typeof WHY_KEY; indexError: Error | null }) {
  const { text, format } = useCopy();
  const reason = indexError ? consoleIndexReason(indexError, text) : text('console.noReason');
  const line = format(WHY_KEY[why], { chain: chain.name, reason });
  return why === 'unlabelled' ? (
    <Notice tone="warn" tier="A">
      {line}
    </Notice>
  ) : (
    <p className={why === 'unreachable' || why === 'behind' ? 'tier-a' : 'tier-b'}>{line}</p>
  );
}

function PauseSection({
  chain,
  pause,
  values,
  known,
  nowSec,
}: {
  chain: SupportedChain;
  pause: Read<PauseRead>;
  values: SettingValues | null;
  known: boolean;
  nowSec: number;
}) {
  const { text, format } = useCopy();
  const p = pause.data;
  let state;
  if (pause.state === 'reading' || (!p && pause.state !== 'failed')) state = <p className="tier-b">{format('console.pause.reading', { chain: chain.name })}</p>;
  else if (!p) {
    state = (
      <Notice tone="warn" tier="A">
        <span data-testid="console-pause" data-pause="unknown">
          {format('console.pause.failed', { chain: chain.name, reason: pause.error ?? '' })}
        </span>
      </Notice>
    );
  } else if (pause.error) {
    // A refresh failed with an older answer still held: what holds now is
    // unknown, and the older answer is not shown as current.
    state = (
      <Notice tone="warn" tier="A">
        <span data-testid="console-pause" data-pause="unknown">
          {format('console.pause.refreshFailed', { chain: chain.name, reason: pause.error, block: p.block.toString() })}
        </span>
      </Notice>
    );
  } else if (!p.paused) {
    state = (
      <p className="tier-b" data-testid="console-pause" data-pause="none">
        {format('console.pause.none', { block: p.block.toString(), time: formatUtc(p.timestamp) })}
      </p>
    );
  } else if (p.manual) {
    state = (
      <Notice tone="warn" tier="A">
        <span data-testid="console-pause" data-pause="manual">
          {format('console.pause.manual', { block: p.block.toString() })}
          {p.pausedUntil > 0n && <> {format('console.pause.manualWithWindow', { until: formatUtc(p.pausedUntil) })}</>}
        </span>
      </Notice>
    );
  } else {
    const until = Number(p.pausedUntil);
    state = (
      <Notice tone="warn" tier="A">
        <span data-testid="console-pause" data-pause="auto">
          {until > nowSec
            ? format('console.pause.auto', { block: p.block.toString(), until: formatUtc(p.pausedUntil), left: formatSpan(until - nowSec) })
            : format('console.pause.autoEnded', { block: p.block.toString(), until: formatUtc(p.pausedUntil) })}
        </span>
      </Notice>
    );
  }
  return (
    <section aria-labelledby="console-pause-title">
      <h2 id="console-pause-title">{text('console.pause.title')}</h2>
      {state}
      <p className="tier-a">{text('console.pause.blocks')}</p>
      <NextAutoPause values={values} known={known} nowSec={nowSec} />
    </section>
  );
}

function NextAutoPause({ values, known, nowSec }: { values: SettingValues | null; known: boolean; nowSec: number }) {
  const { text, format } = useCopy();
  if (!known) return null;
  const at = values?.autoPauseAvailableAt;
  const length = values?.autoPauseDurationSeconds;
  const lines: string[] = [];
  if (typeof at !== 'string' || !/^\d+$/.test(at)) lines.push(text('console.pause.nextUnknown'));
  else if (at === '0') lines.push(text('console.pause.nextNever'));
  else if (Number(at) > nowSec) lines.push(format('console.pause.nextAt', { time: formatUtc(BigInt(at)), left: formatSpan(Number(at) - nowSec) }));
  else lines.push(format('console.pause.nextPassed', { time: formatUtc(BigInt(at)) }));
  if (typeof length === 'string' && /^\d+$/.test(length)) lines.push(format('console.pause.length', { span: formatSpan(Number(length)) }));
  return (
    <p className="tier-b" data-testid="console-next-pause">
      {lines.join(' ')}
    </p>
  );
}

const CLASS_KEY = {
  '1a': 'console.switches.cls.1a',
  '1b': 'console.switches.cls.1b',
  '4': 'console.switches.cls.4',
  other: 'console.switches.cls.other',
} as const satisfies Record<SwitchClass, CopyKey>;

function SwitchesSection({ values, known }: { values: SettingValues | null; known: boolean }) {
  const { text } = useCopy();
  return (
    <section aria-labelledby="console-switches-title">
      <h2 id="console-switches-title">{text('console.switches.title')}</h2>
      <p className="tier-a">{text('console.switches.intro')}</p>
      <WhyLink summaryKey="console.switches.whySummary" detailKey="console.switches.whyDetail" />
      <ul className="console-switches" data-testid="console-switches">
        {SWITCHES.map((sw) => {
          const state = known ? switchState(sw, values) : 'unknown';
          return (
            <li key={sw.id} className="card" data-switch={sw.id} data-state={state}>
              <h3>{text(switchName(sw))}</h3>
              <p className="tier-b">
                <span className="badge">{text(CLASS_KEY[sw.cls])}</span> <strong>{text(`console.switches.state.${state}`)}</strong>
              </p>
              <p className="tier-b">{text(switchEffect(sw))}</p>
            </li>
          );
        })}
      </ul>
      <p className="tier-b">{text('console.switches.assets')}</p>
      <p className="tier-a">{text('console.switches.keeperPasses')}</p>
    </section>
  );
}

function SettingsSection({ chain, s }: { chain: SupportedChain; s: Exclude<ConsoleSettings, { source: 'unknown' }> }) {
  const { text, format } = useCopy();
  const w = { text, format };
  const byGroup = new Map<SettingGroup, SettingKey[]>();
  const other: string[] = [];
  for (const key of Object.keys(s.values)) {
    if (!isSettingKey(key)) {
      other.push(key);
      continue;
    }
    const spec = SETTINGS[key];
    if (spec.format === 'switch') continue;
    byGroup.set(spec.group, [...(byGroup.get(spec.group) ?? []), key]);
  }
  const unanswered = s.unreported.filter((k) => !(k in s.values));
  return (
    <section aria-labelledby="console-settings-title" data-testid="console-settings">
      <h2 id="console-settings-title">{text('console.settings.title')}</h2>
      {SETTING_GROUPS.filter((g) => byGroup.has(g)).map((g) => (
        <section key={g} aria-labelledby={`console-group-${g}`} className="console-group">
          <h3 id={`console-group-${g}`}>{text(`console.settings.group.${g}`)}</h3>
          <dl className="facts">
            {byGroup.get(g)!.map((key) => (
              <Fragment key={key}>
                <dt data-setting={key}>{text(settingLabel(key))}</dt>
                <dd data-setting={key} data-value={JSON.stringify(s.values[key])}>
                  {writeValue(key, s.values[key]!, w)}
                  {s.source === 'snapshot' && EVENTLESS_PROTOCOL_KNOBS.has(key) && <span className="tier-b console-note">{text('console.eventless')}</span>}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
      {other.length > 0 && (
        <section aria-labelledby="console-group-other" className="console-group">
          <h3 id="console-group-other">{text('console.settings.other')}</h3>
          <dl className="facts">
            {other.map((key) => (
              <Fragment key={key}>
                <dt data-setting={key}>{key}</dt>
                <dd data-setting={key}>{JSON.stringify(s.values[key])}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}
      {unanswered.length > 0 && (
        <div data-testid="console-unanswered">
          <p className="tier-b">{format('console.settings.notAnswered', { chain: chain.name })}</p>
          <ul className="console-unanswered">
            {unanswered.map((k) => (
              <li key={k} data-setting={k}>
                {isSettingKey(k) ? text(settingLabel(k)) : k}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
