// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {TestnetChains} from "../compliance/TestnetChains.sol";

/**
 * @title  VaipakamFeedRegistry
 * @notice Vaipakam's own record of which official Chainlink price feed prices
 *         which token on this chain (#2880). It answers the one call the
 *         Diamond's oracle makes of a Chainlink Feed Registry,
 *         `getFeed(base, quote)`, so the oracle prices through it unchanged.
 *
 * @dev    Why it exists: Chainlink runs its Feed Registry on Ethereum mainnet
 *         only. On every other chain the oracle had no way to find an asset's
 *         feed, so every asset except WETH was unpriced, and so illiquid. This
 *         contract is set as the Diamond's registry on every chain, Ethereum
 *         included, so there is one shape everywhere.
 *
 *         1. **What it can prove, it checks.** Every entry is checked when a
 *            change is proposed and again when it takes effect: the token is
 *            a contract answering `decimals()`; the feed answers `decimals()`
 *            with the declared value and `description()` with the declared
 *            pair name, whose quote is the symbol registered for the quote
 *            denomination (so an ETH-quoted feed cannot be filed as a USD
 *            price); and the feed's latest answer is positive and no older
 *            than its declared heartbeat. What it cannot prove is which token
 *            a pair name means (native USDC or bridged USDbC both trade near
 *            one dollar). That binding is decided off-chain, from the
 *            reviewed bindings file, and every change carries the SHA-256 and
 *            date of the Chainlink directory file it was checked against.
 *
 *         2. **Every change waits a delay the guardian can veto.** A proposer
 *            (the feed service's key) or the owner proposes a batch of
 *            changes; nothing takes effect until `delay` has passed (fixed
 *            per proposal when it is made). Meanwhile the guardian (the
 *            Pauser Safe, whose powers are all stop-only) or the owner may
 *            veto it. Removals wait too:
 *            unpricing a collateral asset stops the health-factor reads of
 *            its open loans, which is worse than a stale price, so there is
 *            no instant removal. A Chainlink deprecation is handled as a
 *            replace onto the successor feed, proposed before the shutdown.
 *            On a production chain the delay is 1 to 14 days, 3 by default;
 *            a testnet may set 0 so its mock rig registers in one batch.
 *
 *         3. **The proposer's scope is the routine feeds only.** Chainlink
 *            sorts feeds by risk: low, medium, high, new and custom. A
 *            proposer may propose low and medium feeds only. A high, new or
 *            custom feed enters only on the owner's own proposal, under the
 *            same delay and veto.
 *
 *         4. **A proposal applies to the state it was made against, or not at
 *            all.** Each change names the feed it expects to replace (zero
 *            for a new pair), so a stale or conflicting proposal fails at
 *            execution instead of overwriting a newer entry. A proposal
 *            executes only under the authority it was made under: its
 *            proposer must still hold the same role (owner or proposer),
 *            and must never have lost it since. Removing a proposer, or
 *            ownership leaving an account, voids that account's pending
 *            proposals for good; reappointing it does not revive them.
 *
 *         5. **Everything is stated.** Every proposal emits its full change
 *            list; every veto, withdrawal and execution, and every entry it
 *            writes, emits its own event. The live entries can be enumerated
 *            from state (`entriesPage`), with the directory file each was
 *            last checked against.
 */
contract VaipakamFeedRegistry is Ownable2Step {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Chainlink's own risk categories, as its directory publishes
    ///         them. Proposers may propose {Low} and {Medium} only.
    enum Category {
        Low,
        Medium,
        High,
        New,
        Custom
    }

    /// @notice A registered feed for one (token, quote denomination).
    struct Entry {
        /// @dev The Chainlink feed proxy.
        address feed;
        /// @dev The feed's `decimals()`, checked when written.
        uint8 feedDecimals;
        /// @dev Chainlink's risk category for the feed.
        Category category;
        /// @dev The feed's maximum update interval, seconds, as published.
        uint32 heartbeat;
        /// @dev Date of the directory file the entry was checked against,
        ///      `YYYYMMDD`.
        uint32 directoryDate;
        /// @dev Block time the entry was written.
        uint64 updatedAt;
        /// @dev SHA-256 of that directory file.
        bytes32 directorySha256;
        /// @dev The feed's `description()`, e.g. "LINK / USD".
        string pair;
    }

    /// @notice One change a proposal makes. `feed == address(0)` removes the
    ///         pair; `expectedFeed` is the feed the change replaces, zero for
    ///         a pair not yet registered.
    struct Change {
        address base;
        address quote;
        address expectedFeed;
        address feed;
        uint8 feedDecimals;
        Category category;
        uint32 heartbeat;
        string pair;
    }

    /// @notice A proposal's lifecycle. Only {Pending} may execute.
    enum State {
        None,
        Pending,
        Executed,
        Vetoed,
        Withdrawn
    }

    /// @notice A proposed batch of changes.
    struct Proposal {
        /// @dev keccak256 of the ABI-encoded change list; the executor passes
        ///      the list again and it must match.
        bytes32 changesHash;
        bytes32 directorySha256;
        uint32 directoryDate;
        uint64 executableAt;
        address proposer;
        State state;
        /// @dev Whether the proposer proposed as the owner; the change
        ///      scope it was checked under, and the role it must still hold.
        bool byOwner;
        /// @dev The proposer's {authGeneration} when it proposed.
        uint64 generation;
    }

    /// @notice Chainlink's `Denominations` sentinels, the quote keys the
    ///         Diamond's oracle passes to {getFeed}. Fixed here so the Diamond
    ///         reads its denominators from the registry it prices through
    ///         (`ConfigureOracle`), and the two can never key differently.
    address public constant USD = 0x0000000000000000000000000000000000000348;
    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Bounds on the delay of a production chain.
    uint64 public constant MIN_DELAY = 1 days;
    uint64 public constant MAX_DELAY = 14 days;
    uint64 public constant DEFAULT_DELAY = 3 days;
    /// @notice The most changes one proposal may carry, so a batch's
    ///         execution stays inside one block's gas.
    uint256 public constant MAX_CHANGES = 64;
    /// @notice The most decimals a feed or token may report.
    uint8 public constant MAX_DECIMALS = 36;
    /// @dev Gas each probe of a token or feed may spend.
    uint256 internal constant PROBE_GAS = 100_000;

    /// @notice Whether this chain may set a delay below {MIN_DELAY}.
    bool public immutable testnet;

    /// @notice Delay applied to proposals made from now on.
    uint64 public delay;

    /// @notice The guardian (the Pauser Safe): may veto any pending
    ///         proposal.
    address public guardian;

    /// @notice Accounts allowed to propose low- and medium-risk changes.
    mapping(address account => bool enabled) public isProposer;

    /// @notice How many times each account has lost proposing authority
    ///         (removed as a proposer, or ownership moved away from it). A
    ///         pending proposal executes only while its proposer's count is
    ///         the one it was made under, so a lapse voids it permanently.
    mapping(address account => uint64 generation) public authGeneration;

    /// @notice The symbol a feed's pair name must end with for each quote
    ///         denomination, e.g. Chainlink's USD sentinel `0x…0348` → "USD".
    ///         A quote with no symbol registered cannot be used.
    mapping(address quote => string symbol) public quoteSymbol;

    /// @notice Proposals by id, from 1.
    mapping(uint256 id => Proposal) public proposals;

    /// @notice The number of proposals made.
    uint256 public proposalCount;

    mapping(bytes32 key => Entry) private _entries;
    mapping(bytes32 key => address[2]) private _pairOf;
    EnumerableSet.Bytes32Set private _keys;

    /// @custom:event-category informational/admin
    event ProposerSet(address indexed account, bool enabled);
    /// @notice `account` lost proposing authority; its proposals made before
    ///         now can no longer execute.
    /// @custom:event-category informational/admin
    event AuthorityLapsed(address indexed account, uint64 generation);
    /// @custom:event-category informational/admin
    event GuardianSet(address indexed guardian);
    /// @custom:event-category informational/admin
    event DelaySet(uint64 delay);
    /// @custom:event-category informational/admin
    event QuoteSymbolSet(address indexed quote, string symbol);
    /// @notice A batch was proposed. `changes` is the full list it will apply.
    /// @custom:event-category informational/config
    event ChangesProposed(
        uint256 indexed id,
        address indexed proposer,
        uint64 executableAt,
        bytes32 directorySha256,
        uint32 directoryDate,
        Change[] changes
    );
    /// @custom:event-category informational/config
    event ProposalVetoed(uint256 indexed id, address indexed by);
    /// @custom:event-category informational/config
    event ProposalWithdrawn(uint256 indexed id);
    /// @custom:event-category informational/config
    event ProposalExecuted(uint256 indexed id, address indexed by);
    /// @notice An entry was written (or, with `feed == address(0)`, removed)
    ///         by proposal `id`.
    /// @custom:event-category informational/config
    event FeedSet(
        address indexed base,
        address indexed quote,
        address previousFeed,
        address feed,
        string pair,
        Category category,
        uint256 indexed id
    );

    error ZeroAddress();
    error NotProposer(address caller);
    error NotGuardianOrOwner(address caller);
    error DelayOutOfRange(uint64 delay, uint64 min, uint64 max);
    error NoChanges();
    error TooManyChanges(uint256 count, uint256 max);
    error CategoryNeedsOwner(uint256 index, Category category);
    error QuoteNotRegistered(uint256 index, address quote);
    error TokenNotReadable(uint256 index, address base);
    error FeedDecimalsMismatch(uint256 index, address feed, uint8 declared);
    error FeedDescriptionMismatch(uint256 index, address feed);
    error PairQuoteMismatch(uint256 index, string pair, string quoteSymbol);
    error FeedNotLive(uint256 index, address feed);
    error HeartbeatInvalid(uint256 index, uint32 heartbeat);
    error DuplicatePair(uint256 index);
    error ExpectedFeedMismatch(uint256 index, address expected, address actual);
    error NothingToRemove(uint256 index);
    error ProposalNotPending(uint256 id, State state);
    error ProposalNotReady(uint256 id, uint64 executableAt);
    error ChangesMismatch(uint256 id);
    error ProposerRemoved(uint256 id, address proposer);
    error NotProposalsProposer(uint256 id, address caller);
    error RenounceDisabled();

    /// @param owner_    The chain's admin (later the Timelock).
    /// @param guardian_ The Pauser Safe: its veto is a stop-only power, the
    ///                  same class as the pause it already holds.
    constructor(address owner_, address guardian_) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        testnet = TestnetChains.isTestnet(block.chainid);
        guardian = guardian_;
        delay = DEFAULT_DELAY;
        quoteSymbol[USD] = "USD";
        quoteSymbol[ETH] = "ETH";
        emit GuardianSet(guardian_);
        emit DelaySet(DEFAULT_DELAY);
        emit QuoteSymbolSet(USD, "USD");
        emit QuoteSymbolSet(ETH, "ETH");
    }

    // ─── The Diamond's read ────────────────────────────────────────────

    /// @notice The feed registered for (`base`, `quote`), or `address(0)`
    ///         when none is. Matches the call shape of Chainlink's Feed
    ///         Registry, whose return type is an aggregator address.
    function getFeed(address base, address quote) external view returns (address) {
        return _entries[_key(base, quote)].feed;
    }

    // ─── Reads ─────────────────────────────────────────────────────────

    /// @notice The full entry for (`base`, `quote`); `feed` is zero when none.
    function entry(address base, address quote) external view returns (Entry memory) {
        return _entries[_key(base, quote)];
    }

    /// @notice How many pairs are registered.
    function entryCount() external view returns (uint256) {
        return _keys.length();
    }

    /// @notice A page of the registered pairs and their entries, in no
    ///         particular order, stable between writes.
    function entriesPage(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory bases, address[] memory quotes, Entry[] memory entries)
    {
        uint256 n = _keys.length();
        uint256 end = offset >= n ? offset : (n - offset < limit ? n : offset + limit);
        uint256 len = end - offset;
        bases = new address[](len);
        quotes = new address[](len);
        entries = new Entry[](len);
        for (uint256 i; i < len; ++i) {
            bytes32 k = _keys.at(offset + i);
            bases[i] = _pairOf[k][0];
            quotes[i] = _pairOf[k][1];
            entries[i] = _entries[k];
        }
    }

    // ─── Owner ─────────────────────────────────────────────────────────

    function setProposer(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (isProposer[account] && !enabled) _lapse(account);
        isProposer[account] = enabled;
        emit ProposerSet(account, enabled);
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Set the delay for proposals made from now on. A pending
    ///         proposal keeps the delay it was made under.
    function setDelay(uint64 delay_) external onlyOwner {
        uint64 min = testnet ? 0 : MIN_DELAY;
        if (delay_ < min || delay_ > MAX_DELAY) revert DelayOutOfRange(delay_, min, MAX_DELAY);
        delay = delay_;
        emit DelaySet(delay_);
    }

    /// @notice Register the symbol a quote denomination's pair names end
    ///         with (e.g. a numeraire other than USD on an industrial fork).
    ///         An empty symbol unregisters the quote for new changes;
    ///         existing entries stay until removed by proposal.
    function setQuoteSymbol(address quote, string calldata symbol) external onlyOwner {
        if (quote == address(0)) revert ZeroAddress();
        quoteSymbol[quote] = symbol;
        emit QuoteSymbolSet(quote, symbol);
    }

    /// @dev The owner is the admin and later the Timelock; renouncing would
    ///      freeze the registry with no way to replace a deprecated feed.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @dev Ownership leaving an account voids the proposals it made as the
    ///      owner, even if ownership later returns to it.
    function _transferOwnership(address newOwner) internal override {
        address previous = owner();
        if (previous != address(0) && previous != newOwner) _lapse(previous);
        super._transferOwnership(newOwner);
    }

    // ─── Proposals ─────────────────────────────────────────────────────

    /// @notice Propose a batch of changes, checked now and again when it
    ///         executes.
    /// @param changes         The changes, each naming the feed it replaces.
    /// @param directorySha256 SHA-256 of the Chainlink directory file the
    ///                        batch was checked against.
    /// @param directoryDate   That file's date, `YYYYMMDD`.
    /// @return id The proposal id.
    function propose(Change[] calldata changes, bytes32 directorySha256, uint32 directoryDate)
        external
        returns (uint256 id)
    {
        bool byOwner = msg.sender == owner();
        if (!byOwner && !isProposer[msg.sender]) revert NotProposer(msg.sender);
        _checkChanges(changes, byOwner);
        id = ++proposalCount;
        uint64 executableAt = uint64(block.timestamp) + delay;
        proposals[id] = Proposal({
            changesHash: keccak256(abi.encode(changes)),
            directorySha256: directorySha256,
            directoryDate: directoryDate,
            executableAt: executableAt,
            proposer: msg.sender,
            state: State.Pending,
            byOwner: byOwner,
            generation: authGeneration[msg.sender]
        });
        emit ChangesProposed(id, msg.sender, executableAt, directorySha256, directoryDate, changes);
    }

    /// @notice Veto a pending proposal. Guardian or owner.
    function veto(uint256 id) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner(msg.sender);
        Proposal storage p = _pending(id);
        p.state = State.Vetoed;
        emit ProposalVetoed(id, msg.sender);
    }

    /// @notice Withdraw one of the caller's own pending proposals.
    function withdraw(uint256 id) external {
        Proposal storage p = _pending(id);
        if (p.proposer != msg.sender) revert NotProposalsProposer(id, msg.sender);
        p.state = State.Withdrawn;
        emit ProposalWithdrawn(id);
    }

    /// @notice Apply a pending proposal whose delay has passed. Anyone may
    ///         call: the content is fixed by the proposal and re-checked here.
    /// @param changes The proposal's change list, exactly as proposed.
    function execute(uint256 id, Change[] calldata changes) external {
        Proposal storage p = _pending(id);
        if (block.timestamp < p.executableAt) revert ProposalNotReady(id, p.executableAt);
        if (keccak256(abi.encode(changes)) != p.changesHash) revert ChangesMismatch(id);
        address proposer = p.proposer;
        bool stillHeld = p.byOwner ? proposer == owner() : isProposer[proposer];
        if (!stillHeld || p.generation != authGeneration[proposer]) revert ProposerRemoved(id, proposer);
        _checkChanges(changes, p.byOwner);
        p.state = State.Executed;
        for (uint256 i; i < changes.length; ++i) {
            _apply(changes[i], p.directorySha256, p.directoryDate, i, id);
        }
        emit ProposalExecuted(id, msg.sender);
    }

    // ─── Internals ─────────────────────────────────────────────────────

    function _lapse(address account) private {
        uint64 g = ++authGeneration[account];
        emit AuthorityLapsed(account, g);
    }

    function _pending(uint256 id) private view returns (Proposal storage p) {
        p = proposals[id];
        if (p.state != State.Pending) revert ProposalNotPending(id, p.state);
    }

    function _key(address base, address quote) private pure returns (bytes32) {
        return keccak256(abi.encode(base, quote));
    }

    /// @dev Every check that does not depend on the current entry runs at
    ///      proposal and again at execution; the expected-feed check runs at
    ///      execution only ({_apply}), since a pending proposal may be
    ///      followed by another that changes the pair first.
    function _checkChanges(Change[] calldata changes, bool byOwner) private view {
        uint256 n = changes.length;
        if (n == 0) revert NoChanges();
        if (n > MAX_CHANGES) revert TooManyChanges(n, MAX_CHANGES);
        for (uint256 i; i < n; ++i) {
            Change calldata c = changes[i];
            if (c.base == address(0) || c.quote == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (changes[j].base == c.base && changes[j].quote == c.quote) revert DuplicatePair(i);
            }
            if (c.feed == address(0)) continue; // removal: nothing to probe
            if (!byOwner && c.category != Category.Low && c.category != Category.Medium) {
                revert CategoryNeedsOwner(i, c.category);
            }
            string memory sym = quoteSymbol[c.quote];
            if (bytes(sym).length == 0) revert QuoteNotRegistered(i, c.quote);
            if (!_endsWithQuote(c.pair, sym)) revert PairQuoteMismatch(i, c.pair, sym);
            if (c.heartbeat == 0) revert HeartbeatInvalid(i, c.heartbeat);
            (bool tokOk, uint8 tokDec) = _readDecimals(c.base);
            if (!tokOk || tokDec > MAX_DECIMALS) revert TokenNotReadable(i, c.base);
            (bool decOk, uint8 feedDec) = _readDecimals(c.feed);
            if (!decOk || feedDec != c.feedDecimals || feedDec > MAX_DECIMALS) {
                revert FeedDecimalsMismatch(i, c.feed, c.feedDecimals);
            }
            if (!_descriptionIs(c.feed, c.pair)) revert FeedDescriptionMismatch(i, c.feed);
            if (!_liveWithin(c.feed, c.heartbeat)) revert FeedNotLive(i, c.feed);
        }
    }

    function _apply(Change calldata c, bytes32 dirHash, uint32 dirDate, uint256 i, uint256 id) private {
        bytes32 k = _key(c.base, c.quote);
        Entry storage e = _entries[k];
        address previous = e.feed;
        if (previous != c.expectedFeed) revert ExpectedFeedMismatch(i, c.expectedFeed, previous);
        if (c.feed == address(0)) {
            if (previous == address(0)) revert NothingToRemove(i);
            delete _entries[k];
            delete _pairOf[k];
            _keys.remove(k);
            emit FeedSet(c.base, c.quote, previous, address(0), "", Category.Low, id);
            return;
        }
        e.feed = c.feed;
        e.feedDecimals = c.feedDecimals;
        e.category = c.category;
        e.heartbeat = c.heartbeat;
        e.directoryDate = dirDate;
        e.updatedAt = uint64(block.timestamp);
        e.directorySha256 = dirHash;
        e.pair = c.pair;
        if (_keys.add(k)) _pairOf[k] = [c.base, c.quote];
        emit FeedSet(c.base, c.quote, previous, c.feed, c.pair, c.category, id);
    }

    /// @dev `pair` ends with " / " followed by exactly `sym`.
    function _endsWithQuote(string calldata pair, string memory sym) private pure returns (bool) {
        bytes calldata p = bytes(pair);
        bytes memory s = bytes(sym);
        uint256 tail = s.length + 3;
        if (p.length <= tail) return false;
        uint256 start = p.length - tail;
        if (p[start] != " " || p[start + 1] != "/" || p[start + 2] != " ") return false;
        for (uint256 i; i < s.length; ++i) {
            if (p[start + 3 + i] != s[i]) return false;
        }
        return true;
    }

    /// @dev `decimals()` answered with exactly one word that fits a uint8.
    function _readDecimals(address target) private view returns (bool ok, uint8 dec) {
        if (target.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) =
            target.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("decimals()"));
        if (!success || ret.length != 32) return (false, 0);
        uint256 v = abi.decode(ret, (uint256));
        if (v > type(uint8).max) return (false, 0);
        return (true, uint8(v));
    }

    /// @dev `description()` answered with a well-formed string equal to
    ///      `pair`. The decode is bounds-checked by hand, so a malformed
    ///      reply reads as a mismatch instead of reverting the whole check.
    function _descriptionIs(address feed, string calldata pair) private view returns (bool) {
        (bool success, bytes memory ret) =
            feed.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("description()"));
        if (!success || ret.length < 64) return false;
        uint256 offset;
        uint256 len;
        assembly ("memory-safe") {
            offset := mload(add(ret, 32))
        }
        if (offset != 32) return false;
        assembly ("memory-safe") {
            len := mload(add(ret, 64))
        }
        if (len > ret.length - 64) return false;
        if (len != bytes(pair).length) return false;
        bytes32 got;
        assembly ("memory-safe") {
            got := keccak256(add(ret, 96), len)
        }
        return got == keccak256(bytes(pair));
    }

    /// @dev `latestRoundData()` answered with a positive answer updated no
    ///      later than now and no more than `heartbeat` seconds ago.
    function _liveWithin(address feed, uint32 heartbeat) private view returns (bool) {
        (bool success, bytes memory ret) =
            feed.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("latestRoundData()"));
        if (!success || ret.length != 160) return false;
        // Decoded as five full words: a uint80 decode would REVERT on a
        // malformed round id instead of reading the feed as not live.
        (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return false;
        return block.timestamp - updatedAt <= heartbeat;
    }
}
