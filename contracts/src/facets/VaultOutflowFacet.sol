// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibTreasury} from "../libraries/LibTreasury.sol";
import {LibSellerPayAuth} from "../libraries/LibSellerPayAuth.sol";
import {LibAcceptContext} from "../libraries/LibAcceptContext.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibFillLock} from "../libraries/LibFillLock.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {VaultOutflowTypes} from "../vault/VaultOutflowTypes.sol";
import {LibReferral} from "../libraries/LibReferral.sol";

/// @dev The protected-mode payout gate's host (`VaultPayoutFacet`).
interface IVaultOutflowPayoutGate {
    function applyPayoutGate(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external returns (bool held);
}

/// @dev #3246 part 2 — the recovery address in force, read from the paying
///      vault's own record (`VaipakamVaultImplementation.protectionRecovery`).
interface IVaultRecoveryRead {
    function protectionRecovery()
        external
        view
        returns (address inForce, address pending, uint64 pendingAt, bool recovered, uint64 recoveredAt);
}

/**
 * @title  VaultOutflowFacet
 * @author Vaipakam Developer Team
 * @notice THE one Diamond function every movement out of a user vault passes
 *         (#3205 part 2, `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md`
 *         §3.2). It checks the destination against loan state for its class
 *         (layer 1), applies the lien guard and protected mode, calls the
 *         vault's one door ({VaipakamVaultImplementation.transferOut}, which
 *         checks again on its own knowledge: layer 2), measures what arrived,
 *         keeps the tracked ledgers, and emits one {VaultOutflow} per movement.
 *
 * @dev    A facet behind a self-call, not an inlined library (decided default,
 *         2026-11-08): RiskFacet, PrecloseFacet, OfferMatchFacet,
 *         ForcedSaleFacet, AutoLifecycleFacet and RefinanceFacet each had under
 *         1.2 KB of EIP-170 headroom, and every call site already reached the
 *         old withdraw entries through a self-call. Callers reach it only
 *         through `LibVaultOutflow`'s typed helpers, which take only the
 *         arguments their class allows. `onlyDiamondInternal`.
 *
 *         Stage A (decided default, 2026-11-08): the owner-signed lien bound
 *         on the AMOUNT, the class budgets, the payee-receipt release and the
 *         seller-claim check arrive with Stage B (#3379), before any deploy.
 */
contract VaultOutflowFacet is IVaipakamErrors {
    /**
     * @notice One movement out of a vault: whose vault, what, to whom, why.
     * @param owner     The vault's owner.
     * @param vault     The vault it left.
     * @param asset     The token.
     * @param tokenId   The NFT id (0 for ERC-20).
     * @param amount    What the vault sent.
     * @param delivered What `to` received (ERC-20, measured; NFT = `amount`).
     * @param to        Where it went.
     * @param class_    How `to` was established.
     * @param reason    The business reason (`OutflowReason`).
     * @param ref       The loan or offer it belongs to (0 for owner classes).
     * @custom:event-category state-change/vault-mutation
     */
    event VaultOutflow(
        address indexed owner,
        address indexed vault,
        address indexed asset,
        uint256 tokenId,
        uint256 amount,
        uint256 delivered,
        address to,
        VaultOutflowTypes.OutflowClass class_,
        uint8 reason,
        uint256 ref
    );

    /// @notice A just-in-time allowance closed, with what its spender took.
    /// @custom:event-category state-change/vault-mutation
    event VaultGrantSettled(
        address indexed owner,
        address indexed vault,
        address indexed spender,
        address asset,
        uint256 tokenId,
        uint256 consumed,
        uint256 ref
    );

    /// @notice RL-2 — a vault's tracked VPFI fell (byte-identical to
    ///         `VaultFactoryFacet.VaultVpfiDebited`, so its topic is unchanged).
    /// @custom:event-category state-change/vault-mutation
    event VaultVpfiDebited(address indexed user, uint256 amount, address recipient);

    error OnlyDiamondInternal();
    /// @dev The vault's own (layer-2) refusals, re-declared byte-identical
    ///      from {VaipakamVaultImplementation} so this facet's ABI, and so
    ///      the Diamond's combined ABI, names them: they reach a caller as
    ///      reverts bubbled through {_callVault}, and the vault code is not a
    ///      Diamond facet. The policy test pins the selectors equal.
    error OutflowDestinationRefused(VaultOutflowTypes.OutflowClass class_, address to);
    error GrantRefused(VaultOutflowTypes.GrantClass class_, address spender);
    error GrantOpen(uint256 ref);
    error ZeroOutflow();
    /// @dev Layer 1: the destination is not one the class may reach.
    error OutflowRecipientInvalid(VaultOutflowTypes.OutflowClass class_, address to);
    /// @dev A holder class names a position token that does not belong to `ref`.
    error OutflowPositionMismatch(uint256 ref, uint256 positionToken);
    /// @dev The vault call failed without a reason of its own.
    error VaultOutflowFailed();
    /// @dev `user` has no vault (a grant or its close needs an existing one).
    error NoVault();
    /// @dev A grant of nothing.
    error GrantInvalid();
    /// @dev The withdrawal would dip into a lien (same as the retired
    ///      `VaultFactoryFacet.WithdrawWouldUnderflowLien`).
    error WithdrawWouldUnderflowLien(address user, address asset, uint256 tokenId, uint256 amount, uint256 free);

    /// @dev #3432 — a vault movement ran with neither the Diamond's
    ///      reentrancy guard nor a fill lock held.
    error VaultMoveOutsideGuard();

    /// @dev A self-call, and only inside a guarded action (#3432). A vault
    ///      move hands control to someone else (an NFT receiver's hook, a
    ///      grant's spender), and the vault carries no guard of its own, so
    ///      the Diamond must already refuse a re-entry when the move runs:
    ///      its reentrancy guard is held, or a 1inch fill holds the fill lock
    ///      (under which the Diamond's fallback admits only self-calls and
    ///      the order protocol). Checked here, at the one host every vault
    ///      move passes, rather than trusted of every caller.
    modifier onlyDiamondInternal() {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        if (!LibReentrancyGuard.entered() && LibFillLock.heldBy() == bytes32(0)) revert VaultMoveOutsideGuard();
        _;
    }

    /**
     * @notice Move one asset out of `user`'s vault under the policy.
     * @dev    For PositionHolder, Counterparty and MatchedCounterparty the
     *         caller's `o.to` is ignored: the payee is the vault of whoever
     *         holds `o.positionToken` now, resolved (and created if absent)
     *         here. For Treasury, Backstop and DiamondTransient it is ignored
     *         too: the payee comes from configuration. Returns what the
     *         recipient received (ERC-20, never more than `o.amount`), or
     *         `o.amount` when protected mode held the payout instead of paying
     *         it.
     */
    function vaultOutflow(address user, VaultOutflowTypes.Outflow memory o)
        external
        onlyDiamondInternal
        returns (uint256 delivered)
    {
        return _outflow(user, o);
    }

    /**
     * @notice The Owner class through a compact entry: `user`'s vault to
     *         `user`'s own wallet. The same policy as {vaultOutflow}; it exists
     *         so a caller near EIP-170 encodes six scalars instead of the
     *         whole intent struct.
     */
    function vaultOutflowToOwner(address user, uint8 kind, address asset, uint256 tokenId, uint256 amount, uint8 reason)
        external
        onlyDiamondInternal
        returns (uint256 delivered)
    {
        VaultOutflowTypes.Outflow memory o;
        o.kind = VaultOutflowTypes.AssetKind(kind);
        o.asset = asset;
        o.tokenId = tokenId;
        o.amount = amount;
        // #3379 B2 — the account's owner wallet is the vault's own owner
        // record: the account wallet, or the wallet a verified replacement
        // moved it to (the vault pays only that wallet in this class).
        o.to = LibProtectedAccount.manager(user);
        o.class_ = VaultOutflowTypes.OutflowClass.Owner;
        o.reason = reason;
        return _outflow(user, o);
    }

    /**
     * @notice The Diamond-transient class for an ERC-20, through a compact
     *         entry: `user`'s vault to this Diamond, within the transaction,
     *         for loan or offer `ref`. The same policy as {vaultOutflow}; a
     *         forced sale near EIP-170 encodes five scalars.
     */
    function vaultOutflowToDiamondERC20(address user, address asset, uint256 amount, uint256 ref, uint8 reason)
        external
        onlyDiamondInternal
        returns (uint256 delivered)
    {
        VaultOutflowTypes.Outflow memory o;
        o.asset = asset;
        o.amount = amount;
        o.class_ = VaultOutflowTypes.OutflowClass.DiamondTransient;
        o.ref = ref;
        o.reason = reason;
        return _outflow(user, o);
    }

    /**
     * @notice {vaultOutflow} with the intent passed as scalars (no
     *         `counterRef`, which only the matched-counterparty class uses).
     *         The same policy; it exists because building and encoding the
     *         struct in every caller costs bytecode that facets near EIP-170
     *         do not have.
     */
    function vaultOutflowArgs(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address to,
        uint8 class_,
        uint256 ref,
        uint256 positionToken,
        uint8 reason
    ) external onlyDiamondInternal returns (uint256 delivered) {
        VaultOutflowTypes.Outflow memory o;
        o.kind = VaultOutflowTypes.AssetKind(kind);
        o.asset = asset;
        o.tokenId = tokenId;
        o.amount = amount;
        o.to = to;
        o.class_ = VaultOutflowTypes.OutflowClass(class_);
        o.ref = ref;
        o.positionToken = positionToken;
        o.reason = reason;
        return _outflow(user, o);
    }

    function _outflow(address user, VaultOutflowTypes.Outflow memory o) private returns (uint256 delivered) {
        // Nothing to move is a no-op, as a zero withdrawal always was.
        if (o.amount == 0) return 0;
        address proxy = LibFacet.getOrCreateVault(user);
        // Payout rule (2026-11-19) — an amount already in the account's own
        // vault, just released from its lien or reservation, becomes free
        // balance. Nothing moves, so no position mark and no payout gate.
        if (o.class_ == VaultOutflowTypes.OutflowClass.OwnRelease) return _releaseOwn(user, proxy, o);
        // #3413 / #3710 — THE seam for payouts: every outflow that names a
        // loan takes value out of its positions, so its tokens cool down and
        // its state number goes up. A consolidation keeps the value under the
        // lien and is no payout.
        if (_namesLoan(o.class_)) {
            LibPositionNFT.markLoanValueOut(o.ref);
            // A payout to the position the caller itself holds is the
            // holder's own move for itself: that token takes the long wait.
            if (
                o.class_ == VaultOutflowTypes.OutflowClass.PositionHolder
                    || o.class_ == VaultOutflowTypes.OutflowClass.Counterparty
            ) LibPositionNFT.markHolderMove(o.positionToken);
        } else if (o.class_ == VaultOutflowTypes.OutflowClass.OfferHolder) {
            // #3744 — an offer refund takes value out of the offer's own
            // token: its state number goes up and it waits (the long wait
            // when the caller holds it). The token is marked by its id, not
            // through the offer record, so a held refund collected after the
            // offer is gone (retired token, deleted record) is marked too.
            LibPositionNFT.markTokenValueOut(o.positionToken);
            LibPositionNFT.markHolderMove(o.positionToken);
        }
        address payeeOwner = _resolveRecipient(user, o);
        // A listing's lot moving into the vault's own escrow stays under its
        // lien (the escrow counts as part of the vault), so it is not "free"
        // money leaving and the lien guard does not apply to it.
        if (o.class_ != VaultOutflowTypes.OutflowClass.ListingEscrow) _assertFree(user, proxy, o);

        // Protected account mode: a payout to the owner's own wallet (or its
        // controller) is queued, or kept in a locked account's vault. Nothing
        // moves and the tracked balance is unchanged until a release pays it
        // through this same function.
        // #3246 part 2 — a clawback or a recovered account's sweep is not a
        // payout to the owner: it pays the recovery address the vault's own
        // record names, at once, past the queue a lock cancels (4.2).
        if (
            o.class_ != VaultOutflowTypes.OutflowClass.Recovery && LibProtectedAccount.isProtected(user)
                && IVaultOutflowPayoutGate(address(this)).applyPayoutGate(
                    user, _assetType(o.kind), o.asset, o.tokenId, o.amount, o.to
                )
        ) return o.amount;

        // A payment to a protected account's WALLET from anyone else's vault
        // is credited to that account's vault, so it leaves only through its
        // delay. The holder classes pay a vault already. Codex #3489 r5: the
        // Owner class too, when a replacement made its payee (the manager) a
        // different account; an account's own owner payout is never
        // redirected (`_protectedRecipientVault` skips recipient == user).
        address creditTo;
        // #3246 part 2 — a recovery address that is itself a protected
        // account is paid into its own vault the same way.
        if (
            _paysWallet(o.class_) || o.class_ == VaultOutflowTypes.OutflowClass.Owner
                || o.class_ == VaultOutflowTypes.OutflowClass.Recovery
        ) {
            creditTo = _protectedRecipientVault(user, o.to);
            if (creditTo != address(0)) {
                payeeOwner = o.to;
                o.to = creditTo;
            }
        }

        // A holder payout whose payee vault IS the paying vault (the stored
        // party still holds the position) moves nothing: the share stays where
        // it is and only the ledgers change, from held to the owner's own.
        // Skipping the self-transfer keeps a fee-charging token from charging
        // for a move that did not happen. The classes whose payee is DERIVED
        // here (a holder, a stored party, the backstop) are booked on both
        // sides, here or by their settlement. A class whose recipient the
        // CALLER names (an allowlisted address, an incentive payee, a
        // liquidation buyer) may never name the paying vault itself: that
        // would debit the ledger for tokens that never left.
        // ONE rule for whether anything left the paying vault: the tracked
        // ledger, the payee's booking and the VPFI retention-debit event all
        // read it, so the event can never report an outflow the ledger did
        // not book (Codex #3387 r4).
        bool moved = o.to != proxy;
        if (!moved) {
            if (_paysWallet(o.class_)) revert OutflowRecipientInvalid(o.class_, o.to);
            delivered = o.amount;
        } else {
            delivered = _transfer(proxy, o);
        }
        if (o.class_ == VaultOutflowTypes.OutflowClass.ListingEscrow) {
            emit VaultOutflow(user, proxy, o.asset, o.tokenId, o.amount, delivered, o.to, o.class_, o.reason, o.ref);
            return delivered;
        }
        // THE one place both sides of a vault move are booked (Codex #3387
        // r2): the payer's tracked ledger falls, the payee VAULT's owner's
        // rises by what arrived, for every class whose payee is a vault. A
        // same-vault payout moves nothing, so it changes no tracked ledger at
        // all (no withdraw-then-deposit pair, so no intermediate dip in a
        // VPFI holder's tier record): only the depository credit moves.
        if (moved) LibVaipakam.recordVaultWithdraw(user, o.asset, o.tokenId, o.amount);

        // A payee VAULT's owner is credited in the tracked ledger (here, for
        // every vault class; no settlement books the arrival again) and, for a
        // holder payout or a protected wallet's redirected payment, as free
        // money in the depository ledger, which leaves only through that
        // owner's own withdrawal.
        if (creditTo != address(0)) {
            LibProtectedAccount.creditPayment(payeeOwner, o.asset, o.tokenId, o.amount, delivered);
        } else if (payeeOwner != address(0)) {
            if (moved) LibVaipakam.recordVaultDeposit(payeeOwner, o.asset, o.tokenId, delivered);
            // Free money for its owner only for a holder payout and a new
            // loan's principal; a stored party's custody, a consolidation, a
            // matched leg, the backstop's warehouse and a seller's share stay
            // under the settlement's own reservation.
            if (_credits(o.class_)) {
                LibDepositoryLedger.credit(payeeOwner, o.asset, o.tokenId, delivered);
            }
        }

        // A retention debit only when VPFI actually left the vault: a
        // same-vault payout moved nothing and debits nothing.
        if (moved && o.kind == VaultOutflowTypes.AssetKind.ERC20 && o.asset == LibVaipakam.storageSlot().vpfiToken) {
            emit VaultVpfiDebited(user, o.amount, o.to);
        }
        emit VaultOutflow(user, proxy, o.asset, o.tokenId, o.amount, delivered, o.to, o.class_, o.reason, o.ref);
    }

    /**
     * @notice Open a just-in-time allowance on `user`'s vault for this
     *         transaction (§3.5). The vault checks the spender's registry set.
     */
    function vaultGrant(address user, VaultOutflowTypes.Grant calldata g) external onlyDiamondInternal {
        address proxy = _existingVault(user);
        if (g.amount == 0 && g.kind == VaultOutflowTypes.AssetKind.ERC20) revert GrantInvalid();
        // An order-taker grant (the swap-to-repay lot) runs the lien guard,
        // as a withdrawal does: the fill lowers the lien by the lot first, so
        // the grant can expose only what is then free. A conduit grant
        // exposes the LISTED collateral itself, which its lien covers until
        // the sale settles; Stage B (#3379) bounds it by that lien at the
        // vault.
        if (g.class_ == VaultOutflowTypes.GrantClass.OrderTaker) {
            VaultOutflowTypes.Outflow memory probe;
            probe.kind = g.kind;
            probe.asset = g.asset;
            probe.tokenId = g.tokenId;
            probe.amount = g.amount;
            _assertFree(user, proxy, probe);
        }
        _callVault(proxy, abi.encodeCall(VaipakamVaultImplementation.grantAllowance, (g)));
    }

    /**
     * @notice Close `user`'s vault's open allowance and book what its spender
     *         took: the tracked ledger falls by it. Returns it (0 when none
     *         was open).
     */
    function vaultCloseGrant(address user) external onlyDiamondInternal returns (uint256 consumed) {
        address proxy = _existingVault(user);
        (address asset, address spender, uint256 tokenId,, uint256 ref) = VaipakamVaultImplementation(proxy).openGrant();
        if (spender == address(0)) return 0;
        consumed = VaipakamVaultImplementation(proxy).closeGrant();
        if (consumed != 0) {
            LibVaipakam.recordVaultWithdraw(user, asset, tokenId, consumed);
            if (asset == LibVaipakam.storageSlot().vpfiToken) emit VaultVpfiDebited(user, consumed, spender);
        }
        emit VaultGrantSettled(user, proxy, spender, asset, tokenId, consumed, ref);
    }

    // ─── Layer 1 ─────────────────────────────────────────────────────────

    /// @dev Check (and for derived classes, set) `o.to`. Returns the owner of
    ///      the payee vault for the holder classes (to credit it), else 0.
    function _resolveRecipient(address user, VaultOutflowTypes.Outflow memory o) private returns (address payeeOwner) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        VaultOutflowTypes.OutflowClass c = o.class_;
        if (c == VaultOutflowTypes.OutflowClass.Owner) {
            // #3379 B2 — the owner record, which a replacement moves.
            if (o.to != LibProtectedAccount.manager(user)) revert OutflowRecipientInvalid(c, o.to);
        } else if (c == VaultOutflowTypes.OutflowClass.OwnerAllowlisted) {
            address mgr = LibProtectedAccount.manager(user);
            // #3379 B2 — a payout to the owner record (the controller once a
            // replacement moved it) is the Owner class, whichever entry asked:
            // the vault pays the owner record only in that class.
            if (o.to == mgr && mgr != user) {
                o.class_ = VaultOutflowTypes.OutflowClass.Owner;
                return payeeOwner;
            }
            if (o.to == user || !LibProtectedAccount.isProtected(user) || !LibProtectedAccount.isAllowed(user, o.to)) {
                revert OutflowRecipientInvalid(c, o.to);
            }
        } else if (c == VaultOutflowTypes.OutflowClass.MatchedCounterparty) {
            // The match, read from both loans: the paying loan's borrower owns
            // the paying vault and its collateral is the asset, which is the
            // receiving loan's principal. The payee is the receiving loan's
            // STORED lender, whose vault that loan's lender claim reads (the
            // claim then pays the current holder). The settlement books it.
            LibVaipakam.Loan storage paying = s.loans[o.ref];
            LibVaipakam.Loan storage receiving = s.loans[o.counterRef];
            if (
                o.counterRef == 0 || o.counterRef == o.ref || paying.borrower != user || paying.collateralAsset != o.asset
                    || receiving.principalAsset != o.asset
            ) revert OutflowPositionMismatch(o.ref, o.counterRef);
            o.positionToken = receiving.lenderTokenId;
            payeeOwner = receiving.lender;
            o.to = s.userVaipakamVaults[receiving.lender];
            if (o.to == address(0)) revert OutflowRecipientInvalid(c, address(0));
        } else if (
            c == VaultOutflowTypes.OutflowClass.PositionHolder || c == VaultOutflowTypes.OutflowClass.Counterparty
                || c == VaultOutflowTypes.OutflowClass.Consolidation
        ) {
            LibVaipakam.Loan storage loan = s.loans[o.ref];
            if (o.positionToken == 0 || (o.positionToken != loan.lenderTokenId && o.positionToken != loan.borrowerTokenId)) {
                revert OutflowPositionMismatch(o.ref, o.positionToken);
            }
            address holder = LibPositionNFT.core().holderOf(o.positionToken);
            if (holder == address(0)) revert OutflowRecipientInvalid(c, address(0));
            o.to = LibFacet.getOrCreateVault(holder);
            // A consolidation moves custody under the lien: the move books it.
            // A holder payout is free money for the holder: booked here.
            payeeOwner = holder;
        } else if (c == VaultOutflowTypes.OutflowClass.OfferHolder) {
            // #3744 — offer `ref`'s escrow, from its creator's vault (the
            // paying vault) to the vault of whoever holds the offer's
            // position token now. The token must be that offer's, or the
            // token whose held escrow sits in this vault (the offer record
            // may be gone by the time its holder collects).
            LibVaipakam.Offer storage offer = s.offers[o.ref];
            if (
                o.positionToken == 0
                    || !(
                        (offer.positionTokenId == o.positionToken && offer.creator == user)
                            || s.offerTokenHeldFrom[o.positionToken] == user
                    )
            ) revert OutflowPositionMismatch(o.ref, o.positionToken);
            address holder = LibPositionNFT.core().holderOf(o.positionToken);
            if (holder == address(0)) revert OutflowRecipientInvalid(c, address(0));
            o.to = LibFacet.getOrCreateVault(holder);
            payeeOwner = holder;
        } else if (c == VaultOutflowTypes.OutflowClass.ClaimCustody) {
            // The STORED party of the receiving side of THAT loan, from loan
            // state: `o.positionToken` names the side. Its vault must exist
            // (the settlement resolves it first, under the sanctioned lock
            // where that applies). The parked share is not credited to the
            // depository ledger, so that party's own withdrawal cannot take
            // it; the claim pays it on to the current holder.
            LibVaipakam.Loan storage loan = s.loans[o.ref];
            address stored;
            if (o.positionToken != 0 && o.positionToken == loan.lenderTokenId) stored = loan.lender;
            else if (o.positionToken != 0 && o.positionToken == loan.borrowerTokenId) stored = loan.borrower;
            else revert OutflowPositionMismatch(o.ref, o.positionToken);
            payeeOwner = stored;
            o.to = s.userVaipakamVaults[stored];
            if (o.to == address(0)) revert OutflowRecipientInvalid(c, address(0));
        } else if (c == VaultOutflowTypes.OutflowClass.PrincipalToBorrower) {
            // The borrower side of THIS accept of offer `ref`, derived here:
            // for a borrower offer the holder of the offer's position token
            // at the fill (#3744: the offer's rights follow its token, so
            // whoever holds it takes the principal), else the creator while
            // no token is live; for a lender offer the acceptor as the accept
            // recorded it in this transaction. Paid into its vault as free
            // money, which the borrower withdraws.
            LibVaipakam.Offer storage offer = s.offers[o.ref];
            if (offer.offerType == LibVaipakam.OfferType.Borrower) {
                if (offer.positionTokenId != 0) payeeOwner = LibPositionNFT.core().holderOf(offer.positionTokenId);
                if (payeeOwner == address(0)) payeeOwner = offer.creator;
            } else {
                payeeOwner = LibAcceptContext.acceptor(o.ref);
            }
            if (payeeOwner == address(0)) revert OutflowRecipientInvalid(c, address(0));
            o.to = LibFacet.getOrCreateVault(payeeOwner);
        } else if (c == VaultOutflowTypes.OutflowClass.Treasury) {
            // #3569 — the treasury the paying vault's own code names, which
            // is the only treasury that vault will pay.
            o.to = LibTreasury.ofVault(s.userVaipakamVaults[user]);
        } else if (c == VaultOutflowTypes.OutflowClass.Backstop) {
            // The backstop's own Vaipakam vault, where it holds what it
            // absorbs. The settlement books the arrival (tracked ledger).
            address backstop = LibVaipakam.getBackstopVault();
            if (backstop == address(0)) revert OutflowRecipientInvalid(c, address(0));
            payeeOwner = backstop;
            o.to = LibFacet.getOrCreateVault(backstop);
        } else if (c == VaultOutflowTypes.OutflowClass.DiamondTransient) {
            o.to = address(this);
        } else if (c == VaultOutflowTypes.OutflowClass.Recovery) {
            // #3246 part 2 — the recovery address in force on the paying
            // vault's own record; the caller names none.
            (address r,,,,) = IVaultRecoveryRead(s.userVaipakamVaults[user]).protectionRecovery();
            if (r == address(0)) revert OutflowRecipientInvalid(c, address(0));
            o.to = r;
        } else if (c == VaultOutflowTypes.OutflowClass.SwapAdapter) {
            if (!_isSwapAdapter(s, o.to)) revert OutflowRecipientInvalid(c, o.to);
        } else if (c == VaultOutflowTypes.OutflowClass.ListingEscrow) {
            // This vault's own escrow for the listing whose key the outflow
            // carries (in `positionToken`); the escrow counts as part of the
            // vault, so the move changes no ledger.
            if (o.positionToken == 0 || o.kind != VaultOutflowTypes.AssetKind.ERC1155) {
                revert OutflowRecipientInvalid(c, o.to);
            }
            o.to = VaipakamVaultImplementation(s.userVaipakamVaults[user]).listingEscrowAddress(bytes32(o.positionToken));
        } else if (c == VaultOutflowTypes.OutflowClass.SellerClaim) {
            // A prior seller of THIS loan (#1209), paid exactly what the
            // seller-claim settlement authorized for it in this transaction
            // (LibSellerPayAuth, single-use). Never checked against the
            // loan's seller-claim list: the terminal split deletes it before
            // it pays. The vault is that seller's own.
            LibSellerPayAuth.consume(o.ref, o.to, o.amount);
            payeeOwner = o.to;
            o.to = s.userVaipakamVaults[o.to];
            if (o.to == address(0)) revert OutflowRecipientInvalid(c, address(0));
        } else if (c == VaultOutflowTypes.OutflowClass.IntegratorShare) {
            // #3682 — `o.to` names the integrator; the payee is its payout
            // account, read from the registry, and only an active entry is
            // paid. Free money for that account, which it withdraws through
            // the ordinary payout.
            LibVaipakam.IntegratorEntry storage e = s.integrators[o.to];
            if (e.status != LibVaipakam.IntegratorStatus.Active) revert OutflowRecipientInvalid(c, o.to);
            payeeOwner = e.payout;
            o.to = LibFacet.getOrCreateVault(payeeOwner);
        } else if (c == VaultOutflowTypes.OutflowClass.ReferralShare) {
            // #3722 — `o.to` names the new user; the payee is the inviter its
            // own binding names, only inside its period. Paid to the inviter's
            // wallet (a protected inviter's vault, below).
            o.to = LibReferral.activeInviter(o.to);
            if (o.to == address(0) || o.to == address(this)) revert OutflowRecipientInvalid(c, o.to);
        } else {
            // Incentive, LiquidationBuyer: the caller names the actor; never
            // this Diamond or a vault-less zero.
            if (o.to == address(0) || o.to == address(this)) revert OutflowRecipientInvalid(c, o.to);
        }
    }

    /// @dev The own-balance release (OwnRelease). The caller has just dropped
    ///      a lien or reservation on `user`'s own vault by exactly `o.amount`;
    ///      the lien guard then confirms the vault holds it unencumbered, and
    ///      the depository ledger rises by it. The credit is capped so the
    ///      ledger never exceeds the vault's unencumbered balance: a ledger
    ///      already at or above it (a VPFI figure the depository does not
    ///      debit on every spend, see LibDepositoryLedger) loses nothing,
    ///      since the withdrawal is bounded by that balance anyway, and a
    ///      release can never create a credit tokens do not back.
    function _releaseOwn(address user, address proxy, VaultOutflowTypes.Outflow memory o)
        private
        returns (uint256)
    {
        uint256 free = LibEncumbrance.vaultFree(user, o.kind == VaultOutflowTypes.AssetKind.ERC20, o.asset, o.tokenId);
        if (o.amount > free) revert WithdrawWouldUnderflowLien(user, o.asset, o.tokenId, o.amount, free);
        uint256 held = LibDepositoryLedger.holding(user, o.asset, o.tokenId);
        uint256 room = free > held ? free - held : 0;
        LibDepositoryLedger.credit(user, o.asset, o.tokenId, o.amount < room ? o.amount : room);
        emit VaultOutflow(user, proxy, o.asset, o.tokenId, o.amount, o.amount, proxy, o.class_, o.reason, o.ref);
        return o.amount;
    }

    /// @dev The lien guard: the amount must be free (balance, capped by the
    ///      tracked ledger so unsolicited dust never counts, less the active
    ///      liens on it). Terminal paths release their lien before paying.
    function _assertFree(address user, address, VaultOutflowTypes.Outflow memory o) private view {
        // THE vault free-balance rule (LibEncumbrance.vaultFree), shared with
        // the depository's withdrawal gate.
        uint256 free = LibEncumbrance.vaultFree(user, o.kind == VaultOutflowTypes.AssetKind.ERC20, o.asset, o.tokenId);
        if (o.amount > free) revert WithdrawWouldUnderflowLien(user, o.asset, o.tokenId, o.amount, free);
    }

    // ─── The move ────────────────────────────────────────────────────────

    /// @dev Call the vault's one door and measure the delivery. ERC-20: the
    ///      vault may lose no more than `amount` (a token charging its sender
    ///      would take the excess from the holder's other positions) and the
    ///      return is what `to` received (#2440). NFT: the vault's transfer is
    ///      exact, or the call reverts.
    function _transfer(address proxy, VaultOutflowTypes.Outflow memory o) private returns (uint256 delivered) {
        if (o.kind != VaultOutflowTypes.AssetKind.ERC20) {
            _callVault(proxy, abi.encodeCall(VaipakamVaultImplementation.transferOut, (o)));
            if (o.kind == VaultOutflowTypes.AssetKind.ERC721 && IERC721(o.asset).ownerOf(o.tokenId) != o.to) {
                revert VaultOutflowFailed();
            }
            return o.amount;
        }
        uint256 proxyBefore = IERC20(o.asset).balanceOf(proxy);
        uint256 toBefore = IERC20(o.asset).balanceOf(o.to);
        _callVault(proxy, abi.encodeCall(VaipakamVaultImplementation.transferOut, (o)));
        LibDelivery.requireNoOverDebit(o.asset, proxy, proxyBefore, o.amount);
        delivered = LibDelivery.measured(o.asset, proxy, o.to, toBefore, o.amount);
    }

    function _callVault(address proxy, bytes memory data) private {
        (bool ok, bytes memory ret) = proxy.call(data);
        if (!ok) {
            if (ret.length == 0) revert VaultOutflowFailed();
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _existingVault(address user) private view returns (address proxy) {
        proxy = LibVaipakam.storageSlot().userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();
    }

    /// @dev The classes whose recipient is a wallet the caller names, which a
    ///      protected payee receives into its vault instead.
    /// @dev The classes whose arrival is the payee's own free money.
    function _credits(VaultOutflowTypes.OutflowClass c) private pure returns (bool) {
        return c == VaultOutflowTypes.OutflowClass.PositionHolder || c == VaultOutflowTypes.OutflowClass.Counterparty
            || c == VaultOutflowTypes.OutflowClass.PrincipalToBorrower
            || c == VaultOutflowTypes.OutflowClass.IntegratorShare
            || c == VaultOutflowTypes.OutflowClass.OfferHolder;
    }

    function _paysWallet(VaultOutflowTypes.OutflowClass c) private pure returns (bool) {
        return c == VaultOutflowTypes.OutflowClass.OwnerAllowlisted || c == VaultOutflowTypes.OutflowClass.Incentive
            || c == VaultOutflowTypes.OutflowClass.LiquidationBuyer
            || c == VaultOutflowTypes.OutflowClass.ReferralShare;
    }

    /// @dev #3710 — the classes whose `ref` is a loan the movement takes value
    ///      out of. Consolidation names a loan but keeps the value under its
    ///      lien. A class whose `ref` may be a loan or an offer (treasury,
    ///      backstop, the Diamond, an incentive) is not here: when it carries
    ///      a loan's collateral away, the collateral writer marks the loan.
    function _namesLoan(VaultOutflowTypes.OutflowClass c) private pure returns (bool) {
        return c == VaultOutflowTypes.OutflowClass.PositionHolder || c == VaultOutflowTypes.OutflowClass.Counterparty
            || c == VaultOutflowTypes.OutflowClass.MatchedCounterparty
            || c == VaultOutflowTypes.OutflowClass.ClaimCustody || c == VaultOutflowTypes.OutflowClass.SellerClaim
            || c == VaultOutflowTypes.OutflowClass.LiquidationBuyer;
    }

    /// @dev Where a payout from `user`'s vault to `recipient` must land instead
    ///      of `recipient`'s wallet: its vault when `recipient` has protected
    ///      mode on (and is not `user`), else 0.
    function _protectedRecipientVault(address user, address recipient) private view returns (address) {
        if (recipient == user) return address(0);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibProtectedAccount.isProtected(recipient)) return address(0);
        return s.userVaipakamVaults[recipient];
    }

    function _isSwapAdapter(LibVaipakam.Storage storage s, address who) private view returns (bool) {
        address[] storage list = s.swapAdapters;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) return true;
        }
        return false;
    }

    function _assetType(VaultOutflowTypes.AssetKind k) private pure returns (uint8) {
        if (k == VaultOutflowTypes.AssetKind.ERC20) return uint8(LibVaipakam.AssetType.ERC20);
        if (k == VaultOutflowTypes.AssetKind.ERC721) return uint8(LibVaipakam.AssetType.ERC721);
        return uint8(LibVaipakam.AssetType.ERC1155);
    }
}
