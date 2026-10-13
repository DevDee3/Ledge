// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LedgeBinaryMarket} from "../src/LedgeBinaryMarket.sol";
import {LedgeTestnetUSD} from "../src/LedgeTestnetUSD.sol";

contract LedgeBinaryMarketTest is Test {
    LedgeTestnetUSD internal collateral;
    LedgeBinaryMarket internal market;
    address internal buyer = address(0xB0B);

    function setUp() public {
        collateral = new LedgeTestnetUSD();
        market = new LedgeBinaryMarket(address(this), address(collateral), "BTC", 62_000, uint64(block.timestamp + 1 days), 64_000);
        collateral.faucet();
        collateral.approve(address(market), 1_000e6);
        market.addLiquidity(1_000e6);
        market.placeAsk(0, 500_000, 100e6);
        vm.prank(buyer);
        collateral.faucet();
    }

    function test_buyerCanTakeAnAskAndReceivesShares() public {
        vm.startPrank(buyer);
        collateral.approve(address(market), 10e6);
        (uint128 filled, uint256 cost) = market.buy(0, 500_000, 10e6);
        vm.stopPrank();

        assertEq(filled, 10e6);
        assertEq(cost, 5e6);
        assertEq(market.balance(0, buyer), 10e6);
    }

    function test_makerCanCancelAnAsk() public {
        market.cancelAsk(0);
        (,,, uint128 remaining, bool active) = market.asks(0);
        assertEq(remaining, 100e6);
        assertFalse(active);
    }

    function test_winningSharesCanBeRedeemedAfterResolution() public {
        vm.startPrank(buyer);
        collateral.approve(address(market), 10e6);
        market.buy(0, 500_000, 10e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        market.resolve(0);
        vm.prank(buyer);
        market.redeem(10e6);

        assertEq(market.balance(0, buyer), 0);
        assertEq(collateral.balanceOf(buyer), 10_005e6);
    }
}
