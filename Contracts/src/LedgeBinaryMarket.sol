// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILedgeCollateral {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Testnet binary market with an escrowed ask book.
/// @dev Prices and shares use 6 decimals. This is a controlled testnet protocol and needs an audit
/// before any production use.
contract LedgeBinaryMarket {
    uint256 public constant ONE = 1e6;

    struct Ask {
        address maker;
        uint8 side; // 0 = YES, 1 = NO
        uint64 price;
        uint128 remaining;
        bool active;
    }

    address public immutable owner;
    address public immutable collateral;
    string public underlying;
    uint64 public immutable strike;
    uint64 public immutable expiry;
    uint64 public referencePrice;
    bool public resolved;
    uint8 public winningSide;
    uint256 public nextAskId;
    uint256 public yesCursor;
    uint256 public noCursor;

    mapping(uint256 => Ask) public asks;
    mapping(uint8 => mapping(address => uint256)) public balance;
    mapping(uint8 => mapping(address => uint256)) public locked;

    error NotOwner();
    error InvalidMarket();
    error InvalidSide();
    error InvalidPrice();
    error InsufficientShares();
    error UnknownAsk();
    error NotMaker();
    error NotExpired();
    error AlreadyResolved();
    error NotResolved();
    error TransferFailed();

    event LiquidityAdded(address indexed provider, uint256 shares);
    event AskPlaced(uint256 indexed id, address indexed maker, uint8 side, uint256 price, uint256 shares);
    event AskCancelled(uint256 indexed id, uint256 shares);
    event Trade(uint256 indexed id, address indexed buyer, address indexed maker, uint8 side, uint256 price, uint256 shares);
    event Resolved(uint8 winningSide);
    event Redeemed(address indexed trader, uint256 shares, uint256 payout);
    event ReferencePriceUpdated(uint256 price);

    constructor(address owner_, address collateral_, string memory underlying_, uint64 strike_, uint64 expiry_, uint64 referencePrice_) {
        if (owner_ == address(0) || collateral_ == address(0) || strike_ == 0 || expiry_ <= block.timestamp || referencePrice_ == 0) revert InvalidMarket();
        owner = owner_;
        collateral = collateral_;
        underlying = underlying_;
        strike = strike_;
        expiry = expiry_;
        referencePrice = referencePrice_;
    }

    function addLiquidity(uint256 shares) external {
        if (shares == 0) revert InvalidMarket();
        _pull(msg.sender, shares);
        balance[0][msg.sender] += shares;
        balance[1][msg.sender] += shares;
        emit LiquidityAdded(msg.sender, shares);
    }

    function setReferencePrice(uint64 price) external {
        if (msg.sender != owner) revert NotOwner();
        if (price == 0) revert InvalidPrice();
        referencePrice = price;
        emit ReferencePriceUpdated(price);
    }

    function placeAsk(uint8 side, uint64 price, uint128 shares) external returns (uint256 id) {
        if (side > 1) revert InvalidSide();
        if (price == 0 || price >= ONE || shares == 0) revert InvalidPrice();
        if (balance[side][msg.sender] - locked[side][msg.sender] < shares) revert InsufficientShares();
        id = nextAskId++;
        asks[id] = Ask(msg.sender, side, price, shares, true);
        locked[side][msg.sender] += shares;
        emit AskPlaced(id, msg.sender, side, price, shares);
    }

    function cancelAsk(uint256 id) external {
        Ask storage ask = asks[id];
        if (!ask.active) revert UnknownAsk();
        if (ask.maker != msg.sender) revert NotMaker();
        ask.active = false;
        locked[ask.side][msg.sender] -= ask.remaining;
        emit AskCancelled(id, ask.remaining);
    }

    function buy(uint8 side, uint64 maxPrice, uint128 shares) external returns (uint128 filled, uint256 cost) {
        if (side > 1 || maxPrice == 0 || shares == 0) revert InvalidPrice();
        uint256 cursor = side == 0 ? yesCursor : noCursor;
        uint256 left = shares;
        while (cursor < nextAskId && left > 0) {
            Ask storage ask = asks[cursor];
            if (ask.active && ask.side == side && ask.price <= maxPrice && ask.remaining > 0) {
                uint128 take = uint128(left < ask.remaining ? left : ask.remaining);
                uint256 lineCost = uint256(take) * ask.price / ONE;
                left -= take;
                filled += take;
                cost += lineCost;
                ask.remaining -= take;
                locked[side][ask.maker] -= take;
                balance[side][msg.sender] += take;
                _pull(msg.sender, lineCost);
                _pay(ask.maker, lineCost);
                emit Trade(cursor, msg.sender, ask.maker, side, ask.price, take);
                if (ask.remaining == 0) ask.active = false;
            }
            cursor++;
        }
        if (side == 0) yesCursor = cursor;
        else noCursor = cursor;
    }

    function resolve(uint8 winner) external {
        if (msg.sender != owner) revert NotOwner();
        if (winner > 1) revert InvalidSide();
        if (block.timestamp < expiry) revert NotExpired();
        if (resolved) revert AlreadyResolved();
        resolved = true;
        winningSide = winner;
        emit Resolved(winner);
    }

    function redeem(uint256 shares) external returns (uint256 payout) {
        if (!resolved) revert NotResolved();
        if (shares == 0 || balance[winningSide][msg.sender] < shares) revert InsufficientShares();
        balance[winningSide][msg.sender] -= shares;
        payout = shares;
        _pay(msg.sender, payout);
        emit Redeemed(msg.sender, shares, payout);
    }

    function getAsks(uint8 side) external view returns (Ask[] memory result) {
        if (side > 1) revert InvalidSide();
        uint256 count;
        for (uint256 i = 0; i < nextAskId; i++) if (asks[i].active && asks[i].side == side && asks[i].remaining > 0) count++;
        result = new Ask[](count);
        uint256 j;
        for (uint256 i = 0; i < nextAskId; i++) {
            Ask memory ask = asks[i];
            if (ask.active && ask.side == side && ask.remaining > 0) result[j++] = ask;
        }
    }

    function getBook(uint8 side) external view returns (uint64[] memory prices, uint128[] memory shares) {
        Ask[] memory book = this.getAsks(side);
        prices = new uint64[](book.length);
        shares = new uint128[](book.length);
        for (uint256 i = 0; i < book.length; i++) {
            prices[i] = book[i].price;
            shares[i] = book[i].remaining;
        }
    }

    function _pull(address from, uint256 amount) internal {
        if (!ILedgeCollateral(collateral).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _pay(address to, uint256 amount) internal {
        if (!ILedgeCollateral(collateral).transfer(to, amount)) revert TransferFailed();
    }
}
