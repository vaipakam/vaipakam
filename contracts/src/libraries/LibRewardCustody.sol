// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title LibRewardCustody — the ONE seam between the reward ledgers and the
 *        delivered reward custody holder (#1566 slice 4 PR B, design §5d)
 *
 * PR A bound a `RewardCustodyHolder` per deployment and installed the
 * attribution rows ({LibVaipakam.RewardCustodyRow}) with no writer. PR B is
 * the cutover: on an ACTIVATED deployment every reward read and debit goes
 * through the holder's rows instead of the Diamond's own VPFI balance. Every
 * such read, credit, debit and token move lives here, so that:
 *
 *  - the two ledger invariants are preserved by construction rather than by
 *    each call site remembering them — the sum of the rows never exceeds the
 *    holder's balance (every credit is preceded by a measured token arrival
 *    or an in-holder re-attribution; every debit precedes a measured
 *    release), and no row goes negative (a debit beyond a row's balance
 *    reverts with the row named);
 *  - a facet that is not this library's caller cannot reach the holder at
 *    all (its `release` answers only to the Diamond, and the Diamond's
 *    facets reach it only through {releaseMeasured} here);
 *  - the ROLE branch the design requires has exactly one implementation:
 *    {active} — a deployment reads the holder once the per-chain activation
 *    ceremony has run, and an `Unconfigured` deployment (no delivered ledger
 *    to bind to) can never activate, which is what keeps its column frozen
 *    at today's Diamond-custody behaviour (design §5c matrix, column 4).
 *
 * Why an activation FLAG rather than switching on the role at deploy: the
 * design's migration ceremony reconciles the recovery, overage and recycled
 * positions INTO the holder before any read consults it ("switch custody
 * reads to the holder … then unpause"), and PR A's plan put the funding
 * writer "behind the same activation". A code-level switch at the facet cut
 * would have every active-role gate read empty rows between the refresh and
 * the ceremony; the flag makes that window a defined state — today's
 * behaviour, fail-closed on the delivered bound — instead of an implicit
 * one, and gives a fresh deployment the same ceremony as a live one.
 *
 * Nothing here is `external`: the library inlines into each calling facet,
 * so EIP-170 is paid per facet and there is still one source of truth.
 */
library LibRewardCustody {
    using SafeERC20 for IERC20;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice An attribution row was credited.
    /// @param row    The {LibVaipakam.RewardCustodyRow} ordinal.
    /// @param amount What was credited.
    /// @param origin 0 = a measured arrival at the holder (relocation from
    ///               the Diamond or a caller's transfer); 1 = an in-holder
    ///               re-attribution from another row (that row's debit is
    ///               emitted alongside).
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyRowCredited(uint8 indexed row, uint256 amount, uint8 origin);

    /// @notice An attribution row was debited.
    /// @param row    The {LibVaipakam.RewardCustodyRow} ordinal.
    /// @param amount What was debited.
    /// @param to     Where the tokens went — a payout destination, the
    ///               Diamond (for a transport the messenger pulls from the
    ///               Diamond), or the zero address for an in-holder
    ///               re-attribution.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyRowDebited(uint8 indexed row, uint256 amount, address to);

    /// @notice Fresh funding was credited to the delivered ledger's received
    ///         side, and its custody attributed under the §5c deficit split.
    /// @param amount        The fresh amount that arrived at the holder.
    /// @param toLive        The part allocated to the live-fresh row — the
    ///                      part that becomes headroom.
    /// @param toRestitution The deficit-covering part, allocated to the
    ///                      restitution row: it closes a `paid > received`
    ///                      deficit and creates no headroom, so it is never
    ///                      live backing (design §5c).
    /// @param receivedAfter The received counter after the credit.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyFreshCredited(
        uint256 amount,
        uint256 toLive,
        uint256 toRestitution,
        uint256 receivedAfter
    );

    // ─── Types ──────────────────────────────────────────────────────────────

    /// @notice The custody a transport draws on (design §5d, "transports: an
    ///         authenticated custody SOURCE through the shared tail").
    /// @dev    `Live` pulls the fresh share from the live-fresh row and the
    ///         recycled share from the recycled row, and is bounded and
    ///         charged against the delivered ledger by the caller; `Recovery`
    ///         pulls the whole amount from the recovery row and is exempt
    ///         from the delivered charge (its original outflow was charged).
    ///         Replaces the `bool fromRecovery` the compensation dispatchers
    ///         carried: the tail now debits a NAMED row, so no dispatch path
    ///         can send tokens without naming the custody they leave.
    enum TransportSource {
        Live,
        Recovery
    }

    /// @notice What a transport draws, packed for the viaIR stack: the
    ///         source and the two components of the amount that will be
    ///         approved to the messenger.
    struct TransportDraw {
        TransportSource source;
        uint256 fresh;
        uint256 recycled;
    }

    // ─── Predicates and reads ───────────────────────────────────────────────

    /// @notice Whether this deployment's reward custody reads and debits the
    ///         holder. THE role branch of design §5d, in one place: true only
    ///         after {RewardCustodyFacet.activateRewardCustody} ran, which an
    ///         `Unconfigured` deployment can never do.
    function active(LibVaipakam.Storage storage s) internal view returns (bool) {
        return s.rewardCustodyActivated;
    }

    // ─── The complete-cut record (Codex #2186 r4) ────────────────────────────

    /// @notice The custody protocol version every reward consumer in this
    ///         tree implements. Bump it whenever the set of facets that read
    ///         or debit the holder changes shape (a new consumer, a changed
    ///         seam), so an activation can never run against a complete cut
    ///         that predates the consumers it needs.
    /// @dev #1566 transport epochs PR 3b (Codex #2232 r2) — advanced 1 → 2.
    ///      This PR adds a holder consumer ({RewardEpochFacet}) and changes a
    ///      seam: classification now passes the transport-epoch gate and debits
    ///      the batch's parked remainder. Left at 1, a partial cut carrying
    ///      this ingress but a version-1 reconciliation facet could be stamped
    ///      complete and activation would accept it — a delivery would open an
    ///      epoch while the stale classifier had neither the gate nor the
    ///      debit, so two records would claim one sum. The bump is what makes
    ///      that cut refuse to certify.
    uint32 internal constant CUTOVER_VERSION = 2;

    /// @notice A complete facet cut recorded the custody protocol version and
    ///         the routing it installed.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyCutoverStamped(uint32 version, bytes32 routing, uint256 facetCount, uint256 selectorCount);

    /// @notice The Diamond's ROUTING as one hash: every facet address the
    ///         Diamond routes to, with every selector it serves — facets
    ///         sorted by address and each facet's selectors sorted, so the
    ///         order the loupe happens to hold either in cannot matter. Any
    ///         change to which selector reaches which bytecode changes it: a
    ///         Replace onto new bytecode, an Add, AND a Remove of one selector
    ///         from a facet that keeps others (Codex #2186 r5 P1 — an
    ///         address-only hash was blind to exactly that, and a required
    ///         claim, sweep or transport seam removed by a partial cut would
    ///         have left a funded holder unreachable until another cut).
    ///         Read straight from `LibDiamond` storage, the routing table
    ///         itself, so no facet cut through the constructor-installed cut
    ///         facet can escape it. Costs one SLOAD per routed selector; the
    ///         calls that pay it are the once-per-chain ceremony's.
    function routing() internal view returns (bytes32 hash, uint256 facetCount, uint256 selectorCount) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address[] storage addrs = ds.facetAddresses;
        facetCount = addrs.length;
        address[] memory facets = new address[](facetCount);
        for (uint256 i = 0; i < facetCount; ++i) {
            address a = addrs[i];
            uint256 j = i;
            while (j > 0 && facets[j - 1] > a) {
                facets[j] = facets[j - 1];
                --j;
            }
            facets[j] = a;
        }
        bytes32 acc;
        for (uint256 i = 0; i < facetCount; ++i) {
            bytes4[] storage stored = ds.facetFunctionSelectors[facets[i]].functionSelectors;
            uint256 n = stored.length;
            bytes4[] memory sels = new bytes4[](n);
            for (uint256 k = 0; k < n; ++k) {
                bytes4 x = stored[k];
                uint256 j = k;
                while (j > 0 && sels[j - 1] > x) {
                    sels[j] = sels[j - 1];
                    --j;
                }
                sels[j] = x;
            }
            selectorCount += n;
            acc = keccak256(abi.encodePacked(acc, facets[i], sels));
        }
        hash = acc;
    }

    /// @notice Refuse unless the complete-cut record is CURRENT — the stamped
    ///         version is this tree's and the stamped routing is the routing
    ///         now. The gate on activation and on every bootstrap write. Why
    ///         a record and not the ledger alone (Codex #2186 r4 P1): the
    ///         ledger figures say nothing about WHICH facets are routed, and
    ///         a custody facet cut without the claim, sweep, remittance,
    ///         compensation and recycle facets that read the holder would
    ///         activate custody those stale consumers never debit, spending
    ///         the Diamond's own balance beside a funded holder. The record
    ///         is written only by the two complete-cut paths after their last
    ///         cut, and any cut after it — of a facet or of a single
    ///         selector — invalidates it until the complete refresh runs
    ///         again.
    function requireCutover(LibVaipakam.Storage storage s) internal view {
        (bytes32 current, , ) = routing();
        if (s.rewardCustodyCutoverVersion != CUTOVER_VERSION || s.rewardCustodyCutoverRouting != current) {
            revert IVaipakamErrors.RewardCustodyActivationRequiresCutover(
                s.rewardCustodyCutoverVersion, CUTOVER_VERSION, s.rewardCustodyCutoverRouting, current
            );
        }
    }

    /// @notice Record the complete cut: this tree's custody protocol version
    ///         and the routing now.
    function stampCutover(LibVaipakam.Storage storage s) internal returns (bytes32 hash) {
        (bytes32 current, uint256 facetCount, uint256 selectorCount) = routing();
        s.rewardCustodyCutoverVersion = CUTOVER_VERSION;
        s.rewardCustodyCutoverRouting = current;
        emit RewardCustodyCutoverStamped(CUTOVER_VERSION, current, facetCount, selectorCount);
        hash = current;
    }

    /// @notice One attribution row.
    function row(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r
    ) internal view returns (uint256) {
        return s.rewardCustodyRows[r];
    }

    /// @notice Sum of every {LibVaipakam.RewardCustodyRow}. Iterates the enum
    ///         by ordinal up to its LAST member, so a row appended later is
    ///         picked up by moving one constant — and that constant lives
    ///         here only, since the unattributed-remainder sweep's bound
    ///         (`held - attributed`) would silently widen over attributed
    ///         custody if a copy of it went stale.
    function attributedTotal(
        LibVaipakam.Storage storage s
    ) internal view returns (uint256 total) {
        uint256 last = uint256(LibVaipakam.RewardCustodyRow.Restitution);
        for (uint256 i = 0; i <= last; ++i) {
            total += s.rewardCustodyRows[LibVaipakam.RewardCustodyRow(i)];
        }
    }

    /// @notice The bound holder and the configured token, or a named refusal
    ///         for whichever is missing — every custody move needs both.
    function boundHolderAndToken(
        LibVaipakam.Storage storage s
    ) internal view returns (address holder, address token) {
        token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.RewardCustodyTokenUnset();
        holder = s.rewardCustodyHolder;
        if (holder == address(0)) revert IVaipakamErrors.RewardCustodyHolderNotBound();
    }

    /// @notice A balance read that cannot revert a snapshot: unbound holder,
    ///         unset or codeless token, a failed call, or a malformed answer
    ///         all report `known == false` — the reader is told the balance
    ///         could not be read, never handed a zero that means "empty".
    function tryBalance(
        address token,
        address holder
    ) internal view returns (bool known, uint256 held) {
        if (holder == address(0) || token == address(0) || token.code.length == 0) {
            return (false, 0);
        }
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IERC20.balanceOf, (holder)));
        if (!ok || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @dev Only the sweeps take a holder address at all (to reach a PREVIOUS
    ///      holder after a replacement); binding and replacement construct
    ///      their own and REGISTER what they constructed. The sweeps consult
    ///      that registry — never a getter an arbitrary contract could
    ///      imitate (Codex #2158 r13 P2) — so `release` is only ever called
    ///      on a contract this Diamond created.
    function requireConstructedHere(
        LibVaipakam.Storage storage s,
        address holder
    ) internal view {
        if (!s.rewardCustodyHolderConstructed[holder]) {
            revert IVaipakamErrors.RewardCustodyHolderNotConstructedHere(holder);
        }
    }

    // ─── Row writers ────────────────────────────────────────────────────────

    /// @notice Credit a row. Callers credit ONLY after a measured token
    ///         arrival at the holder ({relocateToHolder}, {fundFromCaller})
    ///         or an in-holder re-attribution ({move}); nothing else may, or
    ///         the rows would describe custody the holder does not hold.
    /// @dev    Arms the role freeze (design §5d, "role and SOURCE changes
    ///         freeze here"): once any holder allocation exists, a role
    ///         transition could orphan it — the retained residual retirement
    ///         can level counters but cannot re-key a row — so the setters
    ///         refuse every effective role change until PR C's era registry
    ///         can carry an allocation across one. Armed here rather than only
    ///         at activation so the bootstrap writers, which credit rows
    ///         before activation, are covered by the same rule.
    function credit(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 amount,
        uint8 origin
    ) internal {
        if (amount == 0) return;
        s.rewardCustodyRows[r] += amount;
        if (!s.rewardRoleChangesFrozen) s.rewardRoleChangesFrozen = true;
        emit RewardCustodyRowCredited(uint8(r), amount, origin);
    }

    /// @notice Debit a row, refusing with the row named when it cannot cover
    ///         the amount — the "no row goes negative" invariant, enforced
    ///         rather than floored: a payout or transport that a row cannot
    ///         back is refused whole, never paid from another row's custody.
    /// @param  to Where the tokens go, for the event; zero for an in-holder
    ///            re-attribution.
    function debit(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 amount,
        address to
    ) internal {
        if (amount == 0) return;
        uint256 have = _debitRow(s, r, amount);
        // A release leaves the holder: a payout, a transport, a return, a
        // disposition — every one of them a spend of what it takes from the
        // classified queue, and a payout of it where the fresh ledger is
        // concerned (the deficit a treasury release pays was `paid` already).
        _recordOutflow(s, r, have, amount, true, false);
        emit RewardCustodyRowDebited(uint8(r), amount, to);
    }

    /// @notice An in-holder re-attribution: `from` → `to`, moving no tokens.
    ///         The absorption of fresh reward value into the recycled row,
    ///         and the claw of a contradicted recovery credit into overage,
    ///         are this — the tokens stay exactly where they are.
    function move(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow from,
        LibVaipakam.RewardCustodyRow to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        uint256 have = _debitRow(s, from, amount);
        // An in-holder move out of the live row is a payout of the fresh
        // ledger's (the absorption of forfeited reward value charges `paid`)
        // — except the demotion's re-attribution into `Unclassified`, the
        // one path that unwinds `received` instead: spent, never paid. Out
        // of restitution INTO the live row it is the paid-correction: the
        // released records re-enter the queue backed by that very inflow.
        _recordOutflow(
            s, from, have, amount, to != LibVaipakam.RewardCustodyRow.Unclassified, to == LibVaipakam.RewardCustodyRow.LiveFresh
        );
        emit RewardCustodyRowDebited(uint8(from), amount, address(0));
        credit(s, to, amount, 1);
    }

    function _debitRow(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 amount
    ) private returns (uint256 have) {
        have = s.rewardCustodyRows[r];
        if (amount > have) revert IVaipakamErrors.RewardCustodyRowShort(uint8(r), amount, have);
        s.rewardCustodyRows[r] = have - amount;
    }

    /// @dev #1566 closure 2 cutover PR 2 (Codex #2206 r4–r6) — the legacy
    ///      reconciliation epoch's SPENT-NESS, recorded here at the one row
    ///      primitive every outflow of the live and restitution rows passes
    ///      through, so no writer of a pool has to know about the queue and
    ///      no balance is ever read for it afterwards. A queue is one RECORD
    ///      per entry at the entry's own log index, with a FRONTIER: what an
    ///      outflow takes of the queue — what the row's other backing could
    ///      not cover, never more than the records still hold — is written
    ///      INTO the records at the frontier, earliest first, with its kind,
    ///      by a walk BOUNDED to `QUEUE_WALK_STEPS` entries; the rest is left
    ///      as a pending take, in order, for later walks (Codex #2206 r6: an
    ///      unbounded skip over exhausted entries could wedge a payout), so
    ///      an entry's spent-ness and what of it the other side may inherit
    ///      are read from its own record, never inferred. The live row's
    ///      outflows spend the fresh queue (paid where the fresh ledger
    ///      charges them; the demotion's unwind into `Unclassified` is spent,
    ///      never paid). The restitution row's outflows RELEASE the absorbed
    ///      records, each released part re-entering the entry's own fresh
    ///      record — free when the paid-correction moved the custody to
    ///      live, spent (and paid) when the deficit was paid with it, spent
    ///      (unpaid) when a demotion re-attributed it. The recycled queue's
    ///      pool is the BUCKET LEDGER, whose row follows it: the ledger's two
    ///      debit primitives record through {takeRecycled}. The walks live in
    ///      the reconciliation facet (these primitives are inlined into
    ///      facets at the EIP-170 budget); the O(1) guard keeps the common
    ///      case — nothing classified — free of the self-call. The correction
    ///      adjusts the queues BEFORE it moves tokens, so its own move records
    ///      nothing. Era 0 until slice 4 PR C's rows.
    function _recordOutflow(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 have,
        uint256 amount,
        bool paid,
        bool toLive
    ) private {
        if (r == LibVaipakam.RewardCustodyRow.LiveFresh) {
            if (s.freshUnspentByEra[PRE_BACKFILL_ERA] == 0) return;
            _custody(abi.encodeWithSignature("reconciliationTakeFresh(uint256,uint256,bool)", have, amount, paid));
        } else if (r == LibVaipakam.RewardCustodyRow.Restitution) {
            if (s.absorbedUnreleased == 0) return;
            _custody(
                abi.encodeWithSignature(
                    "reconciliationReleaseAbsorbed(uint256,uint256,bool,bool)", have, amount, toLive, paid
                )
            );
        }
    }

    /// @dev The bound on a hot outflow's walk, in entries visited (exhausted
    ///      entries skipped count too). Operator paths complete their walk.
    uint256 internal constant QUEUE_WALK_STEPS = 32;
    uint8 internal constant SIDE_FRESH = 0;
    uint8 internal constant SIDE_RECYCLED = 1;
    /// @dev Pending-take kind bits.
    uint8 internal constant KIND_CHARGED = 1;
    uint8 internal constant KIND_RELEASE = 2;
    uint8 internal constant KIND_TO_LIVE = 4;

    /// @notice What an outflow of `amount` from a pool holding `balance`
    ///         takes of a queue whose records still hold `unspent`: the
    ///         pool's other backing (`balance − unspent`) goes first, and
    ///         never more than the records still hold.
    function takeOfQueue(uint256 unspent, uint256 balance, uint256 amount) internal pure returns (uint256 took) {
        uint256 other = balance > unspent ? balance - unspent : 0;
        took = amount > other ? amount - other : 0;
        if (took > unspent) took = unspent;
    }

    /// @notice The fresh queue's record of a live-row outflow of `amount`
    ///         from a row holding `have` (hot: the walk is bounded).
    function takeFresh(LibVaipakam.Storage storage s, uint64 era, uint256 have, uint256 amount, bool paid) internal {
        uint256 unspent = s.freshUnspentByEra[era];
        uint256 took = takeOfQueue(unspent, have, amount);
        if (took == 0) return;
        s.freshUnspentByEra[era] = unspent - took;
        s.freshSpentTotalByEra[era] += took;
        if (paid) s.freshPaidTotalByEra[era] += took;
        s.freshPendingByEra[era].push(LibVaipakam.PendingTake({amount: uint128(took), kind: paid ? KIND_CHARGED : 0}));
        s.freshPendingAmountByEra[era] += took;
        advanceFresh(s, era, QUEUE_WALK_STEPS);
    }

    /// @notice The restitution row's outflow RELEASES the absorbed records
    ///         (the row's other backing released first, never more than the
    ///         records still hold); the released part re-enters the fresh
    ///         queue's totals at once and its entries' fresh records by the
    ///         walk, in time order with the fresh takes.
    function releaseAbsorbed(
        LibVaipakam.Storage storage s,
        uint256 have,
        uint256 amount,
        bool toLive,
        bool paid
    ) internal {
        uint256 unreleased = s.absorbedUnreleased;
        uint256 take = takeOfQueue(unreleased, have, amount);
        if (take == 0) return;
        s.absorbedUnreleased = unreleased - take;
        s.absorbedReleasedTotal += take;
        uint64 era = PRE_BACKFILL_ERA;
        if (toLive) {
            s.freshUnspentByEra[era] += take;
        } else {
            s.freshSpentTotalByEra[era] += take;
            if (paid) s.freshPaidTotalByEra[era] += take;
        }
        uint8 kind = KIND_RELEASE | (toLive ? KIND_TO_LIVE : 0) | (paid ? KIND_CHARGED : 0);
        s.freshPendingByEra[era].push(LibVaipakam.PendingTake({amount: uint128(take), kind: kind}));
        s.freshPendingAmountByEra[era] += take;
        advanceFresh(s, era, QUEUE_WALK_STEPS);
    }

    /// @notice Write the fresh queue's pending takes into the records, in
    ///         order, visiting at most `steps` entries: a take spends the
    ///         records from the fresh frontier (charged too where the outflow
    ///         was a payout); a release releases the absorbed records from
    ///         the absorbed frontier, each released part re-entering the
    ///         entry's own fresh record (free, moving the fresh frontier back
    ///         to it, or spent). Running off the log is a defect (the totals
    ///         and the records disagree) and refuses.
    function advanceFresh(LibVaipakam.Storage storage s, uint64 era, uint256 steps) internal {
        LibVaipakam.PendingTake[] storage pend = s.freshPendingByEra[era];
        uint256 head = s.freshPendingHeadByEra[era];
        uint256 n = s.reconciliationLog.length;
        while (head < pend.length && steps != 0) {
            LibVaipakam.PendingTake storage item = pend[head];
            uint256 take = item.amount;
            uint256 before = take;
            if (item.kind & KIND_RELEASE != 0) {
                (take, steps) = _walkRelease(s, era, take, item.kind, steps, n);
            } else {
                (take, steps) = _walkFresh(s, era, take, item.kind & KIND_CHARGED != 0, steps, n);
            }
            item.amount = uint128(take);
            s.freshPendingAmountByEra[era] -= before - take;
            if (take == 0) ++head;
        }
        s.freshPendingHeadByEra[era] = head;
    }

    function _walkFresh(
        LibVaipakam.Storage storage s,
        uint64 era,
        uint256 take,
        bool charged,
        uint256 steps,
        uint256 n
    ) private returns (uint256, uint256) {
        uint256 f = s.freshFrontierByEra[era];
        while (take != 0 && steps != 0) {
            if (f >= n) revert IVaipakamErrors.ReconciliationQueueInconsistent(SIDE_FRESH);
            LibVaipakam.SideRecord storage rec = s.freshRecords[f];
            uint256 free = rec.amount - rec.spent;
            --steps;
            if (free == 0) {
                ++f;
                continue;
            }
            uint256 u = take < free ? take : free;
            rec.spent += uint128(u);
            if (charged) rec.charged += uint128(u);
            take -= u;
        }
        s.freshFrontierByEra[era] = f;
        return (take, steps);
    }

    function _walkRelease(
        LibVaipakam.Storage storage s,
        uint64 era,
        uint256 take,
        uint8 kind,
        uint256 steps,
        uint256 n
    ) private returns (uint256, uint256) {
        uint256 f = s.absorbedFrontier;
        while (take != 0 && steps != 0) {
            if (f >= n) revert IVaipakamErrors.ReconciliationQueueInconsistent(SIDE_FRESH);
            LibVaipakam.AbsorbedRecord storage rec = s.absorbedRecords[f];
            uint256 free = rec.amount - rec.released;
            --steps;
            if (free == 0) {
                ++f;
                continue;
            }
            uint256 u = take < free ? take : free;
            rec.released += uint128(u);
            LibVaipakam.SideRecord storage fr = s.freshRecords[f];
            fr.amount += uint128(u);
            if (kind & KIND_TO_LIVE != 0) {
                if (f < s.freshFrontierByEra[era]) s.freshFrontierByEra[era] = f;
            } else {
                fr.spent += uint128(u);
                if (kind & KIND_CHARGED != 0) fr.charged += uint128(u);
            }
            take -= u;
        }
        s.absorbedFrontier = f;
        return (take, steps);
    }

    /// @notice The recycled queue's record of a bucket-ledger debit of
    ///         `amount` from a ledger holding `bucketBefore`: what it took.
    ///         An operator path (`mustComplete`) first writes down whatever
    ///         backlog stands, then its own take, whole; a remit
    ///         (`remitId != 0`) has EXACTLY the records its own take wrote,
    ///         and by how much, recorded on its reservation (Codex #2206 r7:
    ///         a range could span a backlog drained ahead of it, or an
    ///         exhausted record another take had charged). A hot path walks
    ///         a bounded number of entries and leaves the rest pending.
    function takeRecycled(
        LibVaipakam.Storage storage s,
        uint256 bucketBefore,
        uint256 amount,
        bool consumption,
        bool mustComplete,
        uint256 remitId
    ) internal returns (uint256 took) {
        uint256 unspent = s.recycledUnspent;
        took = takeOfQueue(unspent, bucketBefore, amount);
        if (took == 0) return 0;
        s.recycledUnspent = unspent - took;
        s.recycledSpentTotal += took;
        if (consumption) s.recycledConsumedTotal += took;
        if (mustComplete) advanceRecycled(s, type(uint256).max, 0);
        s.recycledPending.push(LibVaipakam.PendingTake({amount: uint128(took), kind: consumption ? KIND_CHARGED : 0}));
        s.recycledPendingAmount += took;
        if (mustComplete) {
            advanceRecycled(s, type(uint256).max, remitId);
            if (remitId != 0) s.remitReservations[remitId].classifiedTake = took;
        } else {
            advanceRecycled(s, QUEUE_WALK_STEPS, 0);
        }
    }

    /// @notice Write the recycled queue's pending takes into the records, in
    ///         order, visiting at most `steps` entries; with `remitId` set,
    ///         every record written is noted on that remit's reservation
    ///         (the caller has drained everything older first).
    function advanceRecycled(LibVaipakam.Storage storage s, uint256 steps, uint256 remitId) internal {
        LibVaipakam.PendingTake[] storage pend = s.recycledPending;
        uint256 head = s.recycledPendingHead;
        uint256 n = s.reconciliationLog.length;
        uint256 f = s.recycledFrontier;
        while (head < pend.length && steps != 0) {
            LibVaipakam.PendingTake storage item = pend[head];
            uint256 take = item.amount;
            bool charged = item.kind & KIND_CHARGED != 0;
            while (take != 0 && steps != 0) {
                if (f >= n) revert IVaipakamErrors.ReconciliationQueueInconsistent(SIDE_RECYCLED);
                LibVaipakam.SideRecord storage rec = s.recycledRecords[f];
                uint256 free = rec.amount - rec.spent;
                --steps;
                if (free == 0) {
                    ++f;
                    continue;
                }
                uint256 u = take < free ? take : free;
                rec.spent += uint128(u);
                if (charged) rec.charged += uint128(u);
                if (remitId != 0) s.remitReservations[remitId].classifiedTakes.push((f << 128) | u);
                take -= u;
                s.recycledPendingAmount -= u;
            }
            item.amount = uint128(take);
            if (take == 0) ++head;
        }
        s.recycledFrontier = f;
        s.recycledPendingHead = head;
    }

    /// @notice Whether a side's backlog is drained (a correction requires it).
    function queueSettled(LibVaipakam.Storage storage s, uint8 side, uint64 era) internal view returns (bool) {
        if (side == SIDE_FRESH) return s.freshPendingHeadByEra[era] == s.freshPendingByEra[era].length;
        return s.recycledPendingHead == s.recycledPending.length;
    }

    // ─── Measured token moves ───────────────────────────────────────────────

    /**
     * @notice The ONE measured move of the configured VPFI out of a holder
     *         this Diamond constructed. Both ends are verified: the
     *         destination grew by exactly `amount` AND the source was
     *         debited by exactly `amount` (Codex #2158 r12 P2, r15 P2). A
     *         move either end cannot account for — a fee-on-transfer token,
     *         a token that credits without debiting — reverts the whole
     *         operation rather than leaving the ledger describing custody
     *         that is not there, VPFI stranded at an address nothing can
     *         reach, or an operation that can be repeated against a balance
     *         that never moves.
     * @param  token  The configured VPFI token.
     * @param  from   The holder released from (constructed here).
     * @param  to     The destination.
     * @param  amount What to move; zero moves nothing and verifies nothing
     *                moved.
     * @return toBefore The destination's balance before the move — what was
     *         already there, which a replacement reports as unattributed
     *         rather than refusing (Codex #2158 r3 P1).
     */
    function releaseMeasured(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal returns (uint256 toBefore) {
        uint256 fromBefore = IERC20(token).balanceOf(from);
        toBefore = IERC20(token).balanceOf(to);
        if (amount != 0) {
            RewardCustodyHolder(from).release(token, to, amount);
        }
        uint256 credited = IERC20(token).balanceOf(to) - toBefore;
        if (credited != amount) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(amount, credited);
        }
        requireDebited(from, fromBefore, IERC20(token).balanceOf(from), amount);
    }

    /// @notice Debit `r` by `amount` and release exactly that much from the
    ///         bound holder to `to`, measured at both ends. The payout and
    ///         transport primitives are this call.
    function releaseFromRow(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        (address holder, address token) = boundHolderAndToken(s);
        debit(s, r, amount, to);
        releaseMeasured(token, holder, to, amount);
    }

    /// @notice Move `amount` of the Diamond's OWN VPFI balance into the bound
    ///         holder and credit `r` — the relocation of value that arrived
    ///         at the Diamond (a cross-chain delivery the receiver forwarded
    ///         here, a fee a user paid into the Diamond, a historical
    ///         position the migration ceremony relocates). Measured at both
    ///         ends, exactly as a release is: the holder grew by `amount`
    ///         and the Diamond was debited by `amount`.
    /// @dev    A relocation is only ever of value the ledger has just
    ///         authenticated (a delta-checked ingress or a bootstrap figure);
    ///         it is never a way to seed the holder from ambient custody,
    ///         which is why the bootstrap relocation is bounded by the ledger
    ///         figure and refuses the live-fresh row outright (design §5c,
    ///         "history, not money").
    function relocateToHolder(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        relocateToHolderUncredited(s, amount);
        credit(s, r, amount, 0);
    }

    /// @notice Relocate a FRESH arrival (a mirror's counted remittance share
    ///         or compensation credit) from the Diamond into the holder and
    ///         credit the received side under the deficit split — the
    ///         ingress form of {creditFreshIngress}.
    function relocateFreshIngress(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal returns (uint256 toLive, uint256 toRestitution) {
        if (amount == 0) return (0, 0);
        relocateToHolderUncredited(s, amount);
        return creditFreshIngress(s, amount);
    }

    /// @dev The measured move half of {relocateToHolder}: the holder grew
    ///      by exactly `amount` and the Diamond was debited by exactly
    ///      `amount`. Every caller MUST credit what it moved in the same
    ///      transaction ({credit} or {creditFreshIngress}).
    function relocateToHolderUncredited(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal {
        (address holder, address token) = boundHolderAndToken(s);
        uint256 diamondBefore = IERC20(token).balanceOf(address(this));
        uint256 holderBefore = IERC20(token).balanceOf(holder);
        IERC20(token).safeTransfer(holder, amount);
        uint256 credited = IERC20(token).balanceOf(holder) - holderBefore;
        if (credited != amount) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(amount, credited);
        }
        requireDebited(address(this), diamondBefore, IERC20(token).balanceOf(address(this)), amount);
    }

    /// @notice Pull `amount` from `funder` straight into the bound holder
    ///         and credit `r` — the registered funding writer's transfer,
    ///         and the custody-only replacement funding of a bootstrap
    ///         figure. Delta-checked against the HOLDER's balance (design
    ///         §5b: "reverting unless the transfer delivers exactly `amount`
    ///         to the holder"), never against the Diamond's, which the
    ///         funding never touches.
    function fundFromCaller(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        address funder,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        pullFromCaller(s, funder, amount);
        credit(s, r, amount, 0);
    }

    /// @notice The measured transfer half of {fundFromCaller}, for a writer
    ///         whose row credit is decided AFTER the arrival — the registered
    ///         funding writer credits under the deficit split
    ///         ({creditFreshIngress}), not to a fixed row. Every caller MUST
    ///         credit what it pulled in the same transaction, or the holder
    ///         would hold value no row describes.
    function pullFromCaller(
        LibVaipakam.Storage storage s,
        address funder,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        (address holder, address token) = boundHolderAndToken(s);
        uint256 holderBefore = IERC20(token).balanceOf(holder);
        IERC20(token).safeTransferFrom(funder, holder, amount);
        uint256 credited = IERC20(token).balanceOf(holder) - holderBefore;
        if (credited != amount) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(amount, credited);
        }
    }

    /// @dev The source-side rule of EVERY release from a holder, and of every
    ///      relocation out of the Diamond, in one place (Codex #2158 r12,
    ///      r15, r22 P2): the source must have been debited by exactly
    ///      `amount`. A token that credits the destination without debiting
    ///      the source would otherwise leave the asset behind a "moved"
    ///      event, repeatable at will. The destination side differs by
    ///      asset: custody moves require exact growth, foreign sweeps report
    ///      the measured receipt (a fee-on-transfer token legitimately
    ///      delivers less).
    function requireDebited(
        address from,
        uint256 balanceBefore,
        uint256 balanceAfter,
        uint256 amount
    ) internal pure {
        uint256 debited = balanceAfter > balanceBefore ? 0 : balanceBefore - balanceAfter;
        if (debited != amount) {
            revert IVaipakamErrors.RewardCustodySourceNotDebited(from, amount, debited);
        }
    }

    /// @dev When the configured treasury is this Diamond, an ERC-20 delivered
    ///      to it must be CREDITED to the treasury's tracked balance (Codex
    ///      #2158 post-cap P2): `TreasuryFacet.claimTreasuryFees` releases
    ///      only `treasuryBalances[asset]`, so an uncredited receipt would sit
    ///      in the Diamond's raw balance, unclaimable — and, for the
    ///      configured VPFI, back in the mixed balance the holder exists to
    ///      separate. Credited as a plain balance, not through the fee
    ///      analytics: a recovered stray asset is not revenue.
    function creditDiamondTreasury(
        LibVaipakam.Storage storage s,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0 || s.treasury != address(this)) return;
        s.treasuryBalances[asset] += amount;
    }

    // ─── The delivered ledger's received side ──────────────────────────────

    /**
     * @notice Credit `amount` of FRESH funding that has just arrived at the
     *         holder to the delivered ledger's received side, attributing
     *         its custody under the §5c deficit split: the part that merely
     *         closes a `paid > received` deficit goes to the restitution
     *         row, and only the excess — the part that becomes headroom —
     *         to the live-fresh row.
     * @dev    Why the split: with `paid > received`, the next credit raises
     *         `received` without creating headroom until the deficit clears,
     *         so tokens allocated to the live row for that portion back
     *         nothing a claim can ever debit, and the next role transition
     *         would carry a holder allocation with no ledger balance and no
     *         terminal path. The restitution row is owner-disposable and is
     *         never live backing (design §5c). Holds for every fresh ingress
     *         — the funding writer, the mirror's remittance and compensation
     *         credits — so the rule has one implementation.
     *
     *         PRECONDITION: the caller has already moved `amount` into the
     *         holder ({fundFromCaller} / {relocateToHolder}) WITHOUT
     *         crediting a row — this is the row credit. The live-fresh row
     *         therefore equals `received − paid` after every credit, which
     *         is what lets the gates read the row as the fresh backing.
     * @return toLive        Allocated to the live-fresh row.
     * @return toRestitution Allocated to the restitution row.
     */
    function creditFreshIngress(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal returns (uint256 toLive, uint256 toRestitution) {
        if (amount == 0) return (0, 0);
        (toLive, toRestitution) = freshSplit(s, amount);
        uint256 received = s.rewardBudgetArmedFreshReceived;
        s.rewardBudgetArmedFreshReceived = received + amount;
        credit(s, LibVaipakam.RewardCustodyRow.LiveFresh, toLive, 0);
        credit(s, LibVaipakam.RewardCustodyRow.Restitution, toRestitution, 0);
        emit RewardCustodyFreshCredited(amount, toLive, toRestitution, received + amount);
    }

    /// @notice The §5c deficit split, in ONE place: of a fresh credit of
    ///         `amount`, what the standing deficit (`paid − received`)
    ///         absorbs goes to restitution, only the excess to live backing.
    ///         Read by every fresh credit — the ingress, the funding writer,
    ///         and the reconciliation epoch's classification and
    ///         reclassification into fresh (#1566 closure 2 cutover PR 2).
    function freshSplit(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal view returns (uint256 toLive, uint256 toRestitution) {
        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 paid = s.rewardBudgetArmedFreshPaid;
        uint256 deficit = paid > received ? paid - received : 0;
        toRestitution = amount < deficit ? amount : deficit;
        toLive = amount - toRestitution;
    }

    /**
     * @notice Reverse a fresh credit (a provisional compensation being
     *         demoted): the received side unwinds by `amount`, saturating
     *         as it always has, and the holder RE-ATTRIBUTES what it still
     *         holds of that credit — from the live-fresh row first, then
     *         from the restitution row — into the `Unclassified` row, in
     *         place, at most `amount`, less only where part of it was
     *         already paid out.
     * @dev    Both rows give back, because the demotion re-attributes the
     *         WHOLE credited amount to the stranded-recovery reservation
     *         (Codex #2186 r1 P1); the deficit the restitution portion
     *         covered re-opens with the received unwind, exactly as it would
     *         have without the split. Whatever was already paid out cannot
     *         come back; the reservation is short by that much, as before.
     *         After the unwind the live row again equals `received − paid`.
     *         #1566 closure 2 cutover PR 1: the tokens MOVE IN-HOLDER
     *         (design §5c, "classification is an IN-HOLDER reattribution")
     *         and the R4 return then draws them from the row — an earlier
     *         revision released them to the Diamond's balance, where the
     *         quarantine reservation was still Diamond-side.
     * @return moved What the holder re-attributed into `Unclassified`.
     */
    function uncreditFreshInHolder(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal returns (uint256 moved) {
        if (amount == 0) return 0;
        uint256 received = s.rewardBudgetArmedFreshReceived;
        s.rewardBudgetArmedFreshReceived = received > amount ? received - amount : 0;
        uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        uint256 fromLive = amount < live ? amount : live;
        move(s, LibVaipakam.RewardCustodyRow.LiveFresh, LibVaipakam.RewardCustodyRow.Unclassified, fromLive);
        uint256 rest = amount - fromLive;
        uint256 restitution = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution];
        uint256 fromRestitution = rest < restitution ? rest : restitution;
        move(
            s, LibVaipakam.RewardCustodyRow.Restitution, LibVaipakam.RewardCustodyRow.Unclassified, fromRestitution
        );
        moved = fromLive + fromRestitution;
    }

    // ─── The UNCLASSIFIED ingress attribution (#1566 closure 2 cutover PR 1) ──
    //
    // Design §5c: "An untyped arrival is PROTECTED AT INGRESS — actualReceived
    // routes into an UNCLASSIFIED holder attribution the moment it lands."
    // On an ACTIVATED deployment the three untyped arrivals PR B left
    // Diamond-side — the uncounted remainder of a delivery, a quarantined
    // compensation (and a demotion's unwind), and a stranded return for a
    // receipt that predates recovery attribution — are relocated (measured)
    // into the `Unclassified` row as they land, and every value-bearing
    // packet is recorded under its INGRESS STAMP so the cutover's second PR
    // can classify it per packet. The row is never spendable as fresh; its
    // only exits here are the R4 return (a quarantine going back) — the
    // classification exits are the second PR's.

    uint8 internal constant PACKET_KIND_BUDGET = 1;
    uint8 internal constant PACKET_KIND_COMPENSATION = 2;
    /// @dev The one era every reconciliation entry keys until slice 4 PR C's
    ///      registry assigns real ids; the row hook records into it.
    uint64 internal constant PRE_BACKFILL_ERA = 0;

    /// @notice The one predicate for "this era exists" — the pre-backfill
    ///         era alone until the transport epochs' registry replaces this
    ///         body. A caller-supplied era that does not exist refuses here
    ///         rather than reading an empty era-keyed queue beside the
    ///         global custody figures as if it were one (Codex #2206 r9).
    function requireKnownEra(uint64 era) internal pure {
        if (era != PRE_BACKFILL_ERA) revert IVaipakamErrors.ReconciliationUnknownEra(era);
    }
    uint8 internal constant PACKET_KIND_STRANDED_RETURN = 3;
    uint8 internal constant PACKET_KIND_CEREMONY_INFLOW = 4;

    /// @notice A value-bearing reward packet was recorded under its ingress stamp.
    /// @custom:event-category state-change/reward-custody
    event IngressPacketRecorded(
        bytes32 indexed packetHash,
        uint256 indexed sourceChainId,
        uint8 kind,
        uint256 actualReceived,
        address remitter,
        uint256 remitId
    );
    /// @notice Untyped value landed in (or was re-attributed into) the
    ///         holder's `Unclassified` row for a packet.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyUnclassifiedCredited(bytes32 indexed packetHash, uint8 kind, uint256 amount);
    /// @notice #1566 transport epochs PR 3a — a packet's day-list commitment
    ///         (the flat hash of the days its payload named, and their count)
    ///         was recorded at ingress, with the record.
    /// @custom:event-category state-change/reward-custody
    event IngressPacketDayListRecorded(bytes32 indexed packetHash, bytes32 dayListHash, uint256 dayCount);
    /// @notice #1566 transport epochs PR 3b — an old-wire delivery opened its
    ///         transport epoch. Its membership is NOT yet indexed: admission is
    ///         compact for every delivery, and `TransportBatchPageIndexed`
    ///         reports the index being built afterwards.
    /// @custom:event-category state-change/reward-custody
    event TransportBatchAdmitted(
        bytes32 indexed batchId,
        bytes32 indexed packetHash,
        uint256 amount,
        uint256 dayCount
    );
    /// @notice #1566 transport epochs PR 3b — one bounded page of a batch's
    ///         membership was indexed against its commitment. Every admitted
    ///         batch is indexed this way; size decides how many pages, not
    ///         whether there are any.
    /// @custom:event-category state-change/reward-custody
    event TransportBatchPageIndexed(bytes32 indexed batchId, uint32 indexedDays, uint32 dayCount);
    /// @notice #1566 transport epochs PR 3b — what a batch's obligations left
    ///         was parked under the batch's key, still bound by its membership.
    /// @custom:event-category state-change/reward-custody
    event TransportRemainderParked(bytes32 indexed batchId, uint256 amount, bytes32 dayListHash);
    /// @notice #1566 transport epochs PR 3b — a batch's parked remainder was
    ///         acknowledged, which is what makes its packet classifiable.
    /// @custom:event-category state-change/reward-custody
    event TransportBatchReleased(bytes32 indexed batchId, uint256 remainder);
    /// @notice #1566 transport epochs PR 3b — a disposition took part of a
    ///         batch's parked remainder. `left` is what the entry still holds,
    ///         emitted rather than derived so a reader never has to replay the
    ///         whole history to know what is still parked.
    /// @custom:event-category state-change/reward-custody
    event TransportRemainderDebited(bytes32 indexed batchId, uint256 amount, uint256 left);
    /// @notice #1566 transport epochs PR 3a — the canonical chain's recorded
    ///         split of a d2 remittance was attested for the packet that
    ///         delivered it, both caps scaled to what actually landed.
    /// @custom:event-category state-change/reward-custody
    event IngressPacketSplitAttested(
        bytes32 indexed packetHash,
        address indexed remitter,
        uint256 indexed remitId,
        uint256 freshAttested,
        uint256 recycledAttested
    );
    /// @notice A stranded record's held value left the `Unclassified` row
    ///         for the return sender.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyUnclassifiedReleased(bytes32 indexed packetHash, address to, uint256 amount);

    /// @notice The ingress stamp: `keccak256(sourceChainId, transportMessageId)`
    ///         for a transport that carries a message id; for one that does
    ///         not (`transportMessageId == 0`), a monotonic per-source
    ///         counter allocated INSIDE the authenticated ingress (design
    ///         §5c L4130-4132) — never an operator-supplied tuple.
    function allocatePacketHash(
        LibVaipakam.Storage storage s,
        uint256 sourceChainId,
        bytes32 transportMessageId
    ) internal returns (bytes32) {
        if (transportMessageId != bytes32(0)) {
            return keccak256(abi.encode(sourceChainId, transportMessageId));
        }
        return keccak256(abi.encode(sourceChainId, ++s.ingressSequence[sourceChainId], "seq"));
    }

    /// @notice The receipt key — ONE derivation (#1566 transport epochs PR 3a:
    ///         four byte-identical private copies collapsed here): a mirror's
    ///         receipt of `remitId` from the canonical deployment `remitter`,
    ///         written at the delivery, read by the ack send, the lens and the
    ///         attestation.
    function remitReceiptKey(address remitter, uint256 remitId) internal pure returns (bytes32) {
        return keccak256(abi.encode(remitter, remitId));
    }

    /// @notice #1566 transport epochs PR 3a — the EVIDENCE bounding a
    ///         packet's fresh side (§5c: a fresh classification requires
    ///         authenticated source evidence; absent it, value classifies
    ///         recycled or stays), DERIVED here at use time.
    /// @dev    Derived, never snapshotted into a field by an earlier step
    ///         (Codex #2217 r3). The split attestation is permissionless and
    ///         can land after the batch it describes has been parked, so a
    ///         bound written at parking from the caps as they stood then would
    ///         read zero forever for exactly the packets the attestation was
    ///         sent to evidence — permanently unusable fresh value, with the
    ///         attestation one-shot and no second parking transition to fix
    ///         it. Reading the immutable caps HERE makes a late attestation
    ///         effective the moment it lands, in whatever order the two
    ///         permissionless steps happen to occur.
    ///
    ///         WHY THE ATTESTED CAP AND THE BOUND ARE DIFFERENT FIELDS: the
    ///         caps are the SOURCE's record — both sides, immutable, and 3b
    ///         reconciles its transport legs against them — while the bound is
    ///         what a classification may spend, which 3b computes as the cap
    ///         NET of the fresh leg already drawn. Overwriting
    ///         `freshAuthenticated` with the cap would make the evidence
    ///         figure something 3b then has to mutate as legs are consumed:
    ///         an "authenticated" number edited by ordinary operation, which
    ///         is the shape §5c exists to avoid. Kept apart, the source's
    ///         record is written once and never touched, and everything
    ///         derived from it is derived here.
    ///
    ///         The gate that admits an attested cap as evidence is the
    ///         batch's ACKNOWLEDGED PARKED REMAINDER (§5c: a batch with
    ///         outstanding listed obligations is not classifiable at all, or
    ///         classifying it would let an unrelated claim spend what the
    ///         packet was delivered to pay specific days with), and the batch
    ///         lifecycle is the transport epochs' 3b. Until it lands no packet
    ///         can pass {packetBatchReleased}, so this reads the wire-typed
    ///         figure alone — zero for every wire that carried no split — and
    ///         an attestation lifts no bound by itself.
    function authenticatedFresh(LibVaipakam.IngressPacket storage p) internal view returns (uint256) {
        if (p.attested && packetBatchReleased(p)) {
            // NET of what the packet's own transport draws already spent of
            // its fresh component (Codex #2224 r2): the cap is what the source
            // recorded, not what is left, and classifying the gross figure
            // would republish fresh value the batch already paid listed
            // obligations with. PR 3b filled both seams, and they stayed two
            // so that flipping the release predicate alone can never expose
            // the gross cap.
            uint256 drawn = transportConsumedFresh(p);
            return p.freshAttested > drawn ? p.freshAttested - drawn : 0;
        }
        return p.freshAuthenticated;
    }

    /// @notice What a packet's own transport draws have already spent of its
    ///         FRESH component.
    /// @dev    #1566 transport epochs PR 3b filled this in: the answer is the
    ///         batch's own fresh leg counter. It stays ZERO through 3b-i,
    ///         because the counter is written by the draws PR 3b-ii adds —
    ///         which is a real read of a real zero, not a stub, and it is the
    ///         reason the counter ships with the ledger rather than with the
    ///         draws: a classification must never be able to run against a
    ///         packet whose legs are unreadable.
    ///
    ///         A packet with NO batch answers zero directly. That is the right
    ///         answer for every population that has none — a d5 delivery,
    ///         whose components were typed on the wire; any packet that landed
    ///         before this ledger existed; and any that landed before reward
    ///         custody was activated here (Codex #2232 r1).
    ///
    ///         The second half of the seam {authenticatedFresh} reads, kept
    ///         separate from {packetBatchReleased} deliberately: one predicate
    ///         deciding both "may this be classified" and "how much of it" is
    ///         how a later change exposes a gross figure by flipping a
    ///         boolean. Both halves are single storage reads and must stay so:
    ///         classification reaches them through {authenticatedFresh}, and
    ///         `RewardReconciliationFacet` has under 2 KB of EIP-170 headroom.
    function transportConsumedFresh(LibVaipakam.IngressPacket storage p) internal view returns (uint256) {
        bytes32 batchId = p.batchId;
        if (batchId == bytes32(0)) return 0;
        return LibVaipakam.storageSlot().transportBatches[batchId].consumedFresh;
    }

    /// @notice Whether a packet's batch has been parked with its
    ///         acknowledgment, so what remains of it is classifiable.
    /// @dev    #1566 transport epochs PR 3b filled this in, and nothing else
    ///         about the evidence rule moved with it. A batch is released by
    ///         its remainder being parked WITH its recorded acknowledgment
    ///         (§5c), which is a property of the BATCH rather than of the
    ///         delivery that opened it — so the flag lives there and the
    ///         packet carries only the link. Parking alone does not release:
    ///         an operator would otherwise make a packet classifiable merely
    ///         by draining its batch.
    ///
    ///         A packet with no batch answers NO, which is what keeps every
    ///         packet that landed before this ledger behaving exactly as it
    ///         did. A d5 packet also has none, and never needs one: its
    ///         components were typed on the wire and credited to the shared
    ///         ledgers at ingress, so it is not attested and this predicate is
    ///         never the thing standing between it and a classification.
    function packetBatchReleased(LibVaipakam.IngressPacket storage p) internal view returns (bool) {
        bytes32 batchId = p.batchId;
        if (batchId == bytes32(0)) return false;
        return LibVaipakam.storageSlot().transportBatches[batchId].released;
    }

    /// @notice #1566 transport epochs PR 3a — mark a reservation as dispatched
    ///         on a wire that CARRIES ITS SPLIT, so the mirror types its packet
    ///         at ingress and a split attestation for it can never land.
    /// @dev    Every path that creates a reservation calls this: the budget
    ///         remittance and both compensation dispatches (Codex #2224 r2 —
    ///         the compensation rows went unmarked when only the budget path
    ///         set the flag, and the eligibility rule then admitted an
    ///         attestation the destination had to reject). One helper rather
    ///         than three assignments so the rule has one name to grep for,
    ///         and `RewardRemittanceAttestEligibilityTest` drives all three
    ///         paths so a fourth that forgets is loud rather than silent.
    function markReservationSplitOnWire(LibVaipakam.RemitReservation storage r) internal {
        r.splitOnWire = true;
    }

    /// @notice #1566 transport epochs PR 3a — whether a reservation can be
    ///         attested at all. ONE rule, read by the canonical send and by
    ///         its fee quote alike, so the figure a caller is quoted and the
    ///         message that goes out can never disagree about eligibility
    ///         (Codex #2224 r1).
    /// @dev    A status-only check was not enough. A close-only remittance is
    ///         born terminal with no value, so it dispatches no packet and
    ///         writes no receipt — an attestation for it can only revert at
    ///         the destination for want of a receipt. A reservation whose own
    ///         wire carried the split produced a packet the mirror typed at
    ///         ingress, which the mirror refuses as already typed. Both are
    ///         refused HERE, because the transport fee is paid by the caller
    ///         up front and is not refunded by a destination revert: a
    ///         re-sendable message is a retry lever only while the retry can
    ///         one day land.
    function requireAttestable(
        LibVaipakam.Storage storage s,
        uint256 remitId
    ) internal view returns (address messenger, LibVaipakam.RemitReservation storage r) {
        // EVERY precondition, in one place, returning what each caller needs
        // (Codex #2224 r6). An earlier revision shared only the reservation
        // rules and left the role and messenger gates to each path, and the
        // fee quote promptly drifted: on a demoted deployment it priced an
        // operation the send would refuse, because the historical reservations
        // are deliberately kept in storage. A caller that cannot obtain the
        // messenger without passing the gates cannot quote what it would not
        // send.
        if (!s.isCanonicalRewardChain) revert IVaipakamErrors.NotCanonicalRewardChain();
        messenger = s.rewardMessenger;
        if (messenger == address(0)) revert IVaipakamErrors.RewardMessengerNotSet();
        r = s.remitReservations[remitId];
        if (r.status == 0) revert IVaipakamErrors.RemitReservationUnknown(remitId);
        if (r.fresh + r.recycled == 0) revert IVaipakamErrors.RemitReservationCarriesNoSplit(remitId);
        if (r.splitOnWire) revert IVaipakamErrors.RemitSplitAlreadyOnWire(remitId);
    }

    /// @notice #1566 transport epochs PR 3a — the day-list commitment of a
    ///         just-recorded packet: the flat hash of the days its payload
    ///         named and their count, written ONCE by the mirror ingress in
    ///         the same transaction as the record, so every arrival on a wire
    ///         older than d6 carries authenticated membership for 3b's compact
    ///         admission to materialize against — never taken from an event.
    function stampPacketDayList(LibVaipakam.Storage storage s, bytes32 h, uint256[] memory dayIds) internal {
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        if (p.arrivedAt == 0) revert IVaipakamErrors.IngressPacketUnknown(h);
        if (p.dayListHash != bytes32(0)) revert IVaipakamErrors.IngressPacketDayListStamped(h);
        bytes32 commitment = keccak256(abi.encode(dayIds));
        p.dayListHash = commitment;
        p.dayCount = dayIds.length;
        emit IngressPacketDayListRecorded(h, commitment, dayIds.length);
    }

    // ─── The transport epochs (#1566 PR 3b) ──────────────────────────────────

    /// @notice The largest `dayIds` fan-out the canonical chain will build a
    ///         remittance for.
    /// @dev    #1566 transport epochs PR 3b. The cap exists because
    ///         RETIREMENT writes one index update per member day: a list that
    ///         fit the source transaction can exceed the DESTINATION's block
    ///         gas limit when that happens, leaving the exhausted batch parked
    ///         at the front of every member cursor forever. "Wire-bounded" is
    ///         not a bound — the remitter supplies any nonempty list.
    ///
    ///         32 is a month of daily rows, which covers the lane's real
    ///         shapes, and sizes both ends comfortably: admission pushes at
    ///         most 32 index entries and retirement clears at most 32.
    ///
    ///         It is enforced at DISPATCH and NOT at ingress. A transport
    ///         payload is immutable once sent, so a receive-side refusal
    ///         retries the same over-cap message forever; the receiver instead
    ///         ADMITS any transport-authentic packet, an over-cap one through
    ///         the compact admission below.
    uint256 internal constant TRANSPORT_DAY_FANOUT_CAP = 32;

    /// @notice How many member days one materialization call indexes.
    /// @dev    #1566 transport epochs PR 3b — sized to the same per-call
    ///         storage cost `TRANSPORT_DAY_FANOUT_CAP` bounds a delivery to,
    ///         so ANY batch is indexed by repeating a call that is known to
    ///         fit rather than by a caller guessing a page size. A within-cap
    ///         batch takes exactly one such call; it does not skip the step,
    ///         because admission writes no membership for any batch.
    uint256 internal constant TRANSPORT_INDEX_PAGE = 32;

    /// @notice #1566 transport epochs PR 3b — open this delivery's TRANSPORT
    ///         EPOCH: one untyped balance, spendable only by the obligations
    ///         whose day the delivery listed.
    /// @dev    Called at ingress, in the same transaction as the record and
    ///         the day-list commitment, under exactly the conditions that book
    ///         the delivery's untyped remainder into the holder's
    ///         `Unclassified` row: an untyped wire, a non-zero remainder, and
    ///         an ACTIVATED deployment. The last of those matters as much as
    ///         the first (Codex #2232 r1): before activation the remainder is
    ///         not booked at all — the tokens sit Diamond-side and the
    ///         activation envelope attributes them — so an epoch opened then
    ///         would claim an amount another path is free to move, and the two
    ///         claims could never be reconciled afterwards.
    ///
    ///         A d5 delivery takes no batch: its
    ///         components are typed on the wire and credited to the shared
    ///         live/bucket ledgers at ingress, so admitting it here as well
    ///         would make one delivery spendable twice — once through the
    ///         batch and once through the ledgers it was already credited to
    ///         (§5c's one-accounting-path rule). The caller passes the fact
    ///         rather than inferring it: the RECEIVER is the only party that
    ///         saw the wire generation, and at this depth a typed delivery
    ///         that happens to carry a zero fresh component is
    ///         indistinguishable from an untyped one.
    ///
    ///         The batch is keyed by the packet's own ingress stamp — the
    ///         epoch's unit is the PACKET (§5c: the old wire is batched and
    ///         carries no per-day split, so a per-day balance cannot be
    ///         constructed from it at all), and one key for both means a draw
    ///         can never reach a batch whose packet it has not also reached.
    ///         Storing it on the packet is what lets
    ///         {packetBatchReleased} stay a single storage read from an
    ///         `IngressPacket` alone.
    ///
    ///         The admission is COMPACT for every delivery, whatever its
    ///         list's length (Codex #2232 r2): it writes this batch's row and
    ///         nothing per-day. The receiver's callback runs inside
    ///         `LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT` — 300,000
    ///         — and 32 first-time per-day pushes cost two new storage slots
    ///         each, which exceeds that budget on its own before the packet
    ///         record and the custody relocation are counted. Indexing short
    ///         lists here would therefore have failed to deliver precisely the
    ///         in-flight old-wire messages this path exists to preserve.
    ///
    ///         Refusing a long list instead was never available either: the
    ///         payload is immutable, so the refusal repeats for as long as the
    ///         message is re-executed, and the delivery is authentic. One
    ///         compact path serves both, and the per-day index is built
    ///         afterwards by {materializeTransportBatchPage}, permissionlessly,
    ///         against the day-list commitment 3a stamped.
    /// @param  s        Diamond storage.
    /// @param  h        The packet's ingress stamp.
    /// @param  dayIds   The delivery's day list, as it arrived.
    /// @param  untyped  What this delivery brought that is in NO shared
    ///                  ledger: the destination-observed amount less any
    ///                  component the wire stated. For the untyped wires this
    ///                  admission is for, that is the whole of
    ///                  `actualReceived` — never the declared total, since a
    ///                  short delivery must shrink the funding and not the
    ///                  obligations.
    ///
    ///                  It is the REMAINDER rather than the amount so that the
    ///                  epoch's balance and the `Unclassified` protection the
    ///                  ingress books alongside it are the same expression. A
    ///                  caller that said "untyped" while also stating a
    ///                  component would otherwise leave that component
    ///                  spendable twice — once through the shared ledger it
    ///                  was credited to, once through this balance — and the
    ///                  rule that forbids it should hold by construction, not
    ///                  by the caller being right.
    /// @return batchId  The batch's key, equal to the packet's stamp.
    function admitTransportBatch(
        LibVaipakam.Storage storage s,
        bytes32 h,
        uint256[] calldata dayIds,
        uint256 untyped
    ) internal returns (bytes32 batchId) {
        // Only the list's LENGTH is read here. Its contents are already
        // committed to by the packet's `dayListHash`, and the index they feed
        // is written later, page by page, against that commitment.
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        if (p.arrivedAt == 0) revert IVaipakamErrors.IngressPacketUnknown(h);
        // No balance, no batch — §5c: a batch with nothing in it has a
        // membership that can reserve nothing and a retirement that retires
        // nothing, and here it would be worse than useless, since the
        // classification gate would hold a valueless packet shut until an
        // operator went through a release that releases nothing. The delivery
        // keeps `batchId == 0` and is ungated, which is the honest answer: it
        // holds no epoch value for the gate to protect.
        if (untyped == 0) return bytes32(0);
        batchId = _openTransportBatch(s, p, h, dayIds.length, untyped);
    }

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r3) — admit the
    ///         ROLLOUT POPULATION: an old-wire packet that landed while 3a's
    ///         commitment existed but this ledger did not.
    /// @dev    Permissionless, and retrospective. 3a records a day-list
    ///         commitment on EVERY arrival on a wire older than d6 — design
    ///         §5c states that it does so precisely "so a packet landing
    ///         between 3a and 3b carries authenticated membership 3b can
    ///         index". Without this entry that sentence is false for the whole
    ///         3a-to-3b window: `admitTransportBatch` is reachable only from
    ///         the ingress, so those packets hold untyped value with no epoch
    ///         bounding it, `materializeTransportBatchPage` refuses their
    ///         committed list as an unknown batch, and their zero `batchId`
    ///         makes classification skip the gate entirely.
    ///
    ///         The authority is the PACKET'S OWN RECORD, never the caller:
    ///         balance, membership and count are all read from it, so a
    ///         stranger calling this can only make the ledger state what the
    ///         ingress already wrote. That is the same authority
    ///         materialization runs on, and it is why no role gates either.
    ///
    ///         WHICH PACKETS. Four conditions, each refused by name rather
    ///         than skipped, because a silent skip here is the same silent
    ///         bypass the classification gate exists to close:
    ///
    ///          1. no epoch yet — a re-run must not restate an immutable
    ///             anchor;
    ///          2. a 3a commitment exists — membership is never taken from a
    ///             caller's word, so a packet that recorded no day list cannot
    ///             be bound to one;
    ///          3. the record states NO component — a wire that typed its
    ///             delivery had those components credited to the shared
    ///             ledgers at ingress, and an epoch over them would make one
    ///             value drawable in two places;
    ///          4. something is protected-and-unclassified to bind.
    ///
    ///         Condition 3 is the one that cannot be made exact, and saying so
    ///         is the point. At ingress depth the live path is TOLD which wire
    ///         it is (`splitTyped`), because a d5 delivery whose components
    ///         both floored to zero and a legacy delivery that transmitted
    ///         nothing arrive as the same two zeros. A recorded packet carries
    ///         no such statement, so this entry reads the shape instead: both
    ///         components zero. The residue is a d5 delivery short enough to
    ///         floor BOTH components away, which this entry would admit and
    ///         the live ingress would not. That direction is the conservative
    ///         one — the value becomes bound to the days its own delivery
    ///         named and needs a release before it can be classified, which is
    ///         a stricter gate on the same funds, never a second claim on
    ///         them. The opposite default (refuse everything ambiguous) would
    ///         leave genuine old-wire value permanently ungated, which is the
    ///         gap this entry exists to close.
    ///
    ///         THE ANCHOR IS WHAT REMAINS, not what arrived. A rollout packet
    ///         may already have been classified against, since a zero
    ///         `batchId` skipped the gate for as long as no epoch existed; its
    ///         `admitted` is therefore its CURRENT `unclassified`, and the
    ///         conservation rule (`admitted == balance + parked`) holds
    ///         against that. This is the same expression the live ingress
    ///         admits — there the packet's `unclassified` has just been
    ///         credited with exactly the remainder being passed — so both
    ///         entries bind the epoch to the protected row rather than to a
    ///         figure that merely ought to equal it.
    /// @param  s          Diamond storage.
    /// @param  packetHash The packet's ingress stamp, which is its batch's key.
    /// @return batchId    The batch's key, equal to the packet's stamp.
    function admitLegacyTransportBatch(
        LibVaipakam.Storage storage s,
        bytes32 packetHash,
        uint256[] calldata dayIds
    ) internal returns (bytes32 batchId) {
        LibVaipakam.IngressPacket storage p = s.ingressPackets[packetHash];
        uint8 status = rolloutAdmissionStatus(p);
        if (status != ROLLOUT_ADMISSIBLE) _revertRolloutRefusal(status, packetHash);
        // #1566 transport epochs PR 3b — THE DAY LIST IS EXHIBITED HERE
        // BECAUSE THE ANCHOR IS FIXED HERE.
        //
        // This check was introduced with a SYMMETRY argument: admission sets
        // `p.batchId`, which closed the classification gate on a packet that
        // was until then ungated, and the only route back through that gate
        // proves the same list — so without it anyone could close a gate only
        // a list-holder could reopen.
        //
        // THAT ARGUMENT IS RETIRED, and is written out rather than left
        // standing (Codex #2232 r5). Since {rolloutAdmissionStatus} became the
        // gate's rule too, an owed packet is gated by its own SHAPE from the
        // moment it lands, and this call closes nothing — so a justification
        // resting on what it closes is now simply false. A false justification
        // at this exact seam is how the conflation took five review rounds to
        // find; leaving one behind to be re-read as current is the same
        // mistake with a longer fuse.
        //
        // The check stays, for the reason that actually holds: this is the one
        // call that fixes an IMMUTABLE anchor over the protected row, and an
        // anchor bounding a membership nobody can ever exhibit describes a set
        // nobody can enumerate. It costs a caller nothing it does not already
        // need — {materializeTransportBatchPage} proves the same list against
        // the same commitment, so no route to a release exists without it.
        //
        // The list is NOT written here: admission stays compact and the
        // membership is still built by the paged call. The only thing this
        // adds is that the material now sits in the admitting transaction's
        // calldata permanently, which outlives any log-retention policy.
        //
        // `dayIds.length` is not compared against `p.dayCount` separately —
        // the commitment is over the whole encoded array, so a list of a
        // different length cannot hash to it.
        bytes32 supplied = keccak256(abi.encode(dayIds));
        if (supplied != p.dayListHash) {
            revert IVaipakamErrors.TransportDayListMismatch(packetHash, p.dayListHash, supplied);
        }
        batchId = _openTransportBatch(s, p, packetHash, p.dayCount, p.unclassified);
    }

    // ─── the ROLLOUT ADMISSIBILITY predicate, and its ONE clause list ───────

    /// @dev #1566 transport epochs PR 3b (Codex #2232 r4) — the statuses
    ///      {rolloutAdmissionStatus} answers with. They exist so the clause
    ///      list has exactly ONE home: the retrospective ADMISSION and the
    ///      classification GATE both need to know "is this packet one the
    ///      rollout can still bring in?", and they need the same answer.
    ///      Asking it twice in two places is how the gate came to exempt the
    ///      very packets the admission was written to rescue.
    uint8 internal constant ROLLOUT_ADMISSIBLE = 0;
    uint8 internal constant ROLLOUT_UNKNOWN_PACKET = 1;
    uint8 internal constant ROLLOUT_ALREADY_ADMITTED = 2;
    uint8 internal constant ROLLOUT_NO_DAY_LIST = 3;
    uint8 internal constant ROLLOUT_WIRE_TYPED = 4;
    uint8 internal constant ROLLOUT_NOTHING_UNTYPED = 5;

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r4) — whether the
    ///         ROLLOUT admission could still open an epoch over this packet,
    ///         and if not, why not.
    /// @dev    The single definition of "eligible for retrospective
    ///         admission". Every clause is a property of the PACKET RECORD, so
    ///         the answer does not depend on who is asking or what they
    ///         supply; proving the day-list MATERIAL is the admission's own
    ///         extra step and deliberately not here, because it is evidence a
    ///         caller exhibits rather than a property the packet has.
    ///
    ///         TWO consumers, and that is the whole point:
    ///
    ///         - {admitLegacyTransportBatch}, which refuses by name;
    ///         - {takeFromReleasedRemainder}, whose "no batch, nothing to
    ///           gate" shortcut is correct ONLY for a packet no epoch can ever
    ///           be opened over.
    ///
    ///         The second is the r4 finding. A 3a-to-3b packet carries a day
    ///         list and holds `batchId == 0` until somebody calls the
    ///         permissionless admission — so the gate read it as pre-ledger
    ///         and let an administrator classify its remainder away without a
    ///         release and without a debit, which is the bypass the epoch
    ///         exists to close, surviving on precisely the population the
    ///         rollout entry exists to rescue. Two readings of one question,
    ///         one of them tacit; now one function.
    function rolloutAdmissionStatus(LibVaipakam.IngressPacket storage p)
        internal
        view
        returns (uint8)
    {
        if (p.arrivedAt == 0) return ROLLOUT_UNKNOWN_PACKET;
        if (p.batchId != bytes32(0)) return ROLLOUT_ALREADY_ADMITTED;
        if (p.dayListHash == bytes32(0) || p.dayCount == 0) return ROLLOUT_NO_DAY_LIST;
        // This clause carries a SECOND guarantee beyond the one-accounting-path
        // rule it was written for, and the second one is load-bearing: it is
        // what keeps a transport epoch off every packet a stranded record can
        // bind to, so the R4 repatriation's step-down — which consults no
        // batch — can never strand an anchor over value that has gone home.
        // See {releaseUnclassifiedForReturn}.
        if (p.freshShare != 0 || p.recycledShare != 0) return ROLLOUT_WIRE_TYPED;
        if (p.unclassified == 0) return ROLLOUT_NOTHING_UNTYPED;
        return ROLLOUT_ADMISSIBLE;
    }

    /// @dev The status-to-error mapping, kept beside the predicate so a new
    ///      clause cannot be added without a refusal to name it. Never called
    ///      with {ROLLOUT_ADMISSIBLE}; the trailing revert is the unreachable
    ///      default a future clause would otherwise fall through silently.
    function _revertRolloutRefusal(uint8 status, bytes32 packetHash) private pure {
        if (status == ROLLOUT_UNKNOWN_PACKET) {
            revert IVaipakamErrors.IngressPacketUnknown(packetHash);
        }
        if (status == ROLLOUT_ALREADY_ADMITTED) {
            revert IVaipakamErrors.TransportBatchAlreadyAdmitted(packetHash);
        }
        if (status == ROLLOUT_NO_DAY_LIST) {
            revert IVaipakamErrors.TransportPacketHasNoDayList(packetHash);
        }
        if (status == ROLLOUT_WIRE_TYPED) {
            revert IVaipakamErrors.TransportPacketWireTyped(packetHash);
        }
        revert IVaipakamErrors.TransportPacketNothingUntyped(packetHash);
    }

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r3) — the ONE writer
    ///         of a transport batch's row, shared by the ingress admission and
    ///         the rollout admission.
    /// @dev    One writer because the two entries differ only in how they
    ///         learn the delivery's shape — the ingress is told it on the
    ///         wire, the rollout entry reads it off the record — and not at
    ///         all in what a batch IS. A second copy of these four writes is a
    ///         second place for the anchor, the membership count and the
    ///         packet's back-reference to disagree.
    function _openTransportBatch(
        LibVaipakam.Storage storage s,
        LibVaipakam.IngressPacket storage p,
        bytes32 h,
        uint256 count,
        uint256 untyped
    ) private returns (bytes32 batchId) {
        batchId = h;
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        b.balance = untyped;
        b.admitted = untyped;
        // Cast by name rather than silently: the fan-out is bounded at
        // dispatch and by the destination's gas limit long before a list could
        // reach 2^32 days, so this can only fire on something that is already
        // wrong, and a truncated `dayCount` would then quietly declare an
        // oversize batch fully indexed.
        b.dayCount = SafeCast.toUint32(count);
        p.batchId = batchId;
        emit TransportBatchAdmitted(batchId, h, untyped, count);
    }

    /// @notice #1566 transport epochs PR 3b — index one bounded page of a
    ///         batch's membership, proving the page against the day list this
    ///         delivery committed to at ingress. EVERY admitted batch is
    ///         indexed here, oversize or not — see the note below.
    /// @dev    Permissionless: the commitment is the authority, so anyone may
    ///         supply the payload and nobody can supply a different one. The
    ///         whole list is re-supplied on every call because the commitment
    ///         is flat — one hash over the encoded list, which 3a stamped
    ///         precisely so membership never has to be taken from an event —
    ///         while only `TRANSPORT_INDEX_PAGE` entries are WRITTEN, storage
    ///         being what the destination's block gas limit actually bounds.
    ///
    ///         Every batch is indexed this way, because every admission is
    ///         compact. A batch whose index is already whole has no page left
    ///         and refuses, rather than accepting a call that would write
    ///         nothing.
    /// @return indexedDays The batch's day-index progress after this page.
    function materializeTransportBatchPage(
        LibVaipakam.Storage storage s,
        bytes32 batchId,
        uint256[] calldata dayIds
    ) internal returns (uint32 indexedDays) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        if (b.admitted == 0) revert IVaipakamErrors.TransportBatchUnknown(batchId);
        uint32 done = b.indexedDays;
        if (done >= b.dayCount) revert IVaipakamErrors.TransportBatchFullyIndexed(batchId);
        // The batch's key IS its packet's stamp, so the commitment is read
        // through `batchId` directly.
        bytes32 committed = s.ingressPackets[batchId].dayListHash;
        bytes32 supplied = keccak256(abi.encode(dayIds));
        if (supplied != committed) {
            revert IVaipakamErrors.TransportDayListMismatch(batchId, committed, supplied);
        }
        uint256 end = uint256(done) + TRANSPORT_INDEX_PAGE;
        if (end > dayIds.length) end = dayIds.length;
        for (uint256 i = done; i < end; ++i) {
            // A day's index is a MEMBERSHIP SET, and a batch's POSITION in it
            // carries no meaning (Codex #2232 r3). Materialization is
            // permissionless and asynchronous, so which batch reaches a day
            // first is decided by caller timing; an append therefore cannot
            // be, and never was, an ordering. The order a preparer's
            // "oldest on ties" default needs is the delivery's own arrival —
            // `ingressPackets[batchId].arrivedAt`, written once by the ingress
            // that received it, immutable, and returned alongside every entry
            // by {RewardEpochFacet.getTransportDayBatches} so it is read
            // rather than inferred. That key is correct for a RETROSPECTIVE
            // admission too, which an append order could not be: a rollout
            // packet is admitted long after it arrived, and its true arrival
            // is what the record holds.
            s.transportBatchesByDay[dayIds[i]].push(batchId);
        }
        indexedDays = uint32(end);
        b.indexedDays = indexedDays;
        emit TransportBatchPageIndexed(batchId, indexedDays, b.dayCount);
    }

    /// @notice #1566 transport epochs PR 3b — PARK what this batch's
    ///         obligations left, under the batch's own key, with the
    ///         membership that still binds it.
    /// @dev    Parking is the first half of the release (§5c). It does not
    ///         make the packet classifiable on its own: an operator could
    ///         otherwise make a packet classifiable merely by draining its
    ///         batch, so the ACKNOWLEDGMENT is what releases it.
    ///
    ///         The remainder stays MEMBERSHIP-BOUND — it carries the same flat
    ///         commitment 3a stamped on the packet — so a late obligation
    ///         whose day is in this list can still restore against it after
    ///         the index itself has been retired, rather than finding the
    ///         value in a general pool it has no claim on.
    ///
    ///         An incompletely indexed batch is refused: until its whole
    ///         membership exists, what its obligations may still reach is not
    ///         known, and a remainder parked now would name a filter the
    ///         batch had not finished acquiring.
    ///
    ///         There is NO "the obligations are finished" test here, and in
    ///         3b-i there is nothing for one to test: no draw exists, so no
    ///         obligation can hold a claim on a batch. §5c's rule that a batch
    ///         with outstanding STAGING REFERENCES cannot be retired belongs
    ///         with the staging that creates them, in 3b-ii, and lands on this
    ///         function when it does.
    function parkTransportRemainder(
        LibVaipakam.Storage storage s,
        bytes32 batchId
    ) internal returns (uint256 amount) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        if (b.admitted == 0) revert IVaipakamErrors.TransportBatchUnknown(batchId);
        if (b.indexedDays < b.dayCount) {
            revert IVaipakamErrors.TransportBatchNotFullyIndexed(batchId, b.indexedDays, b.dayCount);
        }
        LibVaipakam.TransportRemainder storage rem = s.transportRemainders[batchId];
        if (rem.batchId != bytes32(0)) revert IVaipakamErrors.TransportRemainderAlreadyParked(batchId);
        LibVaipakam.IngressPacket storage p = s.ingressPackets[batchId];
        amount = b.balance;
        rem.batchId = batchId;
        rem.amount = amount;
        rem.dayListHash = p.dayListHash;
        rem.dayCount = b.dayCount;
        b.balance = 0;
        emit TransportRemainderParked(batchId, amount, rem.dayListHash);
    }

    /// @notice #1566 transport epochs PR 3b — record the acknowledgment that
    ///         RELEASES a batch, so what remains of its packet becomes
    ///         classifiable.
    /// @dev    The second half of the release, and the whole of the gate:
    ///         after this, {packetBatchReleased} answers yes for the batch's
    ///         packet and {authenticatedFresh} derives the classification's
    ///         bound from the packet's immutable attested caps NET of what the
    ///         batch's own transport legs already spent.
    function acknowledgeTransportRemainder(
        LibVaipakam.Storage storage s,
        bytes32 batchId
    ) internal {
        LibVaipakam.TransportRemainder storage rem = s.transportRemainders[batchId];
        if (rem.batchId == bytes32(0)) revert IVaipakamErrors.TransportRemainderNotParked(batchId);
        if (rem.acknowledged) revert IVaipakamErrors.TransportRemainderAlreadyAcknowledged(batchId);
        rem.acknowledged = true;
        s.transportBatches[batchId].released = true;
        emit TransportBatchReleased(batchId, rem.amount);
    }

    /// @notice #1566 transport epochs PR 3b — admit a classification against an
    ///         old-wire packet AND step its batch's parked remainder down by
    ///         what the classification takes.
    /// @dev    ONE function, because the gate and the debit are one rule
    ///         (Codex #2232 r1). An earlier revision gated classification on
    ///         the release and left the remainder alone: parking 10 and
    ///         classifying 4 left the entry still reporting 10, so the
    ///         membership-bound restore and the operator dispositions 3b-ii
    ///         adds would have treated already-classified value as still
    ///         parked — two claims on one amount. Design §5c says a
    ///         classification debits the batch-keyed pending entry rather than
    ///         the transport balance, and it can only be relied on if there is
    ///         no way to do the one without the other.
    ///
    ///         The BOUND falls out of the same arithmetic: a classification
    ///         can never take more than the remainder holds. That is a second,
    ///         independent ceiling on top of the packet's own `unclassified`
    ///         figure — in 3b-i the two are equal by construction, and where a
    ///         later disposition makes them differ the stricter one binds,
    ///         which is the conservative direction.
    ///
    ///         IN 3b-i THE RELEASED BRANCH IS UNREACHABLE, and that is worth
    ///         stating here rather than only at the door (#2258, owner
    ///         decision 2026-09-20; Codex #2232 r10). Both of
    ///         {RewardEpochFacet}'s release entries revert
    ///         `TransportReleaseNotYetAvailable` for every caller, so no batch
    ///         is ever `released` and every packet holding one is refused
    ///         below by `TransportBatchNotReleased` — BEFORE the split is ever
    ///         consulted. The honest description of this cut is therefore that
    ///         an epoch-holding packet is WHOLLY unclassifiable, not that it
    ///         "classifies recycled only": the fresh-versus-recycled question
    ///         is never reached. Nothing leaves the holder; the value stays
    ///         membership-bound until 3b-ii opens the door.
    ///
    ///         A packet with NO batch passes untouched and is debited nothing:
    ///         the rule is about value held in a transport epoch, and a d5
    ///         delivery, a pre-3b arrival, and a delivery that landed before
    ///         custody was activated all hold none.
    ///
    ///         "No batch" is NOT "no batch YET" (Codex #2232 r4). A 3a-to-3b
    ///         packet carries a day-list commitment and holds no batch only
    ///         until somebody calls the permissionless rollout admission — so
    ///         reading a zero `batchId` as "pre-ledger" let an administrator
    ///         classify exactly that population's remainder away with no
    ///         release and no debit, which is the bypass this gate exists to
    ///         close. The two cases are told apart by the ONE predicate the
    ///         admission itself uses, {rolloutAdmissionStatus}: a packet it
    ///         still calls admissible must be admitted and released first, and
    ///         is refused here by name. A packet it refuses can never hold an
    ///         epoch, and that is the shortcut's real precondition.
    function takeFromReleasedRemainder(
        LibVaipakam.Storage storage s,
        bytes32 packetHash,
        uint256 amount
    ) internal {
        LibVaipakam.IngressPacket storage packet = s.ingressPackets[packetHash];
        bytes32 batchId = packet.batchId;
        if (batchId == bytes32(0)) {
            if (rolloutAdmissionStatus(packet) == ROLLOUT_ADMISSIBLE) {
                revert IVaipakamErrors.TransportBatchNotAdmitted(packetHash);
            }
            return;
        }
        if (!s.transportBatches[batchId].released) {
            revert IVaipakamErrors.TransportBatchNotReleased(packetHash, batchId);
        }
        LibVaipakam.TransportRemainder storage rem = s.transportRemainders[batchId];
        uint256 available = rem.amount;
        if (amount > available) {
            revert IVaipakamErrors.TransportRemainderExceeded(batchId, amount, available);
        }
        uint256 left = available - amount;
        rem.amount = left;
        // #1566 transport epochs PR 3b (Codex #2232 r3) — record the EXIT, not
        // only the new balance. `amount` falling is what happened; `debited`
        // is what left, and it is the term that keeps the epoch's conservation
        // identity closed (`admitted == balance + parked + debited`) once a
        // classification has taken from it. Without it the identity is false
        // the moment this line first runs, which is a ledger that reconciles
        // only while it is untouched.
        rem.debited += amount;
        emit TransportRemainderDebited(batchId, amount, left);
    }

    /// @notice #1566 transport epochs PR 3b — the day-list fan-out bound, in
    ///         ONE place.
    /// @dev    Called by the remittance SEND and by its fee QUOTE (Codex #2232
    ///         r1). The quote is documented as a faithful dry run of the send,
    ///         and a bound that lived only on the send let it price a batch the
    ///         send was guaranteed to refuse — a keeper acting on a fee for an
    ///         impossible operation. This is the second time a quote drifted
    ///         from its send in this programme (#2224 r6 was the split
    ///         attestation's), so the rule gets one implementation both reach
    ///         rather than a copy each, and the divergence stops being
    ///         something to remember.
    function requireRemittableFanout(uint256 dayCount) internal pure {
        if (dayCount > TRANSPORT_DAY_FANOUT_CAP) {
            revert IVaipakamErrors.TransportDayFanoutExceeded(dayCount, TRANSPORT_DAY_FANOUT_CAP);
        }
    }

    /// @notice #1566 transport epochs PR 3a — the canonical chain's recorded
    ///         split of a d2 remittance, carried by the transport's SPLIT
    ///         ATTESTATION and persisted ONCE as the packet's two attested
    ///         caps, scaled to what actually landed by the same proportional
    ///         flooring the d5 receiver applies (§5c: the caps are denominated
    ///         in the destination-observed basis, so a short delivery shrinks
    ///         both and can never leave one larger than the whole).
    /// @dev    The packet is resolved through the receipt its delivery wrote.
    ///         Refused, each refusal re-executable and writing nothing: an
    ///         unknown receipt, a receipt whose delivery came from a chain
    ///         other than the attesting one, a receipt with no packet (the
    ///         delivery predates packet stamping), a packet whose own wire
    ///         carried the split, an empty split, and a second attestation.
    ///         Nothing here touches `freshAuthenticated` — the bound a
    ///         classification reads is derived by {authenticatedFresh}.
    function attestPacketSplit(
        LibVaipakam.Storage storage s,
        uint32 sourceChainId,
        address remitter,
        uint256 remitId,
        uint256 fresh,
        uint256 recycled
    ) internal returns (bytes32 h, uint256 freshAttested, uint256 recycledAttested) {
        // The RECEIVING-DOMAIN rule (Codex #2224 r6): messenger authentication
        // proves the message came from a configured peer, never that the peer
        // is the legitimate source for this kind. Only the canonical chain
        // records the split an attestation carries, so only the canonical
        // chain may assert one — otherwise an extra or stale peer, with a
        // receipt of its own delivery to point at, could decide this packet's
        // fresh and recycled caps the moment 3b makes them usable. Checked
        // HERE, beside the receipt rules, so a future caller cannot reach the
        // write without it.
        if (sourceChainId != s.baseChainId) {
            revert IVaipakamErrors.SplitAttestationNotFromBase(sourceChainId, uint32(s.baseChainId));
        }
        LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[remitReceiptKey(remitter, remitId)];
        if (rec.receivedAt == 0) revert IVaipakamErrors.ReceivedRemitNotFound(remitId);
        if (rec.srcChainId != sourceChainId) revert IVaipakamErrors.ReceivedRemitStale(remitId, rec.srcChainId);
        h = rec.packetHash;
        if (h == bytes32(0)) revert IVaipakamErrors.IngressReceiptHasNoPacket(remitId);
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        if (p.freshShare + p.recycledShare != 0) revert IVaipakamErrors.IngressPacketAlreadyTyped(h);
        uint256 total = fresh + recycled;
        if (total == 0) revert IVaipakamErrors.SplitAttestationEmpty(remitId);
        uint256 actual = p.actualReceived;
        freshAttested = (fresh * actual) / total;
        recycledAttested = (recycled * actual) / total;
        if (p.attested) {
            // An IDENTICAL retry is a no-op, not a failure (Codex #2224 r2).
            // The source entry is deliberately re-sendable — a caller who
            // cannot tell whether the first message landed retries it — and
            // the transport fee is paid up front and never refunded, so
            // rejecting a repeat of the same record would make the retry lever
            // a fee-burning trap. What stays refused is a DIVERGENT second
            // record: the first attestation is the source's, and a differing
            // one is a faulty or compromised source, never a correction.
            if (p.freshAttested != freshAttested || p.recycledAttested != recycledAttested) {
                revert IVaipakamErrors.IngressPacketAlreadyAttested(h);
            }
            return (h, freshAttested, recycledAttested);
        }
        p.freshAttested = freshAttested;
        p.recycledAttested = recycledAttested;
        p.attested = true;
        emit IngressPacketSplitAttested(h, remitter, remitId, freshAttested, recycledAttested);
    }

    /// @notice Record a packet as it LANDED (one record per stamp; a second
    ///         landing under the same stamp is refused whole) and write the
    ///         receipt it creates, if any, bound to the stamp (one packet
    ///         per receipt; a second packet under an existing receipt is
    ///         refused whole).
    /// @return h The packet's stamp.
    function recordIngressPacket(
        LibVaipakam.Storage storage s,
        uint256 sourceChainId,
        bytes32 transportMessageId,
        uint8 kind,
        uint256 actualReceived,
        uint256 freshShare,
        uint256 recycledShare,
        address remitter,
        uint256 remitId
    ) internal returns (bytes32 h) {
        h = allocatePacketHash(s, sourceChainId, transportMessageId);
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        if (p.arrivedAt != 0) revert IVaipakamErrors.IngressPacketReplayed(h);
        p.sourceChainId = SafeCast.toUint32(sourceChainId);
        p.kind = kind;
        p.arrivedAt = uint64(block.timestamp);
        p.remitter = remitter;
        p.remitId = remitId;
        p.actualReceived = actualReceived;
        p.freshShare = freshShare;
        p.recycledShare = recycledShare;
        // The receipt a delivery creates on a MIRROR (kinds 1 and 2) —
        // `(srcChainId, receivedAt, amount, remitter)`, bound to the stamp —
        // is written here with the record, so the ingress facet at EIP-170
        // budget pays one call for both. A receipt is delivered ONCE (Codex
        // #2198 r1): the remitter's reservation dispatches one packet, so a
        // second packet under an existing receipt — a distinct transport
        // message, past the stamp guard — is a faulty or compromised
        // remitter and refuses whole (re-executable, like every ingress
        // refusal). That is what makes every receipt-keyed figure — the
        // stranded record's held part, the R4 return's per-packet
        // step-down — describe exactly one packet. (The two ingresses kept
        // the FIRST receipt silently before this PR, on the reasoning that
        // CCIP executes a message once; the stamp guard now covers that
        // case and this guard covers the remitter.) A stranded return
        // (kind 3) lands on the canonical chain and creates no receipt.
        if (remitId != 0 && remitter != address(0) && kind <= PACKET_KIND_COMPENSATION) {
            bytes32 key = remitReceiptKey(remitter, remitId);
            LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[key];
            if (rec.receivedAt != 0) revert IVaipakamErrors.IngressReceiptAlreadyDelivered(key);
            rec.srcChainId = p.sourceChainId;
            rec.receivedAt = uint64(block.timestamp);
            rec.amount = actualReceived;
            rec.remitter = remitter;
            rec.packetHash = h;
        }
        emit IngressPacketRecorded(h, sourceChainId, kind, actualReceived, remitter, remitId);
    }

    /// @notice The uncounted remainder of a delivery, PROTECTED AT INGRESS:
    ///         relocated (measured) from the Diamond into the `Unclassified`
    ///         row and counted for the packet.
    function unclassifiedIngress(LibVaipakam.Storage storage s, bytes32 h, uint256 amount) internal {
        if (amount == 0) return;
        relocateToHolder(s, LibVaipakam.RewardCustodyRow.Unclassified, amount);
        s.rewardCustodyUnclassifiedUncounted += amount;
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        p.unclassified += amount;
        p.protectedCumulative += amount;
        emit RewardCustodyUnclassifiedCredited(h, p.kind, amount);
    }

    /// @notice A quarantined compensation into the row — `relocate` for a
    ///         quarantine landing (tokens at the Diamond, relocated
    ///         measured), `uncredit` for a demotion (the credit's remainder
    ///         re-attributed in-holder) — with the stranded record and the
    ///         reservation told how much of them the holder now backs.
    /// @return got What entered the row.
    function unclassifiedQuarantine(
        LibVaipakam.Storage storage s,
        bytes32 h,
        bytes32 receiptKey,
        uint256 relocate,
        uint256 uncredit
    ) internal returns (uint256 got) {
        if (relocate != 0) {
            relocateToHolder(s, LibVaipakam.RewardCustodyRow.Unclassified, relocate);
            got = relocate;
        }
        if (uncredit != 0) got += uncreditFreshInHolder(s, uncredit);
        if (got == 0) return 0;
        LibVaipakam.StrandedRecovery storage sr = s.strandedRecoveries[receiptKey];
        sr.held += got;
        // The record's packet: a receipt is delivered once (see
        // `recordIngressPacket`), and a demotion passes the receipt's own
        // stamp, so every call for one receipt carries the same `h` — the
        // landing's, or zero for a receipt that predates the stamp.
        if (sr.packetHash == bytes32(0)) sr.packetHash = h;
        s.strandedRecoveryReservedHeld += got;
        s.rewardCustodyUnclassifiedUncounted += got;
        if (h != bytes32(0)) {
            LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
            p.unclassified += got;
            p.protectedCumulative += got;
        }
        emit RewardCustodyUnclassifiedCredited(h, PACKET_KIND_COMPENSATION, got);
    }

    /// @notice A stranded return for a receipt that PREDATES recovery
    ///         attribution: relocated (measured) into the row and counted as
    ///         returned custody — attributable to no position, visible,
    ///         never spendable as fresh.
    function unclassifiedReturn(LibVaipakam.Storage storage s, bytes32 h, uint256 amount) internal {
        if (amount == 0) return;
        relocateToHolder(s, LibVaipakam.RewardCustodyRow.Unclassified, amount);
        s.rewardCustodyUnclassifiedReturned += amount;
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        p.unclassified += amount;
        p.protectedCumulative += amount;
        emit RewardCustodyUnclassifiedCredited(h, p.kind, amount);
    }

    /// @notice The R4 return's draw on the row: the stranded record's held
    ///         value leaves the `Unclassified` row for the return sender,
    ///         measured, and every figure that described it there steps
    ///         down with it.
    /// @dev    #1566 transport epochs PR 3b — THIS DOOR CONSULTS NO BATCH,
    ///         and must not need to. It reduces `p.unclassified` outside the
    ///         epoch gate, so a packet holding both an epoch and a stranded
    ///         record would end a return with its `admitted` anchor over
    ///         value that has gone home: a remainder that can never be
    ///         debited down, and in 3b-ii a listed day drawing on a balance
    ///         that is not there.
    ///
    ///         The two cannot meet, and the reason is INCIDENTAL to this
    ///         ledger rather than declared by it, which is why it is written
    ///         here. A record binds to a packet only through
    ///         {unclassifiedQuarantine}, whose two call sites both pass a
    ///         COMPENSATION packet's stamp; and the compensation ingress
    ///         records its whole amount as the fresh component, which
    ///         {rolloutAdmissionStatus} refuses permanently as
    ///         `ROLLOUT_WIRE_TYPED` while the live admission never runs on a
    ///         compensation at all. So the exclusion rests on the INGRESS's
    ///         choice of component, not on anything the epoch ledger
    ///         enforces: record a compensation untyped and this door opens
    ///         silently. `test_FourthDoor_CannotReachAPacketHoldingAnEpoch`
    ///         is what fails when it does.
    function releaseUnclassifiedForReturn(
        LibVaipakam.Storage storage s,
        bytes32 receiptKey,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.StrandedRecovery storage sr = s.strandedRecoveries[receiptKey];
        uint256 held = sr.held;
        if (amount > held) revert IVaipakamErrors.RewardCustodyUnclassifiedHeldShort(receiptKey, amount, held);
        sr.held = held - amount;
        s.strandedRecoveryReservedHeld -= amount;
        s.rewardCustodyUnclassifiedUncounted -= amount;
        // The record's packet is THE packet — a receipt is delivered once
        // (`recordIngressPacket` refuses a second packet under it) and a
        // demotion re-attributes under the receipt's own stamp — so its
        // per-packet figure was credited in lockstep with the record's held
        // part and steps down with it EXACTLY (Codex #2198 r1: a saturating
        // step-down here would hide a broken lockstep instead of surfacing
        // it). A record whose receipt predates the stamp has no packet and
        // no per-packet figure to step.
        bytes32 h = sr.packetHash;
        if (h != bytes32(0)) {
            LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
            p.unclassified -= amount;
            // The fourth door (#1566 closure 2 cutover PR 2, design §5c): a
            // repatriation exhausts the packet's classifiable remainder in
            // the same act, recorded as a NON-classification exit.
            p.disposed += amount;
        }
        releaseFromRow(s, LibVaipakam.RewardCustodyRow.Unclassified, to, amount);
        emit RewardCustodyUnclassifiedReleased(h, to, amount);
    }

    // ─── The legacy reconciliation epoch (#1566 closure 2 cutover PR 2) ──────
    //
    // The classification EXITS of the `Unclassified` row and the custody
    // side of a reclassification, in-holder, under the deficit split
    // (design §5c, "classification is an IN-HOLDER reattribution —
    // unclassified → fresh, recycled, OR restitution"). The row's figures
    // step down EXACTLY, the way the R4 return steps them down, so
    // `Unclassified == uncounted + returned` holds after every exit; the
    // packet's per-component exits accumulate so its identity
    // `unclassified + classifiedFresh + classifiedRecycled + disposed ==
    // protectedCumulative` holds too. The bucket side of a recycled exit is
    // `LibVpfiRecycle`'s (it owns the bucket's counters); the entry logic —
    // the evidence bound, the FIFO — is the reconciliation facet's.

    /// @notice A classification's step-down: the packet's remainder and the
    ///         row figure it belongs to (uncounted for a delivery or
    ///         compensation, returned for a stranded return or ceremony
    ///         inflow) fall by the entry's total, the packet's components
    ///         rise by their shares, and — for a delivery or compensation —
    ///         the global uncounted aggregate falls too (design §5c step 1;
    ///         a different counter from the holder figure, which the R4
    ///         returns have already let diverge). Every figure is exact:
    ///         a shortfall names itself rather than saturating.
    function takeFromUnclassified(
        LibVaipakam.Storage storage s,
        bytes32 h,
        uint256 freshShare,
        uint256 recycledShare
    ) internal {
        uint256 total = freshShare + recycledShare;
        LibVaipakam.IngressPacket storage p = s.ingressPackets[h];
        if (total > p.unclassified) {
            revert IVaipakamErrors.ReconciliationExceedsPacketRemainder(h, total, p.unclassified);
        }
        p.unclassified -= total;
        p.classifiedFresh += freshShare;
        p.classifiedRecycled += recycledShare;
        if (p.kind <= PACKET_KIND_COMPENSATION) {
            uint256 have = s.rewardCustodyUnclassifiedUncounted;
            if (total > have) revert IVaipakamErrors.ReconciliationFigureShort(0, total, have);
            s.rewardCustodyUnclassifiedUncounted = have - total;
            uint256 aggregate = s.rewardBudgetFreshUncounted;
            if (total > aggregate) revert IVaipakamErrors.ReconciliationFigureShort(2, total, aggregate);
            s.rewardBudgetFreshUncounted = aggregate - total;
        } else {
            uint256 have = s.rewardCustodyUnclassifiedReturned;
            if (total > have) revert IVaipakamErrors.ReconciliationFigureShort(1, total, have);
            s.rewardCustodyUnclassifiedReturned = have - total;
        }
    }

    /// @notice Credit `amount` as FRESH out of `from` (the `Unclassified` row
    ///         for a classification, the `Recycled` row for a
    ///         reclassification into fresh): the received side rises and the
    ///         tokens move in-holder under the deficit split — the absorbed
    ///         portion to restitution, only the excess to live backing.
    ///         The in-holder form of {creditFreshIngress}, same split.
    function creditFreshFromRow(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow from,
        uint256 amount
    ) internal returns (uint256 toLive, uint256 toRestitution) {
        if (amount == 0) return (0, 0);
        (toLive, toRestitution) = freshSplit(s, amount);
        uint256 received = s.rewardBudgetArmedFreshReceived;
        s.rewardBudgetArmedFreshReceived = received + amount;
        move(s, from, LibVaipakam.RewardCustodyRow.LiveFresh, toLive);
        move(s, from, LibVaipakam.RewardCustodyRow.Restitution, toRestitution);
        emit RewardCustodyFreshCredited(amount, toLive, toRestitution, received + amount);
    }

    /// @notice A reclassification's UNSPENT fresh credit leaving for `to`
    ///         (the `Recycled` row): the received side falls by exactly
    ///         `amount` and the tokens move from the LIVE row — never from
    ///         restitution, whose custody moves only through its own
    ///         dispositions (design §5c, "a correction is not a back door
    ///         out of the restitution position"). What is unspent is, by
    ///         derivation, what the live row still backs; the move names
    ///         the row if it cannot cover.
    function debitFreshFromLive(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        // Codex #2206 r6 — what an armed day reserved (`outstandingCommitFresh`)
        // stays in the row for its claims: the fresh twin of the
        // uncommitted-bucket bound on the other direction.
        uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        uint256 reserved = s.outstandingCommitFresh;
        uint256 uncommitted = live > reserved ? live - reserved : 0;
        if (amount > uncommitted) revert IVaipakamErrors.ReconciliationExceedsUncommittedLive(amount, uncommitted);
        uint256 received = s.rewardBudgetArmedFreshReceived;
        if (amount > received) revert IVaipakamErrors.ReconciliationReceivedShort(amount, received);
        s.rewardBudgetArmedFreshReceived = received - amount;
        move(s, LibVaipakam.RewardCustodyRow.LiveFresh, to, amount);
    }

    /// @notice A corrected SPENT fresh split moves its historical debit to
    ///         the recycled side's consumed accounting: `received` and
    ///         `paid` fall together (the headroom aggregate takes the
    ///         registered corrective debit), the live row unchanged, no
    ///         custody moved — the tokens left long ago. NO sequencing
    ///         counter moves (design §5c, "the ordering counter only ever
    ///         grows"; Codex #2206 r1): the moved units are spent on the
    ///         other side by the entry's own inherited figure.
    function inheritFreshDebitAsRecycled(LibVaipakam.Storage storage s, uint256 amount) internal {
        if (amount == 0) return;
        uint256 received = s.rewardBudgetArmedFreshReceived;
        if (amount > received) revert IVaipakamErrors.ReconciliationReceivedShort(amount, received);
        uint256 paid = s.rewardBudgetArmedFreshPaid;
        if (amount > paid) revert IVaipakamErrors.ReconciliationPaidShort(amount, paid);
        s.rewardBudgetArmedFreshReceived = received - amount;
        s.rewardBudgetArmedFreshPaid = paid - amount;
    }

    /// @notice The reverse: a corrected SPENT recycled split's debit is
    ///         inherited by the fresh side — `received` and `paid` rise
    ///         together, the live row unchanged, no sequencing counter
    ///         moved: the moved-in units sit at the entry's original
    ///         position and are spent there by its inherited figure, so a
    ///         round trip restores the entry's original spent-ness instead
    ///         of counting one historical outflow twice (Codex #2206 r1).
    function inheritRecycledDebitAsFresh(LibVaipakam.Storage storage s, uint256 amount) internal {
        if (amount == 0) return;
        s.rewardBudgetArmedFreshReceived += amount;
        s.rewardBudgetArmedFreshPaid += amount;
    }

    // ─── Cross-facet entry (every facet but RewardCustodyFacet and the vault
    //     credit) ───────────────────────────────────────────────────────────
    //
    // The implementation above inlines into whichever facet calls it, and
    // the reward paths that need it — the claim, the two remittance facets,
    // the fee doors on the loan and offer facets — sit at or near the
    // EIP-170 budget. So a facet other than `RewardCustodyFacet` reaches a
    // custody MUTATION through the Diamond's own fallback into the custody
    // facet's Diamond-internal entry points (the same cross-facet self-call
    // the vault credit uses), paying one ABI encode and one call instead of
    // the whole implementation. Reads stay inline — they are a storage load.
    // Each proxy bubbles the callee's typed revert unchanged, so a refusal
    // surfaces exactly as it would have inline.

    /// @dev Bubbles the callee's revert data unchanged. The assembly is
    ///      annotated memory-safe (it only reads an allocated `bytes`), so
    ///      inlining this into a facet at the viaIR stack ceiling keeps that
    ///      facet's memory guard — the shared `LibRevert` bubbler is not
    ///      annotated, and pulling it into `RewardClaimFacet` cost the claim
    ///      its stack.
    function _custody(bytes memory data) private {
        (bool ok, bytes memory ret) = address(this).call(data);
        if (ok) return;
        if (ret.length == 0) revert IVaipakamErrors.RewardCustodyCallFailed();
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    /// @dev {relocateToHolder} through the custody facet.
    function callRelocateToHolder(LibVaipakam.RewardCustodyRow r, uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyRelocateToRow(uint8,uint256)", uint8(r), amount));
    }

    /// @dev {move} through the custody facet.
    function callMove(
        LibVaipakam.RewardCustodyRow from,
        LibVaipakam.RewardCustodyRow to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyMove(uint8,uint8,uint256)", uint8(from), uint8(to), amount));
    }

    /// @dev {relocateFreshIngress} through the custody facet.
    function callRelocateFreshIngress(uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyRelocateFreshIngress(uint256)", amount));
    }

    /// @dev Like {_custody}, returning the callee's data.
    function _custodyReturning(bytes memory data) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(this).call(data);
        if (ok) return ret;
        if (ret.length == 0) revert IVaipakamErrors.RewardCustodyCallFailed();
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    /// @dev {recordIngressPacket} through the custody facet.
    function callRecordIngressPacket(
        uint256 sourceChainId,
        bytes32 transportMessageId,
        uint8 kind,
        uint256 actualReceived,
        uint256 freshShare,
        uint256 recycledShare,
        address remitter,
        uint256 remitId
    ) internal returns (bytes32 h) {
        bytes memory ret = _custodyReturning(
            abi.encodeWithSignature(
                "custodyRecordIngressPacket(uint256,bytes32,uint8,uint256,uint256,uint256,address,uint256)",
                sourceChainId,
                transportMessageId,
                kind,
                actualReceived,
                freshShare,
                recycledShare,
                remitter,
                remitId
            )
        );
        h = abi.decode(ret, (bytes32));
    }

    /// @dev {unclassifiedIngress} through the custody facet.
    function callUnclassifiedIngress(bytes32 h, uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyUnclassifiedIngress(bytes32,uint256)", h, amount));
    }

    /// @dev {unclassifiedQuarantine} through the custody facet.
    function callUnclassifiedQuarantine(bytes32 h, bytes32 receiptKey, uint256 relocate, uint256 uncredit) internal {
        if (relocate + uncredit == 0) return;
        _custody(
            abi.encodeWithSignature(
                "custodyUnclassifiedQuarantine(bytes32,bytes32,uint256,uint256)", h, receiptKey, relocate, uncredit
            )
        );
    }

    /// @dev {unclassifiedReturn} through the custody facet.
    function callUnclassifiedReturn(bytes32 h, uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyUnclassifiedReturn(bytes32,uint256)", h, amount));
    }

    /// @dev {releaseUnclassifiedForReturn} through the custody facet.
    function callReleaseUnclassifiedForReturn(bytes32 receiptKey, address to, uint256 amount) internal {
        if (amount == 0) return;
        _custody(
            abi.encodeWithSignature(
                "custodyReleaseUnclassifiedForReturn(bytes32,address,uint256)", receiptKey, to, amount
            )
        );
    }

    /// @dev {takeRecycled} through the reconciliation facet — the bucket
    ///      ledger's debit primitives live in facets at the EIP-170 budget,
    ///      and the queue machinery lives with the epoch that owns it.
    function callTakeRecycled(
        uint256 bucketBefore,
        uint256 amount,
        bool consumption,
        bool mustComplete,
        uint256 remitId
    ) internal returns (uint256 took) {
        bytes memory ret = _custodyReturning(
            abi.encodeWithSignature(
                "reconciliationTakeRecycled(uint256,uint256,bool,bool,uint256)",
                bucketBefore,
                amount,
                consumption,
                mustComplete,
                remitId
            )
        );
        took = abi.decode(ret, (uint256));
    }

    /// @dev The released remit's take reversed through the reconciliation
    ///      facet ({RewardReconciliationFacet.reconciliationReverseRemitTake}):
    ///      every record it wrote, and the inheritance a correction had
    ///      meanwhile made of it, undone.
    function callReverseRemitTake(uint256 remitId) internal {
        _custody(abi.encodeWithSignature("reconciliationReverseRemitTake(uint256)", remitId));
    }

    /// @dev {releaseFromRow} through the custody facet.
    function callReleaseFromRow(LibVaipakam.RewardCustodyRow r, address to, uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyReleaseFromRow(uint8,address,uint256)", uint8(r), to, amount));
    }

    /// @dev The two-row wallet payout through the custody facet: live-fresh
    ///      by `fresh`, recycled by `recycled`, released to `to`.
    function callPayoutToWallet(address to, uint256 fresh, uint256 recycled) internal {
        if (fresh + recycled == 0) return;
        _custody(abi.encodeWithSignature("custodyPayoutToWallet(address,uint256,uint256)", to, fresh, recycled));
    }

    /// @dev {drawForTransport} through the custody facet; returns the total
    ///      released to the Diamond (the amount to approve to the messenger).
    ///      A no-op returning the total while not activated.
    function callDrawForTransport(
        LibVaipakam.Storage storage s,
        TransportDraw memory draw
    ) internal returns (uint256 total) {
        total = draw.fresh + draw.recycled;
        if (!active(s) || total == 0) return total;
        _custody(
            abi.encodeWithSignature(
                "custodyDrawForTransport(uint8,uint256,uint256)", uint8(draw.source), draw.fresh, draw.recycled
            )
        );
    }

    // ─── Transports ─────────────────────────────────────────────────────────

    /// @notice Draw a transport's tokens out of the named custody into the
    ///         Diamond, where the messenger pulls them in the same
    ///         transaction. No-op (today's Diamond-balance path) while not
    ///         activated. The delivered charge for a `Live` draw is the
    ///         caller's, taken BEFORE this — it is the ledger half of the
    ///         same act, and lives with the ledger.
    /// @return total What was released to the Diamond — the amount the
    ///         caller approves to the messenger.
    function drawForTransport(
        LibVaipakam.Storage storage s,
        TransportDraw memory draw
    ) internal returns (uint256 total) {
        total = draw.fresh + draw.recycled;
        if (!active(s) || total == 0) return total;
        (address holder, address token) = boundHolderAndToken(s);
        if (draw.source == TransportSource.Recovery) {
            debit(s, LibVaipakam.RewardCustodyRow.Recovery, total, address(this));
        } else {
            debit(s, LibVaipakam.RewardCustodyRow.LiveFresh, draw.fresh, address(this));
            debit(s, LibVaipakam.RewardCustodyRow.Recycled, draw.recycled, address(this));
        }
        releaseMeasured(token, holder, address(this), total);
    }
}
