import type { Address } from 'viem';
import { describeGovernanceCall, type DescribedCall, type GovernanceQueue, type GovernanceTarget, type QueuedOperation } from '@vaipakam/lib/governanceQueue';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { governanceTargets, governanceTimelock, useGovernanceQueue } from '../../shared/governance/queue';
import { useScreenChain, type ChainRead } from '../../shared/reads/chainRead';
import { formatExact, formatSpan, formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';

/**
 * Queued governance changes (#3237, RB-GOVERNANCE-QUEUE). A public page: no
 * wallet, nothing of anyone's own. Every change waits out the governance
 * timelock's delay before it can run, and this page is where that wait is
 * visible. It lists every operation the timelock holds on the chain the
 * screen describes, soonest first, with when it can run and what it will
 * do. What it will do is shown only when its calls hash to the id the
 * timelock stores; otherwise the operation is still listed, with its id and
 * time, and the reason its action is unknown. The block the queue was read
 * at is always stated, and a failed read is unknown, never "nothing queued".
 */
export function GovernancePage() {
  const chain = useScreenChain();
  const timelock = governanceTimelock(chain.chainId);
  const queue = useGovernanceQueue(chain.chainId, chain.deployBlock);
  const nowSec = Math.floor(useNow() / 1000);
  return <GovernanceView chain={chain} hasTimelock={timelock !== null} queue={queue} targets={governanceTargets(chain.chainId)} nowSec={nowSec} />;
}

/** The page body for one read of the queue: pure, so every state renders
 *  the same in a unit test as on the page. */
export function GovernanceView({
  chain,
  hasTimelock,
  queue,
  targets,
  nowSec,
}: {
  chain: SupportedChain;
  hasTimelock: boolean;
  queue: Pick<ChainRead<GovernanceQueue>, 'data' | 'state' | 'error' | 'refetch'>;
  targets: readonly GovernanceTarget[];
  nowSec: number;
}) {
  const { text, format } = useCopy();
  let body;
  if (!hasTimelock) {
    body = (
      <Notice tone="warn" tier="A">
        {format('governance.noTimelock', { chain: chain.name })}
      </Notice>
    );
  } else if (queue.state === 'reading') {
    body = <p className="tier-b">{format('governance.reading', { chain: chain.name })}</p>;
  } else if (queue.state === 'failed' || !queue.data) {
    body = (
      <Notice tone="warn" tier="A">
        {format('governance.failed', { chain: chain.name, reason: queue.error ?? 'no answer' })}{' '}
        <button type="button" className="link" onClick={queue.refetch}>
          {text('rail.refresh')}
        </button>
      </Notice>
    );
  } else {
    const q = queue.data;
    body = (
      <>
        <p className="tier-b stamp" data-testid="governance-read-at">
          {format('governance.readAt', { block: q.block.number.toString(), time: formatUtc(Number(q.block.timestamp)) })}
        </p>
        {queue.error !== null && (
          <Notice tone="warn" tier="A">
            {format('governance.rereadFailed', { reason: queue.error })}
          </Notice>
        )}
        <p className="tier-b">{format('governance.minDelay', { delay: formatSpan(Number(q.minDelay)) })}</p>
        {q.operations.length === 0 ? (
          <p className="tier-b" data-testid="governance-empty">
            {format('governance.empty', { chain: chain.name })}
          </p>
        ) : (
          <>
            <p className="tier-b">{format('governance.count', { count: String(q.operations.length) })}</p>
            <ol className="governance-list" data-testid="governance-list">
              {q.operations.map((op, i) => (
                <OperationCard key={op.id} op={op} n={i + 1} chain={chain} targets={targets} nowSec={nowSec} />
              ))}
            </ol>
          </>
        )}
        <p className="tier-a">{text('governance.noExpiry')}</p>
      </>
    );
  }

  return (
    <main className="page governance" aria-labelledby="governance-title">
      <h1 id="governance-title">{text('governance.title')}</h1>
      <p className="tier-a">{format('governance.intro', { chain: chain.name })}</p>
      {body}
    </main>
  );
}

function OperationCard({
  op,
  n,
  chain,
  targets,
  nowSec,
}: {
  op: QueuedOperation;
  n: number;
  chain: SupportedChain;
  targets: readonly GovernanceTarget[];
  nowSec: number;
}) {
  const { text, format } = useCopy();
  const eta = Number(op.eta);
  // The timelock's own `ready` flag was read at the queue's block; a clock
  // that has since passed the time reads as elapsed too. An operation with a
  // predecessor runs only once that one has, so the wait alone is not enough.
  const d = op.details;
  const elapsed = op.ready || eta <= nowSec;
  const waitsOnPredecessor = d.kind === 'proved' && d.predecessorDone === false;
  const runnable = elapsed && !waitsOnPredecessor;
  return (
    <li className="card governance-op" data-testid="governance-op">
      <h2>{format('governance.opTitle', { n: String(n) })}</h2>
      <p className="tier-b" data-testid="governance-op-when">
        {runnable ? text('governance.opReady') : elapsed ? null : format('governance.opWaiting', { time: formatUtc(op.eta), left: formatSpan(eta - nowSec) })}
      </p>
      {d.kind === 'proved' && d.predecessorDone !== null && (
        <p className={d.predecessorDone ? 'tier-b' : 'tier-a'} data-testid="governance-op-after">
          {format(d.predecessorDone ? 'governance.opAfterDone' : 'governance.opAfter', { id: d.predecessor })}
        </p>
      )}
      {d.kind === 'proved' ? (
        <>
          {d.calls.length > 1 && <p className="tier-b">{format('governance.opBatch', { count: String(d.calls.length) })}</p>}
          <ol className="governance-calls">
            {d.calls.map((call, i) => (
              <CallLine key={i} call={describeGovernanceCall(call, targets)} chain={chain} />
            ))}
          </ol>
          <p className="tier-b">
            {format('governance.opScheduled', { block: d.scheduledBlock.toString(), delay: formatSpan(Number(d.delay)) })}{' '}
            <a href={`${chain.blockExplorer}/tx/${d.scheduledTx}`} target="_blank" rel="noreferrer">
              {text('governance.opTx')}
            </a>
          </p>
        </>
      ) : (
        <Notice tone="warn" tier="A">
          {format('governance.unknown', { reason: text(UNKNOWN_REASON[d.reason]) })}
        </Notice>
      )}
      <p className="tier-b governance-id">{format('governance.opId', { id: op.id })}</p>
    </li>
  );
}

const UNKNOWN_REASON: Record<'not-found' | 'unproved' | 'read-failed', CopyKey> = {
  'not-found': 'governance.unknownNotFound',
  unproved: 'governance.unknownUnproved',
  'read-failed': 'governance.unknownReadFailed',
};

const NAMED_TARGETS = new Set([
  'diamond',
  'timelock',
  'sanctionsList',
  'sanctionsDelistingTimelock',
  'sanctionsTestnetOverlay',
  'vpfiToken',
  'vpfiTokenPool',
  'ccipMessenger',
  'rewardMessenger',
  'treasury',
]);

function useTargetName() {
  const { text, format } = useCopy();
  return (key: string | null, address: Address) => {
    if (key === null) return format('governance.target.unlisted', { address });
    if (NAMED_TARGETS.has(key)) return text(`governance.target.${key}` as CopyKey);
    return format('governance.target.other', { key });
  };
}

function CallLine({ call, chain }: { call: DescribedCall; chain: SupportedChain }) {
  const { text, format } = useCopy();
  const targetName = useTargetName();
  const target = targetName(call.targetKey, call.target);
  const a = call.action;
  let line: string;
  switch (a.kind) {
    case 'diamond-cut':
      line = format('governance.action.diamondCut', { target, add: String(a.add), replace: String(a.replace), remove: String(a.remove) });
      break;
    case 'role':
      line = format(a.change === 'grant' ? 'governance.action.roleGrant' : a.change === 'revoke' ? 'governance.action.roleRevoke' : 'governance.action.roleRenounce', {
        role: a.role,
        account: a.account,
        target,
      });
      break;
    case 'delay':
      line = format('governance.action.delay', { delay: formatSpan(Number(a.newDelay)) });
      break;
    case 'pause':
      line = format('governance.action.pause', { target });
      break;
    case 'unpause':
      line = format('governance.action.unpause', { target });
      break;
    case 'ownership':
      line = /^0x0{40}$/i.test(a.newOwner)
        ? format('governance.action.ownershipZero', { target })
        : format('governance.action.ownership', { target, owner: a.newOwner });
      break;
    case 'upgrade':
      line = format('governance.action.upgrade', { target, address: a.implementation });
      break;
    case 'call':
      line = format('governance.action.call', { fn: call.functionName ?? call.selector, target });
      break;
    case 'transfer':
      line = format('governance.action.transfer', { target });
      break;
    case 'undecoded':
      line = format('governance.action.undecoded', { selector: call.selector, target });
      break;
  }
  const init = a.kind === 'diamond-cut' && !/^0x0{40}$/i.test(a.init) ? format('governance.action.diamondCutInit', { address: a.init }) : null;
  return (
    <li className="governance-call" data-testid="governance-call">
      <p className={a.kind === 'call' ? 'tier-b' : 'tier-a'}>{line}</p>
      {init && <p className="tier-a">{init}</p>}
      {call.value > 0n && <p className="tier-a">{format('governance.sendsValue', { value: formatExact(call.value, 18), symbol: chain.nativeGasSymbol })}</p>}
      <details>
        <summary>{text('governance.exactCall')}</summary>
        <dl className="facts governance-args">
          <dt>{call.functionName ?? call.selector}</dt>
          <dd>{call.target}</dd>
          {call.functionName === null ? (
            <>
              <dt>{text('governance.argsUnknown')}</dt>
              <dd />
            </>
          ) : call.args.length === 0 ? (
            <>
              <dt>{text('governance.argsNone')}</dt>
              <dd />
            </>
          ) : (
            call.args.map((arg, i) => (
              <ArgRow key={i} name={arg.name} type={arg.type} value={arg.value} />
            ))
          )}
          <dt>{text('governance.callData')}</dt>
          <dd className="governance-data">{call.data}</dd>
        </dl>
      </details>
    </li>
  );
}

function ArgRow({ name, type, value }: { name: string; type: string; value: string }) {
  return (
    <>
      <dt>
        {name} <span className="tier-b">({type})</span>
      </dt>
      <dd>{value}</dd>
    </>
  );
}
