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
        collateral.faucet();

        uint256 durationDays = vm.envOr("MARKET_DURATION_DAYS", uint256(730));
        require(durationDays > 0 && durationDays <= 730, "Invalid market duration");
        uint64 expiry = uint64(block.timestamp + durationDays * 1 days);
        uint256 liquidity = 1_000e6;

        _seedAsset(factory, collateral, "BTC", 64_000, expiry, liquidity, _btcStrikes());
        _seedAsset(factory, collateral, "ETH", 2_400, expiry, liquidity, _ethStrikes());
        _seedAsset(factory, collateral, "SOL", 100, expiry, liquidity, _solStrikes());

        vm.stopBroadcast();
        console.log("Collateral    ", address(collateral));
        console.log("Factory       ", address(factory));
        console.log("Markets       ", uint256(18));
    }

    function _seedAsset(
        LedgeMarketFactory factory,
        LedgeTestnetUSD collateral,
        string memory underlying,
        uint64 mark,
        uint64 expiry,
        uint256 liquidity,
        uint64[] memory strikes
    ) internal {
        for (uint256 i = 0; i < strikes.length; i++) {
            LedgeBinaryMarket market = LedgeBinaryMarket(factory.createMarket(address(collateral), underlying, strikes[i], expiry, mark));
            collateral.approve(address(market), liquidity);
            market.addLiquidity(liquidity);
            market.placeAsk(0, uint64(500_000 - i * 40_000), uint128(liquidity / 2));
            market.placeAsk(1, uint64(500_000 - i * 40_000), uint128(liquidity / 2));
        }
    }

    function _btcStrikes() internal pure returns (uint64[] memory strikes) {
        strikes = new uint64[](6);
        strikes[0] = 56_320;
        strikes[1] = 59_520;
        strikes[2] = 62_080;
        strikes[3] = 65_920;
        strikes[4] = 68_480;
        strikes[5] = 71_680;
    }

    function _ethStrikes() internal pure returns (uint64[] memory strikes) {
        strikes = new uint64[](6);
        strikes[0] = 2_112;
        strikes[1] = 2_304;
        strikes[2] = 2_352;
        strikes[3] = 2_448;
        strikes[4] = 2_496;
        strikes[5] = 2_688;
    }

    function _solStrikes() internal pure returns (uint64[] memory strikes) {
        strikes = new uint64[](6);
        strikes[0] = 84;
        strikes[1] = 92;
        strikes[2] = 96;
        strikes[3] = 104;
        strikes[4] = 108;
        strikes[5] = 116;
    }
}
