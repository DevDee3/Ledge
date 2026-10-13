// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Testnet-only oracle adapter for Base deployments.
/// @dev The owner must publish the raw reference prices used by the Base market deployment.
///      Replace this with an audited, trust-minimized adapter before production.
contract LedgeTestnetOracle {
    address public immutable owner;
    mapping(uint32 => uint64) public px;

    error NotOwner();
    error InvalidPrice();

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidPrice();
        owner = owner_;
    }

    function set(uint32 index, uint64 value) external {
        if (msg.sender != owner) revert NotOwner();
        if (value == 0) revert InvalidPrice();
        px[index] = value;
    }

    /// @dev Matches LedgeRegistry's oracle adapter call shape: abi.encode(uint32) => uint256 word.
    fallback(bytes calldata data) external returns (bytes memory) {
        if (data.length != 32) revert InvalidPrice();
        return abi.encode(uint256(px[abi.decode(data, (uint32))]));
    }
}
