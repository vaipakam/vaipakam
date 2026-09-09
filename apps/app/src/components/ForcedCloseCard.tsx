/**
 * "This loan is overdue" — the lender's forced close-out.
 *
 * `DefaultedFacet.triggerDefault` has been on-chain the whole time and
 * has never had a surface in this app, so a lender whose borrower
 * simply stopped paying could watch the grace period expire and had no
 * way to act on it from the product. This card is that way.
 *
 * ## Why it renders in states it cannot act on
 *
 * Every non-terminal readiness renders, including `unknown` and
 * `not-yet`. That is the opposite of the usual "hide what you can't
 * do" instinct, and it is deliberate: a lender cannot ask for a route
 * they have never been shown, and this capability stayed invisible for
 * exactly as long as nothing drew it. A card that explains what it is
 * waiting on is worth more here than a clean empty space.
 *
 * ## The one state that shows no button on purpose
 *
 * `ready-needs-route` is genuinely closable on-chain — a keeper could
 * do it this second — but the app cannot build the `AdapterCall[]` the
 * contract requires for liquid collateral, and `swapWithFailover`
 * reverts `NoEnabledSwapRoute` on an empty try-list rather than falling
 * back. So there is no submit button: offering one would sell the
 * lender a guaranteed revert at their own expense. The card says the
 * position is eligible and that the app is the limitation, because
 * blaming the protocol for an app gap would send them to the wrong
 * place for help.
 *
 * ## What this card never says
 *
 * No amount, ever — `triggerDefault` picks between an internal match, a
 * DEX sale and a full-collateral fallback while the transaction runs.
 * No exclusivity — the call is permissionless. And never that money
 * arrives on its own; closing sets the loan terminal and the lender
 * claims afterwards. Each of those would be a sentence the contract
 * does not support, on the one card whose whole job is telling somebody
 * how they get paid.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { AlertTriangle } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useDiamondWrite, DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { ConfirmReceipt } from './ConfirmReceipt';
import {
  canSubmitFromApp,
  shouldRenderForcedClose,
  type ForcedCloseReadiness,
} from '../data/forcedClose';

/** How long to watch for a receipt before concluding the transaction
 *  never made it. Generous enough to cover a slow L2 inclusion, short
 *  enough that a lender whose transaction was dropped is not locked out
 *  of retrying. Releasing here is safe: the readiness reads are still
 *  the binding judgement, and a close-out that DID land leaves the loan
 *  terminal, which unmounts this card entirely. */
const RECEIPT_GIVE_UP_MS = 3 * 60_000;

export function ForcedCloseCard({
  loanId,
  readiness,
  matchFallback,
  swapToRepayPossible,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  busy,
  setBusy,
  onClosedOut,
  readsUpdatedAt,
  preSubmitBlock,
}: {
  loanId: string | number;
  /** Resolved by `decideForcedClose` from live reads — never derived
   *  in this component. The card renders the decision; it does not
   *  make it. */
  readiness: ForcedCloseReadiness;
  /** Where the close-out lands if the internal-match candidate is gone
   *  by the time the transaction mines. Read ONLY on
   *  `ready-internal-match`. Resolved on the page by
   *  `forcedCloseWithoutMatch` — like `readiness`, never derived here. */
  matchFallback: ForcedCloseReadiness;
  /** Whether this loan's shape can carry a swap-to-repay intent at all.
   *
   *  `SwapToRepayIntentFacet` reverts `UnsupportedLoanShape` unless BOTH
   *  legs are ERC-20 and BOTH are Liquid, so a rental, NFT collateral,
   *  or an illiquid asset on either leg can never have one. `false` for
   *  a shape the contract rejects, `undefined` when the app has not read
   *  enough to say. Never derived here. */
  swapToRepayPossible: boolean | undefined;
  /** The page's single confirmation slot — opening this receipt closes
   *  any other, matching every other write card on the page. */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The page-wide write mutex, so two wallet prompts cannot race. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Lets the page refetch status after the loan goes terminal. */
  onClosedOut: () => void;
  /** When the readiness reads behind this card were last refreshed.
   *
   *  The card holds its post-submit state only until this passes the
   *  submit stamp — see `submitted` below. Sourced from the queries
   *  themselves rather than a timer, so the hold is released by
   *  evidence rather than by a guess about how long a refetch takes. */
  readsUpdatedAt: number;
  /** The page's live sale-settlement re-check, run immediately before
   *  sending. Returns a message to show and abort on, or `null` to
   *  proceed.
   *
   *  Separate from the `triggerDefault` simulation below and NOT
   *  replaceable by it: the contract does not inspect the sale link at
   *  all, so a close-out that would strand an accepted sale's manual
   *  completion simulates and executes perfectly (round 32 P1). This is
   *  a product-level interlock, and it has to be asked as one. */
  preSubmitBlock: () => Promise<string | null>;
}) {
  const { write, ready } = useDiamondWrite();
  const { walletChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /** Stamped when a close-out confirms, and released as soon as the
   *  reads have caught up with it.
   *
   *  Round 28 P2 asked for the hold: the refetch after a successful
   *  close is fire-and-forget, so TanStack keeps serving
   *  `defaultable: true` and the old route verdict while it
   *  revalidates, and `useLoan` can hold a still-Active indexed row
   *  for longer still. Without it the button reappeared under the
   *  lender within the same second and invited a second wallet prompt
   *  for a loan that is now terminal.
   *
   *  Round 29 caught what the FIRST version of that hold got wrong: it
   *  never released. `triggerDefault` can succeed on a PARTIAL internal
   *  match, which settles part of the position and deliberately leaves
   *  the loan Active — this card's own copy now says so. A permanent
   *  latch answered that by replacing an actionable card with "the
   *  loan is ending" forever, on a residual that genuinely still needs
   *  closing.
   *
   *  So the hold is bounded by EVIDENCE rather than by time or by
   *  optimism: it covers exactly the window between the submit and the
   *  first read that postdates it. Once `readsUpdatedAt` passes the
   *  stamp, the verdict on screen was computed from post-close data
   *  and is trustworthy either way — a terminal loan unmounts the card
   *  through the page's own reconciliation, and a live residual gets
   *  its button back.
   *
   *  The stamp carries chain and loan identity because
   *  `PositionDetailsInner` is keyed by loan id alone, so a chain
   *  switch keeps this component mounted (round 29's second finding).
   *  The page's chain-change block clears its own confirmation slot but
   *  cannot reach child state, which would have shown loan N on the
   *  destination chain as already closed. */
  const [submitted, setSubmitted] = useState<{
    at: number;
    chainId: number | undefined;
    loanId: string;
    /** The transaction this hold is about. The hold is reconciled
     *  against THIS, not against how recently unrelated reads settled. */
    hash: `0x${string}`;
  } | null>(null);

  /** The give-up deadline as a TIMER, not a `Date.now()` read in render.
   *
   *  Computing it during render is impure — eslint's react-hooks rule
   *  catches it — and it is also wrong on its own terms: the comparison
   *  would only take effect on whatever unrelated re-render happened to
   *  come next, so the hold could outlive the deadline indefinitely on a
   *  quiet card. A timer fires on its own. */
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  useEffect(() => {
    if (submitted === null) return;
    // Keyed by HASH rather than reset to false on entry: a synchronous
    // setState in an effect body is the cascading-render pattern eslint
    // rejects, and it is unnecessary here — a new submission carries a
    // different hash, so a stale give-up simply stops matching.
    const h = submitted.hash;
    const t = setTimeout(() => setGaveUpOn(h), RECEIPT_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [submitted]);

  /** Watches the submitted transaction until its disposition is known.
   *  Any receipt — success or revert — ends the hold; the card's own
   *  readiness reads then say what the chain now looks like. Bounded by
   *  `RECEIPT_GIVE_UP_MS` so a dropped transaction cannot latch the
   *  action shut, which is what the previous timestamp rule did. */
  const receiptWatch = useQuery({
    queryKey: ['forcedClose', 'receipt', submitted?.chainId, submitted?.hash],
    enabled: submitted !== null && Boolean(publicClient),
    refetchInterval: 4_000,
    retry: false,
    queryFn: async () => {
      try {
        return await publicClient!.getTransactionReceipt({
          hash: submitted!.hash,
        });
      } catch {
        // Not mined yet is the normal answer here, not an error.
        return null;
      }
    },
  });

  // A render-phase adjustment, matching how the page resets its own
  // chain-scoped state: no frame is committed carrying the previous
  // chain's or loan's stamp.
  if (
    submitted !== null &&
    (submitted.chainId !== walletChain?.chainId ||
      submitted.loanId !== String(loanId))
  ) {
    setSubmitted(null);
  }

  if (!shouldRenderForcedClose(readiness)) return null;

  /** ROUND 48 P1 — read timestamps are not evidence about a transaction.
   *
   *  The previous rule was `readsUpdatedAt <= submitted.at`, and it fails
   *  in BOTH directions once the stamp is laid down on the hash rather
   *  than the receipt:
   *
   *  - `readsUpdatedAt` is the MIN across the card's reads, and `consent`
   *    carries `staleTime: 10 * 60_000` with NO `refetchInterval`. On the
   *    receipt-timeout path `invalidateQueries` never runs (it sits after
   *    the await), so nothing refetches consent and the min stays below
   *    the stamp — the action is disabled indefinitely for a transaction
   *    that may simply have been dropped. That is the round-29 latch,
   *    reintroduced by fixing the round-47 one.
   *  - And if anything else does refetch those queries while the
   *    transaction is still pending, every timestamp passes the stamp and
   *    the hold releases with the transaction unresolved — which is the
   *    duplicate submit the round-47 fix existed to prevent.
   *
   *  So the hold now reconciles against the TRANSACTION. `submitted.hash`
   *  is watched with `getTransactionReceipt`; the moment a receipt exists
   *  the disposition is known and the hold ends, whatever the reads are
   *  doing. A dropped transaction is bounded rather than latched: after
   *  `RECEIPT_GIVE_UP_MS` with no receipt the hold releases and the
   *  lender may try again, which is the correct outcome for a
   *  transaction the network never accepted.
   *
   *  The read-freshness condition is kept as an ADDITIONAL hold on the
   *  success path only — once a receipt exists we still wait for one
   *  post-stamp read before re-offering a button, which is the round-28
   *  reason the hold was introduced. It can no longer hold on its own. */
  const receiptSettled =
    submitted !== null &&
    (receiptWatch.data != null || gaveUpOn === submitted.hash);
  const holdingAfterSubmit =
    submitted !== null &&
    (!receiptSettled || readsUpdatedAt <= submitted.at);
  const submittable = canSubmitFromApp(readiness) && !holdingAfterSubmit;

  async function closeOut() {
    // Belt and braces on a money path: no render path may reach a
    // second submit while the first is unreconciled. The `disabled`
    // props above are the UI half; this is the half that survives a
    // future caller wiring the confirmation differently.
    if (holdingAfterSubmit || busy) return;
    setError(null);
    setBusy(true);
    try {
      // The empty try-list is correct for both submittable states, and
      // for different reasons. `ready-in-kind` — NFT rentals, illiquid
      // collateral, >110% LTV collapses — is routed to in-kind
      // disposition without a swap adapter ever being consulted.
      // `ready-internal-match` never reaches the swap branch either:
      // `attemptInternalMatchAutoDispatch` runs first and returns.
      // Anywhere else this array reverts `NoEnabledSwapRoute`, which is
      // why the button does not exist there.
      // The sale interlock FIRST, because it is the one the chain will
      // not enforce for us: `triggerDefault` terminalizes the loan
      // regardless of an accepted sale awaiting completion, so the
      // simulation below would happily approve the very transaction
      // that strands the buyer's principal.
      const saleBlock = await preSubmitBlock();
      if (saleBlock) {
        setError(saleBlock);
        return;
      }
      // A LIVE re-check, immediately before sending (round 28 P2). The
      // readiness above is a 30-second poll that the open confirmation
      // can outlive by minutes, and several of the facts behind it move
      // on their own: collateral can be re-priced from illiquid to
      // liquid, a collapsed LTV can recover below the threshold,
      // governance can pause. Each of those turns this exact empty
      // try-list from correct into a guaranteed revert — the paid
      // refusal the whole card exists to prevent. Simulating asks the
      // chain the only question that matters ("would this call succeed
      // right now?") instead of re-deriving the answer from a second
      // copy of the contract's branch rules.
      //
      // It also, without special-casing any of them, covers the gates
      // this decision does not model: `whenNotPaused`, the lender KYC
      // check on an enforcement-enabled deployment, and a consent flag
      // read a moment too early.
      if (publicClient && address) {
        await publicClient.simulateContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'triggerDefault',
          args: [BigInt(loanId), []],
          account: address,
        });
      }
      // STAMP ON THE HASH, NOT ON THE RECEIPT (round 47 P1).
      //
      // `write` resolves only after the receipt wait, and that wait can
      // time out or lose its RPC on a transaction that mined perfectly
      // well — `useDiamondWrite` says so in its own `onSubmitted` doc,
      // which is the hook this call was not using. Stamping after the
      // await meant that on any such failure `submitted` stayed null,
      // `finally` cleared the busy flag, and the confirmation came back
      // live under the lender with the same button.
      //
      // A retry then re-simulates against a chain where the first
      // close-out may not have landed YET, so the simulation passes and
      // a second `triggerDefault` is queued. That second call either
      // burns a network fee reverting on a now-terminal loan, or — after
      // a PARTIAL first settlement — runs for real against the residual.
      // Neither is something to risk because a receipt wait timed out.
      //
      // So the stamp goes down the moment a hash exists. The hold it
      // starts is still released by evidence (`readsUpdatedAt` passing
      // it), so a transaction that genuinely failed to mine unblocks on
      // the next read rather than latching.
      await write('triggerDefault', [BigInt(loanId), []], {
        onSubmitted: (hash) =>
          setSubmitted({
            at: Date.now(),
            chainId: walletChain?.chainId,
            loanId: String(loanId),
            hash,
          }),
      });
      onClosedOut();
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['forcedClose'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Round 39 P2 — losing the match race does not always mean the
   *  close-out fails. `forcedCloseWithoutMatch` says which branch the
   *  contract reaches instead, and each one is a materially different
   *  outcome for the lender, so each gets named rather than folded into
   *  the commonest. `blocked-no-consent` groups with the failures on
   *  purpose: the in-kind branch reverts `LiquidationFailed` without
   *  both parties' consent, so nothing is recovered and only the fee is
   *  spent — the same thing that happens with no swap route. */
  const raceOutcome =
    matchFallback === 'ready-in-kind'
      ? copy.forcedClose.raceFallbackInKind
      : matchFallback === 'ready-rental'
        ? copy.forcedClose.raceFallbackRental
        : matchFallback === 'ready-needs-route' ||
            matchFallback === 'blocked-no-consent'
          ? copy.forcedClose.raceFallbackFails
          : copy.forcedClose.raceFallbackUnknown;

  /** ONE EXHAUSTIVE TABLE, because choosing the set by hand is the bug.
   *
   *  Six findings on this PR were the same shape: a string true of one
   *  route, rendered on a set of routes picked by hand — the rental
   *  described as a collateral transfer, the race promising failure, the
   *  race disclosed in one direction, then disclosed on two of the four
   *  states it applies to. Every one of those was a `readiness === 'a'
   *  || readiness === 'b'` written while looking at a and b.
   *
   *  A `Record<ForcedCloseReadiness, …>` cannot be written that way: the
   *  compiler refuses it until every state has an entry, so adding a
   *  state forces a decision about every column rather than inheriting
   *  whatever the last `else` happened to be. The previous `body` chain
   *  ended in a bare `: copy.forcedClose.readyInKind`, which means a new
   *  state would have silently described itself as an in-kind transfer.
   *
   *  `not-applicable` is listed even though `shouldRenderForcedClose`
   *  returns false for it — exhaustiveness is the point, and an entry
   *  that says "never rendered" is information.
   *
   *  DO NOT HOIST THIS OUT OF THE COMPONENT. Rebuilding an object of
   *  string lookups on every render looks like an obvious thing to
   *  memoize or lift to module scope, and lifting it would be a bug:
   *  `copy` is a Proxy whose `get` calls `i18n.t(...)` at ACCESS time
   *  (`i18n/reactiveCopy.ts`), and `LanguageRemount` re-keys the tree on
   *  language change so components re-read it. A module-scope table
   *  resolves every string once, at import, in whatever language i18n
   *  had loaded then — which is English before the real bundle
   *  arrives. Every non-English reader would get English on this card
   *  and nowhere else, with nothing failing.
   *
   *  The cost being avoided is ten property reads per render on a card
   *  that renders once per position view. That is not worth a silent
   *  localization regression. */
  const PRESENTATION: Record<
    ForcedCloseReadiness,
    {
      body: string;
      /** May the heading say the loan is overdue? Only states downstream
       *  of an affirmative `defaultable` may (round 28 P2). */
      overdue: boolean;
      /** Does the execution-time match check apply to this state's
       *  stated outcome? True wherever the copy names what the lender
       *  gets AND `attemptInternalMatchAutoDispatch` (line 287) runs
       *  before the branch that would produce it. */
      matchRace: boolean;
      /** Does this state render the action block — the not-exclusive
       *  note, the outcome and claim notes, and the submit affordance
       *  below them? The two note fields are non-null exactly here. */
      actionBlock: boolean;
      /** Null where `actionBlock` is false. */
      outcomeNote: string | null;
      claimNote: string | null;
      rentalReceipt: boolean;
    }
  > = {
    'ready-in-kind': {
      body: copy.forcedClose.readyInKind,
      overdue: true,
      matchRace: true,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNote,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: false,
    },
    'ready-needs-route': {
      body: copy.forcedClose.readyNeedsRoute,
      overdue: true,
      // No button here, but its whole message is that a sale must be
      // routed — which a match appearing makes wrong too.
      matchRace: true,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNote,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: false,
    },
    'ready-internal-match': {
      body: copy.forcedClose.readyInternalMatch,
      overdue: true,
      // This state IS the match. Its own race warning covers losing it,
      // rendered separately.
      matchRace: false,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNoteInternalMatch,
      claimNote: copy.forcedClose.claimNoteInternalMatch,
      rentalReceipt: false,
    },
    'ready-rental': {
      body: copy.forcedClose.readyRental,
      overdue: true,
      // `LibMetricsHooks` indexes every loan into
      // `assetPairActiveLoanIds` with no asset-type filter, so a rental
      // can be matched — and a match settles instead of ending it.
      matchRace: true,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNoteRental,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: true,
    },
    'blocked-no-consent': {
      body: copy.forcedClose.blockedNoConsent,
      overdue: true,
      // The sharpest one: this state claims the close-out is refused for
      // EVERYONE, and the match dispatch returns before the consent gate
      // is ever reached.
      matchRace: true,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'not-yet': {
      body: copy.forcedClose.notYet,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'blocked-sequencer': {
      body: copy.forcedClose.blockedSequencer,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'blocked-paused': {
      body: copy.forcedClose.blockedPaused,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    unknown: {
      body: copy.forcedClose.unknown,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    // Never rendered — `shouldRenderForcedClose` returns false.
    'not-applicable': {
      body: copy.forcedClose.unknown,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
  };
  const view = PRESENTATION[readiness];
  const receipt = view.rentalReceipt
    ? copy.forcedClose.rentalReceipt
    : copy.forcedClose.receipt;
  const outcomeNote = view.outcomeNote ?? copy.forcedClose.outcomeNote;
  const claimNote = view.claimNote ?? copy.forcedClose.claimNote;

  const body = holdingAfterSubmit ? copy.forcedClose.submitted : view.body;

  /** The overdue heading ONLY where the chain has actually said so
   *  (round 28 P2): `blocked-sequencer` and `blocked-paused` are
   *  resolved BEFORE `defaultable`, so during an outage a loan three
   *  days into a ninety-day term reaches them, and mapping those to
   *  "This loan is overdue" put a false statement in the card's largest
   *  text. Now a column of the table above rather than a hand-listed
   *  set. */
  const overdueEstablished = view.overdue;

  return (
    <section className="card" data-testid="forced-close-card">
      <div className="card-title">
        <AlertTriangle aria-hidden />
        <h3 style={{ margin: 0 }}>
          {overdueEstablished
            ? copy.forcedClose.title
            : copy.forcedClose.titlePending}
        </h3>
      </div>

      <p className="muted" data-testid="forced-close-body">
        {body}
      </p>

      {/* The match-race warning is its OWN paragraph, not appended to
          the body with a space.
       
          Round 39 built it as `${body} ${raceIntro} ${raceOutcome}`,
          which joins three complete sentences with an ASCII space in
          every language. Japanese and Chinese end a sentence with `。`
          and do not follow it with one, so that produced a stray gap
          mid-paragraph in two of the ten locales — the same class of
          bug `provenanceAge` in copy.ts already carries a warning about,
          where a wrapper added punctuation the translation had supplied.
          The lead-in is now folded into each fallback string at
          authoring time — with a space for the locales that use one
          between sentences and none for Japanese and Chinese — so
          nothing is composed at runtime and there is no join
          character to get wrong. That matches `consentParts`, where
          even the ' and ' and the final '.' are localized strings
          rather than literals in the JSX. */}
      {readiness === 'ready-internal-match' && !holdingAfterSubmit ? (
        <p className="muted" data-testid="forced-close-race">
          {raceOutcome}
        </p>
      ) : null}

      {/* The SAME race, seen from the other side (round 44 P2). This card
          disclosed only match -> something-else. `triggerDefault`
          re-checks for an opposing position at DefaultedFacet.sol:287,
          after this card's read AND after the pre-submit simulation, so
          something-else -> match is equally live: a loan that read as
          in-kind, or as needing a routed sale, can settle as a match and
          repay the lent asset instead of moving collateral.

          Shown on EVERY state whose copy names an outcome, which is all
          four non-terminal ones — and getting there took a second pass.
          The first version covered `ready-in-kind` and
          `ready-needs-route` only, which is the same half-a-symmetric-
          disclosure mistake the finding was about, one cycle later.

          `blocked-no-consent` is the sharpest of the four: it says the
          close-out is refused FOR EVERYONE. The dispatch at
          DefaultedFacet.sol:287 returns before the consent-gated in-kind
          branch is ever reached, and `hasInternalMatchCandidate` filters
          only on status and matchable collateral — not on consent, not
          on asset type — so a candidate appearing makes that absolute
          claim false. Its copy now says "as things stand" and this
          sentence supplies the exception.

          `ready-rental` qualifies for the same reason: `LibMetricsHooks`
          indexes every loan into `assetPairActiveLoanIds` with no
          asset-type filter, so a rental can be matched too, and the
          match settles instead of ending the rental. */}
      {view.matchRace && !holdingAfterSubmit ? (
        <p className="muted" data-testid="forced-close-match-may-appear">
          {copy.forcedClose.matchMayAppear}
        </p>
      ) : null}

      {/* Shown on every actionable state — a lender who cannot submit
          from here still needs to know a keeper may close it, so that
          finding the position already closed reads as normal rather than
          as loss.

          Its old comment said "both ready states" while the condition
          listed four, which is the same rot in miniature: the set grew
          and the sentence describing it did not. It is a table column
          now, so there is no set to describe. */}
      {!holdingAfterSubmit && view.actionBlock ? (
        <>
          <p className="field-hint">{copy.forcedClose.notExclusive}</p>
          <p className="field-hint">{outcomeNote}</p>
          <p className="field-hint">{claimNote}</p>
        </>
      ) : null}

      {submittable ? (
        <>
          {/* Shown only where a swap-to-repay intent could exist.
              `SwapToRepayIntentFacet` reverts `UnsupportedLoanShape`
              unless both legs are ERC-20 and both are Liquid, so a
              rental, NFT collateral, or an illiquid asset on either leg
              can never carry one.

              Round 40 exempted rentals alone, which left the note on an
              ERC-20 loan secured by NFT or illiquid collateral, where it
              is equally unreachable. I recorded that as a residual and
              judged the extra prop not worth it; round 41 disagreed, and
              was right — the whole point of the rule in the functional
              spec is that unreachable conditions appear only where they
              are reachable, and a partial application of it is just the
              same bug with a smaller blast radius.

              ASYMMETRIC ON PURPOSE: suppressed only on a POSITIVE `false`.
              An unread shape (`undefined`) still shows the note, because
              the two errors are not equal — displaying a conditional
              that never fires costs a sentence, while hiding a live one
              means a lender cancels the borrower's pending order without
              being told. */}
          {swapToRepayPossible !== false ? (
            <p className="field-hint">{copy.forcedClose.intentNote}</p>
          ) : null}
          {error ? (
            <div
              className="banner banner-danger"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              {error}
            </div>
          ) : null}
          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenConfirm}
              disabled={busy || !ready}
              data-testid="forced-close-submit"
            >
              {copy.forcedClose.submit}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                // ROUND 47 P1, SECOND HALF — found reviewing my own fix.
                // Stamping in `onSubmitted` gates `submittable`, which
                // gates the OUTER button — but that button is not
                // rendered while the confirmation is open, and after a
                // failed receipt wait the confirmation IS still open
                // (`onCloseConfirm` runs only on success). Its confirm
                // button is `disabled={busy || disabled}`, and this card
                // was passing only `busy` — which `finally` has just
                // cleared. So the exact retry the P1 describes stayed
                // one click away, through the panel rather than the
                // button.
                disabled={holdingAfterSubmit}
                confirmLabel={copy.forcedClose.submit}
                onBack={onCloseConfirm}
                onConfirm={closeOut}
                data={{
                  youReceive: receipt.youReceive,
                  youLock: receipt.youLock,
                  youMayOwe: receipt.youMayOwe,
                  youCanLose: receipt.youCanLose,
                  fees: receipt.fees,
                  whenThisEnds: receipt.whenThisEnds,
                }}
              />
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
