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
    /// @notice 3b-ii-A2 (#2305) — an in-holder HOLD: `amount` moved from `from`
    ///         into `to` against staging record `key`, credited to no one. Not a
    ///         payout, so the era queue is not told; a hold out of the live
    ///         fresh row is refused for exactly that reason.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyRowHeld(uint8 indexed from, uint8 indexed to, uint256 amount, bytes32 indexed key);
    /// @notice 3b-ii-A2 (#2305) — a hold returned: `amount` moved back from `from`
    ///         into `to`, the row it came from, for staging record `key`.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyRowHoldReleased(uint8 indexed from, uint8 indexed to, uint256 amount, bytes32 indexed key);

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
    /// @dev 3 since 3b-ii-A2 (#2305): a new holder-debiting settlement seam
    ///      (the staged record's pages), a vault-only delivery entry on the
    ///      custody facet, and the `Resolving` row in the attributed total —
    ///      an activation must see a custody cut that carries all three.
    uint32 internal constant CUTOVER_VERSION = 3;

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
        // Through the last row, `Resolving` included (3b-ii-A2, #2305): a hold
        // between resolution pages is attributed, never sweepable.
        uint256 last = uint256(LibVaipakam.RewardCustodyRow.Resolving);
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

    /// @notice 3b-ii-A2 (#2305) — HOLD `amount` of row `from` in row `to`
    ///         against staging record `key`: an in-holder move that pays no
    ///         one and tells the era queue nothing. The live fresh row is
    ///         refused as a source — every debit of it is a spend to its era
    ///         queue, so fresh is reserved by count, never held.
    function hold(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow from,
        LibVaipakam.RewardCustodyRow to,
        uint256 amount,
        bytes32 key
    ) internal {
        if (amount == 0) return;
        if (from == LibVaipakam.RewardCustodyRow.LiveFresh) {
            revert IVaipakamErrors.RewardCustodyHoldSourceInvalid(uint8(from));
        }
        _debitRow(s, from, amount);
        s.rewardCustodyRows[to] += amount;
        emit RewardCustodyRowHeld(uint8(from), uint8(to), amount, key);
    }

    /// @notice 3b-ii-A2 (#2305) — return a hold: `amount` back from `from`
    ///         into `to`, the row it was held out of, for record `key`.
    function releaseHold(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow from,
        LibVaipakam.RewardCustodyRow to,
        uint256 amount,
        bytes32 key
    ) internal {
        if (amount == 0) return;
        _debitRow(s, from, amount);
        s.rewardCustodyRows[to] += amount;
        emit RewardCustodyRowHoldReleased(uint8(from), uint8(to), amount, key);
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
    /// @notice The live fresh row less what staging records have reserved of
    ///         it (3b-ii-A2, #2305) — THE figure every mover of the row reads:
    ///         the claim gate's room ({LibVpfiRecycle.freshBackingRoom}), the
    ///         compensation demotion and the fresh-to-recycled correction
    ///         (Codex #2308 r5). Fresh is reserved by count, never held out of
    ///         the row, so the row alone overstates what may leave it.
    function liveFreshUnreserved(LibVaipakam.Storage storage s) internal view returns (uint256) {
        uint256 row = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        uint256 reserved = s.liveFreshReserved;
        return row > reserved ? row - reserved : 0;
    }

    /// @notice What a demotion or a correction may still UNCREDIT from the
    ///         delivered fresh ledger without leaving a standing reservation
    ///         unable to charge it (3b-ii-A2, #2305; Codex #2308 r5). While a
    ///         staging reservation stands, the ledger may not fall below
    ///         `paid + reserved`: a resolving record's last page charges
    ///         exactly its reserved figure, and the reservation was taken
    ///         against a bound that held. With none standing, the whole of
    ///         `received` may be uncredited, as before — a DEFICIT (paid
    ///         beyond received) is a modelled state the restitution machinery
    ///         exists for, and a reservation cannot be taken into one, since
    ///         the bound it needs is then zero. The role-gated bound the gates
    ///         read is {LibInteractionRewards.deliveredFreshBound}.
    function deliveredFreshUncreditable(LibVaipakam.Storage storage s) internal view returns (uint256) {
        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 reserved = s.rewardBudgetArmedFreshReserved;
        if (reserved == 0) return received;
        uint256 floor = s.rewardBudgetArmedFreshPaid + reserved;
        return received > floor ? received - floor : 0;
    }

    function uncreditFreshInHolder(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal returns (uint256 moved) {
        if (amount == 0) return 0;
        // What staging records have RESERVED of the live fresh — on the row
        // and on the delivered ledger — is unavailable to this demotion
        // (3b-ii-A2, #2305; Codex #2308 r5): a resolving record is irrevocable,
        // and its last page charges the ledger and debits the row by exactly
        // the reserved figures. Each bound reads the one figure its source
        // keeps; the ledger's keeps the deficit model where no reservation
        // stands ({deliveredFreshUncreditable}).
        uint256 cut = deliveredFreshUncreditable(s);
        if (cut > amount) cut = amount;
        s.rewardBudgetArmedFreshReceived -= cut;
        uint256 fromLive = liveFreshUnreserved(s);
        if (fromLive > amount) fromLive = amount;
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
    /// @notice #1566 transport epochs PR 3b-ii-A — an obligation on `dayId`
    ///         drew from this epoch: `fresh` covered a fresh-typed need and
    ///         `recycled` a recycled-typed one, both leaving the batch's
    ///         untyped balance (design §5c: the two legs of `transportPaid`).
    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);
    /// @notice #1566 transport epochs PR 3b-ii-A — a day's consumption cursor
    ///         moved past exhausted epochs at the front of its index.
    event TransportDayCursorAdvanced(uint256 indexed dayId, bytes32 cursor);
    /// @notice 3b-ii-A2 (#2305) — a staging record opened for (`user`, `side`,
    ///         `day`) under `key`, committed to `commitment`.
    /// @custom:event-category state-change/reward-staging
    event StagingRecordOpened(bytes32 indexed key, address indexed user, uint8 side, uint64 day, bytes32 commitment);
    /// @notice 3b-ii-A2 (#2305) — `fresh` / `recycled` of `batchId` moved from
    ///         its balance into staged form for record `key`: debited from
    ///         the batch, credited to no one.
    /// @custom:event-category state-change/reward-staging
    event TransportStaged(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);
    /// @notice 3b-ii-A2 (#2305) — record `key`'s deadline moved: only upward,
    ///         only while unexpired, only as the day's list grew.
    /// @custom:event-category state-change/reward-staging
    event StagingDeadlineSet(bytes32 indexed key, uint64 deadline);
    /// @notice A packet's split was attested and a classification it already
    ///         carried exceeds a component's recorded cap by these amounts
    ///         (Codex #2276 r15 P1) — a divergence recorded for the
    ///         correction path, not resolved here.
    event IngressPacketClassifiedBeyondCaps(bytes32 indexed packetHash, uint256 fresh, uint256 recycled);
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
    ///         A packet with NO batch answers zero directly, which is the
    ///         right answer for a packet that HAS none — and a packet holding
    ///         none is not the same population as a packet that can never hold
    ///         one (Codex #2232 r4/r15). Which packets can never hold one is
    ///         {rolloutAdmissionStatus}'s question and is not restated here:
    ///         a d5 delivery, a packet that arrived before 3a began recording
    ///         the day-list commitment, and one that arrived before reward
    ///         custody was activated on this deployment are all refused by
    ///         that predicate. An arrival between 3a and 3b carries the
    ///         commitment, IS owed an epoch, and reads zero here only until
    ///         somebody opens it — so a zero from this seam is never by itself
    ///         evidence that a packet is outside the ledger.
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
    ///         A packet with no batch answers NO, which is what keeps a packet
    ///         outside the ledger behaving exactly as it did. Outside the
    ///         ledger is decided by {rolloutAdmissionStatus} and not by when
    ///         the packet landed (Codex #2232 r4/r15): an arrival between 3a
    ///         and 3b carries the day-list commitment and is owed an epoch, so
    ///         it answers NO here only until the permissionless admission
    ///         opens one — a wait, not an exemption. A d5 packet also has
    ///         none, and never needs one: its components were typed on the
    ///         wire and credited to the shared ledgers at ingress, so it is
    ///         not attested and this predicate is never the thing standing
    ///         between it and a classification.
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
    ///         shapes, and it sizes the operations that WALK a batch's member
    ///         days: retirement clears at most 32, and `TRANSPORT_INDEX_PAGE`
    ///         below mirrors this constant so one materialization call indexes
    ///         at most 32. ADMISSION is not one of those operations and is not
    ///         what this cap sizes — it writes the compact batch row and no
    ///         per-day membership, for any batch, which is why every batch is
    ///         indexed afterwards.
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

    /// @notice #1566 transport epochs PR 3b-ii-A — how many of a day's indexed
    ///         epochs one coverage read, and the draw that follows it, scans.
    /// @dev    Twice the fan-out cap, so a day funded by one remittance a day
    ///         for two months is still read in one window. Past it the read
    ///         reports the cap HIT and the day primitive DEFERS the day rather
    ///         than pull era/live funding for a residual that unseen epochs
    ///         may cover — transport-first is not optional (§5c). 3b-ii-A
    ///         draws nothing on such a day, so there is nothing to stage or
    ///         unwind; 3b-ii-B's staging is what makes a wider day progress.
    uint256 internal constant TRANSPORT_DRAW_SCAN_CAP = 64;
    /// @dev How far back from a day's newest epoch an UNHINTED indexing call
    ///      may walk to find a late epoch's place (Codex #2276 r7 P2). Every
    ///      step is one read; past the cap the call refuses and the caller
    ///      names the predecessor instead, which inserts in constant work.
    uint256 internal constant TRANSPORT_INDEX_WALK_CAP = 128;
    /// @dev The `transportDayPrev` link of a node the day's cursor has PASSED
    ///      (Codex #2276 r12 P1). Nothing is ever placed before the cursor,
    ///      so the back-links of the passed prefix are never followed; the
    ///      value instead answers, in one read, whether a node is behind the
    ///      window — which is what lets a hint into the epochs after the
    ///      cursor be verified in constant work. Non-zero, so a passed node
    ///      still reads as listed. Never a batch id.
    bytes32 internal constant TRANSPORT_PASSED = bytes32(uint256(1));
    /// @dev How many epochs one TRANSACTION may draw from, over every day it
    ///      settles (Codex #2276 r14 P1, r15 P2). Each day's window is
    ///      bounded, but a claimant whose every day is funded by a window of
    ///      small epochs would write thousands of them in one transaction —
    ///      past any block — and, the chunk being fixed, could never
    ///      progress. A day whose draw would take the transaction past this
    ///      cap DEFERS, exactly as a day whose epochs exceed one window does:
    ///      nothing is drawn, the walk ends, the days before it stand, and the
    ///      next transaction starts there. The scope is the TRANSACTION and
    ///      not the settlement call because the bound is the transaction's
    ///      gas: two settlements batched in one transaction share it, and one
    ///      batched after the budget is spent pays nothing and reports the
    ///      earlier draws as its progress rather than failing the batch. At
    ///      about eighty thousand gas per epoch written this is roughly ten
    ///      million gas of draws, a fraction of a block.
    uint256 internal constant TRANSPORT_DRAW_CALL_CAP = 128;
    /// @dev The TRANSIENT slot counting the epochs this transaction's draws
    ///      have written (Codex #2276 r14 P1): read by every allocation of the
    ///      call, stepped by every draw, gone with the transaction. Transient
    ///      because the count is the call's and no facet may keep it — the
    ///      settle facets carry no room for a counter of their own.
    bytes32 internal constant TRANSPORT_WRITES_TSLOT = keccak256("vaipakam.transport.draw-writes.transient");

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

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r15) — whether a
    ///         batch was ever admitted under this id.
    /// @dev    THE existence question, with ONE name, so every surface that
    ///         needs it asks the same thing of the same field rather than
    ///         re-deriving it. `admitted` is the marker the struct itself
    ///         nominates — non-zero for every admitted batch, because a
    ///         delivery with nothing untyped in it opens none — and it is the
    ///         only field that qualifies: `balance` empties at parking,
    ///         `released` is false for every batch in this cut, and the
    ///         REMAINDER's own `batchId` answers "is something parked", which
    ///         is a different question that reads the same when the answer is
    ///         no.
    ///
    ///         This is the batch-side twin of {rolloutAdmissionStatus}. That
    ///         predicate answers "could an epoch still be opened over this
    ///         PACKET"; this one answers "does this BATCH exist". Both were
    ///         being answered by hand at their call sites, and both times the
    ///         hand-answer was the defect: r4 found the packet question asked
    ///         tacitly in a gate that then exempted the population the rollout
    ///         entry exists to rescue, and r15 found the batch question not
    ///         asked at all in two reads, which returned an unknown id's zeros
    ///         as though they were a batch's figures.
    function transportBatchExists(LibVaipakam.TransportBatch storage b) internal view returns (bool) {
        return b.admitted != 0;
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
        uint256[] calldata dayIds,
        bytes32[] memory hints,
        bytes32[] memory lateHints
    ) internal returns (uint32 indexedDays) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        if (!transportBatchExists(b)) revert IVaipakamErrors.TransportBatchUnknown(batchId);
        uint32 done = b.indexedDays;
        if (done >= b.dayCount) revert IVaipakamErrors.TransportBatchFullyIndexed(batchId);
        bytes32 committed = s.ingressPackets[batchId].dayListHash;
        bytes32 supplied = keccak256(abi.encode(dayIds));
        if (supplied != committed) {
            revert IVaipakamErrors.TransportDayListMismatch(batchId, committed, supplied);
        }
        uint256 end = uint256(done) + TRANSPORT_INDEX_PAGE;
        if (end > dayIds.length) end = dayIds.length;
        // Each day's epochs are an ORDERED LIST by (arrival, batch id), kept
        // beside the membership array, whoever materializes and in whatever
        // order (Codex #2276 r5, r6, r7): the draw reads a bounded window
        // from the day's cursor, a window is a prefix of the order, and a
        // prefix of a caller-ordered index was the caller's choice. A list
        // inserts in CONSTANT work given the predecessor — a materializer
        // may name it (`hints`, aligned with `dayIds`; zero = at the head),
        // and for a link that lands anywhere but the tail its predecessor in
        // the day's LATE chain too (`lateHints`, likewise; Codex #2308 r4) —
        // and without one the ledger walks back from the newest for at most
        // `TRANSPORT_INDEX_WALK_CAP` steps, one read each, and refuses past
        // that rather than taking on unbounded work (r7 P2: an arrival-sorted
        // array had to shift every newer entry, which no per-call budget
        // could bound for the day itself). The key is the delivery's own
        // arrival, written once by the ingress that received it — correct
        // for a retrospective admission too — with the batch id breaking
        // same-block ties (r6). A late epoch is never placed behind the
        // day's cursor: the cursor counts leading EXHAUSTED epochs, so a live
        // epoch behind it would be invisible; when a late epoch's place is
        // among the epochs the cursor has passed, it takes its place by key
        // among the epochs after the cursor, and the cursor never moves back
        // (r11, r12).
        //
        // EVERY member is linked as it is pushed (Codex #2296 items 2 and
        // 4), so a day's list holds it whole from its first member and there
        // is no second read source to reconcile: the array is the membership
        // set, the list is the order.
        uint64 arrived = s.ingressPackets[batchId].arrivedAt;
        LinkHint memory h;
        h.hinted = hints.length != 0;
        h.lateHinted = lateHints.length != 0;
        for (uint256 i = done; i < end; ++i) {
            uint256 d = dayIds[i];
            s.transportBatchesByDay[d].push(batchId);
            if (h.hinted) h.prev = hints[i];
            if (h.lateHinted) h.latePrev = lateHints[i];
            _linkIntoDay(s, d, batchId, arrived, h);
        }
        indexedDays = uint32(end);
        b.indexedDays = indexedDays;
        emit TransportBatchPageIndexed(batchId, indexedDays, b.dayCount);
    }

    /// @dev Where a day's scan starts: the first node AFTER its cursor in the
    ///      day's order — the ONE source every read of a day's epochs walks
    ///      (the plan's skip and window, and {transportDayScanIds}). There is
    ///      no second source to choose between: the list holds every day whole
    ///      (Codex #2296 items 2 and 4), and a scan steps with the list's own
    ///      `transportDayNext`, so no step helper is needed either.
    function _scanStart(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) private view returns (bytes32 node) {
        bytes32 cur = s.transportDayCursorNode[dayId];
        node = cur == bytes32(0) ? s.transportDayHead[dayId] : s.transportDayNext[dayId][cur];
    }

    /// @notice The batch ids a plan of `dayId` can look up in an overlay: the
    ///         nodes from the scan's start, at most one prune's worth and one
    ///         window of them (Codex #2276 r13 P1). A dry run hands the plan a
    ///         compact overlay of exactly these entries rather than its whole
    ///         table, so what crosses the call is bounded by the scan and not
    ///         by everything the run has drawn.
    function transportDayScanIds(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bytes32[] memory ids) {
        bytes32 node = _scanStart(s, dayId);
        bytes32[] memory buf = new bytes32[](2 * TRANSPORT_DRAW_SCAN_CAP);
        uint256 n;
        while (node != bytes32(0) && n < buf.length) {
            buf[n] = node;
            unchecked { ++n; }
            node = s.transportDayNext[dayId][node];
        }
        assembly ("memory-safe") {
            mstore(buf, n)
        }
        ids = buf;
    }

    /// @dev Whether the day's cursor has passed `node` (Codex #2276 r12 P1).
    function _passed(LibVaipakam.Storage storage s, uint256 d, bytes32 node) private view returns (bool) {
        return s.transportDayPrev[d][node] == TRANSPORT_PASSED;
    }

    /// @dev Whether `(aAt, a)` orders before `b` by (arrival, batch id).
    function _keyBefore(
        LibVaipakam.Storage storage s,
        uint64 aAt,
        bytes32 a,
        bytes32 b
    ) private view returns (bool) {
        uint64 bAt = s.ingressPackets[b].arrivedAt;
        return aAt < bAt || (aAt == bAt && a < b);
    }

    /// @dev The materializer's optional predecessors for one link: in the
    ///      day's list and, should the link land late, in the day's late
    ///      chain (Codex #2308 r4: a late chain deeper than the bounded walk
    ///      needs its own verified hint, or a valid hinted materialization
    ///      could never complete and the batch's protected funds never
    ///      become usable). Each is verified in constant work; the late one
    ///      is read only for a link that lands anywhere but the list's tail.
    struct LinkHint {
        bytes32 prev;
        bool hinted;
        bytes32 latePrev;
        bool lateHinted;
    }

    /// @dev Link `id` into day `d`'s ordered list at its place by (arrival,
    ///      batch id) — after `h.prev` when `h.hinted` (verified, constant
    ///      work), else after the newest node older than it, found by a
    ///      bounded walk back from the tail; and, when the place is not the
    ///      tail, into the day's late chain the same way after `h.latePrev`.
    ///      Idempotent: a batch already in the list is left where it is.
    function _linkIntoDay(
        LibVaipakam.Storage storage s,
        uint256 d,
        bytes32 id,
        uint64 arrived,
        LinkHint memory h
    ) private {
        bytes32 head = s.transportDayHead[d];
        if (head == id || s.transportDayPrev[d][id] != bytes32(0)) return; // already listed
        if (head == bytes32(0)) {
            s.transportDayHead[d] = id;
            s.transportDayTail[d] = id;
            return;
        }
        // Nothing is ever placed before the cursor (Codex #2276 r11, r12 P1
        // — the root of rounds 7, 8, 10 and 11 on this cursor): the cursor
        // only advances, so its position is an exact stored figure. An epoch
        // whose arrival would place it among the epochs the cursor has
        // passed takes its place BY KEY among the epochs after the cursor —
        // older than every live epoch there, so the window still holds the
        // oldest first, and ordered among such late epochs by the same key,
        // so which of them a window holds is the ledger's choice and not the
        // materializer's. The cursor marks every node it passes, so a hint is
        // refused in one read when it points behind the window.
        bytes32 prev;
        bytes32 cur = s.transportDayCursorNode[d];
        if (h.hinted) {
            prev = h.prev;
            if (prev == bytes32(0)) {
                // The head's place is behind the window once anything is passed.
                if (cur != bytes32(0)) revert IVaipakamErrors.TransportIndexHintInvalid(id, d, h.prev);
            } else {
                bool inList = prev == head || s.transportDayPrev[d][prev] != bytes32(0);
                if (!inList) revert IVaipakamErrors.TransportIndexHintInvalid(id, d, h.prev);
                if (prev == cur) {
                    // The cursor may precede an epoch older than itself.
                } else if (_passed(s, d, prev) || !_keyBefore(s, s.ingressPackets[prev].arrivedAt, prev, id)) {
                    revert IVaipakamErrors.TransportIndexHintInvalid(id, d, h.prev);
                }
            }
            bytes32 succ = prev == bytes32(0) ? head : s.transportDayNext[d][prev];
            if (succ != bytes32(0) && !_keyBefore(s, arrived, id, succ)) {
                revert IVaipakamErrors.TransportIndexHintInvalid(id, d, h.prev);
            }
        } else {
            // Back from the newest, stopping at the first node not after this
            // one — or at the cursor, which is the first passed node met.
            bytes32 node = s.transportDayTail[d];
            uint256 steps;
            while (node != bytes32(0) && !_passed(s, d, node) && _keyBefore(s, arrived, id, node)) {
                if (++steps > TRANSPORT_INDEX_WALK_CAP) revert IVaipakamErrors.TransportIndexWalkExceeded(id, d);
                node = s.transportDayPrev[d][node];
            }
            prev = node;
        }
        bytes32 nxt = prev == bytes32(0) ? head : s.transportDayNext[d][prev];
        s.transportDayPrev[d][id] = prev;
        s.transportDayNext[d][id] = nxt;
        if (prev == bytes32(0)) s.transportDayHead[d] = id;
        else s.transportDayNext[d][prev] = id;
        if (nxt == bytes32(0)) s.transportDayTail[d] = id;
        else s.transportDayPrev[d][nxt] = id;
        // A LATE link (3b-ii-A2, #2305): anywhere but the tail means the
        // epoch sorted ahead of members already listed, so a staging record
        // whose continuation stands past this place would never scan it.
        // The day keeps every such link in arrival order; a record's resume
        // walks the ones it has not seen before it continues.
        if (nxt != bytes32(0)) _linkLate(s, d, id, arrived, h);
    }

    /// @dev The late chain is kept in the LIST's own order — oldest arrival,
    ///      batch id on a tie — so a record's two scans, the chain past what
    ///      it has seen and the list past its continuation, are one order
    ///      read in two places (Codex #2308 r2: link order would let an
    ///      indexer decide which links a record's page takes). PRIORITY —
    ///      fewest listed days first — is the plan's, applied within a page
    ///      exactly as the draw applies it within a window (Codex #2276 r1,
    ///      r5, r12); neither the list nor the chain is kept in it, and an
    ///      earlier revision of this note claimed the chain was (Codex #2308
    ///      r4). Placed after a verified late predecessor when the
    ///      materializer names one, else by the same bounded back-walk the
    ///      list uses. A link that lands anywhere but the chain's tail bumps
    ///      the day's late generation, and a record whose last walk predates
    ///      it restarts from the chain's head.
    function _linkLate(LibVaipakam.Storage storage s, uint256 d, bytes32 id, uint64 arrived, LinkHint memory h) private {
        bytes32 behind;
        if (h.lateHinted) {
            // Verified as the list's hint is: in the chain, older than this
            // link, and with nothing between them — or the chain's head.
            behind = h.latePrev;
            if (behind != bytes32(0)) {
                bool inChain = behind == s.transportDayLateHead[d] || s.transportDayLatePrev[d][behind] != bytes32(0);
                if (!inChain || !_keyBefore(s, s.ingressPackets[behind].arrivedAt, behind, id)) {
                    revert IVaipakamErrors.TransportIndexHintInvalid(id, d, behind);
                }
            }
        } else {
            behind = s.transportDayLateTail[d];
            uint256 steps;
            while (behind != bytes32(0) && _keyBefore(s, arrived, id, behind)) {
                if (++steps > TRANSPORT_INDEX_WALK_CAP) revert IVaipakamErrors.TransportIndexWalkExceeded(id, d);
                behind = s.transportDayLatePrev[d][behind];
            }
        }
        bytes32 ahead = behind == bytes32(0) ? s.transportDayLateHead[d] : s.transportDayLateNext[d][behind];
        if (h.lateHinted && ahead != bytes32(0) && !_keyBefore(s, arrived, id, ahead)) {
            revert IVaipakamErrors.TransportIndexHintInvalid(id, d, h.latePrev);
        }
        s.transportDayLatePrev[d][id] = behind;
        s.transportDayLateNext[d][id] = ahead;
        if (behind == bytes32(0)) s.transportDayLateHead[d] = id;
        else s.transportDayLateNext[d][behind] = id;
        if (ahead == bytes32(0)) s.transportDayLateTail[d] = id;
        else {
            s.transportDayLatePrev[d][ahead] = id;
            unchecked { ++s.transportDayLateGen[d]; }
        }
        unchecked { ++s.transportDayLateCount[d]; }
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
    ///         whose day is in this list can still restore against it succ
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
        if (!transportBatchExists(b)) revert IVaipakamErrors.TransportBatchUnknown(batchId);
        if (b.indexedDays < b.dayCount) {
            revert IVaipakamErrors.TransportBatchNotFullyIndexed(batchId, b.indexedDays, b.dayCount);
        }
        // A referenced batch cannot be parked (3b-ii-A2, #2305): its staged
        // components are a standing record's, and parking would strand both.
        uint256 refs = s.transportBatchReferences[batchId];
        if (refs != 0) revert IVaipakamErrors.TransportBatchReferenced(batchId, refs);
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
    ///         succ this, {packetBatchReleased} answers yes for the batch's
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
    ///         the rule is about value held in a transport epoch. Which
    ///         packets those are is the next paragraph's question, and it is
    ///         deliberately not answered here as a list of populations
    ///         (Codex #2232 r15) — the list that used to stand here named "a
    ///         pre-3b arrival" among them, which is the very reading the
    ///         paragraph below was written to retire.
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

    // ─── Transport epochs PR 3b-ii-A: the draws ─────────────────────────────

    /// @notice One planned draw against a day's epochs: which epochs, how
    ///         much from each, in the order the rule fixes; and what the day's
    ///         window held.
    struct TransportDrawPlan {
        bytes32[] ids;
        /// @dev 3b-ii-A2 (#2305) — set by {planTransportDrawForRecord} only:
        ///      where the list scan and the late-chain scan stopped, carried
        ///      in memory so the split's wide frame holds no extra slots.
        bytes32 lastNode;
        bytes32 lastLate;
        /// @dev 3b-ii-A2 (#2305) — set by {planTransportDrawForRecord} only:
        ///      the live, fully indexed epochs it passed over UNTYPED, for the
        ///      record to remember and re-check.
        bytes32[] skipped;
        /// @dev Each drawable epoch's effective balance (net of the overlay)
        ///      and the ROOM each of its packet's two attested component caps
        ///      leaves it (Codex #2276 r4 P1: a cap covers classification PLUS
        ///      the transport leg, so a known cap bounds a draw's leg). Only an
        ///      ATTESTED epoch is drawable (Codex #2276 r26 P1), so every room
        ///      is a cap net of what is already classified and drawn.
        uint256[] bals;
        uint256[] freshRoom;
        uint256[] recycledRoom;
        /// @dev The day's cursor-visible coverage: the summed effective balances
        ///      of every drawable epoch in the window, each counted only for
        ///      what it can pay through at least one leg.
        uint256 available;
        /// @dev The plan's capacity PER LEG: the sum over its epochs of what
        ///      each could pay on that leg alone (Codex #2276). `available` is
        ///      the JOINT capacity, and crediting it on either leg overstated
        ///      it — a recycled-only epoch counted toward a fresh ask. Bounding
        ///      each leg by its own figure, and both by the joint figure, is the
        ///      exact feasibility test for two legs sharing balances.
        uint256 ordinaryFresh;
        uint256 ordinaryRecycled;
        /// @dev What the window held that the plan WITHHELD, by named reason
        ///      (Codex #2276 r26 P1, both):
        ///
        ///      - `withheldShared` — epochs listing more than one day. A draw
        ///        on such an epoch is contested whenever another listed day
        ///        carries a known unmet obligation, and the spec refuses a
        ///        contested draw until the contested-allocation machinery
        ///        lands (3c, #2318). Neither the listed days nor a per-day
        ///        unmet-obligation figure is readable here, so the plan cannot
        ///        tell a contested draw from an uncontested one and withholds
        ///        every shared epoch. That errs toward the obligation not yet
        ///        claimed: nothing is spent, the balance stays whole for 3c's
        ///        matching, and a day it would have paid defers.
        ///      - `withheldUnattested` — epochs whose packet's split is not yet
        ///        attested. A leg is typed once, by the caps it is drawn under;
        ///        drawing before the caps are known typed legs that a later
        ///        attestation had to retype AFTER settlement had already acted
        ///        on them (the bucket, the recycled commitment, live fresh),
        ///        leaving the epoch and the custody ledgers disagreeing. The
        ///        epoch becomes drawable when its attestation lands.
        ///
        ///      The two figures OVERLAP (Codex #2276 r27 P2): each is the balance
        ///      withheld for that reason, so an unattested shared epoch counts in
        ///      both and neither figure ever hides a pending cause.
        ///
        ///      A withheld epoch still occupies its window slot: the scan stays
        ///      bounded, and the day's cursor passes only exhausted epochs.
        uint256 withheldShared;
        uint256 withheldUnattested;
        /// @dev The window ended before the index did: unseen epochs may hold
        ///      coverage this plan could not see.
        bool capHit;
    }

    /// @dev The ONE split of a plan into per-epoch legs — in the plan's
    ///      order, each epoch's flexible balance held back from a leg only
    ///      where a later epoch's capacity for the other leg could not
    ///      otherwise be used. The allocation's last step, the draw and the
    ///      dry run's overlay all use it, so what was priced is what is drawn.
    struct TransportTakes {
        uint256[] fresh;
        uint256[] recycled;
        uint256 coveredFresh;
        uint256 coveredRecycled;
    }

    struct AllocRequest {
        uint256 dayId;
        uint256 needFresh;
        uint256 needRecycled;
        uint256 domainFresh;
        uint256 domainRecycled;
        uint256 poolFresh;
        uint256 deliveredCap;
        uint256 bucket;
        /// @dev The preview's simulation of draws already planned on earlier
        ///      days of the same dry run, by leg (a leg counts against its
        ///      cap's room), as a hash table over batch ids — length zero or
        ///      a power of two, empty slots zero (Codex #2276 r12 P1) — holding
        ///      only the entries THIS day's plan can look up (r13 P1); empty
        ///      on the settle path.
        bytes32[] ovIds;
        uint256[] ovFresh;
        uint256[] ovRecycled;
    }

    struct AllocResult {
        uint256 transportFresh;
        uint256 transportRecycled;
        bool capHit;
        /// @dev The per-epoch legs the allocation would draw — what a dry run
        ///      folds into its overlay; the settle wrapper re-derives the same
        ///      legs from the same plan and split in the same transaction.
        bytes32[] planIds;
        uint256[] planFresh;
        uint256[] planRecycled;
    }

    /// @notice The ONE walk of a day's index that every read and write of its
    ///         epochs shares.
    /// @dev    3b-ii-A. The coverage read, the allocation, the draw and the
    ///         preview's simulation all call this, so what a day is priced
    ///         against, what is drawn, and what a dry run assumes are one
    ///         computation and cannot disagree.
    ///
    ///         ORDER (Codex #2276 r1, r5): the day's index is kept in ARRIVAL
    ///         order by construction ({materializeTransportBatchPage}), so the
    ///         window — a prefix of the index from the cursor — always holds
    ///         the day's OLDEST live epochs, whoever indexed them and in
    ///         whatever order (r5 P1: a caller-ordered prefix would let a
    ///         materializer decide what a bounded window sees). Within the
    ///         window every planned epoch lists this one day (a shared epoch is
    ///         withheld — see `withheldShared`), so they are spent OLDEST
    ///         ARRIVAL FIRST, the batch id breaking ties. The window is at most
    ///         `TRANSPORT_DRAW_SCAN_CAP` entries, so the sort is bounded, and
    ///         everything beyond it is newer than everything in it.
    ///
    ///         SKIPPED, and not counted as coverage: exhausted batches, and
    ///         batches whose membership is not yet whole (`indexedDays !=
    ///         dayCount`, Codex #2276 r1) — a paged batch would otherwise
    ///         expose its whole balance to its first page's days before its
    ///         later days were indexed, and those days could find it drained.
    ///
    ///         ROOMS (Codex #2276 r4 P1): an ATTESTED packet's two component
    ///         caps each cover classification plus the transport leg of that
    ///         component, so the plan carries, per epoch, how much of each leg
    ///         its packet's cap still leaves — the cap net of what is
    ///         classified and what its own draws already took — and
    ///         {splitTransportTakes} never assigns a leg past it. An
    ///         epoch whose packet is unattested, or that lists more than one
    ///         day, is WITHHELD and counted by reason (see `withheldShared`).
    ///
    ///         `ovIds` / `ovFresh` / `ovRecycled` is the preview's overlay
    ///         (Codex #2276 r1 P2, typed since r4): each batch's balance and
    ///         rooms are read net of what the overlay records for it, so a
    ///         batch listing two days is not counted for both in one dry run.
    ///         Empty on the settle path, where the storage the draw just
    ///         wrote is the truth.
    function planTransportDraw(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        bytes32[] memory ovIds,
        uint256[] memory ovFresh,
        uint256[] memory ovRecycled
    ) internal view returns (TransportDrawPlan memory plan) {
        // The window's source is the day's ORDER from its cursor: the list,
        // which holds every day whole (Codex #2296 items 2 and 4). One scan,
        // one source, and so no case in which a window could be a prefix of
        // one order and not of another.
        bytes32 node = _scanStart(s, dayId);
        // A day this dry run has already settled had its cursor advanced by
        // the live draw's prune before the next side read it (Codex #2276 r9
        // P2): mirror that here — pass the leading epochs exhausted net of
        // the overlay, at most one window of them, exactly the prune's bound
        // — so the preview's later side reads what the claim's would.
        {
            (uint256 settled, ) = overlayOf(ovIds, ovFresh, ovRecycled, transportDaySettledKey(dayId));
            uint256 passed;
            while (settled != 0 && node != bytes32(0) && passed < TRANSPORT_DRAW_SCAN_CAP) {
                (uint256 f, uint256 r) = overlayOf(ovIds, ovFresh, ovRecycled, node);
                if (!_exhaustedNet(s, node, f, r)) break;
                node = s.transportDayNext[dayId][node];
                unchecked { ++passed; }
            }
        }
        bytes32[] memory ids = new bytes32[](TRANSPORT_DRAW_SCAN_CAP);
        uint256[] memory bals = new uint256[](TRANSPORT_DRAW_SCAN_CAP);
        uint256[] memory fRoom = new uint256[](TRANSPORT_DRAW_SCAN_CAP);
        uint256[] memory rRoom = new uint256[](TRANSPORT_DRAW_SCAN_CAP);
        uint256[] memory keys = new uint256[](TRANSPORT_DRAW_SCAN_CAP);
        uint256 live;
        uint256 seen;
        while (node != bytes32(0) && seen < TRANSPORT_DRAW_SCAN_CAP) {
            LibVaipakam.TransportBatch storage b = s.transportBatches[node];
            uint256 bal = b.balance;
            if (bal != 0 && b.indexedDays == b.dayCount) {
                (uint256 ovF, uint256 ovR) = overlayOf(ovIds, ovFresh, ovRecycled, node);
                bal = bal > ovF + ovR ? bal - (ovF + ovR) : 0;
                if (bal == 0) {
                    // Exhausted net of the overlay: nothing to plan or withhold.
                } else if (b.dayCount > 1 || !s.ingressPackets[node].attested) {
                    // Each reason counted on its own (Codex #2276 r27 P2): an
                    // unattested shared epoch is withheld for BOTH, and a
                    // reader asking whether an attestation is pending must not
                    // be told no because the epoch is also shared.
                    if (b.dayCount > 1) plan.withheldShared += bal;
                    if (!s.ingressPackets[node].attested) plan.withheldUnattested += bal;
                } else {
                    (uint256 fr, uint256 rr) = _capRooms(s, node, b, bal, ovF, ovR);
                    // Arrival order: every planned epoch lists this one day.
                    uint256 key = uint256(s.ingressPackets[node].arrivedAt);
                    plan.ordinaryFresh += fr < bal ? fr : bal;
                    plan.ordinaryRecycled += rr < bal ? rr : bal;
                    // The batch id is the final tie-break, so the plan's
                    // order is a function of the SET in the window and not
                    // of the order it was scanned in (Codex #2276 r9 P1) —
                    // which is what let the pre-list read path be removed
                    // without changing any plan (Codex #2296 items 2 and 4).
                    uint256 k = live;
                    while (k != 0 && (keys[k - 1] > key || (keys[k - 1] == key && ids[k - 1] > node))) {
                        ids[k] = ids[k - 1];
                        bals[k] = bals[k - 1];
                        fRoom[k] = fRoom[k - 1];
                        rRoom[k] = rRoom[k - 1];
                        keys[k] = keys[k - 1];
                        unchecked { --k; }
                    }
                    ids[k] = node;
                    bals[k] = bal;
                    fRoom[k] = fr;
                    rRoom[k] = rr;
                    keys[k] = key;
                    // Coverage counts only what is drawable through at least
                    // one leg (Codex #2276 r7 P2): the unit a scaling residual
                    // can leave outside both recorded caps is reserved for the
                    // close-out's disposition path and is not funding.
                    plan.available += fr + rr < bal ? fr + rr : bal;
                    unchecked { ++live; }
                }
            }
            node = s.transportDayNext[dayId][node];
            unchecked { ++seen; }
        }
        plan.capHit = node != bytes32(0);
        assembly ("memory-safe") {
            mstore(ids, live)
            mstore(bals, live)
            mstore(fRoom, live)
            mstore(rRoom, live)
        }
        plan.ids = ids;
        plan.bals = bals;
        plan.freshRoom = fRoom;
        plan.recycledRoom = rRoom;
    }

    /// @dev An ATTESTED epoch's two leg rooms (only an attested epoch is
    ///      planned — Codex #2276 r26 P1): each component's RECORDED cap net of
    ///      the packet's classification of that component, the epoch's own
    ///      draws of it, and the overlay's planned draws of it — never above
    ///      the balance. The two attested figures are floored independently
    ///      and can sum to one unit less than what landed; that unit fits
    ///      neither room and is never drawn once the split is known — it stays
    ///      in the balance for the close-out's disposition path (Codex #2276
    ///      r6 P1: round 5 redefined the recycled cap as what landed net of
    ///      the fresh cap, which let a draw exceed the source-recorded cap;
    ///      the ratified rule keeps both recorded caps and routes the excess
    ///      through the disposition path).
    function _capRooms(
        LibVaipakam.Storage storage s,
        bytes32 id,
        LibVaipakam.TransportBatch storage b,
        uint256 bal,
        uint256 ovF,
        uint256 ovR
    ) private view returns (uint256 fr, uint256 rr) {
        (uint256 capF, uint256 capR) = _netCaps(s.ingressPackets[id]);
        // Net of what standing records have STAGED of each component as well
        // as what draws consumed (3b-ii-A2, #2305; Codex #2308 r1): a staged
        // leg is a claim on that component's cap, and two records reading a
        // clear counter against one cap could otherwise both take it.
        uint256 usedF = b.consumedFresh + b.stagedFresh + ovF;
        uint256 usedR = b.consumedRecycled + b.stagedRecycled + ovR;
        fr = capF > usedF ? capF - usedF : 0;
        rr = capR > usedR ? capR - usedR : 0;
        if (fr > bal) fr = bal;
        if (rr > bal) rr = bal;
    }

    /// @dev An attested packet's two caps NET of the classification the packet
    ///      already carries — a packet that landed before the ledger may have
    ///      been classified before the batch gate existed (Codex #2276 r9
    ///      P1) — the figure the rooms read, so a leg is only ever drawn within
    ///      what the caps leave after classification.
    function _netCaps(LibVaipakam.IngressPacket storage p) private view returns (uint256 capF, uint256 capR) {
        capF = p.freshAttested > p.classifiedFresh ? p.freshAttested - p.classifiedFresh : 0;
        capR = p.recycledAttested > p.classifiedRecycled ? p.recycledAttested - p.classifiedRecycled : 0;
    }

    /// @notice Split a plan into per-epoch legs for the two asks: the most
    ///         either leg can be paid, spent in the plan's order.
    /// @dev    EXACT, not greedy. Walk the epochs BACKWARD, and let each supply
    ///         only what the epochs BEFORE it cannot: the minimum per leg that
    ///         the earlier epochs' capacity for that leg leaves unmet, and —
    ///         where the joint capacity binds — the minimum total they leave
    ///         unmet, the difference going to fresh first. Every epoch's total
    ///         is then the least any assignment could take from it given the
    ///         epochs after it, so the plan order decides which epochs pay:
    ///         the earliest are spent, and the latest are spared wherever the
    ///         earlier ones can cover.
    ///
    ///         Why exact (Codex #2276). Four review rounds found a counterexample
    ///         to each successive FORWARD greedy — fresh-first, then the next
    ///         capacity's index, then the furthest reach, then that reach judged
    ///         once for a whole flexible remainder. Each greedy chose one epoch's
    ///         leg without seeing how the choice constrained the rest. The
    ///         backward walk needs no such choice: an epoch's minimum is read off
    ///         three prefix capacities, which are the exact feasibility test for
    ///         two legs sharing balances. Measured before adoption: it reproduces
    ///         the brute-force lexicographic optimum on every counterexample from
    ///         this PR and on 20,000 of 20,000 random plans, and is idempotent on
    ///         its own result.
    ///
    ///         Why fresh-first for the extra is safe. Because the joint prefix
    ///         capacity is at least each per-leg one, the extra never exceeds
    ///         either leg's remaining demand, and which leg absorbs it changes
    ///         only how the EARLIER epochs split their legs, never how much any
    ///         later epoch pays — the brute force confirms the totals match.
    ///
    ///         The covered totals are computed first and directly: each leg
    ///         capped by its own capacity, and where the joint capacity binds
    ///         the recycled leg gives way, which keeps the long-standing fresh-
    ///         first convention. The split is IDEMPOTENT on its own result:
    ///         splitting again for exactly the legs it covered reproduces the
    ///         same per-epoch legs, which is what lets the settle wrapper
    ///         re-derive the allocation's legs from the plan and the two totals
    ///         alone. Where the rooms keep a leg short, the residual falls to
    ///         the shared sources or the day defers — never past a cap.
    function splitTransportTakes(
        TransportDrawPlan memory plan,
        uint256 askFresh,
        uint256 askRecycled
    ) internal pure returns (TransportTakes memory t) {
        uint256 n = plan.ids.length;
        t.fresh = new uint256[](n);
        t.recycled = new uint256[](n);
        // The capacity of ALL the epochs: per leg, and jointly. Each epoch's
        // rooms are already floored at its balance, so per leg it can give its
        // room, and jointly the lesser of its balance and its two rooms.
        uint256 capF;
        uint256 capR;
        uint256 capJ;
        for (uint256 k; k < n; ) {
            uint256 fr = plan.freshRoom[k];
            uint256 rr = plan.recycledRoom[k];
            uint256 b = plan.bals[k];
            capF += fr < b ? fr : b;
            capR += rr < b ? rr : b;
            capJ += fr + rr < b ? fr + rr : b;
            unchecked { ++k; }
        }
        // The covered totals. `capJ >= capF >= F`, so the recycled leg giving
        // way where the joint binds can never go negative.
        uint256 F = askFresh < capF ? askFresh : capF;
        uint256 R = askRecycled < capR ? askRecycled : capR;
        if (F + R > capJ) R = capJ - F;
        t.coveredFresh = F;
        t.coveredRecycled = R;
        // Backward: remove this epoch from the capacities, leaving those of
        // the epochs BEFORE it, and take from it only what they cannot cover.
        for (uint256 k = n; k > 0; ) {
            unchecked { --k; }
            (uint256 eF, uint256 eR, uint256 eJ) = _epochCaps(plan, k);
            capF -= eF;
            capR -= eR;
            capJ -= eJ;
            uint256 f = F > capF ? F - capF : 0;
            uint256 r = R > capR ? R - capR : 0;
            uint256 need = F + R > capJ ? F + R - capJ : 0;
            if (f + r < need) {
                // The joint prefix is short by more than the per-leg minimums
                // cover. Proven bounded: `capJ >= capF, capR`, so the extra
                // fits within this epoch's rooms and within each leg's
                // remaining demand; the second bound is kept anyway so the
                // subtraction below is safe by inspection, not by argument.
                uint256 extra = need - f - r;
                uint256 a = _min3(extra, eF - f, F - f);
                f += a;
                r += extra - a;
            }
            t.fresh[k] = f;
            t.recycled[k] = r;
            F -= f;
            R -= r;
        }
    }

    /// @dev One epoch's capacity per leg and jointly: its fresh room, its
    ///      recycled room, and the lesser of its balance and the two together.
    ///      Separate from the split so the backward loop stays within the
    ///      viaIR stack budget.
    function _epochCaps(TransportDrawPlan memory plan, uint256 k)
        private
        pure
        returns (uint256 eF, uint256 eR, uint256 eJ)
    {
        uint256 b = plan.bals[k];
        uint256 fr = plan.freshRoom[k];
        uint256 rr = plan.recycledRoom[k];
        eF = fr < b ? fr : b;
        eR = rr < b ? rr : b;
        eJ = fr + rr < b ? fr + rr : b;
    }

    function _min3(uint256 a, uint256 b, uint256 c) private pure returns (uint256 m) {
        m = a < b ? a : b;
        if (c < m) m = c;
    }

    /// @dev What the overlay records as already drawn from `id`, by leg. The
    ///      overlay is an open-addressing HASH TABLE over batch ids (Codex
    ///      #2276 r12 P1): its length is zero or a power of two, an empty
    ///      slot holds zero, and a key is probed linearly from
    ///      `uint256(key) & (length - 1)`; the dry run keeps it under half
    ///      full, so a probe is a few reads. A chunk of thirty days each
    ///      drawing a window of epochs was a linear scan of every prior draw
    ///      per plan entry — quadratic in the chunk — and is now a probe.
    function overlayOf(
        bytes32[] memory ovIds,
        uint256[] memory ovFresh,
        uint256[] memory ovRecycled,
        bytes32 id
    ) internal pure returns (uint256 f, uint256 r) {
        uint256 n = ovIds.length;
        if (n == 0) return (0, 0);
        uint256 mask = n - 1;
        uint256 i = uint256(id) & mask;
        while (true) {
            bytes32 k = ovIds[i];
            if (k == id) return (ovFresh[i], ovRecycled[i]);
            if (k == bytes32(0)) return (0, 0);
            i = (i + 1) & mask;
        }
    }

    /// @notice What `dayId`'s epochs can fund right now, within one scan
    ///         window, whether the window ended before the index did, and what
    ///         it withheld by reason.
    /// @dev    The plan's read half with nothing asked: a keeper's and a test's
    ///         view of a day. Zero, with no scan, on a day no epoch lists.
    // ───────────────────────── 3b-ii-A2 (#2305) — staging ─────────────────────────

    /// @dev The retry cadence a record's deadline is sized in — one page of
    ///      scanning per cadence — plus a fixed grace, from its opening.
    uint64 internal constant STAGING_RETRY_CADENCE = 1 days;
    uint64 internal constant STAGING_GRACE = 3 days;

    /// @notice A record's deadline, derived from the WORK its day needs:
    ///         opening + cadence × the pages the day's list needs + grace.
    /// @dev Moves only UPWARD, and only while the record is unexpired (Codex
    ///      #2297 post-merge item 7: a passed deadline is terminal — later
    ///      list growth belongs to the next obligation, never to a revived
    ///      lease). Never by the stager's own action: the page count is the
    ///      day index's, not the caller's. Set when the record opens and
    ///      re-read on every preparation.
    function stagingDeadlineRefresh(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r
    ) internal {
        uint64 current = r.deadline;
        if (current != 0 && block.timestamp >= current) return; // expired: terminal
        // The work LEFT, not the day's history (Codex #2308 r3): the members
        // the day's cursor has not passed, plus the late links made since the
        // record opened, plus the late work every restart restored — each
        // generation move re-walks the whole chain and adds its count (Codex
        // #2308 r5, r10) — so a mature day with thousands of exhausted
        // members and one window left needs one page, and its lease says so,
        // while every restart's pages are counted too.
        uint256 len = s.transportBatchesByDay[r.day].length;
        uint256 passed = s.transportDayCursor[r.day];
        uint256 members = len > passed ? len - passed : 0;
        uint256 lateNow = s.transportDayLateCount[r.day];
        members += lateNow > r.lateWorkBase ? lateNow - r.lateWorkBase : 0;
        members += r.lateWorkRestored;
        uint256 pages = (members + TRANSPORT_DRAW_SCAN_CAP - 1) / TRANSPORT_DRAW_SCAN_CAP;
        if (pages == 0) pages = 1;
        uint64 next = r.openedAt + uint64(pages) * STAGING_RETRY_CADENCE + STAGING_GRACE;
        if (next > current) {
            r.deadline = next;
            emit StagingDeadlineSet(key, next);
        }
    }

    function stagingKey(address user, LibVaipakam.RewardSide side, uint256 day) internal pure returns (bytes32) {
        return keccak256(abi.encode(user, side, day));
    }

    function stagingCommitment(uint256[] memory entryIds, LibVaipakam.StagingOp op) internal pure returns (bytes32) {
        return keccak256(abi.encode(entryIds, op));
    }

    /// @dev Staging takes exactly what a draw may take: an ATTESTED packet's
    ///      batch whose index is whole and that lists ONE day. An unattested
    ///      batch is neither drawn nor staged (Codex #2276 r26 — a leg is typed
    ///      once, by the caps it is drawn under); a batch whose later pages
    ///      are unindexed would expose its balance to its first page's days
    ///      before those days were indexed (Codex #2276 r1). Either state is
    ///      PENDING to a record — remembered and re-checked, never passed
    ///      (Codex #2308 r4). A batch listing more than one day is WITHHELD
    ///      until the contested-allocation machinery (3c): staging from it is
    ///      the contested draw the plan refuses, so it is never staged — and
    ///      never pending either ({_pendingCandidate}), since nothing before
    ///      3c makes it stageable.
    function stageable(LibVaipakam.Storage storage s, bytes32 batchId) internal view returns (bool) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        return s.ingressPackets[batchId].attested && b.indexedDays == b.dayCount && b.dayCount == 1;
    }

    /// @notice The plan for a RECORD's resume: the day's late chain past what
    ///         the record has seen, then the list from its continuation (the
    ///         day's cursor start when it has none), one window in all, only
    ///         stageable batches, no overlay. Returns where both scans stopped
    ///         so the record never rescans what it staged. Reads the LIST
    ///         only: a record is opened only for a listed day
    ///         ({stageDayFromPlan}), and listing is permanent.
    function planTransportDrawForRecord(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        bytes32 fromNode,
        bytes32 lateSeen,
        bytes32[] memory extraIds
    ) internal view returns (TransportDrawPlan memory plan) {
        uint256 cap = TRANSPORT_DRAW_SCAN_CAP + extraIds.length;
        bytes32[] memory ids = new bytes32[](cap);
        uint256[] memory bals = new uint256[](cap);
        uint256[] memory fRoom = new uint256[](cap);
        uint256[] memory rRoom = new uint256[](cap);
        uint256[] memory keys = new uint256[](cap);
        bytes32[] memory skipped = new bytes32[](cap);
        uint256 nSkipped;
        uint256 live;
        uint256 seen;
        bytes32 node;
        // The record's own re-checks first: epochs it passed over PENDING —
        // untyped, or not yet whole — that may be stageable since (at most
        // one page, not counted against the window — {_planAdd} skips one
        // still pending).
        for (uint256 k; k < extraIds.length; ) {
            live = _planAdd(s, extraIds[k], ids, bals, fRoom, rRoom, keys, live, plan);
            unchecked { ++k; }
        }
        // The late chain first — but only the epochs that sort AHEAD of the
        // continuation, which the list scan from it would never reach; one
        // that sorts after it is reached by that scan, and feeding it twice
        // would plan its balance twice (Codex #2308 r1). A record with no
        // continuation scans the list from its start and needs no late
        // chain: it marks the chain seen so a later resume does not replay
        // links that scan already covered.
        if (fromNode == bytes32(0)) {
            plan.lastLate = s.transportDayLateTail[dayId];
        } else {
            node = lateSeen == bytes32(0) ? s.transportDayLateHead[dayId] : s.transportDayLateNext[dayId][lateSeen];
            while (node != bytes32(0) && seen < TRANSPORT_DRAW_SCAN_CAP) {
                // One candidate once (Codex #2308 r5): an epoch the record's
                // re-checks already offered is passed here, not planned twice
                // — a restarted chain walk meets the re-checked epochs again.
                if (_keyBefore(s, s.ingressPackets[node].arrivedAt, node, fromNode) && !_among(extraIds, node)) {
                    if (_pendingCandidate(s, node)) skipped[nSkipped++] = node;
                    else live = _planAdd(s, node, ids, bals, fRoom, rRoom, keys, live, plan);
                }
                plan.lastLate = node;
                node = s.transportDayLateNext[dayId][node];
                unchecked { ++seen; }
            }
            // A late chain longer than the window leaves nodes unvisited: the
            // scan is not complete, whatever the list says (Codex #2308 r2).
            if (node != bytes32(0)) plan.capHit = true;
        }
        // Then the list from the continuation, or from the day's cursor start.
        if (fromNode == bytes32(0)) {
            bytes32 cur = s.transportDayCursorNode[dayId];
            node = cur == bytes32(0) ? s.transportDayHead[dayId] : s.transportDayNext[dayId][cur];
        } else {
            node = s.transportDayNext[dayId][fromNode];
        }
        while (node != bytes32(0) && seen < TRANSPORT_DRAW_SCAN_CAP) {
            if (!_among(extraIds, node)) {
                if (_pendingCandidate(s, node)) skipped[nSkipped++] = node;
                else live = _planAdd(s, node, ids, bals, fRoom, rRoom, keys, live, plan);
            }
            plan.lastNode = node;
            node = s.transportDayNext[dayId][node];
            unchecked { ++seen; }
        }
        if (node != bytes32(0)) plan.capHit = true;
        assembly ("memory-safe") {
            mstore(ids, live)
            mstore(bals, live)
            mstore(fRoom, live)
            mstore(rRoom, live)
            mstore(skipped, nSkipped)
        }
        plan.skipped = skipped;
        plan.ids = ids;
        plan.bals = bals;
        plan.freshRoom = fRoom;
        plan.recycledRoom = rRoom;
    }

    /// @notice The takes for a record's resume: {planTransportDrawForRecord}
    ///         split for the ask, in one frame that holds no record pointer —
    ///         the split's own frame is wide, and a caller holding the key and
    ///         the record beside it is what pushed viaIR past the stack.
    function planTakesForRecord(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        bytes32 fromNode,
        bytes32 lateSeen,
        uint256 askF,
        uint256 askR,
        bytes32[] memory extraIds
    )
        internal
        view
        returns (
            bytes32[] memory ids,
            uint256[] memory fresh,
            uint256[] memory recycled,
            bytes32 lastNode,
            bytes32 lastLate,
            bool complete,
            bytes32[] memory skipped
        )
    {
        TransportDrawPlan memory plan = planTransportDrawForRecord(s, dayId, fromNode, lateSeen, extraIds);
        if (plan.ids.length != 0) {
            TransportTakes memory t = splitTransportTakes(plan, askF, askR);
            ids = plan.ids;
            fresh = t.fresh;
            recycled = t.recycled;
        }
        lastNode = plan.lastNode;
        lastLate = plan.lastLate;
        complete = !plan.capHit;
        skipped = plan.skipped;
    }

    /// @notice Remember an epoch the record's own scan passed over pending.
    function noteSkipped(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r, bytes32 id) internal {
        _noteSkipped(s, key, r, id);
    }

    /// @dev Whether `node` is among `ids` — the record's re-check page, at most
    ///      one window of them, so the scan stays bounded.
    function _among(bytes32[] memory ids, bytes32 node) private pure returns (bool) {
        uint256 n = ids.length;
        for (uint256 k; k < n; ) {
            if (ids[k] == node) return true;
            unchecked { ++k; }
        }
        return false;
    }

    /// @dev A live epoch the record cannot stage from YET — its packet awaits
    ///      its split, or its membership its last page. Remembered by the
    ///      record and re-checked, never planned: a candidate a scan passed
    ///      without disposing of would be lost to the record, since neither
    ///      an attestation nor a completing page changes the list's length or
    ///      its late generation (Codex #2308 r2, r4). A SHARED epoch is not
    ///      pending (Codex #2276 r26): it is withheld until 3c, so the scan
    ///      passes it as it passes an exhausted one, and a day holding many
    ///      of them never fills the record's page of pending re-checks.
    function _pendingCandidate(LibVaipakam.Storage storage s, bytes32 node) private view returns (bool) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[node];
        return b.balance != 0 && b.dayCount == 1 && !stageable(s, node);
    }

    /// @dev One candidate into the record plan: live and stageable (attested,
    ///      whole, one day), rooms from its caps, sorted by the plan's key
    ///      exactly as {planTransportDraw} sorts — oldest arrival, batch id
    ///      last.
    function _planAdd(
        LibVaipakam.Storage storage s,
        bytes32 node,
        bytes32[] memory ids,
        uint256[] memory bals,
        uint256[] memory fRoom,
        uint256[] memory rRoom,
        uint256[] memory keys,
        uint256 live,
        TransportDrawPlan memory plan
    ) private view returns (uint256) {
        LibVaipakam.TransportBatch storage b = s.transportBatches[node];
        uint256 bal = b.balance;
        if (bal == 0 || !stageable(s, node)) return live;
        (uint256 fr, uint256 rr) = _capRooms(s, node, b, bal, 0, 0);
        uint256 key = uint256(s.ingressPackets[node].arrivedAt);
        uint256 k = live;
        while (k != 0 && (keys[k - 1] > key || (keys[k - 1] == key && ids[k - 1] > node))) {
            ids[k] = ids[k - 1];
            bals[k] = bals[k - 1];
            fRoom[k] = fRoom[k - 1];
            rRoom[k] = rRoom[k - 1];
            keys[k] = keys[k - 1];
            unchecked { --k; }
        }
        ids[k] = node;
        bals[k] = bal;
        fRoom[k] = fr;
        rRoom[k] = rr;
        keys[k] = key;
        plan.available += fr + rr < bal ? fr + rr : bal;
        unchecked { return live + 1; }
    }

    /// @notice Open a record for a claim day the walk could not settle, or
    ///         extend the standing one, and stage the plan's legs into it.
    ///         Called by the claim's entry walk on a cap-hit deferral — on the
    ///         host, never inlined into a settle facet.
    function stageDayFromPlan(
        LibVaipakam.Storage storage s,
        address user,
        LibVaipakam.RewardSide side,
        uint256 day,
        uint256[] memory entryIds,
        bytes32[] memory ids,
        uint256[] memory fresh,
        uint256[] memory recycled,
        LibVaipakam.RewardDelivery deliverTo
    ) internal returns (bytes32 key, uint256 staged) {
        key = stagingKey(user, side, day);
        LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
        bytes32 commitment = stagingCommitment(entryIds, LibVaipakam.StagingOp.Claim);
        bool opened;
        if (r.phase == LibVaipakam.StagingPhase.None) {
            // After a non-settlement release the same obligation may not open
            // a record again until the cooldown has passed (Codex #2308 r2):
            // the restored coverage is the window's, directly consumable by
            // every other obligation meanwhile. The batch-keyed window and
            // priority mode of the design are A2-ii's (#2305).
            // The cooldown is published: set with `StagingCooldownSet` at the
            // release and read back through the epoch view's
            // `getStagingCooldown`, so this silent deferral is never a state a
            // client cannot name (Codex #2308 r7).
            if (block.timestamp < s.stagingCooldownUntil[key]) return (key, 0);
            opened = true;
            r.nonce = ++s.stagingNonce[key];
            r.user = user;
            r.side = side;
            r.op = LibVaipakam.StagingOp.Claim;
            r.phase = LibVaipakam.StagingPhase.Staging;
            r.day = SafeCast.toUint64(day);
            r.openedAt = uint64(block.timestamp);
            r.commitment = commitment;
            r.entryIds = entryIds;
        } else if (r.commitment != commitment) {
            revert IVaipakamErrors.StagingCommitmentMismatch(key, r.commitment, commitment);
        } else if (r.phase != LibVaipakam.StagingPhase.Staging) {
            revert IVaipakamErrors.StagingPhaseInvalid(key, uint8(r.phase));
        }
        (uint256 sf, uint256 sr) = stageTakes(s, key, r, ids, fresh, recycled);
        staged = sf + sr;
        // A window with nothing stageable in it opens no record: an empty
        // record would hold nothing, reference nothing, and only stop the
        // walk on a day it could not help.
        if (staged == 0 && opened) {
            delete s.stagingRecords[key];
            return (key, 0);
        }
        // Opened only once something was staged, so no indexer holds an
        // opening for a record that never stood (Codex #2308 r1 P2).
        if (opened) emit StagingRecordOpened(key, user, uint8(side), r.day, commitment);
        // The venue the claimant named on THIS claim binds the record (Codex
        // #2308 r6): the staged part is delivered where the paid part was.
        // `Default` names nothing, and the record resolves the claimant's
        // default at payout as before; the claimant may still re-bind while
        // the record stages ({LibRewardStaging.setVenue}).
        if (deliverTo != LibVaipakam.RewardDelivery.Default) bindStagingVenue(key, r, deliverTo);
        // The walk records NO scan position (Codex #2308 r4): the day
        // primitive's plan is sorted by priority, not by the list, and it is
        // blind to the epochs its window passed that were not yet whole, so
        // no continuation derived from it disposes of every candidate the
        // window saw — and an epoch passed undisposed is lost to the record,
        // since neither an attestation nor a completing page moves the list's
        // length or its late generation. The record's own scanner is the only
        // one that advances the continuation: its first preparation rescans
        // the window from the day's cursor — one page, over epochs whose
        // balance the staging already moved — and notes every pending epoch
        // it passes. One page is the price of one scanner.
        if (opened) {
            // The late chain is history to a record that opens now: every
            // link before this moment is in the list order that first
            // preparation scans from the day's cursor. Only links made after
            // this are the chain's business for this record.
            r.lateSeen = s.transportDayLateTail[day];
            r.lateGenSeen = s.transportDayLateGen[day];
            r.lateWorkBase = s.transportDayLateCount[day];
        }
        stagingDeadlineRefresh(s, key, r);
    }

    /// @notice Move the takes into staged form for `key`: each stageable
    ///         batch's balance falls by its take, its staged components rise,
    ///         the record references it (once) and records the components it
    ///         gave. An unstageable batch in the plan is skipped, and NOT
    ///         noted — the day primitive's window may hold untyped epochs a
    ///         draw could have taken from; a stage may not, and the record's
    ///         own scan, which starts from the day's cursor, is what
    ///         remembers such an epoch (Codex #2308 r4: a note made here
    ///         only for a take missed the untyped epoch the split assigned
    ///         nothing).
    function stageTakes(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        bytes32[] memory ids,
        uint256[] memory fresh,
        uint256[] memory recycled
    ) internal returns (uint256 stagedFresh, uint256 stagedRecycled) {
        uint256 n = ids.length;
        for (uint256 k; k < n; ) {
            uint256 bf = fresh[k];
            uint256 br = recycled[k];
            if (bf + br != 0) {
                bytes32 id = ids[k];
                if (stageable(s, id)) {
                    LibVaipakam.TransportBatch storage b = s.transportBatches[id];
                    b.balance -= bf + br;
                    b.stagedFresh += bf;
                    b.stagedRecycled += br;
                    // The staged total is the SIXTH reserved source (Codex
                    // #2308 r13): while custody is inactive these tokens rest
                    // in the Diamond's balance, and no other claim may spend
                    // them. {LibVpfiRecycle.freshBackingRoom} reads it.
                    s.stagedEpochTotal += bf + br;
                    _reference(s, key, r, id, bf, br);
                    stagedFresh += bf;
                    stagedRecycled += br;
                    emit TransportStaged(id, key, bf, br);
                }
            }
            unchecked { ++k; }
        }
        r.stagedFresh += stagedFresh;
        r.stagedRecycled += stagedRecycled;
    }

    /// @notice The record's delivery venue set — by the claimant's explicit
    ///         claim at opening, or by the claimant later while the record
    ///         stages; ONE writer, one event (Codex #2308 r6).
    /// @custom:event-category state-change/reward-staging
    event StagingVenueSet(bytes32 indexed key, uint8 venue);

    function bindStagingVenue(bytes32 key, LibVaipakam.StagingRecord storage r, LibVaipakam.RewardDelivery venue) internal {
        r.venue = venue;
        r.venueSet = true;
        emit StagingVenueSet(key, uint8(venue));
    }

    function recordNonceKey(bytes32 key, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, nonce));
    }

    /// @notice One batch of a record's staged list, by insertion index — the
    ///         order the plan staged it in, which is the order the resolution
    ///         consumes (Codex #2308 r13).
    function stagedBatchAt(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        uint256 index
    ) internal view returns (LibVaipakam.StagedBatch storage) {
        return s.stagingBatches[recordNonceKey(key, r.nonce)][index];
    }

    /// @notice A batch's staged components leave the record: consumed, or
    ///         returned to its balance. Clears the row and the record's index
    ///         of it, so the close has nothing unbounded left to delete
    ///         (Codex #2308 r12, r13).
    /// @dev    The staged EARMARK is not dropped here (Codex #2308 r14): what
    ///         leaves the earmark is what leaves the record's claim on the
    ///         Diamond's balance, and a resolution page's consumed share does
    ///         not — it is still owed to the claimant until the last page pays
    ///         it. The caller drops exactly what it returned, and {_pay} drops
    ///         what it paid; {releaseStagedEarmark} is the one writer.
    function releaseStagedBatchAt(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        uint256 index
    ) internal {
        bytes32 nk = recordNonceKey(key, r.nonce);
        LibVaipakam.StagedBatch storage sb = s.stagingBatches[nk][index];
        delete s.stagingBatchIndexPlusOne[nk][sb.id];
        delete s.stagingBatches[nk][index];
    }

    /// @notice `amount` of epoch value leaves the staged earmark of the
    ///         Diamond's balance: returned to its batch, or paid out (Codex
    ///         #2308 r13, r14). Saturating, as every ledger release here is.
    function releaseStagedEarmark(LibVaipakam.Storage storage s, uint256 amount) internal {
        if (amount == 0) return;
        uint256 total = s.stagedEpochTotal;
        s.stagedEpochTotal = total > amount ? total - amount : 0;
    }

    /// @dev One reference per (record, batch), found in O(1) through the
    ///      record's own index (Codex #2308 r2): a batch staged twice by one
    ///      record across retries is one entry with merged components. A
    ///      batch the record had passed over untyped leaves that list here.
    function _reference(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        bytes32 id,
        uint256 bf,
        uint256 br
    ) private {
        bytes32 nk = recordNonceKey(key, r.nonce);
        uint256 at = s.stagingBatchIndexPlusOne[nk][id];
        if (at != 0) {
            LibVaipakam.StagedBatch storage sb = s.stagingBatches[nk][at - 1];
            sb.fresh += bf;
            sb.recycled += br;
            return;
        }
        uint256 next = r.batchCount;
        s.stagingBatches[nk][next] = LibVaipakam.StagedBatch({id: id, fresh: bf, recycled: br});
        r.batchCount = next + 1;
        s.stagingBatchIndexPlusOne[nk][id] = next + 1;
        s.transportBatchReferences[id] += 1;
        if (s.stagingSkippedSeen[nk][id]) _forgetSkipped(s, nk, r, id);
    }

    /// @dev An epoch the record passed over PENDING — untyped, or not yet
    ///      whole — is remembered, at most one page of them, so a preparation
    ///      re-checks it first and an attestation or a completing page
    ///      arriving after the skip is never lost to the record (Codex #2308
    ///      r2, r4). Past the page the record can only be unwound: such a day
    ///      is pending-dominated and stays draw-only.
    function _noteSkipped(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r, bytes32 id) private {
        bytes32 nk = recordNonceKey(key, r.nonce);
        if (s.stagingSkippedSeen[nk][id]) return;
        if (r.skippedIds.length >= TRANSPORT_DRAW_SCAN_CAP) {
            r.pendingOverflow = true;
            return;
        }
        s.stagingSkippedSeen[nk][id] = true;
        r.skippedIds.push(id);
    }

    function _forgetSkipped(LibVaipakam.Storage storage s, bytes32 nk, LibVaipakam.StagingRecord storage r, bytes32 id) private {
        uint256 n = r.skippedIds.length;
        for (uint256 i; i < n; ) {
            if (r.skippedIds[i] == id) {
                r.skippedIds[i] = r.skippedIds[n - 1];
                r.skippedIds.pop();
                break;
            }
            unchecked { ++i; }
        }
        s.stagingSkippedSeen[nk][id] = false;
    }

    /// @notice Forget an epoch the record passed over pending once it has been
    ///         re-checked STAGEABLE: it was offered to the plan, and whether it
    ///         contributed or could not — exhausted, no room, nothing asked —
    ///         it needs no further revisit (Codex #2308 r3).
    function forgetSkippedIfStageable(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r, bytes32 id) internal {
        bytes32 nk = recordNonceKey(key, r.nonce);
        if (s.stagingSkippedSeen[nk][id] && stageable(s, id)) _forgetSkipped(s, nk, r, id);
    }

    /// @notice Whether any epoch the record passed over pending is stageable
    ///         now — what the reservation must not walk past.
    function anySkippedNowStageable(LibVaipakam.Storage storage s, LibVaipakam.StagingRecord storage r) internal view returns (bool) {
        uint256 n = r.skippedIds.length;
        for (uint256 i; i < n; ) {
            if (stageable(s, r.skippedIds[i])) return true;
            unchecked { ++i; }
        }
        return false;
    }

    function transportCoverageForDay(
        LibVaipakam.Storage storage s,
        uint256 dayId
    )
        internal
        view
        returns (uint256 available, bool capHit, uint256 withheldShared, uint256 withheldUnattested)
    {
        if (s.transportBatchesByDay[dayId].length == 0) return (0, false, 0, 0);
        TransportDrawPlan memory plan =
            planTransportDraw(s, dayId, new bytes32[](0), new uint256[](0), new uint256[](0));
        return (plan.available, plan.capHit, plan.withheldShared, plan.withheldUnattested);
    }

    /// @notice §5c's split of `dayId`'s cursor-visible epoch coverage across
    ///         an obligation's fresh and recycled legs.
    /// @dev    The day primitive's ONE call (3b-ii-A): the plan and the split
    ///         live together so what a day is priced against is one read.
    ///         The day's OWN shortfalls first — each leg's need net of its own
    ///         typed source (fresh: the smaller of the pool headroom and the
    ///         delivered bound; recycled: the bucket) — because a day cannot
    ///         settle otherwise. Then the leg carrying the greater deficit
    ///         against the shared sources over the allocation DOMAIN (what
    ///         this call settles; a sweep's single day when the caller passed
    ///         `max`), fresh first on ties, then the other leg. The fresh need
    ///         is read net of the pool-cap trim — coverage is never assigned
    ///         to fresh the 69M headroom would not let anyone pay — and the
    ///         epoch-paid fresh still counts against that headroom, which is
    ///         why the caller passes it and this never inflates it. Blind
    ///         fresh-first was rejected by the design's own counter-example:
    ///         5 fresh / 5 recycled, 5 live fresh, an empty bucket and a
    ///         5-token epoch is fully backed only if live pays fresh and
    ///         transport pays recycled. Pure over the figures, so the settle
    ///         and the dry run split identically.
    function transportAllocateForDay(
        LibVaipakam.Storage storage s,
        AllocRequest memory q
    ) internal view returns (AllocResult memory r) {
        uint256 needFresh = q.needFresh > q.poolFresh ? q.poolFresh : q.needFresh;
        TransportDrawPlan memory plan = planTransportDraw(s, q.dayId, q.ovIds, q.ovFresh, q.ovRecycled);
        r.capHit = plan.capHit;
        if (plan.available == 0) return r;
        uint256 avail = plan.available;
        uint256 liveF = q.poolFresh < q.deliveredCap ? q.poolFresh : q.deliveredCap;
        uint256 sF = needFresh > liveF ? needFresh - liveF : 0;
        uint256 sR = q.needRecycled > q.bucket ? q.needRecycled - q.bucket : 0;
        // Each leg bounded by the ordinary tier's capacity FOR THAT LEG as well
        // as by the joint figure (Codex #2276): see `ordinaryFresh`.
        uint256 tf = _min3(sF, avail, plan.ordinaryFresh);
        avail -= tf;
        uint256 tr = _min3(sR, avail, plan.ordinaryRecycled);
        avail -= tr;
        if (avail != 0) {
            uint256 domainFresh = q.domainFresh == type(uint256).max ? needFresh : q.domainFresh;
            uint256 domainRecycled = q.domainRecycled == type(uint256).max ? q.needRecycled : q.domainRecycled;
            uint256 dF = domainFresh > liveF ? domainFresh - liveF : 0;
            uint256 dR = domainRecycled > q.bucket ? domainRecycled - q.bucket : 0;
            // The deficits NET of the mandatory draws just made (Codex #2276
            // r4 P1): those draws already relieved each leg's deficit by
            // exactly what they took, and choosing the residual leg on the
            // gross figures parked coverage on a leg the other could not do
            // without.
            dF = dF > tf ? dF - tf : 0;
            dR = dR > tr ? dR - tr : 0;
            uint256 moreF = needFresh - tf;
            uint256 moreR = q.needRecycled - tr;
            if (dR > dF) {
                uint256 a = _min3(moreR, avail, plan.ordinaryRecycled - tr);
                tr += a;
                avail -= a;
                tf += _min3(moreF, avail, plan.ordinaryFresh - tf);
            } else {
                uint256 a = _min3(moreF, avail, plan.ordinaryFresh - tf);
                tf += a;
                avail -= a;
                tr += _min3(moreR, avail, plan.ordinaryRecycled - tr);
            }
        }
        // The rule's totals, then the ONE split that realizes them against
        // each epoch's rooms (Codex #2276 r4 P1): where an attested cap keeps
        // a leg short, the covered legs are what the split could assign, and
        // the settle wrapper re-derives exactly these legs from the same plan.
        TransportTakes memory t = splitTransportTakes(plan, tf, tr);
        // Coverage a leg's caps rejected is offered to the OTHER leg, up to
        // its need (Codex #2276 r6 P1): a recycled-only epoch asked for fresh
        // by the tie rule paid nothing and left the shared sources to pay both
        // legs — the transport-first order inverted. The split is idempotent
        // on its result, so re-asking for the covered leg and more of the
        // other reproduces the first assignment and extends it.
        if (t.coveredFresh < tf) {
            uint256 tr2 = tr + (tf - t.coveredFresh);
            if (tr2 > q.needRecycled) tr2 = q.needRecycled;
            if (tr2 > tr) t = splitTransportTakes(plan, t.coveredFresh, tr2);
        } else if (t.coveredRecycled < tr) {
            uint256 tf2 = tf + (tr - t.coveredRecycled);
            if (tf2 > needFresh) tf2 = needFresh;
            if (tf2 > tf) t = splitTransportTakes(plan, tf2, t.coveredRecycled);
        }
        // The call's epoch-write budget (Codex #2276 r14 P1): the epochs this
        // day would write, over what the transaction's draws have written
        // (and, in a dry run, what its simulated draws have), must fit
        // `TRANSPORT_DRAW_CALL_CAP`; past it the day is reported as a cap
        // hit with no coverage, which the day primitive defers on — the walk
        // ends, the days before stand, the next call starts here.
        {
            uint256 writes;
            for (uint256 k; k < plan.ids.length; ) {
                if (t.fresh[k] + t.recycled[k] != 0) {
                    unchecked { ++writes; }
                }
                unchecked { ++k; }
            }
            (uint256 simulated, ) = overlayOf(q.ovIds, q.ovFresh, q.ovRecycled, transportWritesKey());
            if (_transientWrites() + simulated + writes > TRANSPORT_DRAW_CALL_CAP) {
                AllocResult memory deferred;
                deferred.capHit = true;
                return deferred;
            }
        }
        r.transportFresh = t.coveredFresh;
        r.transportRecycled = t.coveredRecycled;
        r.planIds = plan.ids;
        r.planFresh = t.fresh;
        r.planRecycled = t.recycled;
    }

    /// @notice Draw `fresh + recycled` for an obligation on `dayId` out of the
    ///         day's epochs, in the plan's order, recording which leg each
    ///         epoch paid.
    /// @dev    The WRITE half of the same plan the allocation read, so what
    ///         the day primitive priced against is exactly what is drawn.
    ///         Reverts {TransportDrawExceedsCoverage} if the plan cannot cover
    ///         the request — unreachable from a settle wrapper, which draws
    ///         what the same plan priced in the same transaction, and kept as
    ///         the assertion of that agreement.
    ///
    ///         Per epoch taken from: `balance` falls and the leg counters rise
    ///         (the FRESH leg is filled first, so {transportConsumedFresh} —
    ///         which {authenticatedFresh} nets from the attested caps — is
    ///         never understated by the order); the PACKET's untyped
    ///         remainder and the holder's uncounted aggregates fall by the
    ///         same amount, exactly as a classification's take steps them
    ///         down, but WITHOUT typing anything: a draw spends untyped value
    ///         on an obligation, it does not classify it. The custody move
    ///         itself — out of the holder's `Unclassified` row to the claimant,
    ///         or into `Recycled` for an absorption — is the settle path's, so
    ///         the row and this ledger fall together in one transaction.
    ///
    ///         Afterwards the day's cursor moves past every LEADING exhausted
    ///         epoch — the exhaustion transition, immediate here because
    ///         3b-ii-A has no staging that could restore a balance into an
    ///         epoch a cursor has passed. A draw of NOTHING is that prune: the
    ///         settle wrappers reach it on a cap-hit deferral through the same
    ///         entry they draw through, so each facet that inlines a wrapper
    ///         carries one encode rather than two.
    function drawTransportForDay(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 fresh,
        uint256 recycled
    ) internal returns (bool pruned) {
        if (fresh + recycled != 0) {
            TransportDrawPlan memory plan =
                planTransportDraw(s, dayId, new bytes32[](0), new uint256[](0), new uint256[](0));
            TransportTakes memory t = splitTransportTakes(plan, fresh, recycled);
            if (t.coveredFresh != fresh || t.coveredRecycled != recycled) {
                revert IVaipakamErrors.TransportDrawExceedsCoverage(
                    dayId, fresh + recycled, t.coveredFresh + t.coveredRecycled
                );
            }
            uint256 written;
            for (uint256 k; k < plan.ids.length; ) {
                uint256 bf = t.fresh[k];
                uint256 br = t.recycled[k];
                if (bf + br != 0) {
                    bytes32 batchId = plan.ids[k];
                    LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
                    b.balance -= bf + br;
                    b.consumedFresh += bf;
                    b.consumedRecycled += br;
                    spendUntypedForDraw(s, batchId, bf + br);
                    emit TransportDrawn(batchId, dayId, bf, br);
                    unchecked { ++written; }
                }
                unchecked { ++k; }
            }
            // The call's count of written epochs (Codex #2276 r14 P1): what
            // the next day's allocation reads against the budget.
            if (written != 0) _addTransientWrites(written);
        }
        pruned = _pruneTransportDayCursor(s, dayId);
        // A draw of NOTHING in a transaction whose draws have already written
        // epochs is the budget's deferral (Codex #2276 r15 P2): the progress
        // the settlement keeps is those earlier draws — this call's earlier
        // days, or an earlier settlement batched in the same transaction —
        // so it is reported as progress, and a settlement batched after one
        // that spent the budget returns nothing paid instead of reverting
        // the whole batch as an empty claim.
        if (fresh + recycled == 0 && _transientWrites() != 0) pruned = true;
    }

    /// @dev The packet half of a draw: the batch is keyed by its packet's
    ///      ingress stamp, so `batchId` names the packet whose untyped
    ///      remainder this value leaves. Steps the same figures down that a
    ///      classification's take does, through the same function, and none
    ///      of the classified ones.
    function spendUntypedForDraw(LibVaipakam.Storage storage s, bytes32 batchId, uint256 amount) internal {
        LibVaipakam.IngressPacket storage p = s.ingressPackets[batchId];
        uint256 have = p.unclassified;
        if (amount > have) {
            revert IVaipakamErrors.ReconciliationExceedsPacketRemainder(batchId, amount, have);
        }
        p.unclassified = have - amount;
        // The PACKET-level exit (Codex #2274 r8 P1): with it the packet's
        // identity `unclassified + classifiedFresh + classifiedRecycled +
        // disposed + drawn == protectedCumulative` holds after the draw, as
        // the batch's conservation identity does.
        p.drawn += amount;
        _stepDownUncounted(s, p.kind, amount);
    }

    /// @notice Advance `dayId`'s consumption cursor past every exhausted epoch
    ///         at the front of its list — at most one scan window per call.
    /// @dev Run by every draw, and permissionless through the facet. The
    ///      case that needs the standalone entry: an epoch drained by
    ///      ANOTHER day's draws still sits in this day's list (a batch's
    ///      day list is a hash, not an enumerable set, so a draw cannot
    ///      advance its sibling days), and a window full of such husks
    ///      would read as a cap hit with zero coverage — a day that defers
    ///      forever because nothing ever draws on it. So the settle
    ///      wrapper prunes on its way out of a deferred day, and a keeper
    ///      may prune any day at any time; both are idempotent. An epoch
    ///      whose membership is not yet whole is not exhausted and stops
    ///      the prune: it becomes drawable when its last page is indexed.
    ///      The cursor is a NODE (Codex #2276 r7): the last EXHAUSTED epoch at
    ///      the front of the list, zero when none is; the window starts after
    ///      it, and its POSITION — the count of leading exhausted epochs — is
    ///      kept beside it, exact because the cursor only advances (r11, r12:
    ///      a late epoch whose place is among the passed epochs takes its
    ///      place by key among the epochs after the cursor rather than moving
    ///      the cursor back; each passed node is marked). EXHAUSTED is
    ///      nothing left, or — once the split is attested — no room left under
    ///      either recorded cap (Codex #2276 r8 P2): the unit a scaling
    ///      residual leaves outside both caps is not coverage, and this
    ///      release cannot dispose of it, so it must not hold a window slot
    ///      forever. Both are terminal here: a balance only falls, and rooms
    ///      only shrink once the caps are recorded. A day indexed before the
    ///      list existed prunes its array cursor by the same rule.
    function pruneTransportDayCursor(LibVaipakam.Storage storage s, uint256 dayId) internal returns (bool moved) {
        return _pruneTransportDayCursor(s, dayId);
    }

    /// @dev An epoch the cursor may pass: see {pruneTransportDayCursor}.
    function _exhaustedForCursor(LibVaipakam.Storage storage s, bytes32 id) private view returns (bool) {
        return _exhaustedNet(s, id, 0, 0);
    }

    /// @dev The same rule net of a dry run's overlay (Codex #2276 r9 P2): what
    ///      the prune would pass after the draws the overlay records.
    function _exhaustedNet(
        LibVaipakam.Storage storage s,
        bytes32 id,
        uint256 ovF,
        uint256 ovR
    ) private view returns (bool) {
        // A referenced batch is never exhausted for a cursor (3b-ii-A2,
        // #2305): a standing record may unwind into it, and a cursor that had
        // passed it would never revisit what the unwind restored.
        if (s.transportBatchReferences[id] != 0) return false;
        LibVaipakam.TransportBatch storage b = s.transportBatches[id];
        uint256 bal = b.balance;
        bal = bal > ovF + ovR ? bal - (ovF + ovR) : 0;
        if (bal == 0) return true;
        if (!s.ingressPackets[id].attested) return false;
        (uint256 fr, uint256 rr) = _capRooms(s, id, b, bal, ovF, ovR);
        return fr + rr == 0;
    }

    /// @notice The overlay key under which a dry run carries how many epochs
    ///         its simulated draws have written so far (Codex #2276 r14 P1),
    ///         as the entry's fresh figure: the plan adds it to the
    ///         transaction's own count so the preview stops where the claim
    ///         would. Keyed apart from every batch id.
    function transportWritesKey() internal pure returns (bytes32) {
        return keccak256("vaipakam.transport.draw-writes");
    }

    /// @dev The epochs this transaction's draws have written so far.
    function _transientWrites() private view returns (uint256 n) {
        bytes32 slot = TRANSPORT_WRITES_TSLOT;
        assembly ("memory-safe") {
            n := tload(slot)
        }
    }

    /// @dev Step the transaction's count of written epochs by `n`.
    function _addTransientWrites(uint256 n) private {
        bytes32 slot = TRANSPORT_WRITES_TSLOT;
        assembly ("memory-safe") {
            tstore(slot, add(tload(slot), n))
        }
    }

    /// @notice The overlay key under which a dry run records that it settled
    ///         `dayId` (Codex #2276 r9 P2): an entry with a fresh figure of one
    ///         under this key tells the plan the live draw's prune has run on
    ///         the day. Keyed apart from every batch id.
    function transportDaySettledKey(uint256 dayId) internal pure returns (bytes32) {
        return keccak256(abi.encode("vaipakam.transport.day-settled", dayId));
    }

    /// @dev The day's prune: pass up to one window of leading exhausted nodes
    ///      in the day's order, marking each, keeping the node cursor and its
    ///      position. One implementation over one source (Codex #2296 items 2
    ///      and 4) — the array-ordered twin this had, and the conversion that
    ///      read its step count, are gone with the pre-list read path.
    function _pruneTransportDayCursor(LibVaipakam.Storage storage s, uint256 dayId) private returns (bool moved) {
        uint256 steps;
        bytes32 cur = s.transportDayCursorNode[dayId];
        bytes32 node = cur == bytes32(0) ? s.transportDayHead[dayId] : s.transportDayNext[dayId][cur];
        while (node != bytes32(0) && steps < TRANSPORT_DRAW_SCAN_CAP && _exhaustedForCursor(s, node)) {
            // Marked as passed (Codex #2276 r12 P1): its back-link is never
            // followed again, and the mark is what lets a hint be refused in
            // one read when it points behind the window.
            s.transportDayPrev[dayId][node] = TRANSPORT_PASSED;
            cur = node;
            node = s.transportDayNext[dayId][node];
            unchecked { ++steps; }
        }
        if (steps != 0) {
            s.transportDayCursorNode[dayId] = cur;
            // The position is kept beside the node (Codex #2276 r11 P2): the
            // cursor only advances, so the count of leading exhausted epochs
            // is exact for the cost of this write, and the lens reads it.
            s.transportDayCursor[dayId] += steps;
            emit TransportDayCursorAdvanced(dayId, cur);
            moved = true;
        }
    }

    /// @dev {transportAllocateForDay} through the epoch facet, as a STATICCALL
    ///      so the day primitive stays a view and the four facets that inline
    ///      it carry only this encode/decode rather than the plan and the
    ///      split. The short-circuit is PER DAY and read HERE, before the
    ///      call: a day no epoch lists makes no call at all, on every chain,
    ///      and it needs no counter — so it is correct on an in-place upgrade
    ///      from a ledger that already holds batches (Codex #2276 r1).
    /// @dev {transportDayScanIds} through the epoch facet, as a STATICCALL:
    ///      the dry run's read of which entries a day's plan can look up.
    function callTransportDayScanIds(uint256 dayId) internal view returns (bytes32[] memory ids) {
        bytes memory ret = _selfStatic(abi.encodeWithSignature("getTransportDayScanIds(uint256)", dayId));
        ids = abi.decode(ret, (bytes32[]));
    }

    function callTransportAllocateForDay(
        LibVaipakam.Storage storage s,
        AllocRequest memory q
    ) internal view returns (AllocResult memory r) {
        if (s.transportBatchesByDay[q.dayId].length == 0) return r;
        bytes memory ret = _selfStatic(
            abi.encodeWithSignature(
                "getTransportAllocationForDay((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32[],uint256[],uint256[]))",
                q
            )
        );
        r = abi.decode(ret, (AllocResult));
    }

    /// @dev The preview's dry run of `user`'s ShareOfPool days, through the
    ///      epoch facet ({RewardEpochFacet.getDryRunShareOfPoolDays}); see
    ///      {LibInteractionRewards.dryRunShareOfPoolDaysView} for why it is
    ///      hosted there ({RewardEpochViewFacet} since Codex #2276 r2). `armedTotal` is the FULL capped armed fresh the
    ///      chunk charges the emission cap and the armed commitment, the
    ///      epoch-paid fresh included (the public armed need, Codex #2276 r2
    ///      P2); `liveArmed` is the part the live delivery must fund — what
    ///      the delivered and backing gates test. The last two are the
    ///      walk's own readings for the expiry gates (Codex #2276 r1): the
    ///      chunk's draw on the recycle bucket net of the epoch-paid share,
    ///      a deferred day included, and whether a day was deferred on the
    ///      transport scan window.
    function callDryRunShareOfPoolDays(
        address user,
        uint256 deliveredCap,
        uint256 freshBudget
    )
        internal
        view
        returns (
            uint256 userTotal,
            uint256 armedTotal,
            uint256 liveArmed,
            uint256 bucketRecycled,
            bool capHit,
            bool deferred
        )
    {
        bytes memory ret = _selfStatic(
            abi.encodeWithSignature(
                "getDryRunShareOfPoolDays(address,uint256,uint256)", user, deliveredCap, freshBudget
            )
        );
        (userTotal, armedTotal, liveArmed, bucketRecycled, capHit, deferred) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, bool, bool));
    }

    /// @dev The allocation DOMAIN's gross needs for `user`'s next claim call,
    ///      through the epoch facet ({RewardEpochFacet.getObligationDomainNeeds}).
    ///      `max` — "the day is the domain" — when no day that call could
    ///      price has an epoch listed. That is decided by the view itself,
    ///      from the LEDGER: it enumerates the chunk's days without pricing
    ///      them and reads each day's index length — the slots the walk's
    ///      per-day short-circuit reads anyway — so a chain with no epochs
    ///      pays the call and the enumeration and no pricing, and a ledger
    ///      that already held epochs before this release is read exactly
    ///      right from its first block, with no counter to backfill and no
    ///      migration (Codex #2276 r2 P1: a counter appended here read zero
    ///      over pre-existing batches until the next admission, and on a
    ///      chain the old wire no longer fed it stayed zero for good).
    ///      Two reads through {RewardEpochViewFacet}: the probe first, the
    ///      pricing only where it says a listed day is in reach.
    function callDomainNeeds(address user) internal view returns (uint256 domainFresh, uint256 domainRecycled) {
        bytes memory ret = _selfStatic(abi.encodeWithSignature("getObligationDomainListsAnEpoch(address)", user));
        if (!abi.decode(ret, (bool))) return (type(uint256).max, type(uint256).max);
        ret = _selfStatic(abi.encodeWithSignature("getObligationDomainNeeds(address)", user));
        (domainFresh, domainRecycled) = abi.decode(ret, (uint256, uint256));
    }

    /// @dev A settlement's treasury and epoch legs through the epoch facet
    ///      ({RewardEpochFacet.epochSettleClaimLegs}): the live-funded fresh
    ///      absorbed through the bounding operation, the epoch-funded legs
    ///      recycled in place, the recycled commitment released for the
    ///      treasury's recycled AND for the user's epoch-paid recycled — the
    ///      latter without a bucket debit, since the bucket never paid it
    ///      (Codex #2276 r1). Hosted off `RewardClaimFacet` and
    ///      `InteractionRewardsFacet` for their EIP-170 headroom.
    function callSettleClaimLegs(
        uint256 liveFresh,
        uint256 epochLegs,
        uint256 treasuryRecycledRelease,
        uint256 userEpochRecycled,
        uint256 refId
    ) internal {
        if (liveFresh + epochLegs + treasuryRecycledRelease + userEpochRecycled == 0) return;
        _custody(
            abi.encodeWithSignature(
                "epochSettleClaimLegs(uint256,uint256,uint256,uint256,uint256)",
                liveFresh,
                epochLegs,
                treasuryRecycledRelease,
                userEpochRecycled,
                refId
            )
        );
    }

    /// @dev {drawTransportForDay} through the epoch facet. With both legs zero
    ///      it is the PRUNE (a cap-hit deferral); `prune` is what asks for
    ///      that, so an ordinary day with nothing to draw makes no call.
    ///      Returns whether the day's cursor MOVED — persisted progress the
    ///      claim must keep even when it paid nothing (Codex #2276 r4 P2).
    function callDrawTransportForDay(
        uint256 dayId,
        uint256 fresh,
        uint256 recycled,
        bool prune
    ) internal returns (bool pruned) {
        if (fresh + recycled == 0 && !prune) return false;
        bytes memory ret = _custodyReturning(
            abi.encodeWithSignature("epochDrawForDay(uint256,uint256,uint256)", dayId, fresh, recycled)
        );
        pruned = abi.decode(ret, (bool));
    }

    /// @dev {RewardCustodyFacet.custodyDeliverClaim}: the claim's three legs to
    ///      the claimant's vault when asked and creditable, else to their
    ///      wallet. Returns whether the vault took it.
    /// @dev 3b-ii-A2 (#2305) — {custodyDeliverClaimToVault}: the vault route
    ///      with NO wallet fallback, for a claimant the sanctions path says
    ///      may be paid into their vault and nowhere else.
    function callDeliverClaimToVault(address user, uint256 fresh, uint256 recycled, uint256 epoch) internal {
        _custody(
            abi.encodeWithSignature(
                "custodyDeliverClaimToVault(address,uint256,uint256,uint256)", user, fresh, recycled, epoch
            )
        );
    }

    function callDeliverClaim(
        address user,
        uint256 fresh,
        uint256 recycled,
        uint256 epoch,
        bool toVault
    ) internal returns (bool vaulted) {
        bytes memory ret = _custodyReturning(
            abi.encodeWithSignature(
                "custodyDeliverClaim(address,uint256,uint256,uint256,bool)", user, fresh, recycled, epoch, toVault
            )
        );
        vaulted = abi.decode(ret, (bool));
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
        // A classification recorded BEFORE the split was attested may already
        // exceed a cap (Codex #2276 r15 P1): a rollout packet classified
        // recycled before the batch gate existed, then attested mostly
        // fresh. Nothing here can undo it — a classification moved custody
        // rows, and only the correction path moves them back — so the excess
        // is RECORDED as a divergence, per component, for the reconciliation
        // surface and the correction that follows; the caps net of
        // classification saturate at zero meanwhile, so no further draw or
        // classification of that component is admitted, and the identity
        // this attestation keeps is stated over the transport legs alone.
        {
            uint256 exF = p.classifiedFresh > freshAttested ? p.classifiedFresh - freshAttested : 0;
            uint256 exR = p.classifiedRecycled > recycledAttested ? p.classifiedRecycled - recycledAttested : 0;
            // The event is the historical record of what THIS attestation
            // observed; the current excess is derived on read, not stored, so
            // a later correction cannot leave a stale copy behind (Codex #2276).
            if (exF + exR != 0) emit IngressPacketClassifiedBeyondCaps(h, exF, exR);
        }
        // Nothing to reconcile (Codex #2276 r26 P1): an epoch is drawn only
        // once its packet is attested, so no leg exists yet for these caps to
        // retype. A leg is typed once, by the caps it is drawn under, and the
        // custody ledgers settlement moved for it never need revisiting.
    }

    /// @notice Move `amount` of a packet's classification between components.
    /// @dev    The correction path's single write to a packet's classification
    ///         (Codex #2276). It never retypes a transport leg (Codex #2276 r26
    ///         P1): a drawn leg was settled — its bucket debit, its recycled
    ///         release, its live-fresh charge — and moving the leg without
    ///         reversing those left the epoch and the custody ledgers telling
    ///         different stories. The fresh direction is already bounded by the
    ///         evidence NET of the fresh the epoch drew ({authenticatedFresh}),
    ///         so fresh classification plus the fresh leg never exceeds the fresh
    ///         cap. A recycled correction that takes classification plus the
    ///         recycled leg past the recycled cap is RECORDED, not undone: the
    ///         caps net of classification saturate at zero, so no further draw
    ///         of that component is admitted, and the excess reads on
    ///         {RewardReconciliationFacet.getPacketClassificationExcess} — the
    ///         same treatment as a classification that predates its attestation.
    function moveClassification(
        LibVaipakam.Storage storage s,
        bytes32 key,
        uint256 amount,
        bool freshToRecycled
    ) internal {
        LibVaipakam.IngressPacket storage p = s.ingressPackets[key];
        if (freshToRecycled) {
            p.classifiedFresh -= amount;
            p.classifiedRecycled += amount;
        } else {
            p.classifiedRecycled -= amount;
            p.classifiedFresh += amount;
        }
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
        _stepDownUncounted(s, p.kind, total);
    }

    /// @dev The holder-side aggregates that fall when untyped value leaves a
    ///      packet's remainder — by a classification's take above, or by an
    ///      epoch DRAW ({_spendUntypedForDraw}). ONE implementation for both
    ///      (3b-ii-A): whoever changes what "left the untyped remainder"
    ///      means changes it here for every exit, and the `Unclassified` row
    ///      invariant (row == uncounted held + returned held) keeps holding.
    function _stepDownUncounted(LibVaipakam.Storage storage s, uint8 kind, uint256 total) private {
        if (kind <= PACKET_KIND_COMPENSATION) {
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
        // And never what staging records have reserved of the row, nor of
        // the delivered ledger (3b-ii-A2, #2305; Codex #2308 r5): the
        // narrower of the two bounds on each.
        uint256 unreserved = liveFreshUnreserved(s);
        if (unreserved < uncommitted) uncommitted = unreserved;
        if (amount > uncommitted) revert IVaipakamErrors.ReconciliationExceedsUncommittedLive(amount, uncommitted);
        uint256 received = deliveredFreshUncreditable(s);
        if (amount > received) revert IVaipakamErrors.ReconciliationReceivedShort(amount, received);
        s.rewardBudgetArmedFreshReceived -= amount;
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

    /// @dev Like {_custodyReturning} for a VIEW: a staticcall into the Diamond,
    ///      the callee's revert data bubbled unchanged.
    function _selfStatic(bytes memory data) private view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(this).staticcall(data);
        if (ok) return ret;
        if (ret.length == 0) revert IVaipakamErrors.RewardCustodyCallFailed();
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
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
