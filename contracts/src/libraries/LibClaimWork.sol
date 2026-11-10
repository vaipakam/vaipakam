// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibClaimWork
 * @notice #1787 — the ONE work meter for a reward claim and the paginated
 *         steps that settle it. A claim used to bound its walk by DAYS alone
 *         (`MAX_INTERACTION_CLAIM_DAYS`), while what a day costs grows with
 *         the number of entries on it. A wallet with enough loans, or one that
 *         had not claimed for a while, therefore met a claim whose gas no
 *         transaction could carry, and every later claim met the same work:
 *         the reward was stranded with no attacker involved. Measured on the
 *         pre-#1787 code: 40 entries over 30 days cost 28.4M gas, 200 entries
 *         on one day 27.3M, and a 40-day backlog of 10 entries 20.4M just to
 *         prepare its domain.
 *
 *         The meter charges each step its MODELLED gas, from the constants
 *         below, and a loop takes a step only while the call's budget can
 *         carry it. The first step of a call always fits a fresh budget (the
 *         domain's snapshot bound and the page constants are chosen for that,
 *         and a test pins it), so every call makes progress and a backlog of
 *         any size is settled over successive calls. Nothing is lost by
 *         stopping early: an entry not reached keeps its cursor and is paid by
 *         the next call exactly as if the claimant had claimed more often.
 *
 *         The figures are a MODEL, deliberately above the measured costs, so
 *         the meter is deterministic: the same state gives the same split
 *         whatever gas limit the transaction carries (a `gasleft()` bound
 *         would let a low gas estimate shrink every claim to one step, and
 *         would make a simulation disagree with the claim it previews).
 *
 *         Whether an entry was already touched in this transaction is kept in
 *         TRANSIENT storage: its first day in a transaction pays for cold
 *         storage, later days do not, and a second claim in the same
 *         transaction (a multicall) finds it warm, exactly as the EVM does.
 */
library LibClaimWork {
    /// @notice Modelled gas one call may spend on the per-entry work of a
    ///         claim walk, a domain preparation or a domain page. Sized so the
    ///         walk plus the claim's fixed work and its per-entry scans fit
    ///         well inside the 16,777,216 per-transaction gas cap (EIP-7825).
    uint256 internal constant BUDGET = 7_000_000;

    /// @notice One armed day of the claim walk: its fixed cost, an entry's
    ///         first day in this transaction, and each later day of an entry.
    uint256 internal constant WALK_DAY = 100_000;
    uint256 internal constant WALK_ENTRY_FIRST = 160_000;
    uint256 internal constant WALK_ENTRY_DAY = 30_000;

    /// @notice One day of a domain's preparation (a day record written per
    ///         day): fixed, first touch of an entry, and later days.
    uint256 internal constant PREP_DAY = 400_000;
    uint256 internal constant PREP_ENTRY_FIRST = 160_000;
    uint256 internal constant PREP_ENTRY_DAY = 60_000;

    /// @notice One day of a domain page (reserve, revalidate, resolve,
    ///         unwind): fixed for a day the domain holds a record on, per
    ///         entry the record holds, and a day it holds none on.
    uint256 internal constant PAGE_DAY = 500_000;
    uint256 internal constant PAGE_ENTRY = 70_000;
    uint256 internal constant PAGE_EMPTY_DAY = 20_000;

    /// @notice The most entries a claim domain takes into its snapshot. One
    ///         day of the snapshot must fit a fresh budget in every step that
    ///         walks it ({PREP_DAY} + this × {PREP_ENTRY_FIRST} and
    ///         {PAGE_DAY} + this × {PAGE_ENTRY} both stay under {BUDGET}), so
    ///         no step can stall on a day too large for one call. Entries
    ///         beyond it wait for the next domain, as an entry accruing after
    ///         a domain opens already does.
    uint256 internal constant DOMAIN_MAX_ENTRIES = 32;

    /// @dev Transient namespace of the per-transaction "touched" marks.
    bytes32 private constant TOUCHED_NS = keccak256("vaipakam.rewards.claimWork.touched.v1");

    /// @notice How many of `set` (in order) one day can take from `left`, and
    ///         the modelled cost of taking them. `k == 0` when not even the
    ///         first entry fits, which is the caller's signal to stop.
    function fit(
        uint256[] memory set,
        uint256 left,
        uint256 dayCost,
        uint256 firstCost,
        uint256 againCost
    ) internal view returns (uint256 k, uint256 cost) {
        if (left < dayCost) return (0, 0);
        cost = dayCost;
        uint256 n = set.length;
        while (k < n) {
            uint256 c = touched(set[k]) ? againCost : firstCost;
            if (cost + c > left) break;
            cost += c;
            unchecked { ++k; }
        }
        if (k == 0) cost = 0;
    }

    /// @notice How many entries of one day a FRESH call (nothing touched, the
    ///         whole budget) takes: the read-only mirror of {fit} for a view
    ///         that answers "would the next claim reach this entry".
    function freshWalkCapacity() internal pure returns (uint256) {
        return (BUDGET - WALK_DAY) / WALK_ENTRY_FIRST;
    }

    /// @notice {fit} for one walk day of `n` entries none of which the call has
    ///         touched yet, with `left` of the meter remaining: how many it
    ///         takes and what that costs. Pure, so a static read can follow the
    ///         meter from one side's day to the next without the transient
    ///         marks a running claim keeps. `(0, 0)` when not even one fits.
    function fitFresh(uint256 n, uint256 left) internal pure returns (uint256 k, uint256 cost) {
        if (n == 0 || left < WALK_DAY + WALK_ENTRY_FIRST) return (0, 0);
        k = (left - WALK_DAY) / WALK_ENTRY_FIRST;
        if (k > n) k = n;
        cost = WALK_DAY + k * WALK_ENTRY_FIRST;
    }

    /// @notice How many claim calls a domain's preparation needs: `days_`
    ///         days, each a record over at most `entries` entries, prepared by
    ///         calls that each carry as many WHOLE days as the meter fits
    ///         (the first costed cold, the rest warm) and at most `maxDays`.
    ///         The domain's deadline grants one retry cadence per call, so it
    ///         counts the calls the meter actually needs, not days per
    ///         `maxDays`. A model, not a promise: it assumes every day carries
    ///         every entry and the call's whole budget is the preparation's,
    ///         which is the costliest shape of its own extent.
    function prepCalls(uint256 days_, uint256 entries, uint256 maxDays) internal pure returns (uint256 calls) {
        uint256 first = PREP_DAY + entries * PREP_ENTRY_FIRST;
        uint256 again = PREP_DAY + entries * PREP_ENTRY_DAY;
        uint256 perCall = first > BUDGET ? 1 : 1 + (BUDGET - first) / again;
        if (perCall > maxDays) perCall = maxDays;
        if (perCall == 0) perCall = 1;
        calls = (days_ + perCall - 1) / perCall;
    }

    /// @notice The first `k` ids of `set` (a copy; `set` is unchanged).
    function prefix(uint256[] memory set, uint256 k) internal pure returns (uint256[] memory out) {
        if (k >= set.length) return set;
        out = new uint256[](k);
        for (uint256 i; i < k; ) {
            out[i] = set[i];
            unchecked { ++i; }
        }
    }

    /// @notice Mark every id of `set` touched for the rest of the transaction.
    function touch(uint256[] memory set) internal {
        bytes32 ns = TOUCHED_NS;
        for (uint256 i; i < set.length; ) {
            uint256 id = set[i];
            assembly ("memory-safe") {
                mstore(0x00, ns)
                mstore(0x20, id)
                tstore(keccak256(0x00, 0x40), 1)
            }
            unchecked { ++i; }
        }
    }

    /// @notice Whether `id` was touched earlier in this transaction.
    function touched(uint256 id) internal view returns (bool t) {
        bytes32 ns = TOUCHED_NS;
        assembly ("memory-safe") {
            mstore(0x00, ns)
            mstore(0x20, id)
            t := tload(keccak256(0x00, 0x40))
        }
    }
}
