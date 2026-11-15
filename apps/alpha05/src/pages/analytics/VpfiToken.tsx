import type { ReactNode } from 'react';
import type { SupportedChain } from '../../chain/chains';
import type { Figure } from '../../shared/analytics/figures';
import { holderOf, mintable, recordedVpfiAddresses, type Fact, type VpfiRead, type VpfiTokenFacts } from '../../shared/analytics/vpfiToken';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { formatFigureText } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

/** The allocation lines, in the published order (TokenomicsTechSpec §3). */
const ALLOCATION: readonly { label: CopyKey; line: CopyKey }[] = [
  { label: 'analytics.vpfi.alloc.foundersLabel', line: 'analytics.vpfi.alloc.founders' },
  { label: 'analytics.vpfi.alloc.teamLabel', line: 'analytics.vpfi.alloc.team' },
  { label: 'analytics.vpfi.alloc.testersLabel', line: 'analytics.vpfi.alloc.testers' },
  { label: 'analytics.vpfi.alloc.adminsLabel', line: 'analytics.vpfi.alloc.admins' },
  { label: 'analytics.vpfi.alloc.auditorsLabel', line: 'analytics.vpfi.alloc.auditors' },
  { label: 'analytics.vpfi.alloc.complianceLabel', line: 'analytics.vpfi.alloc.compliance' },
  { label: 'analytics.vpfi.alloc.bountyLabel', line: 'analytics.vpfi.alloc.bounty' },
  { label: 'analytics.vpfi.alloc.listingsLabel', line: 'analytics.vpfi.alloc.listings' },
  { label: 'analytics.vpfi.alloc.ecosystemLabel', line: 'analytics.vpfi.alloc.ecosystem' },
  { label: 'analytics.vpfi.alloc.rewardsLabel', line: 'analytics.vpfi.alloc.rewards' },
  { label: 'analytics.vpfi.alloc.reserveLabel', line: 'analytics.vpfi.alloc.reserve' },
  { label: 'analytics.vpfi.alloc.totalLabel', line: 'analytics.vpfi.alloc.total' },
];

/** The cap the published allocation divides (230,000,000 VPFI, 18 decimals). */
const PUBLISHED_CAP = 230_000_000n * 10n ** 18n;

/**
 * RW-60 — the VPFI token's facts on the chosen network, the addresses this
 * app's deployment record names on every network it serves, and the
 * published allocation. Figures come from the token contract at the page's
 * block; a fact that failed says so in place. No price, return or scarcity
 * is stated, and the undecided reserve is shown as undecided.
 */
export function VpfiToken({ chain, vpfi }: { chain: SupportedChain; vpfi: Figure<VpfiRead> }) {
  const { text, format } = useCopy();
  const recorded = recordedVpfiAddresses();
  const homeName = recorded.find((r) => r.home)?.chain.name ?? null;
  let body: ReactNode;
  if (!vpfi.ok) {
    body = (
      <Notice tone="warn" tier="A">
        {format('analytics.vpfi.unread', { chain: chain.name, reason: vpfi.reason })}
      </Notice>
    );
  } else if (vpfi.value.kind === 'none') {
    body = (
      <p className="tier-a" data-testid="analytics-vpfi-none">
        {format('analytics.vpfi.none', { chain: chain.name })}
      </p>
    );
  } else {
    body = (
      <TokenFacts chain={chain} t={vpfi.value.facts} homeName={homeName} recorded={recorded.find((r) => r.chain.chainId === chain.chainId)?.token ?? null} />
    );
  }
  return (
    <section aria-labelledby="analytics-vpfi">
      <h2 id="analytics-vpfi">{text('analytics.vpfi.title')}</h2>
      <p className="tier-a">{text('analytics.vpfi.intro')}</p>
      {body}
      <h3>{text('analytics.vpfi.addressesTitle')}</h3>
      <p className="tier-b">{text('analytics.vpfi.addressesSource')}</p>
      <dl className="facts" data-testid="analytics-vpfi-addresses">
        {recorded.map((r) => (
          <AddressRow key={r.chain.chainId} chain={r.chain} token={r.token} home={r.home} />
        ))}
      </dl>
      <h3>{text('analytics.vpfi.allocationTitle')}</h3>
      <p className="tier-a">{text('analytics.vpfi.allocationIntro')}</p>
      <dl className="facts" data-testid="analytics-vpfi-allocation">
        {ALLOCATION.map((a) => (
          <Line key={a.label} label={text(a.label)}>
            {text(a.line)}
          </Line>
        ))}
      </dl>
    </section>
  );
}

function Line({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

function AddressRow({ chain, token, home }: { chain: SupportedChain; token: Hex; home: boolean }) {
  const { text } = useCopy();
  return (
    <Line label={`${chain.name} · ${text(home ? 'analytics.vpfi.homeTag' : 'analytics.vpfi.bridgedTag')}`}>
      <a className="analytics-address" href={`${chain.blockExplorer}/token/${token}`} target="_blank" rel="noreferrer">
        {token}
      </a>
    </Line>
  );
}

function TokenFacts({ chain, t, homeName, recorded }: { chain: SupportedChain; t: VpfiTokenFacts; homeName: string | null; recorded: Hex | null }) {
  const { text, format } = useCopy();
  const unread = (f: Fact<unknown>) => (f.ok ? null : format('analytics.unread', { reason: f.reason }));
  const amount = (f: Fact<bigint>) => {
    if (!f.ok) return unread(f);
    // The token's own decimals, never assumed: unread decimals show base units.
    if (!t.decimals.ok) return format('analytics.vpfi.baseUnits', { amount: f.value.toString() });
    // The token's own symbol, never assumed: an unread symbol says so.
    return t.symbol.ok
      ? `${formatFigureText(f.value, t.decimals.value)} ${t.symbol.value}`
      : format('analytics.vpfi.symbolUnread', { amount: formatFigureText(f.value, t.decimals.value) });
  };
  const who = (f: Fact<Hex>) => {
    if (!f.ok) return unread(f);
    const h = holderOf(f.value, chain);
    return h === 'other' ? f.value : format(h === 'diamond' ? 'analytics.vpfi.isDiamond' : 'analytics.vpfi.isTimelock', { address: f.value });
  };
  const h = t.homeFacts;
  const left = h ? mintable(h, t.supply) : null;
  // Whether a minter change must wait on the timelock is said only from an
  // owner that was read; an unread owner says that instead.
  const mintKey = !t.owner.ok
    ? 'analytics.vpfi.mintOwnerUnread'
    : holderOf(t.owner.value, chain) === 'timelock'
      ? 'analytics.vpfi.mintGoverned'
      : 'analytics.vpfi.mintOwner';
  return (
    <>
      {t.paused.ok ? (
        t.paused.value && (
          <Notice tone="warn" tier="A">
            {format('analytics.vpfi.paused', { chain: chain.name })}
          </Notice>
        )
      ) : (
        <Notice tone="warn" tier="A">
          <span data-testid="analytics-vpfi-paused-unread">{format('analytics.vpfi.pausedUnread', { chain: chain.name, reason: t.paused.reason })}</span>
        </Notice>
      )}
      <dl className="facts" data-testid="analytics-vpfi">
        <Line label={text('analytics.vpfi.name')}>{t.name.ok ? t.name.value : unread(t.name)}</Line>
        <Line label={text('analytics.vpfi.symbol')}>{t.symbol.ok ? t.symbol.value : unread(t.symbol)}</Line>
        <Line label={text('analytics.vpfi.decimals')} testId="analytics-vpfi-decimals">
          {t.decimals.ok ? String(t.decimals.value) : unread(t.decimals)}
        </Line>
        <Line label={text('analytics.vpfi.address')}>
          <a className="analytics-address" href={`${chain.blockExplorer}/token/${t.token}`} target="_blank" rel="noreferrer">
            {t.token}
          </a>
        </Line>
        <Line label={text(h ? 'analytics.vpfi.supply' : 'analytics.vpfi.localSupply')} testId="analytics-vpfi-supply">
          {amount(t.supply)}
        </Line>
        {h && (
          <>
            <Line label={text('analytics.vpfi.cap')} testId="analytics-vpfi-cap">
              {amount(h.cap)}
            </Line>
            <Line label={text('analytics.vpfi.mintable')} testId="analytics-vpfi-mintable">
              {left === null ? text('analytics.vpfi.mintableUnread') : amount({ ok: true, value: left })}
            </Line>
            <Line label={text('analytics.vpfi.initialMint')}>{amount(h.initialMint)}</Line>
            <Line label={text('analytics.vpfi.minter')} testId="analytics-vpfi-minter">
              {who(h.minter)}
            </Line>
          </>
        )}
        <Line label={text('analytics.vpfi.owner')} testId="analytics-vpfi-owner">
          {who(t.owner)}
        </Line>
      </dl>
      <p className="tier-a" data-testid="analytics-vpfi-where">
        {t.home === true
          ? format('analytics.vpfi.homeNote', { chain: chain.name })
          : t.home === false
            ? format('analytics.vpfi.bridgedNote', { chain: chain.name, home: homeName ?? text('analytics.vpfi.homeUnnamed') })
            : format('analytics.vpfi.homeUnread', { chain: chain.name })}
      </p>
      {h && <p className="tier-a">{text(mintKey)}</p>}
      {h && h.cap.ok && h.cap.value !== PUBLISHED_CAP && (
        <Notice tone="warn" tier="A">
          {text('analytics.vpfi.capDiffers')}
        </Notice>
      )}
      {recorded !== null && recorded.toLowerCase() !== t.token.toLowerCase() && (
        <Notice tone="warn" tier="A">
          <span data-testid="analytics-vpfi-record-differs">{format('analytics.vpfi.recordDiffers', { record: recorded })}</span>
        </Notice>
      )}
    </>
  );
}
