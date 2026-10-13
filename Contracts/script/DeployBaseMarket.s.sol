// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LedgeTestnetUSD} from "../src/LedgeTestnetUSD.sol";
import {LedgeBinaryMarket} from "../src/LedgeBinaryMarket.sol";
import {LedgeMarketFactory} from "../src/LedgeMarketFactory.sol";

/// @notice Seeds a small Base Sepolia market set for local testnet validation.
/// @dev The deployer controls liquidity and market resolution. This is not production infrastructure.
contract DeployBaseMarket is Script {
    function run() external returns (LedgeTestnetUSD collateral, LedgeMarketFactory factory) {
        require(block.chainid == 84532, "Base Sepolia only");
        address marketOwner = vm.envAddress("MARKET_OWNER");
        vm.startBroadcast();
        collateral = new LedgeTestnetUSD();
        factory = new LedgeMarketFactory(marketOwner);
        collateral.faucet();

        uint64 expiry = uint64(block.timestamp + 2 days);
        uint64 mark = 64_000;
        uint256 liquidity = 1_000e6;
        uint64[] memory strikes = new uint64[](6);
        strikes[0] = 56_320;
        strikes[1] = 59_520;
        strikes[2] = 62_080;
        strikes[3] = 65_920;
        strikes[4] = 68_480;
        strikes[5] = 71_680;

        for (uint256 i = 0; i < strikes.length; i++) {
            LedgeBinaryMarket market = LedgeBinaryMarket(factory.createMarket(address(collateral), "BTC", strikes[i], expiry, mark));
            collateral.approve(address(market), liquidity);
            market.addLiquidity(liquidity);
            market.placeAsk(0, uint64(500_000 - i * 40_000), uint128(liquidity / 2));
            market.placeAsk(1, uint64(500_000 - i * 40_000), uint128(liquidity / 2));
        }
        vm.stopBroadcast();
        console.log("Collateral    ", address(collateral));
        console.log("Factory       ", address(factory));
        console.log("Markets       ", strikes.length);
    }
}
