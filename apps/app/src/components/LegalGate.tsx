/**
 * Connected-route Terms-of-Service gate (#1961).
 *
 * Renders `children` only once the connected wallet has accepted the ToS
 * version currently in force. The retired `apps/defi` app had this; the
 * successor shipped without it, which meant governance could activate a
 * ToS version and no user would ever be asked to accept it — the
 * contracts delegate this enforcement to the client and have no
 * per-action backstop, so an absent gate is a bypass rather than a
 * missing convenience.
 *
 * THIS module is deliberately light. It is in the shell's entry graph,
 * so anything it imports lands in every first paint; the two questions
 * it answers here — is a wallet connected, is this an exit route — need
 * no contract access at all. Everything that reads the chain lives in
 * `LegalGateActive`, loaded only once a wallet is connected and a
 * decision is actually required (review round 2 P2).
 *
 * The decision itself, and why each branch falls the way it does, is in
 * `tosGate.ts` and `LegalGateActive`. Two rules are settled here:
 *
 *   - Not connected → pass through. There is nothing to gate: the write
 *     flows already refuse an unconnected wallet, and double-gating
 *     would replace each page's own "connect first" affordance with a
 *     worse one.
 *   - EXIT ROUTES are never gated, whatever the verdict — see
 *     `tosExitRoutes.ts`. A control over new business is legitimate; the
 *     same control over somebody's ability to repay a loan or withdraw
 *     their own assets is not, and the first cut of this component did
 *     exactly that while its own footnote promised otherwise. Checked
 *     BEFORE any verdict, because it must hold in the states where the
 *     verdict is unknown.
 *
 * The route exemption is an AFFORDANCE, not the enforcement — it lets a
 * held user reach the page carrying the repay button. What stops that
 * same user taking on new exposure from an exempt page is the write
 * allowlist in `tosWriteGate.ts`, checked in `useDiamondWrite`.
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useActiveChain } from '../chain/useActiveChain';
import { isExitRoute } from '../contracts/tosExitRoutes';
import { TermsStatusCard } from './TermsStatusCard';

interface GateProps {
  /** Optional so this can stand in for `LegalGateActive` as the lazy
   *  import's rejection fallback, which types it optional. Absent reads
   *  as GATED — the fail-closed direction, since a missing exemption
   *  withholds a page rather than opening one. */
  exempt?: boolean;
  children?: ReactNode;
}

/**
 * What renders when the gate's own chunk cannot be fetched — a deploy
 * invalidating a cached asset, or a CDN blip.
 *
 * Same shape as the Suspense fallback: on an exempt route the gate has
 * nothing to render (the children are siblings of this whole subtree —
 * see `LegalGate`), and a gated route holds the closed card, because
 * the gate failing to load is not permission to bypass it.
 */
function LegalGateUnavailable({ exempt }: GateProps) {
  if (exempt) return null;
  // Review round 12 P2: with a RETRY, because React caches a resolved
  // lazy payload permanently — and this one resolves successfully, to
  // this component. So a single transient chunk failure would otherwise
  // pin every gated route on the checking card for the life of the
  // page: the Terms query never mounts, the user can neither accept nor
  // write, and nothing recovers even once the asset is back. Failing
  // closed is right; failing closed with no way out is a trap, the same
  // one the disabled-query fix removed before review round 1.
  //
  // A reload is the honest control here rather than a re-import: the
  // chunk is fetched by URL from a build the page already has, so
  // recovering from a deployment that invalidated it means fetching the
  // document again, not retrying the same URL.
  return <TermsStatusCard onRetry={() => window.location.reload()} />;
}

// Review round 10 P2: the import rejection is handled HERE rather than
// by an ErrorBoundary around the rendered gate. Round 8 wrapped the
// subtree in a boundary, which caught what it was aimed at — and also
// every error thrown by the routed page inside it, once the verdict
// passed and `children` were rendering. An ordinary page crash on a
// gated route then showed "checking the terms" forever, hiding
// `AppShell`'s route boundary and the reload control it offers: a
// crash misreported as a pending check, with no way out.
//
// Resolving the rejection into a component instead scopes the recovery
// to exactly the failure it is for. Nothing wraps `children`, so a page
// error propagates to the route boundary as it did before this
// component existed. React caches the resolved lazy result either way,
// so this retries no less than the boundary did.
const LegalGateActive = lazy(() =>
  import('./LegalGateActive')
    .then((m) => ({ default: m.LegalGateActive }))
    .catch(() => ({ default: LegalGateUnavailable })),
);

export function LegalGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { address } = useActiveChain();

  // Review round 5 P1: an exit route renders its children, but the read
  // still MOUNTS. Returning early here left `useTosAcceptance`
  // unmounted on `/vpfi` and `/positions/:loanId`, so the write gate —
  // which reads that query's cache — saw "not checked" and refused
  // deposits and refinancing even with no Terms in force. The exemption
  // is about what a held user may SEE; it was never meant to stop the
  // app finding out whether they are held.
  const exempt = isExitRoute(pathname);

  // A GATED route keeps children INSIDE the boundary, where they
  // belong: they must not render at all until the verdict passes, so
  // the fallback holds the closed card rather than the page. Review
  // round 8 P1: the chunk can FAIL as well as be slow, which Suspense
  // does not cover — handled at the import above, landing on the same
  // outcome.
  const gate = (
    <Suspense fallback={<LegalGateUnavailable exempt={exempt}>{children}</LegalGateUnavailable>}>
      <LegalGateActive exempt={exempt}>{exempt ? null : children}</LegalGateActive>
    </Suspense>
  );

  // The two PASS-THROUGH cases — no wallet, and an exempt route — share
  // one shape, and that is load-bearing rather than tidiness.
  //
  // Children rendered INSIDE the boundary were rendered twice over: once
  // in the Suspense fallback, then again under `LegalGateActive` when
  // the chunk resolved. Those are different positions in the tree, so
  // React tears the first down and builds the second — the page
  // REMOUNTS mid-visit, losing focus, scroll, in-flight typing and every
  // piece of component state on it. On `/desk` that detached an input
  // from under a fill and failed the gasless-loop scenario; it would do
  // the same to a user halfway through the same form.
  //
  // Connecting a wallet did it too, and that is the likelier trigger in
  // practice: `!address` used to return a bare fragment and then switch
  // to the boundary, so the page a visitor was already looking at was
  // rebuilt the moment they connected.
  //
  // Keeping ONE shape across both — children first, gate second, the
  // gate slot empty when there is nothing to mount — means the page
  // reconciles in place through the connect and through the chunk
  // arriving. The gate still mounts beside it so the read runs (round 5
  // P1's requirement, and the reason an exempt route loads this chunk at
  // all) and renders nothing while pending, resolved or failed.
  if (!address || exempt) {
    return (
      <>
        {children}
        {address ? gate : null}
      </>
    );
  }
  return gate;
}
