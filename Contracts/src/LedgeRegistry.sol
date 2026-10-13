// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LedgeRegistry
/// @notice Verifiable protection records for Ledge hedges executed on Base markets.
///
/// A trader who hedges an asset with binary outcome contracts commits the plan here. The ENTRY price
/// is read on-chain from an injected oracle adapter, so it cannot be chosen by the trader. After
/// expiry anyone can settle the plan against the oracle price inside a short window.
/// Settlement records what the unhedged position would have lost, what the trader's loss cap was,
/// and therefore how much loss the floor was designed to absorb.
///
/// WHAT THIS DOES NOT DO
///  - It does not place, hold or settle the hedge. Market execution happens in LedgeBinaryMarket.
///  - It cannot verify that the hedge was actually bought or paid out. `legsHash` only binds the
///    record to the exact leg list the trader published off-chain.
///  - Settlement uses the oracle price at the moment `settle` is called inside the window, not an
///    exact expiry-time price. Keep the window short (see SETTLE_WINDOW).
contract LedgeRegistry {
    // ------------------------------------------------------------------ constants

    /// @notice How long after expiry a plan can be settled before it can only be marked lapsed.
    uint64 public constant SETTLE_WINDOW = 10 minutes;

    /// @notice Longest allowed commitment. Base testnet binary markets are short-dated.
    uint64 public constant MAX_DURATION = 7 days;

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Open,
        Settled,
        Lapsed
    }

    struct Plan {
        address owner;
        uint32 assetIndex; // Reference-price slot used by the oracle adapter
        bool isLong;
        Status status;
        uint64 expiry;
        uint64 entryPx; // raw oracle price at commit
        uint64 settlePx; // raw oracle price at settle (0 until settled)
        uint128 notional; // USD, 1e6 scale
        uint128 lossCap; // USD, 1e6 scale. Maximum loss the trader asked the hedge to hold.
        uint128 unhedgedLoss; // USD, 1e6 scale. Filled at settle.
        bytes32 legsHash; // keccak256 of the off-chain leg list
    }

    struct Record {
        uint64 settled;
        uint64 triggered; // plans where the unhedged loss exceeded the cap
        uint64 lapsed;
        uint128 totalLossAvoided; // sum of (unhedgedLoss - lossCap) over triggered plans, USD 1e6
    }

    // ------------------------------------------------------------------ storage

    /// @notice Oracle adapter. It must accept abi.encode(uint32) and return one 32-byte uint64 price.
    address public immutable oracle;

    uint256 public planCount;
    mapping(uint256 => Plan) internal _plans;
    mapping(address => Record) internal _records;

    // ------------------------------------------------------------------ events & errors

    event Committed(
        uint256 indexed id,
        address indexed owner,
        uint32 assetIndex,
        bool isLong,
        uint64 entryPx,
        uint128 notional,
        uint128 lossCap,
        uint64 expiry,
        bytes32 legsHash
    );
    event Settled(
        uint256 indexed id,
        address indexed owner,
        uint64 settlePx,
        uint128 unhedgedLoss,
        bool triggered,
        uint128 lossAvoided
    );
    event Lapsed(uint256 indexed id, address indexed owner);

    error InvalidParams();
    error OracleUnavailable();
    error UnknownPlan();
    error NotOpen();
    error TooEarly();
    error WindowClosed();
    error WindowStillOpen();

    // ------------------------------------------------------------------ constructor

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert InvalidParams();
        oracle = oracle_;
    }

    // ------------------------------------------------------------------ write

    /// @notice Commit a hedge plan. The entry price is read from the oracle, not supplied.
    function commit(
        uint32 assetIndex,
        bool isLong,
        uint128 notional,
        uint128 lossCap,
        uint64 expiry,
        bytes32 legsHash
    ) external returns (uint256 id) {
        if (notional == 0 || lossCap > notional) revert InvalidParams();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert InvalidParams();

        uint64 entryPx = _oraclePx(assetIndex);

        id = ++planCount;
        _plans[id] = Plan({
            owner: msg.sender,
            assetIndex: assetIndex,
            isLong: isLong,
            status: Status.Open,
            expiry: expiry,
            entryPx: entryPx,
            settlePx: 0,
            notional: notional,
            lossCap: lossCap,
            unhedgedLoss: 0,
            legsHash: legsHash
        });

        emit Committed(id, msg.sender, assetIndex, isLong, entryPx, notional, lossCap, expiry, legsHash);
    }

    /// @notice Settle a plan against the oracle price. Callable by anyone inside the settle window.
    function settle(uint256 id) external {
        Plan storage p = _plans[id];
        if (p.status == Status.None) revert UnknownPlan();
        if (p.status != Status.Open) revert NotOpen();
        if (block.timestamp < p.expiry) revert TooEarly();
        if (block.timestamp > p.expiry + SETTLE_WINDOW) revert WindowClosed();

        uint64 px = _oraclePx(p.assetIndex);
        uint128 loss = _unhedgedLoss(p.isLong, p.notional, p.entryPx, px);

        bool triggered = loss > p.lossCap;
        uint128 avoided = triggered ? loss - p.lossCap : 0;

        p.status = Status.Settled;
        p.settlePx = px;
        p.unhedgedLoss = loss;

        Record storage r = _records[p.owner];
        r.settled += 1;
        if (triggered) {
            r.triggered += 1;
            r.totalLossAvoided += avoided;
        }

        emit Settled(id, p.owner, px, loss, triggered, avoided);
    }

    /// @notice Mark a plan nobody settled in time as lapsed. Lapsed plans claim nothing.
    function lapse(uint256 id) external {
        Plan storage p = _plans[id];
        if (p.status == Status.None) revert UnknownPlan();
        if (p.status != Status.Open) revert NotOpen();
        if (block.timestamp <= p.expiry + SETTLE_WINDOW) revert WindowStillOpen();

        p.status = Status.Lapsed;
        _records[p.owner].lapsed += 1;

        emit Lapsed(id, p.owner);
    }

    // ------------------------------------------------------------------ views

    function getPlan(uint256 id) external view returns (Plan memory) {
        Plan memory p = _plans[id];
        if (p.status == Status.None) revert UnknownPlan();
        return p;
    }

    function recordOf(address owner) external view returns (Record memory) {
        return _records[owner];
    }

    /// @notice Pure helper so front-ends and tests share one definition of the loss math.
    function unhedgedLossFor(bool isLong, uint128 notional, uint64 entryPx, uint64 px) external pure returns (uint128) {
        return _unhedgedLoss(isLong, notional, entryPx, px);
    }

    // ------------------------------------------------------------------ internals

    function _oraclePx(uint32 assetIndex) internal view returns (uint64) {
        (bool ok, bytes memory ret) = oracle.staticcall(abi.encode(assetIndex));
        if (!ok || ret.length != 32) revert OracleUnavailable();
        uint256 v = abi.decode(ret, (uint256));
        if (v == 0 || v > type(uint64).max) revert OracleUnavailable();
        return uint64(v);
    }

    /// @dev Loss (never negative) of an unhedged position of `notional` opened at `entryPx`, marked at `px`.
    function _unhedgedLoss(bool isLong, uint128 notional, uint64 entryPx, uint64 px) internal pure returns (uint128) {
        uint256 adverse;
        if (isLong) {
            if (px >= entryPx) return 0;
            adverse = uint256(entryPx) - px;
        } else {
            if (px <= entryPx) return 0;
            adverse = uint256(px) - entryPx;
        }
        // notional * adverse / entryPx, rounded down. Short losses can exceed notional (price more than doubles).
        uint256 loss = (uint256(notional) * adverse) / entryPx;
        return loss > type(uint128).max ? type(uint128).max : uint128(loss);
    }
}
