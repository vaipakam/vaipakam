// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";

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
        uint256 have = s.rewardCustodyRows[r];
        if (amount > have) revert IVaipakamErrors.RewardCustodyRowShort(uint8(r), amount, have);
        s.rewardCustodyRows[r] = have - amount;
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
        debit(s, from, amount, address(0));
        credit(s, to, amount, 1);
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
        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 paid = s.rewardBudgetArmedFreshPaid;
        uint256 deficit = paid > received ? paid - received : 0;
        toRestitution = amount < deficit ? amount : deficit;
        toLive = amount - toRestitution;
        s.rewardBudgetArmedFreshReceived = received + amount;
        credit(s, LibVaipakam.RewardCustodyRow.LiveFresh, toLive, 0);
        credit(s, LibVaipakam.RewardCustodyRow.Restitution, toRestitution, 0);
        emit RewardCustodyFreshCredited(amount, toLive, toRestitution, received + amount);
    }

    /**
     * @notice Reverse a fresh credit (a provisional compensation being
     *         demoted): the received side unwinds by `amount`, saturating
     *         as it always has, and the holder gives back what it still
     *         holds of that credit — from the live-fresh row first, then
     *         from the restitution row — at most `amount`, less only where
     *         part of it was already paid out.
     * @dev    Both rows give back, because the demotion re-attributes the
     *         WHOLE credited amount to the Diamond-side stranded-recovery
     *         reservation, which the return sender then transfers from the
     *         Diamond's balance in full (Codex #2186 r1 P1): a demotion that
     *         released only the live portion would leave the deficit-covering
     *         part in the holder while the reservation described it at the
     *         Diamond, so the return would spend unrelated ambient VPFI or
     *         revert. The deficit the restitution portion covered re-opens
     *         with the received unwind, exactly as it would have without
     *         the split, and the tokens go where the reservation says they
     *         are. Whatever was already paid out cannot come back, exactly
     *         as before; the reservation is short by that much, as before.
     *         After the unwind the live row again equals `received − paid`.
     *         The tokens are released to the DIAMOND, measured (the
     *         quarantine custody stays where the return sender draws it
     *         from; its move into the holder is the cutover PR's).
     * @return returned What the holder gave back and the Diamond received.
     */
    function uncreditFresh(
        LibVaipakam.Storage storage s,
        uint256 amount
    ) internal returns (uint256 returned) {
        if (amount == 0) return 0;
        uint256 received = s.rewardBudgetArmedFreshReceived;
        s.rewardBudgetArmedFreshReceived = received > amount ? received - amount : 0;
        uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        uint256 fromLive = amount < live ? amount : live;
        if (fromLive != 0) {
            releaseFromRow(s, LibVaipakam.RewardCustodyRow.LiveFresh, address(this), fromLive);
        }
        uint256 rest = amount - fromLive;
        uint256 restitution = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution];
        uint256 fromRestitution = rest < restitution ? rest : restitution;
        if (fromRestitution != 0) {
            releaseFromRow(s, LibVaipakam.RewardCustodyRow.Restitution, address(this), fromRestitution);
        }
        returned = fromLive + fromRestitution;
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

    /// @dev {uncreditFresh} through the custody facet.
    function callUncreditFresh(uint256 amount) internal {
        if (amount == 0) return;
        _custody(abi.encodeWithSignature("custodyUncreditFresh(uint256)", amount));
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
