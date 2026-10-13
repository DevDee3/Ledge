// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LedgeRegistry} from "../src/LedgeRegistry.sol";

/// Deploy the registry to Base:
///   LEDGE_ORACLE=0x... forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --account deployer --broadcast
/// LEDGE_ORACLE must be a Base-compatible
/// oracle adapter deployed separately (or a deliberately controlled testnet oracle).
contract Deploy is Script {
    function run() external returns (LedgeRegistry registry) {
        require(block.chainid == 8453 || block.chainid == 84532, "unsupported Base chain");
        address oracle = vm.envAddress("LEDGE_ORACLE");
        require(oracle != address(0), "LEDGE_ORACLE is zero");
        vm.startBroadcast();
        registry = new LedgeRegistry(oracle);
        vm.stopBroadcast();
        console.log("Chain ID      ", block.chainid);
        console.log("Oracle        ", oracle);
        console.log("LedgeRegistry deployed at", address(registry));
    }
}
