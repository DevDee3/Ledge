// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LedgeRegistry} from "../src/LedgeRegistry.sol";
import {LedgeTestnetOracle} from "../src/LedgeTestnetOracle.sol";

/// @notice Deploys the controlled oracle and registry for Base Sepolia testing.
/// @dev This is not a production oracle deployment. The owner must update prices manually.
contract DeployBaseTestnet is Script {
    function run() external returns (LedgeRegistry registry, LedgeTestnetOracle oracle) {
        require(block.chainid == 84532, "Base Sepolia only");
        address owner = vm.envAddress("ORACLE_OWNER");
        vm.startBroadcast();
        oracle = new LedgeTestnetOracle(owner);
        registry = new LedgeRegistry(address(oracle));
        vm.stopBroadcast();
        console.log("Chain ID      ", block.chainid);
        console.log("Oracle owner  ", owner);
        console.log("Oracle        ", address(oracle));
        console.log("LedgeRegistry ", address(registry));
    }
}
