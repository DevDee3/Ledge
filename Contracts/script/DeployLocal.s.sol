// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LedgeRegistry} from "../src/LedgeRegistry.sol";

/// @dev LOCAL DEVELOPMENT ONLY. Same call shape as the Base oracle adapter, with settable prices.
contract LocalOracle {
    mapping(uint32 => uint64) public px;

    function set(uint32 index, uint64 value) external {
        px[index] = value;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        return abi.encode(uint256(px[abi.decode(data, (uint32))]));
    }
}

/// Local test chain:
///   anvil
///   forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
/// The key above is Anvil's public default account #0. It is not a secret.
contract DeployLocal is Script {
    function run() external returns (LedgeRegistry registry, LocalOracle oracle) {
        vm.startBroadcast();
        oracle = new LocalOracle();
        // Raw prices are arbitrary here; only ratios matter. Index 0 = BTC, 1 = ETH, 2 = SOL.
        oracle.set(0, 640_000);
        oracle.set(1, 24_000);
        oracle.set(2, 570);
        oracle.set(3, 7_400);
        registry = new LedgeRegistry(address(oracle));
        vm.stopBroadcast();
        console.log("LocalOracle   ", address(oracle));
        console.log("LedgeRegistry ", address(registry));
    }
}
