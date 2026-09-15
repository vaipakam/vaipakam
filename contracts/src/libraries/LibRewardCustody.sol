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
    uint32 internal constant CUTOVER_VERSION = 1;

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

    /// @dev #1566 closure 2 cutover PR 2 (Codex #2206 r4) — the legacy
    ///      reconciliation epoch's SPENT-NESS, recorded here at the one row
    ///      primitive every outflow passes through, so no writer of a pool
    ///      has to know about the queue and no balance is ever read for it
    ///      afterwards: a later credit cannot un-spend an earlier entry, and
    ///      a refill cannot be consumed twice. What an outflow takes of the
    ///      classified queue is what the row's OTHER backing could not
    ///      cover — the other backing is consumed first, and `queued −
    ///      spent` is what the classified records still hold of the row —
    ///      never more than that. Two rows carry a queue here: the live row
    ///      (the fresh queue: spent, and paid where the outflow is a payout
    ///      of the fresh ledger's) and the restitution row (the absorbed
    ///      records: RELEASED — into the live queue as unspent when the
    ///      paid-correction moves them to live, as spent when the deficit
    ///      was paid with them). The recycled queue's pool is the BUCKET
    ///      LEDGER, whose row follows it: its record is written by the
    ///      ledger's own two debit primitives (`LibVpfiRecycle.consume`,
    ///      `debitRepatriationSurplus`) with the same take, so it is
    ///      recorded whether or not the tokens' release from the row is
    ///      paired in the same frame. The correction adjusts the queues
    ///      BEFORE it moves tokens, so its own move records nothing. Era 0
    ///      until slice 4 PR C's rows.
    function _recordOutflow(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow r,
        uint256 have,
        uint256 amount,
        bool paid,
        bool toLive
    ) private {
        if (r == LibVaipakam.RewardCustodyRow.LiveFresh) {
            uint256 queued = s.freshQueuedTotalByEra[PRE_BACKFILL_ERA] + s.freshReleasedTotal;
            uint256 spent = s.freshSpentTotalByEra[PRE_BACKFILL_ERA];
            uint256 took = takeOfQueue(queued, spent, have, amount);
            if (took == 0) return;
            s.freshSpentTotalByEra[PRE_BACKFILL_ERA] = spent + took;
            if (paid) s.freshPaidTotalByEra[PRE_BACKFILL_ERA] += took;
        } else if (r == LibVaipakam.RewardCustodyRow.Restitution) {
            uint256 released = s.freshReleasedTotal;
            uint256 took = takeOfQueue(s.freshAbsorbedTotal, released, have, amount);
            if (took == 0) return;
            s.freshReleasedTotal = released + took;
            if (toLive) return;
            s.freshSpentTotalByEra[PRE_BACKFILL_ERA] += took;
            if (paid) s.freshPaidTotalByEra[PRE_BACKFILL_ERA] += took;
        }
    }

    /// @notice What an outflow of `amount` from a row holding `balance`
    ///         takes of a queue's still-unspent records: the row's other
    ///         backing (`balance − (queued − spent)`) goes first, and never
    ///         more than the records still hold.
    function takeOfQueue(
        uint256 queued,
        uint256 spent,
        uint256 balance,
        uint256 amount
    ) internal pure returns (uint256 took) {
        uint256 unspent = queued > spent ? queued - spent : 0;
        uint256 other = balance > unspent ? balance - unspent : 0;
        took = amount > other ? amount - other : 0;
        if (took > unspent) took = unspent;
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
            bytes32 receiptKey = keccak256(abi.encode(remitter, remitId));
            LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[receiptKey];
            if (rec.receivedAt != 0) revert IVaipakamErrors.IngressReceiptAlreadyDelivered(receiptKey);
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
