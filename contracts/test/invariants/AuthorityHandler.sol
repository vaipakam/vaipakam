// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {ProtectedAccountFacet} from "../../src/facets/ProtectedAccountFacet.sol";
import {AutoLifecycleSettingsFacet} from "../../src/facets/AutoLifecycleSettingsFacet.sol";
import {LibTestPositionNFT} from "../helpers/LibTestPositionNFT.sol";
import {LibTestProtection} from "../helpers/LibTestProtection.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title  AuthorityHandler
 * @notice #3568 — the authority-chain handler. It drives the steps that
 *         change WHO may act (a protected-account replacement, operator
 *         approvals made before it, the recovery of retired positions, per-
 *         loan keeper toggles, each side's auto-extend and auto-refinance
 *         caps) interleaved with the ordinary loan steps of the shared
 *         {Handler}, which it owns and forwards to. Three hostile actors:
 *         - the OLD KEY: a wallet a replacement retired, and any operator it
 *           approved before;
 *         - the COUNTERPARTY: the other side of each loan;
 *         - the STALE GRANTEE: an operator whose grant the replacement voided.
 *
 *         Value and position checks run after EVERY step, inside the
 *         handler, so a value that reaches a retired wallet and leaves again
 *         within one step is still seen. A violation is latched in a ghost
 *         flag the suite asserts, with the step that caused it.
 *
 *         Separate from {Handler} on purpose: the custody and ledger suites
 *         keep their surface and run time.
 */
contract AuthorityHandler is Test {
    InvariantBase public base;
    Handler public inner;
    address public diamond;
    PositionNFT public core;
    address public usdc;
    address public weth;

    uint32 internal constant DELAY = 2 days;

    /// @dev Every actor (3 lenders, 3 borrowers), for the per-step checks.
    address[] internal actors;

    // ─── Invariant 1 ghosts: retired keys ────────────────────────────────
    address[] public retiredKeys;
    mapping(address => bool) public isRetired;
    mapping(address => address) public replacementOf;
    /// @dev A retired key's wallet balance after the last step, per asset.
    mapping(address => mapping(address => uint256)) internal lastBal;
    /// @dev Positions a retired key held when it was retired, and where each
    ///      one is allowed to be now.
    uint256[] internal trackedTokens;
    mapping(uint256 => address) public expectedHolder;
    mapping(address => address) public operatorOf;

    // ─── Invariant 2 ghosts: each side's own settings ────────────────────
    struct CapGhost {
        bool set;
        address setter;
        bool enabled;
        uint16 maxRateBps;
        uint64 maxNewExpiry;
    }
    /// loanId => side (0 lender, 1 borrower) => the extend caps that side set.
    mapping(uint256 => mapping(uint8 => CapGhost)) internal extendGhost;
    /// loanId => the refinance caps the borrower side set.
    mapping(uint256 => CapGhost) internal refiGhost;
    /// loanId => side => the per-loan keeper value that side last set.
    mapping(uint256 => mapping(uint8 => bool)) public keeperSet;
    mapping(uint256 => mapping(uint8 => bool)) public keeperValue;
    address public keeper;

    // ─── Latched violations ──────────────────────────────────────────────
    string public valueViolation;
    string public positionViolation;
    string public capViolation;
    string public keeperViolation;

    mapping(bytes32 => uint256) public callCount;

    constructor(InvariantBase _base) {
        base = _base;
        diamond = address(_base.diamond());
        inner = new Handler(_base);
        core = LibTestPositionNFT.core(diamond);
        usdc = _base.mockUsdc();
        weth = _base.mockWeth();
        keeper = makeAddr("authorityKeeper");
        for (uint256 i; i < 3; ++i) {
            actors.push(_base.lenderAt(i));
            actors.push(_base.borrowerAt(i));
        }
    }

    // ═══ Ordinary loan steps (forwarded) ═════════════════════════════════

    function createLenderOffer(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) external checked {
        inner.createLenderOffer(a, b, c, d, e);
    }

    function createBorrowerOffer(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) external checked {
        inner.createBorrowerOffer(a, b, c, d, e);
    }

    function acceptLenderOffer(uint256 a, uint256 b) external checked {
        inner.acceptLenderOffer(a, b);
    }

    function acceptBorrowerOffer(uint256 a, uint256 b) external checked {
        inner.acceptBorrowerOffer(a, b);
    }

    function repay(uint256 a) external checked {
        inner.repay(a);
    }

    function repayPartial(uint256 a, uint256 b) external checked {
        inner.repayPartial(a, b);
    }

    function addCollateral(uint256 a, uint256 b) external checked {
        inner.addCollateral(a, b);
    }

    function triggerDefault(uint256 a) external checked {
        inner.triggerDefault(a);
    }

    /// @dev Pranks the STORED lender: for a retired lender this is the old key.
    function claimAsLender(uint256 a) external checked {
        inner.claimAsLender(a);
    }

    /// @dev Pranks the STORED borrower: for a retired borrower this is the old key.
    function claimAsBorrower(uint256 a) external checked {
        inner.claimAsBorrower(a);
    }

    function warp(uint256 a) external checked {
        inner.warp(a);
    }

    // ═══ Authority steps ═════════════════════════════════════════════════

    /// @notice An actor approves an operator for all its positions. Done
    ///         before a replacement, the operator becomes a stale grantee.
    function approveOperator(uint256 actorSeed) external checked {
        callCount["approveOperator"]++;
        address a = actors[actorSeed % actors.length];
        if (isRetired[a]) return;
        address op = operatorOf[a];
        if (op == address(0)) {
            op = address(uint160(uint256(keccak256(abi.encode("operator", a)))));
            operatorOf[a] = op;
        }
        vm.prank(a);
        try core.setApprovalForAll(op, true) {} catch {}
    }

    /// @notice A protected-account replacement retires `actor` and names a
    ///         fresh replacement wallet.
    function retire(uint256 actorSeed) external checked {
        callCount["retire"]++;
        address a = actors[actorSeed % actors.length];
        if (isRetired[a]) return;
        address nominee = address(uint160(uint256(keccak256(abi.encode("replacement", a)))));
        LibTestProtection.enable(diamond, a, DELAY);
        LibTestProtection.propose(diamond, a, a, nominee);
        vm.warp(block.timestamp + DELAY);
        LibTestProtection.finalizeReplacement(diamond, a);
        (bool retired, address replacement) = core.retiredRecordOf(a);
        if (!retired) return;
        isRetired[a] = true;
        replacementOf[a] = replacement;
        retiredKeys.push(a);
        lastBal[a][usdc] = ERC20Mock(usdc).balanceOf(a);
        lastBal[a][weth] = ERC20Mock(weth).balanceOf(a);
        uint256 n = core.balanceOf(a);
        for (uint256 i; i < n; ++i) {
            uint256 t = core.tokenOfOwnerByIndex(a, i);
            if (expectedHolder[t] == address(0)) trackedTokens.push(t);
            expectedHolder[t] = a;
        }
    }

    /// @notice The old key, its earlier operator, or a fresh approval from
    ///         it, tries to move a position the retired account holds.
    function oldKeyMovesPosition(uint256 keySeed, uint256 tokenSeed, uint256 route) external checked {
        callCount["oldKeyMovesPosition"]++;
        if (retiredKeys.length == 0) return;
        address r = retiredKeys[keySeed % retiredKeys.length];
        uint256 n = core.balanceOf(r);
        if (n == 0) return;
        uint256 t = core.tokenOfOwnerByIndex(r, tokenSeed % n);
        address thief = makeAddr("thief");
        route = route % 3;
        if (route == 0) {
            vm.prank(r);
            try core.transferFrom(r, thief, t) {} catch {}
        } else if (route == 1) {
            address op = operatorOf[r];
            if (op == address(0)) return;
            vm.prank(op);
            try core.transferFrom(r, thief, t) {} catch {}
        } else {
            vm.prank(r);
            try core.approve(thief, t) {} catch {}
            vm.prank(thief);
            try core.transferFrom(r, thief, t) {} catch {}
        }
    }

    /// @notice The old key tries to take what is held for an open loan.
    function oldKeyClaimsHeld(uint256 keySeed, uint256 loanSeed) external checked {
        callCount["oldKeyClaimsHeld"]++;
        if (retiredKeys.length == 0) return;
        uint256 n = inner.loanIdsLength();
        if (n == 0) return;
        address r = retiredKeys[keySeed % retiredKeys.length];
        uint256 loanId = inner.loanIdAt(loanSeed % n);
        vm.prank(r);
        try ClaimFacet(diamond).claimHeldForLender(loanId) {} catch {}
        vm.prank(r);
        try ClaimFacet(diamond).claimHeldForBorrower(loanId) {} catch {}
    }

    /// @notice Anyone moves a retired account's position to its replacement.
    function recover(uint256 keySeed, uint256 tokenSeed) external checked {
        callCount["recover"]++;
        if (retiredKeys.length == 0) return;
        address r = retiredKeys[keySeed % retiredKeys.length];
        uint256 n = core.balanceOf(r);
        if (n == 0) return;
        uint256 t = core.tokenOfOwnerByIndex(r, tokenSeed % n);
        // #3246 part 2 — the replacing wallet asks first and waits the
        // delay, unless the account is locked (then the move stays refused).
        (,, bool locked) = _vaultLockState(r);
        if (!locked) {
            (bool open,) = LibTestProtection.vaultOf(diamond, r).positionMoveState();
            if (!open) LibTestProtection.openPositionMove(diamond, r);
        }
        LibTestPositionNFT.waitOutCooldown(diamond, t);
        uint256[] memory ids = new uint256[](1);
        ids[0] = t;
        vm.prank(makeAddr("anyone"));
        try core.recover(ids) {
            expectedHolder[t] = replacementOf[r];
        } catch {}
    }

    function _vaultLockState(address account) internal returns (bool enabled, bool retired, bool locked) {
        (enabled, locked,,, retired) = LibTestProtection.vaultOf(diamond, account).protectionCore();
    }

    /// @notice A side's manager sets that side's auto-extend caps.
    function sideSetsExtendCaps(uint256 loanSeed, uint8 side, bool enabled, uint16 rate, uint32 ahead)
        external
        checked
    {
        callCount["sideSetsExtendCaps"]++;
        (uint256 loanId, LibVaipakam.Loan memory L) = _pickLoan(loanSeed);
        if (loanId == 0 || L.status != LibVaipakam.LoanStatus.Active) return;
        side = side % 2;
        address m = _managerOfSide(L, side);
        if (m == address(0)) return;
        rate = uint16(bound(rate, 1, 5000));
        uint64 expiry = uint64(block.timestamp + bound(ahead, 1 days, 400 days));
        vm.prank(m);
        bool ok;
        if (side == 0) {
            try AutoLifecycleSettingsFacet(diamond).setAutoExtendLenderCaps(loanId, enabled, 0, rate, expiry) {
                ok = true;
            } catch {}
        } else {
            try AutoLifecycleSettingsFacet(diamond).setAutoExtendBorrowerCaps(loanId, enabled, 0, rate, expiry, 0) {
                ok = true;
            } catch {}
        }
        if (ok) extendGhost[loanId][side] = CapGhost(true, m, enabled, rate, expiry);
    }

    /// @notice The borrower side's manager sets the auto-refinance caps.
    function borrowerSetsRefinanceCaps(uint256 loanSeed, bool enabled, uint16 rate, uint32 ahead) external checked {
        callCount["borrowerSetsRefinanceCaps"]++;
        (uint256 loanId, LibVaipakam.Loan memory L) = _pickLoan(loanSeed);
        if (loanId == 0 || L.status != LibVaipakam.LoanStatus.Active) return;
        address m = _managerOfSide(L, 1);
        if (m == address(0)) return;
        rate = uint16(bound(rate, 1, 5000));
        uint64 expiry = uint64(block.timestamp + bound(ahead, 1 days, 400 days));
        vm.prank(m);
        try AutoLifecycleSettingsFacet(diamond).setAutoRefinanceCaps(loanId, enabled, rate, expiry) {
            refiGhost[loanId] = CapGhost(true, m, enabled, rate, expiry);
        } catch {}
    }

    /// @notice The COUNTERPARTY (or a retired key) tries to set the other
    ///         side's caps. Any success is recorded as a violation by the
    ///         post-step check, which compares against each side's ghost.
    function counterpartySetsCaps(uint256 loanSeed, uint8 targetSide, bool enabled, uint16 rate) external checked {
        callCount["counterpartySetsCaps"]++;
        (uint256 loanId, LibVaipakam.Loan memory L) = _pickLoan(loanSeed);
        if (loanId == 0 || L.status != LibVaipakam.LoanStatus.Active) return;
        targetSide = targetSide % 2;
        address other = _managerOfSide(L, 1 - targetSide);
        if (other == address(0) || other == _managerOfSide(L, targetSide)) return;
        rate = uint16(bound(rate, 1, 5000));
        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.startPrank(other);
        if (targetSide == 0) {
            try AutoLifecycleSettingsFacet(diamond).setAutoExtendLenderCaps(loanId, enabled, 0, rate, expiry) {} catch {}
        } else {
            try AutoLifecycleSettingsFacet(diamond).setAutoExtendBorrowerCaps(loanId, enabled, 0, rate, expiry, 0) {}
                catch {}
            try AutoLifecycleSettingsFacet(diamond).setAutoRefinanceCaps(loanId, enabled, rate, expiry) {} catch {}
        }
        vm.stopPrank();
    }

    /// @notice A side's manager switches the per-loan keeper on or off. The
    ///         flag is shared by both sides today (#3353), so a counterparty
    ///         write changes what the other side set: that is the known gap
    ///         the suite reports separately ({keeperViolation}).
    function sideSetsLoanKeeper(uint256 loanSeed, uint8 side, bool enabled) external checked {
        callCount["sideSetsLoanKeeper"]++;
        (uint256 loanId, LibVaipakam.Loan memory L) = _pickLoan(loanSeed);
        if (loanId == 0) return;
        side = side % 2;
        address m = _managerOfSide(L, side);
        if (m == address(0)) return;
        vm.prank(m);
        try ProfileFacet(diamond).setLoanKeeperEnabled(loanId, keeper, enabled) {
            keeperSet[loanId][side] = true;
            keeperValue[loanId][side] = enabled;
            // The other side's recorded intent is what a write must not move.
            uint8 o = 1 - side;
            if (keeperSet[loanId][o] && keeperValue[loanId][o] != enabled && bytes(keeperViolation).length == 0) {
                keeperViolation = "a side's per-loan keeper write changed the other side's setting (#3353)";
            }
        } catch {}
    }

    // ═══ Per-step checks ═════════════════════════════════════════════════

    modifier checked() {
        _;
        _checkRetiredValue();
        _checkTrackedPositions();
        _checkCaps();
    }

    /// Invariant 1 (value): a retired wallet's balance never rises.
    function _checkRetiredValue() internal {
        for (uint256 i; i < retiredKeys.length; ++i) {
            address r = retiredKeys[i];
            _bal(r, usdc);
            _bal(r, weth);
        }
    }

    function _bal(address r, address asset) internal {
        uint256 b = ERC20Mock(asset).balanceOf(r);
        if (b > lastBal[r][asset] && bytes(valueViolation).length == 0) {
            valueViolation = string.concat("a retired key received value: ", vm.toString(r), " in ", vm.toString(asset));
        }
        lastBal[r][asset] = b;
    }

    /// Invariant 1 (positions): a retired account's position moves only to
    /// its replacement.
    function _checkTrackedPositions() internal {
        for (uint256 i; i < trackedTokens.length; ++i) {
            uint256 t = trackedTokens[i];
            address h = core.holderOf(t);
            address e = expectedHolder[t];
            if (h == e) continue;
            // A recovery the handler did not drive (none today) would still
            // be allowed: the replacement of the expected holder.
            if (isRetired[e] && h == replacementOf[e]) {
                expectedHolder[t] = h;
                continue;
            }
            if (bytes(positionViolation).length == 0) {
                positionViolation = string.concat("a retired account's position moved to ", vm.toString(h));
            }
        }
    }

    /// Invariant 2: a side's caps change only by that side. A change of
    /// the side's manager (a sale, a recovery) ends the record: the new
    /// manager's caps are its own.
    function _checkCaps() internal {
        uint256 n = inner.loanIdsLength();
        for (uint256 i; i < n; ++i) {
            uint256 loanId = inner.loanIdAt(i);
            LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(loanId);
            for (uint8 side; side < 2; ++side) {
                CapGhost memory g = extendGhost[loanId][side];
                if (!g.set || _managerOfSide(L, side) != g.setter) continue;
                LibVaipakam.AutoExtendCaps memory c = side == 0
                    ? AutoLifecycleSettingsFacet(diamond).getAutoExtendLenderCaps(loanId)
                    : AutoLifecycleSettingsFacet(diamond).getAutoExtendBorrowerCaps(loanId);
                if (
                    (c.enabled != g.enabled || c.maxRateBps != g.maxRateBps || c.maxNewExpiry != g.maxNewExpiry)
                        && bytes(capViolation).length == 0
                ) {
                    capViolation = string.concat("extend caps of loan ", vm.toString(loanId), " changed by another party");
                }
            }
            CapGhost memory rg = refiGhost[loanId];
            if (rg.set && _managerOfSide(L, 1) == rg.setter) {
                LibVaipakam.AutoRefinanceCaps memory rc = AutoLifecycleSettingsFacet(diamond).getAutoRefinanceCaps(loanId);
                if (
                    (rc.enabled != rg.enabled || rc.maxRateBps != rg.maxRateBps || rc.maxNewExpiry != rg.maxNewExpiry)
                        && bytes(capViolation).length == 0
                ) {
                    capViolation = string.concat(
                        "refinance caps of loan ", vm.toString(loanId), " changed by another party: got ",
                        rc.enabled ? "on " : "off ", vm.toString(uint256(rc.maxRateBps)), " ", vm.toString(uint256(rc.maxNewExpiry)),
                        " setter ", vm.toString(rc.setter), "; ghost ", rg.enabled ? "on " : "off ",
                        vm.toString(uint256(rg.maxRateBps)), " ", vm.toString(uint256(rg.maxNewExpiry)), " by ", vm.toString(rg.setter)
                    );
                }
            }
        }
    }

    // ═══ Internals ═══════════════════════════════════════════════════════

    function _pickLoan(uint256 seed) internal view returns (uint256 loanId, LibVaipakam.Loan memory L) {
        uint256 n = inner.loanIdsLength();
        if (n == 0) return (0, L);
        loanId = inner.loanIdAt(seed % n);
        L = LoanFacet(diamond).getLoanDetails(loanId);
    }

    /// @dev The wallet that may act for `side` of `L` now: the manager of the
    ///      position's current holder. 0 when the token has no holder or the
    ///      position is closed.
    function _managerOfSide(LibVaipakam.Loan memory L, uint8 side) internal view returns (address) {
        uint256 t = side == 0 ? L.lenderTokenId : L.borrowerTokenId;
        // A closed position's token is retired: it may still sit with its
        // holder, but nobody acts for that side any more.
        if (t == 0 || VaipakamNFTFacet(diamond).isPositionRetired(t)) return address(0);
        address h;
        try core.holderOf(t) returns (address x) {
            h = x;
        } catch {
            return address(0);
        }
        if (h == address(0)) return address(0);
        return ProtectedAccountFacet(diamond).protectionManagerOf(h);
    }

    // ═══ Accessors ═══════════════════════════════════════════════════════

    function retiredKeysLength() external view returns (uint256) {
        return retiredKeys.length;
    }
}
