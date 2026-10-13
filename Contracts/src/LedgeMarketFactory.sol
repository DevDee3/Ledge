// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LedgeBinaryMarket} from "./LedgeBinaryMarket.sol";

/// @notice Registry and creator for Base-native Ledge binary markets.
contract LedgeMarketFactory {
    address public immutable owner;
    address[] public markets;

    error NotOwner();
    error InvalidOwner();

    event MarketCreated(address indexed market, string underlying, uint64 strike, uint64 expiry);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    function createMarket(address collateral, string calldata underlying, uint64 strike, uint64 expiry, uint64 referencePrice) external returns (address market) {
        if (msg.sender != owner) revert NotOwner();
        market = address(new LedgeBinaryMarket(owner, collateral, underlying, strike, expiry, referencePrice));
        markets.push(market);
        emit MarketCreated(market, underlying, strike, expiry);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return markets[index];
    }
}
