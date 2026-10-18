// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "../crosschain/ICrossChainMessenger.sol";
import {SanctionsList} from "./SanctionsList.sol";
import {SANCTIONS_CLEARANCE_WIRE_VERSION} from "./SanctionsClearanceAttestor.sol";
import {LibOracleFreshness} from "./LibOracleFreshness.sol";

/**
 * @title  SanctionsDelistingTimelock
 * @notice Automated delisting for a {SanctionsList}, under a waiting window
 *         the multisig can veto, gated on RedStone's Sanctions Oracle no
 *         longer flagging the address (#2443, owner decision 2026-10-18:
 *         "bot proposes, Safe vetoes").
 *
 * @dev    The list splits its signers by direction: an adder may only list,
 *         a remover (the Safe) may also delist. Delisting lets a sanctioned
 *         wallet back in, so this contract does not make it unattended. It
 *         is appointed as a SECOND remover and adds three things in front of
 *         every delisting it applies:
 *
 *         1. **Provenance.** A proposer (the delister bot) may propose only
 *            addresses the list records, against the OFAC publication the
 *            list itself records, and no more of them than that publication
 *            declared outstanding (`pendingDelistings`). The bot's reading
 *            of the OFAC files is off-chain; what the contract can check, it
 *            checks.
 *
 *         2. **A waiting window the Safe can veto.** Nothing executes until
 *            `delay` has passed (owner-set, 1 to 30 days, 48 hours by
 *            default; fixed per proposal when it is made). During it the
 *            Safe — any remover of the list — or the owner may cancel, and
 *            that cancel is a VETO that sticks to each address: the bot
 *            cannot propose it again until the Safe or the owner lifts it
 *            ({setVetoed}), so a vetoed wallet does not come back every
 *            window. The Safe may also veto before any proposal. The
 *            Safe also keeps its own direct delist through
 *            `SanctionsList.applyUpdate` for emergencies; this contract
 *            changes nothing about the Safe's powers.
 *
 *         3. **RedStone must agree, and be current.** OFAC's file is one
 *            source; RedStone's Sanctions Oracle is an independent on-chain
 *            one. At execution, every address must be unflagged by it, and
 *            the oracle's own last update (`getLastUpdateBlockTimestamp()`)
 *            must be known and no older than `oracleMaxAge` — a frozen
 *            oracle still answers "not flagged" for every address it never
 *            listed, which would make this check say nothing:
 *            - where the list has RedStone as its secondary on THIS chain,
 *              read live (`GateMode.Local`); a revert propagates, so an
 *              oracle that cannot answer blocks the delisting (fail closed);
 *            - otherwise, through a CCIP answer sent from a chain where
 *              RedStone is deployed by `SanctionsClearanceAttestor`
 *              (`GateMode.CrossChain`). After the window ends anyone may
 *              {requestClearance}, which issues an unpredictable challenge
 *              for the proposal; only an answer echoing it, for exactly the
 *              proposal's addresses, counts. So the reading was taken after
 *              the window by causality, not by comparing two chains' clocks.
 *              One flagged answer marks the challenge flagged for good,
 *              whatever else arrives, so conflicting answers fail closed.
 *              The challenge is usable for `clearanceMaxAge` after it is
 *              issued, measured on this chain's clock;
 *            - with neither configured, execution reverts
 *              {ClearanceUnavailable}: the automated route is closed and
 *              only the Safe's manual delist remains.
 *
 *         Execution itself is permissionless once all three hold, and it
 *         applies the delisting as a repeat of the recorded publication, so
 *         the list's own rules (version, publication ordering, the pending
 *         counts) still apply.
 *
 *         A new OFAC publication can land during the window (the adder runs
 *         daily). The proposal names the publication it was checked against,
 *         so execution would then refuse it ({PublicationChanged}); the
 *         proposer re-checks the address against the new file and
 *         {reconfirm}s it, which moves the proposal to the new publication
 *         WITHOUT restarting the window — the decision the Safe has been
 *         given time to veto has not changed.
 *
 *         Residual risk, stated: a stolen proposer key can propose wrongful
 *         delistings. Each needs the list to record the address, the window
 *         to pass with no veto, and a current RedStone not to flag it. The owner can
 *         remove the proposer at once, and the Safe can cancel every pending
 *         proposal. A stolen proposer key cannot shorten the window or skip
 *         the RedStone check.
 */
contract SanctionsDelistingTimelock is Ownable2Step, ICrossChainMessageRecipient {
    // ── Types ─────────────────────────────────────────────────────────

    /// @notice A proposal's lifecycle. `None` is an id never issued.
    enum Status {
        None,
        Pending,
        Cancelled,
        Executed
    }

    /// @notice Which RedStone check an execution passed.
    enum GateMode {
        Local,
        CrossChain
    }

    /// @notice One proposed batch of delistings.
    /// @param accountsHash `keccak256(abi.encode(accounts))`, which a
    ///                     cross-chain answer must match.
    struct Proposal {
        Status status;
        address proposer;
        uint32 publicationDate;
        uint64 createdAt;
        uint64 eta;
        bytes32 sourceHash;
        bytes32 accountsHash;
        address[] accounts;
    }

    /// @notice Where a proposal's cross-chain RedStone check stands.
    ///         `None`: no challenge issued. `Requested`: issued, no answer
    ///         yet. `Cleared`: every answer so far said "not flagged".
    ///         `Flagged`: at least one answer flagged an address; it stays
    ///         so for this challenge whatever arrives later.
    enum ClearanceState {
        None,
        Requested,
        Cleared,
        Flagged
    }

    /// @notice A proposal's current clearance challenge and its answer.
    /// @param challenge       The value an answer must echo.
    /// @param issuedAt        When it was issued, on this chain's clock; it
    ///                        is usable until `issuedAt + clearanceMaxAge`.
    /// @param oracleUpdatedAt The freshest oracle last-update time any
    ///                        "not flagged" answer reported (clamped to this
    ///                        chain's clock); 0 when none reported one.
    /// @param epoch           The clearance-source configuration it was
    ///                        issued under; a change of source voids it.
    /// @param state           See {ClearanceState}.
    struct ClearanceChallenge {
        bytes32 challenge;
        uint64 issuedAt;
        uint64 oracleUpdatedAt;
        uint32 epoch;
        ClearanceState state;
    }

    /// @notice Why an inbound answer was ignored rather than recorded.
    enum IgnoreReason {
        UnknownChallenge,
        Superseded,
        ProposalClosed,
        AccountsMismatch
    }

    // ── Constants ─────────────────────────────────────────────────────

    /// @notice Bounds and default for the waiting window.
    uint32 public constant MIN_DELAY = 1 days;
    uint32 public constant MAX_DELAY = 30 days;
    uint32 public constant DEFAULT_DELAY = 2 days;

    /// @notice Bounds and default for how long a clearance challenge stays
    ///         usable after it is issued.
    uint32 public constant MIN_CLEARANCE_MAX_AGE = 1 hours;
    uint32 public constant MAX_CLEARANCE_MAX_AGE = 7 days;
    uint32 public constant DEFAULT_CLEARANCE_MAX_AGE = 1 days;

    /// @notice Bounds and default for how long ago RedStone may last have
    ///         updated when an execution relies on it. RedStone publishes no
    ///         update cadence for its Sanctions Oracle, so the default is
    ///         generous; an oracle quieter than this closes the automated
    ///         route (the Safe's direct delist is unaffected).
    uint32 public constant MIN_ORACLE_MAX_AGE = 1 days;
    uint32 public constant MAX_ORACLE_MAX_AGE = 30 days;
    uint32 public constant DEFAULT_ORACLE_MAX_AGE = 7 days;

    /// @notice The most addresses one proposal may carry, so one execution
    ///         always fits a block.
    uint256 public constant MAX_BATCH = 100;

    // ── Storage ───────────────────────────────────────────────────────

    /// @notice The list this contract delists from, as one of its removers.
    SanctionsList public immutable list;

    /// @notice Who may propose and reconfirm (the delister bot).
    mapping(address account => bool enabled) public isProposer;

    /// @notice The waiting window applied to NEW proposals, in seconds.
    uint32 public delay = DEFAULT_DELAY;

    /// @notice How long a clearance challenge stays usable, seconds.
    uint32 public clearanceMaxAge = DEFAULT_CLEARANCE_MAX_AGE;

    /// @notice The oldest RedStone's own last update may be when used.
    uint32 public oracleMaxAge = DEFAULT_ORACLE_MAX_AGE;

    /// @notice The messenger allowed to deliver clearances; zero when the
    ///         cross-chain route is not configured.
    address public clearanceMessenger;

    /// @notice The chain the attestor reads RedStone on.
    uint256 public clearanceSourceChainId;

    /// @notice The attestor contract on that chain.
    address public clearanceAttestor;

    /// @notice Bumped on every clearance-source change, so a challenge
    ///         issued under an earlier source never counts.
    uint32 public clearanceEpoch;

    /// @notice Each proposal's current clearance challenge.
    mapping(uint256 id => ClearanceChallenge) public clearanceOf;

    /// @notice The proposal a live challenge belongs to, or 0.
    mapping(bytes32 challenge => uint256 id) public proposalOfChallenge;

    /// @dev Makes every challenge distinct, even two in one block.
    uint256 private _challengeNonce;

    /// @notice Proposals issued so far; ids start at 1.
    uint256 public proposalCount;

    mapping(uint256 id => Proposal) private _proposals;

    /// @notice The pending proposal naming `account`, or 0. An address is in
    ///         at most one pending proposal at a time.
    mapping(address account => uint256 id) public proposalOf;

    /// @notice The Safe (or the owner) has vetoed delisting `account`. A veto
    ///         sticks: the address cannot be proposed again, and a pending
    ///         proposal naming it cannot execute, until the Safe or the owner
    ///         lifts it. OFAC's file may keep calling for the delisting
    ///         meanwhile; the list keeps it counted in `pendingDelistings`,
    ///         so the disagreement stays visible rather than resolved by
    ///         repetition.
    mapping(address account => bool) public vetoed;

    // ── Events ────────────────────────────────────────────────────────

    /// @custom:event-category informational/admin
    event ProposerSet(address indexed account, bool enabled);
    /// @custom:event-category informational/admin
    event DelaySet(uint32 previousDelay, uint32 newDelay);
    /// @custom:event-category informational/admin
    event ClearanceMaxAgeSet(uint32 previousMaxAge, uint32 newMaxAge);
    /// @custom:event-category informational/admin
    event OracleMaxAgeSet(uint32 previousMaxAge, uint32 newMaxAge);
    /// @custom:event-category informational/admin
    event ClearanceSourceSet(
        uint32 indexed epoch, address indexed messenger, uint256 sourceChainId, address indexed attestor
    );
    /// @custom:event-category state-change/compliance
    event DelistingProposed(
        uint256 indexed id,
        address indexed proposer,
        address[] accounts,
        bytes32 sourceHash,
        uint32 publicationDate,
        uint64 eta
    );
    /// @custom:event-category state-change/compliance
    event DelistingReconfirmed(
        uint256 indexed id,
        bytes32 previousSourceHash,
        uint32 previousPublicationDate,
        bytes32 sourceHash,
        uint32 publicationDate
    );
    /// @custom:event-category state-change/compliance
    event DelistingCancelled(uint256 indexed id, address indexed by);
    /// @custom:event-category state-change/compliance
    event VetoSet(address indexed account, bool vetoed, address indexed by);
    /// @custom:event-category state-change/compliance
    event DelistingExecuted(uint256 indexed id, address indexed by, GateMode gate, uint64 listVersion);
    /// @custom:event-category informational/compliance
    event ClearanceRequested(
        uint256 indexed id, bytes32 indexed challenge, uint32 indexed epoch, uint64 expiresAt, address[] accounts
    );
    /// @notice An answer was recorded. `state` is the challenge's state
    ///         after it: an answer saying "not flagged" leaves a flagged
    ///         challenge flagged.
    /// @custom:event-category informational/compliance
    event ClearanceAnswered(
        uint256 indexed id, bytes32 indexed challenge, bool[] flagged, uint64 oracleUpdatedAt, ClearanceState state
    );
    /// @custom:event-category informational/compliance
    event ClearanceIgnored(bytes32 indexed challenge, uint256 indexed id, IgnoreReason reason);

    // ── Errors ────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotAContract(address candidate);
    error RenounceDisabled();
    error NotProposer(address caller);
    error NotCanceller(address caller);
    /// @notice Only the Safe (any remover of the list) or the owner may veto.
    error NotVetoer(address caller);
    /// @notice The Safe or the owner has vetoed delisting this address.
    error Vetoed(address account);
    error DelayOutOfRange(uint32 value);
    error ClearanceMaxAgeOutOfRange(uint32 value);
    error OracleMaxAgeOutOfRange(uint32 value);
    error InvalidClearanceSource();
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    /// @notice The proposal names a publication the list does not record.
    error PublicationMismatch(bytes32 sourceHash, uint32 publicationDate, bytes32 recordedHash, uint32 recordedDate);
    /// @notice The list moved to a newer publication since the proposal was
    ///         made or reconfirmed; {reconfirm} it against the new one.
    error PublicationChanged(uint256 id, bytes32 recordedHash, uint32 recordedDate);
    /// @notice A reconfirmation must name the list's current publication,
    ///         and it must differ from the proposal's.
    error NothingToReconfirm(uint256 id);
    error ExceedsPendingDelistings(uint256 requested, uint32 pending);
    error NotListedByOwnList(address account);
    error AlreadyProposed(address account, uint256 id);
    error NotPending(uint256 id, Status status);
    error TooEarly(uint256 id, uint64 eta);
    /// @notice RedStone, read live on this chain, flags the address; it may
    ///         not be delisted.
    error StillSanctioned(address account);
    /// @notice RedStone reports no usable last-update time (none, zero, or
    ///         in the future), so its "not flagged" cannot be relied on.
    error OracleFreshnessUnknown(GateMode gate);
    /// @notice RedStone last updated longer ago than `oracleMaxAge`.
    error OracleStale(GateMode gate, uint256 lastUpdate, uint32 maxAge);
    /// @notice The local RedStone secondary is the gate on this chain; a
    ///         cross-chain challenge would not be used.
    error LocalGateInUse();
    /// @notice The proposal's challenge is still usable; a new one may be
    ///         issued once it expires.
    error ClearanceOutstanding(uint256 id, bytes32 challenge, uint64 expiresAt);
    /// @notice No challenge under the current source: {requestClearance}.
    error ClearanceNotRequested(uint256 id);
    /// @notice The challenge has expired: {requestClearance} again.
    error ClearanceExpired(uint256 id, uint64 expiredAt);
    /// @notice The challenge has had no answer yet.
    error ClearanceNotAnswered(uint256 id, bytes32 challenge);
    /// @notice An answer to the challenge flagged at least one address.
    error ClearanceFlagged(uint256 id, bytes32 challenge);
    /// @notice Neither a local RedStone secondary nor a cross-chain clearance
    ///         source is configured: only the Safe's manual delist remains.
    error ClearanceUnavailable();
    error NotMessenger(address caller);
    error UnauthorizedClearanceSender(uint256 sourceChainId, address sourceSender);
    error UnexpectedTokens();
    error UnsupportedClearanceVersion(uint16 got);
    error LengthMismatch(uint256 accounts, uint256 flags);

    // ── Construction ──────────────────────────────────────────────────

    /// @param owner_ The chain's admin, which also owns the list.
    /// @param list_  The list to delist from. Appoint this contract as its
    ///               remover after deploying it.
    constructor(address owner_, SanctionsList list_) Ownable(owner_) {
        if (address(list_) == address(0)) revert ZeroAddress();
        if (address(list_).code.length == 0) revert NotAContract(address(list_));
        list = list_;
        emit DelaySet(0, DEFAULT_DELAY);
        emit ClearanceMaxAgeSet(0, DEFAULT_CLEARANCE_MAX_AGE);
        emit OracleMaxAgeSet(0, DEFAULT_ORACLE_MAX_AGE);
    }

    // ── Owner configuration ───────────────────────────────────────────

    /// @notice Disabled: an ownerless timelock could never be reconfigured.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Appoint or remove a proposer.
    function setProposer(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isProposer[account] = enabled;
        emit ProposerSet(account, enabled);
    }

    /// @notice Set the waiting window for proposals made from now on.
    ///         Pending proposals keep the eta they were given.
    function setDelay(uint32 newDelay) external onlyOwner {
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) revert DelayOutOfRange(newDelay);
        emit DelaySet(delay, newDelay);
        delay = newDelay;
    }

    /// @notice Set how long a clearance challenge stays usable after it is
    ///         issued. Applies to existing challenges too, since it is read
    ///         at use.
    function setClearanceMaxAge(uint32 newMaxAge) external onlyOwner {
        if (newMaxAge < MIN_CLEARANCE_MAX_AGE || newMaxAge > MAX_CLEARANCE_MAX_AGE) {
            revert ClearanceMaxAgeOutOfRange(newMaxAge);
        }
        emit ClearanceMaxAgeSet(clearanceMaxAge, newMaxAge);
        clearanceMaxAge = newMaxAge;
    }

    /// @notice Set how long ago RedStone may last have updated when an
    ///         execution relies on it.
    function setOracleMaxAge(uint32 newMaxAge) external onlyOwner {
        if (newMaxAge < MIN_ORACLE_MAX_AGE || newMaxAge > MAX_ORACLE_MAX_AGE) {
            revert OracleMaxAgeOutOfRange(newMaxAge);
        }
        emit OracleMaxAgeSet(oracleMaxAge, newMaxAge);
        oracleMaxAge = newMaxAge;
    }

    /// @notice Configure where RedStone clearances come from, or pass all
    ///         zeros to turn the cross-chain route off. Every call starts a
    ///         new epoch, so a challenge issued under the old source, and any
    ///         answer to it, no longer counts.
    /// @param messenger     This chain's `ICrossChainMessenger`.
    /// @param sourceChainId The chain the attestor reads RedStone on.
    /// @param attestor      The `SanctionsClearanceAttestor` there.
    function setClearanceSource(address messenger, uint256 sourceChainId, address attestor) external onlyOwner {
        bool off = messenger == address(0) && sourceChainId == 0 && attestor == address(0);
        if (!off) {
            if (messenger == address(0) || sourceChainId == 0 || attestor == address(0)) {
                revert InvalidClearanceSource();
            }
            if (messenger.code.length == 0) revert NotAContract(messenger);
        }
        clearanceMessenger = messenger;
        clearanceSourceChainId = sourceChainId;
        clearanceAttestor = attestor;
        uint32 epoch = ++clearanceEpoch;
        emit ClearanceSourceSet(epoch, messenger, sourceChainId, attestor);
    }

    // ── Proposals ─────────────────────────────────────────────────────

    /// @notice Propose delisting `accounts`, as the OFAC publication the
    ///         list records calls for.
    /// @param accounts        Addresses the list records; none already in a
    ///                        pending proposal.
    /// @param sourceHash      SHA-256 of the publication; must be the list's.
    /// @param publicationDate Its date, `YYYYMMDD`; must be the list's.
    /// @return id The new proposal's id.
    function propose(address[] calldata accounts, bytes32 sourceHash, uint32 publicationDate)
        external
        returns (uint256 id)
    {
        if (!isProposer[msg.sender]) revert NotProposer(msg.sender);
        uint256 n = accounts.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        _requireRecordedPublication(sourceHash, publicationDate);
        uint32 pending = list.pendingDelistings();
        if (n > pending) revert ExceedsPendingDelistings(n, pending);

        id = ++proposalCount;
        for (uint256 i; i < n; ++i) {
            address account = accounts[i];
            if (!list.listedByOwnList(account)) revert NotListedByOwnList(account);
            if (vetoed[account]) revert Vetoed(account);
            uint256 existing = proposalOf[account];
            // Also catches a duplicate within this batch.
            if (existing != 0) revert AlreadyProposed(account, existing);
            proposalOf[account] = id;
        }
        uint64 eta = uint64(block.timestamp) + delay;
        Proposal storage p = _proposals[id];
        p.status = Status.Pending;
        p.proposer = msg.sender;
        p.publicationDate = publicationDate;
        p.createdAt = uint64(block.timestamp);
        p.eta = eta;
        p.sourceHash = sourceHash;
        p.accountsHash = keccak256(abi.encode(accounts));
        p.accounts = accounts;
        emit DelistingProposed(id, msg.sender, accounts, sourceHash, publicationDate, eta);
    }

    /// @notice Move a pending proposal to the publication the list now
    ///         records, after the proposer has re-checked its addresses
    ///         against that file. The eta is unchanged.
    function reconfirm(uint256 id, bytes32 sourceHash, uint32 publicationDate) external {
        if (!isProposer[msg.sender]) revert NotProposer(msg.sender);
        Proposal storage p = _pending(id);
        _requireRecordedPublication(sourceHash, publicationDate);
        if (sourceHash == p.sourceHash && publicationDate == p.publicationDate) revert NothingToReconfirm(id);
        emit DelistingReconfirmed(id, p.sourceHash, p.publicationDate, sourceHash, publicationDate);
        p.sourceHash = sourceHash;
        p.publicationDate = publicationDate;
    }

    /// @notice Cancel a pending proposal. The Safe (any remover of the
    ///         list) or the owner may cancel at any time before execution,
    ///         and their cancel is a VETO: every address in the proposal is
    ///         marked {vetoed}, so the bot cannot bring it back. A proposer
    ///         may also cancel, which only withdraws the proposal (it found
    ///         a reason to stop) and vetoes nothing.
    function cancel(uint256 id) external {
        bool vetoer = _isVetoer(msg.sender);
        if (!vetoer && !isProposer[msg.sender]) revert NotCanceller(msg.sender);
        Proposal storage p = _pending(id);
        p.status = Status.Cancelled;
        address[] memory accounts = p.accounts;
        _release(accounts);
        emit DelistingCancelled(id, msg.sender);
        if (vetoer) {
            for (uint256 i; i < accounts.length; ++i) {
                _setVeto(accounts[i], true);
            }
        }
    }

    /// @notice Veto, or lift a veto on, delisting `accounts`. The Safe (any
    ///         remover of the list) or the owner only. A veto may be set
    ///         before any proposal exists, and blocks a pending proposal
    ///         naming the address from executing.
    function setVetoed(address[] calldata accounts, bool vetoed_) external {
        if (!_isVetoer(msg.sender)) revert NotVetoer(msg.sender);
        for (uint256 i; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            _setVeto(accounts[i], vetoed_);
        }
    }

    /// @notice Apply a matured proposal. Anyone may call it.
    /// @dev    Checks, in order: pending, matured, publication unchanged,
    ///         within the publication's outstanding delistings, not vetoed,
    ///         a current RedStone clears every address ({checkExecutable} is
    ///         the same sequence). Then delists through the list as a repeat
    ///         of the recorded publication.
    function execute(uint256 id) external {
        (Proposal storage p, GateMode gate) = _checkExecutable(id);
        address[] memory accounts = p.accounts;
        uint32 pending = list.pendingDelistings();

        p.status = Status.Executed;
        _release(accounts);
        uint64 version = list.listVersion();
        list.applyUpdate(
            version,
            new address[](0),
            accounts,
            p.sourceHash,
            p.publicationDate,
            list.pendingAdditions(),
            pending - uint32(accounts.length)
        );
        emit DelistingExecuted(id, msg.sender, gate, version + 1);
    }

    // ── Clearances ────────────────────────────────────────────────────

    /// @notice Issue a cross-chain clearance challenge for a matured
    ///         proposal. Anyone may call it (the delister bot does); the
    ///         attestor on the RedStone chain is then asked to answer it.
    /// @dev    Issued only once the window has ended and from the previous
    ///         block's hash, so no answer echoing it can have been read
    ///         before the window ended — this replaces any comparison of the
    ///         source chain's clock with ours. (The previous block's hash is
    ///         public one block early, so a caller predicting its own request
    ///         can know the challenge at most one block ahead: a lead bounded
    ///         by the block time.) A new challenge may be issued
    ///         only when the proposal has none under the current source, or
    ///         the current one has expired, so a caller cannot keep voiding
    ///         an answer in flight.
    /// @return challenge The value the attestor's answer must echo.
    function requestClearance(uint256 id) external returns (bytes32 challenge) {
        Proposal storage p = _pending(id);
        if (block.timestamp < p.eta) revert TooEarly(id, p.eta);
        if (address(list.secondary()) != address(0)) revert LocalGateInUse();
        if (clearanceMessenger == address(0)) revert ClearanceUnavailable();
        uint32 epoch = clearanceEpoch;
        ClearanceChallenge storage c = clearanceOf[id];
        bytes32 previous = c.challenge;
        if (previous != bytes32(0)) {
            if (c.epoch == epoch && block.timestamp <= _expiresAt(c)) {
                revert ClearanceOutstanding(id, previous, _expiresAt(c));
            }
            delete proposalOfChallenge[previous];
        }
        challenge = keccak256(
            abi.encode(address(this), block.chainid, id, epoch, ++_challengeNonce, blockhash(block.number - 1))
        );
        c.challenge = challenge;
        c.issuedAt = uint64(block.timestamp);
        c.oracleUpdatedAt = 0;
        c.epoch = epoch;
        c.state = ClearanceState.Requested;
        proposalOfChallenge[challenge] = id;
        emit ClearanceRequested(id, challenge, epoch, _expiresAt(c), p.accounts);
    }

    /// @inheritdoc ICrossChainMessageRecipient
    /// @dev    Records RedStone's answer to a challenge. The messenger has
    ///         already authenticated the CCIP lane and the channel peer; this
    ///         re-checks that the peer is the configured attestor, and
    ///         reverts on anything malformed. The attestor is permissionless,
    ///         so an answer to an unknown or superseded challenge, for a
    ///         closed proposal, or for other addresses than the proposal's is
    ///         IGNORED with {ClearanceIgnored} rather than reverted: it
    ///         carries no evidence about any live proposal. One flagged
    ///         answer marks the challenge {ClearanceState.Flagged} for good,
    ///         so two answers that disagree fail closed whatever order they
    ///         arrive in.
    function onCrossChainMessage(
        uint256 sourceChainId,
        address sourceSender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        bytes32
    ) external {
        address messenger = clearanceMessenger;
        if (messenger == address(0) || msg.sender != messenger) revert NotMessenger(msg.sender);
        if (sourceChainId != clearanceSourceChainId || sourceSender != clearanceAttestor) {
            revert UnauthorizedClearanceSender(sourceChainId, sourceSender);
        }
        if (tokens.length != 0) revert UnexpectedTokens();
        (uint16 version, bytes32 challenge, address[] memory accounts, bool[] memory flagged, uint64 oracleUpdatedAt) =
            abi.decode(payload, (uint16, bytes32, address[], bool[], uint64));
        if (version != SANCTIONS_CLEARANCE_WIRE_VERSION) revert UnsupportedClearanceVersion(version);
        if (accounts.length != flagged.length) revert LengthMismatch(accounts.length, flagged.length);

        uint256 id = proposalOfChallenge[challenge];
        if (id == 0) {
            emit ClearanceIgnored(challenge, 0, IgnoreReason.UnknownChallenge);
            return;
        }
        ClearanceChallenge storage c = clearanceOf[id];
        if (c.challenge != challenge || c.epoch != clearanceEpoch) {
            emit ClearanceIgnored(challenge, id, IgnoreReason.Superseded);
            return;
        }
        Proposal storage p = _proposals[id];
        if (p.status != Status.Pending) {
            emit ClearanceIgnored(challenge, id, IgnoreReason.ProposalClosed);
            return;
        }
        if (keccak256(abi.encode(accounts)) != p.accountsHash) {
            emit ClearanceIgnored(challenge, id, IgnoreReason.AccountsMismatch);
            return;
        }

        bool anyFlagged;
        for (uint256 i; i < flagged.length; ++i) {
            if (flagged[i]) {
                anyFlagged = true;
                break;
            }
        }
        // A source clock ahead of ours must not make the oracle look fresher
        // than it can be.
        if (oracleUpdatedAt > block.timestamp) oracleUpdatedAt = uint64(block.timestamp);
        if (anyFlagged) {
            c.state = ClearanceState.Flagged;
        } else if (c.state != ClearanceState.Flagged) {
            c.state = ClearanceState.Cleared;
            if (oracleUpdatedAt > c.oracleUpdatedAt) c.oracleUpdatedAt = oracleUpdatedAt;
        }
        emit ClearanceAnswered(id, challenge, flagged, oracleUpdatedAt, c.state);
    }

    // ── Reads ─────────────────────────────────────────────────────────

    /// @notice A proposal in full.
    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @notice Whether {execute} would pass every check but the list's own
    ///         at this block, and if not, the first reason. A view for bots
    ///         and surfaces; {execute} is the authority.
    /// @return ready  True when the proposal can execute now.
    /// @return reason The selector of the error {execute} would revert with,
    ///                or zero when ready.
    function readiness(uint256 id) external view returns (bool ready, bytes4 reason) {
        try this.checkExecutable(id) {
            return (true, bytes4(0));
        } catch (bytes memory err) {
            return (false, err.length >= 4 ? bytes4(err) : bytes4(0));
        }
    }

    /// @notice Reverts with {execute}'s first failing reason, else returns
    ///         the RedStone gate it would pass.
    function checkExecutable(uint256 id) external view returns (GateMode gate) {
        (, gate) = _checkExecutable(id);
    }

    // ── Internals ─────────────────────────────────────────────────────

    /// @dev Every check {execute} makes before it writes, in order. One
    ///      sequence for {execute} and {checkExecutable}, so the view cannot
    ///      report ready on a proposal {execute} would refuse.
    function _checkExecutable(uint256 id) private view returns (Proposal storage p, GateMode gate) {
        p = _pending(id);
        if (block.timestamp < p.eta) revert TooEarly(id, p.eta);
        bytes32 recordedHash = list.sourceHash();
        uint32 recordedDate = list.sourcePublicationDate();
        if (recordedHash != p.sourceHash || recordedDate != p.publicationDate) {
            revert PublicationChanged(id, recordedHash, recordedDate);
        }
        uint256 n = p.accounts.length;
        uint32 pending = list.pendingDelistings();
        if (n > pending) revert ExceedsPendingDelistings(n, pending);
        address[] memory accounts = p.accounts;
        _requireNotVetoed(accounts);
        gate = _requireCleared(id, accounts);
    }

    function _pending(uint256 id) private view returns (Proposal storage p) {
        p = _proposals[id];
        if (p.status != Status.Pending) revert NotPending(id, p.status);
    }

    function _expiresAt(ClearanceChallenge storage c) private view returns (uint64) {
        return c.issuedAt + clearanceMaxAge;
    }

    function _isVetoer(address who) private view returns (bool) {
        return who == owner() || list.isRemover(who);
    }

    function _setVeto(address account, bool vetoed_) private {
        if (vetoed[account] == vetoed_) return;
        vetoed[account] = vetoed_;
        emit VetoSet(account, vetoed_, msg.sender);
    }

    function _requireNotVetoed(address[] memory accounts) private view {
        for (uint256 i; i < accounts.length; ++i) {
            if (vetoed[accounts[i]]) revert Vetoed(accounts[i]);
        }
    }

    function _release(address[] memory accounts) private {
        for (uint256 i; i < accounts.length; ++i) {
            delete proposalOf[accounts[i]];
        }
    }

    function _requireRecordedPublication(bytes32 sourceHash, uint32 publicationDate) private view {
        bytes32 recordedHash = list.sourceHash();
        uint32 recordedDate = list.sourcePublicationDate();
        if (sourceHash != recordedHash || publicationDate != recordedDate) {
            revert PublicationMismatch(sourceHash, publicationDate, recordedHash, recordedDate);
        }
    }

    /// @dev A current RedStone must not flag any address. Local secondary
    ///      first, read live (a revert propagates) after its own freshness;
    ///      else the proposal's cross-chain challenge; else the automated
    ///      route is closed.
    function _requireCleared(uint256 id, address[] memory accounts) private view returns (GateMode) {
        ISanctionsList secondary = list.secondary();
        if (address(secondary) != address(0)) {
            (bool known, uint256 updatedAt) = LibOracleFreshness.lastUpdate(address(secondary));
            _requireFresh(GateMode.Local, known, updatedAt);
            for (uint256 i; i < accounts.length; ++i) {
                if (secondary.isSanctioned(accounts[i])) revert StillSanctioned(accounts[i]);
            }
            return GateMode.Local;
        }
        if (clearanceMessenger == address(0)) revert ClearanceUnavailable();
        ClearanceChallenge storage c = clearanceOf[id];
        if (c.challenge == bytes32(0) || c.epoch != clearanceEpoch) revert ClearanceNotRequested(id);
        uint64 expiresAt = _expiresAt(c);
        if (block.timestamp > expiresAt) revert ClearanceExpired(id, expiresAt);
        ClearanceState state = c.state;
        if (state == ClearanceState.Requested) revert ClearanceNotAnswered(id, c.challenge);
        if (state == ClearanceState.Flagged) revert ClearanceFlagged(id, c.challenge);
        _requireFresh(GateMode.CrossChain, c.oracleUpdatedAt != 0, c.oracleUpdatedAt);
        return GateMode.CrossChain;
    }

    function _requireFresh(GateMode gate, bool known, uint256 updatedAt) private view {
        if (!known) revert OracleFreshnessUnknown(gate);
        uint32 maxAge = oracleMaxAge;
        if (block.timestamp > updatedAt + maxAge) revert OracleStale(gate, updatedAt, maxAge);
    }
}
